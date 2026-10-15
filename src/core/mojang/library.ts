/**
 * 库（libraries）解析：坐标 → 磁盘路径 + 下载地址（含镜像与回退），以及 native 选择。
 *
 * 两种历史格式都要支持：
 *  1. 现代格式：lib.downloads.artifact / lib.downloads.classifiers 里有完整信息；
 *  2. 老格式（Forge 自建 maven、1.5 及以前的 vanilla json）：只有 name + 可选 url 字段，
 *     需要按 Maven 布局自己拼路径。
 *
 * native 的反直觉点：
 *  - 一个 native 库往往同时有「普通 artifact」（要进 classpath）和「classifier 包」（要解压），
 *    因此一个 lib 可能产出两个 ResolvedLibrary 条目（native 条目 + classpath 条目）；
 *  - 只有 downloads.classifiers 而没有 artifact 的库（例如 lwjgl 的纯 natives 条目）
 *    不进 classpath，只用于 natives 解压。
 */

import { join } from 'node:path'
import type { ArchName, DownloadItem, Library } from '@shared/types'
import { OFFICIAL_ENDPOINTS, fallbackMirrors, type MirrorResolver } from '@core/net/mirror'
import { logger } from '@core/util/logger'
import { mavenToPath, parseMavenName, type MavenCoordinate } from '@core/util/misc'
import { evaluateRules, type RuleContext } from './rules'

const log = logger.scoped('mojang:library')

/** 老格式库未给 url 时的默认仓库（Mojang 官方库仓库） */
const DEFAULT_LIBRARY_BASE = 'https://libraries.minecraft.net/'

export interface ResolvedLibrary {
  name: string
  /** 相对 libraries 目录的路径 */
  path: string
  /** 最终下载地址（已镜像解析） */
  url: string
  /** 备用地址 */
  fallbackUrls: string[]
  sha1?: string
  size?: number
  /** 绝对路径 */
  absolutePath: string
  /** 是否为 native 库 */
  isNative: boolean
  /** native 解压目标子目录名（例如 natives-windows） */
  nativeClassifier?: string
  extractExclude?: string[]
}

export interface ResolveLibraryOptions {
  librariesDir: string
  rules: RuleContext
  allowMirror?: boolean
  mirror?: MirrorResolver
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path}`
}

/**
 * 把库地址经镜像解析，并收集备用地址：
 * 镜像改写过就把原始官方地址作为回退；bmclapi 地址再补官方回退。
 */
function resolveMirroredUrl(url: string, opts: ResolveLibraryOptions): { url: string; fallbackUrls: string[] } {
  const original = url
  let resolved = url
  if (opts.allowMirror !== false && opts.mirror) {
    // Forge / NeoForge maven 走 forge scope，其余库（含 Mojang 官方库）走 mojang scope
    const scope =
      original.startsWith(OFFICIAL_ENDPOINTS.forgeMaven) || original.startsWith(OFFICIAL_ENDPOINTS.neoforgeMaven)
        ? 'forge'
        : 'mojang'
    resolved = opts.mirror.resolve(original, scope)
  }
  const fallbackUrls = new Set<string>()
  if (resolved !== original) fallbackUrls.add(original)
  for (const candidate of fallbackMirrors(resolved)) {
    if (candidate !== resolved) fallbackUrls.add(candidate)
  }
  return { url: resolved, fallbackUrls: [...fallbackUrls] }
}

function makeEntry(
  lib: Library,
  path: string,
  rawUrl: string,
  isNative: boolean,
  nativeClassifier: string | undefined,
  sha1: string | undefined,
  size: number | undefined,
  extractExclude: string[] | undefined,
  opts: ResolveLibraryOptions
): ResolvedLibrary {
  const { url, fallbackUrls } = resolveMirroredUrl(rawUrl, opts)
  return {
    name: lib.name,
    path,
    url,
    fallbackUrls,
    sha1,
    size,
    absolutePath: join(opts.librariesDir, path),
    isNative,
    nativeClassifier,
    extractExclude
  }
}

/** 当前平台对应的 native classifier。
 *
 * 解析顺序（从最可信到最尽力）：
 *  1. name 里已经带 classifier 时以 name 为准，避免拼出双 classifier；
 *  2. `natives` 映射：`lib.natives[osName].replace('${arch}', '64'|'32')`；
 *  3. 没有 natives 映射、只有 downloads.classifiers 的老库（Twitch 等第三方库）：
 *     按 `natives-<os>[-<bits>]` 的命名约定在 classifiers 的 key 里挑当前平台的条目。
 */
function nativeClassifierFor(lib: Library, coord: MavenCoordinate | null, ctx: RuleContext): string | null {
  if (coord?.classifier) return coord.classifier
  // osx 在 Mojang 的命名里有 osx / macos 两种写法（1.19+ 的部分条目改用 macos）
  const aliases = ctx.osName === 'osx' ? ['osx', 'macos'] : [ctx.osName]
  // natives 模板里的 ${arch} 只有 32/64 两种取值；arm64 属于 64 位
  const bits = ctx.arch === 'x64' || ctx.arch === 'arm64' ? '64' : '32'

  for (const osName of aliases) {
    const template = lib.natives?.[osName]
    if (template) return template.replace(/\$\{arch\}/g, bits) || null
  }

  const classifiers = lib.downloads?.classifiers
  if (!classifiers) return null
  const candidates = new Set<string>()
  for (const osName of aliases) {
    candidates.add(`natives-${osName}-${bits}`)
    candidates.add(`native-${osName}-${bits}`)
    candidates.add(`natives-${osName}`)
    candidates.add(`native-${osName}`)
    candidates.add(`${osName}-${bits}`)
  }
  if (ctx.arch === 'arm64') {
    for (const osName of aliases) {
      // arm64 平台的老库可能用 arm64 / aarch64 后缀
      candidates.add(`natives-${osName}-arm64`)
      candidates.add(`natives-${osName}-aarch64`)
    }
  }
  for (const candidate of candidates) {
    if (classifiers[candidate]) return candidate
  }
  return null
}

function buildNativeEntry(lib: Library, coord: MavenCoordinate | null, opts: ResolveLibraryOptions): ResolvedLibrary | null {
  const classifiers = lib.downloads?.classifiers
  const hasClassifiers = !!classifiers && Object.keys(classifiers).length > 0
  // 既没有 natives 映射也没有 classifiers 的库不是 native 库（普通 classpath 库）
  if (!lib.natives && !hasClassifiers) return null

  const classifier = nativeClassifierFor(lib, coord, opts.rules)
  if (!classifier) return null

  const fromDownloads = classifiers?.[classifier]
  if (fromDownloads) {
    const path = fromDownloads.path ?? (coord ? mavenToPath({ ...coord, classifier }) : null)
    if (!path) return null
    // 老 json 的 classifiers 条目偶尔缺 url：按 Maven 布局回退到 lib.url / 官方仓库
    const url = fromDownloads.url ?? joinUrl(lib.url ?? DEFAULT_LIBRARY_BASE, path)
    return makeEntry(lib, path, url, true, classifier, fromDownloads.sha1, fromDownloads.size, lib.extract?.exclude, opts)
  }
  // 明确给出了 classifiers 但没有当前平台的条目：说明该平台确实没有 native，不再猜测地址
  if (hasClassifiers) return null
  // 老格式：自己按 classifier 拼 Maven 路径
  if (!coord) return null
  const path = mavenToPath({ ...coord, classifier })
  return makeEntry(lib, path, joinUrl(lib.url ?? DEFAULT_LIBRARY_BASE, path), true, classifier, undefined, undefined, lib.extract?.exclude, opts)
}

function buildClasspathEntry(lib: Library, coord: MavenCoordinate | null, opts: ResolveLibraryOptions): ResolvedLibrary | null {
  const artifact = lib.downloads?.artifact
  if (artifact?.url) {
    const path = artifact.path ?? (coord ? mavenToPath(coord) : null)
    if (!path) return null
    return makeEntry(lib, path, artifact.url, false, undefined, artifact.sha1, artifact.size, undefined, opts)
  }
  const hasClassifiers = !!lib.downloads?.classifiers && Object.keys(lib.downloads.classifiers).length > 0
  if (hasClassifiers) {
    // 纯 natives 条目（无 artifact）：classpath 不包含它
    return null
  }
  // 老格式：只有 name (+ url)，classpath 用不带到 classifier 的坐标
  if (!coord) return null
  const path = mavenToPath({ ...coord, classifier: undefined })
  return makeEntry(lib, path, joinUrl(lib.url ?? DEFAULT_LIBRARY_BASE, path), false, undefined, undefined, undefined, undefined, opts)
}

/**
 * native classifier 里显式写出的目标架构。
 *
 * 为什么需要它：Mojang 从 1.21.9（LWJGL 3.4）起把 natives 拆成独立库条目
 * （`natives-windows` / `natives-windows-arm64` / `natives-windows-x86`），
 * 但规则里只判断了 `os.name`，**没有判断 os.arch**。照规则求值会把这些变体
 * 全部收下，在 x64 机器上同时下载并解压 x64 与 arm64 的 DLL —— 同名文件互相
 * 覆盖，最终解压出来的可能正好是加载不了的那一套。
 */
const ARCH_TOKEN_PATTERNS: { pattern: RegExp; arch: ArchName }[] = [
  { pattern: /(?:^|[-_.])(?:x86_64|x64|amd64)(?:$|[-_.])/, arch: 'x64' },
  { pattern: /(?:^|[-_.])(?:aarch64|arm64)(?:$|[-_.])/, arch: 'arm64' },
  { pattern: /(?:^|[-_.])(?:x86|i386|i686|ia32)(?:$|[-_.])/, arch: 'x86' },
  // 老约定：natives 模板 `${arch}` 展开成 32/64，如 natives-windows-64
  { pattern: /(?:^|[-_.])64(?:$|[-_.])/, arch: 'x64' },
  { pattern: /(?:^|[-_.])32(?:$|[-_.])/, arch: 'x86' }
]

/** 从 classifier 推出它面向的架构；推不出（如 `natives-windows`）返回 null */
export function classifierArch(classifier: string | null | undefined): ArchName | null {
  if (!classifier) return null
  const value = classifier.toLowerCase()
  for (const { pattern, arch } of ARCH_TOKEN_PATTERNS) {
    if (pattern.test(value)) return arch
  }
  return null
}

/** 该 classifier 是否适用于当前架构；没有架构信息时视为通用 */
function classifierArchUsable(classifier: string | null, ctx: RuleContext): boolean {
  const arch = classifierArch(classifier)
  if (!arch) return true
  // x64 的 native 在 arm64 上靠兼容层也能跑，其余必须精确匹配
  if (arch === 'x64') return ctx.arch === 'x64' || ctx.arch === 'arm64'
  return arch === ctx.arch
}

/** group:artifact（去掉版本与 classifier），用于把同一库的多个 natives 变体归组 */
function baseCoordOf(name: string): string {
  const coord = parseMavenName(name)
  if (!coord) return name
  return `${coord.group}:${coord.artifact}`
}

/** 内部：一个库可能产出 native + classpath 两个条目 */
function resolveLibraryEntries(lib: Library, opts: ResolveLibraryOptions): ResolvedLibrary[] {
  if (!lib?.name) return []
  // 平台规则不匹配 → 整个库跳过（返回 null 语义）
  if (!evaluateRules(lib.rules, opts.rules)) return []

  const coord = parseMavenName(lib.name)
  // 条目名里点名了别的架构（natives-windows-arm64 之流）→ 跳过
  if (!classifierArchUsable(coord?.classifier ?? null, opts.rules)) return []
  const entries: ResolvedLibrary[] = []
  const nativeEntry = buildNativeEntry(lib, coord, opts)
  if (nativeEntry) entries.push(nativeEntry)
  const classpathEntry = buildClasspathEntry(lib, coord, opts)
  if (classpathEntry) entries.push(classpathEntry)

  if (entries.length === 0 && !coord) log.debug(`无法解析库坐标，已跳过：${lib.name}`)
  return entries
}

/**
 * 解析单个库。native 库存在时返回 native 条目（isNative=true）；
 * 需要完整条目（native + classpath）时应使用 resolveLibraries。
 */
export function resolveLibrary(lib: Library, opts: ResolveLibraryOptions): ResolvedLibrary | null {
  return resolveLibraryEntries(lib, opts)[0] ?? null
}

export function resolveLibraries(libs: Library[] | undefined, opts: ResolveLibraryOptions): ResolvedLibrary[] {
  const out: ResolvedLibrary[] = []
  for (const lib of libs ?? []) out.push(...resolveLibraryEntries(lib, opts))

  // 收尾：同一坐标若同时存在「显式架构」与「无架构标注」（按惯例是 x64 基线）
  // 两种 natives，丢掉后者 —— 两个 jar 里的 DLL 同名，同时挂着必然有一个被挑错。
  // 例：x86 主机上 `natives-windows`(x64) 与 `natives-windows-x86` 只能留后者。
  const host = opts.rules.arch
  if (host === 'x64' || host === 'x86' || host === 'arm64') {
    const explicitBases = new Set<string>()
    for (const entry of out) {
      const classifier = parseMavenName(entry.name)?.classifier
      if (!classifier || !classifier.includes('natives')) continue
      if (classifierArch(classifier) === host) explicitBases.add(baseCoordOf(entry.name))
    }
    if (explicitBases.size > 0) {
      return out.filter((entry) => {
        const classifier = parseMavenName(entry.name)?.classifier
        const isGenericNative =
          !!classifier && classifier.includes('natives') && classifierArch(classifier) === null
        return !(isGenericNative && explicitBases.has(baseCoordOf(entry.name)))
      })
    }
  }
  return out
}

export function nativeLibraries(libs: ResolvedLibrary[]): ResolvedLibrary[] {
  return libs.filter((lib) => lib.isNative)
}

/** 把库列表转成 downloads 项，供下载器使用 */
export function libraryDownloadItems(libs: ResolvedLibrary[]): DownloadItem[] {
  return libs
    .filter((lib) => !!lib.url)
    .map((lib) => ({
      key: lib.path,
      url: lib.url,
      fallbackUrls: lib.fallbackUrls.length > 0 ? lib.fallbackUrls : undefined,
      dest: lib.absolutePath,
      sha1: lib.sha1,
      size: lib.size
    }))
}

/**
 * 去重键：版本号不参与（继承场景下子版本正是靠「同名不同版本」覆盖父库）。
 *
 * 纯 native 条目（有 natives 映射，或只有 classifiers 没有普通 artifact）
 * 必须把「平台变体」纳入键：1.19+ 的 vanilla json 里同一坐标会出现多条 native 条目
 * （windows / windows-arm64 / macos 各一条，靠 rules 区分）外加一条普通 artifact 条目；
 * 若只按 group:artifact 去重，除最后一条外的 native 变体会全部消失，
 * x64 机器很可能直接找不到可用 natives。普通 classpath 条目仍严格按 group:artifact 去重。
 */
function libraryDedupeKey(lib: Library): string {
  const coord = parseMavenName(lib.name)
  if (!coord) return `raw:${lib.name}`
  const base = coord.classifier
    ? `${coord.group}:${coord.artifact}:${coord.classifier}`
    : `${coord.group}:${coord.artifact}`
  const isNativeKind =
    !!lib.natives ||
    (!!lib.downloads?.classifiers && Object.keys(lib.downloads.classifiers).length > 0 && !lib.downloads.artifact?.url)
  if (!isNativeKind) return base
  return `${base}#natives:${JSON.stringify(lib.natives ?? null)}`
}

/**
 * 去重：同一 group:artifact 只保留一个，后出现的条目覆盖先出现的值，
 * 但保留它第一次出现的位置（父在前子在后时顺序稳定）。
 */
export function dedupeLibraries(libs: Library[]): Library[] {
  const result: Library[] = []
  const indexByKey = new Map<string, number>()
  for (const lib of libs) {
    const key = libraryDedupeKey(lib)
    const existing = indexByKey.get(key)
    if (existing !== undefined) {
      result[existing] = lib
    } else {
      indexByKey.set(key, result.length)
      result.push(lib)
    }
  }
  return result
}
