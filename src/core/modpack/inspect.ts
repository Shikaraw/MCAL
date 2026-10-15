/**
 * 整合包格式识别与解析
 *
 * 支持四种主流格式（以及它们的常见变体）：
 *  1. Modrinth `.mrpack`：根 `modrinth.index.json` + `overrides/`；
 *  2. CurseForge：根 `manifest.json`（`minecraft.version` / `modLoaders` / `files[projectID,fileID]`）；
 *  3. MultiMC / Prism（MMC）：`instance.cfg`（INI 子集）+ `mmc-pack.json`（components uid/version）+ `minecraft/`；
 *  4. HMCL / MCBBS：根 `mcbbs.packmeta` 或 HMCL 自有 `manifest.json`（`addons` + `files`）；
 *  5. MCAL 自有：`mcal-pack.json`（完整 ModpackManifest，支持无损往返）。
 *
 * 安全：所有 zip 条目路径都做穿越校验（`..`、绝对路径、盘符、NUL），命中直接拒绝。
 */

import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import type { LoaderType, ModpackManifest, ModpackManifestFile } from '@shared/types'
import type { HttpClient } from '@core/net/http'
import { isDirectory, isFile, readJsonSafe, readTextSmart, sha1Short } from '@core/util/fsx'

/* ------------------------------------------------------------------ *
 *  公共类型
 * ------------------------------------------------------------------ */

export type ModpackFormatId = 'mcal' | 'curseforge' | 'modrinth' | 'mmc' | 'unknown'

export interface InspectResult {
  manifest: ModpackManifest
  warnings: string[]
  /** 内容根目录：zip 时为 zip 文件路径，目录时为整合包根目录（含 overrides 的那一层） */
  root: string
}

/** 整合包根目录里可能出现的清单文件名（用于目录/zip 的根定位） */
const MANIFEST_NAMES = ['mcal-pack.json', 'modrinth.index.json', 'manifest.json', 'mcbbs.packmeta', 'mmc-pack.json', 'instance.cfg']

/** 各加载器在 Modrinth dependencies / 依赖键里的写法（精确匹配优先，避免 neoforge 被当成 forge） */
const DEPENDENCY_LOADER_KEYS: { keys: string[]; loaderType: LoaderType }[] = [
  { keys: ['fabric-loader', 'fabric'], loaderType: 'fabric' },
  { keys: ['quilt-loader', 'quilt'], loaderType: 'quilt' },
  { keys: ['neoforge'], loaderType: 'neoforge' },
  { keys: ['forge'], loaderType: 'forge' },
  { keys: ['liteloader'], loaderType: 'liteloader' },
  { keys: ['optifine'], loaderType: 'optifine' }
]

/** 常见的内容子目录（用于从 Modrinth 的 path 推断 targetDir） */
const KNOWN_TARGET_DIRS = new Set([
  'mods',
  'resourcepacks',
  'shaderpacks',
  'datapacks',
  'config',
  'defaultconfigs',
  'plugins',
  'saves'
])

/* ------------------------------------------------------------------ *
 *  路径安全
 * ------------------------------------------------------------------ */

/** zip 条目名归一化：统一分隔符、去掉前导 ./ 与 / */
export function normalizeArchivePath(name: string): string {
  let value = (name ?? '').replace(/\\/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  value = value.replace(/^\/+/, '')
  return value
}

/**
 * 校验 zip 条目路径安全：拒绝绝对路径、盘符、`..` 穿越、NUL 字节。
 * 越界时抛错，而不是静默跳过。
 * 注意：绝对路径检查必须在归一化之前做（归一化会去掉前导 `/`）。
 */
export function assertSafeZipEntry(entryName: string): void {
  const name = entryName ?? ''
  if (name.includes('\u0000')) throw new Error(`整合包条目含非法字符（NUL）：${JSON.stringify(name)}`)
  const slashed = name.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(slashed)) throw new Error(`整合包条目使用绝对路径（盘符），已拒绝：${entryName}`)
  if (slashed.startsWith('/') || slashed.startsWith('//')) {
    throw new Error(`整合包条目使用绝对路径，已拒绝：${entryName}`)
  }
  const normalized = normalizeArchivePath(name)
  if (normalized.length === 0) return
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`整合包条目试图穿越目录（..），已拒绝：${entryName}`)
  }
}

/** 把整合包内的相对路径解析到 root 之下；越界抛错（zip 与目录统一入口） */
export function safeResolveInside(root: string, relPath: string): string {
  assertSafeZipEntry(relPath)
  const absRoot = resolve(root)
  const normalized = normalizeArchivePath(relPath)
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  const target = resolve(absRoot, ...segments)
  const rel = relative(absRoot, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`整合包路径越界：${relPath}（根目录 ${root}）`)
  }
  return target
}

/** 打开 zip（损坏时给出可读错误） */
export function openZipArchive(path: string): AdmZip {
  try {
    return new AdmZip(path)
  } catch (err) {
    throw new Error(`无法读取整合包 zip（文件可能损坏或不完整）：${path}：${(err as Error).message}`)
  }
}

/** 在 zip 条目名里定位整合包根前缀（很多包会多套一层目录） */
export function detectArchiveRootPrefix(names: string[]): string {
  const normalized = new Set(names.map((name) => normalizeArchivePath(name)))
  for (const name of MANIFEST_NAMES) {
    if (normalized.has(name)) return ''
  }
  const prefixes = new Set<string>()
  for (const name of normalized) {
    const parts = name.split('/')
    // 只考虑最多 3 层的候选前缀（MyPack/ 或 a/b/ 之类）
    for (let i = 1; i < Math.min(parts.length, 4); i++) {
      prefixes.add(`${parts.slice(0, i).join('/')}/`)
    }
  }
  const sorted = [...prefixes].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  for (const prefix of sorted) {
    for (const name of MANIFEST_NAMES) {
      if (normalized.has(prefix + name)) return prefix
    }
  }
  return ''
}

/* ------------------------------------------------------------------ *
 *  INI 解析（MultiMC / Prism 的 instance.cfg）
 * ------------------------------------------------------------------ */

/**
 * 自写 INI 子集解析器（MultiMC 的 instance.cfg 是 `key=value` 的 INI）。
 * 支持：[section]、`;`/`#` 注释、`key=value`、值里的 `=`、行尾空白、重复键后写覆盖。
 */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = ''
  out[section] = {}
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith(';') || line.startsWith('#')) continue
    const sectionMatch = /^\[(.+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1].trim()
      if (!out[section]) out[section] = {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key.length === 0) continue
    out[section][key] = value
  }
  return out
}

/** 从 instance.cfg 读取指定键（按 section 名 `General` 优先，找不到就在所有 section 里找） */
export function readIniValue(ini: Record<string, Record<string, string>>, key: string): string | undefined {
  const general = ini['General'] ?? ini[''] ?? {}
  if (general[key] !== undefined) return general[key]
  for (const section of Object.values(ini)) {
    if (section[key] !== undefined) return section[key]
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 *  各种清单的解析（纯函数，便于测试）
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

function loaderFromDependencyKey(key: string): LoaderType | undefined {
  const lower = (key ?? '').trim().toLowerCase()
  if (!lower) return undefined
  for (const item of DEPENDENCY_LOADER_KEYS) {
    if (item.keys.includes(lower)) return item.loaderType
  }
  // 兼容带包名前缀的写法（如 net.fabricmc.fabric-loader）；endsWith 不会把 neoforge 误判成 forge
  for (const item of DEPENDENCY_LOADER_KEYS) {
    if (item.keys.some((candidate) => lower.endsWith(candidate))) return item.loaderType
  }
  return undefined
}

/** 从 CurseForge/HMCL 的 `forge-47.2.0` 形式解析加载器 */
export function parseLoaderSpec(spec: string): { loaderType?: LoaderType; loaderVersion?: string } {
  const value = (spec ?? '').trim()
  if (!value) return {}
  const patterns: { re: RegExp; loaderType: LoaderType }[] = [
    { re: /^neoforge[-_]?(.*)$/i, loaderType: 'neoforge' },
    { re: /^forge[-_]?(.*)$/i, loaderType: 'forge' },
    { re: /^fabric(?:-loader)?[-_]?(.*)$/i, loaderType: 'fabric' },
    { re: /^quilt(?:-loader)?[-_]?(.*)$/i, loaderType: 'quilt' },
    { re: /^liteloader[-_]?(.*)$/i, loaderType: 'liteloader' },
    { re: /^optifine[-_]?(.*)$/i, loaderType: 'optifine' },
    { re: /^vanilla$/i, loaderType: 'vanilla' }
  ]
  for (const pattern of patterns) {
    const match = pattern.re.exec(value)
    if (match) {
      const version = (match[1] ?? '').trim().length > 0 ? match[1].trim() : undefined
      return { loaderType: pattern.loaderType, loaderVersion: version }
    }
  }
  return {}
}

/* ------------------------------ Modrinth ------------------------------ */

/** 解析 `modrinth.index.json`（支持官方 dependencies 写法与 game/loaders 变体） */
export function parseModrinthIndex(json: unknown, warnings: string[] = []): ModpackManifest {
  const record = asRecord(json)
  if (!record) throw new Error('modrinth.index.json 不是合法的 JSON 对象')
  const formatVersion = asNumber(record.formatVersion)
  if (formatVersion !== undefined && formatVersion !== 1) {
    warnings.push(`modrinth.index.json 的 formatVersion=${formatVersion} 不是 1，可能不被支持。`)
  }

  const dependencies = asRecord(record.dependencies) ?? {}
  let loaderType: LoaderType | undefined
  let loaderVersion: string | undefined
  let gameVersion = asString(dependencies.minecraft)

  for (const [key, value] of Object.entries(dependencies)) {
    const mapped = loaderFromDependencyKey(key)
    if (mapped) {
      loaderType = mapped
      loaderVersion = asString(value)
    }
  }

  // 变体：`game: { version, loaders: [{ id, version }] }`
  const game = asRecord(record.game)
  if (game) {
    gameVersion = gameVersion ?? asString(game.version)
    for (const item of asArray(game.loaders)) {
      const loader = asRecord(item)
      if (!loader) continue
      const mapped = loaderFromDependencyKey(asString(loader.id) ?? '')
      if (mapped) {
        loaderType = loaderType ?? mapped
        loaderVersion = loaderVersion ?? asString(loader.version)
      }
    }
  }
  if (!loaderType && asString(record.game) && asString(record.game) !== 'minecraft') {
    warnings.push(`未识别的 game 字段：${asString(record.game)}`)
  }

  const files: ModpackManifestFile[] = []
  let unsupported = 0
  for (const item of asArray(record.files)) {
    const file = asRecord(item)
    if (!file) continue
    const path = asString(file.path)
    if (!path) {
      warnings.push('modrinth.index.json 里有一条 files 缺少 path，已跳过。')
      continue
    }
    try {
      assertSafeZipEntry(path)
    } catch (err) {
      throw new Error(`modrinth.index.json 的 files.path 非法：${(err as Error).message}`)
    }
    const env = asRecord(file.env) ?? {}
    const clientEnv = (asString(env.client) ?? 'required').toLowerCase()
    if (clientEnv === 'unsupported') {
      unsupported++
      continue
    }
    const downloads = asArray(file.downloads)
      .map((url) => asString(url))
      .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url))
    const hashes: Record<string, string> = {}
    const rawHashes = asRecord(file.hashes) ?? {}
    for (const [algo, value] of Object.entries(rawHashes)) {
      const hash = asString(value)
      if (hash) hashes[algo.toLowerCase()] = hash.toLowerCase()
    }
    const firstSegment = normalizeArchivePath(path).split('/')[0]
    files.push({
      path: normalizeArchivePath(path),
      hashes: Object.keys(hashes).length > 0 ? hashes : undefined,
      downloads: downloads.length > 0 ? downloads : undefined,
      fileSize: asNumber(file.fileSize) ?? asNumber(file.size),
      optional: clientEnv === 'optional' ? true : undefined,
      targetDir: KNOWN_TARGET_DIRS.has(firstSegment) ? firstSegment : undefined
    })
  }
  if (unsupported > 0) warnings.push(`该整合包声明有 ${unsupported} 个文件不支持客户端（env.client=unsupported），已跳过。`)

  const overrides = ['overrides', 'client-overrides']
  return {
    format: 'modrinth',
    name: asString(record.name) ?? '未命名整合包',
    version: asString(record.versionId),
    description: asString(record.summary),
    gameVersion,
    loaderType,
    loaderVersion,
    files,
    overridesDir: overrides.join(','),
    extra: {
      sourceKind: 'zip',
      modrinthFormatVersion: formatVersion ?? 1,
      overridesDirs: overrides,
      versionId: asString(record.versionId)
    }
  }
}

/* ------------------------------ CurseForge ------------------------------ */

/**
 * 解析 CurseForge `manifest.json`。
 * 注意：CurseForge 的文件必须通过官方 API（需要 API Key）获取，
 * 这里只写 platform 定位信息（projectID/fileID），downloads 留空。
 */
export function parseCurseForgeManifest(json: unknown, warnings: string[] = []): ModpackManifest {
  const record = asRecord(json)
  if (!record) throw new Error('manifest.json 不是合法的 JSON 对象')
  const minecraft = asRecord(record.minecraft) ?? {}
  const gameVersion = asString(minecraft.version)

  let loaderType: LoaderType | undefined
  let loaderVersion: string | undefined
  const modLoaders = asArray(minecraft.modLoaders)
  for (const item of modLoaders) {
    const loader = asRecord(item)
    if (!loader) continue
    const id = asString(loader.id)
    if (!id) continue
    const primary = loader.primary === true
    const parsed = parseLoaderSpec(id)
    if (!parsed.loaderType) continue
    if (!loaderType || primary) {
      loaderType = parsed.loaderType
      loaderVersion = parsed.loaderVersion
    }
    if (primary) break
  }

  const files: ModpackManifestFile[] = []
  for (const item of asArray(record.files)) {
    const file = asRecord(item)
    if (!file) continue
    const projectID = asNumber(file.projectID) ?? asNumber(file.projectId)
    const fileID = asNumber(file.fileID) ?? asNumber(file.fileId)
    if (projectID === undefined || fileID === undefined) continue
    const displayName = asString(file.displayName) ?? asString(file.fileName)
    const fileName = displayName && /\.jar$/i.test(displayName) ? displayName : `cf-${projectID}-${fileID}.jar`
    files.push({
      path: `mods/${fileName}`,
      optional: file.required === false ? true : undefined,
      targetDir: 'mods',
      platform: { type: 'curseforge', projectId: String(projectID), versionId: String(fileID) }
    })
  }

  const overridesDir = asString(record.overrides) ?? 'overrides'
  if (files.length > 0) {
    warnings.push(
      `该整合包是 CurseForge 格式：CurseForge 官方不允许第三方直接下载文件，需要 CurseForge API Key，或手动下载 ${files.length} 个文件` +
        `（清单里的 projectID/fileID 可用于在 CurseForge 上精确定位版本）。`
    )
  }
  return {
    format: 'curseforge',
    name: asString(record.name) ?? '未命名整合包',
    version: asString(record.version),
    author: asString(record.author),
    description: asString(record.description),
    gameVersion,
    loaderType,
    loaderVersion,
    files,
    overridesDir,
    extra: {
      sourceKind: 'zip',
      manifestType: asString(record.manifestType),
      manifestVersion: asNumber(record.manifestVersion),
      overridesDirs: [overridesDir]
    }
  }
}

/* ------------------------------ MultiMC / Prism ------------------------------ */

const MMC_COMPONENT_MAP: { re: RegExp; loaderType: LoaderType }[] = [
  { re: /^net\.minecraftforge$/i, loaderType: 'forge' },
  { re: /^net\.neoforged(?:\.forge)?$/i, loaderType: 'neoforge' },
  { re: /^net\.fabricmc\.fabric-loader$/i, loaderType: 'fabric' },
  { re: /^org\.quiltmc\.quilt-loader$/i, loaderType: 'quilt' },
  { re: /(?:liteloader|com\.mumfrey\.liteloader)/i, loaderType: 'liteloader' },
  { re: /optifine/i, loaderType: 'optifine' }
]

/** 解析 MMC 的 `mmc-pack.json` + `instance.cfg` */
export function parseMmcPack(opts: {
  packJson: unknown
  instanceCfg?: string | null
  /** 实例目录里是否存在 minecraft/（游戏目录） */
  hasMinecraftDir?: boolean
  hasDotMinecraftDir?: boolean
  fallbackName?: string
  warnings?: string[]
}): ModpackManifest {
  const warnings = opts.warnings ?? []
  const record = asRecord(opts.packJson)
  if (!record) throw new Error('mmc-pack.json 不是合法的 JSON 对象')
  const components = asArray(record.components)

  let gameVersion: string | undefined
  let loaderType: LoaderType | undefined
  let loaderVersion: string | undefined
  const componentList: { uid: string; version?: string }[] = []

  for (const item of components) {
    const component = asRecord(item)
    if (!component) continue
    const uid = asString(component.uid)
    if (!uid) continue
    const version = asString(component.version)
    componentList.push({ uid, version })
    if (/^net\.minecraft$/i.test(uid)) {
      gameVersion = version
      continue
    }
    for (const map of MMC_COMPONENT_MAP) {
      if (map.re.test(uid)) {
        loaderType = map.loaderType
        loaderVersion = version
        break
      }
    }
  }

  const ini = opts.instanceCfg ? parseIni(opts.instanceCfg) : {}
  const iniName = readIniValue(ini, 'name')
  const maxMem = readIniValue(ini, 'MaxMemAlloc') ?? readIniValue(ini, 'MaxMemAllocMB')
  const minMem = readIniValue(ini, 'MinMemAlloc')
  const instanceType = readIniValue(ini, 'InstanceType')
  const javaPath = readIniValue(ini, 'JavaPath')

  let overridesDir: string | undefined
  if (opts.hasMinecraftDir) overridesDir = 'minecraft'
  else if (opts.hasDotMinecraftDir) overridesDir = '.minecraft'
  if (!overridesDir) warnings.push('MMC 实例里没有找到 minecraft/ 目录，导入时不会有覆盖文件被复制。')

  if (loaderType && loaderVersion) {
    warnings.push(`该整合包要求安装加载器 ${loaderType} ${loaderVersion}（导入后需调用 LoaderManager 安装）。`)
  } else if (loaderType) {
    warnings.push(`该整合包要求安装加载器 ${loaderType}（版本未知，导入后需安装加载器）。`)
  } else if (!gameVersion) {
    warnings.push('mmc-pack.json 里没有解析到 Minecraft 版本，请手动确认。')
  }

  return {
    format: 'mmc',
    name: iniName ?? opts.fallbackName ?? 'MMC 实例',
    description: instanceType ? `MultiMC 实例类型：${instanceType}` : undefined,
    gameVersion,
    loaderType,
    loaderVersion,
    files: [],
    overridesDir,
    extra: {
      sourceKind: 'directory',
      components: componentList,
      maxMemAlloc: maxMem ? Number.parseInt(maxMem, 10) : undefined,
      minMemAlloc: minMem ? Number.parseInt(minMem, 10) : undefined,
      javaPath: javaPath ?? undefined
    }
  }
}

/* ------------------------------ HMCL / MCBBS ------------------------------ */

/**
 * 解析 HMCL 自有 / MCBBS 格式：
 * `{ name, version, author, description, addons:[{id,version}], files:[{path,hash,url?,force?}|{type:'curse',projectID,fileID,fileName,url}], settings }`
 */
export function parseHmclManifest(json: unknown, warnings: string[] = []): ModpackManifest {
  const record = asRecord(json)
  if (!record) throw new Error('HMCL 清单不是合法的 JSON 对象')
  const addons = asArray(record.addons)
  let gameVersion: string | undefined
  let loaderType: LoaderType | undefined
  let loaderVersion: string | undefined

  for (const item of addons) {
    const addon = asRecord(item)
    if (!addon) continue
    const id = (asString(addon.id) ?? '').toLowerCase()
    const version = asString(addon.version)
    if (!id) continue
    if (/^(game|minecraft)$/.test(id)) {
      gameVersion = version
      continue
    }
    if (id.includes('neoforge')) {
      loaderType = 'neoforge'
      loaderVersion = version
      continue
    }
    if (id.includes('forge')) {
      loaderType = 'forge'
      loaderVersion = version
      continue
    }
    if (id.includes('quilt')) {
      loaderType = 'quilt'
      loaderVersion = version
      continue
    }
    if (id.includes('fabric')) {
      loaderType = 'fabric'
      loaderVersion = version
      continue
    }
    if (id.includes('liteloader')) {
      loaderType = 'liteloader'
      loaderVersion = version
      continue
    }
    if (id.includes('optifine')) {
      loaderType = 'optifine'
      loaderVersion = version
    }
  }

  const files: ModpackManifestFile[] = []
  let manualCount = 0
  for (const item of asArray(record.files)) {
    const file = asRecord(item)
    if (!file) continue
    const type = (asString(file.type) ?? 'addon').toLowerCase()
    const force = file.force === true || file.required !== false
    if (type === 'curse' || file.projectID !== undefined) {
      const projectID = asNumber(file.projectID)
      const fileID = asNumber(file.fileID)
      const fileName = asString(file.fileName) ?? (projectID !== undefined && fileID !== undefined ? `cf-${projectID}-${fileID}.jar` : 'unknown.jar')
      const url = asString(file.url)
      files.push({
        path: `mods/${fileName}`,
        downloads: url && /^https?:\/\//i.test(url) ? [url] : undefined,
        optional: force ? undefined : true,
        targetDir: 'mods',
        platform:
          projectID !== undefined && fileID !== undefined
            ? { type: 'curseforge', projectId: String(projectID), versionId: String(fileID) }
            : undefined
      })
      if (!url) manualCount++
      continue
    }
    const path = asString(file.path)
    if (!path) continue
    try {
      assertSafeZipEntry(path)
    } catch (err) {
      throw new Error(`HMCL 清单里的 path 非法：${(err as Error).message}`)
    }
    const hash = asString(file.hash)
    const url = asString(file.url)
    const normalized = normalizeArchivePath(path)
    const firstSegment = normalized.split('/')[0]
    files.push({
      path: normalized,
      hashes: hash ? { sha1: hash.toLowerCase() } : undefined,
      downloads: url && /^https?:\/\//i.test(url) ? [url] : undefined,
      optional: force ? undefined : true,
      targetDir: KNOWN_TARGET_DIRS.has(firstSegment) ? firstSegment : undefined
    })
  }

  if (manualCount > 0) {
    warnings.push(`HMCL 清单里有 ${manualCount} 个 CurseForge 文件没有直链，需要 CurseForge API Key 或手动下载。`)
  }
  const settings = asRecord(record.settings)
  if (settings) {
    if (settings.install_mods === false) warnings.push('清单声明不安装 mods（settings.install_mods=false）。')
    if (settings.install_resourcepack === false) warnings.push('清单声明不安装资源包（settings.install_resourcepack=false）。')
  }

  return {
    format: 'mcal',
    name: asString(record.name) ?? 'HMCL 整合包',
    version: asString(record.version),
    author: asString(record.author),
    description: asString(record.description),
    gameVersion,
    loaderType,
    loaderVersion,
    files,
    overridesDir: 'overrides',
    extra: {
      sourceKind: 'zip',
      hmcl: true,
      manifestType: asString(record.manifestType),
      fileApi: asString(record.fileApi),
      forceUpdate: record.forceUpdate === true,
      overridesDirs: ['overrides']
    }
  }
}

/** 解析 MCAL 自有 `mcal-pack.json`（完整 ModpackManifest） */
export function parseMcalManifest(json: unknown, warnings: string[] = []): ModpackManifest {
  const record = asRecord(json)
  if (!record) throw new Error('mcal-pack.json 不是合法的 JSON 对象')
  const files: ModpackManifestFile[] = []
  for (const item of asArray(record.files)) {
    const file = asRecord(item)
    if (!file) continue
    const path = asString(file.path)
    if (!path) continue
    assertSafeZipEntry(path)
    const hashes = asRecord(file.hashes)
    const hashMap: Record<string, string> = {}
    if (hashes) {
      for (const [algo, value] of Object.entries(hashes)) {
        const hash = asString(value)
        if (hash) hashMap[algo.toLowerCase()] = hash.toLowerCase()
      }
    }
    const platform = asRecord(file.platform)
    const platformType = asString(platform?.type)
    files.push({
      path: normalizeArchivePath(path),
      hashes: Object.keys(hashMap).length > 0 ? hashMap : undefined,
      downloads: asArray(file.downloads)
        .map((url) => asString(url))
        .filter((url): url is string => typeof url === 'string' && url.length > 0),
      fileSize: asNumber(file.fileSize),
      optional: file.optional === true ? true : undefined,
      targetDir: asString(file.targetDir),
      platform:
        platformType === 'modrinth' || platformType === 'curseforge'
          ? {
              type: platformType,
              projectId: asString(platform?.projectId) ?? '',
              versionId: asString(platform?.versionId) ?? ''
            }
          : undefined
    })
  }
  const overridesDir = asString(record.overridesDir) ?? 'overrides'
  const format = asString(record.format)
  if (format && format !== 'mcal') {
    warnings.push(`mcal-pack.json 声明的 format=${format}，按 MCAL 格式处理。`)
  }
  return {
    format: 'mcal',
    name: asString(record.name) ?? '未命名整合包',
    version: asString(record.version),
    author: asString(record.author),
    description: asString(record.description),
    gameVersion: asString(record.gameVersion),
    loaderType: (asString(record.loaderType) as LoaderType | undefined) ?? undefined,
    loaderVersion: asString(record.loaderVersion),
    files,
    overridesDir,
    extra: {
      sourceKind: 'zip',
      originalExtra: asRecord(record.extra) ?? undefined,
      overridesDirs: [overridesDir]
    }
  }
}

/* ------------------------------------------------------------------ *
 *  目录形态解析辅助
 * ------------------------------------------------------------------ */

/** 目录是否像一个游戏目录（.minecraft 等价物） */
async function looksLikeGameDir(dir: string): Promise<boolean> {
  for (const marker of ['mods', 'config', 'versions', 'resourcepacks', 'shaderpacks', 'options.txt', 'saves', 'logs']) {
    if (await isFile(join(dir, marker))) return true
    if (await isDirectory(join(dir, marker))) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 *  ModpackInspector
 * ------------------------------------------------------------------ */

export class ModpackInspector {
  /** 需要网络时为后续扩展预留（当前所有清单解析都是纯本地） */
  protected readonly client: HttpClient

  constructor(opts: { client: HttpClient }) {
    this.client = opts.client
  }

  /** 支持：zip 文件、目录、.mrpack（Modrinth）、CurseForge 整合包 zip、MMC/HMCL 的整合包目录 */
  async inspect(opts: { file?: string; dir?: string }): Promise<InspectResult> {
    if (opts.file) return this.inspectFile(opts.file)
    if (opts.dir) return this.inspectDir(opts.dir)
    throw new Error('inspect 需要提供 file 或 dir 之一')
  }

  /** 只识别格式，不返回完整清单 */
  async detectFormat(opts: { file?: string; dir?: string }): Promise<ModpackFormatId> {
    const result = await this.inspect(opts)
    return result.manifest.format
  }

  /* ------------------------------ zip ------------------------------ */

  private async inspectFile(file: string): Promise<InspectResult> {
    if (!(await isFile(file))) throw new Error(`整合包文件不存在：${file}`)
    const info = await stat(file)
    if (info.size === 0) throw new Error(`整合包文件是空的（0 字节）：${file}`)
    const zip = openZipArchive(file)
    const allEntries = zip.getEntries()
    const entryMap = new Map<string, AdmZip.IZipEntry>()
    for (const entry of allEntries) {
      const name = normalizeArchivePath(entry.entryName)
      if (name.length === 0) continue
      // 穿越/绝对路径直接拒绝（zip slip 防护）
      assertSafeZipEntry(entry.entryName)
      if (entry.isDirectory) continue
      if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue
      entryMap.set(name, entry)
    }
    if (entryMap.size === 0) throw new Error(`整合包 zip 里没有任何文件：${file}`)

    const names = [...entryMap.keys()]
    const prefix = detectArchiveRootPrefix(names)
    const warnings: string[] = []
    if (prefix) warnings.push(`zip 内含顶层目录「${prefix.replace(/\/$/, '')}」，已自动识别为整合包根目录。`)

    const rel = (name: string): string => `${prefix}${name}`
    const readJson = (name: string): unknown | undefined => {
      const entry = entryMap.get(rel(name))
      if (!entry) return undefined
      try {
        return JSON.parse(zip.readAsText(entry))
      } catch (err) {
        warnings.push(`${name} 不是合法 JSON：${(err as Error).message}`)
        return undefined
      }
    }
    const readText = (name: string): string | undefined => {
      const entry = entryMap.get(rel(name))
      if (!entry) return undefined
      try {
        return zip.readAsText(entry)
      } catch {
        return undefined
      }
    }

    // 1) MCAL 自有
    const mcal = readJson('mcal-pack.json')
    if (mcal !== undefined) {
      const manifest = parseMcalManifest(mcal, warnings)
      return this.finish(manifest, warnings, file, prefix, entryMap)
    }

    // 2) Modrinth
    const modrinth = readJson('modrinth.index.json')
    if (modrinth !== undefined) {
      const manifest = parseModrinthIndex(modrinth, warnings)
      return this.finish(manifest, warnings, file, prefix, entryMap)
    }

    // 3) MCBBS / HMCL（mcbbs.packmeta 没有 .json 后缀）
    const mcbbsText = readText('mcbbs.packmeta')
    if (mcbbsText !== undefined) {
      try {
        const manifest = parseHmclManifest(JSON.parse(mcbbsText), warnings)
        return this.finish(manifest, warnings, file, prefix, entryMap)
      } catch (err) {
        warnings.push(`mcbbs.packmeta 解析失败：${(err as Error).message}`)
      }
    }

    // 4) manifest.json → CurseForge 或 HMCL 自有
    const manifestJson = readJson('manifest.json')
    if (manifestJson !== undefined) {
      const record = asRecord(manifestJson)
      if (record && asRecord(record.minecraft)) {
        const manifest = parseCurseForgeManifest(manifestJson, warnings)
        return this.finish(manifest, warnings, file, prefix, entryMap)
      }
      if (record && (Array.isArray(record.addons) || asString(record.manifestType) === 'minecraftModpack')) {
        const manifest = parseHmclManifest(manifestJson, warnings)
        return this.finish(manifest, warnings, file, prefix, entryMap)
      }
      warnings.push('manifest.json 既不是 CurseForge 也不是 HMCL 格式。')
    }

    // 5) MMC（zip 形态的实例导出）
    const mmcPack = readJson('mmc-pack.json')
    const instanceCfg = readText('instance.cfg')
    if (mmcPack !== undefined || instanceCfg !== undefined) {
      const hasMinecraftDir = names.some((name) => name.startsWith(rel('minecraft/')))
      const hasDotMinecraftDir = names.some((name) => name.startsWith(rel('.minecraft/')))
      const manifest = parseMmcPack({
        packJson: mmcPack ?? { components: [] },
        instanceCfg: instanceCfg ?? null,
        hasMinecraftDir,
        hasDotMinecraftDir,
        fallbackName: basename(file).replace(/\.(zip|mrpack)$/i, ''),
        warnings
      })
      return this.finish(manifest, warnings, file, prefix, entryMap)
    }

    // 6) 无法识别
    warnings.push('无法识别该 zip 的整合包格式；如果它只是游戏目录的压缩包，请解压后以目录形式导入。')
    return {
      manifest: {
        format: 'unknown',
        name: basename(file).replace(/\.(zip|mrpack)$/i, ''),
        files: [],
        extra: { sourceKind: 'zip' }
      },
      warnings,
      root: file
    }
  }

  /** 统一收尾：把 overrides 目录信息与统计写入 extra */
  private finish(
    manifest: ModpackManifest,
    warnings: string[],
    root: string,
    prefix: string,
    entryMap: Map<string, AdmZip.IZipEntry>
  ): InspectResult {
    const extra = { ...(manifest.extra ?? {}) }
    extra.sourceKind = 'zip'
    extra.rootPrefix = prefix

    const overridesDirs = overridesDirList(manifest)
    const counts: Record<string, number> = {}
    for (const dir of overridesDirs) {
      const dirPrefix = `${prefix}${dir.replace(/\/+$/, '')}/`
      let count = 0
      for (const name of entryMap.keys()) {
        if (name.startsWith(dirPrefix)) count++
      }
      counts[dir] = count
    }
    extra.overrideCounts = counts
    const overrideTotal = Object.values(counts).reduce((acc, value) => acc + value, 0)
    if (overrideTotal === 0 && manifest.files.length === 0 && manifest.format !== 'mmc') {
      warnings.push('整合包里既没有可下载文件、也没有 overrides 内容，导入后会得到一个空实例。')
    }
    if (manifest.files.length > 0) {
      const missingHashes = manifest.files.filter((file) => !file.downloads?.length && !file.platform).length
      if (missingHashes > 0) {
        warnings.push(`有 ${missingHashes} 个文件既没有下载地址也没有平台定位信息，导入时需要手动处理。`)
      }
    }
    manifest.extra = extra
    return { manifest, warnings, root }
  }

  /* ------------------------------ 目录 ------------------------------ */

  private async inspectDir(inputDir: string): Promise<InspectResult> {
    const dir = resolve(inputDir)
    if (!(await isDirectory(dir))) throw new Error(`整合包目录不存在：${dir}`)
    const warnings: string[] = []

    // 目录形态：含 .minecraft → 以之为根；含 minecraft/ + MMC 清单 → MMC
    const nestedDotMinecraft = join(dir, '.minecraft')
    const hasInstanceCfg = await isFile(join(dir, 'instance.cfg'))
    const hasMmcPack = await isFile(join(dir, 'mmc-pack.json'))

    // 1) MCAL 自有
    if (await isFile(join(dir, 'mcal-pack.json'))) {
      const json = await readJsonSafe<unknown>(join(dir, 'mcal-pack.json'), null)
      const manifest = parseMcalManifest(json, warnings)
      return this.finishDir(manifest, warnings, dir)
    }

    // 2) Modrinth（目录形态：解压后的 mrpack）
    if (await isFile(join(dir, 'modrinth.index.json'))) {
      const json = await readJsonSafe<unknown>(join(dir, 'modrinth.index.json'), null)
      const manifest = parseModrinthIndex(json, warnings)
      return this.finishDir(manifest, warnings, dir)
    }

    // 3) MMC（instance.cfg + mmc-pack.json）
    if (hasInstanceCfg || hasMmcPack) {
      const packJson = hasMmcPack ? await readJsonSafe<unknown>(join(dir, 'mmc-pack.json'), null) : { components: [] }
      const instanceCfg = hasInstanceCfg ? (await readTextSmart(join(dir, 'instance.cfg'))).text : null
      const manifest = parseMmcPack({
        packJson,
        instanceCfg,
        hasMinecraftDir: await isDirectory(join(dir, 'minecraft')),
        hasDotMinecraftDir: await isDirectory(nestedDotMinecraft),
        fallbackName: basename(dir),
        warnings
      })
      return this.finishDir(manifest, warnings, dir)
    }

    // 4) manifest.json → CurseForge / HMCL
    if (await isFile(join(dir, 'manifest.json'))) {
      const json = await readJsonSafe<unknown>(join(dir, 'manifest.json'), null)
      const record = asRecord(json)
      if (record && asRecord(record.minecraft)) {
        return this.finishDir(parseCurseForgeManifest(json, warnings), warnings, dir)
      }
      if (record && (Array.isArray(record.addons) || asString(record.manifestType) === 'minecraftModpack')) {
        return this.finishDir(parseHmclManifest(json, warnings), warnings, dir)
      }
      warnings.push('manifest.json 既不是 CurseForge 也不是 HMCL 格式。')
    }

    // 5) mcbbs.packmeta
    if (await isFile(join(dir, 'mcbbs.packmeta'))) {
      const text = (await readTextSmart(join(dir, 'mcbbs.packmeta'))).text
      return this.finishDir(parseHmclManifest(JSON.parse(text), warnings), warnings, dir)
    }

    // 6) 含 .minecraft 子目录 → 以它为根再识别一次
    if (await isDirectory(nestedDotMinecraft)) {
      const inner = await this.inspectDir(nestedDotMinecraft)
      inner.warnings.unshift(`目录里含 .minecraft 子目录，已将其作为游戏目录根（${nestedDotMinecraft}）。`)
      return inner
    }

    // 7) 普通游戏目录（HMCL 导出的文件夹形态 / 手动整理的整合包）
    if (await looksLikeGameDir(dir)) {
      warnings.push('按「目录型整合包」处理：所有文件将原样复制到目标游戏目录（跳过启动器清单文件）。')
      const manifest: ModpackManifest = {
        format: 'mcal',
        name: basename(dir),
        files: [],
        overridesDir: '.',
        extra: { sourceKind: 'directory', genericDirPack: true, overridesDirs: ['.'] }
      }
      return { manifest, warnings, root: dir }
    }

    warnings.push('无法识别该目录的整合包格式（缺少 mcal-pack.json / modrinth.index.json / manifest.json / mmc-pack.json，也不像游戏目录）。')
    return {
      manifest: {
        format: 'unknown',
        name: basename(dir),
        files: [],
        extra: { sourceKind: 'directory' }
      },
      warnings,
      root: dir
    }
  }

  private async finishDir(manifest: ModpackManifest, warnings: string[], dir: string): Promise<InspectResult> {
    const extra = { ...(manifest.extra ?? {}) }
    extra.sourceKind = 'directory'
    manifest.extra = extra
    // 目录形态的 overrides：确认目录存在，缺失时给出提示
    const dirs = overridesDirList(manifest)
    if (dirs.length > 0) {
      let found = 0
      for (const name of dirs) {
        if (await isDirectory(join(dir, name))) found++
      }
      extra.overrideCounts = { [dirs.join(',')]: found }
      if (found === 0 && manifest.files.length === 0) {
        warnings.push('目录里没有找到 overrides 内容，导入后实例可能缺少配置与模组。')
      }
    }
    return { manifest, warnings, root: dir }
  }
}

/* ------------------------------------------------------------------ *
 *  共享小工具
 * ------------------------------------------------------------------ */

/** 规范化 overridesDir：支持 'a,b' 与 extra.overridesDirs 数组 */
export function overridesDirList(manifest: ModpackManifest): string[] {
  const fromExtra = manifest.extra?.overridesDirs
  const list: string[] = []
  if (Array.isArray(fromExtra)) {
    for (const item of fromExtra) if (typeof item === 'string' && item.trim()) list.push(item.trim())
  }
  if (list.length === 0 && manifest.overridesDir) {
    for (const item of manifest.overridesDir.split(',')) {
      const value = item.trim()
      if (value) list.push(value)
    }
  }
  return [...new Set(list)]
}

/** 生成一个稳定的整合包 id（用于实例命名去重） */
export function packIdOf(manifest: ModpackManifest, source: string): string {
  return sha1Short(`${manifest.format}:${manifest.name}:${source}`, 8)
}
