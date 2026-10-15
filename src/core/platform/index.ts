/**
 * 平台服务：把「搜索 / 详情 / 版本列表 / 安装」统一成平台无关的入口。
 *
 * 当前只落地 Modrinth。CurseForge 需要 API Key（官方禁止无 Key 的第三方下载入口），
 * 因此凡是 platform='curseforge' 的调用都会抛出可读错误，而不是静默失败。
 */

import { basename, dirname, isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import type {
  DownloadItem,
  DownloadProgress,
  LoaderType,
  Platform,
  ProjectDetail,
  ProjectSearchResult,
  ProjectType,
  ProjectVersion
} from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import type { DownloadManager } from '@core/net/downloader'
import { sha1OfFile } from '@core/util/misc'
import { logger } from '@core/util/logger'
import { ModrinthClient, pickBestVersion } from './modrinth'

const log = logger.scoped('platform')

export interface PlatformInstallRequest {
  platform: Platform
  projectId: string
  versionId?: string
  gameDir: string
  kind: ProjectType
  gameVersion?: string
  loader?: LoaderType
  withDependencies?: boolean
  targetSubdir?: string
  signal?: AbortSignal
  onProgress?: (p: DownloadProgress) => void
}

export interface PlatformInstallResult {
  files: string[]
  installed: { projectId: string; versionId: string; fileName: string; dir: string }[]
  skipped: string[]
  warnings: string[]
}

/** ProjectType → 实例内默认子目录 */
export const DEFAULT_TARGET_SUBDIRS: Record<ProjectType, string> = {
  mod: 'mods',
  modpack: 'modpacks',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks',
  plugin: 'plugins',
  world: 'saves'
}

export const CURSEFORGE_API_KEY_MESSAGE =
  'CurseForge 需要 API Key：请在「设置 → 网络 / 平台」中填写 CurseForge API Key 后重试。' +
  'CurseForge 官方禁止无 Key 的第三方访问，未配置时无法搜索或安装。'

/** 平台可用性断言：CurseForge 在有 Key 的实现接入前一律给出可读错误。 */
export function assertPlatformSupported(platform: Platform): void {
  if (platform === 'curseforge') throw new Error(CURSEFORGE_API_KEY_MESSAGE)
}

export class PlatformService {
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly downloadManager: DownloadManager
  readonly modrinth: ModrinthClient

  constructor(opts: {
    client: HttpClient
    mirror: MirrorResolver
    downloadManager: DownloadManager
    modrinth: ModrinthClient
  }) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.downloadManager = opts.downloadManager
    this.modrinth = opts.modrinth
  }

  /** 搜索（默认 Modrinth） */
  async search(opts: Parameters<ModrinthClient['search']>[0] & { platform?: Platform }): Promise<ProjectSearchResult[]> {
    const platform = opts.platform ?? 'modrinth'
    assertPlatformSupported(platform)
    const { hits } = await this.modrinth.search(opts)
    return hits
  }

  async detail(opts: { platform: Platform; projectId: string }): Promise<ProjectDetail | null> {
    assertPlatformSupported(opts.platform)
    return this.modrinth.getProject(opts.projectId)
  }

  async versions(opts: {
    platform: Platform
    projectId: string
    gameVersion?: string
    loader?: LoaderType
    limit?: number
  }): Promise<ProjectVersion[]> {
    assertPlatformSupported(opts.platform)
    return this.modrinth.listVersions({
      projectId: opts.projectId,
      gameVersion: opts.gameVersion,
      loader: opts.loader,
      limit: opts.limit ?? 50
    })
  }

  /**
   * 安装项目：解析版本（未指定时按 gameVersion/loader 选最优）、可选解析依赖、
   * 下载到正确目录，并跳过「已存在且大小/哈希一致」的文件。
   */
  async install(req: PlatformInstallRequest): Promise<PlatformInstallResult> {
    assertPlatformSupported(req.platform)
    const files: string[] = []
    const installed: PlatformInstallResult['installed'] = []
    const skipped: string[] = []
    const warnings: string[] = []
    const loader = this.loaderFilter(req.kind, req.loader)

    // 1) 选版本
    let version: ProjectVersion | null = null
    if (req.versionId) {
      version = await this.modrinth.getVersion(req.versionId)
      if (!version) throw new Error(`Modrinth 上找不到指定版本：${req.versionId}`)
    } else {
      const list = await this.modrinth.listVersions({
        projectId: req.projectId,
        gameVersion: req.gameVersion,
        loader,
        limit: 50
      })
      version = pickBestVersion(list, { gameVersion: req.gameVersion, loader })
      if (!version && loader) {
        // 加载器过滤过严（部分项目不打 loader 标记）→ 放宽重试一次
        const relaxed = await this.modrinth.listVersions({ projectId: req.projectId, gameVersion: req.gameVersion, limit: 50 })
        version = pickBestVersion(relaxed, { gameVersion: req.gameVersion })
      }
      if (!version) {
        const filters = [req.gameVersion, req.loader].filter(Boolean).join(' / ')
        throw new Error(`项目 ${req.projectId} 没有${filters ? `匹配 ${filters} 的` : ''}可用版本`)
      }
    }

    // 2) 依赖（整合包与 mod 支持一起安装；其他类型没有依赖语义）
    const versions: ProjectVersion[] = [version]
    if (req.withDependencies && (req.kind === 'mod' || req.kind === 'modpack')) {
      const dependencies = await this.modrinth.resolveDependencies(version, {
        gameVersion: req.gameVersion,
        loader,
        includeOptional: false,
        maxDepth: 2
      })
      for (const dep of dependencies) {
        versions.push(dep.version)
        warnings.push(`附带依赖：${dep.version.name || dep.version.versionNumber || dep.version.versionId}（${dep.reason}）`)
      }
    }

    // 去重：同一项目只装一个版本（先到先得，主版本优先）
    const unique: ProjectVersion[] = []
    const seenProjects = new Set<string>()
    for (const item of versions) {
      const key = item.projectId || item.versionId
      if (seenProjects.has(key)) continue
      seenProjects.add(key)
      unique.push(item)
    }

    // 3) 目标目录与下载项
    const targetDir = this.resolveTargetDir(req.gameDir, req.kind, req.targetSubdir)
    const items = this.modrinth.buildDownloadItems(unique, targetDir)
    if (items.length === 0) throw new Error('该版本没有可下载的文件（可能只提供外部链接）')
    if (req.kind === 'modpack') {
      warnings.push('整合包文件已下载到 modpacks/，请使用整合包导入流程完成实例创建（会自动展开 manifest/overrides）')
    }
    if (req.kind === 'world') {
      warnings.push('存档文件已下载到 saves/：若下载的是 zip，需要先解压成 saves/<世界名>/ 才能被游戏识别')
    }

    // 4) 已存在且大小/哈希一致 → 跳过
    const pending: DownloadItem[] = []
    for (const item of items) {
      if (await this.isSameFile(item)) {
        skipped.push(item.dest)
        log.debug(`跳过已存在的相同文件：${item.dest}`)
        continue
      }
      pending.push(item)
    }

    // 5) 下载
    if (pending.length > 0) {
      const taskId = `platform:${req.platform}:${req.projectId}:${version.versionId}`
      const result = await this.downloadManager.runTask(taskId, {
        label: `安装 ${version.name || version.versionNumber || req.projectId}`,
        items: pending,
        signal: req.signal,
        onProgress: req.onProgress,
        continueOnError: false
      })
      const failedKeys = new Set(result.failures.map((f) => f.key))
      for (const item of pending) {
        if (failedKeys.has(item.key)) {
          warnings.push(`下载失败：${item.url}（${item.dest}）`)
          continue
        }
        files.push(item.dest)
      }
    }

    // 6) 汇总 installed 清单
    for (const item of unique) {
      const download = items.find((i) => i.key.startsWith(`modrinth:${item.versionId}:`))
      if (!download) continue
      if (files.includes(download.dest) || skipped.includes(download.dest)) {
        installed.push({
          projectId: item.projectId,
          versionId: item.versionId,
          fileName: basename(download.dest),
          dir: dirname(download.dest)
        })
      }
    }

    if (files.length === 0 && skipped.length === 0) {
      throw new Error(`安装失败：${req.projectId} 没有任何文件写入（${warnings.join('；') || '未知原因'}）`)
    }
    return { files, installed, skipped, warnings }
  }

  /**
   * 目标子目录规则：
   * mod→mods（服务端实例同样可用）、shader→shaderpacks、resourcepack→resourcepacks、
   * datapack→datapacks、plugin→plugins、world→saves、modpack→modpacks（仅放下载产物，
   * 真正安装由整合包流程展开）。
   */
  resolveTargetDir(gameDir: string, kind: ProjectType, explicit?: string): string {
    if (explicit) return isAbsolute(explicit) ? explicit : join(gameDir, explicit)
    return join(gameDir, DEFAULT_TARGET_SUBDIRS[kind] ?? 'mods')
  }

  /**
   * 只有 mod / modpack / plugin 需要按加载器过滤；
   * 资源包/光影/数据包/世界没有加载器概念（Iris 光影的 loaders 字段是 iris/optifine，
   * 用 fabric 过滤会得到 0 结果），因此这些类型一律不加加载器过滤。
   */
  private loaderFilter(kind: ProjectType, loader?: LoaderType): LoaderType | undefined {
    if (!loader) return undefined
    return kind === 'mod' || kind === 'modpack' || kind === 'plugin' ? loader : undefined
  }

  /** 目标文件已存在且大小/哈希与平台记录一致 */
  private async isSameFile(item: DownloadItem): Promise<boolean> {
    try {
      const info = await stat(item.dest)
      if (!info.isFile()) return false
      if (item.size !== undefined && item.size > 0 && info.size !== item.size) return false
      if (item.sha1) return (await sha1OfFile(item.dest)) === item.sha1.toLowerCase()
      return item.size !== undefined && item.size > 0
    } catch {
      return false
    }
  }
}
