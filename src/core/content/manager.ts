/**
 * 内容管理器：扫描实例内的 mods / resourcepacks / shaderpacks / datapacks / saves，
 * 负责启用禁用、导入、删除、一致性校验与清单摘要。
 *
 * 设计要点：
 *  - 启用/禁用统一用 `.disabled` 后缀（`.jar.disabled` / `.zip.disabled` 都算禁用），
 *    这是启动器生态里最常见的约定，且不改变加载器行为；
 *  - 元数据解析限制并发为 4（mapConcurrent），避免同时打开上百个 zip 导致句柄/内存暴涨；
 *  - 校验全部离线完成，不发起任何网络请求。
 */

import { basename, extname, join } from 'node:path'
import { copyFile, readdir, rename, stat } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import type { ContentFile, ContentIssue, ContentKind, LoaderType, ModEnvironment } from '@shared/types'
import type { DownloadManager } from '@core/net/downloader'
import {
  copyDir,
  dirSize,
  ensureDir,
  isDirectory,
  pathExists,
  removePath
} from '@core/util/fsx'
import { extractGameVersions, formatBytes, mapConcurrent, sha1OfFile } from '@core/util/misc'
import { logger } from '@core/util/logger'
import {
  describePackFormat,
  displayNameOf,
  getMetaExtra,
  guessContentKind,
  inspectArchiveKind,
  packFormatVersions,
  packFormatsForVersion,
  parseContentFile
} from './metadata'

const log = logger.scoped('content')

export interface ScanOptions {
  gameDir: string
  kinds?: ContentKind[]
  withMeta?: boolean
  withHash?: boolean
  signal?: AbortSignal
  onProgress?: (done: number, total: number, current: string) => void
}

/** 内容类型 → 实例内子目录 */
export const KIND_DIRS: Record<ContentKind, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shaderpack: 'shaderpacks',
  datapack: 'datapacks',
  world: 'saves',
  modpack: 'modpacks'
}

const DEFAULT_SCAN_KINDS: ContentKind[] = ['mod', 'resourcepack', 'shaderpack', 'datapack', 'world']

const MOD_FILE_RE = /\.(jar|litemod|zip)(\.disabled)?$/i
const ZIP_FILE_RE = /\.zip(\.disabled)?$/i
const MRPACK_FILE_RE = /\.(mrpack|zip)(\.disabled)?$/i
const DISABLED_RE = /\.disabled$/i
const JUNK_RE = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i

/** 是否处于禁用状态（.disabled 后缀） */
export function isDisabledPath(path: string): boolean {
  return DISABLED_RE.test(path)
}

/** 生成禁用后的文件名（已有 .disabled 则原样返回） */
export function disabledName(path: string): string {
  return isDisabledPath(path) ? path : `${path}.disabled`
}

/** 生成启用后的文件名（去掉 .disabled；没有则原样返回） */
export function enabledName(path: string): string {
  return path.replace(DISABLED_RE, '')
}

/* ------------------------------------------------------------------ *
 *  加载器 / 依赖 / 性能模组常量表
 * ------------------------------------------------------------------ */

/**
 * 这些 depends 项不是「需要安装的 mod 文件」，而是运行环境本身：
 * minecraft（版本范围）、forge/neoforge（加载器）、fabricloader、java、Fabric API（启动器/整合包生态默认会带）。
 */
export const NON_MOD_DEPENDENCIES: ReadonlySet<string> = new Set([
  'minecraft',
  'forge',
  'neoforge',
  'fabricloader',
  'fabric-loader',
  'fabric',
  'fabric-api',
  'quilt_loader',
  'quiltloader',
  'quilt-base',
  'java',
  'javafml',
  'mcp',
  'optifine',
  'liteloader',
  'modloader',
  'bukkit',
  'spigot',
  'paper'
])

/** 依赖 id 归一化：去掉分隔符，展开常见别名 */
export function normalizeLoaderId(id: string): string {
  const key = id.trim().toLowerCase().replace(/[\s_-]/g, '')
  const aliases: Record<string, string> = {
    fabric: 'fabric',
    fabricloader: 'fabric',
    quilt: 'quilt',
    quiltloader: 'quilt',
    forge: 'forge',
    minecraftforge: 'forge',
    neoforge: 'neoforge',
    neo: 'neoforge',
    liteloader: 'liteloader',
    optifine: 'optifine',
    vanilla: 'vanilla'
  }
  return aliases[key] ?? key
}

export function isNonModDependency(id: string): boolean {
  return NON_MOD_DEPENDENCIES.has(id.trim().toLowerCase())
}

/**
 * 判断 mod 声明的加载器与实例加载器是否兼容。
 * 兼容规则：
 *  - Quilt 可以加载 Fabric 模组
 *  - NeoForge 1.20.1 时代兼容 Forge 模组（之后的版本不再兼容 → 用 warn 而不是 error）
 */
export function loaderCompatibility(loader: LoaderType, declared?: string[]): 'ok' | 'warn' | 'mismatch' {
  if (!declared || declared.length === 0) return 'ok'
  const set = new Set(declared.map(normalizeLoaderId))
  // 原版实例装任何声明了加载器的 mod 都不成立
  if (loader === 'vanilla') return 'mismatch'
  switch (loader) {
    case 'fabric':
      return set.has('fabric') ? 'ok' : 'mismatch'
    case 'quilt':
      return set.has('quilt') || set.has('fabric') ? 'ok' : 'mismatch'
    case 'forge':
      return set.has('forge') ? 'ok' : 'mismatch'
    case 'neoforge':
      return set.has('neoforge') ? 'ok' : set.has('forge') ? 'warn' : 'mismatch'
    case 'liteloader':
      return set.has('liteloader') ? 'ok' : set.has('forge') ? 'warn' : 'mismatch'
    default:
      return 'ok'
  }
}

/**
 * mod 声明的游戏版本是否涵盖实例版本。
 * 声明里通常只写主次版本（1.20 表示 1.20.x），因此声明 1.20 视为涵盖 1.20.1；
 * 反向不成立（声明 1.20.1 不涵盖 1.20）。
 */
export function gameVersionsMatch(declared: string[] | undefined, target: string): boolean {
  if (!declared || declared.length === 0) return true
  const normalizedTarget = target.trim()
  return declared.some((raw) => {
    const v = raw.trim()
    if (!v) return false
    if (v === normalizedTarget) return true
    return normalizedTarget.startsWith(`${v}.`)
  })
}

/**
 * 已知的性能/渲染优化模组互斥表。
 * 这些是社区公认的冲突组合（多为同一功能的 fork 或渲染管线占用）：
 *  - Sodium 与 OptiFine / Embeddium / Rubidium 互斥
 *  - OptiFine 与 Embeddium / Oculus / Iris 互斥（Oculus/Iris 需要 Embeddium/Rubidium 系）
 *  - Embeddium 是 Rubidium 的继任者，二者不能共存
 */
export const PERFORMANCE_CONFLICT_PAIRS: readonly {
  a: string
  b: string
  reason: string
  severity: 'error' | 'warning'
}[] = [
  { a: 'sodium', b: 'optifine', reason: 'Sodium 与 OptiFine 的渲染管线互斥，同时安装会导致渲染异常或崩溃', severity: 'error' },
  { a: 'sodium', b: 'embeddium', reason: 'Sodium 与 Embeddium 是同一类渲染核心的两个实现，只能二选一', severity: 'error' },
  { a: 'sodium', b: 'rubidium', reason: 'Sodium 与 Rubidium 是同一类渲染核心的两个实现，只能二选一', severity: 'error' },
  { a: 'embeddium', b: 'rubidium', reason: 'Embeddium 是 Rubidium 的继任者，两者同时安装会冲突', severity: 'error' },
  { a: 'optifine', b: 'embeddium', reason: 'OptiFine 与 Embeddium 渲染管线冲突', severity: 'warning' },
  { a: 'optifine', b: 'oculus', reason: 'Oculus 依赖 Embeddium/Rubidium，与 OptiFine 冲突', severity: 'warning' },
  { a: 'optifine', b: 'iris', reason: 'OptiFine 与 Iris 都提供光影加载能力，建议只保留一个', severity: 'warning' },
  { a: 'iris', b: 'oculus', reason: 'Iris 与 Oculus 分别是 Fabric/Forge 的光影加载器，通常只会用到其中一个', severity: 'warning' }
]

const PERF_IDS = ['sodium', 'embeddium', 'rubidium', 'optifine', 'iris', 'oculus'] as const

/**
 * 从 ContentFile 推断性能模组的规范 id。
 * 优先用解析出的 mod id；OptiFine 的 jar 没有元数据文件，只能靠文件名识别。
 */
export function canonicalPerformanceId(file: ContentFile): string | null {
  const id = (file.meta?.id ?? '').trim().toLowerCase()
  if ((PERF_IDS as readonly string[]).includes(id)) return id
  const name = file.fileName.toLowerCase()
  if (/optifine/.test(name)) return 'optifine'
  for (const candidate of PERF_IDS) {
    if (candidate === 'optifine') continue
    if (new RegExp(`(^|[^a-z])${candidate}([^a-z]|$)`).test(name)) return candidate
  }
  return null
}

/* ------------------------------------------------------------------ *
 *  ContentManager
 * ------------------------------------------------------------------ */

export class ContentManager {
  /** 预留给后续「资源包/光影下载」能力（当前扫描/校验全部离线） */
  readonly downloads?: DownloadManager

  constructor(opts: { downloadManager?: DownloadManager } = {}) {
    this.downloads = opts.downloadManager
  }

  /* -------------------- 扫描 -------------------- */

  /** 扫描实例内容目录。 */
  async scan(opts: ScanOptions): Promise<ContentFile[]> {
    const { gameDir } = opts
    const kinds = opts.kinds && opts.kinds.length > 0 ? [...new Set(opts.kinds)] : DEFAULT_SCAN_KINDS
    const files: ContentFile[] = []
    for (const kind of kinds) {
      if (opts.signal?.aborted) throw new Error('扫描已取消')
      const dir = join(gameDir, KIND_DIRS[kind])
      if (!(await isDirectory(dir))) continue
      try {
        files.push(...(await this.collectKind(dir, kind)))
      } catch (err) {
        log.warn(`扫描 ${dir} 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (opts.withHash) {
      const total = files.length
      let done = 0
      await mapConcurrent(
        files,
        META_CONCURRENCY,
        async (file) => {
          if ((await isDirectory(file.path)) === false) {
            try {
              file.hash = await sha1OfFile(file.path)
            } catch (err) {
              file.error = `哈希计算失败：${err instanceof Error ? err.message : String(err)}`
            }
          }
          done++
          opts.onProgress?.(done, total, file.fileName)
        },
        opts.signal
      )
    }

    if (opts.withMeta) {
      const total = files.length
      let done = 0
      await mapConcurrent(
        files,
        META_CONCURRENCY,
        async (file) => {
          try {
            const parsed = await parseContentFile(file.path, file.kind)
            file.meta = parsed.meta
            // 解析告警（例如缺少 pack.mcmeta）记录到 error 字段供 UI 展示，
            // 它们不是致命错误，因此只在没有其它错误时写入。
            if (!file.error && parsed.warnings.length > 0) file.error = parsed.warnings.join('；')
          } catch (err) {
            file.error = `元数据解析失败：${err instanceof Error ? err.message : String(err)}`
          }
          done++
          opts.onProgress?.(done, total, file.fileName)
        },
        opts.signal
      )
    }

    return sortFiles(files)
  }

  /** 收集单类内容目录下的条目（不解析元数据） */
  private async collectKind(dir: string, kind: ContentKind): Promise<ContentFile[]> {
    const out: ContentFile[] = []
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (JUNK_RE.test(entry.name) || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const isDirEntry = entry.isDirectory()
      let nameOk = false
      if (kind === 'mod') nameOk = !isDirEntry && MOD_FILE_RE.test(entry.name)
      else if (kind === 'world') nameOk = isDirEntry || ZIP_FILE_RE.test(entry.name)
      else if (kind === 'modpack') nameOk = !isDirEntry && MRPACK_FILE_RE.test(entry.name)
      else nameOk = isDirEntry || ZIP_FILE_RE.test(entry.name)
      if (!nameOk) continue
      // 目录形态的内容包（资源包/光影/存档可以是文件夹）
      try {
        const info = await stat(full)
        const size = isDirEntry ? await dirSize(full, 20_000) : info.size
        out.push({
          path: full,
          fileName: entry.name,
          kind,
          size,
          mtimeMs: info.mtimeMs,
          enabled: !DISABLED_RE.test(entry.name)
        })
      } catch (err) {
        log.debug(`跳过 ${full}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return out
  }

  /* -------------------- 启用 / 禁用 -------------------- */

  /**
   * 启用/禁用内容：通过重命名加/去 `.disabled` 后缀实现。
   * 返回处理后的路径（状态未变化时返回原路径）。
   */
  async setEnabled(filePath: string, enabled: boolean): Promise<string> {
    const currentlyEnabled = !isDisabledPath(filePath)
    if (enabled === currentlyEnabled) return filePath
    const target = enabled ? enabledName(filePath) : disabledName(filePath)
    if (await pathExists(target)) {
      throw new Error(`无法${enabled ? '启用' : '禁用'}：目标文件已存在（${target}）`)
    }
    await rename(filePath, target)
    return target
  }

  /** 批量删除（默认永久删除，返回成功与失败清单；不存在的路径算失败项） */
  async remove(paths: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
    const removed: string[] = []
    const failed: { path: string; error: string }[] = []
    for (const path of paths) {
      try {
        if (!(await pathExists(path))) {
          failed.push({ path, error: '路径不存在' })
          continue
        }
        await removePath(path)
        removed.push(path)
      } catch (err) {
        failed.push({ path, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { removed, failed }
  }

  /* -------------------- 导入 -------------------- */

  /**
   * 导入文件/文件夹到正确的子目录：
   * mod → mods/、资源包 → resourcepacks/、光影 → shaderpacks/、数据包 → datapacks/、存档 → saves/。
   * 类型优先按内容嗅探（zip 内是否含 pack.mcmeta / data/ / shaders/ / level.dat），
   * 再退化到文件名启发式。文件夹形态的资源包/光影直接复制目录（Minecraft 原生支持），不打包成 zip。
   * 重名时按 overwrite 决定覆盖或追加 “ (1)” 后缀。
   */
  async importFiles(
    gameDir: string,
    sources: string[],
    opts: { kind?: ContentKind; overwrite?: boolean } = {}
  ): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = []
    const skipped: string[] = []
    const overwrite = opts.overwrite ?? false

    for (const source of sources) {
      try {
        const info = await stat(source)
        const fileName = basename(source)
        let kind = opts.kind ?? guessContentKind(fileName)
        const sniffed = info.isDirectory() ? await this.detectDirectoryKind(source) : await inspectArchiveKind(source)
        if (sniffed) kind = sniffed

        if (kind === 'modpack') {
          // 整合包由上层（modpack 导入流程）处理，这里只落到 modpacks/ 便于后续识别
          if (info.isDirectory()) {
            skipped.push(source)
            log.info(`整合包文件夹 ${source} 请使用整合包导入流程`)
            continue
          }
          const packDir = join(gameDir, KIND_DIRS.modpack)
          await ensureDir(packDir)
          const dest = await resolveDest(packDir, fileName, overwrite)
          await copyFile(source, dest)
          imported.push(dest)
          continue
        }

        const targetDir = join(gameDir, KIND_DIRS[kind])
        await ensureDir(targetDir)

        if (kind === 'world') {
          if (info.isDirectory()) {
            const dest = await resolveDest(targetDir, fileName, overwrite)
            await copyDir(source, dest)
            imported.push(dest)
          } else {
            // 世界 zip：解压到 saves/<名字>/（Minecraft 只读取 saves 下的文件夹）
            const dest = await resolveDest(targetDir, displayNameOf(fileName), overwrite)
            await ensureDir(dest)
            const zip = new AdmZip(source)
            zip.extractAllTo(dest, true)
            imported.push(dest)
          }
          continue
        }

        if (info.isDirectory()) {
          const dest = await resolveDest(targetDir, fileName, overwrite)
          await copyDir(source, dest)
          imported.push(dest)
        } else {
          const dest = await resolveDest(targetDir, fileName, overwrite)
          await copyFile(source, dest)
          imported.push(dest)
        }
      } catch (err) {
        log.warn(`导入 ${source} 失败：${err instanceof Error ? err.message : String(err)}`)
        skipped.push(source)
      }
    }
    return { imported, skipped }
  }

  /** 目录形态内容类型嗅探（资源包/光影/存档文件夹） */
  private async detectDirectoryKind(dir: string): Promise<ContentKind | null> {
    const has = (rel: string): Promise<boolean> => pathExists(join(dir, rel))
    if (await has('modrinth.index.json')) return 'modpack'
    if (await has('level.dat')) return 'world'
    if (await has('pack.mcmeta')) {
      if (await has('data')) return 'datapack'
      if (await has('assets')) return 'resourcepack'
      return null
    }
    if (await has('iris.properties') || (await has('shaders/shaders.properties'))) return 'shaderpack'
    if (await has('shaders')) {
      const shaderDir = await readdir(join(dir, 'shaders')).catch(() => [])
      if (shaderDir.some((f) => /\.(fsh|vsh|glsl|csh|gsh)$/i.test(f))) return 'shaderpack'
    }
    if (await has('assets')) return 'resourcepack'
    if (await has('data')) return 'datapack'
    if ((await has('manifest.json')) && !(await has('textures'))) return 'modpack'
    return null
  }

  /* -------------------- 校验 -------------------- */

  /**
   * 一致性校验（全部离线）：
   *  - mod 声明的 gameVersions 与实例版本不匹配
   *  - mod 声明的 loaders 与实例加载器不匹配
   *  - 客户端/服务端专属 mod 装错环境
   *  - 缺失必需依赖
   *  - 同一 modId 重复（多版本共存）
   *  - 资源包/数据包 pack_format 与目标版本不符
   *  - 性能模组互斥
   *  - 光影与加载器/加载器 mod 不匹配
   */
  async validate(opts: {
    gameDir: string
    gameVersion?: string
    loaderType?: LoaderType
    side?: 'client' | 'server'
  }): Promise<ContentIssue[]> {
    const issues: ContentIssue[] = []
    const files = await this.scan({
      gameDir: opts.gameDir,
      kinds: ['mod', 'resourcepack', 'shaderpack', 'datapack'],
      withMeta: true
    })
    const mods = files.filter((f) => f.kind === 'mod')

    // 1) 逐个 mod 的版本/加载器/环境检查
    for (const file of mods) {
      const meta = file.meta
      if (!meta) continue
      if (!meta.id && !meta.name) continue

      if (opts.gameVersion) {
        const declared = meta.gameVersions?.length ? meta.gameVersions : extractGameVersions(file.fileName)
        if (declared.length > 0 && !gameVersionsMatch(declared, opts.gameVersion)) {
          issues.push({
            severity: 'warning',
            code: 'mod.game-version-mismatch',
            message: `mod「${label(file)}」声明支持 ${describeVersions(declared)}，实例为 ${opts.gameVersion}`,
            files: [file.path],
            suggestion: '安装与该 MC 版本匹配的 mod 版本；若作者已声明多版本支持请忽略'
          })
        }
      }

      if (opts.loaderType && meta.loaders && meta.loaders.length > 0) {
        const verdict = loaderCompatibility(opts.loaderType, meta.loaders)
        if (verdict === 'mismatch') {
          issues.push({
            severity: 'error',
            code: 'mod.loader-mismatch',
            message: `mod「${label(file)}」声明加载器 ${meta.loaders.join('/')}，与实例加载器 ${opts.loaderType} 不兼容`,
            files: [file.path],
            suggestion: `改用 ${meta.loaders.join('/')} 版本，或给实例安装对应加载器`
          })
        } else if (verdict === 'warn') {
          issues.push({
            severity: 'warning',
            code: 'mod.loader-maybe-incompatible',
            message: `mod「${label(file)}」声明加载器 ${meta.loaders.join('/')}，实例为 ${opts.loaderType}（仅旧版本可能兼容）`,
            files: [file.path],
            suggestion: '若启动报 mod 解析失败，请换用目标加载器的专版'
          })
        }
      }

      const environment: ModEnvironment | undefined = meta.environment
      if (opts.side === 'server' && environment === 'client') {
        issues.push({
          severity: 'warning',
          code: 'mod.client-only-on-server',
          message: `mod「${label(file)}」标记为仅客户端，装在服务端不会生效，且可能导致服务端崩溃`,
          files: [file.path],
          suggestion: '从服务端 mods 目录移除该 mod'
        })
      }
      if (opts.side === 'client' && environment === 'server') {
        issues.push({
          severity: 'info',
          code: 'mod.server-only-on-client',
          message: `mod「${label(file)}」标记为仅服务端，客户端通常无需安装`,
          files: [file.path],
          suggestion: '从客户端 mods 目录移除该 mod'
        })
      }

      if (file.enabled && (!meta.id || meta.id === '')) {
        issues.push({
          severity: 'info',
          code: 'mod.metadata-missing',
          message: `无法解析「${file.fileName}」的 mod 元数据，校验已跳过该文件`,
          files: [file.path],
          suggestion: `确认它是模组文件；若为整合包或损坏文件请移出 mods 目录${file.error ? `（${file.error}）` : ''}`
        })
      }
    }

    // 2) 缺失依赖
    for (const missing of this.findMissingDependencies(files)) {
      issues.push({
        severity: 'error',
        code: 'mod.missing-dependency',
        message: `缺少前置 mod「${missing.modId}」，被${missing.requiredBy.map((r) => `「${r}」`).join('、')}依赖${
          missing.versionRange ? `（版本要求 ${missing.versionRange}）` : ''
        }`,
        files: files.filter((f) => f.meta?.id === missing.modId || missing.requiredBy.includes(label(f))).map((f) => f.path),
        suggestion: `安装 ${missing.modId}${missing.versionRange ? ` ${missing.versionRange}` : ''}`
      })
    }

    // 3) 重复 mod（同一 modId 多个文件）
    const byModId = new Map<string, ContentFile[]>()
    for (const file of mods) {
      const id = file.meta?.id?.trim().toLowerCase()
      if (!id) continue
      const list = byModId.get(id) ?? []
      list.push(file)
      byModId.set(id, list)
    }
    for (const [id, list] of byModId) {
      if (list.length < 2) continue
      const versions = [...new Set(list.map((f) => f.meta?.version ?? '未知'))]
      issues.push({
        severity: versions.length > 1 ? 'warning' : 'info',
        code: 'mod.duplicate',
        message:
          versions.length > 1
            ? `同一 mod「${id}」存在多个版本：${versions.join('、')}，加载器只会加载其中一个（通常加载版本号最高者或直接崩溃）`
            : `同一 mod「${id}」存在 ${list.length} 个重复副本（版本 ${versions[0]}）`,
        files: list.map((f) => f.path),
        suggestion: '删除旧版本，只保留一个'
      })
    }

    // 4) 资源包/数据包 pack_format
    if (opts.gameVersion) {
      for (const file of files) {
        if (file.kind === 'resourcepack' || file.kind === 'datapack') {
          const issue = this.checkPackFormat(file, opts.gameVersion)
          if (issue) issues.push(issue)
        }
      }
    }

    // 5) 性能模组互斥
    const perf = new Map<string, ContentFile>()
    for (const file of mods) {
      if (!file.enabled) continue
      const id = canonicalPerformanceId(file)
      if (id && !perf.has(id)) perf.set(id, file)
    }
    for (const pair of PERFORMANCE_CONFLICT_PAIRS) {
      const a = perf.get(pair.a)
      const b = perf.get(pair.b)
      if (a && b) {
        issues.push({
          severity: pair.severity,
          code: 'mod.performance-conflict',
          message: `检测到性能模组互斥：${a.fileName} 与 ${b.fileName} —— ${pair.reason}`,
          files: [a.path, b.path],
          suggestion: '只保留其中一个（OptiFine 与 Sodium/Embeddium 系列不要同时安装）'
        })
      }
    }

    // 6) 光影与加载器/Iris 的匹配
    for (const file of files) {
      if (file.kind !== 'shaderpack') continue
      const language = file.meta?.shaderLanguage ?? ''
      const irisOnly = language.includes('Iris') && !language.includes('OptiFine')
      if (!irisOnly) continue
      const hasIrisLoaderMod = mods.some((m) => {
        const id = (m.meta?.id ?? '').toLowerCase()
        return m.enabled && (id === 'iris' || id === 'oculus')
      })
      if (!hasIrisLoaderMod) {
        issues.push({
          severity: 'warning',
          code: 'shader.iris-required',
          message: `光影「${file.fileName}」是 Iris 专属（${file.meta?.description ?? '未识别 GLSL 版本'}），当前 mods 中没有 Iris/Oculus`,
          files: [file.path],
          suggestion: '安装 Iris（Fabric/Quilt）或 Oculus（Forge/NeoForge），或改用 OptiFine 兼容光影'
        })
      }
    }

    return issues
  }

  /**
   * 从已装 mod 的 depends 中找出缺失的 modId（离线，只给建议不做安装）。
   * 已禁用（.disabled）的 mod 视为未安装，因为加载器不会加载它。
   */
  findMissingDependencies(files: ContentFile[]): { modId: string; requiredBy: string[]; versionRange?: string }[] {
    const installed = new Set<string>()
    for (const file of files) {
      if (file.kind !== 'mod' || !file.enabled) continue
      const id = file.meta?.id?.trim().toLowerCase()
      if (id) installed.add(id)
    }
    const missing = new Map<string, { modId: string; requiredBy: Set<string>; versionRange?: string }>()
    for (const file of files) {
      if (file.kind !== 'mod' || !file.enabled) continue
      const depends = file.meta?.depends
      if (!depends || depends.length === 0) continue
      const owner = label(file)
      for (const dep of depends) {
        if (!dep.required) continue
        const id = dep.id.trim().toLowerCase()
        if (!id || isNonModDependency(id) || installed.has(id)) continue
        const entry = missing.get(id) ?? { modId: dep.id, requiredBy: new Set<string>(), versionRange: dep.versionRange }
        entry.requiredBy.add(owner)
        if (!entry.versionRange && dep.versionRange) entry.versionRange = dep.versionRange
        missing.set(id, entry)
      }
    }
    return [...missing.values()].map((entry) => ({
      modId: entry.modId,
      requiredBy: [...entry.requiredBy],
      versionRange: entry.versionRange
    }))
  }

  /** 生成给 Agent 看的清单摘要（token 友好，最多 ~50 行） */
  summarize(files: ContentFile[]): string {
    const lines: string[] = []
    const groups = new Map<ContentKind, ContentFile[]>()
    for (const file of files) {
      const list = groups.get(file.kind) ?? []
      list.push(file)
      groups.set(file.kind, list)
    }
    const kindLabel: Record<ContentKind, string> = {
      mod: 'mod',
      resourcepack: '资源包',
      shaderpack: '光影',
      datapack: '数据包',
      world: '存档',
      modpack: '整合包'
    }
    const order: ContentKind[] = ['mod', 'resourcepack', 'shaderpack', 'datapack', 'world', 'modpack']
    const overview = order
      .filter((k) => (groups.get(k)?.length ?? 0) > 0)
      .map((k) => {
        const list = groups.get(k)!
        if (k === 'mod') {
          const enabled = list.filter((f) => f.enabled).length
          return `mod ${list.length}（启用 ${enabled}/禁用 ${list.length - enabled}）`
        }
        return `${kindLabel[k]} ${list.length}`
      })
    lines.push(`内容概览：${overview.length > 0 ? overview.join(' · ') : '空'}`)

    const emit = (kind: ContentKind, formatter: (file: ContentFile) => string): void => {
      const list = groups.get(kind)
      if (!list || list.length === 0) return
      lines.push(`[${kindLabel[kind]}] ${list.length} 个`)
      const limit = kind === 'mod' ? 30 : 20
      for (const file of list.slice(0, limit)) lines.push(`  - ${formatter(file)}`)
      if (list.length > limit) lines.push(`  …另有 ${list.length - limit} 个未列出`)
    }

    emit('mod', (f) => {
      const meta = f.meta
      const flags: string[] = []
      if (!f.enabled) flags.push('已禁用')
      if (meta?.environment === 'client') flags.push('仅客户端')
      if (meta?.environment === 'server') flags.push('仅服务端')
      if (meta?.loaders?.length) flags.push(meta.loaders.join('/'))
      const gv = meta?.gameVersions
      if (gv && gv.length > 0) flags.push(gv.length === 1 ? gv[0] : `${gv[0]}–${gv[gv.length - 1]}`)
      const base = meta?.id ? `${meta.id}${meta.version ? `@${meta.version}` : ''}` : `${f.fileName}（未识别元数据）`
      return `${base}${flags.length > 0 ? `（${flags.join('，')}）` : ''}`
    })
    emit('resourcepack', (f) => {
      const format = f.meta?.packFormat
      return `${f.meta?.name ?? f.fileName}${format !== undefined && format !== null ? `（format ${describePackFormat(format, 'resourcepack')}）` : '（无 pack_format）'}${f.enabled ? '' : '（已禁用）'}`
    })
    emit('shaderpack', (f) => `${f.meta?.name ?? f.fileName}${f.meta?.shaderLanguage ? `（${f.meta.shaderLanguage}）` : ''}${f.enabled ? '' : '（已禁用）'}`)
    emit('datapack', (f) => `${f.meta?.name ?? f.fileName}${f.meta?.packFormat !== undefined && f.meta?.packFormat !== null ? `（format ${f.meta.packFormat}）` : ''}`)
    emit('world', (f) => {
      const extra = getMetaExtra(f.meta)
      const parts = [f.meta?.name ?? f.fileName]
      if (extra?.dataVersion !== undefined) parts.push(`DataVersion=${extra.dataVersion}`)
      parts.push(formatBytes(f.size))
      return parts.join('，')
    })
    emit('modpack', (f) => f.fileName)

    if (lines.length > 50) {
      const removed = lines.length - 50
      return `${lines.slice(0, 50).join('\n')}\n…（已截断 ${removed} 行，可用 content 工具查询完整清单）`
    }
    return lines.join('\n')
  }

  /** 计算文件哈希（sha1），返回 路径 → 哈希。用于整合包导出与去重。 */
  async hashFiles(paths: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    await mapConcurrent(paths, META_CONCURRENCY, async (path) => {
      try {
        if (await isDirectory(path)) return
        out[path] = await sha1OfFile(path)
      } catch (err) {
        log.debug(`哈希失败 ${path}：${err instanceof Error ? err.message : String(err)}`)
      }
    })
    return out
  }

  /**
   * 资源包/数据包的 pack_format 与目标 MC 版本兼容性检查。
   *  - 有 supported_formats 时，只要其中任一格式被目标版本接受即视为兼容（1.20.2+ 语义）
   *  - 目标版本超出内置对照表范围时不做判断（返回 null）
   */
  checkPackFormat(file: ContentFile, gameVersion: string): ContentIssue | null {
    if (file.kind !== 'resourcepack' && file.kind !== 'datapack') return null
    const kind = file.kind === 'datapack' ? 'datapack' : 'resourcepack'
    const format = file.meta?.packFormat
    const acceptable = packFormatsForVersion(gameVersion, kind)
    if (acceptable.length === 0) return null // 目标版本未知 → 不判断
    if (format === undefined || format === null) {
      // 光影/文件夹形态资源包可能没有 pack.mcmeta
      return {
        severity: 'warning',
        code: 'pack.format-missing',
        message: `「${file.fileName}」没有读到 pack_format，无法确认与 ${gameVersion} 的兼容性`,
        files: [file.path],
        suggestion: '用压缩包形式提供 pack.mcmeta，或手动确认支持该版本'
      }
    }
    const extra = getMetaExtra(file.meta)
    const candidates = [format, ...(extra?.supportedFormats ?? [])]
    if (candidates.some((f) => acceptable.includes(f))) return null
    const known = packFormatVersions(format, kind)
    return {
      severity: 'warning',
      code: 'pack.format-mismatch',
      message: `${kind === 'datapack' ? '数据包' : '资源包'}「${file.fileName}」的 pack_format=${format}${
        known ? `（${known[0]}–${known[known.length - 1]}）` : '（未收录）'
      } 与目标版本 ${gameVersion} 要求的格式 ${acceptable.join('/')} 不一致，游戏会把它标记为不兼容`,
      files: [file.path],
      suggestion: `下载支持 ${gameVersion} 的版本，或修改 pack.mcmeta 的 pack_format/supported_formats`
    }
  }
}

/* ------------------------------------------------------------------ *
 *  辅助
 * ------------------------------------------------------------------ */

const META_CONCURRENCY = 4

function sortFiles(files: ContentFile[]): ContentFile[] {
  const order: ContentKind[] = ['mod', 'resourcepack', 'shaderpack', 'datapack', 'world', 'modpack']
  return [...files].sort((a, b) => {
    const d = order.indexOf(a.kind) - order.indexOf(b.kind)
    if (d !== 0) return d
    return a.fileName.localeCompare(b.fileName, 'zh-Hans-CN')
  })
}

function label(file: ContentFile): string {
  return file.meta?.id ? `${file.meta.id}${file.meta.version ? `@${file.meta.version}` : ''}` : file.fileName
}

function describeVersions(versions: string[]): string {
  if (versions.length <= 3) return versions.join('、')
  return `${versions[0]}–${versions[versions.length - 1]}（共 ${versions.length} 个）`
}

/** 目标路径冲突时生成唯一名：overwrite 时覆盖，否则追加 “ (1)”、“ (2)”… */
async function resolveDest(dir: string, name: string, overwrite: boolean): Promise<string> {
  const dest = join(dir, name)
  if (!(await pathExists(dest))) return dest
  if (overwrite) {
    await removePath(dest)
    return dest
  }
  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${base} (${i})${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  return join(dir, `${base} (${Date.now()})${ext}`)
}

/** 供上层复用的「实例内容目录」解析 */
export function contentDirOf(gameDir: string, kind: ContentKind): string {
  return join(gameDir, KIND_DIRS[kind])
}
