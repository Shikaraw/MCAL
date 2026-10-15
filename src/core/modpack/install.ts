/**
 * 整合包安装器
 *
 * 职责边界：
 *  - 解析清单（委托 ModpackInspector）；
 *  - 逐个文件下载：`downloads` 有直链就下载（经镜像解析），
 *    没有直链但有 `platform` 信息时通过注入的 PlatformService 反查真实地址，
 *    两条路都不通就记入 manualDownloads（例如 CurseForge 无 API Key）；
 *  - 复制 overrides / client-overrides 到目标游戏目录（目标是新实例，直接复制）；
 *  - 单个文件失败不中断整体，失败率 > 20% 时强提示；
 *  - **不实现加载器安装**：把 loaderType/loaderVersion 回传，并在 warnings 里说明需要调用 LoaderManager。
 *
 * 安全：所有落盘路径都经 safeResolveInside 校验，zip 条目先做穿越校验，防 zip slip。
 */

import { copyFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  DownloadItem,
  DownloadProgress,
  LoaderType,
  ModpackManifest,
  Platform,
  ProjectVersion
} from '@shared/types'
import { DownloadManager } from '@core/net/downloader'
import type { MirrorResolver } from '@core/net/mirror'
import { fallbackMirrors } from '@core/net/mirror'
import { ensureDir, isDirectory, pathExists, shortId, walkFiles } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { formatBytes } from '@core/util/misc'
import {
  ModpackInspector,
  assertSafeZipEntry,
  normalizeArchivePath,
  openZipArchive,
  overridesDirList,
  safeResolveInside
} from '@core/modpack/inspect'

const log = logger.scoped('modpack-install')

/* ------------------------------------------------------------------ *
 *  平台服务的最小鸭子类型接口
 *
 * 真实的 PlatformService 由上层注入；这里只依赖「能把 (platform, projectId, versionId)
 * 解析成真实下载地址」这一能力，并兼容几种常见方法命名，避免与 PlatformService 的实现强耦合。
 * ------------------------------------------------------------------ */

export interface ResolvedPlatformFile {
  url: string
  fileName?: string
  size?: number
  hashes?: Record<string, string>
}

export interface PlatformResolveRequest {
  platform: Platform
  projectId: string
  versionId: string
  gameVersion?: string
  loader?: LoaderType
}

export interface PlatformServiceLike {
  /** 首选：直接解析单文件 */
  resolveFile?(opts: PlatformResolveRequest): Promise<ResolvedPlatformFile | null>
  resolveDownload?(opts: PlatformResolveRequest): Promise<ResolvedPlatformFile | null>
  getVersionFile?(opts: PlatformResolveRequest): Promise<ResolvedPlatformFile | null>
  /** 兜底：列出项目版本（本仓库 PlatformService.versions 的形态），再从中挑文件 */
  versions?(opts: { platform: Platform; projectId: string; gameVersion?: string; loader?: LoaderType }): Promise<ProjectVersion[]>
}

/* ------------------------------------------------------------------ *
 *  请求 / 结果
 * ------------------------------------------------------------------ */

export interface ModpackInstallRequest {
  file?: string
  dir?: string
  /** 目标游戏目录（会创建实例） */
  targetGameDir: string
  name?: string
  /** 同时安装哪些可选文件 */
  skipOptional?: boolean
  platform?: PlatformServiceLike
  signal?: AbortSignal
  onProgress?: (p: { phase: string; message: string; ratio: number; download?: DownloadProgress }) => void
}

export interface ModpackInstallResult {
  instanceDir: string
  name: string
  gameVersion: string
  loaderType: LoaderType
  loaderVersion?: string
  installedFiles: string[]
  skippedFiles: { path: string; reason: string }[]
  failedFiles: { path: string; reason: string }[]
  warnings: string[]
  /** 需要用户手动处理的文件（如 CurseForge 无 key） */
  manualDownloads: { fileName: string; projectId?: string; url?: string }[]
}

/** 整合包根目录里属于「启动器清单」的文件，复制 overrides 时要跳过 */
const MANIFEST_FILE_NAMES = new Set([
  'mcal-pack.json',
  'modrinth.index.json',
  'manifest.json',
  'mcbbs.packmeta',
  'instance.cfg',
  'mmc-pack.json',
  'hmclversion.cfg'
])

/** 目录型整合包（overrides = 根目录）里不复制的内容：日志、崩溃报告与截图 */
const DIR_PACK_EXCLUDED_PREFIXES = ['logs/', 'crash-reports/', 'screenshots/', 'replay_patches/']

function isManifestFileName(relPath: string): boolean {
  const normalized = normalizeArchivePath(relPath)
  if (!normalized.includes('/')) return MANIFEST_FILE_NAMES.has(normalized.toLowerCase())
  return false
}

/* ------------------------------------------------------------------ *
 *  安装器
 * ------------------------------------------------------------------ */

export class ModpackInstaller {
  private readonly downloadManager: DownloadManager
  private readonly inspector: ModpackInspector

  constructor(opts: { downloadManager: DownloadManager; inspector: ModpackInspector }) {
    this.downloadManager = opts.downloadManager
    this.inspector = opts.inspector
  }

  async install(req: ModpackInstallRequest): Promise<ModpackInstallResult> {
    if (!req.file && !req.dir) throw new Error('整合包安装需要提供 file 或 dir 之一')
    const taskId = shortId('pack-')
    const emit = (phase: string, message: string, ratio: number, download?: DownloadProgress): void => {
      req.onProgress?.({ phase, message, ratio: Math.max(0, Math.min(1, ratio)), download })
    }
    const ensureAlive = (): void => {
      if (req.signal?.aborted) throw new Error('整合包安装已取消')
    }

    /* -------------------------- 1. 识别与计划 -------------------------- */
    emit('inspect', '正在识别整合包格式…', 0.02)
    const inspected = await this.inspector.inspect({ file: req.file, dir: req.dir })
    const manifest = inspected.manifest
    const warnings = [...inspected.warnings]
    if (manifest.format === 'unknown') {
      throw new Error(
        `无法识别整合包格式（${req.file ?? req.dir}）：支持 Modrinth(.mrpack) / CurseForge / MMC / HMCL / MCAL 格式。` +
          '如果这是一个普通游戏目录压缩包，请解压后以目录形式导入。'
      )
    }

    const targetGameDir = resolve(req.targetGameDir)
    await ensureDir(targetGameDir)

    const name = (req.name ?? manifest.name ?? '整合包').trim() || '整合包'
    const installedFiles: string[] = []
    const skippedFiles: { path: string; reason: string }[] = []
    const failedFiles: { path: string; reason: string }[] = []
    const manualDownloads: { fileName: string; projectId?: string; url?: string }[] = []

    /* -------------------------- 2. 规划下载项 -------------------------- */
    emit('plan', `共 ${manifest.files.length} 个清单文件，正在解析下载地址…`, 0.05)
    const items: DownloadItem[] = []
    const plannedRelPaths = new Set<string>()

    for (const file of manifest.files) {
      ensureAlive()
      const rawPath = file.path && file.path.trim().length > 0 ? file.path : join(file.targetDir ?? 'mods', 'unknown.jar')
      let relPath = normalizeArchivePath(rawPath)
      let fileName = basename(relPath) || 'download.bin'
      let hashes = { ...(file.hashes ?? {}) }
      let size = file.fileSize
      let url: string | undefined

      if (file.downloads && file.downloads.length > 0) {
        url = file.downloads[0]
      } else if (file.platform && req.platform) {
        const resolved = await this.resolvePlatformFile(req.platform, file.platform, manifest.gameVersion, manifest.loaderType)
        if (resolved) {
          url = resolved.url
          if (resolved.fileName) {
            fileName = basename(resolved.fileName)
            const targetDir = file.targetDir ?? (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : 'mods')
            relPath = normalizeArchivePath(`${targetDir}/${fileName}`)
          }
          if (resolved.size) size = resolved.size
          if (resolved.hashes) hashes = { ...hashes, ...resolved.hashes }
        }
      }

      if (req.skipOptional && file.optional) {
        skippedFiles.push({ path: relPath, reason: '可选文件（skipOptional 已跳过）' })
        continue
      }

      if (!url) {
        manualDownloads.push({ fileName, projectId: file.platform?.projectId, url: file.downloads?.[0] })
        skippedFiles.push({ path: relPath, reason: '没有可用的下载地址（需要平台 API Key 或手动下载后放入对应目录）' })
        continue
      }

      const dest = safeResolveInside(targetGameDir, relPath)
      if (await pathExists(dest)) {
        skippedFiles.push({ path: relPath, reason: '目标已存在同名文件，将按哈希校验决定是否覆盖' })
      }
      const mirroredUrl = this.mirrorUrl(url)
      items.push({
        key: relPath,
        url: mirroredUrl,
        fallbackUrls: [
          ...(file.downloads ?? []).slice(1).map((candidate) => this.mirrorUrl(candidate)),
          ...fallbackMirrors(mirroredUrl)
        ].filter((candidate) => candidate && candidate !== mirroredUrl),
        dest,
        sha1: hashes.sha1,
        sha256: hashes.sha256,
        size,
        skipIfExists: false
      })
      plannedRelPaths.add(relPath)
    }

    /* -------------------------- 3. 下载 -------------------------- */
    if (items.length > 0) {
      ensureAlive()
      const totalBytes = items.reduce((acc, item) => acc + (item.size ?? 0), 0)
      emit(
        'download',
        `开始下载 ${items.length} 个文件${totalBytes > 0 ? `（约 ${formatBytes(totalBytes)}）` : ''}…`,
        0.1
      )
      const result = await this.downloadManager.runTask(taskId, {
        label: `整合包「${name}」`,
        items,
        continueOnError: true,
        signal: req.signal,
        onProgress: (progress) => {
          const ratio = progress.total > 0 ? 0.1 + 0.6 * (progress.completed / progress.total) : 0.4
          emit('download', DownloadManager.describeProgress(progress), ratio, progress)
        }
      })
      const failedKeys = new Set(result.failures.map((failure) => failure.key))
      for (const failure of result.failures) {
        failedFiles.push({ path: failure.key || failure.url, reason: failure.error })
      }
      for (const item of items) {
        if (!failedKeys.has(item.key)) installedFiles.push(item.key)
      }
      if (failedFiles.length > 0) {
        log.warn(`整合包下载失败 ${failedFiles.length}/${items.length} 个文件`)
      }
    }

    /* -------------------------- 4. overrides -------------------------- */
    ensureAlive()
    emit('overrides', '正在复制 overrides / client-overrides…', 0.75)
    const copyResult = await this.copyOverrides({
      root: inspected.root,
      manifest,
      targetGameDir,
      signal: req.signal,
      shouldSkip: (relPath) => {
        // 清单里已下载的同名文件优先保留（避免 overrides 用旧版覆盖刚下载的版本）
        return plannedRelPaths.has(relPath)
      }
    })
    installedFiles.push(...copyResult.copied)
    skippedFiles.push(...copyResult.skipped)

    /* -------------------------- 5. 汇总 -------------------------- */
    const attempted = items.length
    if (attempted > 0 && failedFiles.length / attempted > 0.2) {
      warnings.push(
        `下载失败率过高（${failedFiles.length}/${attempted}，超过 20%）：实例可能无法启动。请检查网络/镜像源后重新导入，或按 manualDownloads 手动补齐。`
      )
    }
    if (manifest.loaderType && manifest.loaderType !== 'vanilla') {
      warnings.push(
        `需调用 LoaderManager 安装加载器：${manifest.loaderType}${manifest.loaderVersion ? ` ${manifest.loaderVersion}` : ''}` +
          `（目标游戏版本 ${manifest.gameVersion ?? '未知'}）。整合包安装器不负责安装加载器，请在上层完成后再启动。`
      )
    }
    if (!manifest.gameVersion) {
      warnings.push('未能从清单中识别游戏版本：请在创建实例时手动指定 MC 版本。')
    }
    if (manualDownloads.length > 0) {
      warnings.push(
        `有 ${manualDownloads.length} 个文件需要手动处理（清单里没有直链）：` +
          manualDownloads
            .slice(0, 8)
            .map((item) => item.fileName + (item.projectId ? `(${item.projectId})` : ''))
            .join('、') +
          (manualDownloads.length > 8 ? ' 等' : '')
      )
    }
    if (copyResult.conflicts.length > 0) {
      warnings.push(`overrides 覆盖了 ${copyResult.conflicts.length} 个已存在的文件（详情见 skippedFiles 中的“被整合包覆盖”条目）。`)
    }
    emit('done', `整合包「${name}」安装完成：${installedFiles.length} 个文件`, 1)

    return {
      instanceDir: targetGameDir,
      name,
      gameVersion: manifest.gameVersion ?? '',
      loaderType: manifest.loaderType ?? 'vanilla',
      loaderVersion: manifest.loaderVersion,
      installedFiles,
      skippedFiles,
      failedFiles,
      warnings,
      manualDownloads
    }
  }

  /* ------------------------------ 平台解析 ------------------------------ */

  /** 通过注入的 PlatformService 把 platform 定位信息解析成真实下载地址（兼容多种方法名） */
  private async resolvePlatformFile(
    platform: PlatformServiceLike,
    target: { type: Platform; projectId: string; versionId: string },
    gameVersion?: string,
    loader?: LoaderType
  ): Promise<ResolvedPlatformFile | null> {
    const request: PlatformResolveRequest = {
      platform: target.type,
      projectId: target.projectId,
      versionId: target.versionId,
      gameVersion,
      loader
    }
    const directMethods = [platform.resolveFile, platform.resolveDownload, platform.getVersionFile].filter(
      (fn): fn is (opts: PlatformResolveRequest) => Promise<ResolvedPlatformFile | null> => typeof fn === 'function'
    )
    for (const method of directMethods) {
      try {
        const resolved = await method.call(platform, request)
        if (resolved?.url) return resolved
      } catch (err) {
        log.debug(`平台解析失败（${target.type} ${target.projectId}/${target.versionId}）：${(err as Error).message}`)
      }
    }
    if (typeof platform.versions === 'function') {
      try {
        const versions = await platform.versions({ platform: target.type, projectId: target.projectId, gameVersion, loader })
        const picked =
          versions.find((version) => version.versionId === target.versionId) ?? versions[0]
        if (picked && picked.files.length > 0) {
          const file = picked.files.find((candidate) => candidate.primary) ?? picked.files[0]
          return {
            url: file.url,
            fileName: file.filename,
            size: file.size,
            hashes: file.hashes
          }
        }
      } catch (err) {
        log.debug(`平台版本列表解析失败（${target.type} ${target.projectId}）：${(err as Error).message}`)
      }
    }
    return null
  }

  /** 把官方地址映射到当前镜像（无 MirrorResolver 时原样返回） */
  private mirrorUrl(url: string): string {
    const resolver = (this.downloadManager as { mirrorResolver?: MirrorResolver }).mirrorResolver
    if (!resolver || typeof resolver.resolve !== 'function') return url
    try {
      const isModrinth = /(?:api\.modrinth\.com|cdn\.modrinth\.com|github\.com|githubusercontent\.com)/i.test(url)
      return resolver.resolve(url, isModrinth ? 'modrinth' : 'mojang')
    } catch {
      return url
    }
  }

  /* ------------------------------ overrides ------------------------------ */

  private async copyOverrides(opts: {
    root: string
    manifest: ModpackManifest
    targetGameDir: string
    signal?: AbortSignal
    shouldSkip: (relPath: string) => boolean
  }): Promise<{
    copied: string[]
    skipped: { path: string; reason: string }[]
    conflicts: string[]
  }> {
    const { root, manifest, targetGameDir } = opts
    const copied: string[] = []
    const skipped: { path: string; reason: string }[] = []
    const conflicts: string[] = []
    const dirs = overridesDirList(manifest)
    if (dirs.length === 0) return { copied, skipped, conflicts }

    const sourceKind = typeof manifest.extra?.sourceKind === 'string' ? manifest.extra.sourceKind : undefined
    const isGenericDirPack = manifest.extra?.genericDirPack === true

    const handleFile = async (relPath: string, write: (dest: string) => Promise<void>): Promise<void> => {
      if (opts.signal?.aborted) throw new Error('整合包安装已取消')
      const rel = normalizeArchivePath(relPath)
      if (rel.length === 0) return
      if (isManifestFileName(rel)) return
      if (isGenericDirPack) {
        const lower = rel.toLowerCase()
        if (DIR_PACK_EXCLUDED_PREFIXES.some((prefix) => lower.startsWith(prefix)) || /\.log$/i.test(lower)) {
          skipped.push({ path: rel, reason: '目录型整合包：日志/崩溃报告/截图不复制' })
          return
        }
      }
      if (opts.shouldSkip(rel)) {
        skipped.push({ path: rel, reason: '清单里已下载同一文件，overrides 未覆盖' })
        return
      }
      const dest = safeResolveInside(targetGameDir, rel)
      if (await pathExists(dest)) {
        conflicts.push(rel)
        skipped.push({ path: rel, reason: '目标已存在同名文件，被整合包覆盖' })
      }
      await ensureDir(dirname(dest))
      await write(dest)
      copied.push(rel)
    }

    if (sourceKind === 'directory') {
      for (const dir of dirs) {
        if (opts.signal?.aborted) throw new Error('整合包安装已取消')
        const srcDir = dir === '.' ? root : resolve(root, dir)
        if (!(await isDirectory(srcDir))) continue
        const files = await walkFiles(srcDir, { maxDepth: 20 })
        for (const rel of files) {
          const from = join(srcDir, rel)
          await handleFile(dir === '.' ? rel : `${dir}/${rel}`, (dest) => copyFile(from, dest))
        }
      }
      return { copied, skipped, conflicts }
    }

    // zip：直接读条目写入（已验证穿越安全）
    const zip = openZipArchive(root)
    const prefix = typeof manifest.extra?.rootPrefix === 'string' ? manifest.extra.rootPrefix : ''
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      assertSafeZipEntry(entry.entryName)
      const name = normalizeArchivePath(entry.entryName)
      if (name.length === 0) continue
      if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue
      if (prefix && !name.startsWith(prefix)) continue
      const local = prefix ? name.slice(prefix.length) : name
      let matched: string | undefined
      for (const dir of dirs) {
        const normalizedDir = dir.replace(/^\.\/+/, '').replace(/\/+$/, '')
        if (normalizedDir === '.' || normalizedDir === '') {
          matched = local
          break
        }
        if (local === normalizedDir) continue
        if (local.startsWith(`${normalizedDir}/`)) {
          matched = local.slice(normalizedDir.length + 1)
          break
        }
      }
      if (!matched) continue
      const data = entry.getData()
      await handleFile(matched, (dest) => writeFile(dest, data))
    }
    return { copied, skipped, conflicts }
  }
}

export default ModpackInstaller
