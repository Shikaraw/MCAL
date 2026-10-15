/**
 * 游戏内容元数据解析（纯本地读取，不联网）。
 *
 * 覆盖五类内容：
 *  - mod jar：fabric.mod.json / quilt.mod.json / META-INF/mods.toml / META-INF/neoforge.mods.toml / mcmod.info
 *  - 资源包：pack.mcmeta（pack_format / supported_formats / description）
 *  - 数据包：pack.mcmeta + data/ 目录；顺带识别「其实是存档」（含 level.dat）
 *  - 光影包：shaders/ 目录探测 + shaders.properties / iris.properties / *.fsh|*.vsh|*.glsl 语法判定
 *  - 存档：level.dat（gzip + NBT，只读 LevelName / DataVersion）
 *
 * 实现约束（协议依据）：
 *  - 只用 adm-zip，且「按需读取条目」，绝不整包解压（mod jar 常见 50MB+）；
 *  - TOML 子集解析器与 NBT 解析器全部自研，避免引入 npm 依赖；
 *  - 目录形态的内容包（资源包 / 光影 / 存档可以是不打包的文件夹）与 zip 共用同一套
 *    「相对路径条目表」抽象，因此同一份解析逻辑对两者都成立。
 */

import AdmZip from 'adm-zip'
import { gunzipSync } from 'node:zlib'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentKind, ContentMeta, ModEnvironment } from '@shared/types'
import { compareVersions } from '@core/util/misc'
import { decodeText, walkFiles } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('content:meta')

/* ------------------------------------------------------------------ *
 *  公共类型
 * ------------------------------------------------------------------ */

export interface ParsedContent {
  meta: ContentMeta
  warnings: string[]
  /** 解析到的主要元数据原文（截断），用于诊断展示 */
  raw?: string
}

/**
 * 附加解析结果。
 * 这些字段不属于 @shared/types 的 ContentMeta 契约（该契约是跨进程共享的），
 * 但又必须随元数据一起传给 ContentManager（例如 supported_formats），
 * 因此挂在一个约定键上，通过 getMetaExtra/setMetaExtra 访问。
 */
export interface ContentMetaExtra {
  /** 资源包/数据包 supported_formats 展开出的格式号（不含主 pack_format） */
  supportedFormats?: number[]
  /** 内容根目录前缀（zip 内只含一个顶层文件夹时是该文件夹名 + '/'） */
  rootPrefix?: string
  /** 存档 level.dat 信息 */
  levelName?: string
  dataVersion?: number
  /** 光影探测细节 */
  shader?: {
    /** 出现过的 #version 号 */
    glslVersions: number[]
    /** 是否只支持 Iris（含 RENDERTARGETS / #include / iris 专属 uniform / iris.properties） */
    irisOnly: boolean
    /** 是否 OptiFine 风格（shaders.properties / DRAWBUFFERS / GLSL 120） */
    optifineStyle: boolean
    hasShadersProperties: boolean
    hasIrisProperties: boolean
    /** 是否存在 shaders/ 目录 */
    hasShadersDir: boolean
  }
  /** 描述原文（可能是 translate 键） */
  rawDescription?: string
}

const EXTRA_KEY = 'mcalExtra'

export function setMetaExtra(meta: ContentMeta, extra: ContentMetaExtra): ContentMeta {
  ;(meta as unknown as Record<string, unknown>)[EXTRA_KEY] = extra
  return meta
}

export function getMetaExtra(meta?: ContentMeta): ContentMetaExtra | undefined {
  if (!meta) return undefined
  return (meta as unknown as Record<string, unknown>)[EXTRA_KEY] as ContentMetaExtra | undefined
}

/* ------------------------------------------------------------------ *
 *  MC 版本工具：已知发布版列表 + 版本约束解析
 * ------------------------------------------------------------------ */

/**
 * 已知的 MC 发布版列表（不是穷举，只覆盖本实现编写时确认过的发布版）。
 * 用途：把 mod 声明的版本范围「保守地」展开为具体版本；不在此列表中的版本不会出现，
 * 因此比列表更新的版本（1.21.6+ 之后的新版）不会被编造出来。
 */
export const KNOWN_GAME_VERSIONS: readonly string[] = [
  '1.6.1', '1.6.2', '1.6.4',
  '1.7.2', '1.7.3', '1.7.4', '1.7.5', '1.7.6', '1.7.7', '1.7.8', '1.7.9', '1.7.10',
  '1.8', '1.8.1', '1.8.2', '1.8.3', '1.8.4', '1.8.5', '1.8.6', '1.8.7', '1.8.8', '1.8.9',
  '1.9', '1.9.1', '1.9.2', '1.9.3', '1.9.4',
  '1.10', '1.10.1', '1.10.2',
  '1.11', '1.11.1', '1.11.2',
  '1.12', '1.12.1', '1.12.2',
  '1.13', '1.13.1', '1.13.2',
  '1.14', '1.14.1', '1.14.2', '1.14.3', '1.14.4',
  '1.15', '1.15.1', '1.15.2',
  '1.16', '1.16.1', '1.16.2', '1.16.3', '1.16.4', '1.16.5',
  '1.17', '1.17.1',
  '1.18', '1.18.1', '1.18.2',
  '1.19', '1.19.1', '1.19.2', '1.19.3', '1.19.4',
  '1.20', '1.20.1', '1.20.2', '1.20.3', '1.20.4', '1.20.5', '1.20.6',
  '1.21', '1.21.1', '1.21.2', '1.21.3', '1.21.4', '1.21.5'
]

export type VersionConstraintKind = 'any' | 'exact' | 'wildcard' | 'range'

export interface VersionConstraint {
  raw: string
  kind: VersionConstraintKind
  /** 判断某个具体版本是否满足该约束 */
  test(version: string): boolean
}

/** 解析单段比较器，例如 `>=1.20`、`~1.20.1`、`1.20.x`、`1.20.1` */
function parseComparator(token: string): { test: (v: string) => boolean; exact: boolean } | null {
  const t = token.trim()
  if (!t) return null
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(t)
  if (!m) return null
  const op = m[1] ?? '='
  const value = m[2].trim()
  if (!value) return null

  // 通配：1.20.x / 1.20.* / 1.x
  if (/[xX*]/.test(value)) {
    const parts = value.split('.')
    const fixed: number[] = []
    for (const p of parts) {
      if (/^\d+$/.test(p)) fixed.push(Number.parseInt(p, 10))
      else if (p === 'x' || p === 'X' || p === '*') break
      else return null
    }
    if (fixed.length === 0) return null
    const prefix = fixed.join('.')
    return {
      exact: false,
      test: (v) => v === prefix || v.startsWith(`${prefix}.`)
    }
  }

  // 波浪号：~1.20.1 → >=1.20.1 <1.21.0（npm 语义，Fabric 的 mod 也常用）
  if (op === '~' || op === '^') {
    const segs = value.split('.').map((s) => Number.parseInt(s, 10))
    if (segs.some((n) => !Number.isFinite(n))) return null
    const lower = value
    let upper: string
    if (op === '~') {
      const major = segs[0]
      const minor = segs.length > 1 ? segs[1] : 0
      upper = `${major}.${minor + 1}`
    } else {
      upper = `${segs[0] + 1}.0`
    }
    return {
      exact: false,
      test: (v) => compareVersions(v, lower) >= 0 && compareVersions(v, upper) < 0
    }
  }

  switch (op) {
    case '>=':
      return { exact: false, test: (v) => compareVersions(v, value) >= 0 }
    case '>':
      return { exact: false, test: (v) => compareVersions(v, value) > 0 }
    case '<=':
      return { exact: false, test: (v) => compareVersions(v, value) <= 0 }
    case '<':
      return { exact: false, test: (v) => compareVersions(v, value) < 0 }
    case '=':
    default:
      return { exact: true, test: (v) => compareVersions(v, value) === 0 }
  }
}

/** Maven 风格区间：[1.20,1.21) / [1.20] / (,1.21] / [1.20,) */
function parseMavenRange(text: string): VersionConstraint | null {
  const m = /^([\[(])\s*([^,\])]*?)\s*(?:,\s*([^,\])]*?)\s*)?([\])])$/.exec(text)
  if (!m) return null
  const lowerInclusive = m[1] === '['
  const lower = m[2] ?? ''
  const hasComma = text.includes(',')
  const upper = m[3] ?? ''
  const upperInclusive = m[4] === ']'

  if (!hasComma) {
    if (!lower) return null
    // [1.20] 表示精确匹配
    return { raw: text, kind: 'exact', test: (v) => compareVersions(v, lower) === 0 }
  }
  const tests: ((v: string) => boolean)[] = []
  if (lower) tests.push((v) => (lowerInclusive ? compareVersions(v, lower) >= 0 : compareVersions(v, lower) > 0))
  if (upper) tests.push((v) => (upperInclusive ? compareVersions(v, upper) <= 0 : compareVersions(v, upper) < 0))
  if (tests.length === 0) return null
  return { raw: text, kind: 'range', test: (v) => tests.every((t) => t(v)) }
}

/**
 * 解析版本约束表达式。支持：
 *  - `*`（任意）
 *  - Maven 区间 `[1.20,1.21)`、`[1.20]`、`[1.20,)`、`(,1.21]`
 *  - 比较器组 `>=1.20 <1.21`、`>=1.16`、`<1.21`（空格分隔按 AND 处理）
 *  - 波浪号/插入号 `~1.20.1`、`^1.20`
 *  - 通配 `1.20.x`、`1.20.*`、`1.x`
 *  - 精确 `1.20.1`
 * 无法识别时返回 null（调用方应保留原文，不要编造）。
 */
export function parseVersionConstraint(raw: string): VersionConstraint | null {
  const text = raw.trim()
  if (!text) return null
  if (text === '*' || text === 'x' || text === 'X') {
    return { raw: text, kind: 'any', test: () => true }
  }
  if (/^[\[(]/.test(text)) return parseMavenRange(text)

  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const tests: ((v: string) => boolean)[] = []
  let exact = false
  for (const token of tokens) {
    const parsed = parseComparator(token)
    if (!parsed) return null
    if (parsed.exact) exact = true
    tests.push(parsed.test)
  }
  const kind: VersionConstraintKind = exact && tests.length === 1 ? 'exact' : /[xX*]/.test(text) ? 'wildcard' : 'range'
  return { raw: text, kind, test: (v) => tests.every((t) => t(v)) }
}

/**
 * 把版本约束保守地展开为具体版本列表。
 * 返回 null 表示「不展开」：约束无法解析 / 是 `*` / 命中候选列表的所有条目（约束过宽，
 * 展开没有信息量）/ 命中为空（例如约束比已知列表更新）。此时调用方应保留范围原文。
 */
export function expandVersionRange(
  raw: string,
  candidates: readonly string[] = KNOWN_GAME_VERSIONS
): string[] | null {
  const constraint = parseVersionConstraint(raw)
  if (!constraint || constraint.kind === 'any') return null
  const hits = candidates.filter((v) => constraint.test(v))
  if (hits.length === 0 || hits.length >= candidates.length) return null
  return hits
}

/* ------------------------------------------------------------------ *
 *  pack_format → MC 版本对照表
 * ------------------------------------------------------------------ */

/**
 * 资源包/数据包 pack_format 表。
 * 数值来自 Minecraft Wiki 的「资源包版本 / 数据包版本」历史表，只写高置信度条目：
 * 不确定（尤其是比 1.21.5 更新的版本）一律不写，宁可让上层显示「未知」。
 *
 * 注意：资源包格式与数据包格式在 1.19.3 之前数值相同，之后开始分叉
 * （例如 1.20.3/1.20.4：资源包 22、数据包 26）。
 */
export interface PackFormatRange {
  format: number
  /** 起始版本（含） */
  from: string
  /** 结束版本（含） */
  to: string
  note?: string
}

export const RESOURCE_PACK_FORMAT_RANGES: readonly PackFormatRange[] = [
  { format: 1, from: '1.6.1', to: '1.8.9', note: '1.6.1 引入 pack.mcmeta' },
  { format: 2, from: '1.9', to: '1.10.2' },
  { format: 3, from: '1.11', to: '1.12.2' },
  { format: 4, from: '1.13', to: '1.14.4' },
  { format: 5, from: '1.15', to: '1.16.1' },
  { format: 6, from: '1.16.2', to: '1.16.5' },
  { format: 7, from: '1.17', to: '1.17.1' },
  { format: 8, from: '1.18', to: '1.18.2' },
  { format: 9, from: '1.19', to: '1.19.2' },
  { format: 12, from: '1.19.3', to: '1.19.3' },
  { format: 13, from: '1.19.4', to: '1.19.4' },
  { format: 15, from: '1.20', to: '1.20.1' },
  { format: 18, from: '1.20.2', to: '1.20.2', note: '1.20.2 起支持 supported_formats' },
  { format: 22, from: '1.20.3', to: '1.20.4' },
  { format: 32, from: '1.20.5', to: '1.20.6' },
  { format: 34, from: '1.21', to: '1.21.1' },
  { format: 42, from: '1.21.2', to: '1.21.3' },
  { format: 46, from: '1.21.4', to: '1.21.4' },
  { format: 55, from: '1.21.5', to: '1.21.5' }
]

export const DATAPACK_FORMAT_RANGES: readonly PackFormatRange[] = [
  { format: 4, from: '1.13', to: '1.14.4' },
  { format: 5, from: '1.15', to: '1.16.1' },
  { format: 6, from: '1.16.2', to: '1.16.5' },
  { format: 7, from: '1.17', to: '1.17.1' },
  { format: 8, from: '1.18', to: '1.18.2' },
  { format: 9, from: '1.19', to: '1.19.2' },
  { format: 10, from: '1.19.3', to: '1.19.3', note: '1.19.3 起数据包格式与资源包格式分叉' },
  { format: 12, from: '1.19.4', to: '1.19.4' },
  { format: 15, from: '1.20', to: '1.20.1' },
  { format: 18, from: '1.20.2', to: '1.20.2' },
  { format: 26, from: '1.20.3', to: '1.20.4' },
  { format: 41, from: '1.20.5', to: '1.20.6' },
  { format: 48, from: '1.21', to: '1.21.1' },
  { format: 57, from: '1.21.2', to: '1.21.3' },
  { format: 61, from: '1.21.4', to: '1.21.4' },
  { format: 71, from: '1.21.5', to: '1.21.5' }
]

export type PackFormatKind = 'resourcepack' | 'datapack'

function packRanges(kind: PackFormatKind): readonly PackFormatRange[] {
  return kind === 'datapack' ? DATAPACK_FORMAT_RANGES : RESOURCE_PACK_FORMAT_RANGES
}

export function packFormatTableVersionRange(kind: PackFormatKind): { from: string; to: string } {
  const ranges = packRanges(kind)
  return { from: ranges[0].from, to: ranges[ranges.length - 1].to }
}

/** pack_format → MC 版本列表；未收录时返回 null（未知，不要猜）。 */
export function packFormatVersions(format: number, kind: PackFormatKind): string[] | null {
  const entry = packRanges(kind).find((r) => r.format === format)
  if (!entry) return null
  return KNOWN_GAME_VERSIONS.filter(
    (v) => compareVersions(v, entry.from) >= 0 && compareVersions(v, entry.to) <= 0
  )
}

/** MC 版本 → 该版本可接受的 pack_format 列表；版本超出对照表覆盖范围时返回 []（未知）。 */
export function packFormatsForVersion(gameVersion: string, kind: PackFormatKind): number[] {
  const out: number[] = []
  for (const range of packRanges(kind)) {
    if (compareVersions(gameVersion, range.from) >= 0 && compareVersions(gameVersion, range.to) <= 0) {
      out.push(range.format)
    }
  }
  return out
}

/** 人类可读的格式描述，例如 “15（1.20–1.20.1）” 或 “未知”。 */
export function describePackFormat(format: number, kind: PackFormatKind): string {
  const versions = packFormatVersions(format, kind)
  if (!versions || versions.length === 0) return `${format}（未收录，未知）`
  const first = versions[0]
  const last = versions[versions.length - 1]
  return first === last ? `${format}（${first}）` : `${format}（${first}–${last}）`
}

/* ------------------------------------------------------------------ *
 *  TOML 子集解析器
 * ------------------------------------------------------------------ */

export type TomlPrimitive = string | number | boolean
export type TomlValue = TomlPrimitive | TomlValue[] | TomlTable
export interface TomlTable {
  [key: string]: TomlValue
}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析 TOML 子集。支持：
 *  - `key = "value"`（含转义）、`key = 123`、`key = true/false`、浮点/十六进制/下划线分隔数字
 *  - `[table]`、`[[array of tables]]`、点分键 `a.b.c`、带引号的键
 *  - 内联数组 `[1, "a"]`、内联表 `{ a = 1 }`（可跨行）
 *  - 多行字符串 `'''...'''` / `"""..."""`（含行尾续行）
 *  - `#` 注释
 *
 * 这是「子集」实现：解析不了的行会被跳过而不是抛错，保证畸形 mods.toml 不会让整个扫描失败。
 * 需要完整 TOML（日期时间、多行数组嵌套等）时请换用专业库。
 */
export function parseToml(text: string): TomlTable {
  const reader = new TomlSubsetReader(text)
  return reader.parse()
}

class TomlSubsetReader {
  private pos = 0
  private readonly src: string

  constructor(src: string) {
    this.src = src
  }

  parse(): TomlTable {
    const root: TomlTable = {}
    let current: TomlTable = root
    for (;;) {
      this.skipTrivia()
      if (this.pos >= this.src.length) break
      const ch = this.src[this.pos]
      if (ch === ',' || ch === ';') {
        // 容忍多余分隔符（部分手写 toml 会带）
        this.finishLine()
        continue
      }
      if (ch === '[') {
        const isArray = this.src.startsWith('[[', this.pos)
        this.pos += isArray ? 2 : 1
        const path = this.readKeyPath()
        this.skipInlineWhitespace()
        if (isArray) {
          if (this.src.startsWith(']]', this.pos)) this.pos += 2
          else if (this.src[this.pos] === ']') this.pos += 1
        } else if (this.src[this.pos] === ']') {
          this.pos += 1
        }
        this.finishLine()
        if (path.length > 0) current = tableFor(root, path, isArray)
        continue
      }
      const path = this.readKeyPath()
      this.skipInlineWhitespace()
      if (this.src[this.pos] !== '=' || path.length === 0) {
        this.finishLine()
        continue
      }
      this.pos++ // '='
      this.skipInlineWhitespace()
      const value = this.readValue()
      const parent = path.length > 1 ? tableFor(current, path.slice(0, -1), false) : current
      parent[path[path.length - 1]] = value
      this.finishLine()
    }
    return root
  }

  /* -------------------- 基础读取 -------------------- */

  private skipInlineWhitespace(): void {
    while (this.pos < this.src.length && (this.src[this.pos] === ' ' || this.src[this.pos] === '\t')) this.pos++
  }

  private skipTrivia(): void {
    for (;;) {
      if (this.pos >= this.src.length) return
      const c = this.src[this.pos]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++
        continue
      }
      if (c === '#') {
        this.finishLine()
        continue
      }
      return
    }
  }

  private finishLine(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++
  }

  private readKeyPath(): string[] {
    const segments: string[] = []
    for (;;) {
      this.skipInlineWhitespace()
      const segment = this.readKeySegment()
      if (segment === null) break
      segments.push(segment)
      this.skipInlineWhitespace()
      if (this.src[this.pos] === '.') {
        this.pos++
        continue
      }
      break
    }
    return segments
  }

  private readKeySegment(): string | null {
    const c = this.src[this.pos]
    if (c === undefined) return null
    if (c === '"') {
      this.pos++
      return this.readBasicString()
    }
    if (c === "'") {
      this.pos++
      return this.readLiteralString()
    }
    const m = /^[A-Za-z0-9_\-]+/.exec(this.src.slice(this.pos, this.pos + 200))
    if (!m) {
      // 无法识别的字符：消费一个字符避免死循环
      this.pos++
      return null
    }
    this.pos += m[0].length
    return m[0]
  }

  /* -------------------- 字符串 -------------------- */

  private readBasicString(): string {
    let out = ''
    for (;;) {
      if (this.pos >= this.src.length) break
      const c = this.src[this.pos]
      if (c === '"') {
        this.pos++
        break
      }
      if (c === '\n') break // 未闭合，容忍
      if (c === '\\') {
        this.pos++
        out += this.readEscape()
        continue
      }
      out += c
      this.pos++
    }
    return out
  }

  private readLiteralString(): string {
    let out = ''
    for (;;) {
      if (this.pos >= this.src.length) break
      const c = this.src[this.pos]
      if (c === "'") {
        this.pos++
        break
      }
      if (c === '\n') break
      out += c
      this.pos++
    }
    return out
  }

  private readMultilineBasic(): string {
    // 开头的换行会被 TOML 规范裁掉
    if (this.src.startsWith('\r\n', this.pos)) this.pos += 2
    else if (this.src[this.pos] === '\n') this.pos += 1
    let out = ''
    for (;;) {
      if (this.pos >= this.src.length) break
      if (this.src.startsWith('"""', this.pos)) {
        // 四/五个引号：多出来的属于内容
        if (this.src[this.pos + 3] === '"') {
          out += '"'
          this.pos++
          continue
        }
        this.pos += 3
        break
      }
      const c = this.src[this.pos]
      if (c === '\\') {
        // 行尾反斜杠 = 续行，吞掉后续空白与换行
        let j = this.pos + 1
        if (this.src[j] === '\r' && this.src[j + 1] === '\n') j += 2
        else if (this.src[j] === '\n') j += 1
        else {
          this.pos++
          out += this.readEscape()
          continue
        }
        while (j < this.src.length && /\s/.test(this.src[j])) j++
        this.pos = j
        continue
      }
      out += c
      this.pos++
    }
    return out
  }

  private readMultilineLiteral(): string {
    if (this.src.startsWith('\r\n', this.pos)) this.pos += 2
    else if (this.src[this.pos] === '\n') this.pos += 1
    let out = ''
    for (;;) {
      if (this.pos >= this.src.length) break
      if (this.src.startsWith("'''", this.pos)) {
        if (this.src[this.pos + 3] === "'") {
          out += "'"
          this.pos++
          continue
        }
        this.pos += 3
        break
      }
      out += this.src[this.pos]
      this.pos++
    }
    return out
  }

  private readEscape(): string {
    const c = this.src[this.pos]
    this.pos++
    switch (c) {
      case 'b':
        return '\b'
      case 't':
        return '\t'
      case 'n':
        return '\n'
      case 'f':
        return '\f'
      case 'r':
        return '\r'
      case '"':
        return '"'
      case '\\':
        return '\\'
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8
        const hex = this.src.slice(this.pos, this.pos + len)
        this.pos += len
        const code = Number.parseInt(hex, 16)
        return Number.isFinite(code) ? String.fromCodePoint(code) : ''
      }
      default:
        return c ?? ''
    }
  }

  /* -------------------- 值 -------------------- */

  private readValue(): TomlValue {
    this.skipInlineWhitespace()
    if (this.pos >= this.src.length) return ''
    if (this.src.startsWith('"""', this.pos)) {
      this.pos += 3
      return this.readMultilineBasic()
    }
    if (this.src.startsWith("'''", this.pos)) {
      this.pos += 3
      return this.readMultilineLiteral()
    }
    const c = this.src[this.pos]
    if (c === '"') {
      this.pos++
      return this.readBasicString()
    }
    if (c === "'") {
      this.pos++
      return this.readLiteralString()
    }
    if (c === '[') return this.readArray()
    if (c === '{') return this.readInlineTable()
    return parseBareScalar(this.readBareToken())
  }

  private readArray(): TomlValue[] {
    const out: TomlValue[] = []
    this.pos++ // '['
    for (;;) {
      this.skipTrivia()
      if (this.pos >= this.src.length) break
      const c = this.src[this.pos]
      if (c === ']') {
        this.pos++
        break
      }
      if (c === ',') {
        // 容忍多余逗号
        this.pos++
        continue
      }
      out.push(this.readValue())
      this.skipTrivia()
      const next = this.src[this.pos]
      if (next === ',') {
        this.pos++
        continue
      }
      if (next === ']') {
        this.pos++
        break
      }
      // 无法识别：消费一个字符避免死循环
      this.pos++
    }
    return out
  }

  private readInlineTable(): TomlTable {
    const table: TomlTable = {}
    this.pos++ // '{'
    for (;;) {
      this.skipTrivia()
      if (this.pos >= this.src.length) break
      if (this.src[this.pos] === '}') {
        this.pos++
        break
      }
      const path = this.readKeyPath()
      this.skipInlineWhitespace()
      if (this.src[this.pos] === '=') {
        this.pos++
        this.skipInlineWhitespace()
        const value = this.readValue()
        if (path.length > 0) {
          const parent = path.length > 1 ? tableFor(table, path.slice(0, -1), false) : table
          parent[path[path.length - 1]] = value
        }
      } else {
        this.pos++
      }
      this.skipTrivia()
      if (this.src[this.pos] === ',') this.pos++
    }
    return table
  }

  private readBareToken(): string {
    const start = this.pos
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]
      if (c === '\n' || c === '\r' || c === ',' || c === ']' || c === '}' || c === '#') break
      this.pos++
    }
    return this.src.slice(start, this.pos).trim()
  }
}

function parseBareScalar(raw: string): TomlValue {
  const text = raw.trim()
  if (text === '') return ''
  if (text === 'true') return true
  if (text === 'false') return false
  const cleaned = text.replace(/_/g, '')
  const sign = /^[+-]/.test(cleaned) ? cleaned[0] : ''
  const body = sign ? cleaned.slice(1) : cleaned
  if (/^inf$/i.test(body)) return sign === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  if (/^nan$/i.test(body)) return Number.NaN
  if (/^0x[0-9a-f]+$/i.test(body)) return sign === '-' ? -Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(2), 16)
  if (/^0o[0-7]+$/i.test(body)) return sign === '-' ? -Number.parseInt(body.slice(2), 8) : Number.parseInt(body.slice(2), 8)
  if (/^0b[01]+$/i.test(body)) return sign === '-' ? -Number.parseInt(body.slice(2), 2) : Number.parseInt(body.slice(2), 2)
  if (/^(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(body)) {
    const n = Number(`${sign}${body}`)
    if (Number.isFinite(n)) return n
  }
  // 日期时间等无法识别的字面量按字符串保留
  return text
}

/** 沿点分路径取/建表；中间遇到「数组 of tables」时取最后一个元素（TOML 语义）。 */
function tableFor(root: TomlTable, path: string[], arrayOfTables: boolean): TomlTable {
  const parent = path.length > 1 ? tableFor(root, path.slice(0, -1), false) : root
  const key = path[path.length - 1]
  if (arrayOfTables) {
    let list = parent[key]
    if (!Array.isArray(list)) {
      list = []
      parent[key] = list
    }
    const table: TomlTable = {}
    ;(list as TomlValue[]).push(table)
    return table
  }
  let value = parent[key]
  if (!isTomlTable(value)) {
    value = {}
    parent[key] = value
  }
  return value
}

/* ------------------------------------------------------------------ *
 *  最小 NBT 解析器（用于 level.dat）
 * ------------------------------------------------------------------ */

export type NbtTag =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: number }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'string'; value: string }
  | { type: 'byteArray'; value: Buffer }
  | { type: 'intArray'; value: number[] }
  | { type: 'longArray'; value: number[] }
  | { type: 'list'; value: NbtTag[] }
  | { type: 'compound'; value: Record<string, NbtTag> }

const TAG_NAMES: Record<number, NbtTag['type'] | 'end'> = {
  0: 'end',
  1: 'byte',
  2: 'short',
  3: 'int',
  4: 'long',
  5: 'float',
  6: 'double',
  7: 'byteArray',
  8: 'string',
  9: 'list',
  10: 'compound',
  11: 'intArray',
  12: 'longArray'
}

const MAX_NBT_DEPTH = 64
const MAX_NBT_STRING = 32 * 1024
const MAX_NBT_LIST = 200_000

class NbtReader {
  private offset = 0
  constructor(private readonly buf: Buffer) {}

  private ensure(n: number): void {
    if (this.offset + n > this.buf.length) throw new Error('NBT 数据意外结束')
  }

  readU8(): number {
    this.ensure(1)
    return this.buf.readUInt8(this.offset++)
  }

  readI16(): number {
    this.ensure(2)
    const v = this.buf.readInt16BE(this.offset)
    this.offset += 2
    return v
  }

  readI32(): number {
    this.ensure(4)
    const v = this.buf.readInt32BE(this.offset)
    this.offset += 4
    return v
  }

  readI64(): number {
    this.ensure(8)
    const v = this.buf.readBigInt64BE(this.offset)
    this.offset += 8
    // Long 可能超出 Number 安全范围（例如种子），这里允许精度损失
    return Number(v)
  }

  readF32(): number {
    this.ensure(4)
    const v = this.buf.readFloatBE(this.offset)
    this.offset += 4
    return v
  }

  readF64(): number {
    this.ensure(8)
    const v = this.buf.readDoubleBE(this.offset)
    this.offset += 8
    return v
  }

  readString(): string {
    const length = this.buf.readUInt16BE(this.offset)
    this.offset += 2
    const len = Math.min(length, MAX_NBT_STRING)
    this.ensure(len)
    const value = this.buf.toString('utf8', this.offset, this.offset + len)
    this.offset += length
    return value
  }

  readBytes(n: number): Buffer {
    this.ensure(n)
    const out = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  readTagPayload(typeId: number, depth: number): NbtTag {
    switch (TAG_NAMES[typeId]) {
      case 'byte':
        return { type: 'byte', value: (this.readU8() << 24) >> 24 }
      case 'short':
        return { type: 'short', value: this.readI16() }
      case 'int':
        return { type: 'int', value: this.readI32() }
      case 'long':
        return { type: 'long', value: this.readI64() }
      case 'float':
        return { type: 'float', value: this.readF32() }
      case 'double':
        return { type: 'double', value: this.readF64() }
      case 'string':
        return { type: 'string', value: this.readString() }
      case 'byteArray': {
        const len = this.readI32()
        return { type: 'byteArray', value: this.readBytes(Math.max(0, Math.min(len, MAX_NBT_LIST))) }
      }
      case 'intArray': {
        const len = Math.min(this.readI32(), MAX_NBT_LIST)
        const value: number[] = []
        for (let i = 0; i < len; i++) value.push(this.readI32())
        return { type: 'intArray', value }
      }
      case 'longArray': {
        const len = Math.min(this.readI32(), MAX_NBT_LIST)
        const value: number[] = []
        for (let i = 0; i < len; i++) value.push(this.readI64())
        return { type: 'longArray', value }
      }
      case 'list': {
        const elementType = this.readU8()
        const len = Math.min(this.readI32(), MAX_NBT_LIST)
        const value: NbtTag[] = []
        if (elementType === 0) return { type: 'list', value }
        for (let i = 0; i < len; i++) value.push(this.readTagPayload(elementType, depth + 1))
        return { type: 'list', value }
      }
      case 'compound': {
        if (depth > MAX_NBT_DEPTH) throw new Error('NBT 嵌套过深')
        const value: Record<string, NbtTag> = {}
        for (;;) {
          const childType = this.readU8()
          if (childType === 0) break
          const name = this.readString()
          value[name] = this.readTagPayload(childType, depth + 1)
        }
        return { type: 'compound', value }
      }
      default:
        throw new Error(`未知的 NBT 标签类型：${typeId}`)
    }
  }

  /** 读取带名称的命名标签（根标签形式） */
  readNamedTag(depth = 0): { name: string; tag: NbtTag } {
    const typeId = this.readU8()
    if (typeId === 0) throw new Error('NBT 根标签为 TAG_End')
    const name = this.readString()
    return { name, tag: this.readTagPayload(typeId, depth) }
  }
}

/** 解析未压缩的 NBT 数据，返回根标签。 */
export function parseNbt(buffer: Buffer): NbtTag {
  const reader = new NbtReader(buffer)
  const { tag } = reader.readNamedTag()
  return tag
}

/** 按路径读取 compound 链路上的子标签，例如 ['Data','LevelName'] */
export function nbtGet(tag: NbtTag | undefined, path: string[]): NbtTag | undefined {
  let current: NbtTag | undefined = tag
  for (const key of path) {
    if (!current || current.type !== 'compound') return undefined
    current = current.value[key]
  }
  return current
}

export function nbtString(tag: NbtTag | undefined): string | undefined {
  return tag && tag.type === 'string' ? tag.value : undefined
}

export function nbtNumber(tag: NbtTag | undefined): number | undefined {
  if (!tag) return undefined
  switch (tag.type) {
    case 'byte':
    case 'short':
    case 'int':
    case 'long':
    case 'float':
    case 'double':
      return tag.value
    default:
      return undefined
  }
}

export interface LevelDatInfo {
  /** 存档显示名（level.dat → Data.LevelName） */
  levelName?: string
  /** 存档数据版本（Data.DataVersion），它不是游戏版本号，仅用于粗略判断新旧 */
  dataVersion?: number
}

/**
 * 读取 level.dat。
 * level.dat 是 gzip 压缩的 NBT（部分工具会写未压缩版本，因此先嗅探 gzip 魔数 1f 8b）。
 * 根结构固定为 无名 TAG_Compound → Data: TAG_Compound。
 */
export function readLevelDatBuffer(buffer: Buffer): LevelDatInfo {
  let raw = buffer
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    raw = gunzipSync(buffer)
  }
  const root = parseNbt(raw)
  const data = nbtGet(root, ['Data']) ?? root
  return {
    levelName: nbtString(nbtGet(data, ['LevelName'])),
    dataVersion: nbtNumber(nbtGet(data, ['DataVersion']))
  }
}

/* ------------------------------------------------------------------ *
 *  内容源抽象（zip / 目录共用）
 * ------------------------------------------------------------------ */

/** 内容包根目录标记：文件用完整相对路径匹配，目录用 “xxx/” 前缀匹配。 */
interface ContentSource {
  type: 'zip' | 'dir'
  /** 全部文件条目（posix 相对路径），不含目录条目 */
  entries: string[]
  readBuffer(rel: string): Promise<Buffer | null>
  readText(rel: string, maxBytes?: number): Promise<string | null>
  close(): Promise<void>
}

async function openSource(target: string): Promise<ContentSource> {
  const info = await stat(target)
  if (info.isDirectory()) {
    const files = await walkFiles(target, { maxDepth: 8, limit: 20_000 })
    return {
      type: 'dir',
      entries: files,
      async readBuffer(rel: string): Promise<Buffer | null> {
        try {
          return await readFile(join(target, rel))
        } catch {
          return null
        }
      },
      async readText(rel: string, maxBytes = 512 * 1024): Promise<string | null> {
        try {
          const buf = await readFile(join(target, rel))
          // mcmeta / json 一般是 UTF-8，但老 mcmod.info 可能是 GBK
          return decodeText(buf.subarray(0, maxBytes)).text
        } catch {
          return null
        }
      },
      async close(): Promise<void> {
        /* 目录无需释放 */
      }
    }
  }

  const zip = new AdmZip(target)
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replace(/\\/g, '/'))
    // 跳过打包工具留下的垃圾条目，避免误判内容类型
    .filter((name) => !name.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/i.test(name))
  return {
    type: 'zip',
    entries,
    async readBuffer(rel: string): Promise<Buffer | null> {
      const entry = zip.getEntry(rel)
      if (!entry || entry.isDirectory) return null
      try {
        return entry.getData()
      } catch (err) {
        log.debug(`读取 zip 条目失败 ${rel}：${String(err)}`)
        return null
      }
    },
    async readText(rel: string, maxBytes = 512 * 1024): Promise<string | null> {
      const entry = zip.getEntry(rel)
      if (!entry || entry.isDirectory) return null
      try {
        return decodeText(entry.getData().subarray(0, maxBytes)).text
      } catch {
        return null
      }
    },
    async close(): Promise<void> {
      /* adm-zip 无句柄需要释放 */
    }
  }
}

function markerMatches(entries: string[], prefix: string, marker: string): boolean {
  if (marker.endsWith('/')) return entries.some((e) => e.startsWith(prefix + marker))
  return entries.includes(prefix + marker)
}

/**
 * 探测内容根目录前缀。
 * Minecraft 允许 zip 里套一层同名文件夹（资源包/数据包/存档常见），
 * 但 mod jar 的元数据必须位于 jar 根，因此只有包装类内容才用这个前缀。
 */
function detectRootPrefix(entries: string[], markers: string[]): { prefix: string; wrapped: boolean } {
  if (markers.some((m) => markerMatches(entries, '', m))) return { prefix: '', wrapped: false }
  const tops = new Set<string>()
  for (const entry of entries) {
    const idx = entry.indexOf('/')
    if (idx > 0) tops.add(entry.slice(0, idx))
  }
  const candidates: string[] = []
  for (const top of tops) {
    if (markers.some((m) => markerMatches(entries, `${top}/`, m))) candidates.push(top)
  }
  if (candidates.length === 1) return { prefix: `${candidates[0]}/`, wrapped: true }
  return { prefix: '', wrapped: false }
}

function baseNameOf(target: string): string {
  const name = target.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? target
  return name
}

/** 去掉 .disabled / .jar / .zip / .litemod / .mrpack 等后缀，得到可读名称。 */
function stemOf(fileName: string): string {
  return fileName
    .replace(/\.disabled$/i, '')
    .replace(/\.(jar|zip|litemod|mrpack)$/i, '')
}

function baseMetaFromPath(target: string, kind: ContentKind): ContentMeta {
  const stem = stemOf(baseNameOf(target))
  void kind
  return { name: stem, source: { platform: 'local' } }
}

/* ------------------------------------------------------------------ *
 *  mod 元数据
 * ------------------------------------------------------------------ */

const MOD_MARKERS = [
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'mcmod.info'
]

function firstLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
  return []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** mods.toml 的 authors 既可能是数组，也可能是 "Alice, Bob" 形式的字符串 */
function parseAuthorsField(value: TomlValue | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    const list = normalizeStringArray(value)
    return list.length > 0 ? list : undefined
  }
  if (typeof value === 'string') {
    const list = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return list.length > 0 ? list : undefined
  }
  return undefined
}

/** fabric.mod.json 的 authors 可能是字符串数组，也可能是 {name, contact} 对象数组 */
function parseFabricAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return normalizeStringArray(value)
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
    else {
      const record = asRecord(item)
      const name = record.name
      if (typeof name === 'string') out.push(name)
    }
  }
  return out
}

function mapEnvironment(value: unknown): ModEnvironment | undefined {
  if (value === '*') return 'both'
  if (value === 'client') return 'client'
  if (value === 'server') return 'server'
  return undefined
}

export interface FabricDepEntry {
  id: string
  versionRange?: string
  required: boolean
}

/** 解析 fabric.mod.json 的 depends（值可能是字符串或 {version, optional} 对象） */
function parseFabricDependencies(value: unknown): FabricDepEntry[] {
  const depends: FabricDepEntry[] = []
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (raw === null || raw === undefined || raw === false) continue
    if (raw === true || raw === '*') {
      depends.push({ id: key, required: true })
      continue
    }
    if (typeof raw === 'string') {
      depends.push({ id: key, versionRange: raw, required: true })
      continue
    }
    const record = asRecord(raw)
    depends.push({
      id: key,
      versionRange: typeof record.version === 'string' ? record.version : undefined,
      required: record.optional !== true
    })
  }
  return depends
}

/**
 * 解析 fabric.mod.json。
 * 依据 Fabric Loader 规范：
 *  - depends 中 `minecraft` 是 MC 版本范围，`fabricloader`/`java` 是加载器与 JVM 要求；
 *  - environment 取值 `*`（双端）/`client`/`server`；
 *  - Fabric 模组可被 Quilt 加载器加载，因此 loaders 记为 fabric + quilt。
 */
export function parseFabricModJson(text: string): ParsedContent {
  const warnings: string[] = []
  const meta: ContentMeta = { source: { platform: 'local' } }
  let json: Record<string, unknown>
  try {
    json = asRecord(JSON.parse(text))
  } catch (err) {
    return { meta, warnings: [`fabric.mod.json 不是合法 JSON：${msgOf(err)}`] }
  }
  meta.id = typeof json.id === 'string' ? json.id : undefined
  meta.name = typeof json.name === 'string' ? json.name : meta.id
  meta.version = typeof json.version === 'string' ? json.version : undefined
  const description = asRecord(json.description)
  if (typeof json.description === 'string') meta.description = json.description
  else if (typeof description.translate === 'string') meta.description = description.translate
  meta.authors = parseFabricAuthors(json.authors)
  if (meta.authors.length === 0) delete meta.authors
  if (typeof json.license === 'string') meta.license = json.license
  else if (Array.isArray(json.license)) meta.license = normalizeStringArray(json.license).join(' OR ')
  const contact = asRecord(json.contact)
  meta.homepage =
    typeof contact.homepage === 'string'
      ? contact.homepage
      : typeof contact.sources === 'string'
        ? contact.sources
        : undefined
  meta.environment = mapEnvironment(json.environment)
  meta.loaders = ['fabric', 'quilt']

  const depends = parseFabricDependencies(json.depends)
  const minecraftRange = depends.find((d) => d.id.toLowerCase() === 'minecraft')?.versionRange
  if (minecraftRange) {
    const expanded = expandVersionRange(minecraftRange)
    if (expanded) meta.gameVersions = expanded
    else if (parseVersionConstraint(minecraftRange)?.kind !== 'any') {
      warnings.push(`minecraft 版本约束「${minecraftRange}」无法保守展开，仅保留范围原文`)
    }
  }
  meta.depends = depends.map((d) => ({ id: d.id, versionRange: d.versionRange, required: d.required }))
  // breaks 也是 { id: range } 映射，进 meta.breaks 供冲突检查使用
  const breakList: { id: string; versionRange?: string }[] = []
  for (const [key, raw] of Object.entries(asRecord(json.breaks))) {
    const record = asRecord(raw)
    breakList.push({
      id: key,
      versionRange: typeof raw === 'string' ? raw : typeof record.version === 'string' ? record.version : undefined
    })
  }
  if (breakList.length > 0) meta.breaks = breakList
  return { meta, warnings, raw: text.slice(0, 8192) }
}

/**
 * 解析 quilt.mod.json。
 * Quilt 的结构把元数据放在 quilt_loader 下，depends/breaks 是对象数组：
 * `[{ "id": "minecraft", "versions": ">=1.19" }]`。
 */
export function parseQuiltModJson(text: string): ParsedContent {
  const warnings: string[] = []
  const meta: ContentMeta = { source: { platform: 'local' } }
  let json: Record<string, unknown>
  try {
    json = asRecord(JSON.parse(text))
  } catch (err) {
    return { meta, warnings: [`quilt.mod.json 不是合法 JSON：${msgOf(err)}`] }
  }
  const loader = asRecord(json.quilt_loader)
  meta.id = typeof loader.id === 'string' ? loader.id : undefined
  meta.version = typeof loader.version === 'string' ? loader.version : undefined
  const metadata = asRecord(loader.metadata)
  meta.name = typeof metadata.name === 'string' ? metadata.name : meta.id
  if (typeof metadata.description === 'string') meta.description = metadata.description
  const contributors = asRecord(metadata.contributors)
  const authors = Object.keys(contributors)
  if (authors.length > 0) meta.authors = authors
  if (typeof metadata.license === 'string') meta.license = metadata.license
  meta.loaders = ['quilt']

  const depends: ContentMeta['depends'] = []
  const rawDepends = Array.isArray(loader.depends) ? loader.depends : []
  for (const item of rawDepends) {
    const record = asRecord(item)
    const id = typeof record.id === 'string' ? record.id : undefined
    if (!id) continue
    const range = typeof record.versions === 'string' ? record.versions : undefined
    depends.push({ id, versionRange: range, required: record.optional !== true })
    if (id.toLowerCase() === 'minecraft' && range) {
      const expanded = expandVersionRange(range)
      if (expanded) meta.gameVersions = expanded
      else if (parseVersionConstraint(range)?.kind !== 'any') {
        warnings.push(`minecraft 版本约束「${range}」无法保守展开，仅保留范围原文`)
      }
    }
  }
  if (depends.length > 0) meta.depends = depends
  const breaks: { id: string; versionRange?: string }[] = []
  for (const item of Array.isArray(loader.breaks) ? loader.breaks : []) {
    const record = asRecord(item)
    if (typeof record.id === 'string') {
      breaks.push({ id: record.id, versionRange: typeof record.versions === 'string' ? record.versions : undefined })
    }
  }
  if (breaks.length > 0) meta.breaks = breaks
  return { meta, warnings, raw: text.slice(0, 4096) }
}

export interface ModsTomlDependency {
  modId: string
  mandatory: boolean
  versionRange?: string
  side?: string
  /** NeoForge 1.21+ 用 type=required|optional|incompatible 取代 mandatory */
  type?: string
}

export interface ModsTomlParseResult {
  mods: { modId: string; version?: string; displayName?: string; description?: string; authors?: string[]; license?: string; displayTest?: string; displayURL?: string; logoFile?: string; updateJsonUrl?: string }[]
  dependencies: Record<string, ModsTomlDependency[]>
  license?: string
  loaderVersion?: string
  issueTrackerURL?: string
  warnings: string[]
}

/**
 * 解析 Forge/NeoForge 的 mods.toml。
 * 关键结构：
 *  - `[[mods]]` 列表：modId / version / displayName / description / authors / license / displayTest
 *  - `[[dependencies.<modid>]]`：modId / mandatory（NeoForge 1.21+ 为 type）/ versionRange / ordering / side
 */
export function parseModsTomlText(text: string): ModsTomlParseResult {
  const warnings: string[] = []
  const table = parseToml(text)
  const modsRaw = table.mods
  const modList = Array.isArray(modsRaw) ? modsRaw : isTomlTable(modsRaw) ? [modsRaw] : []
  const mods: ModsTomlParseResult['mods'] = []
  for (const item of modList) {
    if (!isTomlTable(item)) continue
    const modId = typeof item.modId === 'string' ? item.modId : ''
    if (!modId) continue
    mods.push({
      modId,
      version: strOf(item.version),
      displayName: strOf(item.displayName),
      description: strOf(item.description),
      authors: parseAuthorsField(item.authors),
      license: strOf(item.license),
      displayTest: strOf(item.displayTest),
      displayURL: strOf(item.displayURL),
      logoFile: strOf(item.logoFile),
      updateJsonUrl: strOf(item.updateJSONURL)
    })
  }
  if (mods.length === 0) warnings.push('mods.toml 没有 [[mods]] 条目')

  const dependencies: Record<string, ModsTomlDependency[]> = {}
  const depsTable = table.dependencies
  if (isTomlTable(depsTable)) {
    for (const [owner, rawList] of Object.entries(depsTable)) {
      const list = Array.isArray(rawList) ? rawList : isTomlTable(rawList) ? [rawList] : []
      const parsed: ModsTomlDependency[] = []
      for (const item of list) {
        if (!isTomlTable(item)) continue
        const modId = strOf(item.modId)
        if (!modId) continue
        parsed.push({
          modId,
          mandatory: item.mandatory === undefined ? item.type === undefined || item.type === 'required' : item.mandatory === true,
          versionRange: strOf(item.versionRange),
          side: strOf(item.side),
          type: strOf(item.type)
        })
      }
      dependencies[owner] = parsed
    }
  }
  return {
    mods,
    dependencies,
    license: strOf(table.license),
    loaderVersion: strOf(table.loaderVersion),
    issueTrackerURL: strOf(table.issueTrackerURL),
    warnings
  }
}

function strOf(value: TomlValue | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * mcmod.info（1.12 及更早）：
 *  - 1.12：JSON 数组，字段 modid / name / version / mcversion / authorList / description
 *  - 更早（Retro）：`{ "modList": [ ... ] }`
 */
export function parseMcmodInfo(text: string): ParsedContent {
  const warnings: string[] = []
  const entries: Record<string, unknown>[] = []
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) entries.push(...parsed.map(asRecord))
    else {
      const record = asRecord(parsed)
      if (Array.isArray(record.modList)) entries.push(...(record.modList as unknown[]).map(asRecord))
      else entries.push(record)
    }
  } catch (err) {
    return { meta: { source: { platform: 'local' } }, warnings: [`mcmod.info 不是合法 JSON：${msgOf(err)}`] }
  }
  const meta: ContentMeta = { source: { platform: 'local' }, loaders: ['forge'] }
  const depends: ContentMeta['depends'] = []
  const gameVersions = new Set<string>()
  let first = true
  for (const entry of entries) {
    const modId = typeof entry.modid === 'string' ? entry.modid : typeof entry.modId === 'string' ? (entry.modId as string) : undefined
    if (!modId) continue
    if (first) {
      meta.id = modId
      meta.name = typeof entry.name === 'string' ? entry.name : modId
      meta.version = typeof entry.version === 'string' ? entry.version : undefined
      const description = entry.description
      meta.description = typeof description === 'string' ? description : undefined
      meta.authors = normalizeStringArray(entry.authorList ?? entry.authors)
      if (meta.authors.length === 0) delete meta.authors
      if (typeof entry.url === 'string') meta.homepage = entry.url
      first = false
    }
    const mcversion = entry.mcversion
    if (typeof mcversion === 'string') {
      for (const v of mcversion.split(/[,\s]+/)) if (/^1\.\d+(\.\d+)?$/.test(v)) gameVersions.add(v)
    }
    const deps = normalizeStringArray(entry.requiredMods ?? entry.dependencies)
    for (const dep of deps) {
      const [id, range] = dep.split('@')
      if (id && id !== modId) depends.push({ id, versionRange: range || undefined, required: true })
    }
  }
  if (gameVersions.size > 0) meta.gameVersions = [...gameVersions].sort(compareVersions)
  if (depends.length > 0) meta.depends = depends
  if (!meta.id) warnings.push('mcmod.info 没有可用的 modid')
  return { meta, warnings, raw: text.slice(0, 4096) }
}

/** 汇总：把解析出的 meta 合并进目标 meta（目标已有的非空字段优先保留）。 */
function mergeMeta(target: ContentMeta, source: ContentMeta): void {
  for (const [key, value] of Object.entries(source) as [keyof ContentMeta, unknown][]) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === 'string' && value === '') continue
    const existing = target[key]
    const emptyExisting = existing === undefined || existing === '' || (Array.isArray(existing) && existing.length === 0)
    if (emptyExisting) {
      ;(target as unknown as Record<string, unknown>)[key] = value
    }
  }
}

/**
 * 读取 mod jar 元数据，按加载器规范依次尝试：
 * fabric.mod.json → quilt.mod.json → META-INF/mods.toml → META-INF/neoforge.mods.toml → mcmod.info
 */
export async function parseModMetadata(jarPath: string): Promise<ParsedContent> {
  const warnings: string[] = []
  const meta = baseMetaFromPath(jarPath, 'mod')
  let source: ContentSource | null = null
  let raw: string | undefined
  try {
    source = await openSource(jarPath)
    const { prefix, wrapped } = detectRootPrefix(source.entries, MOD_MARKERS)
    if (wrapped) warnings.push(`元数据位于子目录 ${prefix}，模组加载器要求元数据在 jar 根目录，可能无法加载`)

    const fabric = await source.readText(`${prefix}fabric.mod.json`)
    if (fabric) {
      const parsed = parseFabricModJson(fabric)
      mergeMeta(meta, parsed.meta)
      warnings.push(...parsed.warnings)
      raw = fabric
    } else {
      const quilt = await source.readText(`${prefix}quilt.mod.json`)
      if (quilt) {
        const parsed = parseQuiltModJson(quilt)
        mergeMeta(meta, parsed.meta)
        warnings.push(...parsed.warnings)
        raw = quilt
      } else {
        // NeoForge 1.20.5+ 用 neoforge.mods.toml；1.20.4 及更早/Forge 用 mods.toml
        const modsToml = await source.readText(`${prefix}META-INF/mods.toml`)
        const neoToml = await source.readText(`${prefix}META-INF/neoforge.mods.toml`)
        const tomlText = modsToml ?? neoToml
        if (tomlText) {
          const parsed = parseModsTomlText(tomlText)
          warnings.push(...parsed.warnings)
          const primary = parsed.mods[0]
          if (primary) {
            meta.id = primary.modId
            meta.name = primary.displayName ?? primary.modId
            meta.version = primary.version
            meta.description = primary.description ? firstLine(primary.description, 400) : undefined
            meta.authors = primary.authors && primary.authors.length > 0 ? primary.authors : undefined
            meta.license = primary.license ?? parsed.license
            meta.homepage = primary.displayURL
            const loaderVersion = parsed.loaderVersion ?? ''
            const isNeo = neoToml !== null || /neoforge/i.test(loaderVersion) || /neoforge/i.test(parsed.issueTrackerURL ?? '')
            meta.loaders = [isNeo ? 'neoforge' : 'forge']
            if (parsed.mods.length > 1) {
              warnings.push(`mods.toml 含 ${parsed.mods.length} 个 mod 声明（fat jar/多模块），仅解析第一个：${primary.modId}`)
            }
            // displayTest=IGNORE_* 是客户端专属模组的常见声明（服务端缺失时不报错）
            const displayTest = primary.displayTest ?? ''
            if (/^IGNORE/.test(displayTest)) meta.environment = 'client'
          }
          const deps = Object.values(parsed.dependencies).flat()
          if (deps.length > 0) {
            const depends: ContentMeta['depends'] = []
            const breaks: ContentMeta['breaks'] = []
            for (const dep of deps) {
              if (dep.type === 'incompatible') {
                breaks.push({ id: dep.modId, versionRange: dep.versionRange })
                continue
              }
              depends.push({ id: dep.modId, versionRange: dep.versionRange, required: dep.mandatory })
              if (dep.modId.toLowerCase() === 'minecraft' && dep.versionRange) {
                const expanded = expandVersionRange(dep.versionRange)
                if (expanded) meta.gameVersions = expanded
                else if (parseVersionConstraint(dep.versionRange)?.kind !== 'any') {
                  warnings.push(`minecraft 版本约束「${dep.versionRange}」无法保守展开，仅保留范围原文`)
                }
              }
            }
            if (depends.length > 0) meta.depends = depends
            if (breaks.length > 0) meta.breaks = breaks
          }
          raw = tomlText
        } else {
          const mcmodInfo = await source.readText(`${prefix}mcmod.info`)
          if (mcmodInfo) {
            const parsed = parseMcmodInfo(mcmodInfo)
            mergeMeta(meta, parsed.meta)
            warnings.push(...parsed.warnings)
            raw = mcmodInfo
          } else {
            warnings.push('未找到任何已识别的 mod 元数据文件（fabric.mod.json / quilt.mod.json / mods.toml / mcmod.info）')
            meta.loaders = []
          }
        }
      }
    }
  } catch (err) {
    warnings.push(`读取 jar 失败：${msgOf(err)}`)
  } finally {
    await source?.close()
  }
  if (!meta.name) meta.name = stemOf(baseNameOf(jarPath))
  return { meta, warnings, raw }
}

/* ------------------------------------------------------------------ *
 *  pack.mcmeta（资源包 / 数据包）
 * ------------------------------------------------------------------ */

export interface PackMcmeta {
  /** pack.pack_format（数字；写成数组时取第一个） */
  packFormat: number | null
  /** pack.supported_formats 展开出的格式号（不含主格式） */
  supportedFormats: number[]
  /** 描述（字符串，或 translate 键；对象则优先取 translate / text） */
  description: string
  /** 描述是否为本地化 key */
  descriptionIsTranslateKey: boolean
  raw: unknown
}

function flattenFormats(value: unknown, out: number[]): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    // [min, max] 或 [ {min_inclusive,max_inclusive}, ... ]
    if (value.length === 2 && value.every((v) => typeof v === 'number')) {
      const [min, max] = value as [number, number]
      for (let f = min; f <= max; f++) out.push(f)
      return
    }
    for (const item of value) flattenFormats(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const min = record.min_inclusive
    const max = record.max_inclusive ?? record.max
    if (typeof min === 'number' && typeof max === 'number') {
      for (let f = min; f <= max; f++) out.push(f)
      return
    }
    if (typeof min === 'number') out.push(min)
    if (typeof max === 'number') out.push(max)
  }
}

/**
 * 解析 pack.mcmeta。
 *  - `pack.pack_format`：数字（部分包会写成数组）
 *  - `pack.supported_formats`：1.20.2+ 支持，可为 [min,max] / {min_inclusive,max_inclusive} / 两者的数组
 *  - `pack.description`：字符串，或 `{"translate":"..."}`/`{"text":"..."}` 对象（社区包常见 translate 键）
 */
export function parsePackMcmeta(text: string): PackMcmeta {
  let json: Record<string, unknown>
  try {
    json = asRecord(JSON.parse(text))
  } catch {
    return { packFormat: null, supportedFormats: [], description: '', descriptionIsTranslateKey: false, raw: null }
  }
  const pack = asRecord(json.pack)
  let packFormat: number | null = null
  if (typeof pack.pack_format === 'number') packFormat = pack.pack_format
  else if (Array.isArray(pack.pack_format) && typeof pack.pack_format[0] === 'number') packFormat = pack.pack_format[0]

  const supported: number[] = []
  flattenFormats(pack.supported_formats, supported)

  let description = ''
  let isTranslateKey = false
  if (typeof pack.description === 'string') description = pack.description
  else {
    const record = asRecord(pack.description)
    if (typeof record.translate === 'string') {
      description = record.translate
      isTranslateKey = true
    } else if (typeof record.text === 'string') {
      description = record.text
    } else if (Array.isArray(pack.description) && typeof pack.description[0] === 'string') {
      description = String(pack.description[0])
    }
  }
  const uniqueSupported = [...new Set(supported.filter((f) => Number.isFinite(f)))].sort((a, b) => a - b)
  return { packFormat, supportedFormats: uniqueSupported, description, descriptionIsTranslateKey: isTranslateKey, raw: json.pack }
}

export async function parseResourcePackMetadata(zipPath: string): Promise<ParsedContent> {
  const warnings: string[] = []
  const meta: ContentMeta = baseMetaFromPath(zipPath, 'resourcepack')
  let source: ContentSource | null = null
  let raw: string | undefined
  try {
    source = await openSource(zipPath)
    const { prefix, wrapped } = detectRootPrefix(source.entries, ['pack.mcmeta', 'assets/'])
    if (wrapped) warnings.push(`内容包位于子目录 ${prefix}，Minecraft 支持这种单层包装的 zip`)
    const hasAssets = markerMatches(source.entries, prefix, 'assets/')
    const mcmetaText = await source.readText(`${prefix}pack.mcmeta`)
    const extra: ContentMetaExtra = { rootPrefix: prefix }
    if (!mcmetaText) {
      warnings.push('缺少 pack.mcmeta，Minecraft 会拒绝加载（提示“缺少 pack.mcmeta”）')
      if (!hasAssets) warnings.push('未发现 assets/ 目录，可能不是资源包')
    } else {
      const mcmeta = parsePackMcmeta(mcmetaText)
      raw = mcmetaText
      meta.packFormat = mcmeta.packFormat ?? undefined
      extra.supportedFormats = mcmeta.supportedFormats
      extra.rawDescription = mcmeta.description
      if (mcmeta.description) meta.description = mcmeta.description
      const versions = mcmeta.packFormat !== null ? packFormatVersions(mcmeta.packFormat, 'resourcepack') : null
      if (versions && versions.length > 0) meta.gameVersions = versions
      else if (mcmeta.packFormat !== null) warnings.push(`pack_format=${mcmeta.packFormat} 未收录在对照表中（可能是比已知列表更新的版本）`)
      if (!hasAssets) warnings.push('未发现 assets/ 目录，加载后可能没有任何纹理变化')
    }
    setMetaExtra(meta, extra)
  } catch (err) {
    warnings.push(`读取资源包失败：${msgOf(err)}`)
  } finally {
    await source?.close()
  }
  return { meta, warnings, raw }
}

/**
 * 读取数据包元数据。
 * 同时判断压缩包到底是数据包还是「存档」：
 *  - 有 data/ 或 pack.mcmeta → 数据包
 *  - 有 level.dat（根目录或世界子目录）→ 存档
 */
export async function parseDatapackMetadata(zipPath: string): Promise<ParsedContent> {
  const warnings: string[] = []
  const meta: ContentMeta = baseMetaFromPath(zipPath, 'datapack')
  let source: ContentSource | null = null
  let raw: string | undefined
  try {
    source = await openSource(zipPath)
    const { prefix, wrapped } = detectRootPrefix(source.entries, ['pack.mcmeta', 'data/'])
    if (wrapped) warnings.push(`内容包位于子目录 ${prefix}，Minecraft 支持这种单层包装的 zip`)
    const hasData = markerMatches(source.entries, prefix, 'data/')
    // 存档判定：level.dat 在根，或位于单层子目录（saves/<world>/level.dat 被整体打包）
    const levelDatPath = source.entries.includes(`${prefix}level.dat`)
      ? `${prefix}level.dat`
      : source.entries.find((e) => /^level\.dat$/.test(e) || /^[^/]+\/level\.dat$/.test(e))
    const extra: ContentMetaExtra = { rootPrefix: prefix }
    if (levelDatPath) {
      warnings.push('该压缩包包含 level.dat，更像是一个存档（世界）而不是数据包')
      const buffer = await source.readBuffer(levelDatPath)
      if (buffer) {
        try {
          const info = readLevelDatBuffer(buffer)
          if (info.levelName) meta.name = info.levelName
          extra.levelName = info.levelName
          extra.dataVersion = info.dataVersion
        } catch (err) {
          warnings.push(`level.dat 解析失败：${msgOf(err)}`)
        }
      }
    }
    const mcmetaText = await source.readText(`${prefix}pack.mcmeta`)
    if (!mcmetaText) {
      if (!hasData) warnings.push('缺少 pack.mcmeta 与 data/ 目录，可能不是有效的数据包')
    } else {
      const mcmeta = parsePackMcmeta(mcmetaText)
      raw = mcmetaText
      meta.packFormat = mcmeta.packFormat ?? undefined
      extra.supportedFormats = mcmeta.supportedFormats
      extra.rawDescription = mcmeta.description
      if (mcmeta.description) meta.description = mcmeta.description
      const versions = mcmeta.packFormat !== null ? packFormatVersions(mcmeta.packFormat, 'datapack') : null
      if (versions && versions.length > 0) meta.gameVersions = versions
      else if (mcmeta.packFormat !== null) warnings.push(`pack_format=${mcmeta.packFormat} 未收录在数据包对照表中`)
    }
    if (!hasData && !levelDatPath) warnings.push('未发现 data/ 目录，数据包不会提供任何内容')
    setMetaExtra(meta, extra)
  } catch (err) {
    warnings.push(`读取数据包失败：${msgOf(err)}`)
  } finally {
    await source?.close()
  }
  return { meta, warnings, raw }
}

/**
 * 读取存档（世界）元数据：level.dat 的 LevelName / DataVersion。
 * DataVersion 只是存档格式版本（例如 1.20.1=3465），并不等于游戏版本，
 * 因此这里只做记录，不做版本映射（映射表过大且容易过时）。
 */
export async function parseWorldMetadata(path: string): Promise<ParsedContent> {
  const warnings: string[] = []
  const meta: ContentMeta = baseMetaFromPath(path, 'world')
  let source: ContentSource | null = null
  try {
    source = await openSource(path)
    const levelDatPath = source.entries.includes('level.dat')
      ? 'level.dat'
      : source.entries.find((e) => /^[^/]+\/level\.dat$/.test(e))
    if (!levelDatPath) {
      warnings.push('未找到 level.dat，可能不是有效的存档')
    } else {
      const buffer = await source.readBuffer(levelDatPath)
      if (!buffer) warnings.push('level.dat 读取失败')
      else {
        try {
          const info = readLevelDatBuffer(buffer)
          const extra: ContentMetaExtra = { levelName: info.levelName, dataVersion: info.dataVersion }
          if (info.levelName) meta.name = info.levelName
          if (info.dataVersion !== undefined) {
            meta.description = `DataVersion=${info.dataVersion}`
          }
          setMetaExtra(meta, extra)
        } catch (err) {
          warnings.push(`level.dat 解析失败：${msgOf(err)}`)
        }
      }
    }
  } catch (err) {
    warnings.push(`读取存档失败：${msgOf(err)}`)
  } finally {
    await source?.close()
  }
  return { meta, warnings }
}

/* ------------------------------------------------------------------ *
 *  光影包
 * ------------------------------------------------------------------ */

const SHADER_TEXT_EXT = /\.(fsh|vsh|gsh|csh|glsl|properties|txt)$/i

/**
 * 读取光影包元数据。
 *
 * 判定依据（社区实际约定）：
 *  - `shaders/shaders.properties`：OptiFine 光影标准入口
 *  - `iris.properties`：Iris 专属（Iris 也兼容 OptiFine 语法）
 *  - `#version 120`：OptiFine/GLSL 1.20 语法；`#version 330/400/430`：Iris 的现代核心 Profile
 *  - `/* DRAWBUFFERS:... *\/`：OptiFine 后处理缓冲写法
 *  - `/* RENDERTARGETS:... *\/`：Iris 1.17+ 的对应写法
 *  - `#include`：Iris 专属预处理指令
 */
export async function parseShaderPackMetadata(zipPath: string): Promise<ParsedContent> {
  const warnings: string[] = []
  const meta: ContentMeta = baseMetaFromPath(zipPath, 'shaderpack')
  let source: ContentSource | null = null
  try {
    source = await openSource(zipPath)
    const { prefix, wrapped } = detectRootPrefix(source.entries, ['shaders/', 'shaders/shaders.properties', 'iris.properties'])
    if (wrapped) warnings.push(`光影包位于子目录 ${prefix}，Minecraft 支持这种单层包装的 zip`)

    const hasShadersDir = markerMatches(source.entries, prefix, 'shaders/')
    const hasShadersProperties = source.entries.includes(`${prefix}shaders/shaders.properties`)
    const hasIrisProperties = source.entries.includes(`${prefix}iris.properties`)

    const glslVersions = new Set<number>()
    let hasInclude = false
    let drawBuffers = false
    let renderTargets = false
    let irisUniform = false

    const shaderFiles = source.entries
      .filter((e) => e.startsWith(`${prefix}shaders/`) && SHADER_TEXT_EXT.test(e))
      .slice(0, 60)
    for (const file of shaderFiles) {
      const text = await source.readText(file, 64 * 1024)
      if (!text) continue
      const versionMatch = /^\s*#version\s+(\d+)/m.exec(text)
      if (versionMatch) glslVersions.add(Number.parseInt(versionMatch[1], 10))
      if (/^\s*#include\b/m.test(text)) hasInclude = true
      if (/DRAWBUFFERS\s*:/i.test(text)) drawBuffers = true
      if (/RENDERTARGETS\s*:/i.test(text)) renderTargets = true
      if (/\buniform\b[^\n]*\biris_\w+/i.test(text) || /\biris_\w+/.test(text)) irisUniform = true
    }

    const irisOnly = hasIrisProperties || renderTargets || hasInclude || irisUniform
    const optifineStyle = hasShadersProperties || drawBuffers || glslVersions.has(120)

    let language = '未知'
    if (irisOnly && optifineStyle) language = 'Iris/OptiFine 兼容'
    else if (irisOnly) language = 'Iris'
    else if (optifineStyle) language = 'OptiFine'
    meta.shaderLanguage = language

    if (!hasShadersDir) warnings.push('未发现 shaders/ 目录，不是有效的光影包')
    else if (!hasShadersProperties && !hasIrisProperties && !optifineStyle && !irisOnly) {
      warnings.push('未发现 shaders.properties / iris.properties，也没有可识别的 shader 源码')
    }

    const versionList = [...glslVersions].sort((a, b) => a - b)
    if (versionList.length > 0) meta.description = `GLSL ${versionList.join('/')}`
    setMetaExtra(meta, {
      rootPrefix: prefix,
      shader: {
        glslVersions: versionList,
        irisOnly,
        optifineStyle,
        hasShadersProperties,
        hasIrisProperties,
        hasShadersDir
      }
    })
  } catch (err) {
    warnings.push(`读取光影包失败：${msgOf(err)}`)
  } finally {
    await source?.close()
  }
  return { meta, warnings }
}

/* ------------------------------------------------------------------ *
 *  类型猜测与统一入口
 * ------------------------------------------------------------------ */

/**
 * 按文件名/扩展名猜测内容类型（纯名称推断，不含内容嗅探）。
 * `.jar`/`.litemod` → mod；`.mrpack` → modpack；`.zip` 依据名称关键词，
 * 无关键词时按最常见的“资源包”兜底，调用方可再用 inspectArchiveKind 纠正。
 */
export function guessContentKind(fileName: string): ContentKind {
  const name = fileName.replace(/\.disabled$/i, '').toLowerCase()
  if (/\.(jar|litemod)$/.test(name)) return 'mod'
  if (/\.mrpack$/.test(name)) return 'modpack'
  if (/\.zip$/.test(name)) {
    if (/shader|光影|optifine.*shader|irisshaders/.test(name)) return 'shaderpack'
    if (/resourcepack|resource_pack|resource-pack|资源包|texturepack|材质/.test(name)) return 'resourcepack'
    if (/datapack|data_pack|数据包/.test(name)) return 'datapack'
    if (/modpack|整合包/.test(name)) return 'modpack'
    if (/world|saves|存档|地图/.test(name)) return 'world'
    return 'resourcepack'
  }
  return 'mod'
}

/**
 * 从条目表（zip 内容或目录）推断内容类型，识别不了返回 null。
 * 判定顺序按「特征强度」排列：整合包 → 存档 → 光影 → mod → 资源包 → 数据包。
 */
export function detectKindFromEntries(entries: string[], prefix = ''): ContentKind | null {
  const has = (marker: string): boolean => markerMatches(entries, prefix, marker)
  const p = prefix

  // 整合包：Modrinth .mrpack 有 modrinth.index.json；CurseForge 包有 manifest.json + overrides/
  // （Bedrock 的 manifest.json 也有，但同时会有 textures/ models/ 等，因此要求没有 assets/、data/、level.dat）
  if (entries.includes(`${p}modrinth.index.json`) || has('overrides/')) return 'modpack'
  if (
    entries.includes(`${p}manifest.json`) &&
    !has('assets/') &&
    !has('data/') &&
    !has('level.dat') &&
    !has('textures/')
  ) {
    return 'modpack'
  }
  if (has('level.dat') || entries.some((e) => new RegExp(`^${escapeRegExp(p)}[^/]+/level\\.dat$`).test(e))) return 'world'
  if (has('fabric.mod.json') || has('quilt.mod.json') || has('META-INF/mods.toml') || has('META-INF/neoforge.mods.toml')) return 'mod'
  if (has('shaders/')) {
    if (entries.some((e) => e.startsWith(`${p}shaders/`) && /\.(fsh|vsh|glsl|csh|gsh)$/i.test(e))) return 'shaderpack'
    if (has('shaders/shaders.properties') || entries.includes(`${p}iris.properties`)) return 'shaderpack'
  }
  if (has('assets/')) return 'resourcepack'
  if (has('data/')) return 'datapack'
  if (has('pack.mcmeta')) {
    // 只有 pack.mcmeta：先看描述里有没有 datapack 段（1.13 前的老资源包没有 assets/）
    return null
  }
  // 单层包装目录：递归一次
  if (prefix === '') {
    const tops = new Set<string>()
    for (const entry of entries) {
      const idx = entry.indexOf('/')
      if (idx > 0) tops.add(entry.slice(0, idx))
    }
    for (const top of tops) {
      const result = detectKindFromEntries(entries, `${top}/`)
      if (result) return result
    }
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 打开压缩包/目录，嗅探内容类型（导入流程用于纠正按文件名猜出的类型）。 */
export async function inspectArchiveKind(target: string): Promise<ContentKind | null> {
  let source: ContentSource | null = null
  try {
    source = await openSource(target)
    return detectKindFromEntries(source.entries)
  } catch (err) {
    log.debug(`内容类型嗅探失败 ${target}：${msgOf(err)}`)
    return null
  } finally {
    await source?.close()
  }
}

/** 统一入口：按类型解析内容文件（zip 或目录均可）。 */
export async function parseContentFile(filePath: string, kind: ContentKind): Promise<ParsedContent> {
  switch (kind) {
    case 'mod':
      return parseModMetadata(filePath)
    case 'resourcepack':
      return parseResourcePackMetadata(filePath)
    case 'datapack':
      return parseDatapackMetadata(filePath)
    case 'shaderpack':
      return parseShaderPackMetadata(filePath)
    case 'world':
      return parseWorldMetadata(filePath)
    case 'modpack':
    default: {
      const meta: ContentMeta = baseMetaFromPath(filePath, 'modpack')
      return { meta, warnings: ['整合包需要由整合包导入流程解析（manifest / overrides）'] }
    }
  }
}

/** 供上层展示的绝对路径 → 内容包名 */
export function displayNameOf(filePath: string): string {
  return stemOf(baseNameOf(filePath))
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
