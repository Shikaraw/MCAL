/**
 * Java 运行时探测与全量扫描。
 *
 * 探测方式：真实执行 `<java> -XshowSettings:properties -version`（该输出写在 stderr），
 * 解析 `java.version` / `java.vendor` / `java.home` / `os.arch`；
 * 失败时回退 `<java> -version` 只用正则取版本号。
 *
 * 为什么不用注册表作为唯一来源：注册表在 32/64 位视图、绿色版 JDK、压缩包解压的 JDK
 * 上都不完整；而 %JAVA_HOME%、PATH、常见安装目录、Mojang 官方 runtime 才是玩家实际
 * 在用的位置，因此把注册表只当作「补充线索」。
 *
 * 这里的探测只运行本机已存在的 java，不会下载任何东西。
 */

import { spawn } from 'node:child_process'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, normalize } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { ArchName, JavaRuntimeInfo, OsName } from '@shared/types'
import { currentArch, currentOs, normalizePathForCompare, parseJavaMajor } from '@core/util/misc'
import { decodeText, isFile, readJsonSafe, writeJson } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('java')

/** 探测超时：Java 首次启动（尤其冷启动）可能较慢，但 6 秒足够 */
const PROBE_TIMEOUT_MS = 6000
/** 递归查找 bin/java 的最大深度：runtime/<component>/<platform>/<component>/bin/java 需要 4 层 */
const MAX_DESCEND_DEPTH = 4
/** 单次扫描最多访问的目录数与最多返回的运行时数，避免在异常目录结构上卡死 */
const MAX_VISIT_DIRS = 800
const MAX_RESULTS = 64

/** 探测时不该继续深入的目录名（都是 JDK / 游戏目录里的非 JVM 目录） */
const SKIP_DIR_NAMES = new Set([
  'bin', 'lib', 'conf', 'include', 'legal', 'man', 'jmods', 'modules', 'demo', 'sample',
  'docs', 'licenses', 'resources', 'assets', 'versions', 'libraries', 'logs', 'mods', 'saves',
  'cache', 'tmp', 'temp', 'node_modules', '.git', '__macosx', 'screenshots', 'shaderpacks',
  'resourcepacks', 'crash-reports', 'config', 'defaultconfigs', 'build', 'src', 'out'
])

export interface ProbeOptions {
  /** 是否是 MCAL 自装运行时 */
  managed?: boolean
  /** Mojang 组件名（jre-legacy / java-runtime-gamma ...） */
  component?: string
  timeoutMs?: number
}

export interface JavaProbeDetails {
  /** java 自己报告的 java.home（用于「同一 java.home 去重」） */
  home?: string
  runtimeName?: string
  vmName?: string
  vendorRaw?: string
}

/** path(小写归一) → 探测细节。detect 与 install 共享，避免把非契约字段塞进 JavaRuntimeInfo */
const probeDetails = new Map<string, JavaProbeDetails>()

export function getProbeDetails(exePath: string): JavaProbeDetails | undefined {
  return probeDetails.get(normalizePathForCompare(exePath))
}

function rememberDetails(exePath: string, details: JavaProbeDetails): void {
  probeDetails.set(normalizePathForCompare(exePath), details)
}

/* ------------------------------------------------------------------ *
 *  低层：执行 java 命令
 * ------------------------------------------------------------------ */

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  error?: Error
}

function runCommand(command: string, args: string[], timeoutMs: number, useShell = false): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        // 探测是后台行为，不要弹出控制台窗口
        windowsHide: true,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err instanceof Error ? err : new Error(String(err)) })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    const finish = (code: number | null, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Java 的属性输出可能带中文路径（GBK），用 decodeText 自动判编码
      resolve({
        code,
        stdout: decodeText(Buffer.concat(stdoutChunks)).text,
        stderr: decodeText(Buffer.concat(stderrChunks)).text,
        error
      })
    }

    const timer = setTimeout(() => {
      // 超时强杀：探测卡住时不能拖住整个扫描
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(null, new Error(`执行超时（${timeoutMs}ms）：${command}`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutChunks.length < 256) stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrChunks.length < 512) stderrChunks.push(chunk)
    })
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  })
}

/* ------------------------------------------------------------------ *
 *  路径 / 可执行文件定位
 * ------------------------------------------------------------------ */

function javaExecutableName(): string {
  return currentOs() === 'windows' ? 'java.exe' : 'java'
}

/** 判断路径是否像 java 可执行文件 */
function looksLikeJavaExe(path: string): boolean {
  return /[\\/](java|javaw)(\.exe)?$/i.test(path)
}

/**
 * 在目录里查找 java 可执行文件。
 * 优先 `<dir>/bin/java`；找不到才递归（覆盖 Mojang runtime 的三层嵌套与 macOS .app 包）。
 * 一旦某层找到 bin/java 就不再深入 —— 这同时解决了 JDK 8 里 `jdk/bin/java` 与
 * `jdk/jre/bin/java` 重复的问题（只保留更上层的那个）。
 */
export async function findJavaExecutables(root: string, maxDepth = MAX_DESCEND_DEPTH): Promise<string[]> {
  const exeName = javaExecutableName()
  if (await isFile(root)) return looksLikeJavaExe(root) ? [root] : []

  const out: string[] = []
  const seen = new Set<string>()
  let visited = 0

  const push = (exe: string): void => {
    const key = normalizePathForCompare(exe)
    if (seen.has(key) || out.length >= MAX_RESULTS) return
    seen.add(key)
    out.push(exe)
  }

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || visited >= MAX_VISIT_DIRS || out.length >= MAX_RESULTS) return
    visited++
    if (await isFile(join(dir, 'bin', exeName))) {
      push(join(dir, 'bin', exeName))
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= MAX_RESULTS) return
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (SKIP_DIR_NAMES.has(entry.name.toLowerCase())) continue
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (await isFile(join(full, 'bin', exeName))) {
        push(join(full, 'bin', exeName))
        continue
      }
      await visit(full, depth + 1)
    }
  }

  await visit(root, 0)
  return out
}

/** 展开只含 `*`/`?` 通配符的目录表达式（不引入 glob 依赖） */
export async function expandGlob(pattern: string): Promise<string[]> {
  const wildcardAt = pattern.search(/[*?]/)
  if (wildcardAt < 0) return [pattern]
  const sepIndex = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf('\\'))
  const base = pattern.slice(0, sepIndex + 1) || '.'
  const rest = pattern.slice(sepIndex + 1)
  const restWildcard = rest.search(/[*?]/)
  const segEnd = ((): number => {
    const slash = rest.indexOf('/', restWildcard)
    const backslash = rest.indexOf('\\', restWildcard)
    if (slash < 0) return backslash
    if (backslash < 0) return slash
    return Math.min(slash, backslash)
  })()
  const segment = segEnd < 0 ? rest : rest.slice(0, segEnd)
  const remainder = segEnd < 0 ? '' : rest.slice(segEnd + 1)
  const matcher = new RegExp(
    '^' +
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i'
  )

  let names: string[] = []
  try {
    names = (await readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    return []
  }

  const out: string[] = []
  for (const name of names) {
    if (!matcher.test(name)) continue
    const next = join(base, name)
    if (remainder) out.push(...(await expandGlob(join(next, remainder))))
    else out.push(next)
  }
  return out
}

/* ------------------------------------------------------------------ *
 *  vendor / arch 归一
 * ------------------------------------------------------------------ */

export function normalizeJavaVendor(rawVendor?: string, runtimeName?: string): string | undefined {
  const vendor = (rawVendor ?? '').toLowerCase()
  const runtime = (runtimeName ?? '').toLowerCase()
  const all = `${vendor} ${runtime}`

  if (all.includes('adoptium') || all.includes('temurin') || all.includes('eclipse')) return 'Temurin'
  if (all.includes('azul') || all.includes('zulu')) return 'Zulu'
  if (all.includes('microsoft')) return 'Microsoft'
  if (all.includes('bellsoft') || all.includes('liberica')) return 'Liberica'
  if (all.includes('amazon') || all.includes('corretto')) return 'Corretto'
  if (all.includes('alibaba') || all.includes('dragonwell')) return 'Dragonwell'
  if (all.includes('graalvm') || all.includes('oracle graal')) return 'GraalVM'
  if (all.includes('sapmachine') || all.includes('sap se')) return 'SAP'
  if (all.includes('ibm') || all.includes('semeru')) return 'Semeru'
  if (all.includes('openjdk')) return 'OpenJDK'
  if (all.includes('oracle')) return 'Oracle'
  if (all.includes('mojang')) return 'Mojang'
  const trimmed = rawVendor?.trim()
  return trimmed ? trimmed.slice(0, 40) : undefined
}

function mapArch(osArch?: string): ArchName {
  const a = (osArch ?? '').toLowerCase()
  if (a === 'amd64' || a === 'x86_64' || a === 'x64') return 'x64'
  if (a === 'aarch64' || a === 'arm64') return 'arm64'
  if (a === 'x86' || a === 'i386' || a === 'i486' || a === 'i586' || a === 'i686') return 'x86'
  if (a.startsWith('arm')) return 'arm32'
  return currentArch()
}

function is64BitArch(arch?: ArchName, vmName?: string): boolean | undefined {
  if (vmName) {
    if (/64-bit/i.test(vmName)) return true
    if (/32-bit/i.test(vmName)) return false
  }
  if (arch === 'x64' || arch === 'arm64') return true
  if (arch === 'x86' || arch === 'arm32') return false
  return undefined
}

/** 从路径推断 Mojang 组件名：.../.minecraft/runtime/<component>/<platform>/... */
function componentFromPath(path: string): string | undefined {
  const m = /[\\/]runtime[\\/]([^\\/]+)[\\/]/.exec(path)
  return m ? m[1] : undefined
}

/* ------------------------------------------------------------------ *
 *  probeJava：探测单个可执行文件
 * ------------------------------------------------------------------ */

/**
 * 探测一个 java 可执行文件。
 * - 路径不存在 / 不是可执行文件 → 返回 null
 * - 进程能跑但输出无法解析 → 返回带 error 字段的 info（UI 可展示“损坏的 Java”）
 */
export async function probeJava(exePath: string, opts: ProbeOptions = {}): Promise<JavaRuntimeInfo | null> {
  if (!(await isFile(exePath))) return null
  const component = opts.component ?? componentFromPath(exePath)
  const managed = opts.managed ?? false
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS

  const props: Record<string, string> = {}
  const settings = await runCommand(exePath, ['-XshowSettings:properties', '-version'], timeoutMs)
  if (!settings.error) {
    // 属性块形如：`    java.version = 17.0.9`（有缩进，等号两侧有空格）
    for (const line of `${settings.stderr}\n${settings.stdout}`.split(/\r?\n/)) {
      const m = /^\s*([\w.$-]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && m[1].includes('.')) props[m[1]] = m[2]
    }
  }

  let versionString = props['java.version']
  if (!versionString) {
    // 回退：`openjdk version "17.0.9" 2023-10-17` / `java version "1.8.0_392"`
    const fallback = settings.error ? { stdout: '', stderr: '' } : settings
    const text = `${fallback.stderr}\n${fallback.stdout}`
    const m = /version\s+"([^"]+)"/i.exec(text)
    if (m) versionString = m[1]
  }
  if (!versionString) {
    const extra = await runCommand(exePath, ['-version'], timeoutMs)
    const m = /version\s+"([^"]+)"/i.exec(`${extra.stderr}\n${extra.stdout}`)
    if (m) versionString = m[1]
  }

  const vendor = component
    ? 'Mojang'
    : normalizeJavaVendor(props['java.vendor'] ?? props['java.vendor.url'], props['java.runtime.name'])
  const arch = mapArch(props['os.arch'])
  const details: JavaProbeDetails = {
    home: props['java.home'],
    runtimeName: props['java.runtime.name'],
    vmName: props['java.vm.name'],
    vendorRaw: props['java.vendor']
  }
  rememberDetails(exePath, details)

  if (!versionString) {
    const reason = settings.error
      ? `无法执行该文件：${settings.error.message}`
      : '无法从 `-XshowSettings:properties -version` / `-version` 输出中解析出版本号'
    return {
      path: exePath,
      vendor,
      majorVersion: 0,
      arch,
      os: currentOs(),
      managed,
      component,
      error: reason
    }
  }

  const majorVersion = parseJavaMajor(versionString)
  return {
    path: exePath,
    vendor,
    version: versionString.replace(/^"|"$/g, ''),
    majorVersion,
    arch,
    os: currentOs(),
    managed,
    component,
    is64Bit: is64BitArch(arch, details.vmName)
  }
}

/** 从可执行文件路径推导 java.home（探测失败时的兜底去重键） */
export function homeOfJavaExe(exePath: string): string {
  const normalized = normalize(exePath)
  const parent = normalize(join(normalized, '..'))
  const parentName = parent.split(/[\\/]/).pop()?.toLowerCase()
  if (parentName === 'bin') return normalize(join(parent, '..'))
  return parent
}

/* ------------------------------------------------------------------ *
 *  JavaScanner
 * ------------------------------------------------------------------ */

export interface JavaScannerOptions {
  /** 扫描结果缓存文件（JSON），含 mtime 校验，路径失效的条目会被丢弃 */
  cachePath?: string
  /** 用户额外指定的扫描目录（在常见目录之外补充） */
  scanDirs?: string[]
  /** 用户优先使用的 java 可执行文件，扫描时也会一并探测 */
  preferredJava?: string
}

interface CacheEntry {
  path: string
  mtimeMs: number
  info: JavaRuntimeInfo
  home?: string
}

interface CacheFile {
  version: 1
  updatedAt: number
  entries: CacheEntry[]
}

interface IndexedEntry {
  mtimeMs: number
  info: JavaRuntimeInfo
}

export class JavaScanner {
  private cachePath: string | null
  private scanDirs: string[]
  private preferredJava?: string
  private cached: JavaRuntimeInfo[] = []
  private index = new Map<string, IndexedEntry>()
  private root: string
  private scanning: Promise<JavaRuntimeInfo[]> | null = null

  constructor(opts: JavaScannerOptions = {}) {
    this.cachePath = opts.cachePath ?? null
    this.scanDirs = opts.scanDirs ?? []
    this.preferredJava = opts.preferredJava
    this.root = defaultManagedRoot()
  }

  /* ---------------- MCAL 自装运行时目录 ---------------- */

  managedRoot(): string {
    return this.root
  }

  setManagedRoot(dir: string): void {
    this.root = dir
  }

  private isManagedPath(path: string): boolean {
    const root = normalizePathForCompare(this.root)
    const target = normalizePathForCompare(path)
    return target === root || target.startsWith(`${root}/`)
  }

  /* ---------------- 缓存 ---------------- */

  getCached(): JavaRuntimeInfo[] {
    return this.cached.map((info) => ({ ...info }))
  }

  /** 把缓存文件里的条目读进内存索引（不做探测），随后由 stat 惰性校验 mtime */
  private async loadCache(): Promise<void> {
    if (!this.cachePath) return
    const data = await readJsonSafe<CacheFile | null>(this.cachePath, null)
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) return
    for (const entry of data.entries) {
      if (!entry?.path) continue
      this.index.set(normalizePathForCompare(entry.path), { mtimeMs: entry.mtimeMs, info: entry.info })
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cachePath) return
    const entries: CacheEntry[] = []
    for (const value of this.index.values()) {
      entries.push({
        path: value.info.path,
        mtimeMs: value.mtimeMs,
        info: value.info,
        home: getProbeDetails(value.info.path)?.home ?? homeOfJavaExe(value.info.path)
      })
    }
    const payload: CacheFile = { version: 1, updatedAt: Date.now(), entries }
    try {
      await writeJson(this.cachePath, payload)
    } catch (err) {
      log.debug(`写入 Java 缓存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 带 mtime 校验的探测：文件不存在或 mtime 变化则重新探测 */
  private async probeIndexed(exePath: string, managedOverride?: boolean): Promise<JavaRuntimeInfo | null> {
    let stats: Stats
    try {
      stats = await stat(exePath)
    } catch {
      return null
    }
    if (!stats.isFile()) return null
    const key = normalizePathForCompare(exePath)
    const managed = managedOverride ?? this.isManagedPath(exePath)
    let probe = this.index.get(key)
    if (!probe || probe.mtimeMs !== stats.mtimeMs) {
      const fresh = await probeJava(exePath, { managed })
      if (!fresh) return null
      probe = { mtimeMs: stats.mtimeMs, info: fresh }
      this.index.set(key, probe)
    }
    // managed 由路径推导，可能与缓存时的值不同（用户改了自装目录）
    return { ...probe.info, managed }
  }

  /* ---------------- 公开探测接口 ---------------- */

  /** 探测单个路径（文件或目录），目录会先定位 bin/java */
  async probe(path: string, opts: { managed?: boolean } = {}): Promise<JavaRuntimeInfo | null> {
    const exe = looksLikeJavaExe(path) && (await isFile(path)) ? path : (await findJavaExecutables(path))[0]
    if (!exe) return null
    return this.probeIndexed(exe, opts.managed)
  }

  /** 探测一个 java 目录下的所有 jdk/jre（含多层嵌套，例如 Mojang runtime） */
  async probeHome(homeDir: string, opts: { managed?: boolean } = {}): Promise<JavaRuntimeInfo[]> {
    const executables = await findJavaExecutables(homeDir)
    const out: JavaRuntimeInfo[] = []
    for (const exe of executables) {
      const info = await this.probeIndexed(exe, opts.managed)
      if (info) out.push(info)
    }
    return out
  }

  /* ---------------- 全量扫描 ---------------- */

  async scan(opts: { force?: boolean; scanDirs?: string[] } = {}): Promise<JavaRuntimeInfo[]> {
    if (this.scanning) return this.scanning
    this.scanning = this.scanInternal(opts).finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  private async scanInternal(opts: { force?: boolean; scanDirs?: string[] }): Promise<JavaRuntimeInfo[]> {
    // 1. 先载入缓存文件（随后 stat 校验，文件不存在的条目自然被丢弃）
    if (opts.force) this.index.clear()
    else if (this.index.size === 0) await this.loadCache()

    const roots = await this.collectRoots(opts.scanDirs ?? this.scanDirs)
    const results: JavaRuntimeInfo[] = []
    for (const root of roots) {
      try {
        // 根是一个 java 可执行文件时直接探测；是目录时才深入查找
        let found: JavaRuntimeInfo[] = []
        if (await isFile(root)) {
          if (looksLikeJavaExe(root)) {
            const info = await this.probeIndexed(root, this.isManagedPath(root))
            if (info) found = [info]
          }
        } else {
          found = await this.probeHome(root, { managed: this.isManagedPath(root) })
        }
        results.push(...found)
      } catch (err) {
        log.debug(`扫描 Java 失败 ${root}：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 2. 清理不再存在的缓存条目（例如用户卸载了 Java）
    const freshKeys = new Set(results.map((r) => normalizePathForCompare(r.path)))
    for (const key of [...this.index.keys()]) {
      if (!freshKeys.has(key)) this.index.delete(key)
    }

    this.cached = this.dedupe(results)
    await this.saveCache()
    log.debug(`Java 扫描完成：${this.cached.length} 个运行时`)
    return this.getCached()
  }

  /** 收集所有待扫描的根：设置目录 / 常见安装目录 / PATH / JAVA_HOME / 注册表 / 自装运行时 */
  private async collectRoots(extraDirs: string[]): Promise<string[]> {
    const roots: string[] = []
    const add = (p?: string | null): void => {
      if (!p) return
      const trimmed = p.trim()
      if (!trimmed) return
      roots.push(trimmed)
    }

    // MCAL 自装运行时
    add(this.root)

    // 用户额外指定
    for (const dir of extraDirs) add(dir)
    add(this.preferredJava)

    // JAVA_HOME
    add(process.env.JAVA_HOME)
    add(process.env.JDK_HOME)

    // PATH 里的 java（直接是可执行文件）
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      if (!entry) continue
      const exe = join(entry, javaExecutableName())
      if (await isFile(exe)) add(exe)
    }

    // 常见安装目录
    for (const pattern of knownInstallPatterns()) {
      try {
        const matches = await expandGlob(pattern)
        for (const match of matches.slice(0, 32)) add(match)
      } catch {
        /* 目录不存在 / 无权限：忽略 */
      }
    }

    // Windows 注册表（尽力而为）
    for (const home of await queryRegistryJavaHomes()) add(home)

    // 去重 + 过滤掉明显不存在的固定路径（通配符展开结果已做过存在性检查，固定路径可能有误）
    const seen = new Set<string>()
    const out: string[] = []
    for (const root of roots) {
      const abs = normalize(root)
      const key = normalizePathForCompare(abs)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(abs)
    }
    return out
  }

  /** 按 java.home（缺失时用可执行文件推导）去重，并按主版本升序排序 */
  private dedupe(list: JavaRuntimeInfo[]): JavaRuntimeInfo[] {
    const byHome = new Map<string, JavaRuntimeInfo>()
    for (const info of list) {
      if (!info) continue
      const home = getProbeDetails(info.path)?.home ?? homeOfJavaExe(info.path)
      const key = normalizePathForCompare(home)
      const existing = byHome.get(key)
      if (!existing) {
        byHome.set(key, info)
        continue
      }
      // 同一 java.home 只保留一个：优先保留探测成功且信息更全的
      const better =
        (info.majorVersion > 0 ? 2 : 0) + (info.vendor ? 1 : 0) - ((existing.majorVersion > 0 ? 2 : 0) + (existing.vendor ? 1 : 0))
      if (better > 0) byHome.set(key, info)
    }
    return [...byHome.values()].sort((a, b) => {
      if (a.majorVersion !== b.majorVersion) return a.majorVersion - b.majorVersion
      const va = a.vendor ?? ''
      const vb = b.vendor ?? ''
      if (va !== vb) return va.localeCompare(vb)
      return a.path.localeCompare(b.path)
    })
  }
}

/** MCAL 自装运行时的默认存放目录 */
export function defaultManagedRoot(): string {
  return process.env.MCAL_JAVA_ROOT || join(homedir(), '.mcal', 'runtimes')
}

/** Windows / macOS / Linux 的常见 Java 安装位置（`*` 为通配符） */
export function knownInstallPatterns(): string[] {
  const home = homedir()
  const os: OsName = currentOs()
  const patterns: string[] = [
    // 跨平台工具链目录
    join(home, '.jdks', '*'),
    join(home, '.gradle', 'jdks', '*'),
    join(home, '.sdkman', 'candidates', 'java', '*'),
    join(home, '.jdks', '*', '*')
  ]

  if (os === 'windows') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA
    const appData = process.env.APPDATA
    patterns.push(
      join(pf, 'Java', '*'),
      join(pf, 'Eclipse Adoptium', '*'),
      join(pf, 'Zulu', '*'),
      join(pf, 'BellSoft', '*'),
      join(pf, 'Microsoft', 'jdk*'),
      join(pf, 'Amazon Corretto', '*'),
      join(pf, 'JetBrains', '*', 'jbr'),
      join(pf, 'Semeru', '*'),
      join(pf86, 'Java', '*'),
      join(pf86, 'Eclipse Adoptium', '*')
    )
    if (appData) patterns.push(join(appData, '.minecraft', 'runtime', '*'))
    if (localAppData) {
      patterns.push(
        join(localAppData, 'Programs', 'Eclipse Adoptium', '*'),
        join(localAppData, 'Programs', 'Microsoft', 'jdk*')
      )
    }
  } else if (os === 'osx') {
    patterns.push(
      '/Library/Java/JavaVirtualMachines/*/Contents/Home',
      join(home, 'Library/Java/JavaVirtualMachines/*/Contents/Home'),
      '/Applications/*.app/Contents/Home'
    )
  } else {
    patterns.push('/usr/lib/jvm/*', '/usr/java/*', '/opt/java/*', '/opt/jdk*', join(home, '.minecraft', 'runtime', '*'))
  }

  return patterns
}

/** 读取 Windows 注册表中的 JavaHome（只作为补充线索，失败静默） */
export async function queryRegistryJavaHomes(): Promise<string[]> {
  if (currentOs() !== 'windows') return []
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
    'HKLM\\SOFTWARE\\JavaSoft\\JDK',
    'HKLM\\SOFTWARE\\JavaSoft\\JRE',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment'
  ]
  const out: string[] = []
  for (const key of keys) {
    const result = await runCommand('reg', ['query', key, '/s', '/v', 'JavaHome'], 3000)
    if (result.error) continue
    for (const m of `${result.stdout}\n${result.stderr}`.matchAll(/JavaHome\s+REG_SZ\s+(.+)/g)) {
      const value = m[1].trim()
      if (value) out.push(value)
    }
  }
  return [...new Set(out)]
}
