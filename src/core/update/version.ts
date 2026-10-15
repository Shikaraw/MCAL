/**
 * 版本号解析与比较。
 *
 * 需要容忍的两种真实写法：Release tag 带 `v` 前缀（v0.2.0）、预发布后缀
 * （0.2.0-beta.1）。比较只取数字段，后缀不参与排序（预发布与同号正式版视为同版本），
 * 这样「跳过此版本」的匹配也不会被后缀影响。
 */

/** 解析结果：extra 仅作展示，不参与比较 */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布 / 构建后缀，如 `beta.1` */
  extra?: string
}

/**
 * 解析版本号：容忍 `v` 前缀与 `-beta.1` / `+build` 后缀；
 * 段数不足（如 `1.2`）按 0 补齐；无法解析时返回 null。
 */
export function parseVersion(v: string): ParsedVersion | null {
  const text = String(v ?? '').trim()
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/i.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    extra: match[4] || undefined
  }
}

/**
 * 逐段比较数字版本：a<b 返回 -1，相等返回 0，a>b 返回 1。
 * 任一方无法解析时返回 0（调用方据此视为「无法判断，不提示更新」）。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  const keys = ['major', 'minor', 'patch'] as const
  for (const key of keys) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  return 0
}

/** candidate 是否比 current 新（无法解析时不视为更新） */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** 两个版本号是否等价（忽略 `v` 前缀与后缀差异，用于「跳过此版本」匹配） */
export function isSameVersion(a: string | undefined, b: string | undefined): boolean {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  if (!left || !right) return false
  const parsedLeft = parseVersion(left)
  const parsedRight = parseVersion(right)
  if (parsedLeft && parsedRight) return compareVersions(left, right) === 0
  return left.replace(/^v/i, '') === right.replace(/^v/i, '')
}
