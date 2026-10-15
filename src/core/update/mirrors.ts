/**
 * 更新源（GitHub 加速前缀）预设、前缀规范化与地址改写。
 *
 * 为什么默认走镜像：国内直连 api.github.com 经常整体超时（甚至 CONNECT 通了但
 * TLS 握手永远完不成），而这些公共加速前缀转发同一个 API 稳定得多，所以默认逐个
 * 尝试、命中即返回，官方直连只作最后兜底。
 *
 * 注意：这些镜像会用自己账号替换 Authorization 头，因此只适合「只读」操作
 * （检查更新 / 拉取 Release 列表）；发布 Release 不能走它们。
 */

import type { UpdateMirror } from '@shared/types'

/** GitHub API 原始地址：镜像前缀的拼接基点 */
export const GITHUB_API_ORIGIN = 'https://api.github.com'

/** 用户没显式选择时使用的镜像 id */
export const DEFAULT_MIRROR_ID = 'ghproxy'

/** 官方直连（空前缀），固定放在候选列表的最后兜底 */
export const DIRECT_MIRROR: UpdateMirror = {
  id: 'direct',
  name: 'GitHub 官方直连',
  prefix: '',
  note: '不走镜像，需要本机可直连 GitHub'
}

/**
 * 镜像预设，按实测可靠性排列。
 * 只有确认能代理 api.github.com 的条目才放进来；direct 恒定在最后兜底。
 */
export const MIRROR_PRESETS: UpdateMirror[] = [
  { id: 'ghproxy', name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/', note: '长期稳定，推荐' },
  { id: 'ghfast', name: 'ghfast.top', prefix: 'https://ghfast.top/', note: '备用线路' },
  { id: 'llkk', name: 'gh.llkk.cc', prefix: 'https://gh.llkk.cc/', note: '备用线路 2' },
  { id: 'moeyy', name: 'github.moeyy.xyz', prefix: 'https://github.moeyy.xyz/', note: '备用线路 3' },
  DIRECT_MIRROR
]

/** 解析更新源只需要设置里的这几个字段（结构化类型，便于测试注入） */
export interface UpdateSourceSettings {
  /** mirror 走镜像前缀，direct 直连 GitHub，custom 用自定义前缀 */
  source?: 'mirror' | 'direct' | 'custom'
  /** 镜像 id，见 MIRROR_PRESETS */
  mirrorId?: string
  /** 自定义前缀（source=custom 时使用） */
  customPrefix?: string
}

/**
 * 前缀规范化：接受 `gh-proxy.com`、`https://gh-proxy.com`、`https://gh-proxy.com/`
 * 三种写法，统一成带协议且以 `/` 结尾；空输入返回空字符串。
 */
export function normalizePrefix(input: string): string {
  const text = String(input ?? '').trim()
  if (!text) return ''
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`
  return `${withScheme.replace(/\/+$/, '')}/`
}

/** 按 id 查找预设（忽略大小写与空白）；找不到返回 undefined */
export function findMirrorById(id: string | undefined): UpdateMirror | undefined {
  const key = String(id ?? '').trim().toLowerCase()
  if (!key) return undefined
  return MIRROR_PRESETS.find((m) => m.id.toLowerCase() === key)
}

/**
 * 把用户的更新源设置解析成「按顺序尝试」的镜像列表：
 *  - source=direct  → 只有官方直连；
 *  - source=custom 且有前缀 → 只有自定义（规范化后的）前缀；
 *  - 其余（mirror）→ 用户选的排第一，其余镜像预设按顺序回退，direct 放最后兜底。
 */
export function resolveMirrors(settings: UpdateSourceSettings): UpdateMirror[] {
  const mode = settings?.source ?? 'mirror'
  if (mode === 'direct') return [{ ...DIRECT_MIRROR }]

  const custom = normalizePrefix(settings?.customPrefix ?? '')
  if (mode === 'custom' && custom) {
    return [{ id: 'custom', name: '自定义前缀', prefix: custom, note: '用户自定义镜像前缀' }]
  }

  const preferred = findMirrorById(settings?.mirrorId ?? DEFAULT_MIRROR_ID)
  // 用户选定项排第一；其余镜像预设依次回退（不含 direct），direct 恒在最后
  const selected = preferred && preferred.id !== DIRECT_MIRROR.id ? [preferred] : []
  const rest = MIRROR_PRESETS.filter((m) => m.id !== DIRECT_MIRROR.id && m.id !== selected[0]?.id)
  return [...selected, ...rest, DIRECT_MIRROR].map((m) => ({ ...m }))
}

/**
 * 构造 GitHub API 地址：镜像前缀 + 官方 API 地址。
 * 例：buildApiUrl(ghproxy, '/repos/o/r/releases/latest')
 *  → `https://gh-proxy.com/https://api.github.com/repos/o/r/releases/latest`
 * direct 时前缀为空，结果就是官方地址本身。
 */
export function buildApiUrl(mirror: UpdateMirror, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`
  return `${mirror.prefix}${GITHUB_API_ORIGIN}${clean}`
}

/**
 * 把 Release 资源的 `browser_download_url` 改写成镜像地址。
 * direct（空前缀）时原样返回。
 */
export function applyMirrorToAssetUrl(mirror: UpdateMirror, url: string): string {
  if (!mirror.prefix) return url
  return `${mirror.prefix}${url}`
}
