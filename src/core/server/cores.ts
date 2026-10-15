/**
 * 服务端核心注册表：每个核心的「可用 MC 版本 / 可用构建 / 安装实现」。
 *
 * 端点与启动方式的依据（逐项核对公开文档与 reference/HMCL 的实现）：
 *
 *  - vanilla：服务端 jar 来自版本 json 的 `downloads.server`（HMCL VanillaInstallTask 同款）；
 *    BMCLAPI 备用地址 `https://bmclapi2.bangbang93.com/version/<id>/server`（BMCLAPI 文档）。
 *  - Paper：PaperMC API v2
 *      `GET {paperApi}/projects/paper/versions`           → { versions: [...] }
 *      `GET {paperApi}/projects/paper/versions/<mc>/builds` → 构建数组
 *      `GET {paperApi}/projects/paper/versions/<mc>/builds/<build>/downloads/<name>`
 *    反直觉点：下载道具的键在版本间变化（1.20.6 起由 `application` 变为 `server:default`），
 *    因此这里按 application → server → server:default → 任意 .jar 键的顺序兼容，
 *    并优先用响应里的 `name` 拼 URL（PaperMC 官方下载页也是这么生成的）。
 *  - Purpur：`GET {purpurApi}/purpur`、`GET {purpurApi}/purpur/<mc>`
 *    （`{ builds: { latest, all: [...] } }`），下载 `GET {purpurApi}/purpur/<mc>/<build>/download`
 *    （302 到实际文件；HttpClient.downloadToFile 基于 fetch，会自动跟随重定向）。
 *  - Fabric：`GET {fabricMeta}/v2/versions/game`、`GET {fabricMeta}/v2/versions/loader/<mc>`，
 *    下载 `GET {fabricMeta}/v2/versions/loader/<mc>/<loader>/server/jar`。
 *    服务端启动器布局与 fabric-installer 一致：`fabric-server-launch.jar` +
 *    `fabric-server-launcher.properties`（内容 `serverJar=server.jar`），
 *    且**必须**由用户提供同目录下的原版 `server.jar` 作为父级（Fabric 启动器会去读它）。
 *  - Quilt：meta v3 结构同 Fabric（`{quiltMeta}/v3/...`），启动器 jar 命名为
 *    `quilt-server-launch.jar`，属性文件 `quilt-server-launcher.properties`。
 *  - Forge / NeoForge：官方 installer，`java -jar <installer> --installServer <dir>`
 *    （见 installer-jar.ts#runInstallerJar）。新版产物是
 *    `libraries/<group>/<artifact>/<ver>/{win,unix}_args.txt`，**正确启动方式是 @ 语法**：
 *    `java <jvmArgs> @libraries/.../win_args.txt nogui`（Forge 官方 run.bat/run.sh 同款）。
 *    installer 生成的 `user_jvm_args.txt` 由官方脚本 @ 引入，本启动器自行传入 JVM 参数，
 *    因此不 @ 它（否则参数会重复）。
 *  - Spigot：官方不提供可直接下载的 jar，必须用 BuildTools 编译（hub.spigotmc.org 官方说明）。
 *    本模块只返回 manualSteps，绝不伪造下载地址。
 *  - custom：用户自备 jar，install 只做存在性校验。
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DownloadItem,
  DownloadProgress,
  JavaRuntimeInfo,
  ServerCoreDownload,
  ServerCoreType,
  VersionDetail
} from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import { BMCLAPI_ENDPOINTS, OFFICIAL_ENDPOINTS } from '@core/net/mirror'
import { DownloadManager } from '@core/net/downloader'
import type { VersionManifestService } from '@core/mojang/manifest'
import { resolveInstallerJava, runInstallerJar } from '@core/loaders/installer-jar'
import { parseForgeMavenVersion } from '@core/loaders/forge'
import { parseNeoForgeMavenVersion } from '@core/loaders/neoforge'
import { cleanGameVersion, compareVersions } from '@core/util/misc'
import { ensureDir, pathExists, sanitizeFileName, toPosix, writeFileAtomic } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('server:cores')

/* ------------------------------------------------------------------ *
 *  公共类型
 * ------------------------------------------------------------------ */

/** 安装进度回调载荷（ratio 为 0~1 的整体进度） */
export interface ServerInstallProgress {
  phase: string
  message: string
  ratio: number
  download?: DownloadProgress
}

/** Java 运行时提供者：JavaScanner 结构上满足；测试可注入假实现 */
export interface JavaProviderLike {
  scan(): Promise<JavaRuntimeInfo[]>
  probe(path: string): Promise<JavaRuntimeInfo | null>
}

export interface ServerInstallOptions {
  /** 服务端目录（绝对路径） */
  dir: string
  gameVersion: string
  /** 构建号：Paper/Purpur 的 build、Fabric/Quilt 的 loader 版本、Forge/NeoForge 的加载器版本 */
  build?: string
  /** custom 核心：目录内已有的 jar 文件名 */
  fileName?: string
  /** 兼容别名：加载器版本（fabric/forge 等） */
  loaderVersion?: string
  javaPath?: string
  java?: JavaProviderLike
  signal?: AbortSignal
  onProgress?: (p: ServerInstallProgress) => void
  /** vanilla 需要：版本详情（上层可传入以避免重复请求） */
  versionDetail?: VersionDetail
}

export interface ServerInstallResult {
  /** 启动所需的 jar 文件名（Forge/NeoForge 新式安装没有 jar，则为 @args.txt 的相对路径或空串） */
  jarFile: string
  fileName: string
  coreType: ServerCoreType
  gameVersion: string
  build?: string
  /** 需要写入的额外文件（本模块已写入；返回给上层做展示与幂等重放） */
  extraFiles?: { path: string; content: string }[]
  /** 需要用户手动完成的步骤（例如 Spigot 需要 BuildTools） */
  manualSteps?: string[]
  warnings: string[]
}

export interface ServerCoreProvider {
  type: ServerCoreType
  name: string
  /** 该核心支持哪些 MC 版本 */
  listGameVersions(opts?: { refresh?: boolean }): Promise<string[]>
  /** 该核心某 MC 版本下的可用构建 */
  listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]>
  /** 安装该核心到目标目录（下载 jar、必要时运行 installer） */
  install(opts: ServerInstallOptions): Promise<ServerInstallResult>
  /** 是否需要 Java 运行 installer */
  requiresJava: boolean
  note: string
}

export interface ServerCoreContext {
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  manifest?: VersionManifestService
}

/* ------------------------------------------------------------------ *
 *  通用工具
 * ------------------------------------------------------------------ */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 从 URL 中取文件名（用于诊断原文件名） */
export function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const last = path.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last)
  } catch {
    return ''
  }
}

/** 解析 content-disposition 里的文件名（Fabric Meta 返回的规范名仅用于诊断） */
export function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header)
  if (star) {
    const value = star[1].trim()
    const parts = value.split("''")
    const encoded = (parts.length > 1 ? parts[1] : value).replace(/^"|"$/g, '')
    try {
      const decoded = decodeURIComponent(encoded)
      if (decoded) return decoded
    } catch {
      /* 编码异常时退回普通 filename */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header)
  if (plain) {
    const name = (plain[2] ?? plain[3] ?? '').trim()
    if (name) return name
  }
  return null
}

/** Fabric 服务端启动器的固定文件名（与 fabric-installer 的服务端布局一致） */
export function fabricServerLauncherFileName(): string {
  return 'fabric-server-launch.jar'
}

/** Quilt 服务端启动器的固定文件名 */
export function quiltServerLauncherFileName(): string {
  return 'quilt-server-launch.jar'
}

/** 版本号降序（新版在前） */
function sortVersionsDesc(values: string[]): string[] {
  return [...values].sort((a, b) => compareVersions(b, a))
}

/** 小型 TTL 缓存：refresh 时绕过缓存 */
class TtlCache<T> {
  private readonly map = new Map<string, { at: number; value: T }>()
  constructor(private readonly ttlMs: number) {}

  get(key: string, refresh?: boolean): T | null {
    const hit = this.map.get(key)
    if (!hit) return null
    if (!refresh && Date.now() - hit.at < this.ttlMs) return hit.value
    return null
  }

  set(key: string, value: T): void {
    this.map.set(key, { at: Date.now(), value })
  }
}

/**
 * Forge / NeoForge 新式安装产物的参数文件根目录。
 * 版本目录名（`1.20.1-47.2.0` 等）无法完全静态推导，因此按前缀扫描。
 */
export const ARGS_FILE_ROOTS: { coreType: ServerCoreType; root: string }[] = [
  { coreType: 'forge', root: 'libraries/net/minecraftforge/forge' },
  { coreType: 'neoforge', root: 'libraries/net/neoforged/neoforge' },
  { coreType: 'neoforge', root: 'libraries/net/neoforged/forge' }
]

/**
 * 在服务端目录中查找 Forge/NeoForge 新版的 `@args.txt` 参数文件。
 * 返回相对路径（posix 风格）与所属核心；同一版本目录仅一个平台文件存在。
 */
export async function findServerArgsFile(
  dir: string,
  platform: NodeJS.Platform = process.platform
): Promise<{ path: string; coreType: ServerCoreType } | null> {
  const names = platform === 'win32' ? ['win_args.txt', 'unix_args.txt'] : ['unix_args.txt', 'win_args.txt']
  for (const { coreType, root } of ARGS_FILE_ROOTS) {
    const rootDir = join(dir, root)
    const versions = await readdir(rootDir).catch(() => [] as string[])
    // 重装/升级可能留下多个版本目录，取版本号最大的（新装的）
    for (const version of sortVersionsDesc(versions)) {
      for (const name of names) {
        if (await pathExists(join(rootDir, version, name))) {
          return { path: toPosix(join(root, version, name)), coreType }
        }
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 *  Provider 基类
 * ------------------------------------------------------------------ */

abstract class BaseProvider implements ServerCoreProvider {
  abstract readonly type: ServerCoreType
  abstract readonly name: string
  abstract readonly requiresJava: boolean
  abstract readonly note: string
  protected readonly ctx: ServerCoreContext

  constructor(ctx: ServerCoreContext) {
    this.ctx = ctx
  }

  abstract listGameVersions(opts?: { refresh?: boolean }): Promise<string[]>
  abstract listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]>
  abstract install(opts: ServerInstallOptions): Promise<ServerInstallResult>

  protected report(opts: ServerInstallOptions, phase: string, message: string, ratio: number, download?: DownloadProgress): void {
    try {
      opts.onProgress?.({ phase, message, ratio, download })
    } catch (err) {
      log.warn(`安装进度回调异常：${errorMessage(err)}`)
    }
  }

  /** 多地址（含镜像回退）取 JSON */
  protected async fetchJson<T>(urls: string[], opts: { signal?: AbortSignal; label: string }): Promise<T> {
    const errors: string[] = []
    for (const url of [...new Set(urls.filter(Boolean))]) {
      try {
        return await this.ctx.client.getJson<T>(url, { retries: 1, signal: opts.signal })
      } catch (err) {
        errors.push(`${url}：${errorMessage(err)}`)
      }
    }
    throw new Error(`获取${opts.label}失败，已尝试以下地址：\n${errors.map((e) => `- ${e}`).join('\n')}`)
  }

  /** 多地址（含镜像回退）取文本 */
  protected async fetchText(urls: string[], opts: { signal?: AbortSignal; label: string }): Promise<string> {
    const errors: string[] = []
    for (const url of [...new Set(urls.filter(Boolean))]) {
      try {
        return await this.ctx.client.getText(url, { retries: 1, signal: opts.signal })
      } catch (err) {
        errors.push(`${url}：${errorMessage(err)}`)
      }
    }
    throw new Error(`获取${opts.label}失败，已尝试以下地址：\n${errors.map((e) => `- ${e}`).join('\n')}`)
  }

  /** 通过 DownloadManager 下载单个文件（带哈希校验与地址回退），失败抛错 */
  protected async downloadFile(opts: ServerInstallOptions, item: DownloadItem, label: string): Promise<void> {
    const result = await this.ctx.downloadManager.fetchFiles(`server-${this.type}-${item.key}`, label, [item], {
      signal: opts.signal,
      continueOnError: false,
      onProgress: (p) =>
        this.report(opts, 'download', DownloadManager.describeProgress(p), 0.2 + 0.7 * (p.completed / Math.max(1, p.total)), p)
    })
    if (!result.ok || result.failures.length > 0) {
      const detail = result.failures.map((f) => `${f.url || f.key}（${f.error}）`).join('；')
      log.warn(`${label} 下载失败：${detail}`)
      throw new Error(`${label} 下载失败：${detail || '未知错误'}`)
    }
  }

  /** HEAD 探测远端文件名（仅诊断用，失败返回 null） */
  protected async probeRemoteFileName(url: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const response = await this.ctx.client.head(url, { signal, retries: 0, timeoutMs: 15_000 })
      if (!response.ok) return null
      return parseContentDispositionFilename(response.headers.get('content-disposition'))
    } catch {
      return null
    }
  }

  /** 解析运行 installer 所需的 Java（javaPath 优先，其次扫描） */
  protected async resolveJava(opts: ServerInstallOptions, gameVersion: string): Promise<string> {
    if (opts.javaPath && (await pathExists(opts.javaPath))) return opts.javaPath
    if (!opts.java && !opts.javaPath) {
      throw new Error('运行安装器需要 Java：请传入 javaPath，或通过 java 传入 JavaProvider（例如 JavaScanner）')
    }
    const provider: JavaProviderLike = opts.java ?? {
      scan: async () => [],
      probe: async () => null
    }
    return resolveInstallerJava({ java: provider, javaPath: opts.javaPath, gameVersion })
  }
}

/* ------------------------------------------------------------------ *
 *  Vanilla（原版）
 * ------------------------------------------------------------------ */

export class VanillaServerCore extends BaseProvider {
  readonly type = 'vanilla' as const
  readonly name = 'Vanilla 原版'
  readonly requiresJava = false
  readonly note = 'Mojang 官方服务端（版本 json 的 downloads.server）：最稳定、无插件/模组能力，适合纯原版联机'

  private requireManifest(): VersionManifestService {
    if (!this.ctx.manifest) {
      throw new Error('vanilla 核心需要 VersionManifestService：请在构造 ServerCoreRegistry 时传入 manifest')
    }
    return this.ctx.manifest
  }

  async listGameVersions(opts: { refresh?: boolean } = {}): Promise<string[]> {
    const manifest = await this.requireManifest().getManifest({ forceRefresh: opts.refresh })
    return manifest.versions.map((v) => v.id)
  }

  async listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const detail = await this.requireManifest().fetchVersionDetail(gameVersion)
    const server = detail.downloads?.server
    if (!server?.url) return []
    return [
      {
        coreType: 'vanilla',
        gameVersion,
        url: server.url,
        fileName: 'server.jar',
        size: server.size
      }
    ]
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const warnings: string[] = []
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const detail = opts.versionDetail ?? (await this.requireManifest().fetchVersionDetail(gameVersion))
    const server = detail.downloads?.server
    if (!server?.url) {
      throw new Error(
        `Minecraft ${gameVersion} 的版本 json 没有 downloads.server（该版本没有官方服务端 jar）；` +
          '请改用 Paper / Purpur 等第三方核心，或使用「自定义核心」指向自备 jar'
      )
    }
    const originalName = fileNameFromUrl(server.url)
    if (originalName && originalName !== 'server.jar') {
      warnings.push(`官方文件名为 ${originalName}，已统一保存为 server.jar（便于启动与诊断；sha1=${server.sha1 ?? '未提供'}）`)
    }
    await ensureDir(opts.dir)
    this.report(opts, 'download', `下载原版服务端 ${gameVersion}`, 0.05)
    await this.downloadFile(
      opts,
      {
        key: `vanilla-${gameVersion}`,
        url: server.url,
        // BMCLAPI 的等价地址（sha1 相同，可直接作为回退源）
        fallbackUrls: [`${BMCLAPI_ENDPOINTS.root}/version/${gameVersion}/server`],
        dest: join(opts.dir, 'server.jar'),
        sha1: server.sha1,
        size: server.size
      },
      `原版服务端 ${gameVersion}`
    )
    this.report(opts, 'done', '原版服务端安装完成', 1)
    return { jarFile: 'server.jar', fileName: 'server.jar', coreType: 'vanilla', gameVersion, warnings }
  }
}

/* ------------------------------------------------------------------ *
 *  Paper
 * ------------------------------------------------------------------ */

interface PaperBuildJson {
  build?: number | string
  channel?: string
  downloads?: Record<string, { name?: string; sha256?: string; size?: number } | undefined>
}

interface PaperBuildEntry {
  build: string
  channel?: string
  name: string
  sha256?: string
  size?: number
  url: string
}

/**
 * 选取 builds 响应中的下载道具。
 * 兼容 `application`（1.20.6 之前）→ `server` → `server:default`（1.20.6 起）→ 任意 .jar 键。
 */
export function pickPaperDownload(downloads: PaperBuildJson['downloads']): { name: string; sha256?: string; size?: number } | null {
  if (!downloads) return null
  const priority = ['application', 'server', 'server:default']
  for (const key of priority) {
    const item = downloads[key]
    if (item?.name && /\.jar$/i.test(item.name)) return { name: item.name, sha256: item.sha256, size: item.size }
  }
  for (const [key, item] of Object.entries(downloads)) {
    if (!item?.name) continue
    if (/\.jar$/i.test(item.name) && key !== 'mojang-mappings') return { name: item.name, sha256: item.sha256, size: item.size }
  }
  return null
}

export class PaperServerCore extends BaseProvider {
  readonly type = 'paper' as const
  readonly name = 'Paper'
  readonly requiresJava = false
  readonly note = '高性能插件服务端（PaperMC 官方 API，支持 1.8.8 ~ 最新版），与 Spigot/Bukkit 插件兼容'
  private readonly cache = new TtlCache<PaperBuildEntry[]>(5 * 60_000)

  private base(): string {
    return OFFICIAL_ENDPOINTS.paperApi.replace(/\/+$/, '')
  }

  async listGameVersions(opts: { refresh?: boolean } = {}): Promise<string[]> {
    const url = `${this.base()}/projects/paper/versions`
    const data = await this.fetchJson<{ versions?: string[] } | string[]>([url], { label: ' Paper 版本列表' })
    const versions = Array.isArray(data) ? data : (data.versions ?? [])
    return sortVersionsDesc(versions)
  }

  private async fetchBuilds(gameVersion: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PaperBuildEntry[]> {
    const cached = this.cache.get(gameVersion, opts.refresh)
    if (cached) return cached
    const url = `${this.base()}/projects/paper/versions/${encodeURIComponent(gameVersion)}/builds`
    const data = await this.fetchJson<PaperBuildJson[] | { builds?: PaperBuildJson[] }>([url], {
      signal: opts.signal,
      label: ` Paper ${gameVersion} 构建列表`
    })
    const list = Array.isArray(data) ? data : (data.builds ?? [])
    const entries: PaperBuildEntry[] = []
    for (const item of list) {
      const build = item.build !== undefined ? String(item.build) : ''
      if (!build) continue
      const download = pickPaperDownload(item.downloads)
      if (!download) continue
      entries.push({
        build,
        channel: typeof item.channel === 'string' ? item.channel : undefined,
        name: download.name,
        sha256: download.sha256,
        size: download.size,
        url: `${this.base()}/projects/paper/versions/${encodeURIComponent(gameVersion)}/builds/${encodeURIComponent(build)}/downloads/${download.name}`
      })
    }
    entries.sort((a, b) => compareVersions(b.build, a.build))
    this.cache.set(gameVersion, entries)
    return entries
  }

  async listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const builds = await this.fetchBuilds(gameVersion, { refresh: opts.refresh })
    return builds.map((b) => ({
      coreType: 'paper' as const,
      gameVersion,
      build: b.build,
      url: b.url,
      fileName: sanitizeFileName(b.name),
      size: b.size,
      channel: b.channel
    }))
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const builds = await this.fetchBuilds(gameVersion, { signal: opts.signal })
    if (builds.length === 0) {
      throw new Error(`Paper 没有可用于 MC ${gameVersion} 的构建（请确认版本号，Paper 不支持快照）`)
    }
    const wanted = opts.build?.trim()
    const entry =
      (wanted ? builds.find((b) => b.build === wanted) : undefined) ??
      // 默认取最新的稳定构建（experimental 构建不作为默认）
      (wanted ? undefined : builds.find((b) => b.channel !== 'experimental')) ??
      builds[0]
    if (!entry) throw new Error(`Paper 没有 build=${wanted}（MC ${gameVersion}）`)
    await ensureDir(opts.dir)
    const fileName = sanitizeFileName(entry.name)
    this.report(opts, 'download', `下载 Paper ${gameVersion} build ${entry.build}`, 0.2)
    await this.downloadFile(
      opts,
      {
        key: `paper-${gameVersion}-${entry.build}`,
        url: entry.url,
        dest: join(opts.dir, fileName),
        sha256: entry.sha256,
        size: entry.size
      },
      `Paper ${gameVersion} build ${entry.build}`
    )
    this.report(opts, 'done', 'Paper 安装完成', 1)
    return {
      jarFile: fileName,
      fileName,
      coreType: 'paper',
      gameVersion,
      build: entry.build,
      warnings: entry.channel === 'experimental' ? ['所选构建为 experimental（实验性）通道，可能不稳定'] : []
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Purpur
 * ------------------------------------------------------------------ */

interface PurpurBuildsJson {
  builds?: {
    latest?: string | number
    all?: (string | number)[]
  }
}

export class PurpurServerCore extends BaseProvider {
  readonly type = 'purpur' as const
  readonly name = 'Purpur'
  readonly requiresJava = false
  readonly note = 'Paper 的下游分支：提供更多可调参数（TPS 上限、刷怪控制等），插件与 Paper 兼容'

  private base(): string {
    return OFFICIAL_ENDPOINTS.purpurApi.replace(/\/+$/, '')
  }

  async listGameVersions(opts: { refresh?: boolean } = {}): Promise<string[]> {
    const url = `${this.base()}/purpur`
    const data = await this.fetchJson<{ versions?: string[] } | string[]>([url], { label: ' Purpur 版本列表' })
    const versions = Array.isArray(data) ? data : (data.versions ?? [])
    return sortVersionsDesc(versions)
  }

  async listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const url = `${this.base()}/purpur/${encodeURIComponent(gameVersion)}`
    const data = await this.fetchJson<PurpurBuildsJson>([url], { label: ` Purpur ${gameVersion} 构建列表` })
    const latest = data.builds?.latest !== undefined ? String(data.builds.latest) : undefined
    const all = Array.isArray(data.builds?.all) ? data.builds!.all.map((b) => String(b)) : []
    const builds = sortVersionsDesc(all)
    return builds.map((build) => ({
      coreType: 'purpur' as const,
      gameVersion,
      build,
      url: `${this.base()}/purpur/${encodeURIComponent(gameVersion)}/${encodeURIComponent(build)}/download`,
      fileName: `purpur-${gameVersion}-${build}.jar`,
      channel: latest === build ? 'latest' : undefined
    }))
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const builds = await this.listBuilds({ gameVersion })
    if (builds.length === 0) throw new Error(`Purpur 没有可用于 MC ${gameVersion} 的构建`)
    const wanted = opts.build?.trim()
    const entry = (wanted ? builds.find((b) => b.build === wanted) : undefined) ?? (wanted ? undefined : builds[0])
    if (!entry) throw new Error(`Purpur 没有 build=${wanted}（MC ${gameVersion}）`)
    await ensureDir(opts.dir)
    const fileName = sanitizeFileName(entry.fileName)
    this.report(opts, 'download', `下载 Purpur ${gameVersion} build ${entry.build}`, 0.2)
    await this.downloadFile(
      opts,
      { key: `purpur-${gameVersion}-${entry.build}`, url: entry.url, dest: join(opts.dir, fileName) },
      `Purpur ${gameVersion} build ${entry.build}`
    )
    this.report(opts, 'done', 'Purpur 安装完成', 1)
    return { jarFile: fileName, fileName, coreType: 'purpur', gameVersion, build: entry.build, warnings: [] }
  }
}

/* ------------------------------------------------------------------ *
 *  Fabric / Quilt（meta 协议同源，服务端启动器都是「launcher jar + 原版 server.jar」）
 * ------------------------------------------------------------------ */

interface FabricGameEntry {
  version?: string
  stable?: boolean
}

interface FabricLoaderEntry {
  loader?: { version?: string; stable?: boolean }
}

abstract class FabricLikeServerCore extends BaseProvider {
  protected abstract metaEndpoint(): string
  /** 支持的 MC 版本列表路径（Fabric 是 /v2/versions/game，Quilt 是 /v3/versions/game） */
  protected abstract gameListPath(): string
  protected abstract listPath(gameVersion: string): string
  protected abstract serverJarPath(gameVersion: string, loaderVersion: string): string
  protected abstract launcherFileName(): string
  protected abstract launcherPropertiesName(): string
  /** 展示名（错误提示用） */
  protected abstract displayName(): string

  protected metaBase(): string {
    return this.ctx.mirror.resolve(this.metaEndpoint(), 'fabric').replace(/\/+$/, '')
  }

  async listGameVersions(opts: { refresh?: boolean } = {}): Promise<string[]> {
    const url = `${this.metaBase()}${this.gameListPath()}`
    const data = await this.fetchJson<FabricGameEntry[] | { versions?: FabricGameEntry[] }>([url], {
      label: ` ${this.displayName()} 支持的 MC 版本`
    })
    const list = Array.isArray(data) ? data : (data.versions ?? [])
    const versions = list.map((v) => v.version).filter((v): v is string => typeof v === 'string' && v.length > 0)
    return sortVersionsDesc(versions)
  }

  /** 加载器列表（server 启动器 jar 按 loader 版本生成，因此每个 loader 版本就是一个「构建」） */
  protected async fetchLoaders(gameVersion: string, signal?: AbortSignal): Promise<{ version: string; stable: boolean }[]> {
    const url = `${this.metaBase()}${this.listPath(gameVersion)}`
    const data = await this.fetchJson<FabricLoaderEntry[]>([url], {
      signal,
      label: ` ${this.displayName()} ${gameVersion} 的 loader 列表`
    })
    const list = Array.isArray(data) ? data : []
    const loaders: { version: string; stable: boolean }[] = []
    for (const entry of list) {
      const version = entry?.loader?.version
      if (typeof version !== 'string' || version.length === 0) continue
      loaders.push({ version, stable: entry.loader?.stable !== false })
    }
    // 稳定版在前，其次版本号降序
    loaders.sort((a, b) => (a.stable === b.stable ? 0 : a.stable ? -1 : 1) || compareVersions(b.version, a.version))
    return loaders
  }

  async listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const loaders = await this.fetchLoaders(gameVersion)
    return loaders.map((l) => ({
      coreType: this.type,
      gameVersion,
      build: l.version,
      url: `${this.metaBase()}${this.serverJarPath(gameVersion, l.version)}`,
      fileName: this.launcherFileName(),
      channel: l.stable ? 'stable' : 'unstable'
    }))
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const warnings: string[] = []
    const manualSteps: string[] = []
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const wanted = opts.loaderVersion?.trim() || opts.build?.trim()
    const loaders = await this.fetchLoaders(gameVersion, opts.signal)
    const loader = (wanted ? loaders.find((l) => l.version === wanted) : undefined) ?? (wanted ? undefined : loaders[0])
    if (!loader) {
      throw new Error(
        wanted
          ? `${this.displayName()} Loader ${wanted} 不支持 MC ${gameVersion}`
          : `${this.displayName()} 没有可用于 MC ${gameVersion} 的 Loader`
      )
    }
    if (!loader.stable) warnings.push(`${this.displayName()} Loader ${loader.version} 标记为不稳定（unstable）`)

    await ensureDir(opts.dir)
    const fileName = this.launcherFileName()
    const url = `${this.metaBase()}${this.serverJarPath(gameVersion, loader.version)}`
    // 响应头里的规范文件名（fabric-server-mc.<mc>-loader.<lv>-launcher.<x>.<y>.<z>.jar）仅用于诊断：
    // 固定命名能保证启动脚本与文档一致，也避免 launcher 版本变化导致文件名漂移。
    const canonical = await this.probeRemoteFileName(url, opts.signal)
    if (canonical && canonical !== fileName) warnings.push(`Meta 返回的规范文件名为 ${canonical}，已固定保存为 ${fileName}`)

    this.report(opts, 'download', `下载 ${this.displayName()} 服务端启动器（loader ${loader.version}）`, 0.2)
    await this.downloadFile(
      opts,
      { key: `${this.type}-${gameVersion}-${loader.version}`, url, dest: join(opts.dir, fileName) },
      `${this.displayName()} 服务端启动器`
    )

    // 启动器读取同目录的 properties，缺省父级 jar 是 server.jar
    const propertiesPath = this.launcherPropertiesName()
    const propertiesContent = 'serverJar=server.jar\n'
    await writeFileAtomic(join(opts.dir, propertiesPath), propertiesContent)

    if (!(await pathExists(join(opts.dir, 'server.jar')))) {
      warnings.push(
        `${this.displayName()} 服务端启动器需要同目录下的原版 server.jar 作为父级，当前目录没有找到 server.jar`
      )
      manualSteps.push('请先安装原版（vanilla）服务端（或用 vanilla 核心安装一次），确保目录内存在 server.jar 后再启动')
    }

    this.report(opts, 'done', `${this.displayName()} 安装完成`, 1)
    return {
      jarFile: fileName,
      fileName,
      coreType: this.type,
      gameVersion,
      build: loader.version,
      extraFiles: [{ path: propertiesPath, content: propertiesContent }],
      manualSteps,
      warnings
    }
  }
}

export class FabricServerCore extends FabricLikeServerCore {
  readonly type = 'fabric' as const
  readonly name = 'Fabric'
  readonly requiresJava = false
  readonly note = '轻量模组加载器：服务端模组生态活跃；需自备同目录的原版 server.jar 作为父级'

  protected metaEndpoint(): string {
    return OFFICIAL_ENDPOINTS.fabricMeta
  }
  protected gameListPath(): string {
    return '/v2/versions/game'
  }
  protected listPath(gameVersion: string): string {
    return `/v2/versions/loader/${encodeURIComponent(gameVersion)}`
  }
  protected serverJarPath(gameVersion: string, loaderVersion: string): string {
    return `/v2/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/server/jar`
  }
  protected launcherFileName(): string {
    return fabricServerLauncherFileName()
  }
  protected launcherPropertiesName(): string {
    return 'fabric-server-launcher.properties'
  }
  protected displayName(): string {
    return 'Fabric'
  }
}

export class QuiltServerCore extends FabricLikeServerCore {
  readonly type = 'quilt' as const
  readonly name = 'Quilt'
  readonly requiresJava = false
  readonly note = 'Fabric 生态的衍生加载器（meta v3）；同样需要同目录的原版 server.jar'

  protected metaEndpoint(): string {
    return OFFICIAL_ENDPOINTS.quiltMeta
  }
  protected gameListPath(): string {
    return '/v3/versions/game'
  }
  protected listPath(gameVersion: string): string {
    return `/v3/versions/loader/${encodeURIComponent(gameVersion)}`
  }
  protected serverJarPath(gameVersion: string, loaderVersion: string): string {
    return `/v3/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/server/jar`
  }
  protected launcherFileName(): string {
    return quiltServerLauncherFileName()
  }
  protected launcherPropertiesName(): string {
    return 'quilt-server-launcher.properties'
  }
  protected displayName(): string {
    return 'Quilt'
  }
}

/* ------------------------------------------------------------------ *
 *  Forge / NeoForge（官方 installer + 新式 @args.txt 启动）
 * ------------------------------------------------------------------ */

abstract class InstallerJarServerCore extends BaseProvider {
  readonly requiresJava = true
  protected readonly mavenCache = new TtlCache<string[]>(10 * 60_000)
  private readonly promosCache = new TtlCache<Record<string, string>>(30 * 60_000)

  /** 官方 maven 根（用于镜像回退） */
  protected abstract mavenEndpoint(): string
  protected abstract displayName(): string

  /** 当前设置下解析出的 maven 根（可能是 BMCLAPI 镜像） */
  protected mavenBase(): string {
    return this.ctx.mirror.resolve(this.mavenEndpoint(), 'forge').replace(/\/+$/, '')
  }

  /** 主地址失败时回退官方 maven 的等价地址 */
  protected mavenFallbackUrls(url: string): string[] {
    const base = this.mavenBase()
    const official = this.mavenEndpoint()
    if (base !== official && url.startsWith(base)) return [url.replace(base, official)]
    return []
  }

  /** maven-metadata.xml → <version> 列表（带缓存与镜像回退） */
  protected async fetchMavenVersions(
    artifactPath: string,
    opts: { refresh?: boolean; signal?: AbortSignal } = {}
  ): Promise<string[]> {
    const cacheKey = artifactPath
    const cached = this.mavenCache.get(cacheKey, opts.refresh)
    if (cached) return cached
    const path = `${artifactPath}/maven-metadata.xml`
    const text = await this.fetchText([`${this.mavenBase()}/${path}`, `${this.mavenEndpoint()}/${path}`], {
      signal: opts.signal,
      label: ` ${this.displayName()} maven 版本列表`
    })
    const versions: string[] = []
    for (const match of text.matchAll(/<version>([^<]+)<\/version>/g)) {
      const value = match[1].trim()
      if (value) versions.push(value)
    }
    if (versions.length === 0) throw new Error(`${this.displayName()} maven-metadata.xml 未解析出任何版本（${path}）`)
    this.mavenCache.set(cacheKey, versions)
    return versions
  }

  /** promotions_slim.json → { "<mc>-recommended": "<forge>" }（失败时返回空表） */
  protected async fetchPromotions(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, string>> {
    const cached = this.promosCache.get('promos', opts.refresh)
    if (cached) return cached
    const mirror = this.ctx.mirror.get('forge')
    const urls = [
      mirror === 'bmclapi' ? BMCLAPI_ENDPOINTS.forgePromotions : '',
      OFFICIAL_ENDPOINTS.forgePromotions
    ].filter(Boolean)
    for (const url of urls) {
      try {
        const raw = await this.ctx.client.getJson<{ promos?: Record<string, string> }>(url, {
          retries: 1,
          signal: opts.signal
        })
        const promos = raw?.promos && typeof raw.promos === 'object' ? raw.promos : {}
        this.promosCache.set('promos', promos)
        return promos
      } catch (err) {
        log.debug(`${this.displayName()} promotions 获取失败（${url}）：${errorMessage(err)}`)
      }
    }
    this.promosCache.set('promos', {})
    return {}
  }

  /** 安装的公共流程：下载 installer → --installServer → 探测产物 */
  protected async installViaInstaller(
    opts: ServerInstallOptions,
    params: { installerUrl: string; installerName: string; build: string; gameVersion: string; installerLabel: string }
  ): Promise<ServerInstallResult> {
    const javaPath = await this.resolveJava(opts, params.gameVersion)
    await ensureDir(opts.dir)
    const installerPath = join(opts.dir, sanitizeFileName(params.installerName))
    this.report(opts, 'download', `下载 ${params.installerLabel}`, 0.1)
    await this.downloadFile(
      opts,
      {
        key: `${this.type}-installer-${params.build}`,
        url: params.installerUrl,
        fallbackUrls: this.mavenFallbackUrls(params.installerUrl),
        dest: installerPath
      },
      params.installerLabel
    )

    this.report(opts, 'installer', `运行 ${this.displayName()} 安装器（联网下载库、执行 processors，可能需要数分钟）`, 0.4)
    const result = await runInstallerJar({
      installerPath,
      gameDir: opts.dir,
      javaPath,
      side: 'server',
      signal: opts.signal,
      onOutput: (line) => this.report(opts, 'installer', line, 0.5)
    })
    if (!result.ok) {
      const tail = result.output.split(/\r?\n/).slice(-20).join('\n')
      throw new Error(`${this.displayName()} 安装器执行失败（退出码 ${result.code ?? 'null'}）：\n${tail}`)
    }

    /*
     * 产物探测：新版 Forge/NeoForge 生成
     *   libraries/<group>/<artifact>/<ver>/{win,unix}_args.txt   ← 正确启动方式（@ 语法）
     * 旧版只生成 run.bat/run.sh（内含 java -jar ...），本启动器不代跑脚本，
     * 因此写进 manualSteps 让用户手动启动或改用新版核心。
     */
    const warnings: string[] = []
    const manualSteps: string[] = []
    const args = await findServerArgsFile(opts.dir)
    let jarFile = ''
    if (args) {
      jarFile = args.path
    } else if ((await pathExists(join(opts.dir, 'run.bat'))) || (await pathExists(join(opts.dir, 'run.sh')))) {
      warnings.push('未找到 win_args.txt/unix_args.txt（可能是旧版 Forge/NeoForge），只生成了 run.bat/run.sh')
      manualSteps.push(
        `请手动运行 ${opts.dir} 下的 run.bat（Windows）或 run.sh（Linux/macOS）启动服务端，` +
          '或更新到支持 @args.txt 的新版 Forge/NeoForge，再交由启动器托管'
      )
    } else {
      warnings.push('安装器执行成功，但未检测到 @args.txt 参数文件或 run 脚本，请检查安装产物是否完整')
    }

    this.report(opts, 'done', `${this.displayName()} 安装完成`, 1)
    return {
      jarFile,
      fileName: jarFile,
      coreType: this.type,
      gameVersion: params.gameVersion,
      build: params.build,
      manualSteps,
      warnings
    }
  }
}

interface ForgeBuildEntry {
  build: string
  /** MC 版本（来自 maven 目录名解析，用于精确过滤） */
  gameVersion: string
  mavenDir: string
  fileName: string
  url: string
  channel?: string
}

export class ForgeServerCore extends InstallerJarServerCore {
  readonly type = 'forge' as const
  readonly name = 'Forge'
  readonly note = '老牌模组加载器（官方 installer 安装，启动用 @args.txt）；1.16.5 及更早整合包的事实标准'

  protected mavenEndpoint(): string {
    return OFFICIAL_ENDPOINTS.forgeMaven
  }
  protected displayName(): string {
    return 'Forge'
  }

  private mavenArtifactPath(): string {
    return 'net/minecraftforge/forge'
  }

  private async forgeBuilds(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ForgeBuildEntry[]> {
    const versions = await this.fetchMavenVersions(this.mavenArtifactPath(), opts)
    const promos = await this.fetchPromotions(opts)
    // 同一 forge 版本可能对应多个 maven 目录（pre4 / 末尾重复 MC 版本），优选精确目录名
    const byForgeVersion = new Map<string, { mavenDir: string; parsed: NonNullable<ReturnType<typeof parseForgeMavenVersion>> }>()
    for (const raw of versions) {
      const parsed = parseForgeMavenVersion(raw)
      if (!parsed) continue
      const exact = `${parsed.mcVersion}-${parsed.forgeVersion}`
      const current = byForgeVersion.get(`${parsed.mcVersion}:${parsed.forgeVersion}`)
      if (!current || raw === exact || (current.mavenDir !== exact && raw.length < current.mavenDir.length)) {
        byForgeVersion.set(`${parsed.mcVersion}:${parsed.forgeVersion}`, { mavenDir: raw, parsed })
      }
    }
    const entries: ForgeBuildEntry[] = []
    for (const { mavenDir, parsed } of byForgeVersion.values()) {
      const fileName = `forge-${mavenDir}-installer.jar`
      const channel =
        promos[`${parsed.mcVersion}-recommended`] === parsed.forgeVersion
          ? 'recommended'
          : promos[`${parsed.mcVersion}-latest`] === parsed.forgeVersion
            ? 'latest'
            : undefined
      entries.push({
        build: parsed.forgeVersion,
        gameVersion: parsed.mcVersion,
        mavenDir,
        fileName,
        url: `${this.mavenBase()}/${this.mavenArtifactPath()}/${mavenDir}/${fileName}`,
        channel
      })
    }
    return entries
  }

  /** 某个 MC 版本下的 forge 构建清单（recommended/latest 排前） */
  private async buildsFor(gameVersion: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ForgeBuildEntry[]> {
    const entries = (await this.forgeBuilds(opts)).filter((e) => e.gameVersion === gameVersion)
    const rank = (e: ForgeBuildEntry): number => (e.channel === 'recommended' ? 0 : e.channel === 'latest' ? 1 : 2)
    entries.sort((a, b) => rank(a) - rank(b) || compareVersions(b.build, a.build))
    return entries
  }

  async listGameVersions(opts: { refresh?: boolean } = {}): Promise<string[]> {
    const versions = await this.fetchMavenVersions(this.mavenArtifactPath(), opts)
    const mcVersions = new Set<string>()
    for (const raw of versions) {
      const parsed = parseForgeMavenVersion(raw)
      if (parsed) mcVersions.add(parsed.mcVersion)
    }
    return sortVersionsDesc([...mcVersions])
  }

  async listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const entries = await this.buildsFor(gameVersion, { refresh: opts.refresh })
    return entries.map((e) => ({
      coreType: 'forge' as const,
      gameVersion,
      build: e.build,
      url: e.url,
      fileName: e.fileName,
      channel: e.channel
    }))
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const wanted = opts.loaderVersion?.trim() || opts.build?.trim()
    const entries = await this.buildsFor(gameVersion, { signal: opts.signal })
    let entry = wanted ? entries.find((e) => e.build === wanted) : entries[0]
    if (!entry && wanted) {
      // maven 列表不可用时的兜底：现代命名规则 `<mc>-<forge>`
      const mavenDir = `${gameVersion}-${wanted}`
      const fileName = `forge-${mavenDir}-installer.jar`
      entry = {
        build: wanted,
        gameVersion,
        mavenDir,
        fileName,
        url: `${this.mavenBase()}/${this.mavenArtifactPath()}/${mavenDir}/${fileName}`
      }
      log.warn(`未在 maven 列表中找到 Forge ${wanted}（MC ${gameVersion}），按现代命名规则推导安装地址`)
    }
    if (!entry) throw new Error(`Forge 没有可用于 MC ${gameVersion} 的构建`)
    return this.installViaInstaller(opts, {
      installerUrl: entry.url,
      installerName: entry.fileName,
      build: entry.build,
      gameVersion,
      installerLabel: `Forge ${entry.build} installer`
    })
  }
}

export class NeoForgeServerCore extends InstallerJarServerCore {
  readonly type = 'neoforge' as const
  readonly name = 'NeoForge'
  readonly note = 'Forge 的社区分支（1.20.1 起接替 Forge，官方 installer + @args.txt 启动），新版本模组服推荐'

  private static readonly MODERN_ARTIFACT = 'net/neoforged/neoforge'
  private static readonly LEGACY_ARTIFACT = 'net/neoforged/forge'

  protected mavenEndpoint(): string {
    return OFFICIAL_ENDPOINTS.neoforgeMaven
  }
  protected displayName(): string {
    return 'NeoForge'
  }

  private async modernBuilds(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<
    { version: string; mcVersion: string | null; url: string; fileName: string }[]
  > {
    const versions = await this.fetchMavenVersions(NeoForgeServerCore.MODERN_ARTIFACT, opts)
    const out: { version: string; mcVersion: string | null; url: string; fileName: string }[] = []
    for (const version of versions) {
      const parsed = parseNeoForgeMavenVersion(version)
      if (!parsed || parsed.legacy) continue
      const fileName = `neoforge-${version}-installer.jar`
      out.push({
        version,
        mcVersion: parsed.mcVersion,
        url: `${this.mavenBase()}/${NeoForgeServerCore.MODERN_ARTIFACT}/${version}/${fileName}`,
        fileName
      })
    }
    return out
  }

  /** 1.20.1 时代的 NeoForge 在 legacy artifact（net/neoforged/forge）下 */
  private async legacyBuilds(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<
    { mavenDir: string; selfVersion: string; url: string; fileName: string }[]
  > {
    const versions = await this.fetchMavenVersions(NeoForgeServerCore.LEGACY_ARTIFACT, opts).catch((err: unknown) => {
      log.debug(`NeoForge legacy maven 列表不可用：${errorMessage(err)}`)
      return [] as string[]
    })
    const out: { mavenDir: string; selfVersion: string; url: string; fileName: string }[] = []
    for (const version of versions) {
      const parsed = parseNeoForgeMavenVersion(version)
      if (!parsed || !parsed.legacy || parsed.mcVersion !== '1.20.1') continue
      const fileName = `forge-${parsed.mavenVersion}-installer.jar`
      out.push({
        mavenDir: parsed.mavenVersion,
        selfVersion: parsed.selfVersion,
        url: `${this.mavenBase()}/${NeoForgeServerCore.LEGACY_ARTIFACT}/${parsed.mavenVersion}/${fileName}`,
        fileName
      })
    }
    return out
  }

  async listGameVersions(opts: { refresh?: boolean } = {}): Promise<string[]> {
    const set = new Set<string>()
    for (const build of await this.modernBuilds(opts)) {
      if (build.mcVersion) set.add(build.mcVersion)
    }
    if ((await this.legacyBuilds(opts)).length > 0) set.add('1.20.1')
    return sortVersionsDesc([...set])
  }

  async listBuilds(opts: { gameVersion: string; refresh?: boolean }): Promise<ServerCoreDownload[]> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const out: ServerCoreDownload[] = []
    for (const build of await this.modernBuilds({ refresh: opts.refresh })) {
      if (build.mcVersion !== gameVersion) continue
      out.push({ coreType: 'neoforge', gameVersion, build: build.version, url: build.url, fileName: build.fileName })
    }
    if (gameVersion === '1.20.1') {
      for (const build of await this.legacyBuilds({ refresh: opts.refresh })) {
        out.push({ coreType: 'neoforge', gameVersion, build: build.mavenDir, url: build.url, fileName: build.fileName })
      }
    }
    out.sort((a, b) => compareVersions(b.build ?? '', a.build ?? ''))
    return out
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const wanted = opts.loaderVersion?.trim() || opts.build?.trim()
    const builds = await this.listBuilds({ gameVersion })
    const entry = (wanted ? builds.find((b) => b.build === wanted) : undefined) ?? (wanted ? undefined : builds[0])
    if (!entry || !entry.build || !entry.url || !entry.fileName) {
      throw new Error(wanted ? `NeoForge ${wanted} 不支持 MC ${gameVersion}` : `NeoForge 没有可用于 MC ${gameVersion} 的构建`)
    }
    return this.installViaInstaller(opts, {
      installerUrl: entry.url,
      installerName: entry.fileName,
      build: entry.build,
      gameVersion,
      installerLabel: `NeoForge ${entry.build} installer`
    })
  }
}

/* ------------------------------------------------------------------ *
 *  Spigot / custom
 * ------------------------------------------------------------------ */

export class SpigotServerCore extends BaseProvider {
  readonly type = 'spigot' as const
  readonly name = 'Spigot'
  readonly requiresJava = false
  readonly note = '官方不提供可直接下载的 jar：必须用 BuildTools 自行编译（需要 JDK 与 Git）；多数场景建议直接用 Paper'

  async listGameVersions(): Promise<string[]> {
    return []
  }

  async listBuilds(): Promise<ServerCoreDownload[]> {
    return []
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    return {
      jarFile: '',
      fileName: '',
      coreType: 'spigot',
      gameVersion,
      warnings: ['Spigot 官方没有提供可直接下载的服务端 jar，本启动器不会伪造下载地址'],
      manualSteps: [
        '下载 BuildTools：https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar',
        `准备 JDK（Spigot 1.17+ 需要 JDK 17/21）与 Git，运行：java -jar BuildTools.jar --rev ${gameVersion}（首次编译需数分钟到数十分钟）`,
        `编译完成后把生成的 spigot-${gameVersion}.jar 复制到本服务端目录，再用「自定义核心」指向它，或重新创建实例并选择自定义核心`,
        '更省事的选择：直接改用 Paper / Purpur（与 Spigot 插件完全兼容，且提供预编译下载）'
      ]
    }
  }
}

export class CustomServerCore extends BaseProvider {
  readonly type = 'custom' as const
  readonly name = '自定义核心'
  readonly requiresJava = false
  readonly note = '使用用户自备的服务端 jar（Paper 构建、代理端、整合包自带核心等），安装时只校验文件存在'

  async listGameVersions(): Promise<string[]> {
    return []
  }

  async listBuilds(): Promise<ServerCoreDownload[]> {
    return []
  }

  /** 优先 server.jar，其次常见命名，最后取任意非 installer 的 jar */
  private async pickExistingJar(dir: string): Promise<string | null> {
    const entries = await readdir(dir).catch(() => [] as string[])
    const jars = entries.filter((name) => /\.jar$/i.test(name) && !/installer/i.test(name))
    if (jars.length === 0) return null
    const priority = (name: string): number => {
      const lower = name.toLowerCase()
      if (lower === 'server.jar') return 0
      if (/^minecraft_server.*\.jar$/.test(lower)) return 1
      if (/^(paper|purpur|spigot|craftbukkit|fabric|quilt)/.test(lower)) return 2
      if (/launch/.test(lower)) return 3
      return 4
    }
    jars.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    return jars[0]
  }

  async install(opts: ServerInstallOptions): Promise<ServerInstallResult> {
    const gameVersion = cleanGameVersion(opts.gameVersion)
    await ensureDir(opts.dir)
    let fileName = opts.fileName?.trim() ?? ''
    if (fileName) {
      if (!(await pathExists(join(opts.dir, fileName)))) {
        throw new Error(`自定义核心：目录中不存在 ${fileName}（${opts.dir}）`)
      }
    } else {
      const found = await this.pickExistingJar(opts.dir)
      if (!found) {
        throw new Error(`自定义核心：未在 ${opts.dir} 找到任何 .jar；请先把服务端 jar 放入目录并传入 fileName`)
      }
      fileName = found
    }
    return { jarFile: fileName, fileName, coreType: 'custom', gameVersion, warnings: [] }
  }
}

/* ------------------------------------------------------------------ *
 *  注册表
 * ------------------------------------------------------------------ */

export interface ServerCoreRegistryOptions {
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  manifest?: VersionManifestService
}

export class ServerCoreRegistry {
  private readonly providers = new Map<ServerCoreType, ServerCoreProvider>()

  constructor(opts: ServerCoreRegistryOptions) {
    const ctx: ServerCoreContext = {
      client: opts.client,
      mirror: opts.mirror,
      downloadManager: opts.downloadManager,
      manifest: opts.manifest
    }
    for (const provider of [
      new VanillaServerCore(ctx),
      new PaperServerCore(ctx),
      new PurpurServerCore(ctx),
      new FabricServerCore(ctx),
      new QuiltServerCore(ctx),
      new ForgeServerCore(ctx),
      new NeoForgeServerCore(ctx),
      new SpigotServerCore(ctx),
      new CustomServerCore(ctx)
    ]) {
      this.providers.set(provider.type, provider)
    }
  }

  get(coreType: ServerCoreType): ServerCoreProvider | null {
    return this.providers.get(coreType) ?? null
  }

  list(): { type: ServerCoreType; name: string; requiresJava: boolean; note: string }[] {
    return [...this.providers.values()].map((p) => ({
      type: p.type,
      name: p.name,
      requiresJava: p.requiresJava,
      note: p.note
    }))
  }

  listGameVersions(coreType: ServerCoreType, opts: { refresh?: boolean } = {}): Promise<string[]> {
    return this.require(coreType).listGameVersions(opts)
  }

  listBuilds(coreType: ServerCoreType, gameVersion: string, opts: { refresh?: boolean } = {}): Promise<ServerCoreDownload[]> {
    return this.require(coreType).listBuilds({ gameVersion, refresh: opts.refresh })
  }

  install(coreType: ServerCoreType, opts: ServerInstallOptions): Promise<ServerInstallResult> {
    return this.require(coreType).install(opts)
  }

  /** 推荐核心：按 MC 版本给默认选择 + 理由（顺序即偏好） */
  recommend(gameVersion: string): { coreType: ServerCoreType; reason: string }[] {
    const mc = cleanGameVersion(gameVersion)
    const out: { coreType: ServerCoreType; reason: string }[] = []
    const add = (coreType: ServerCoreType, reason: string): void => {
      if (!out.some((o) => o.coreType === coreType)) out.push({ coreType, reason })
    }

    const release = /^1\.(\d+)(?:\.(\d+))?/.exec(mc)
    const isSnapshot = /^\d{2}w\d{2}[a-z]?$/i.test(mc)
    const minor = release ? Number.parseInt(release[1], 10) : 0

    if (isSnapshot) {
      add('vanilla', '快照版本只有 Mojang 官方服务端可直接下载，稳定性无法保证')
      add('fabric', 'Fabric 通常第一时间跟进快照（需在实例中自行选择 loader 版本）')
      return out
    }

    if (minor >= 8) {
      add('paper', '插件生态最完整、性能优于原版，插件服首选（支持 1.8.8 ~ 最新版）')
      add('purpur', 'Paper 的下游分支，可调参数更多（TPS 上限、刷怪控制等），插件与 Paper 兼容')
    }
    if (minor >= 14) {
      add('fabric', '轻量模组加载器：服务端模组生态活跃、启动快，适合原版风格的模组服')
    }
    if (minor >= 20) {
      add('neoforge', 'NeoForge 从 1.20.1 起接替 Forge，新版本模组服推荐（1.20.1 为 legacy 安装包）')
      add('forge', '老牌模组加载器：1.20.1 及更早的整合包绝大多数基于 Forge')
    } else {
      add('forge', '老牌模组加载器：1.16.5 及更早的整合包事实标准（Forge 服务端需要 Java 运行 installer）')
    }
    add('vanilla', 'Mojang 官方原版：最稳定、无第三方依赖，适合纯原版联机')
    if (minor >= 8) {
      add('spigot', 'Spigot 需用 BuildTools 自行编译，通常直接用 Paper 替代')
    }
    return out
  }

  private require(coreType: ServerCoreType): ServerCoreProvider {
    const provider = this.get(coreType)
    if (!provider) throw new Error(`未知的服务端核心类型：${coreType}`)
    return provider
  }
}
