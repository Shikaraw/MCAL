/**
 * Mojang 版本清单服务。
 *
 * 职责：版本清单（version_manifest_v2.json）的本地缓存 + 联网刷新、
 * 单版本详情 json 的镜像加速获取（多地址回退）、版本列表查询。
 * 缓存策略：默认 6 小时有效；forceRefresh / refresh 时强制联网；
 * 网络失败但有旧缓存时降级使用旧缓存并在日志中告警，避免启动器完全不可用。
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReleaseChannel, VersionDetail, VersionManifest, VersionSummary } from '@shared/types'
import type { HttpClient } from '@core/net/http'
import { OFFICIAL_ENDPOINTS, type MirrorResolver } from '@core/net/mirror'
import { readJsonSafe, writeJson } from '@core/util/fsx'
import { logger } from '@core/util/logger'

/** 版本清单缓存有效期：6 小时 */
export const MANIFEST_CACHE_TTL_MS = 6 * 60 * 60 * 1000

const log = logger.scoped('mojang:manifest')

function isVersionManifest(value: unknown): value is VersionManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<VersionManifest>
  return Array.isArray(manifest.versions) && !!manifest.latest && typeof manifest.latest.release === 'string'
}

function isVersionDetail(value: unknown): value is VersionDetail {
  if (!value || typeof value !== 'object') return false
  const detail = value as Partial<VersionDetail>
  return typeof detail.id === 'string' && detail.id.length > 0
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class VersionManifestService {
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly cacheDir: string
  private memoryCache: { manifest: VersionManifest; at: number } | null = null
  private inflight: Promise<VersionManifest> | null = null

  constructor(opts: { client: HttpClient; mirror: MirrorResolver; cacheDir: string }) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.cacheDir = opts.cacheDir
  }

  /** 本地缓存文件路径（v2 清单带 sha1 与 complianceLevel） */
  get cachePath(): string {
    return join(this.cacheDir, 'version_manifest_v2.json')
  }

  /**
   * 读取版本清单：优先内存 / 本地缓存（默认 6 小时内有效），
   * forceRefresh 或缓存过期时联网；联网失败时若存在旧缓存则降级返回。
   */
  async getManifest(opts: { forceRefresh?: boolean } = {}): Promise<VersionManifest> {
    if (!opts.forceRefresh) {
      const cached = await this.readCache(true)
      if (cached) return cached
    }
    // 并发调用只发一次网络请求
    if (!this.inflight) {
      this.inflight = this.fetchAndCache().finally(() => {
        this.inflight = null
      })
    }
    try {
      return await this.inflight
    } catch (err) {
      const stale = await this.readCache(false)
      if (stale) {
        log.warn(`版本清单联网失败（${errorMessage(err)}），使用过期缓存继续`)
        return stale
      }
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  /** 在清单中查找单个版本；缓存里没有时强制刷新一次（可能是刚发布的新快照） */
  async getSummary(versionId: string, opts: { forceRefresh?: boolean } = {}): Promise<VersionSummary | null> {
    let manifest = await this.getManifest({ forceRefresh: opts.forceRefresh })
    let hit = manifest.versions.find((v) => v.id === versionId)
    if (!hit && !opts.forceRefresh) {
      try {
        manifest = await this.getManifest({ forceRefresh: true })
        hit = manifest.versions.find((v) => v.id === versionId)
      } catch (err) {
        log.warn(`刷新版本清单失败（${errorMessage(err)}），按未找到处理：${versionId}`)
        return null
      }
    }
    return hit ?? null
  }

  /**
   * 获取单个版本详情 json。
   * bmclapi 模式下优先 /version/<id>/json（比通用镜像映射更可靠），
   * 其余情况用清单里的 url 经镜像解析；所有地址都失败时抛出聚合错误（含全部 URL）。
   */
  async fetchVersionDetail(versionId: string): Promise<VersionDetail> {
    let summary: VersionSummary | null = null
    try {
      summary = await this.getSummary(versionId)
    } catch (err) {
      log.warn(`读取版本清单失败，将仅尝试镜像地址：${errorMessage(err)}`)
    }

    const candidates: string[] = []
    const bmclapi = this.mirror.get('mojang') === 'bmclapi'
    if (bmclapi) candidates.push(this.mirror.bmclapiVersionJson(versionId))
    if (summary?.url) {
      const resolved = this.mirror.resolve(summary.url, 'mojang')
      candidates.push(resolved)
      if (resolved !== summary.url) candidates.push(summary.url)
    }
    if (!bmclapi) candidates.push(this.mirror.bmclapiVersionJson(versionId))
    const urls = [...new Set(candidates)]

    const errors: string[] = []
    for (const url of urls) {
      try {
        const data = await this.client.getJson<unknown>(url, { retries: 1 })
        if (!isVersionDetail(data)) {
          errors.push(`${url}：响应不是合法的版本 json`)
          continue
        }
        return data
      } catch (err) {
        errors.push(`${url}：${errorMessage(err)}`)
      }
    }

    throw new Error(
      `无法获取版本 ${versionId} 的详情 json，已尝试以下地址：\n${errors.map((e) => `- ${e}`).join('\n')}`
    )
  }

  /** 拉取全部版本（含版本 json 的 url，客户端下载地址在其中）——用于「下载游戏」页 */
  async listGameVersions(opts: { refresh?: boolean; type?: ReleaseChannel | 'all' } = {}): Promise<VersionSummary[]> {
    const manifest = await this.getManifest({ forceRefresh: opts.refresh })
    const type = opts.type ?? 'all'
    if (type === 'all') return [...manifest.versions]
    return manifest.versions.filter((v) => v.type === type)
  }

  /** 兼容旧调用点：委托给模块级函数 isVersionSupportedByLoader */
  static isSupportedByLoader(versionId: string): boolean {
    return isVersionSupportedByLoader(versionId)
  }

  private async readCache(requireFresh: boolean): Promise<VersionManifest | null> {
    if (this.memoryCache) {
      if (!requireFresh || Date.now() - this.memoryCache.at < MANIFEST_CACHE_TTL_MS) return this.memoryCache.manifest
    }
    const manifest = await readJsonSafe<VersionManifest | null>(this.cachePath, null)
    if (!isVersionManifest(manifest)) return null
    if (requireFresh) {
      const info = await stat(this.cachePath).catch(() => null)
      if (!info || Date.now() - info.mtimeMs > MANIFEST_CACHE_TTL_MS) return null
    }
    this.memoryCache = { manifest, at: Date.now() }
    return manifest
  }

  private async fetchAndCache(): Promise<VersionManifest> {
    const urls = [
      ...new Set([
        this.mirror.resolve(OFFICIAL_ENDPOINTS.versionManifest, 'mojang'),
        OFFICIAL_ENDPOINTS.versionManifest,
        OFFICIAL_ENDPOINTS.versionManifestV1
      ])
    ]
    const errors: string[] = []
    for (const url of urls) {
      try {
        const data = await this.client.getJson<unknown>(url, { retries: 1 })
        if (!isVersionManifest(data)) {
          errors.push(`${url}：响应不是合法的版本清单`)
          continue
        }
        this.memoryCache = { manifest: data, at: Date.now() }
        await writeJson(this.cachePath, data).catch((err) => log.warn(`写入版本清单缓存失败：${errorMessage(err)}`))
        log.info(`版本清单已更新：${data.versions.length} 个版本（来源 ${url}）`)
        return data
      } catch (err) {
        errors.push(`${url}：${errorMessage(err)}`)
      }
    }
    throw new Error(`获取 Minecraft 版本清单失败，已尝试以下地址：\n${errors.map((e) => `- ${e}`).join('\n')}`)
  }
}

/**
 * 判断某版本 id 能否作为加载器（Forge / Fabric / NeoForge…）的安装目标。
 *
 * 只做「格式层面」的判断：正式版 1.x / 1.x.y。
 * 快照（24w14a）、pre/rc、远古版本（a1.2.6 / b1.7.3 / rd-…）没有稳定的加载器支持，直接排除；
 * 具体版本区间（例如 Fabric 支持的最低版本、Forge 是否发布过该版本）由各加载器模块二次校验。
 */
export function isVersionSupportedByLoader(versionId: string): boolean {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(versionId.trim())
  if (!match) return false
  // 1.1 起才有可加载器目标的意义
  return Number.parseInt(match[1], 10) >= 1
}
