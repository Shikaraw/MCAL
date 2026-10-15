/**
 * Fabric 加载器安装。
 *
 * 协议依据（reference/HMCL/.../download/fabric/FabricInstallTask.java 与
 * HMCL DownloadProvider#fetchFabricVersionsAsync，以及 Fabric Meta 官方文档）：
 *
 *  - 版本列表：`GET {fabricMeta}/v2/versions/loader/<gameVersion>`
 *    → `[{ loader: { version, stable }, intermediary: { version, maven }, launcherMeta }]`
 *  - 完整版本 json：`GET {fabricMeta}/v2/versions/loader/<gameVersion>/<loaderVersion>/profile/json`
 *    该 json 是「完整」的启动描述，含 mainClass / libraries / inheritsFrom。
 *    HMCL 选择安装器的做法是：保留 profile 的 mainClass 与 libraries 原样（不手工合并原版 json），
 *    让启动器的版本继承机制去叠加原版；这一点非常关键 —— profile 里 asm / mixin 等库
 *    相对原版有版本提升，且 load 顺序依赖父在前子覆盖。
 *  - 版本 id：`fabric-loader-<loaderVersion>-<gameVersion>`（Fabric 官方 + HMCL 一致）。
 *
 * 反直觉点：
 *  1. profile json 偶尔缺 `inheritsFrom`（或值不对），此时启动器解析继承链会失败，
 *     必须显式补上 gameVersion（HMCL 通过把 patch 应用到原版 manifest 来规避，我们直接写字段）。
 *  2. 不需要下载任何 jar：client jar 由父版本提供，loader 自身以 library 形式在 profile 里。
 *  3. Fabric 只能装在原版之上（HMCL 在 preExecute 里检查 base manifest 的 mainClass 必须是
 *     VANILLA_MAIN，否则抛 FABRIC_NOT_COMPATIBLE_WITH_FORGE）。我们对非原版给出警告而不是硬失败，
 *     因为快照/第三方版本 json 的 mainClass 可能不同。
 */

import { join } from 'node:path'
import type { LoaderInstallRequest, LoaderInstallResult, LoaderVersion, VersionDetail } from '@shared/types'
import { OFFICIAL_ENDPOINTS } from '@core/net/mirror'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import type { VersionRepository } from '@core/mojang/version'
import { DownloadManager } from '@core/net/downloader'
import { libraryDownloadItems, resolveLibraries } from '@core/mojang/library'
import { createRuleContext } from '@core/mojang/rules'
import { cleanGameVersion, compareVersions } from '@core/util/misc'
import { logger } from '@core/util/logger'
import { baseGameVersionOf } from './version-id'
import type { LoaderInstallDeps } from './index'

const log = logger.scoped('loader:fabric')

/** Fabric Meta 的 loader 列表元素 */
export interface FabricLikeLoaderEntry {
  loader?: { version?: string; stable?: boolean; maven?: string }
  intermediary?: { version?: string; maven?: string }
  hashed?: { version?: string; maven?: string }
  launcherMeta?: unknown
}

export interface FabricLikeLoaderOptions {
  client: HttpClient
  mirror: MirrorResolver
  repository: VersionRepository
}

export interface FabricLikeMetaOptions {
  /**
   * meta 根地址常量，供 MirrorResolver 识别并替换为镜像地址。
   * Fabric 用 OFFICIAL_ENDPOINTS.fabricMeta，Quilt 必须用 OFFICIAL_ENDPOINTS.quiltMeta ——
   * MirrorResolver#resolve(scope='fabric') 是按 url 前缀分别映射 fabricMeta/quiltMeta 的，
   * 传错会请求到 meta.fabricmc.net 的 Quilt 路径（404）。
   */
  metaEndpoint: string
  /** loader 列表地址前缀，例如 {fabricMeta}/v2/versions/loader 或 {quiltMeta}/v3/versions/loader */
  listPath: (gameVersion: string) => string
  /** profile json 地址 */
  profilePath: (gameVersion: string, loaderVersion: string) => string
  /** 版本 id 前缀，例如 fabric-loader- / quilt-loader- */
  idPrefix: string
  /** 缓存 key 前缀（区分 fabric/quilt） */
  cacheNamespace: string
  /** 日志展示名 */
  displayName: string
}

/**
 * Fabric 与 Quilt 的 meta 协议几乎一致（Quilt v3 的 loader 列表多一个 hashed 字段，
 * profile json 结构相同），这里抽出共同实现，子类只提供 URL 与命名规则。
 */
export class FabricLikeLoader {
  protected readonly client: HttpClient
  protected readonly mirror: MirrorResolver
  protected readonly repository: VersionRepository
  private readonly meta: FabricLikeMetaOptions
  private readonly cache = new Map<string, { at: number; versions: LoaderVersion[] }>()
  private static readonly CACHE_TTL_MS = 5 * 60_000

  constructor(opts: FabricLikeLoaderOptions, meta: FabricLikeMetaOptions) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.repository = opts.repository
    this.meta = meta
  }

  /** meta 根地址（已按镜像解析），例如 https://bmclapi2.bangbang93.com/fabric-meta */
  protected metaBase(): string {
    return this.mirror.resolve(this.meta.metaEndpoint, 'fabric').replace(/\/+$/, '')
  }

  /** 该加载器是否声明支持此 MC 版本（离线近似：正式版 1.14+ 与全部快照） */
  supports(gameVersion: string): boolean {
    const v = cleanGameVersion(gameVersion)
    if (/^\d{2}w\d{2}[a-z]?$/i.test(v)) return true
    const match = /^1\.(\d+)(?:\.(\d+))?/.exec(v)
    if (!match) return false
    const minor = Number.parseInt(match[1], 10)
    // Fabric Loader 从 1.14 起正式支持；1.13.2 及更早的 loader 已不可用
    return minor >= 14
  }

  versionIdFor(loaderVersion: string, gameVersion: string): string {
    return `${this.meta.idPrefix}${loaderVersion}-${gameVersion}`
  }

  /** GET {fabricMeta}/v2/versions/loader/<gameVersion> */
  async listVersions(gameVersion: string, opts: { refresh?: boolean } = {}): Promise<LoaderVersion[]> {
    const key = `${this.meta.cacheNamespace}:${gameVersion}`
    const cached = this.cache.get(key)
    if (!opts.refresh && cached && Date.now() - cached.at < FabricLikeLoader.CACHE_TTL_MS) return cached.versions

    const url = `${this.metaBase()}${this.meta.listPath(gameVersion)}`
    log.debug(`获取 ${this.meta.displayName} 版本列表：${url}`)
    const raw = await this.client.getJson<FabricLikeLoaderEntry[]>(url, opts.refresh ? { retries: 1 } : {})
    if (!Array.isArray(raw)) throw new Error(`${this.meta.displayName} 版本列表格式异常（${url}）`)

    const versions: LoaderVersion[] = []
    for (const entry of raw) {
      const loaderVersion = entry?.loader?.version
      if (typeof loaderVersion !== 'string' || loaderVersion.length === 0) continue
      versions.push({
        loaderType: this.meta.cacheNamespace === 'quilt' ? 'quilt' : 'fabric',
        version: loaderVersion,
        gameVersion,
        stable: entry.loader?.stable !== false,
        label: entry.loader?.stable === false ? 'unstable' : undefined
      })
    }
    versions.sort((a, b) => compareVersions(b.version, a.version))
    this.cache.set(key, { at: Date.now(), versions })
    return versions
  }

  /**
   * GET {fabricMeta}/v2/versions/loader/<gameVersion>/<loaderVersion>/profile/json
   * 返回完整版本 json（含 inheritsFrom），写入计算机会原样保留以避免破坏继承语义。
   */
  async fetchProfile(gameVersion: string, loaderVersion: string): Promise<VersionDetail> {
    const url = `${this.metaBase()}${this.meta.profilePath(gameVersion, loaderVersion)}`
    log.debug(`获取 ${this.meta.displayName} profile：${url}`)
    const detail = await this.client.getJson<VersionDetail>(url)
    if (!detail || typeof detail !== 'object' || typeof detail.id !== 'string') {
      throw new Error(`${this.meta.displayName} profile json 格式异常（${url}）：缺少 id 字段`)
    }
    if (!Array.isArray(detail.libraries)) {
      throw new Error(`${this.meta.displayName} profile json 缺少 libraries（${url}）`)
    }
    return detail
  }

  async install(req: LoaderInstallRequest, deps: LoaderInstallDeps): Promise<LoaderInstallResult> {
    const gameVersion = baseGameVersionOf(req.versionId)
    const loaderVersion = req.loaderVersion?.trim()
    if (!loaderVersion) throw new Error(`安装 ${this.meta.displayName} 需要 loaderVersion`)

    const warnings: string[] = []
    if (!this.supports(gameVersion)) {
      warnings.push(`${this.meta.displayName} 官方不支持 MC ${gameVersion}（仅 1.14+ 与快照），安装仍会尝试`)
    }

    // 原版版本 json 必须存在：否则 inheritsFrom 链断裂，启动时缺原版库与参数
    const jsonPath = this.repository.versionJsonPath(deps.gameDir, gameVersion)
    const vanilla = await this.repository.readVersionJson(deps.gameDir, gameVersion)
    if (!vanilla) {
      throw new Error(`安装 ${this.meta.displayName} 前需要先安装原版 ${gameVersion}：缺少 ${jsonPath}`)
    }
    if (vanilla.mainClass && vanilla.mainClass !== 'net.minecraft.client.main.Main') {
      warnings.push(
        `基础版本 ${gameVersion} 的 mainClass 为 ${vanilla.mainClass}（不是原版），` +
          `${this.meta.displayName} 应安装在原版之上，启动可能失败`
      )
    }

    deps.onProgress?.({ phase: 'meta', message: `获取 ${this.meta.displayName} ${loaderVersion} 的 profile`, ratio: 0.1 })
    const profile = await this.fetchProfile(gameVersion, loaderVersion)

    const versionId = this.versionIdFor(loaderVersion, gameVersion)
    const detail: VersionDetail = {
      ...profile,
      // 强制 id 与目录名一致；meta 返回的 id 与官方命名一致时这一步是 no-op
      id: versionId,
      // inheritsFrom 必须等于 gameVersion（部分 profile 缺失，缺失会导致启动时缺原版库/参数）
      inheritsFrom: gameVersion,
      type: profile.type ?? 'release',
      mcalMeta: {
        loaderType: this.meta.cacheNamespace === 'quilt' ? 'quilt' : 'fabric',
        loaderVersion,
        installedAt: new Date().toISOString(),
        source: this.meta.idPrefix.endsWith('quilt-loader-') ? 'quilt-meta' : 'fabric-meta',
        notes: profile.id !== versionId ? `profile 原始 id=${profile.id}` : undefined
      }
    }
    if (profile.inheritsFrom !== gameVersion) {
      warnings.push(`profile json 的 inheritsFrom=${profile.inheritsFrom ?? '(缺失)'}，已修正为 ${gameVersion}`)
    }

    deps.onProgress?.({ phase: 'write', message: `写入版本 ${versionId}`, ratio: 0.8 })
    const written = await this.repository.writeVersionJson(deps.gameDir, detail)

    /*
     * 下载 profile 自带的库（loader / mixin / asm / intermediary 等）。
     * 这些库相对原版有版本提升（例如 asm、mixin），必须真正落盘才能在继承覆盖后生效；
     * 父版本的库由原版安装负责，这里只装 profile 列表里的。
     * 单个库失败不中断安装（continueOnError），但会在 warnings 里给出明确提示。
     */
    const libraries = detail.libraries ?? []
    const resolved = resolveLibraries(libraries, {
      librariesDir: join(deps.gameDir, 'libraries'),
      rules: createRuleContext(),
      mirror: deps.mirror
    })
    const items = libraryDownloadItems(resolved)
    if (items.length > 0) {
      deps.onProgress?.({ phase: 'libraries', message: `下载 ${this.meta.displayName} 的 ${items.length} 个库`, ratio: 0.5 })
      const libResult = await deps.downloadManager.fetchFiles(
        `loader-${this.meta.cacheNamespace}-libs-${versionId}`,
        `${this.meta.displayName} 库`,
        items,
        {
          signal: deps.signal,
          continueOnError: true,
          onProgress: (p) =>
            deps.onProgress?.({
              phase: 'libraries',
              message: DownloadManager.describeProgress(p),
              ratio: 0.6,
              download: p
            })
        }
      )
      if (libResult.failures.length > 0) {
        warnings.push(
          `有 ${libResult.failures.length} 个 ${this.meta.displayName} 库未能下载（启动前请重试安装）：` +
            libResult.failures
              .slice(0, 3)
              .map((f) => `${f.url.split('/').slice(-1)[0] || f.key}（${f.error.slice(0, 80)}）`)
              .join('；')
        )
      }
    }

    if (req.createInstance) {
      log.info(`版本 ${versionId} 已就绪，供上层创建实例（instanceName=${req.instanceName ?? '-'}）`)
    }
    deps.onProgress?.({ phase: 'done', message: `${this.meta.displayName} ${loaderVersion} 安装完成`, ratio: 1 })

    return {
      versionId,
      loaderType: this.meta.cacheNamespace === 'quilt' ? 'quilt' : 'fabric',
      loaderVersion,
      files: [written],
      warnings
    }
  }
}

export class FabricLoader extends FabricLikeLoader {
  constructor(opts: FabricLikeLoaderOptions) {
    super(opts, {
      metaEndpoint: OFFICIAL_ENDPOINTS.fabricMeta,
      listPath: (gameVersion) => `/v2/versions/loader/${encodeURIComponent(gameVersion)}`,
      profilePath: (gameVersion, loaderVersion) =>
        `/v2/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
      idPrefix: 'fabric-loader-',
      cacheNamespace: 'fabric',
      displayName: 'Fabric'
    })
  }
}
