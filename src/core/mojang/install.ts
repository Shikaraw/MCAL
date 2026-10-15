/**
 * 原版（vanilla）版本安装引擎。
 *
 * 安装一个版本 = 落地四类文件：
 *  1. 客户端 jar    → versions/<jarVersionId>/<jarVersionId>.jar
 *  2. 依赖库        → libraries/<Maven 路径>（含 native 分类包）
 *  3. 资源索引/对象 → assets/indexes/<id>.json、assets/objects/<h2>/<hash>
 *  4. native 解压   → versions/<versionId>/natives（供 JVM -Djava.library.path 使用）
 *
 * 几个容易做错的地方，实现时都做了显式处理：
 *  - client jar 属于继承链中「实际携带 downloads.client」的那个版本（通常是原版根版本），
 *    所以落地目录用 ResolvedVersion.jarVersionId，而不是想当然用目标版本 id；
 *  - 老版本（<1.7.2）没有 assetIndex，索引 id 在 `assets` 字段里，甚至需要 legacy 索引兜底；
 *  - 1.6 及以前的资源索引带 virtual / map_to_resources 标记，需要把对象展开成真实路径；
 *  - 资源对象动辄 3000+，必须走 DownloadManager 的并发队列并把进度按权重映射到总进度。
 *
 * 进度权重（与规范一致）：client 0.15 / libraries 0.45 / assets 0.9 / natives 0.97 / done 1.0。
 */

import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import type { AssetIndex, DownloadItem, DownloadProgress } from '@shared/types'
import { DownloadManager, type DownloadTaskResult } from '@core/net/downloader'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import { ensureDir, pathExists, readJsonSafe, removePath, fileSize } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { mapConcurrent, sha1OfFile } from '@core/util/misc'
import { createRuleContext } from './rules'
import { libraryDownloadItems, nativeLibraries, resolveLibraries } from './library'
import type { ResolvedVersion, VersionRepository } from './version'
import type { VersionManifestService } from './manifest'
import type { AssetService } from './assets'

const log = logger.scoped('mojang:install')

export interface InstallProgress {
  phase: 'prepare' | 'client' | 'libraries' | 'assets' | 'natives' | 'done'
  message: string
  progress?: DownloadProgress
  /** 0-1 总进度（按阶段权重映射） */
  ratio: number
}

export interface VanillaInstallResult {
  versionId: string
  versionDir: string
  jarPath: string
  jsonPath: string
  librariesDir: string
  assetsDir: string
  assetIndexId: string
  /**
   * 本次安装处理的总字节数（DownloadManager 汇总口径：
   * 实际传输 + 已存在被跳过的文件按期望大小计入）
   */
  totalBytes: number
}

export interface VerifyResult {
  ok: boolean
  missingLibraries: number
  missingAssets: number
  clientJarOk: boolean
  detail: string[]
}

export interface InstallPlan {
  /** 需要下载的库文件数（classpath + native 分类包，去重后） */
  libraries: number
  assetObjects: number
  /** 库 + 资源对象的预估字节数（不含 client jar，client jar 单列） */
  totalBytes: number
  clientJarBytes: number
}

/** 每个阶段占总进度的 [起点, 终点] */
const PHASE_RATIO: Record<InstallProgress['phase'], [number, number]> = {
  prepare: [0, 0.02],
  client: [0.02, 0.15],
  libraries: [0.15, 0.45],
  assets: [0.45, 0.9],
  natives: [0.9, 0.97],
  done: [1, 1]
}

export class VersionInstaller {
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly downloadManager: DownloadManager
  private readonly repository: VersionRepository
  private readonly manifest: VersionManifestService
  private readonly assets: AssetService

  constructor(opts: {
    client: HttpClient
    mirror: MirrorResolver
    downloadManager: DownloadManager
    repository: VersionRepository
    manifest: VersionManifestService
    assets: AssetService
  }) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.downloadManager = opts.downloadManager
    this.repository = opts.repository
    this.manifest = opts.manifest
    this.assets = opts.assets
  }

  /**
   * 安装（或补全）一个版本。可重复执行：已存在且哈希正确的文件会被下载器跳过。
   * 任何阶段出现失败都会聚合错误信息后抛出，不会静默降级。
   */
  async install(opts: {
    gameDir: string
    versionId: string
    signal?: AbortSignal
    onProgress?: (p: InstallProgress) => void
    skipAssets?: boolean
    skipClientJar?: boolean
  }): Promise<VanillaInstallResult> {
    const { gameDir, versionId, signal, onProgress } = opts
    const librariesDir = join(gameDir, 'libraries')
    const assetsDir = join(gameDir, 'assets')
    let totalBytes = 0

    const report = (phase: InstallProgress['phase'], message: string, ratio: number, progress?: DownloadProgress): void => {
      onProgress?.({ phase, message, ratio: Math.max(0, Math.min(1, ratio)), progress })
    }
    const downloadProgressFor =
      (phase: InstallProgress['phase'], label: string) =>
      (p: DownloadProgress): void => {
        const [start, end] = PHASE_RATIO[phase]
        const fraction = p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : p.total > 0 ? p.completed / p.total : 0
        report(phase, `${label}：${DownloadManager.describeProgress(p)}`, start + (end - start) * fraction, p)
      }

    /* ---------------- prepare：解析继承链 ---------------- */
    report('prepare', `解析版本 ${versionId}…`, PHASE_RATIO.prepare[0])
    const resolvedRaw = await this.repository.resolve(gameDir, versionId)
    let resolved: ResolvedVersion = resolvedRaw
    let detail = resolvedRaw.detail

    // 合并后的 downloads 通常已带上父版本的 client 信息；完全没有时沿 inheritsFrom 补全
    // （ensureClientDownload 可能回退到 bmclapi 直链）。这种兜底得到的 jar 属于
    // 「目标版本的直接父版本」——与 ensureClientDownload 内部的 sourceId 规则保持一致。
    const raw = await this.repository.readVersionJson(gameDir, versionId)
    const fallbackJarId = raw?.inheritsFrom ?? versionId
    if (!detail.downloads?.client?.url && raw) {
      const fixed = await this.repository.ensureClientDownload(gameDir, raw)
      detail = { ...detail, downloads: { ...(detail.downloads ?? {}), ...(fixed.downloads ?? {}) } }
      resolved = { ...resolved, detail }
    }
    const clientDownload = detail.downloads?.client
    let jarVersionId = resolved.jarVersionId
    let hasOwnJar = resolved.hasOwnJar
    if (!resolvedRaw.detail.downloads?.client?.url && clientDownload?.url) {
      // 继承链上任何节点都没有 downloads.client：兜底 jar 一定来自 fallbackJarId
      jarVersionId = fallbackJarId
      hasOwnJar = fallbackJarId === versionId
    }
    report('prepare', `版本 ${versionId} 继承链：${resolved.chain.join(' → ')}`, PHASE_RATIO.prepare[1])

    /* ---------------- client：客户端 jar ---------------- */
    const jarDir = this.repository.versionDir(gameDir, jarVersionId)
    const jarPath = join(jarDir, `${jarVersionId}.jar`)
    const clientUrl = clientDownload?.url
    if (opts.skipClientJar) {
      report('client', `已跳过客户端 jar 下载（${jarPath}）`, PHASE_RATIO.client[1])
      if (!(await pathExists(jarPath))) log.warn(`客户端 jar 被跳过且本地不存在：${jarPath}`)
    } else {
      if (!clientUrl) {
        throw new Error(`版本 ${versionId} 缺少客户端 jar 下载信息（downloads.client），无法安装`)
      }
      report('client', `下载客户端 jar（${hasOwnJar ? versionId : `继承自 ${jarVersionId}`}）…`, PHASE_RATIO.client[0])
      const urls = new Set<string>()
      urls.add(this.mirror.resolve(clientUrl, 'mojang'))
      if (this.mirror.get('mojang') === 'bmclapi') {
        // bmclapi 的 /version/<id>/client 比通用 URL 映射更可靠，作为备用地址
        urls.add(this.mirror.bmclapiClientJar(jarVersionId))
      }
      urls.add(clientUrl)
      const [primary, ...fallbacks] = [...urls]
      const item: DownloadItem = {
        key: `client:${jarVersionId}`,
        url: primary,
        fallbackUrls: fallbacks.length > 0 ? fallbacks : undefined,
        dest: jarPath,
        sha1: clientDownload?.sha1,
        size: clientDownload?.size
      }
      const result = await this.downloadManager.runTask(`install:${versionId}:client`, {
        label: '客户端 jar',
        items: [item],
        signal,
        onProgress: downloadProgressFor('client', '客户端 jar')
      })
      if (!result.ok) throw downloadFailureError('客户端 jar', result)
      totalBytes += result.bytes
      report('client', `客户端 jar 就绪（${jarPath}）`, PHASE_RATIO.client[1])
    }

    /* ---------------- libraries：依赖库（含 native 分类包） ---------------- */
    const libs = resolveLibraries(detail.libraries, {
      librariesDir,
      rules: createRuleContext(),
      mirror: this.mirror
    })
    const libraryItems = dedupeByDest(libraryDownloadItems(libs))
    if (libraryItems.length === 0) {
      report('libraries', '没有需要下载的依赖库', PHASE_RATIO.libraries[1])
    } else {
      report('libraries', `下载 ${libraryItems.length} 个依赖库…`, PHASE_RATIO.libraries[0])
      const result = await this.downloadManager.runTask(`install:${versionId}:libraries`, {
        label: '依赖库',
        items: libraryItems,
        signal,
        onProgress: downloadProgressFor('libraries', '依赖库')
      })
      if (!result.ok) throw downloadFailureError('依赖库', result)
      totalBytes += result.bytes
      report('libraries', `依赖库就绪（${libraryItems.length} 个）`, PHASE_RATIO.libraries[1])
    }

    /* ---------------- assets：资源索引 + 资源对象 ---------------- */
    let assetIndexId = detail.assetIndex?.id ?? detail.assets ?? versionId
    if (opts.skipAssets) {
      report('assets', '已跳过资源下载', PHASE_RATIO.assets[1])
    } else {
      report('assets', '检查资源索引…', PHASE_RATIO.assets[0])
      const indexResult = await this.assets.ensureAssetIndex(assetsDir, gameDir, resolved, {
        taskId: `install:${versionId}:assets`,
        signal,
        onProgress: downloadProgressFor('assets', '资源索引')
      })
      assetIndexId = indexResult.indexId
      if (indexResult.indexFileMissing) {
        log.warn(`版本 ${versionId} 的资源索引缺失，按空索引继续`)
      }
      const assetResult = await this.assets.installAssets({
        assetsDir,
        index: indexResult.index,
        signal,
        onProgress: downloadProgressFor('assets', '游戏资源'),
        taskId: `install:${versionId}:assets`
      })
      if (!assetResult.ok) throw downloadFailureError('游戏资源', assetResult)
      totalBytes += assetResult.bytes

      const objectCount = Object.keys(indexResult.index.objects ?? {}).length
      if (objectCount === 0) {
        report('assets', '该版本没有需要下载的资源对象', PHASE_RATIO.assets[1])
      } else if (indexResult.index.virtual || indexResult.index.map_to_resources) {
        // 1.6 及以前的版本使用虚拟资源目录；map_to_resources 还要展开到 <gameDir>/resources
        report('assets', '展开虚拟资源目录（1.6 及以前的目录结构）…', 0.85)
        const materialized = await this.assets.materializeVirtualAssets(assetsDir, indexResult.indexId, indexResult.index, {
          mapToResources: indexResult.index.map_to_resources === true
        })
        report('assets', `资源就绪（虚拟资源 ${materialized.count} 个文件）`, PHASE_RATIO.assets[1])
      } else {
        report('assets', `资源就绪（${objectCount} 个对象）`, PHASE_RATIO.assets[1])
      }
    }

    /* ---------------- natives：解压 native 库 ---------------- */
    const nativeDir = join(this.repository.versionDir(gameDir, versionId), 'natives')
    const natives = nativeLibraries(libs)
    if (natives.length === 0) {
      report('natives', '没有需要解压的 native 库', PHASE_RATIO.natives[1])
    } else {
      report('natives', `解压 ${natives.length} 个 native 库…`, PHASE_RATIO.natives[0])
      // 先清空：切换加载器 / 版本后残留的旧 dll 会被 JVM 误加载，导致原生崩溃
      await removePath(nativeDir)
      await ensureDir(nativeDir)
      const failures: string[] = []
      let done = 0
      for (const lib of natives) {
        try {
          await extractNativeJar(lib.absolutePath, nativeDir, lib.extractExclude)
        } catch (err) {
          failures.push(`${lib.path}：${errorMessage(err)}`)
        }
        done++
        const [start, end] = PHASE_RATIO.natives
        report('natives', `已解压 ${done}/${natives.length} 个 native 库`, start + (end - start) * (done / natives.length))
      }
      if (failures.length > 0) {
        throw new Error(`native 库解压失败（${failures.length}/${natives.length}）：\n${failures.map((f) => `- ${f}`).join('\n')}`)
      }
      report('natives', `native 库解压完成（${nativeDir}）`, PHASE_RATIO.natives[1])
    }

    report('done', `版本 ${versionId} 安装完成`, 1)
    log.info(
      `版本安装完成：${versionId}（jar=${hasOwnJar ? versionId : `${jarVersionId}(继承)`}，库 ${libs.length} 项，下载 ${totalBytes} 字节）`
    )

    return {
      versionId,
      versionDir: this.repository.versionDir(gameDir, versionId),
      jarPath,
      jsonPath: this.repository.versionJsonPath(gameDir, versionId),
      librariesDir,
      assetsDir,
      assetIndexId,
      totalBytes
    }
  }

  /**
   * 校验本地安装完整性（不联网、不改动任何文件）。
   * 库与资源对象按「存在 + 大小一致」判断；client jar 有 sha1 时做完整哈希校验。
   */
  async verify(opts: { gameDir: string; versionId: string }): Promise<VerifyResult> {
    const { gameDir, versionId } = opts
    const detailLines: string[] = []
    let resolved: ResolvedVersion
    try {
      resolved = await this.repository.resolve(gameDir, versionId, { allowNetwork: false })
    } catch (err) {
      return {
        ok: false,
        missingLibraries: 0,
        missingAssets: 0,
        clientJarOk: false,
        detail: [`无法解析版本 ${versionId}：${errorMessage(err)}`]
      }
    }

    const librariesDir = join(gameDir, 'libraries')
    const assetsDir = join(gameDir, 'assets')
    const libs = resolveLibraries(resolved.detail.libraries, {
      librariesDir,
      rules: createRuleContext(),
      mirror: this.mirror
    })

    let missingLibraries = 0
    const missingLibrarySamples: string[] = []
    for (const lib of libs) {
      const size = await fileSize(lib.absolutePath)
      const expected = lib.size ?? 0
      // 大小未知（老格式 json）时只能判断「存在且非空」
      const ok = size > 0 && (expected === 0 || size === expected)
      if (!ok) {
        missingLibraries++
        if (missingLibrarySamples.length < 8) missingLibrarySamples.push(lib.path)
      }
    }
    if (missingLibraries > 0) {
      detailLines.push(
        `缺失或大小不符的依赖库 ${missingLibraries} 个：${missingLibrarySamples.join('、')}${missingLibraries > missingLibrarySamples.length ? ' …' : ''}`
      )
    }

    // client jar：可能在目标版本目录（自带的 jar），也可能在父版本目录（继承的 jar）
    const clientInfo = resolved.detail.downloads?.client
    const jarCandidates = new Set([
      join(this.repository.versionDir(gameDir, versionId), `${versionId}.jar`),
      join(this.repository.versionDir(gameDir, resolved.jarVersionId), `${resolved.jarVersionId}.jar`)
    ])
    let clientJarOk = false
    for (const candidate of jarCandidates) {
      if (!(await pathExists(candidate))) continue
      const size = await fileSize(candidate)
      if (clientInfo?.size && size !== clientInfo.size) continue
      if (clientInfo?.sha1) {
        try {
          if ((await sha1OfFile(candidate)) !== clientInfo.sha1.toLowerCase()) continue
        } catch {
          continue
        }
      }
      clientJarOk = true
      break
    }
    if (!clientJarOk) {
      detailLines.push(`客户端 jar 缺失或校验失败（检查过 ${[...jarCandidates].join('、')}）`)
    }

    // 资源：没有索引时无法校验；json 里根本没有资源字段的版本视为不适用
    const hasAssetFields = !!resolved.detail.assetIndex || !!resolved.detail.assets
    const indexId = resolved.detail.assetIndex?.id ?? resolved.detail.assets ?? versionId
    const indexPath = join(assetsDir, 'indexes', `${indexId}.json`)
    const index = await readJsonSafe<AssetIndex | null>(indexPath, null)
    let missingAssets = 0
    let assetsVerifiable = true
    if (!index?.objects) {
      assetsVerifiable = !hasAssetFields
      if (hasAssetFields) detailLines.push(`资源索引缺失，无法校验资源对象：${indexPath}`)
    } else {
      const objects = Object.values(index.objects)
      const missing = await mapConcurrent(
        objects,
        64,
        async (obj) => {
          try {
            const size = await fileSize(join(assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash))
            return size > 0 && (obj.size === undefined || size === obj.size) ? null : obj.hash
          } catch {
            return obj.hash
          }
        }
      )
      const missingList = missing.filter((hash): hash is string => hash !== null)
      missingAssets = missingList.length
      if (missingAssets > 0) {
        detailLines.push(`缺失或大小不符的资源对象 ${missingAssets} 个（索引 ${indexId}）`)
      }
    }

    const ok = clientJarOk && missingLibraries === 0 && missingAssets === 0 && assetsVerifiable
    return { ok, missingLibraries, missingAssets, clientJarOk, detail: detailLines }
  }

  /**
   * 安装前的规模预估（会联网补全缺失的版本 json，但不下载任何游戏文件）。
   * assetObjects 只有在本地已有资源索引时才能给出精确值，否则为 0，
   * 此时 totalBytes 用 assetIndex.totalSize（json 自带的总量）兜底。
   */
  async plan(opts: { gameDir: string; versionId: string }): Promise<InstallPlan> {
    const { gameDir, versionId } = opts
    const resolved = await this.repository.resolve(gameDir, versionId)
    const librariesDir = join(gameDir, 'libraries')
    const assetsDir = join(gameDir, 'assets')

    const items = dedupeByDest(
      libraryDownloadItems(
        resolveLibraries(resolved.detail.libraries, {
          librariesDir,
          rules: createRuleContext(),
          mirror: this.mirror
        })
      )
    )
    const libraryBytes = items.reduce((acc, item) => acc + (item.size ?? 0), 0)

    const indexId = resolved.detail.assetIndex?.id ?? resolved.detail.assets ?? versionId
    const index = await readJsonSafe<AssetIndex | null>(join(assetsDir, 'indexes', `${indexId}.json`), null)
    let assetObjects = 0
    let assetBytes = 0
    if (index?.objects) {
      const objects = Object.values(index.objects)
      assetObjects = objects.length
      assetBytes = objects.reduce((acc, obj) => acc + (obj.size ?? 0), 0)
    } else {
      assetBytes = resolved.detail.assetIndex?.totalSize ?? 0
    }

    return {
      libraries: items.length,
      assetObjects,
      totalBytes: libraryBytes + assetBytes,
      clientJarBytes: resolved.detail.downloads?.client?.size ?? 0
    }
  }
}

/* ------------------------------------------------------------------ *
 *  内部辅助
 * ------------------------------------------------------------------ */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 把下载失败聚合成一个带上下文的错误，绝不静默吞掉 */
function downloadFailureError(phase: string, result: DownloadTaskResult): Error {
  const sample = result.failures.slice(0, 8).map((f) => `- ${f.key || f.url}：${f.error}`)
  const more = result.failures.length > sample.length ? `\n…（共 ${result.failures.length} 个失败）` : ''
  return new Error(`${phase}阶段有 ${result.failures.length}/${result.total} 个文件下载失败：\n${sample.join('\n')}${more}`)
}

/** 同一条目可能同时作为 classpath 与 native 产出，dest 相同的只下载一次 */
function dedupeByDest(items: DownloadItem[]): DownloadItem[] {
  const seen = new Set<string>()
  const out: DownloadItem[] = []
  for (const item of items) {
    if (seen.has(item.dest)) continue
    seen.add(item.dest)
    out.push(item)
  }
  return out
}

/**
 * 解压 native jar 到目标目录。
 * 排除规则来自库的 `extract.exclude`（如 META-INF/），语义为「前缀匹配则跳过」；
 * 同时拒绝含 `..` 的路径，防止压缩包目录穿越。
 */
async function extractNativeJar(jarPath: string, targetDir: string, exclude: string[] | undefined): Promise<number> {
  if (!(await pathExists(jarPath))) {
    throw new Error(`native 库文件缺失：${jarPath}`)
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(jarPath)
  } catch (err) {
    throw new Error(`无法读取 native 压缩包 ${jarPath}：${errorMessage(err)}`)
  }

  let count = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (!name || name.includes('..')) continue
    if (exclude?.some((prefix) => name.startsWith(prefix))) continue
    const dest = join(targetDir, name)
    await ensureDir(dirname(dest))
    await writeFile(dest, entry.getData())
    count++
  }
  return count
}
