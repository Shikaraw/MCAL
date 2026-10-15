/**
 * 资源（assets）服务：资源索引 + 资源对象下载 + 旧版虚拟资源展开。
 *
 * 资源对象按内容哈希寻址（objects/<hash前2位>/<hash>），因此天然去重、可跳过。
 * 1.20 约有 3000+ 个对象，性能关键点：
 *  - 先批量 stat 判断「已存在且大小匹配」，只把缺失项交给下载器；
 *  - 下载必须走 DownloadManager 的并发队列，不能在业务层循环 await。
 *
 * 旧版本（1.6 及以下）的索引带 virtual / map_to_resources 标记：
 * 游戏只认「真实文件路径」而不是哈希目录，因此需要把 objects 复制/硬链接到
 * assets/virtual/legacy（pre-1.6 索引的特殊约定）以及游戏目录下的 resources/。
 */

import { copyFile, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AssetIndex, DownloadItem, DownloadProgress } from '@shared/types'
import type { DownloadManager, DownloadTaskResult } from '@core/net/downloader'
import type { HttpClient } from '@core/net/http'
import { OFFICIAL_ENDPOINTS, fallbackMirrors, type MirrorResolver } from '@core/net/mirror'
import { ensureDir, pathExists, readJsonSafe, stat } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { mapConcurrent } from '@core/util/misc'
import type { ResolvedVersion } from './version'

const log = logger.scoped('mojang:assets')

/** pre-1.6 的索引 id 是 "pre-1.6"，但虚拟资源目录按官方启动器约定叫 legacy */
const LEGACY_INDEX_ID = 'pre-1.6'
const LEGACY_VIRTUAL_DIR = 'legacy'

/**
 * 1.6.4 及更早的版本 json 只有 `assets: "pre-1.6"`，没有 assetIndex.url，
 * 官方仓库里对应的索引文件是固定的 legacy 索引（与 PCL2 内置的兜底地址一致）。
 * 缺了它，老版本在官方源下会完全无法安装资源。
 */
const LEGACY_ASSET_INDEX_FALLBACK = {
  sha1: 'c0fd82e8ce9fbc93119e40d96d5a4e62cfa3f729',
  size: 134284,
  url: 'https://launchermeta.mojang.com/mc-staging/assets/legacy/c0fd82e8ce9fbc93119e40d96d5a4e62cfa3f729/legacy.json'
}

export interface EnsureAssetIndexResult {
  indexId: string
  indexPath: string
  index: AssetIndex
  /** 本地与网络都拿不到索引文件（例如版本 json 缺少 assetIndex）时为 true */
  indexFileMissing: boolean
}

export interface ResolvedAssetObject {
  /** 绝对路径：objects/<hash前2位>/<hash> */
  path: string
  hash: string
  size: number
  url: string
  fallbackUrls: string[]
}

export class AssetService {
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly downloadManager: DownloadManager

  constructor(opts: { client: HttpClient; mirror: MirrorResolver; downloadManager: DownloadManager }) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.downloadManager = opts.downloadManager
  }

  /**
   * 确保资源索引 json 存在（assets/indexes/<id>.json），返回索引内容。
   * 索引 id 优先取 assetIndex.id，其次 version.assets（1.7~1.10 的字段），
   * 最后兜底为 versionId（极老 json 两者都缺的情况）。
   * gameDir 参数保留：map_to_resources 的资源最终要落到 <gameDir>/resources。
   */
  async ensureAssetIndex(
    assetsDir: string,
    gameDir: string,
    version: ResolvedVersion,
    opts: { taskId?: string; signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}
  ): Promise<EnsureAssetIndexResult> {
    const detail = version.detail
    const indexId = detail.assetIndex?.id ?? detail.assets ?? version.id
    const indexPath = join(assetsDir, 'indexes', `${indexId}.json`)

    const local = await this.readIndex(indexPath)
    if (local) return { indexId, indexPath, index: local, indexFileMissing: false }

    const candidates: { url: string; sha1?: string; size?: number }[] = []
    const bmclapi = this.mirror.get('mojang') === 'bmclapi'
    if (bmclapi) {
      // bmclapi 的 /version/<id>/assetIndex 直接按游戏版本取索引，比通用映射可靠
      candidates.push({ url: this.mirror.bmclapiAssetIndex(version.id) })
    }
    const ref = detail.assetIndex
    if (ref?.url) {
      const resolved = this.mirror.resolve(ref.url, 'mojang')
      candidates.push({ url: resolved, sha1: ref.sha1, size: ref.size })
      if (resolved !== ref.url) candidates.push({ url: ref.url, sha1: ref.sha1, size: ref.size })
    }
    if (indexId === LEGACY_INDEX_ID || indexId === LEGACY_VIRTUAL_DIR) {
      // 1.6.4 及以前：json 里没有 assetIndex，只有 assets 字段；用固定的 legacy 索引兜底
      candidates.push({
        url: this.mirror.resolve(LEGACY_ASSET_INDEX_FALLBACK.url, 'mojang'),
        sha1: LEGACY_ASSET_INDEX_FALLBACK.sha1,
        size: LEGACY_ASSET_INDEX_FALLBACK.size
      })
    }
    const urls = candidates.filter((c, i, arr) => !!c.url && arr.findIndex((x) => x.url === c.url) === i)

    if (urls.length === 0) {
      // 没有 assetIndex 且无法构造地址：以空索引继续，让调用方决定是否降级
      log.warn(`版本 ${version.id}（gameDir=${gameDir}）没有 assetIndex，将以空资源索引继续`)
      return { indexId, indexPath, index: { objects: {} }, indexFileMissing: true }
    }

    const taskId = opts.taskId ?? 'assets:index'
    const errors: string[] = []
    for (let i = 0; i < urls.length; i++) {
      const candidate = urls[i]
      const item: DownloadItem = {
        key: `asset-index:${indexId}:${i}`,
        url: candidate.url,
        fallbackUrls: urls.length > i + 1 ? urls.slice(i + 1).map((c) => c.url) : undefined,
        dest: indexPath,
        sha1: candidate.sha1,
        size: candidate.size
      }
      const result = await this.downloadManager.runTask(taskId, {
        label: `资源索引 ${indexId}`,
        items: [item],
        signal: opts.signal,
        onProgress: opts.onProgress
      })
      if (!result.ok) {
        errors.push(...result.failures.map((f) => `${f.url}：${f.error}`))
        continue
      }
      const parsed = await this.readIndex(indexPath)
      if (parsed) return { indexId, indexPath, index: parsed, indexFileMissing: false }
      errors.push(`${candidate.url}：下载到的资源索引无法解析`)
    }

    throw new Error(
      `获取资源索引 ${indexId} 失败（版本 ${version.id}），已尝试以下地址：\n${errors.map((e) => `- ${e}`).join('\n')}`
    )
  }

  /** 索引 → 资源对象路径映射（objects/<hash前2位>/<hash>） */
  resolveAssetObjects(assetsDir: string, index: AssetIndex): ResolvedAssetObject[] {
    const out: ResolvedAssetObject[] = []
    for (const obj of Object.values(index.objects ?? {})) {
      if (!obj?.hash) continue
      const prefix = obj.hash.slice(0, 2)
      const official = `${OFFICIAL_ENDPOINTS.resources}/${prefix}/${obj.hash}`
      const url = this.mirror.resolve(official, 'mojang')
      const fallbackUrls = new Set<string>()
      if (url !== official) fallbackUrls.add(official)
      for (const candidate of fallbackMirrors(url)) {
        if (candidate !== url) fallbackUrls.add(candidate)
      }
      out.push({
        path: join(assetsDir, 'objects', prefix, obj.hash),
        hash: obj.hash,
        size: obj.size ?? 0,
        url,
        fallbackUrls: [...fallbackUrls]
      })
    }
    return out
  }

  /** 下载缺失的资源对象（已存在且大小匹配则跳过；先批量 stat 再决定） */
  async installAssets(opts: {
    assetsDir: string
    index: AssetIndex
    signal?: AbortSignal
    onProgress?: (p: DownloadProgress) => void
    taskId?: string
  }): Promise<DownloadTaskResult> {
    const taskId = opts.taskId ?? 'assets'
    const objects = this.resolveAssetObjects(opts.assetsDir, opts.index)

    // 3000+ 文件的场景必须一次性并发 stat，避免逐个 await 串行化
    const checked = await mapConcurrent(
      objects,
      64,
      async (obj) => {
        try {
          const info = await stat(obj.path)
          return info.size === obj.size ? null : obj
        } catch {
          return obj
        }
      },
      opts.signal
    )
    const missing = checked.filter((obj): obj is ResolvedAssetObject => obj !== null)

    if (missing.length === 0) {
      const progress: DownloadProgress = {
        taskId,
        label: '游戏资源',
        completed: 0,
        total: 0,
        bytesDone: 0,
        bytesTotal: 0,
        speed: 0,
        etaSeconds: null,
        failures: [],
        state: 'completed'
      }
      opts.onProgress?.(progress)
      return { ok: true, completed: 0, total: 0, bytes: 0, failures: [], skipped: objects.length }
    }

    const items: DownloadItem[] = missing.map((obj) => ({
      key: obj.hash,
      url: obj.url,
      fallbackUrls: obj.fallbackUrls.length > 0 ? obj.fallbackUrls : undefined,
      dest: obj.path,
      sha1: obj.hash,
      size: obj.size
    }))

    log.debug(`资源对象：${objects.length} 个，缺失 ${items.length} 个，已存在 ${objects.length - items.length} 个`)
    return this.downloadManager.runTask(taskId, {
      label: '游戏资源',
      items,
      signal: opts.signal,
      onProgress: opts.onProgress
    })
  }

  /**
   * 处理 virtual / map_to_resources 旧资源（1.6 及以下）：
   * 把 objects 复制/硬链接到 assets/virtual/legacy（indexId 为 pre-1.6 时的官方目录名），
   * mapToResources 为 true 时同时展开到 <gameDir>/resources。
   */
  async materializeVirtualAssets(
    assetsDir: string,
    indexId: string,
    index: AssetIndex,
    opts: { mapToResources?: boolean } = {}
  ): Promise<{ virtualDir: string; count: number }> {
    const dirName = indexId === LEGACY_INDEX_ID ? LEGACY_VIRTUAL_DIR : indexId
    const virtualDir = join(assetsDir, 'virtual', dirName)
    const mapToResources = opts.mapToResources ?? index.map_to_resources === true
    const resourcesDir = join(dirname(assetsDir), 'resources')
    const entries = Object.entries(index.objects ?? {})

    let count = 0
    await mapConcurrent(entries, 32, async ([relPath, obj]) => {
      if (!obj?.hash) return
      const source = join(assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash)
      if (!(await pathExists(source))) {
        log.warn(`虚拟资源对象缺失，跳过：${source}`)
        return
      }
      const relative = (obj.path ?? relPath).replace(/\\/g, '/')
      if (relative.includes('..')) return // 防目录穿越
      const targets = [join(virtualDir, relative)]
      if (mapToResources) targets.push(join(resourcesDir, relative))
      for (const target of targets) {
        if (!(await pathExists(target))) {
          await ensureDir(dirname(target))
          await linkOrCopy(source, target)
        }
        count++
      }
    })

    log.info(`虚拟资源已展开：${count} 个文件 → ${virtualDir}${mapToResources ? ` 与 ${resourcesDir}` : ''}`)
    return { virtualDir, count }
  }

  private async readIndex(path: string): Promise<AssetIndex | null> {
    const parsed = await readJsonSafe<AssetIndex | null>(path, null)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.objects !== 'object' || parsed.objects === null) return null
    return parsed
  }
}

/** 优先硬链接（零拷贝），跨盘 / 权限不足时回退复制 */
async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target)
    return
  } catch {
    /* 回退复制 */
  }
  await copyFile(source, target)
}
