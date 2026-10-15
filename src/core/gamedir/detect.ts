/**
 * 游戏目录（.minecraft）自动检测。
 *
 * 设计要点：
 *  - 候选位置按「官方启动器 / 第三方启动器 / 常见手动位置」分来源推导，只对真实存在的目录做探测；
 *  - 探测只读浅层标记（`versions/`、`launcher_profiles.json`、`assets/`），绝不递归扫整个目录
 *    （assets 可能有几十万文件）；体积只统计 `versions/` 与 `mods/` 两个子目录，并带超时与文件数上限；
 *  - 去重按路径归一化，同一个目录被多个来源命中时保留来源优先级更高的一个、label 取更具体的那个；
 *  - 注入 env 时只使用注入值并跳过真实盘符枚举，保证结果与运行环境（尤其测试机）无关；
 *  - 所有 IO 都包了 try/catch：单个位置探测失败只影响它自己，整体不抛错。
 */

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { GameDirCandidate, LoaderType } from '@shared/types'
import { dirSize, isDirectory, isFile, readJsonSafe } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { currentOs, mapConcurrent, normalizePathForCompare } from '@core/util/misc'

const log = logger.scoped('gamedir')

/** 候选目录的标准探测并发：同时打开几十上百个目录会让机械盘 / 网络盘非常难受 */
const PROBE_CONCURRENCY = 5
/** versions 列表最多列出的版本数（完整数量见 versionCount） */
const MAX_LISTED_VERSIONS = 20
/** 单次读取版本目录时的并发 */
const VERSION_CHECK_CONCURRENCY = 8
/** 体积统计最多统计的文件数，超出部分不再统计（避免在超大目录上卡住） */
const SIZE_SCAN_LIMIT = 150_000
/** 体积 / mtime 统计的总超时：拿不到就当 0，绝不拖住整个检测 */
const DEEP_TIMEOUT_MS = 8000
/** 盘符枚举范围：A/B 是软驱历史遗留，跳过 */
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'

const MARKER_VERSIONS = 'versions'
const MARKER_PROFILES = 'launcher_profiles.json'
const MARKER_ASSETS = 'assets'
const MARKER_MODS = 'mods'

/** loaders 输出的固定顺序，保证同一目录多次检测结果稳定 */
const LOADER_ORDER: LoaderType[] = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'optifine']

/** 纯原版版本号：1.20.1 / 1.21 / 1.20.1-pre1 / 24w14a */
const VANILLA_ID_RE = /^(?:\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z])$/i

/**
 * 去重时的来源优先级。
 * 任务约定约束了 official > thirdparty > common；manual 是用户显式指定的路径，
 * 放在最前，避免用户指路的目录被自动扫描结果「吞掉」。
 */
const SOURCE_PRIORITY: Record<GameDirCandidate['source'], number> = {
  manual: 4,
  official: 3,
  thirdparty: 2,
  common: 1
}

export interface DetectGameDirOptions {
  /** 已知的游戏目录（settings.gameDirs），用于标记 added */
  known?: { path: string }[]
  /** 手动补充的搜索根（例如用户指定） */
  extraRoots?: string[]
  /** 是否做耗时统计（目录大小 / 最近修改时间）。默认 true */
  deep?: boolean
  /** 中止信号：中止后不再启动新的探测，已探测到的结果照常返回（不抛错） */
  signal?: AbortSignal
  /** 便于测试注入：覆盖环境变量推导出的路径 */
  env?: {
    home?: string
    appData?: string // Windows %APPDATA%
    localAppData?: string // Windows %LOCALAPPDATA%
    userProfile?: string
  }
}

/* ------------------------------------------------------------------ *
 *  内部结构
 * ------------------------------------------------------------------ */

/** 一个待探测的候选根 */
interface CandidateRoot {
  path: string
  source: GameDirCandidate['source']
  label: string
  /** 标签具体度：0=裸路径、1=启动器名、2=实例 / 配置里的具体目录；越大越具体 */
  labelRank: number
}

/** 探测上下文 */
interface ProbeContext {
  deep: boolean
  known: Set<string>
}

interface ProbedRoot {
  candidate: GameDirCandidate
  labelRank: number
}

/* ------------------------------------------------------------------ *
 *  环境推导
 * ------------------------------------------------------------------ */

interface ResolvedEnv {
  home?: string
  appData?: string
  localAppData?: string
  userProfile?: string
  /** 调用方是否显式注入过环境（注入模式下不读取真实环境变量，也不枚举真实盘符） */
  injected: boolean
}

function cleanPath(value?: string): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * 解析环境路径。
 * 只要注入了任意一个字段，就完全只使用注入值（缺失的字段按标准布局从注入的 home 推导），
 * 避免测试结果里混入运行测试的机器上真实的 .minecraft。
 */
function resolveEnv(raw?: DetectGameDirOptions['env']): ResolvedEnv {
  const injected = Boolean(raw && (raw.home || raw.appData || raw.localAppData || raw.userProfile))
  if (injected) {
    const home = cleanPath(raw?.home)
    return {
      home,
      appData: cleanPath(raw?.appData) ?? (home ? join(home, 'AppData', 'Roaming') : undefined),
      localAppData: cleanPath(raw?.localAppData) ?? (home ? join(home, 'AppData', 'Local') : undefined),
      userProfile: cleanPath(raw?.userProfile) ?? home,
      injected: true
    }
  }
  const home = homedir()
  return {
    home,
    appData: cleanPath(process.env.APPDATA),
    localAppData: cleanPath(process.env.LOCALAPPDATA),
    userProfile: cleanPath(process.env.USERPROFILE) ?? home,
    injected: false
  }
}

/* ------------------------------------------------------------------ *
 *  版本 / 加载器解析
 * ------------------------------------------------------------------ */

/** 版本 id → 加载器（大小写不敏感的子串规则；neoforge 必须先于 forge 判断，否则会双重命中） */
function loadersOfVersionId(versionId: string): LoaderType[] {
  const id = (versionId ?? '').trim()
  if (!id) return []
  const lower = id.toLowerCase()
  const out: LoaderType[] = []
  if (lower.includes('fabric')) out.push('fabric')
  if (lower.includes('quilt')) out.push('quilt')
  if (lower.includes('neoforge')) out.push('neoforge')
  else if (lower.includes('forge')) out.push('forge')
  // OptiFine 的两种命名：含 optifine，或独立的 OF 段（1.20.1-OF / 1.20.1-forge-OF）
  if (lower.includes('optifine') || /(^|[^a-z0-9])of([^a-z0-9]|$)/i.test(id)) out.push('optifine')
  // 纯原版版本号才计 vanilla：有加载器痕迹的 id 不重复计入
  if (out.length === 0 && VANILLA_ID_RE.test(id)) out.push('vanilla')
  return out
}

function collectLoaders(ids: string[]): LoaderType[] {
  const found = new Set<LoaderType>()
  for (const id of ids) {
    for (const loader of loadersOfVersionId(id)) found.add(loader)
  }
  return LOADER_ORDER.filter((loader) => found.has(loader))
}

/**
 * 列出已安装的版本 id。
 * 只有 `versions/<id>/<id>.json` 存在才算安装完成（HMCL / 官方启动器的同款判定），
 * 返回按目录名升序排序的全部 id。
 */
async function listInstalledVersions(versionsDir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(versionsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const ids = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
  const checked = await mapConcurrent(ids, VERSION_CHECK_CONCURRENCY, async (id) =>
    (await isFile(join(versionsDir, id, `${id}.json`))) ? id : null
  )
  return checked.filter((id): id is string => id !== null).sort(compareStrings)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/* ------------------------------------------------------------------ *
 *  探测
 * ------------------------------------------------------------------ */

/**
 * 统计游戏目录体积。
 * 只统计 versions / mods：assets 与 libraries 可能有几十万文件，
 * 全量递归既慢又会把磁盘打满，对「这个目录有多大」的展示意义也不大。
 */
async function measureGameDirSize(dir: string): Promise<number> {
  const work = (async (): Promise<number> => {
    let total = 0
    for (const name of [MARKER_VERSIONS, MARKER_MODS]) {
      try {
        total += await dirSize(join(dir, name), SIZE_SCAN_LIMIT)
      } catch {
        /* 单个子目录统计失败不影响另一个 */
      }
    }
    return total
  })()
  return withTimeout(work, DEEP_TIMEOUT_MS, 0)
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((settle) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      settle(fallback)
    }, ms)
    void promise
      .catch(() => fallback)
      .then((value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        settle(value)
      })
  })
}

/** versions 目录的 mtime（ISO），取不到返回 undefined */
async function versionsMtime(versionsDir: string): Promise<string | undefined> {
  try {
    const info = await stat(versionsDir)
    return Number.isFinite(info.mtimeMs) ? info.mtime.toISOString() : undefined
  } catch {
    return undefined
  }
}

/** 组装候选（假设目录已存在；目录不存在时返回 valid=false 的空候选，不抛错） */
async function buildCandidate(root: CandidateRoot, ctx: ProbeContext): Promise<GameDirCandidate> {
  const dir = root.path
  const candidate: GameDirCandidate = {
    path: dir,
    label: root.label,
    source: root.source,
    added: ctx.known.has(normalizePathForCompare(dir)),
    valid: false,
    versions: [],
    loaders: [],
    versionCount: 0,
    sizeBytes: 0
  }

  const versionsDir = join(dir, MARKER_VERSIONS)
  const hasVersions = await isDirectory(versionsDir)
  const hasProfiles = await isFile(join(dir, MARKER_PROFILES))
  const hasAssets = await isDirectory(join(dir, MARKER_ASSETS))
  candidate.valid = hasVersions || hasProfiles || hasAssets

  if (hasVersions) {
    const ids = await listInstalledVersions(versionsDir)
    candidate.versionCount = ids.length
    candidate.versions = ids.slice(0, MAX_LISTED_VERSIONS)
    candidate.loaders = collectLoaders(ids)
  }

  if (ctx.deep) {
    candidate.sizeBytes = await measureGameDirSize(dir)
    candidate.lastModified = await versionsMtime(versionsDir)
  }

  return candidate
}

/** 探测一个候选根：目录不存在（或探测出错）返回 null，由调用方丢弃 */
async function probeRoot(root: CandidateRoot, ctx: ProbeContext): Promise<GameDirCandidate | null> {
  try {
    if (!(await isDirectory(root.path))) return null
    return await buildCandidate(root, ctx)
  } catch (err) {
    log.debug(`探测失败（已跳过）：${root.path} —— ${errorText(err)}`)
    return null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ *
 *  候选位置推导
 * ------------------------------------------------------------------ */

/** 读取 `%APPDATA%\.minecraft\launcher_profiles.json` 里用户自定义的 gameDir */
async function readLauncherProfileDirs(officialDir: string): Promise<CandidateRoot[]> {
  const file = join(officialDir, MARKER_PROFILES)
  if (!(await isFile(file))) return []
  const data = await readJsonSafe<LauncherProfilesFile | null>(file, null)
  if (!data) return []
  const rawProfiles = data.profiles
  const profiles: LauncherProfileEntry[] = Array.isArray(rawProfiles) ? rawProfiles : Object.values(rawProfiles ?? {})
  const self = normalizePathForCompare(officialDir)
  const out: CandidateRoot[] = []
  for (const profile of profiles) {
    const raw = typeof profile?.gameDir === 'string' ? profile.gameDir.trim() : ''
    if (!raw) continue
    // launcher_profiles 里理论上存绝对路径；相对路径按 .minecraft 目录展开
    const dir = isAbsolute(raw) ? resolve(raw) : resolve(officialDir, raw)
    // 指向默认目录本身的不重复登记：默认候选已经覆盖它，profile 名反而没有信息量
    if (normalizePathForCompare(dir) === self) continue
    const name = typeof profile.name === 'string' ? profile.name.trim() : ''
    out.push({
      path: dir,
      source: 'official',
      label: name ? `官方启动器 · ${name}` : '官方启动器 · 自定义位置',
      labelRank: 2
    })
  }
  return out
}

interface LauncherProfileEntry {
  name?: string
  gameDir?: string
}

interface LauncherProfilesFile {
  profiles?: Record<string, LauncherProfileEntry> | LauncherProfileEntry[]
}

/** 实例目录 → 真正的游戏目录：优先 `<实例>/.minecraft`、其次 `<实例>/minecraft`，都没有就用实例目录本身 */
async function resolveInstanceGameDir(instanceDir: string): Promise<string> {
  const dotted = join(instanceDir, '.minecraft')
  if (await isDirectory(dotted)) return dotted
  const plain = join(instanceDir, 'minecraft')
  if (await isDirectory(plain)) return plain
  return instanceDir
}

/** 展开 `<启动器>/instances/*`（或 profiles/*）：每个实例目录算一个候选 */
async function expandInstanceRoots(
  base: string,
  labelPrefix: string,
  source: GameDirCandidate['source']
): Promise<CandidateRoot[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out: CandidateRoot[] = []
  for (const entry of entries) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('.')) continue
    const instanceDir = join(base, entry.name)
    out.push({
      path: await resolveInstanceGameDir(instanceDir),
      source,
      label: `${labelPrefix} · ${entry.name} 实例`,
      labelRank: 2
    })
  }
  return out
}

/**
 * 常见手动位置：每个已挂载盘符下的 `\Minecraft\.minecraft`、`\.minecraft`、`\Games\.minecraft`。
 * 只检查这些固定路径是否存在，不做任何递归扫描；共享盘 / 网络盘上不存在时会很快失败。
 */
async function collectDriveRoots(): Promise<CandidateRoot[]> {
  const out: CandidateRoot[] = []
  for (const letter of DRIVE_LETTERS) {
    const driveRoot = `${letter}:\\`
    if (!(await isDirectory(driveRoot))) continue
    for (const relative of [join('Minecraft', '.minecraft'), '.minecraft', join('Games', '.minecraft')]) {
      const dir = join(driveRoot, relative)
      out.push({ path: dir, source: 'common', label: dir, labelRank: 0 })
    }
  }
  return out
}

/**
 * 收集并去重候选根。
 * 同一路径只保留一个待探测项：来源优先级更高者胜出，label 取更具体的那个。
 */
async function collectRoots(env: ResolvedEnv, extraRoots: string[]): Promise<CandidateRoot[]> {
  const os = currentOs()
  const specs: CandidateRoot[] = []
  const officialDirs: string[] = []
  const instanceBases: { base: string; labelPrefix: string; source: GameDirCandidate['source'] }[] = []

  const addSpec = (dir: string, source: GameDirCandidate['source'], label: string, labelRank: number): void => {
    if (!dir) return
    specs.push({ path: resolve(dir), source, label, labelRank })
  }
  const addOfficial = (dir: string, label: string): void => {
    if (!dir) return
    addSpec(dir, 'official', label, 1)
    officialDirs.push(resolve(dir))
  }
  const addInstances = (base: string, labelPrefix: string): void => {
    if (!base) return
    instanceBases.push({ base, labelPrefix, source: 'thirdparty' })
  }

  /* ---------- 官方启动器 ---------- */
  if (env.appData) addOfficial(join(env.appData, '.minecraft'), '官方启动器 · .minecraft')
  // Microsoft Store 版启动器：把 .minecraft 放在 LocalCache 里
  if (env.localAppData) {
    addOfficial(
      join(env.localAppData, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Roaming', '.minecraft'),
      '官方启动器 · Microsoft Store'
    )
  }
  if (env.home && os === 'osx') {
    addOfficial(join(env.home, 'Library', 'Application Support', 'minecraft'), '官方启动器 · minecraft')
  }
  if (env.home && os === 'linux') {
    addOfficial(join(env.home, '.minecraft'), '官方启动器 · .minecraft')
  }
  // 注入 env 时额外按「用户目录下的 .minecraft」探测，让跨平台 fixture 的结果可预期
  if (env.injected && env.home && os !== 'linux') {
    addOfficial(join(env.home, '.minecraft'), '官方启动器 · .minecraft')
  }

  /* ---------- HMCL ---------- */
  if (env.appData) addSpec(join(env.appData, 'HMCL', '.minecraft'), 'thirdparty', 'HMCL', 1)
  if (env.home) addSpec(join(env.home, '.hmcl', '.minecraft'), 'thirdparty', 'HMCL', 1)

  /* ---------- PCL / PCL2 ---------- */
  if (env.appData) addSpec(join(env.appData, 'PCL', '.minecraft'), 'thirdparty', 'PCL2', 1)
  if (env.userProfile) addSpec(join(env.userProfile, 'PCL', '.minecraft'), 'thirdparty', 'PCL2', 1)

  /* ---------- BakaXL ---------- */
  if (env.appData) addSpec(join(env.appData, 'BakaXL', '.minecraft'), 'thirdparty', 'BakaXL', 1)

  /* ---------- PrismLauncher / MultiMC（每个实例一个候选） ---------- */
  if (env.appData) {
    addInstances(join(env.appData, 'PrismLauncher', 'instances'), 'PrismLauncher')
    addInstances(join(env.appData, 'MultiMC', 'instances'), 'MultiMC')
  }
  if (env.home && os === 'osx') {
    addInstances(join(env.home, 'Library', 'Application Support', 'PrismLauncher', 'instances'), 'PrismLauncher')
    addInstances(join(env.home, 'Library', 'Application Support', 'MultiMC', 'instances'), 'MultiMC')
  }
  if (env.home && os === 'linux') {
    addInstances(join(env.home, '.local', 'share', 'PrismLauncher', 'instances'), 'PrismLauncher')
    addInstances(join(env.home, '.local', 'share', 'multimc', 'instances'), 'MultiMC')
    // Flatpak 版 PrismLauncher
    addInstances(join(env.home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances'), 'PrismLauncher')
  }

  /* ---------- CurseForge ---------- */
  if (env.userProfile) addInstances(join(env.userProfile, 'curseforge', 'minecraft', 'Instances'), 'CurseForge')
  if (env.home && os === 'osx') {
    addInstances(join(env.home, 'Documents', 'curseforge', 'minecraft', 'Instances'), 'CurseForge')
  }

  /* ---------- Modrinth App（Theseus） ---------- */
  if (env.appData) addInstances(join(env.appData, 'com.modrinth.theseus', 'profiles'), 'Modrinth App')
  if (env.home && os === 'osx') {
    addInstances(join(env.home, 'Library', 'Application Support', 'com.modrinth.theseus', 'profiles'), 'Modrinth App')
  }
  if (env.home && os === 'linux') {
    addInstances(join(env.home, '.local', 'share', 'com.modrinth.theseus', 'profiles'), 'Modrinth App')
    addInstances(join(env.home, '.var', 'app', 'com.modrinth.theseus', 'data', 'com.modrinth.theseus', 'profiles'), 'Modrinth App')
  }

  /* ---------- 常见手动位置 ---------- */
  // Windows：枚举 C-Z 盘符下的固定路径；注入 env（测试）时跳过，避免混入真实机器的目录
  if (os === 'windows' && !env.injected) specs.push(...(await collectDriveRoots()))
  if (env.home && (os !== 'windows' || env.injected)) {
    for (const relative of [join('Minecraft', '.minecraft'), join('Games', '.minecraft')]) {
      const dir = join(env.home, relative)
      addSpec(dir, 'common', dir, 0)
    }
  }

  /* ---------- 官方启动器配置里的自定义 gameDir ---------- */
  const profileSpecs: CandidateRoot[] = []
  for (const officialDir of officialDirs) {
    profileSpecs.push(...(await readLauncherProfileDirs(officialDir)))
  }

  /* ---------- 用户手动补充的搜索根 ---------- */
  for (const raw of extraRoots) {
    const trimmed = raw?.trim()
    if (!trimmed) continue
    const absolute = resolve(trimmed)
    specs.push({ path: absolute, source: 'manual', label: absolute, labelRank: 0 })
  }

  /* ---------- 实例目录展开 ---------- */
  const instanceSpecs: CandidateRoot[] = []
  for (const item of instanceBases) {
    instanceSpecs.push(...(await expandInstanceRoots(item.base, item.labelPrefix, item.source)))
  }

  /* ---------- 同一路径只探测一次 ---------- */
  const byPath = new Map<string, CandidateRoot>()
  for (const spec of [...specs, ...instanceSpecs, ...profileSpecs]) {
    const key = normalizePathForCompare(spec.path)
    const existing = byPath.get(key)
    byPath.set(key, existing ? mergeRootSpecs(existing, spec) : spec)
  }
  return [...byPath.values()]
}

/** 合并指向同一路径的两个候选根：来源取优先级更高者，label 取更具体者 */
function mergeRootSpecs(a: CandidateRoot, b: CandidateRoot): CandidateRoot {
  const priorityA = SOURCE_PRIORITY[a.source]
  const priorityB = SOURCE_PRIORITY[b.source]
  let winner: CandidateRoot
  if (priorityA !== priorityB) winner = priorityA > priorityB ? a : b
  else winner = a.labelRank >= b.labelRank ? a : b
  const label = pickMoreSpecificLabel(a.label, a.labelRank, b.label, b.labelRank)
  return { ...winner, label, labelRank: Math.max(a.labelRank, b.labelRank) }
}

/** label 谁更具体：先看具体度，再看长度，最后字典序（保证结果稳定） */
function pickMoreSpecificLabel(labelA: string, rankA: number, labelB: string, rankB: number): string {
  if (rankA !== rankB) return rankA > rankB ? labelA : labelB
  if (labelA.length !== labelB.length) return labelA.length > labelB.length ? labelA : labelB
  return labelA.localeCompare(labelB) <= 0 ? labelA : labelB
}

/* ------------------------------------------------------------------ *
 *  已知目录 / 结果合并与排序
 * ------------------------------------------------------------------ */

function buildKnownSet(known?: { path: string }[]): Set<string> {
  const set = new Set<string>()
  for (const item of known ?? []) {
    const raw = typeof item?.path === 'string' ? item.path.trim() : ''
    if (!raw) continue
    set.add(normalizePathForCompare(resolve(raw)))
  }
  return set
}

/** 合并同一个路径的多个探测结果（正常情况内容一致，这里做防御性合并） */
function mergeCandidates(a: ProbedRoot, b: ProbedRoot): ProbedRoot {
  const winner = SOURCE_PRIORITY[a.candidate.source] >= SOURCE_PRIORITY[b.candidate.source] ? a : b
  const other = winner === a ? b : a
  const label = pickMoreSpecificLabel(a.candidate.label, a.labelRank, b.candidate.label, b.labelRank)
  const richerVersions =
    winner.candidate.versions.length >= other.candidate.versions.length ? winner.candidate.versions : other.candidate.versions
  const loaderSet = new Set<LoaderType>([...winner.candidate.loaders, ...other.candidate.loaders])
  return {
    labelRank: Math.max(a.labelRank, b.labelRank),
    candidate: {
      path: winner.candidate.path,
      label,
      source: winner.candidate.source,
      added: winner.candidate.added || other.candidate.added,
      valid: winner.candidate.valid || other.candidate.valid,
      versions: richerVersions,
      loaders: LOADER_ORDER.filter((loader) => loaderSet.has(loader)),
      versionCount: Math.max(winner.candidate.versionCount, other.candidate.versionCount),
      sizeBytes: Math.max(winner.candidate.sizeBytes, other.candidate.sizeBytes),
      lastModified: winner.candidate.lastModified ?? other.candidate.lastModified
    }
  }
}

/** 排序：来源优先级 → versionCount 降序 → 路径 */
function compareCandidates(a: GameDirCandidate, b: GameDirCandidate): number {
  const priority = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
  if (priority !== 0) return priority
  if (a.versionCount !== b.versionCount) return b.versionCount - a.versionCount
  return a.path.localeCompare(b.path)
}

function mergeAndSort(items: ProbedRoot[]): GameDirCandidate[] {
  const byPath = new Map<string, ProbedRoot>()
  for (const item of items) {
    const key = normalizePathForCompare(item.candidate.path)
    const existing = byPath.get(key)
    byPath.set(key, existing ? mergeCandidates(existing, item) : item)
  }
  return [...byPath.values()].map((item) => item.candidate).sort(compareCandidates)
}

/* ------------------------------------------------------------------ *
 *  对外 API
 * ------------------------------------------------------------------ */

/**
 * 自动检测本机可能存在的游戏目录。
 * 返回的候选只包含「目录真实存在」的位置（可能存在但不像游戏目录的，valid=false），
 * 已按来源优先级与版本数量排序；任何内部失败都不会抛出，最坏情况返回空数组。
 */
export async function detectGameDirs(options: DetectGameDirOptions = {}): Promise<GameDirCandidate[]> {
  try {
    const deep = options.deep !== false
    const env = resolveEnv(options.env)
    const roots = await collectRoots(env, options.extraRoots ?? [])
    const ctx: ProbeContext = { deep, known: buildKnownSet(options.known) }
    const probed = await mapConcurrent(roots, PROBE_CONCURRENCY, async (root) => {
      // 中止后只返回已完成的部分，不再启动新的探测
      if (options.signal?.aborted) return null
      const candidate = await probeRoot(root, ctx)
      return candidate ? { candidate, labelRank: root.labelRank } : null
    })
    const found = probed.filter((item): item is ProbedRoot => item !== null)
    const merged = mergeAndSort(found)
    log.debug(`游戏目录检测完成：命中 ${merged.length} 个候选（共检查 ${roots.length} 个位置）`)
    return merged
  } catch (err) {
    log.warn(`游戏目录检测失败：${errorText(err)}`)
    return []
  }
}

/**
 * 探测单个目录（用户在 UI 里手选目录时使用）。
 * 目录不存在或探测失败都会返回一个 valid=false 的候选，而不是抛错；
 * 因为没有来源信息，source 记为 manual、label 直接用路径。
 */
export async function probeGameDir(
  dir: string,
  opts: { deep?: boolean; known?: { path: string }[] } = {}
): Promise<GameDirCandidate> {
  const absolute = resolve(dir)
  const ctx: ProbeContext = { deep: opts.deep !== false, known: buildKnownSet(opts.known) }
  const meta: CandidateRoot = { path: absolute, source: 'manual', label: absolute, labelRank: 0 }
  try {
    return await buildCandidate(meta, ctx)
  } catch (err) {
    log.debug(`探测游戏目录失败：${absolute} —— ${errorText(err)}`)
    return {
      path: absolute,
      label: absolute,
      source: 'manual',
      added: ctx.known.has(normalizePathForCompare(absolute)),
      valid: false,
      versions: [],
      loaders: [],
      versionCount: 0,
      sizeBytes: 0
    }
  }
}

/**
 * 快速判断一个目录是否像游戏目录：有 `versions/`，或有 `launcher_profiles.json`，
 * 或有 `assets/`（只做三次存在性检查，不读版本列表）。
 */
export async function isLikelyGameDir(dir: string): Promise<boolean> {
  try {
    const absolute = resolve(dir)
    if (!(await isDirectory(absolute))) return false
    if (await isDirectory(join(absolute, MARKER_VERSIONS))) return true
    if (await isFile(join(absolute, MARKER_PROFILES))) return true
    return isDirectory(join(absolute, MARKER_ASSETS))
  } catch {
    return false
  }
}
