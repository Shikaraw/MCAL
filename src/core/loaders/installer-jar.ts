/**
 * Forge / NeoForge installer jar 的解析与执行器。
 *
 * 协议细节（参考 reference/HMCL/.../download/forge/ForgeNewInstallTask.java、
 * ForgeOldInstallTask.java、ForgeInstallTask.java 的 detectForgeInstallerType 与
 * reference/HMCL/.../download/neoforge/NeoForgeInstallTask.java）：
 *
 *  1. 两种 install_profile.json 形态（HMCL ForgeInstallTask#detectForgeInstallerType）：
 *     - 新形态（Forge 1.13+ / 全部 NeoForge）：带 `spec` 字段与 `processors` 数组，
 *       真正的版本 json 在 installer 内的 `version.json`（install_profile.json 的 `json` 字段
 *       指向它）。processor 步骤会生成 patched client jar，必须由 installer 本体执行。
 *     - 旧形态（Forge 1.12.2 及以前）：`install` + `versionInfo` 两个字段，
 *       universal jar 以 `install.filePath` 为条目名内嵌在 installer zip 里。
 *  2. NeoForge 识别（HMCL NeoForgeInstallTask#install）：
 *     install_profile.profile == "neoforge" / "NeoForge"，或者 profile == "forge"
 *     但 zip 内存在 `META-INF/NEOFORGE.RSA` / 文本含 "neoforge"（1.20.1 时代的 NeoForge
 *     复用了 Forge 的 installer 结构）。
 *  3. 运行 installer 前必须存在 `<gameDir>/launcher_profiles.json`，
 *     否则 Forge 官方 installer 直接报 "There is no minecraft launcher profile"。
 *     该文件即使用户在用官方启动器也只是被 installer 读取，因此「已存在则绝不覆盖」。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as pathResolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import type { JavaRuntimeInfo, VersionDetail } from '@shared/types'
import { pickBestJava, requiredJavaMajor } from '@core/java/requirement'
import { decodeText, ensureDir, pathExists, writeFileAtomic } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('loader:installer')

/** installer 的类型。“forge-new” 指带 processors 的现代 installer（需求方主要关心这个）。 */
export type InstallerJarKind = 'forge-old' | 'forge-new' | 'neoforge' | 'unknown'

/** Java 运行时提供者：JavaScanner 结构上满足该接口（测试里可注入假实现） */
export interface JavaProvider {
  scan(): Promise<JavaRuntimeInfo[]>
  probe(path: string): Promise<JavaRuntimeInfo | null>
}

export interface InstallProfileInfo {
  /** install_profile.json 的原始对象；无法解析时为 null */
  profile: Record<string, unknown> | null
  /** 是否带 processors（新形态的标志之一） */
  hasProcessors: boolean
  /**
   * installer 内嵌的版本 json：
   *  - 现代 installer → 根目录 `version.json`（部分 installer 由 install_profile.json 的 `json` 指定路径）
   *  - 旧版 installer → install_profile.json 里的 `versionInfo`
   * 都没有时为 null。
   */
  versionJson: VersionDetail | null
  /** install_profile.json 的 `spec` 字段，旧形态没有该字段（返回 0） */
  spec: number
}

export interface InstallerJarOptions {
  installerPath: string
  gameDir: string
  javaPath: string
  /** 'client' | 'server' */
  side: 'client' | 'server'
  /** installer 需要的 MC 版本（部分 installer fork 需要 --mcVersion，官方 installer 一般不用） */
  mcVersion?: string
  signal?: AbortSignal
  onOutput?: (line: string) => void
  /** 额外 JVM 参数 */
  extraJvmArgs?: string[]
  timeoutMs?: number
}

export interface InstallerJarResult {
  code: number | null
  output: string
  ok: boolean
  installerKind: InstallerJarKind
}

/** 失败时保留的尾部行数（便于 Agent 诊断网络 / 校验失败原因） */
const INSTALLER_TAIL_LINES = 60
/** 新版 installer 需要联网下载 maven 库，给足 10 分钟 */
const DEFAULT_INSTALLER_TIMEOUT_MS = 10 * 60_000
/** installer 输出里的长进度行上限，防止单行撑爆内存 */
const MAX_LINE_BYTES = 64 * 1024

/* ------------------------------------------------------------------ *
 *  zip 读取辅助
 * ------------------------------------------------------------------ */

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.?\//, '')
}

function openZip(installerPath: string): AdmZip | null {
  try {
    return new AdmZip(installerPath)
  } catch (err) {
    log.warn(`无法打开 installer jar：${installerPath}（${err instanceof Error ? err.message : String(err)}）`)
    return null
  }
}

function entryMap(zip: AdmZip): Map<string, AdmZip.IZipEntry> {
  const map = new Map<string, AdmZip.IZipEntry>()
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    map.set(normalizeEntryName(entry.entryName), entry)
  }
  return map
}

function readEntryText(entries: Map<string, AdmZip.IZipEntry>, name: string): string | null {
  const entry = entries.get(normalizeEntryName(name))
  if (!entry) return null
  try {
    const buffer = entry.getData()
    // 去掉 UTF-8 BOM（部分第三方 installer 会带）
    return decodeText(buffer).text.replace(/^\uFEFF/, '')
  } catch (err) {
    log.warn(`读取 installer 条目失败：${name}（${err instanceof Error ? err.message : String(err)}）`)
    return null
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* fallthrough */
  }
  return null
}

function toVersionDetail(value: unknown): VersionDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null
  // 至少要有 libraries 或 mainClass 之一，避免把 install_profile 里的无关对象当版本
  if (!Array.isArray(obj.libraries) && typeof obj.mainClass !== 'string') return null
  return obj as unknown as VersionDetail
}

/**
 * 从 installer jar 中取出内嵌的版本 json（现代 installer 的 `version.json` 条目）。
 *
 * 条目名优先取 install_profile.json 的 `json` 字段（Forge 规范里通常就是 "version.json"），
 * 再回退到根目录 `version.json`。旧版 installer 没有该条目，返回 null。
 */
export function extractEmbeddedVersionJson(installerPath: string): VersionDetail | null {
  const zip = openZip(installerPath)
  if (!zip) return null
  const entries = entryMap(zip)
  let candidate = 'version.json'
  const profileText = readEntryText(entries, 'install_profile.json')
  if (profileText) {
    const profile = parseJsonObject(profileText)
    if (typeof profile?.json === 'string' && profile.json.trim()) candidate = profile.json.trim()
  }
  const text = readEntryText(entries, candidate) ?? readEntryText(entries, 'version.json')
  if (!text) return null
  return toVersionDetail(parseJsonObject(text))
}

/** 解析 installer jar 内的 install_profile.json，判断新旧格式并给出内嵌版本 json */
export function readInstallProfile(installerPath: string): InstallProfileInfo {
  const empty: InstallProfileInfo = { profile: null, hasProcessors: false, versionJson: null, spec: 0 }
  const zip = openZip(installerPath)
  if (!zip) return empty
  const entries = entryMap(zip)
  const text = readEntryText(entries, 'install_profile.json')
  if (!text) {
    log.debug(`installer 缺少 install_profile.json：${installerPath}`)
    // 仍尝试根目录 version.json（少数第三方打包方式会单独带版本清单）
    return { profile: null, hasProcessors: false, versionJson: extractEmbeddedVersionJson(installerPath), spec: 0 }
  }
  const profile = parseJsonObject(text)
  if (!profile) {
    // install_profile.json 解析失败时仍然尝试取出根目录 version.json（部分 installer 会把它单独打包）
    return { profile: null, hasProcessors: false, versionJson: extractEmbeddedVersionJson(installerPath), spec: 0 }
  }

  const spec = typeof profile.spec === 'number' && Number.isFinite(profile.spec) ? profile.spec : 0
  const processors = Array.isArray(profile.processors) ? profile.processors : []
  // 版本 json：优先 installer 内嵌 version.json，其次旧形态的 install_profile.versionInfo
  const versionJson = extractEmbeddedVersionJson(installerPath) ?? toVersionDetail(profile.versionInfo)
  return { profile, hasProcessors: processors.length > 0, versionJson, spec }
}

/** 识别 installer 形态（Forge 新/旧、NeoForge），未知时返回 'unknown' */
export function detectInstallerKind(installerPath: string): InstallerJarKind {
  const zip = openZip(installerPath)
  if (!zip) return 'unknown'
  const entries = entryMap(zip)
  const text = readEntryText(entries, 'install_profile.json')
  if (!text) return 'unknown'
  const profile = parseJsonObject(text)
  if (!profile) return 'unknown'

  const profileName = typeof profile.profile === 'string' ? profile.profile.toLowerCase() : ''
  const neoForgeMarker = entries.has('META-INF/NEOFORGE.RSA') || text.toLowerCase().includes('neoforge')
  if (profileName === 'neoforge') return 'neoforge'
  if (profileName === 'forge' && neoForgeMarker) return 'neoforge'

  const spec = typeof profile.spec === 'number' ? profile.spec : 0
  const processors = Array.isArray(profile.processors) ? profile.processors : []
  if (spec >= 1 && processors.length > 0) return 'forge-new'
  if (profile.install && profile.versionInfo) return 'forge-old'
  if (spec >= 1) return 'forge-new'
  return 'unknown'
}

/**
 * 把 installer 内嵌的 `maven/**` 库解压到 `<gameDir>/libraries`。
 *
 * 为什么需要：现代 Forge/NeoForge installer 把 processors 依赖的 jar（含 installer-tools、
 * forge universal 等）直接打包在 `maven/` 目录里（HMCL ForgeNewInstallTask#preExecute 会逐个
 * 拷贝到库目录）。手工回退安装时若不落盘这些文件，processor 与 classpath 都会缺件。
 */
export async function extractEmbeddedMavenFiles(installerPath: string, librariesDir: string): Promise<string[]> {
  const zip = openZip(installerPath)
  if (!zip) return []
  const out: string[] = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = normalizeEntryName(entry.entryName)
    if (!name.startsWith('maven/')) continue
    const relative = name.slice('maven/'.length)
    const dest = safeJoin(librariesDir, relative)
    if (!dest) {
      log.warn(`跳过可疑的 installer 条目（路径越界）：${entry.entryName}`)
      continue
    }
    try {
      const data = entry.getData()
      await ensureDir(dirname(dest))
      await writeFile(dest, data)
      out.push(dest)
    } catch (err) {
      log.warn(`解压 installer 内嵌库失败：${name}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  return out
}

function safeJoin(root: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.split('/').some((segment) => segment === '..')) return null
  const target = pathResolve(root, normalized)
  const rootResolved = pathResolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return null
  return target
}

/* ------------------------------------------------------------------ *
 * installer 运行
 * ------------------------------------------------------------------ */

/** 若无 launcher_profiles.json 则创建；已存在时绝不覆盖（用户可能在用官方启动器） */
export async function ensureLauncherProfiles(gameDir: string): Promise<{ path: string; created: boolean }> {
  const path = join(gameDir, 'launcher_profiles.json')
  if (await pathExists(path)) return { path, created: false }
  await writeFileAtomic(path, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2))
  log.info(`已为 installer 创建最小 launcher_profiles.json：${path}`)
  return { path, created: true }
}

function decodeLine(raw: Buffer): string {
  const trimmed = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw
  return decodeText(trimmed).text
}

function createLineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  const emit = (): void => {
    for (;;) {
      const index = pending.indexOf(0x0a)
      if (index < 0) break
      onLine(decodeLine(pending.subarray(0, index)))
      pending = pending.subarray(index + 1)
    }
    if (pending.length > MAX_LINE_BYTES) {
      onLine(decodeLine(pending.subarray(0, MAX_LINE_BYTES)))
      pending = Buffer.alloc(0)
    }
  }
  return {
    push(chunk: Buffer): void {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      emit()
    },
    flush(): void {
      if (pending.length > 0) {
        onLine(decodeLine(pending))
        pending = Buffer.alloc(0)
      }
    }
  }
}

/**
 * 结束进程树。
 * Windows 下 child.kill() 不会结束 installer 派生的子进程（processor 又会派生子 JVM），
 * 必须用 taskkill /T；POSIX 下 spawn 时加了 detached，按进程组 kill(-pid)。
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      log.warn(`taskkill 失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 进程可能已退出 */
    }
  }
}

/**
 * 运行 installer（headless）。
 *
 * 命令：`<java> [extraJvmArgs] -Djava.awt.headless=true -jar <installer> --installClient <gameDir>`
 * （server 侧为 --installServer <gameDir>），工作目录固定为 gameDir，
 * 这样 installer 才会把 versions/libraries 写到目标游戏目录。
 *
 * 失败不抛异常，而是返回 ok:false（调用方可能想回退到手工安装）；前置条件缺失才抛。
 */
export async function runInstallerJar(opts: InstallerJarOptions): Promise<InstallerJarResult> {
  if (!existsSync(opts.installerPath)) throw new Error(`installer 文件不存在：${opts.installerPath}`)
  if (!existsSync(opts.javaPath)) throw new Error(`指定的 Java 不存在：${opts.javaPath}`)

  const installerKind = detectInstallerKind(opts.installerPath)
  const gameDir = pathResolve(opts.gameDir)
  await ensureDir(gameDir)
  await ensureDir(join(gameDir, 'versions'))
  await ensureLauncherProfiles(gameDir)

  const args = [
    ...(opts.extraJvmArgs ?? []),
    // 无显示环境也能跑；installer 在 --installClient 下本来就是 headless
    '-Djava.awt.headless=true',
    '-jar',
    pathResolve(opts.installerPath),
    opts.side === 'server' ? '--installServer' : '--installClient',
    gameDir
  ]
  if (opts.mcVersion) {
    // 官方 Forge/NeoForge installer 从 install_profile.json 读取 MC 版本，无需该参数；
    // 这里为支持 --mcVersion 的第三方 installer fork 保留透传。
    args.push('--mcVersion', opts.mcVersion)
  }

  log.info(`运行 installer：${opts.javaPath} ${args.join(' ')}（cwd=${gameDir}，kind=${installerKind}）`)
  const result = await runJavaProcess({
    javaPath: opts.javaPath,
    args,
    cwd: gameDir,
    signal: opts.signal,
    onOutput: opts.onOutput,
    timeoutMs: opts.timeoutMs ?? DEFAULT_INSTALLER_TIMEOUT_MS,
    tailLines: INSTALLER_TAIL_LINES,
    label: `${installerKind} installer`
  })
  if (!result.ok) {
    log.warn(`installer 失败（code=${result.code ?? 'null'}）：${opts.installerPath}`)
  } else {
    log.info(`installer 完成：${opts.installerPath}`)
  }
  return { code: result.code, output: result.output, ok: result.ok, installerKind }
}

export interface JavaProcessOptions {
  javaPath: string
  args: string[]
  cwd?: string
  signal?: AbortSignal
  onOutput?: (line: string) => void
  timeoutMs?: number
  /** 结果 output 保留的尾部行数（完整输出通过 onOutput 或日志获取） */
  tailLines?: number
  /** 日志展示名 */
  label?: string
  extraJvmArgs?: string[]
}

export interface JavaProcessResult {
  code: number | null
  /** 尾部 N 行（失败诊断用） */
  output: string
  ok: boolean
}

/**
 * 通用的 Java 进程执行器（installer 与 OptiFine patcher 共用）。
 * 逐行回调输出、支持取消（kill 进程树）与超时；进程失败不抛异常。
 */
export async function runJavaProcess(opts: JavaProcessOptions): Promise<JavaProcessResult> {
  const tailLines = opts.tailLines ?? INSTALLER_TAIL_LINES
  const tail: string[] = []
  const pushLine = (line: string): void => {
    tail.push(line)
    if (tail.length > tailLines) tail.shift()
    try {
      opts.onOutput?.(line)
    } catch (err) {
      log.warn(`进程输出回调异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 进程结果通过对象字段回填：TS 的控制流分析不会跟踪回调里的赋值，
  // 用局部变量会在后续判断里被错误收窄成 never，因此统一放进 state 对象
  const state: { aborted: boolean; timedOut: boolean; spawnError: Error | null; exitCode: number | null } = {
    aborted: false,
    timedOut: false,
    spawnError: null,
    exitCode: null
  }

  const child = spawn(opts.javaPath, [...(opts.extraJvmArgs ?? []), ...opts.args], {
    cwd: opts.cwd,
    windowsHide: true,
    // POSIX 下建立独立进程组，便于整组 kill；Windows 用 taskkill /T 处理
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const stdoutSplitter = createLineSplitter(pushLine)
  const stderrSplitter = createLineSplitter(pushLine)
  child.stdout?.on('data', (chunk: Buffer) => stdoutSplitter.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderrSplitter.push(chunk))

  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALLER_TIMEOUT_MS
  const timer = setTimeout(() => {
    state.timedOut = true
    pushLine(`[MCAL] ${opts.label ?? 'Java 进程'} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`)
    killProcessTree(child.pid)
  }, timeoutMs)

  const onAbort = (): void => {
    state.aborted = true
    pushLine(`[MCAL] 收到取消信号，已终止 ${opts.label ?? 'Java 进程'}`)
    killProcessTree(child.pid)
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted) onAbort()

  await new Promise<void>((resolveDone) => {
    child.once('error', (err) => {
      state.spawnError = err instanceof Error ? err : new Error(String(err))
      resolveDone()
    })
    child.once('close', (code) => {
      state.exitCode = code
      resolveDone()
    })
  })

  clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onAbort)
  stdoutSplitter.flush()
  stderrSplitter.flush()

  if (state.spawnError) pushLine(`[MCAL] 启动进程失败：${state.spawnError.message}`)
  if (state.aborted) pushLine('[MCAL] 进程已被取消')
  const ok = !state.spawnError && !state.timedOut && !state.aborted && state.exitCode === 0
  if (tail.length > 0) log.debug(`${opts.label ?? 'Java 进程'} 输出尾部：\n${tail.join('\n')}`)
  return { code: state.exitCode, output: tail.join('\n'), ok }
}

/** 为 installer / patcher 选择 Java（优先上层已解析的路径） */
export async function resolveInstallerJava(opts: {
  java: JavaProvider
  javaPath?: string
  gameVersion: string
  detail?: VersionDetail | null
  signal?: AbortSignal
}): Promise<string> {
  if (opts.javaPath && existsSync(opts.javaPath)) return opts.javaPath
  const required = requiredJavaMajor(opts.gameVersion, opts.detail?.javaVersion)
  const candidates = await opts.java.scan()
  const picked = pickBestJava(candidates, required)
  if (!picked?.path) {
    throw new Error(`未找到可用的 Java（需要 Java ${required}），无法运行安装器；请先安装或指定 javaPath`)
  }
  log.info(`自动选择 Java：${picked.path}（major=${picked.majorVersion}，需要 ${required}）`)
  return picked.path
}

/** 追加写 installer 完整日志到文件（供上层在失败时保存现场，可选） */
export async function appendInstallerLog(path: string, output: string): Promise<void> {
  try {
    await ensureDir(dirname(path))
    await appendFile(path, output.endsWith('\n') ? output : output + '\n', 'utf8')
  } catch {
    /* 日志落盘失败不影响安装流程 */
  }
}
