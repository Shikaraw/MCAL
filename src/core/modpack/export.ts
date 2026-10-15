/**
 * 整合包导出器
 *
 * 支持的导出格式：
 *  - `modrinth`：`modrinth.index.json` + `overrides/`（有 recognized 的文件只写 hash+url，不打包）；
 *  - `curseforge`：`manifest.json` + `overrides/`（无法从 hash 反查 projectID/fileID，所有文件进 overrides）；
 *  - `mcal`：`mcal-pack.json`（完整 ModpackManifest）+ `overrides/`，保证 MCAL 自身无损往返。
 *
 * 安全（硬要求）：
 *  - 永远排除敏感内容：`servers.dat`（服务器列表）、`usercache.json`、`launcher_profiles*.json`、
 *    `session.lock`、`*.token` / 凭据文件、`.mcal*` 启动器数据；
 *  - `options.txt` 保留但剔除 `lastServer` 行（避免泄露上次进入的服务器）；
 *  - 默认排除 `logs/`、`crash-reports/`、`screenshots/`、`saves/`（除非 includeSaves）等；
 *  - 导出前统计敏感文件数量并在 warnings 里说明。
 */

import { randomUUID } from 'node:crypto'
import { readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import type { LoaderType, ModpackManifest, ModpackManifestFile } from '@shared/types'
import { decodeText, ensureDir, isDirectory, walkFiles } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('modpack-export')

/* ------------------------------------------------------------------ *
 *  选项 / 结果
 * ------------------------------------------------------------------ */

export interface RecognizedPackFile {
  platform: 'modrinth'
  projectId: string
  versionId: string
  url?: string
  sha1?: string
  size?: number
}

export interface ExportOptions {
  gameDir: string
  outFile: string
  name: string
  version?: string
  author?: string
  format: 'modrinth' | 'mcal' | 'curseforge'
  gameVersion?: string
  loaderType?: LoaderType
  loaderVersion?: string
  includeConfig?: boolean
  includeSaves?: boolean
  includeResourcePacks?: boolean
  includeShaderPacks?: boolean
  /** 需要排除的路径前缀 */
  exclude?: string[]
  /** 已识别的项目文件（由 PlatformService.lookupByHash 得到），能提供时导出官方下载地址而非打包文件 */
  recognized?: Record<string, RecognizedPackFile>
  onProgress?: (p: { phase: string; message: string; ratio: number }) => void
}

export interface ExportResult {
  file: string
  fileCount: number
  packedBytes: number
  warnings: string[]
}

export interface BuildManifestResult {
  manifest: ModpackManifest
  /** 会被打包进 zip 的文件（相对游戏目录的路径 + 大小） */
  packed: { path: string; size: number }[]
  warnings: string[]
}

/**
 * 默认排除的目录（无开关时永远排除）。
 * `versions/libraries/assets` 不属于整合包内容（是启动器安装的游戏本体），一并排除，
 * 否则导出会把整个游戏目录（几十 GB）塞进 zip。
 */
export const ALWAYS_EXCLUDED_DIRS = [
  'logs',
  'crash-reports',
  'screenshots',
  'replay_patches',
  'temp',
  'downloads',
  'versions',
  'libraries',
  'assets',
  'natives'
]

/** 敏感文件（永远排除，且计入 warnings 统计） */
const SENSITIVE_FILES = [
  'servers.dat',
  'usercache.json',
  'launcher_profiles.json',
  'launcher_profiles_microsoft_store.json',
  'realms_persistence.json'
]
const SENSITIVE_RE = /(?:^|\/)(?:[^/]*\.(?:token|credentials?|keystore|p12)|\.mcal[^/]*)$/i

/* ------------------------------------------------------------------ *
 *  路径分类（纯函数，便于测试）
 * ------------------------------------------------------------------ */

export interface ClassifyContext {
  includeSaves?: boolean
  includeConfig?: boolean
  includeResourcePacks?: boolean
  includeShaderPacks?: boolean
  /** 路径前缀（相对游戏目录，posix 或反斜杠都接受） */
  exclude?: string[]
}

export interface ClassifyResult {
  keep: boolean
  /** 排除原因（keep=false 时给出） */
  reason?: string
  /** 是否敏感文件（用于导出前统计） */
  sensitive?: boolean
  /** 需要在打包时剔除 lastServer 行 */
  redactOptions?: boolean
  /** 是否为被禁用的内容（*.disabled） */
  disabled?: boolean
}

export function normalizeRelPath(relPath: string): string {
  return (relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function matchesPrefix(relPath: string, prefix: string): boolean {
  const target = normalizeRelPath(prefix).replace(/\/+$/, '').toLowerCase()
  if (target.length === 0) return false
  const lower = relPath.toLowerCase()
  return lower === target || lower.startsWith(`${target}/`)
}

/**
 * 判断游戏目录里的某个文件是否应进入整合包。
 * 顺序很重要：敏感文件 > 用户排除 > 默认排除目录 > 内容开关。
 */
export function classifyExportPath(inputRelPath: string, ctx: ClassifyContext = {}): ClassifyResult {
  const rel = normalizeRelPath(inputRelPath)
  const lower = rel.toLowerCase()
  const name = basename(lower)
  const includeConfig = ctx.includeConfig !== false
  const includeResourcePacks = ctx.includeResourcePacks !== false
  const includeShaderPacks = ctx.includeShaderPacks !== false

  // 1) 敏感内容：永远排除
  if (SENSITIVE_FILES.includes(name)) return { keep: false, reason: '敏感文件（服务器列表 / 账号缓存）', sensitive: true }
  if (SENSITIVE_RE.test(lower)) return { keep: false, reason: '敏感文件（token / 凭据 / 启动器数据）', sensitive: true }
  if (/(^|\/)\.mcal/.test(lower)) return { keep: false, reason: '敏感文件（MCAL 启动器数据）', sensitive: true }
  if (/(^|\/)session\.lock$/.test(lower)) return { keep: false, reason: '会话锁文件' }
  if (/(^|\/)bootstrap-[^/]*\.log$/.test(lower)) return { keep: false, reason: '启动器引导日志' }
  if (/(^|\/)hs_err_pid[^/]*\.log$/.test(lower)) return { keep: false, reason: 'JVM 崩溃日志' }
  if (/\.log$/i.test(lower)) return { keep: false, reason: '日志文件' }

  // 2) 用户显式排除
  if (ctx.exclude && ctx.exclude.some((prefix) => matchesPrefix(lower, prefix))) {
    return { keep: false, reason: '用户指定的排除项' }
  }

  // 3) 永远排除的目录
  if (ALWAYS_EXCLUDED_DIRS.some((dir) => matchesPrefix(lower, dir))) {
    return { keep: false, reason: `默认排除目录 ${ALWAYS_EXCLUDED_DIRS.join('/')}` }
  }

  // 4) 存档
  if (matchesPrefix(lower, 'saves') && ctx.includeSaves !== true) {
    return { keep: false, reason: '存档目录（includeSaves=false）' }
  }

  // 5) 资源包 / 光影
  if (matchesPrefix(lower, 'resourcepacks') && !includeResourcePacks) {
    return { keep: false, reason: '资源包目录（includeResourcePacks=false）' }
  }
  if (matchesPrefix(lower, 'shaderpacks')) {
    if (!includeShaderPacks) return { keep: false, reason: '光影目录（includeShaderPacks=false）' }
    // 光影目录里的说明/配置文本（shaderpacks/*.txt）不打包
    if (/^shaderpacks\/[^/]+\.txt$/i.test(lower)) return { keep: false, reason: '光影说明文本（shaderpacks/*.txt）' }
  }

  // 6) 配置 / options.txt
  if (!includeConfig) {
    if (matchesPrefix(lower, 'config') || matchesPrefix(lower, 'defaultconfigs') || matchesPrefix(lower, 'localconfigs')) {
      return { keep: false, reason: '配置目录（includeConfig=false）' }
    }
    if (name === 'options.txt') return { keep: false, reason: '选项文件（includeConfig=false）' }
  }

  // 7) 被禁用的内容不导出（.disabled 后缀）
  if (/\.disabled$/i.test(lower)) return { keep: false, reason: '被禁用的内容（*.disabled）', disabled: true }

  // 8) options.txt：保留但剔除 lastServer
  if (name === 'options.txt') return { keep: true, redactOptions: true }

  return { keep: true }
}

/* ------------------------------------------------------------------ *
 *  导出器
 * ------------------------------------------------------------------ */

interface PlanEntry {
  relPath: string
  absPath: string
  size: number
  /** zip 内条目名 */
  entryName: string
  kind: 'manifest-file' | 'override'
  recognized?: RecognizedPackFile
  redactOptions?: boolean
}

interface ExportPlan {
  manifest: ModpackManifest
  manifestJson: unknown
  manifestEntryName: string
  entries: PlanEntry[]
  excluded: { path: string; reason: string }[]
  sensitiveCount: number
  redactedOptions: boolean
  disabledCount: number
  packedBytes: number
  fileCount: number
  warnings: string[]
}

export class ModpackExporter {
  constructor(_opts: Record<string, unknown> = {}) {
    // 当前无状态；保留构造函数以便未来注入 HttpClient / PlatformService
  }

  /** 生成整合包 zip */
  async export(opts: ExportOptions): Promise<ExportResult> {
    const plan = await this.buildPlan(opts)
    const emit = (phase: string, message: string, ratio: number): void => opts.onProgress?.({ phase, message, ratio })

    const zip = new AdmZip()
    zip.addFile(plan.manifestEntryName, Buffer.from(JSON.stringify(plan.manifestJson, null, 2), 'utf8'))
    let fileCount = 1
    let packedBytes = 0
    const packed = plan.entries.filter((entry) => entry.kind === 'override')
    for (let i = 0; i < packed.length; i++) {
      const entry = packed[i]
      if (entry.redactOptions) {
        const text = await this.readOptionsWithoutServer(entry.absPath)
        zip.addFile(entry.entryName, Buffer.from(text, 'utf8'))
      } else {
        zip.addLocalFile(entry.absPath, dirname(entry.entryName), basename(entry.entryName))
      }
      packedBytes += entry.size
      fileCount++
      if (i % 100 === 0 || i === packed.length - 1) {
        emit('pack', `打包中：${i + 1}/${packed.length}`, packed.length > 0 ? (i + 1) / packed.length : 1)
      }
    }

    const outFile = resolve(opts.outFile)
    await ensureDir(dirname(outFile))
    const tmp = `${outFile}.${randomUUID().slice(0, 8)}.tmp`
    emit('write', '正在写入 zip…', 0.98)
    zip.writeZip(tmp)
    await rename(tmp, outFile)
    log.info(`整合包已导出：${outFile}（${fileCount} 个文件，${packedBytes} 字节）`)
    emit('done', `导出完成：${outFile}`, 1)

    return { file: outFile, fileCount, packedBytes, warnings: plan.warnings }
  }

  /** 只生成 manifest 清单（不打包），用于预览与给 Agent 看 */
  async buildManifest(opts: ExportOptions): Promise<BuildManifestResult> {
    const plan = await this.buildPlan(opts)
    return {
      manifest: plan.manifest,
      packed: plan.entries.filter((entry) => entry.kind === 'override').map((entry) => ({ path: entry.relPath, size: entry.size })),
      warnings: plan.warnings
    }
  }

  /* ------------------------------ 计划 ------------------------------ */

  private async buildPlan(opts: ExportOptions): Promise<ExportPlan> {
    const gameDir = resolve(opts.gameDir)
    if (!(await isDirectory(gameDir))) throw new Error(`游戏目录不存在：${gameDir}`)
    const warnings: string[] = []
    const emit = (phase: string, message: string, ratio: number): void => opts.onProgress?.({ phase, message, ratio })

    emit('scan', '正在扫描游戏目录…', 0.05)
    const relPaths = (await walkFiles(gameDir, { maxDepth: 20 })).map(normalizeRelPath).sort()
    const recognizedMap = buildRecognizedIndex(opts.recognized)

    const entries: PlanEntry[] = []
    const excluded: { path: string; reason: string }[] = []
    let sensitiveCount = 0
    let disabledCount = 0
    let redactedOptions = false

    for (const rel of relPaths) {
      const classified = classifyExportPath(rel, {
        includeSaves: opts.includeSaves,
        includeConfig: opts.includeConfig,
        includeResourcePacks: opts.includeResourcePacks,
        includeShaderPacks: opts.includeShaderPacks,
        exclude: opts.exclude
      })
      if (!classified.keep) {
        excluded.push({ path: rel, reason: classified.reason ?? '已排除' })
        if (classified.sensitive) sensitiveCount++
        if (classified.disabled) disabledCount++
        continue
      }
      if (classified.redactOptions) redactedOptions = true
      const absPath = resolve(gameDir, rel)
      let size = 0
      try {
        size = (await stat(absPath)).size
      } catch {
        continue
      }
      const recognized = lookupRecognized(recognizedMap, rel, absPath)
      entries.push({
        relPath: rel,
        absPath,
        size,
        entryName: `overrides/${rel}`,
        kind: recognized ? 'manifest-file' : 'override',
        recognized,
        redactOptions: classified.redactOptions
      })
    }

    emit('plan', `共 ${entries.length} 个文件可用，正在生成清单…`, 0.15)

    const manifestFiles: ModpackManifestFile[] = []
    const packedFiles: { path: string; size: number }[] = []
    for (const entry of entries) {
      if (entry.kind === 'manifest-file' && entry.recognized && opts.format !== 'curseforge') {
        const file: ModpackManifestFile = {
          path: entry.relPath,
          fileSize: entry.recognized.size ?? entry.size,
          downloads: entry.recognized.url ? [entry.recognized.url] : undefined,
          hashes: entry.recognized.sha1 ? { sha1: entry.recognized.sha1 } : undefined,
          platform: { type: 'modrinth', projectId: entry.recognized.projectId, versionId: entry.recognized.versionId },
          targetDir: entry.relPath.includes('/') ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/')) : undefined
        }
        manifestFiles.push(file)
      } else {
        packedFiles.push({ path: entry.relPath, size: entry.size })
      }
    }

    const manifest: ModpackManifest = {
      format: opts.format === 'curseforge' ? 'curseforge' : opts.format === 'modrinth' ? 'modrinth' : 'mcal',
      name: opts.name,
      version: opts.version,
      author: opts.author,
      gameVersion: opts.gameVersion,
      loaderType: opts.loaderType,
      loaderVersion: opts.loaderVersion,
      files: manifestFiles,
      overridesDir: 'overrides',
      extra: { sourceKind: 'zip', exportedAt: new Date().toISOString(), exportedBy: 'MCAL' }
    }

    const packedBytes = packedFiles.reduce((acc, file) => acc + file.size, 0)
    const fileCount = packedFiles.length + 1

    /* ---- warnings ---- */
    if (sensitiveCount > 0) {
      warnings.push(`已排除 ${sensitiveCount} 项敏感文件（服务器列表 servers.dat / 账号缓存 usercache.json / 启动器会话数据等），不会随整合包分发。`)
    }
    if (redactedOptions) warnings.push('options.txt 保留但已剔除 lastServer（上次进入的服务器地址）。')
    if (disabledCount > 0) warnings.push(`跳过 ${disabledCount} 个被禁用的文件（*.disabled）。`)
    if (packedFiles.length > 3000) {
      warnings.push(
        `整合包包含 ${packedFiles.length} 个文件（>3000）：adm-zip 打包会把内容读入内存，写入可能较慢，建议精简资源包/光影后分批导出。`
      )
    }
    if (packedBytes > 2 * 1024 * 1024 * 1024) {
      warnings.push('待打包内容超过 2GB：请关闭 includeResourcePacks/includeShaderPacks 或排除大文件后重试，避免导出时占满内存。')
    }
    if (opts.format === 'curseforge') {
      warnings.push(
        'CurseForge 格式导出未做平台反查（从文件 hash 无法直接得到 projectID/fileID）：所有文件都打包进 overrides/，' +
          '若要在 CurseForge 上发布整合包，需要手动用平台的 manifest 工具重建 files 列表。'
      )
    }
    if (opts.format === 'modrinth' && manifestFiles.length === 0 && opts.recognized && Object.keys(opts.recognized).length > 0) {
      warnings.push('提供了 recognized 信息但没有匹配上任何文件，请确认键是「相对游戏目录的路径」（如 mods/sodium.jar）。')
    }
    if (manifestFiles.length > 0) {
      warnings.push(`有 ${manifestFiles.length} 个文件已识别为 Modrinth 项目：清单里只写下载地址与哈希，不再打包进 zip（导入时需要联网）。`)
    }
    if (!opts.gameVersion) warnings.push('未指定 gameVersion：导入方可能无法正确选择模组版本，建议在某实例上导出并自动带上版本。')
    if (excluded.length > entries.length) {
      log.debug(`排除 ${excluded.length} 个文件 / 保留 ${entries.length} 个`)
    }

    return {
      manifest,
      manifestJson: buildManifestJson(opts, manifest, manifestFiles),
      manifestEntryName: manifestEntryNameOf(opts.format),
      entries,
      excluded,
      sensitiveCount,
      redactedOptions,
      disabledCount,
      packedBytes,
      fileCount,
      warnings
    }
  }

  /** 读取 options.txt 并剔除 lastServer 行（保留其余设置） */
  private async readOptionsWithoutServer(absPath: string): Promise<string> {
    const buffer = await readFile(absPath)
    const { text } = decodeText(buffer)
    return text
      .split(/\r?\n/)
      .filter((line) => !/^\s*lastServer\s*:/i.test(line))
      .join('\n')
  }
}

/* ------------------------------------------------------------------ *
 *  清单（各格式的真实文件内容）
 * ------------------------------------------------------------------ */

export function manifestEntryNameOf(format: ExportOptions['format']): string {
  if (format === 'modrinth') return 'modrinth.index.json'
  if (format === 'curseforge') return 'manifest.json'
  return 'mcal-pack.json'
}

/** 生成写入 zip 的清单 JSON：Modrinth / CurseForge 用官方结构，mcal 用 ModpackManifest */
export function buildManifestJson(
  opts: ExportOptions,
  manifest: ModpackManifest,
  files: ModpackManifestFile[]
): unknown {
  if (opts.format === 'modrinth') {
    const dependencies: Record<string, string> = {}
    if (opts.gameVersion) dependencies.minecraft = opts.gameVersion
    if (opts.loaderType && opts.loaderVersion) {
      const key =
        opts.loaderType === 'fabric'
          ? 'fabric-loader'
          : opts.loaderType === 'quilt'
            ? 'quilt-loader'
            : opts.loaderType === 'neoforge'
              ? 'neoforge'
              : opts.loaderType === 'forge'
                ? 'forge'
                : opts.loaderType
      dependencies[key] = opts.loaderVersion
    }
    return {
      formatVersion: 1,
      game: 'minecraft',
      versionId: opts.version ?? '1.0.0',
      name: opts.name,
      summary: manifest.description ?? `由 MCAL 导出的整合包（${opts.name}）`,
      files: files.map((file) => ({
        path: file.path,
        hashes: file.hashes ?? {},
        downloads: file.downloads ?? [],
        fileSize: file.fileSize ?? 0,
        env: { client: file.optional ? 'optional' : 'required', server: 'required' }
      })),
      dependencies
    }
  }
  if (opts.format === 'curseforge') {
    const loaderSpec =
      opts.loaderType && opts.loaderType !== 'vanilla'
        ? [{ id: `${opts.loaderType === 'neoforge' ? 'neoforge' : opts.loaderType}-${opts.loaderVersion ?? ''}`.replace(/-$/, ''), primary: true }]
        : []
    return {
      manifestType: 'minecraftModpack',
      manifestVersion: 1,
      name: opts.name,
      version: opts.version ?? '1.0.0',
      author: opts.author ?? 'MCAL',
      description: `由 MCAL 导出（${opts.name}）`,
      minecraft: { version: opts.gameVersion ?? '', modLoaders: loaderSpec },
      files: [],
      overrides: 'overrides'
    }
  }
  // mcal：完整 ModpackManifest（含 files 的下载地址 / platform / hashes）
  return manifest
}

/* ------------------------------------------------------------------ *
 *  recognized 索引
 * ------------------------------------------------------------------ */

/** 把 recognized 的键归一化：支持绝对路径、相对路径（posix/反斜杠）、纯文件名 */
function buildRecognizedIndex(recognized?: Record<string, RecognizedPackFile>): Map<string, RecognizedPackFile> {
  const map = new Map<string, RecognizedPackFile>()
  if (!recognized) return map
  for (const [key, value] of Object.entries(recognized)) {
    if (!value) continue
    const normalized = normalizeRelPath(key)
    if (normalized.length > 0) map.set(normalized.toLowerCase(), value)
    map.set(normalized.toLowerCase().split('/').pop() ?? normalized.toLowerCase(), value)
    if (isAbsolute(key)) {
      const abs = normalizeRelPath(key).toLowerCase()
      map.set(abs, value)
    }
  }
  return map
}

function lookupRecognized(
  index: Map<string, RecognizedPackFile>,
  relPath: string,
  absPath: string
): RecognizedPackFile | undefined {
  if (index.size === 0) return undefined
  const rel = relPath.toLowerCase()
  const direct = index.get(rel)
  if (direct) return direct
  const byAbs = index.get(normalizeRelPath(absPath).toLowerCase())
  if (byAbs) return byAbs
  const name = rel.split('/').pop() ?? rel
  return index.get(name)
}

export default ModpackExporter
