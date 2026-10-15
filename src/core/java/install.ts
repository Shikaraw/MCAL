/**
 * Java 运行时安装：Mojang 官方运行时（组件清单 + 逐文件下载）与 Adoptium Temurin（tar.gz 解包）。
 *
 * 关键事实（都已对照 Mojang 官方 launchermeta 数据验证）：
 *  - `javaRuntimeAll` 的结构是 { "<platform>": { "<component>": [ { manifest:{url,sha1,size}, version:{name} } ] } }，
 *    平台键为 windows-x64 / windows-x86 / windows-arm64 / mac-os / mac-os-arm64 / linux / linux-i386；
 *    组件与主版本：jre-legacy=8、java-runtime-alpha=16、java-runtime-beta/gamma=17、java-runtime-delta=21。
 *  - 组件 manifest json 里 `files` 的每一项有 type=file/directory/link：
 *    只有 `downloads.raw` 是我们要的（`downloads.lzma` 是 lzma 压缩版，官方启动器为省流量用，
 *    这里绝不下载 —— 需要额外解压器，且官方随时可能移除）。
 *  - link 类型（例如 bin/java.exe → bin/javaw.exe 的别名）需要建符号链接，Windows 无权限时退回复制；
 *    executable 类型在 POSIX 上要 chmod +x。
 *
 * Adoptium 的产物是 tar.gz，Node 没有内置 tar，这里实现一个只处理「文件 + 目录」的最小流式解析器，
 * 支持 ustar / pax（path= 记录）/ GNU longname（L），足够覆盖 Temurin / Zulu 的发行包。
 *
 * 本模块所有网络动作都由调用方显式触发；测试与开发环境禁止真实下载。
 */

import { createReadStream } from 'node:fs'
import { chmod, copyFile, open, rm, symlink } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import type { DownloadItem, DownloadProgress, JavaInstallCandidate, JavaRuntimeInfo } from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import { OFFICIAL_ENDPOINTS } from '@core/net/mirror'
import type { DownloadManager } from '@core/net/downloader'
import { currentArch, currentOs, normalizePathForCompare } from '@core/util/misc'
import { ensureDir, pathExists, removePath, sanitizeFileName } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { findJavaExecutables, probeJava } from './detect'
import { javaMajorVerdict } from './requirement'

const log = logger.scoped('java:install')

/** Mojang 运行时组件 → Java 主版本 */
export const MOJANG_COMPONENT_MAJOR: Record<string, number> = {
  'jre-legacy': 8,
  'java-runtime-alpha': 16,
  'java-runtime-beta': 17,
  'java-runtime-gamma': 17,
  'java-runtime-delta': 21
}

export interface JavaInstallerOptions {
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  /** MCAL 自装运行时的根目录：<root>/<component>/<platform>/... */
  installerRoot: string
}

/* ------------------------------------------------------------------ *
 *  Mojang launchermeta 类型
 * ------------------------------------------------------------------ */

interface MojangRuntimeFile {
  type?: 'file' | 'directory' | 'link'
  executable?: boolean
  target?: string
  downloads?: {
    raw?: { url?: string; sha1?: string; size?: number }
    lzma?: unknown
  }
}

interface MojangRuntimeManifest {
  files?: Record<string, MojangRuntimeFile>
}

interface MojangRuntimeEntry {
  manifest?: { url?: string; sha1?: string; size?: number }
  version?: { name?: string; released?: string }
}

type MojangRuntimeAll = Record<string, Record<string, MojangRuntimeEntry[]>>

interface AdoptiumAsset {
  binary?: {
    package?: { checksum?: string; link?: string; name?: string; size?: number }
    image_type?: string
  }
  version?: { major?: number; semver?: string; openjdk_version?: string }
  release_name?: string
}

/* ------------------------------------------------------------------ *
 *  JavaInstaller
 * ------------------------------------------------------------------ */

export class JavaInstaller {
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly downloadManager: DownloadManager
  private readonly installerRoot: string

  constructor(opts: JavaInstallerOptions) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.downloadManager = opts.downloadManager
    this.installerRoot = opts.installerRoot
  }

  /** 当前平台在 Mojang 清单里的候选键（按优先级：arm64 版优先，找不到再退 x64 兼容层） */
  platformKeys(): string[] {
    const os = currentOs()
    const arch = currentArch()
    if (os === 'windows') {
      if (arch === 'arm64') return ['windows-arm64', 'windows-x64']
      if (arch === 'x86') return ['windows-x86']
      return ['windows-x64']
    }
    if (os === 'osx') return arch === 'arm64' ? ['mac-os-arm64', 'mac-os'] : ['mac-os']
    // Linux：官方同时提供 linux 与 linux-i386
    return arch === 'x86' ? ['linux-i386', 'linux'] : ['linux']
  }

  /**
   * 列出可安装的 Java 候选。
   * - source=auto（默认）：优先 Mojang 官方运行时；指定 majorVersion 时同时给出 Temurin 备选
   * - source=mojang / adoptium：只查对应来源，失败直接抛错
   */
  async listCandidates(opts: { majorVersion?: number; source?: 'auto' | 'mojang' | 'adoptium'; signal?: AbortSignal } = {}): Promise<JavaInstallCandidate[]> {
    const source = opts.source ?? 'auto'
    const out: JavaInstallCandidate[] = []

    if (source === 'auto' || source === 'mojang') {
      try {
        out.push(...(await this.listMojangCandidates(opts)))
      } catch (err) {
        if (source === 'mojang') throw err
        log.warn(`获取 Mojang 运行时清单失败，改用 Temurin：${messageOf(err)}`)
      }
    }

    if ((source === 'auto' || source === 'adoptium') && opts.majorVersion) {
      try {
        out.push(...(await this.listAdoptiumCandidates(opts.majorVersion, opts.signal)))
      } catch (err) {
        if (source === 'adoptium') throw err
        log.warn(`获取 Adoptium 候选失败：${messageOf(err)}`)
      }
    }

    const filtered = opts.majorVersion ? out.filter((c) => c.majorVersion === opts.majorVersion) : out
    return filtered.sort((a, b) => {
      if (a.majorVersion !== b.majorVersion) return a.majorVersion - b.majorVersion
      // 同主版本：Mojang 官方运行时与游戏绑定最紧，排在前面
      if (a.source !== b.source) return a.source === 'mojang' ? -1 : 1
      return a.version.localeCompare(b.version)
    })
  }

  /**
   * 安装候选：下载到 <installerRoot>/<dirName> 并返回探测通过的 JavaRuntimeInfo（managed=true）。
   * 注意：本方法会真实下载，只能在用户确认后调用。
   */
  async install(
    candidate: JavaInstallCandidate,
    opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}
  ): Promise<JavaRuntimeInfo> {
    await ensureDir(this.installerRoot)
    if (candidate.source === 'mojang') {
      return this.installMojangComponent(candidate, opts)
    }
    return this.installArchive(candidate, opts)
  }

  /**
   * 从候选中推荐一个用于某游戏版本。
   * 排序与 pickBestJava 一致：精确匹配 > 高一档 > 低一档（16+），同档取差距最小的。
   */
  recommendFor(gameVersion: string, requiredMajor: number, candidates: JavaInstallCandidate[]): JavaInstallCandidate | null {
    let best: { candidate: JavaInstallCandidate; score: number } | null = null
    for (const candidate of candidates) {
      const verdict = javaMajorVerdict(candidate.majorVersion, requiredMajor)
      if (!verdict) continue
      let score = verdict === 'exact' ? 3000 : verdict === 'higher' ? 2000 : 1000
      score -= Math.min(20, Math.abs(candidate.majorVersion - requiredMajor))
      // Mojang 运行时与游戏版本强绑定（官方组件停更慢、体积小），同分优先
      if (candidate.source === 'mojang') score += 5
      if (!best || score > best.score) best = { candidate, score }
    }
    if (best) {
      log.debug(`为 ${gameVersion}（需要 Java ${requiredMajor}）推荐 ${best.candidate.id}（Java ${best.candidate.majorVersion}）`)
    }
    return best ? best.candidate : null
  }

  /* ---------------- Mojang 官方运行时 ---------------- */

  private async listMojangCandidates(opts: { majorVersion?: number; signal?: AbortSignal }): Promise<JavaInstallCandidate[]> {
    const all = await this.fetchJsonWithMirror<MojangRuntimeAll>(OFFICIAL_ENDPOINTS.javaRuntimeAll, opts.signal)
    const keys = this.platformKeys()
    const out: JavaInstallCandidate[] = []
    for (const platformKey of keys) {
      const components = all[platformKey]
      if (!components || typeof components !== 'object') continue
      for (const [component, entries] of Object.entries(components)) {
        const major = MOJANG_COMPONENT_MAJOR[component]
        if (!major) {
          log.debug(`未知 Mojang 运行时组件，已跳过：${component}`)
          continue
        }
        if (opts.majorVersion && major !== opts.majorVersion) continue
        const entry = Array.isArray(entries) ? entries[0] : undefined
        const url = entry?.manifest?.url
        if (!url) continue
        const resolvedMirror = this.mirror.resolve(url, 'mojang')
        out.push({
          id: `mojang:${component}:${platformKey}`,
          vendor: 'Mojang',
          version: entry.version?.name ?? component,
          majorVersion: major,
          os: currentOs(),
          arch: currentArch(),
          url,
          size: entry.manifest?.size,
          mirrorUrl: resolvedMirror !== url ? resolvedMirror : undefined,
          dirName: `${component}/${platformKey}`,
          source: 'mojang'
        })
      }
    }
    return out
  }

  private async installMojangComponent(
    candidate: JavaInstallCandidate,
    opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void }
  ): Promise<JavaRuntimeInfo> {
    const manifest = await this.fetchJsonWithMirror<MojangRuntimeManifest>(candidate.url, opts.signal)
    const files = manifest.files
    if (!files || typeof files !== 'object') {
      throw new Error(`Mojang 运行时清单格式异常（缺少 files 字段）：${candidate.url}`)
    }

    const targetRoot = join(this.installerRoot, candidate.dirName)
    await ensureDir(targetRoot)

    const items: DownloadItem[] = []
    const dirs: string[] = []
    const links: { path: string; target: string }[] = []
    const executables: string[] = []

    for (const [rawPath, entry] of Object.entries(files)) {
      const rel = relPath(rawPath)
      if (!rel) continue
      if (entry.type === 'directory') {
        dirs.push(join(targetRoot, rel))
        continue
      }
      if (entry.type === 'link') {
        if (entry.target) links.push({ path: join(targetRoot, rel), target: entry.target })
        continue
      }
      if (!entry.type || entry.type === 'file') {
        // 只要 raw：lzma 版本官方用于省流量，需要额外解压器，明确不支持
        const raw = entry.downloads?.raw
        if (!raw?.url) {
          log.warn(`运行时文件 ${rel} 缺少 downloads.raw，已跳过`)
          continue
        }
        const mirrored = this.mirror.resolve(raw.url, 'mojang')
        const dest = join(targetRoot, rel)
        items.push({
          key: `mojang-java:${candidate.id}:${rel}`,
          url: raw.url,
          fallbackUrls: mirrored !== raw.url ? [mirrored] : undefined,
          dest,
          sha1: raw.sha1,
          size: raw.size
        })
        if (entry.executable) executables.push(dest)
      }
    }

    const result = await this.downloadManager.runTask(`java-install:${candidate.id}`, {
      label: `安装 Java 运行时（${candidate.vendor} ${candidate.version}）`,
      items,
      concurrency: 8,
      signal: opts.signal,
      onProgress: opts.onProgress
    })
    if (!result.ok) {
      const detail = result.failures
        .slice(0, 3)
        .map((f) => `- ${f.url}：${f.error}`)
        .join('\n')
      throw new Error(`Java 运行时下载失败（${result.completed}/${result.total} 文件）：\n${detail}`)
    }

    for (const dir of dirs) await ensureDir(dir)
    // link 类型：Windows 上创建符号链接常因权限失败，退回复制目标文件
    for (const link of links) {
      const targetAbs = join(targetRoot, relPath(link.target) ?? link.target)
      await createLinkOrCopy(targetAbs, link.path)
    }
    if (currentOs() !== 'windows') {
      for (const exe of executables) await chmod(exe, 0o755).catch(() => undefined)
    }

    return this.verifyInstallation(targetRoot, candidate.id, candidate.id)
  }

  /* ---------------- Adoptium Temurin（tar.gz） ---------------- */

  private async listAdoptiumCandidates(majorVersion: number, signal?: AbortSignal): Promise<JavaInstallCandidate[]> {
    const os = adoptiumOs()
    const arch = adoptiumArch()
    const url = `${OFFICIAL_ENDPOINTS.adoptiumApi}/assets/latest/${majorVersion}/hotspot?os=${os}&architecture=${arch}&image_type=jre`
    const assets = await this.client.getJson<AdoptiumAsset[]>(url, { signal, timeoutMs: 30_000 })
    const out: JavaInstallCandidate[] = []
    for (const asset of Array.isArray(assets) ? assets : []) {
      const pkg = asset.binary?.package
      if (!pkg?.link) continue
      const version = asset.version?.semver ?? String(asset.version?.major ?? majorVersion)
      out.push({
        id: `adoptium:${majorVersion}:${os}-${arch}`,
        vendor: 'Temurin',
        version,
        majorVersion,
        os: currentOs(),
        arch: currentArch(),
        url: pkg.link,
        size: pkg.size,
        dirName: `temurin-${majorVersion}-${os}-${arch}`,
        source: 'adoptium'
      })
    }
    return out
  }

  private async installArchive(
    candidate: JavaInstallCandidate,
    opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void }
  ): Promise<JavaRuntimeInfo> {
    const tmpDir = join(this.installerRoot, '.tmp')
    await ensureDir(tmpDir)
    const archive = join(tmpDir, `${sanitizeFileName(candidate.id.replace(/[:/\\]/g, '_'))}.tar.gz`)
    try {
      await this.downloadManager.downloadOne(
        {
          key: `java-archive:${candidate.id}`,
          url: candidate.url,
          fallbackUrls: candidate.mirrorUrl ? [candidate.mirrorUrl] : undefined,
          dest: archive
        },
        opts.signal
      )

      const targetRoot = join(this.installerRoot, candidate.dirName)
      // 复用已下载的归档但目录不完整时会导致半成品，直接清空重来
      await removePath(targetRoot)
      await ensureDir(targetRoot)
      log.info(`解压 Java 运行时：${archive} → ${targetRoot}`)
      await extractTarGz(archive, targetRoot, { stripComponents: 1, signal: opts.signal })
    } finally {
      await rm(archive, { force: true }).catch(() => undefined)
    }

    return this.verifyInstallation(join(this.installerRoot, candidate.dirName), candidate.id, candidate.id)
  }

  /* ---------------- 公共辅助 ---------------- */

  /** 下载完成后定位 java 可执行文件并真实探测，失败即抛错（避免留下损坏的运行时被当成可用） */
  private async verifyInstallation(root: string, label: string, component: string): Promise<JavaRuntimeInfo> {
    const executables = await findJavaExecutables(root, 5)
    const exe = executables[0]
    if (!exe) {
      throw new Error(`Java 运行时安装不完整（${label}）：在 ${root} 中找不到 bin/java`)
    }
    const info = await probeJava(exe, { managed: true, component })
    if (!info || info.majorVersion <= 0) {
      throw new Error(`Java 运行时安装完成但探测失败（${label}）：${info?.error ?? '未知原因'}`)
    }
    log.info(`Java 运行时就绪：${info.path}（Java ${info.majorVersion}，${info.vendor ?? '未知发行版'}）`)
    return info
  }

  private async fetchJsonWithMirror<T>(url: string, signal?: AbortSignal): Promise<T> {
    const urls = [url]
    const mirrored = this.mirror.resolve(url, 'mojang')
    if (mirrored !== url) urls.push(mirrored)
    let lastError: Error | null = null
    for (const candidate of urls) {
      try {
        return await this.client.getJson<T>(candidate, { signal, timeoutMs: 60_000 })
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        log.debug(`获取失败 ${candidate}：${lastError.message}`)
      }
    }
    throw lastError ?? new Error(`无法获取 ${url}`)
  }
}

/* ------------------------------------------------------------------ *
 *  Adoptium 平台参数
 * ------------------------------------------------------------------ */

function adoptiumOs(): string {
  const os = currentOs()
  if (os === 'windows') return 'windows'
  if (os === 'osx') return 'mac'
  return 'linux'
}

function adoptiumArch(): string {
  const arch = currentArch()
  if (arch === 'x64') return 'x64'
  if (arch === 'x86') return 'x86'
  if (arch === 'arm64') return 'aarch64'
  return 'arm'
}

/* ------------------------------------------------------------------ *
 *  路径 / 链接辅助
 * ------------------------------------------------------------------ */

/** 将清单里的相对路径归一化；含 .. 或为空则返回 null（防目录穿越） */
function relPath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!normalized) return null
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.')
  if (parts.length === 0 || parts.some((p) => p === '..')) return null
  return parts.join('/')
}

async function createLinkOrCopy(target: string, linkPath: string): Promise<void> {
  if (!(await pathExists(target))) {
    log.warn(`链接目标不存在，已跳过：${linkPath} → ${target}`)
    return
  }
  await ensureDir(dirname(linkPath))
  try {
    // 相对链接名：与官方启动器一致（可用 launcher 移动整个 runtime 目录）
    const relativeTarget = relativePosix(dirname(linkPath), target)
    await symlink(relativeTarget, linkPath, 'file')
    return
  } catch {
    /* Windows 未开启开发者模式 / 无权限：退回复制 */
  }
  try {
    await copyFile(target, linkPath)
  } catch (err) {
    log.warn(`创建链接与复制均失败：${linkPath}（${messageOf(err)}）`)
  }
}

function relativePosix(from: string, to: string): string {
  const fromParts = from.replace(/\\/g, '/').split('/').filter(Boolean)
  const toParts = to.replace(/\\/g, '/').split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && normalizePathForCompare(fromParts[common]) === normalizePathForCompare(toParts[common])) {
    common++
  }
  const up = new Array(fromParts.length - common).fill('..')
  return [...up, ...toParts.slice(common)].join('/') || '.'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ *
 *  最小 tar.gz 解包器（只处理文件与目录）
 * ------------------------------------------------------------------ */

export interface TarExtractOptions {
  /** 剥离前 N 层路径组件（Adoptium 的归档顶层是 jdk-17.0.9+9/） */
  stripComponents?: number
  signal?: AbortSignal
}

export interface TarExtractResult {
  files: number
  dirs: number
  skipped: number
}

/**
 * 流式解出 tar.gz 内容。支持：
 *  - ustar 头（含 prefix 字段拼长路径）
 *  - pax 扩展头（typeflag 'x'，只取 path / linkpath 记录）
 *  - GNU longname（typeflag 'L'）
 *  - GNU base-256 数字编码（超大文件）
 * 其余类型（符号链接、硬链接、设备文件等）一律跳过 —— JRE 发行包里只需要文件与目录。
 */
export async function extractTarGz(archivePath: string, destDir: string, opts: TarExtractOptions = {}): Promise<TarExtractResult> {
  const strip = Math.max(0, opts.stripComponents ?? 0)
  await ensureDir(destDir)

  const source = createReadStream(archivePath)
  const gunzip = createGunzip()
  const reader = new ByteReader(source.pipe(gunzip))

  const result: TarExtractResult = { files: 0, dirs: 0, skipped: 0 }
  let pendingName: string | null = null

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('aborted')
      const header = await reader.readExact(512)
      if (!header) break
      // 全零块：归档结束标记（标准是两个，但有的实现只写一个），继续读到 EOF 自然退出
      if (isZeroBlock(header)) continue
      if (!tarChecksumOk(header)) throw new Error(`tar 头校验失败，归档可能损坏：${archivePath}`)

      const size = tarNumber(header, 124, 12)
      const mode = tarNumber(header, 100, 8)
      const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156])
      const rawName = tarString(header, 0, 100)
      const prefix = isUstar(header) ? tarString(header, 345, 155) : ''

      // GNU longname / pax 头：内容是「下一个条目的名字」
      if (typeFlag === 'L') {
        const data = await reader.readExact(size)
        pendingName = data ? stripTrailingNulls(decodeUtf8(data)) : null
        await reader.skipExact(pad512(size))
        continue
      }
      if (typeFlag === 'x' || typeFlag === 'g') {
        const data = await reader.readExact(size)
        const records = data ? parsePaxRecords(data) : null
        if (typeFlag === 'x' && records?.path) pendingName = records.path
        await reader.skipExact(pad512(size))
        continue
      }
      if (typeFlag === 'K') {
        // GNU longlink：我们不解压链接，直接跳过内容
        await reader.skipExact(size + pad512(size))
        continue
      }

      const fullName = pendingName ?? (prefix ? `${prefix}/${rawName}` : rawName)
      pendingName = null
      const safe = sanitizeTarPath(fullName, strip)

      if (typeFlag === '5') {
        if (safe) {
          await ensureDir(join(destDir, safe))
          result.dirs++
        }
      } else if (typeFlag === '0' || typeFlag === '7') {
        if (!safe) {
          // 被 strip 掉的顶层文件（例如目录条目）或穿越路径
          await reader.skipExact(size + pad512(size))
          result.skipped++
        } else {
          await writeTarFile(reader, join(destDir, safe), size, mode)
          result.files++
        }
      } else {
        // 符号链接 / 硬链接 / 其他类型：跳过（JRE 包里这些不是运行时必需）
        await reader.skipExact(size + pad512(size))
        result.skipped++
      }
    }
  } finally {
    source.destroy()
    gunzip.destroy()
  }

  return result
}

/** 增量读取器：把异步 chunk 流包装成「恰好读 N 字节」的接口 */
class ByteReader {
  private iterator: AsyncIterator<Buffer | Uint8Array>
  private current: Buffer | null = null
  private offset = 0
  private ended = false

  constructor(stream: AsyncIterable<Buffer | Uint8Array>) {
    this.iterator = stream[Symbol.asyncIterator]()
  }

  private async fill(): Promise<boolean> {
    while (!this.ended) {
      const next = await this.iterator.next()
      if (next.done) {
        this.ended = true
        return false
      }
      const buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
      if (buffer.length === 0) continue
      this.current = buffer
      this.offset = 0
      return true
    }
    return false
  }

  /** 恰好读取 n 字节；流已结束且一字节都没读到返回 null（部分读出时返回不足的部分） */
  async readExact(n: number): Promise<Buffer | null> {
    if (n <= 0) return Buffer.alloc(0)
    const parts: Buffer[] = []
    let remaining = n
    while (remaining > 0) {
      if (!this.current || this.offset >= this.current.length) {
        if (!(await this.fill())) break
      }
      const chunk = this.current as Buffer
      const take = Math.min(remaining, chunk.length - this.offset)
      parts.push(chunk.subarray(this.offset, this.offset + take))
      this.offset += take
      remaining -= take
    }
    if (remaining === n) return null
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }

  /** 丢弃 n 字节，流结束提前返回 false */
  async skipExact(n: number): Promise<boolean> {
    let remaining = n
    while (remaining > 0) {
      if (!this.current || this.offset >= this.current.length) {
        if (!(await this.fill())) return false
      }
      const chunk = this.current as Buffer
      const take = Math.min(remaining, chunk.length - this.offset)
      this.offset += take
      remaining -= take
    }
    return true
  }
}

async function writeTarFile(reader: ByteReader, target: string, size: number, mode: number): Promise<void> {
  await ensureDir(dirname(target))
  const handle = await open(target, 'w')
  try {
    let remaining = size
    while (remaining > 0) {
      const chunk = await reader.readExact(Math.min(remaining, 64 * 1024))
      if (!chunk || chunk.length === 0) throw new Error(`归档数据意外结束：${target}`)
      await handle.write(chunk)
      remaining -= chunk.length
    }
  } finally {
    await handle.close()
  }
  await reader.skipExact(pad512(size))
  // 可执行位（POSIX）；Windows 上 chmod 只是改只读属性，无害
  if (mode & 0o111) await chmod(target, 0o755).catch(() => undefined)
}

function pad512(size: number): number {
  return (512 - (size % 512)) % 512
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

function isUstar(header: Buffer): boolean {
  return header.toString('ascii', 257, 262) === 'ustar'
}

function tarString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length)
  const nul = slice.indexOf(0)
  const data = nul >= 0 ? slice.subarray(0, nul) : slice
  return data.toString('utf8').trim()
}

function tarNumber(buffer: Buffer, start: number, length: number): number {
  const raw = buffer.subarray(start, start + length)
  // GNU base-256：最高位为 1 时按大端整数解析（tar 支持超过 8GB 的文件）
  if (raw.length > 0 && (raw[0] & 0x80) !== 0) {
    let value = raw[0] & 0x7f
    for (let i = 1; i < raw.length; i++) value = value * 256 + raw[i]
    return value
  }
  const text = raw.toString('ascii').replace(/\0[\s\S]*$/, '').trim()
  const parsed = Number.parseInt(text, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

function tarChecksumOk(header: Buffer): boolean {
  const expected = tarNumber(header, 148, 8)
  if (expected === 0) return false
  let sum = 0
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i] // 校验和计算时该字段视为 8 个空格
  }
  return sum === expected
}

function decodeUtf8(data: Buffer): string {
  return data.toString('utf8')
}

function stripTrailingNulls(text: string): string {
  return text.replace(/\0[\s\S]*$/, '')
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length)
    const eq = record.indexOf(0x3d)
    if (eq > 0) {
      const key = record.subarray(0, eq).toString('ascii')
      // 记录值以 \n 结尾
      const value = record.subarray(eq + 1, record.length - 1).toString('utf8')
      if (key) out[key] = value
    }
    offset += length
  }
  return out
}

/** 归一化 tar 内路径并剥离前 N 层；含 .. 或剥离后为空时返回 null */
export function sanitizeTarPath(raw: string, stripComponents: number): string | null {
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
  if (!normalized) return null
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.')
  if (parts.some((p) => p === '..')) return null
  const stripped = parts.slice(Math.max(0, stripComponents))
  if (stripped.length === 0) return null
  return stripped.join('/')
}
