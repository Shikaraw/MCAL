/**
 * 更新检查：查询 GitHub Releases、按更新源逐个回退、产出资产推荐。
 *
 * 从参考实现（StudyAgent 更新器）保留下来的实战经验：
 *  - 国内直连 api.github.com 经常整体超时，默认走公共加速前缀，逐个回退、命中即返回；
 *  - 仓库还没发版时 GitHub 返回 404 —— 这是正常状态，不能当报错吓用户；
 *  - Release 字段可能缺失、notes 可能很长，解析要健壮并截断。
 *
 * 本层不依赖 Electron，也不直接调用 fetch：抓取函数由调用方注入（FetchLike），
 * 因此可以用纯 vitest（假 fetch）覆盖全部逻辑。系统代理策略（settings.update.useSystemProxy）
 * 由调用方在构造 FetchLike 时决定，本层只把配置透传出去。
 */

import type { OsName, UpdateAsset, UpdateAttempt, UpdateCheckResult, UpdateMirror } from '@shared/types'
import { logger } from '@core/util/logger'
import { currentArch, currentOs } from '@core/util/misc'
import { applyMirrorToAssetUrl, buildApiUrl, resolveMirrors, type UpdateSourceSettings } from './mirrors'
import { isNewer, isSameVersion, parseVersion } from './version'

const log = logger.scoped('update')

/** 单次请求的默认超时（毫秒）：镜像很快，超过这个时间基本就是走不通 */
export const DEFAULT_TIMEOUT_MS = 12_000

/** 「最新 Release」的 notes 截断长度 */
export const NOTES_LIMIT = 8000

/** 版本历史里每条 Release 的 notes 截断长度 */
export const RELEASE_LIST_NOTES_LIMIT = 4000

/** 注入式抓取函数：返回状态码与文本，非 2xx 不抛错（由本层判定），网络失败才 reject */
export interface FetchLike {
  (url: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ status: number; text: string }>
}

/** 更新检查只读取设置里的这几个字段（结构化类型，便于测试注入） */
export interface UpdateCheckSettings extends UpdateSourceSettings {
  /** 启动时自动检查更新；显式 false 且非 manual 时直接返回 disabled */
  autoCheck?: boolean
  /** 是否让抓取走的系统代理（由调用方的 FetchLike 实现消费） */
  useSystemProxy?: boolean
  /** GitHub 仓库 slug，owner/repo */
  repo?: string
  /** 用户选择跳过的版本号 */
  skippedVersion?: string
  /** 上次检查时间（ISO），仅透传展示 */
  lastCheckAt?: string
}

/** 平台判定：默认取运行环境，测试可注入 */
export interface UpdatePlatform {
  os: OsName
  arch: string
}

export interface CheckOptions {
  fetch: FetchLike
  settings: { update: UpdateCheckSettings }
  currentVersion: string
  /** 手动检查时忽略「跳过此版本」与 autoCheck 开关 */
  manual?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /** 平台判定（测试注入），默认取运行环境 */
  platform?: UpdatePlatform
}

/** 在共享类型基础上补充检查层的信息（仍可直接当作 UpdateCheckResult 使用） */
export interface UpdateCheckResultWithMeta extends UpdateCheckResult {
  /** 命中的最新版本被用户在设置里跳过（此时 hasUpdate 已置 false） */
  skipped?: boolean
}

/** 版本历史里的一条 Release */
export interface ReleaseSummary {
  tag: string
  name: string
  /** 去掉 v 前缀后的版本号 */
  latestVersion: string
  publishedAt: string | null
  prerelease: boolean
  notes: string
  url: string
  assets: UpdateAsset[]
}

export interface ReleaseListResult {
  ok: boolean
  /** 命中的更新源名称 */
  source?: string
  sourceId?: string
  reason?: UpdateCheckResult['reason']
  message?: string
  releases: ReleaseSummary[]
  attempts: UpdateAttempt[]
  checkedAt: string
}

/* ------------------------------------------------------------------ *
 *  仓库 slug
 * ------------------------------------------------------------------ */

export interface RepoSlug {
  owner: string
  name: string
  /** 规范化后的 owner/repo */
  slug: string
}

/** 解析 `owner/repo`；容忍粘贴完整 GitHub 地址、结尾斜杠与 .git 后缀 */
export function parseRepoSlug(input: string): RepoSlug | null {
  const text = String(input ?? '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(text)
  if (!match) return null
  // 只由点组成的段（`..`）会被 URL 规范化吃掉，等于悄悄换成了另一个地址
  if (/^\.+$/.test(match[1]) || /^\.+$/.test(match[2])) return null
  return { owner: match[1], name: match[2], slug: `${match[1]}/${match[2]}` }
}

/* ------------------------------------------------------------------ *
 *  资产推荐
 * ------------------------------------------------------------------ */

/** 明显不是安装包、永不推荐的后缀（.zip 等归档可下载但不推荐，由平台规则排除） */
const NON_INSTALLER_SUFFIXES = [
  '.blockmap',
  '.yml',
  '.yaml',
  '.json',
  '.sig',
  '.asc',
  '.sha256',
  '.sha512',
  '.md5',
  '.txt'
]

const ARCH_TOKENS: Record<string, string[]> = {
  x64: ['x64', 'amd64', 'x86_64'],
  arm64: ['arm64', 'aarch64'],
  x86: ['ia32', 'i386', 'i686'],
  arm32: ['armv7']
}

/** 该资源名是否像本平台的安装包（只看扩展名，不含「首选/次选」判定） */
export function isInstallerAsset(name: string, platform: UpdatePlatform): boolean {
  const lower = String(name ?? '').toLowerCase().trim()
  if (!lower) return false
  if (NON_INSTALLER_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false
  if (platform.os === 'windows') return lower.endsWith('.exe')
  if (platform.os === 'osx') return lower.endsWith('.dmg')
  return lower.endsWith('.appimage')
}

/**
 * 安装包偏好打分（越高越合适，0 表示不作候选）：
 * Windows 上含 Setup/installer 的 .exe 最优先，其次任意 .exe；macOS 认 .dmg；Linux 认 .AppImage。
 */
export function assetPreferenceScore(name: string, platform: UpdatePlatform): number {
  if (!isInstallerAsset(name, platform)) return 0
  const lower = name.toLowerCase()
  let score = 1
  if (platform.os === 'windows' && /setup|installer|install|nsis/.test(lower)) score += 1
  return score
}

/** 文件名里是否提到当前架构（仅在打分相同时用于择优） */
function archMatchesName(name: string, arch: string): boolean {
  const tokens = ARCH_TOKENS[arch] ?? (arch ? [arch.toLowerCase()] : [])
  if (tokens.length === 0) return false
  const lower = name.toLowerCase()
  return tokens.some((token) => lower.includes(token))
}

/** 选出最推荐的资产索引；没有合适资源时返回 -1 */
export function pickRecommendedAsset(assets: readonly { name: string }[], platform: UpdatePlatform): number {
  let best = -1
  let bestScore = 0
  for (let i = 0; i < assets.length; i++) {
    const name = assets[i]?.name ?? ''
    const score = assetPreferenceScore(name, platform) + (archMatchesName(name, platform.arch) ? 0.5 : 0)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/* ------------------------------------------------------------------ *
 *  内部工具
 * ------------------------------------------------------------------ */

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  const text = String(err ?? '').trim()
  return text || '未知错误'
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function parseJsonArray(text: string): Record<string, unknown>[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
  } catch {
    return null
  }
}

/** 404 在各处的统一说法：仓库还没发版是正常状态 */
const NO_RELEASE_ERROR = '仓库中还没有发布任何 Release（HTTP 404）'

function statusError(status: number): string {
  return status === 404 ? NO_RELEASE_ERROR : `HTTP ${status}`
}

/** 把 Release JSON 里的 assets 数组转成共享类型，并标出本平台最推荐的一个 */
function parseAssets(raw: unknown, mirror: UpdateMirror, platform: UpdatePlatform): UpdateAsset[] {
  const list = Array.isArray(raw) ? raw : []
  const assets: UpdateAsset[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : ''
    const url = typeof record.browser_download_url === 'string' ? record.browser_download_url : ''
    if (!name || !url) continue
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0
    assets.push({
      name,
      size,
      url,
      // browser_download_url 是 github.com 地址，按当前命中的更新源改写
      mirrorUrl: applyMirrorToAssetUrl(mirror, url),
      recommended: false
    })
  }
  const best = pickRecommendedAsset(assets, platform)
  if (best >= 0) assets[best].recommended = true
  return assets
}

/** 构造失败结果：有任意一次 404 即视为「还没发版」 */
function failureResult(opts: {
  repo: string
  currentVersion: string
  attempts: UpdateAttempt[]
  reason: UpdateCheckResult['reason']
  message: string
}): UpdateCheckResultWithMeta {
  return {
    ok: false,
    repo: opts.repo,
    currentVersion: opts.currentVersion,
    reason: opts.reason,
    message: opts.message,
    attempts: opts.attempts,
    checkedAt: new Date().toISOString()
  }
}

/* ------------------------------------------------------------------ *
 *  检查更新
 * ------------------------------------------------------------------ */

/**
 * 查询最新 Release：逐个尝试解析出的更新源，命中即返回。
 *
 * 失败原因：任意一次 404 → `no-release`（仓库还没发版，正常状态）；
 * repo 配置不合法 → `bad-repo`；其余 → `network`。每次都记进 attempts。
 */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateCheckResultWithMeta> {
  const cfg = opts.settings?.update ?? {}
  const platform: UpdatePlatform = opts.platform ?? { os: currentOs(), arch: currentArch() }
  const repoRaw = String(cfg.repo ?? '').trim()
  const attempts: UpdateAttempt[] = []

  // 自动检查关闭时不再发请求；手动检查不受该开关影响
  if (!opts.manual && cfg.autoCheck === false) {
    log.debug('自动检查更新已关闭，跳过本次检查')
    return failureResult({
      repo: repoRaw,
      currentVersion: opts.currentVersion,
      attempts,
      reason: 'disabled',
      message: '自动检查更新已关闭：可在「设置 → 更新」中重新开启。'
    })
  }

  const slug = parseRepoSlug(repoRaw)
  if (!slug) {
    log.warn(`更新仓库配置不合法：${repoRaw || '(空)'}`)
    return failureResult({
      repo: repoRaw,
      currentVersion: opts.currentVersion,
      attempts,
      reason: 'bad-repo',
      message: `更新仓库配置不合法（应为 owner/repo 形式，当前为「${repoRaw || '空'}」）：请在「设置 → 更新」中修正。`
    })
  }

  const mirrors = resolveMirrors(cfg)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const path = `/repos/${slug.slug}/releases/latest`
  log.debug(`检查更新：${slug.slug}（当前 ${opts.currentVersion}，候选源 ${mirrors.map((m) => m.name).join(' → ')}）`)

  for (const mirror of mirrors) {
    const url = buildApiUrl(mirror, path)
    try {
      const response = await opts.fetch(url, { timeoutMs, signal: opts.signal })
      if (!isOkStatus(response.status)) {
        attempts.push({ source: mirror.name, error: statusError(response.status), statusCode: response.status })
        log.warn(`更新源 ${mirror.name} 返回异常：${statusError(response.status)}`)
        continue
      }
      const release = parseJsonObject(response.text)
      if (!release) {
        attempts.push({ source: mirror.name, error: '响应内容不是合法 JSON' })
        log.warn(`更新源 ${mirror.name} 响应不是合法 JSON，尝试下一个`)
        continue
      }
      // tag_name / name 都可能缺，两者都拿到才谈得上「版本」
      const tagName = String(release.tag_name ?? release.name ?? '').trim()
      if (!tagName) {
        attempts.push({ source: mirror.name, error: 'Release 缺少 tag_name 字段' })
        continue
      }

      const latestVersion = tagName.replace(/^v/i, '')
      const skipped = !opts.manual && isSameVersion(latestVersion, cfg.skippedVersion)
      const hasUpdate = isNewer(latestVersion, opts.currentVersion)
      if (parseVersion(latestVersion) === null) {
        // 不能静默当成「已是最新」：tag 写成 1.2.3.4 / release-1.2 这类时，用户会以为检查过了
        log.warn(`Release tag「${tagName}」无法解析成版本号，建议改成 v1.2.3 形式；本次判定为无更新`)
      }
      log.info(
        `检查更新成功（源=${mirror.name}）：最新 ${latestVersion}，当前 ${opts.currentVersion}` +
          (skipped ? '，该版本已被用户跳过' : hasUpdate ? '，有新版本' : '，已是最新')
      )
      return {
        ok: true,
        source: mirror.name,
        sourceId: mirror.id,
        repo: slug.slug,
        currentVersion: opts.currentVersion,
        latestVersion,
        tagName: String(release.tag_name ?? `v${latestVersion}`),
        hasUpdate: skipped ? false : hasUpdate,
        skipped,
        releaseUrl:
          typeof release.html_url === 'string' && release.html_url
            ? release.html_url
            : `https://github.com/${slug.slug}/releases`,
        notes: String(release.body ?? '').slice(0, NOTES_LIMIT),
        publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
        prerelease: release.prerelease === true,
        assets: parseAssets(release.assets, mirror, platform),
        message: skipped ? `最新版本 ${latestVersion} 已被你跳过；如需升级可在「设置 → 更新」中取消跳过。` : undefined,
        attempts,
        checkedAt: new Date().toISOString()
      }
    } catch (err) {
      const error = describeError(err)
      attempts.push({ source: mirror.name, error })
      log.warn(`更新源 ${mirror.name} 请求失败：${error}`)
    }
  }

  const everyAttempt404 = attempts.length > 0 && attempts.every((attempt) => attempt.statusCode === 404)
  if (everyAttempt404) {
    log.info('所有更新源均提示仓库还没有 Release（正常状态）')
    return failureResult({
      repo: slug.slug,
      currentVersion: opts.currentVersion,
      attempts,
      reason: 'no-release',
      message: '仓库中还没有发布任何 Release，暂无可更新的版本；发布后会自动提示。'
    })
  }
  // 只有部分源 404 时要当网络问题：镜像网关「没代理到就回 404」是常见行为，
  // 不能据此告诉用户「仓库还没发版」，那会把排查方向带偏
  const someAttempt404 = attempts.some((attempt) => attempt.statusCode === 404)
  log.warn(`检查更新失败：${attempts.length} 个更新源全部不可用`)
  return failureResult({
    repo: slug.slug,
    currentVersion: opts.currentVersion,
    attempts,
    reason: 'network',
    message: someAttempt404
      ? '更新源都不可用（其中部分返回 404，可能是镜像没有代理到，而不一定是仓库没发版）：可在「设置 → 更新」中切换更新源或改用直连。'
      : '无法连接到 GitHub（所有更新源均失败）：可在「设置 → 更新」中切换更新源，或稍后重试。'
  })
}

/* ------------------------------------------------------------------ *
 *  版本历史
 * ------------------------------------------------------------------ */

/** 拉取 Release 列表（供「版本历史」视图使用），同样逐个更新源回退 */
export async function listReleases(opts: CheckOptions & { limit?: number }): Promise<ReleaseListResult> {
  const cfg = opts.settings?.update ?? {}
  const platform: UpdatePlatform = opts.platform ?? { os: currentOs(), arch: currentArch() }
  const repoRaw = String(cfg.repo ?? '').trim()
  const attempts: UpdateAttempt[] = []
  const slug = parseRepoSlug(repoRaw)
  if (!slug) {
    return {
      ok: false,
      reason: 'bad-repo',
      message: `更新仓库配置不合法（应为 owner/repo 形式，当前为「${repoRaw || '空'}」）：请在「设置 → 更新」中修正。`,
      releases: [],
      attempts,
      checkedAt: new Date().toISOString()
    }
  }

  const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 10), 100))
  const mirrors = resolveMirrors(cfg)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const path = `/repos/${slug.slug}/releases?per_page=${limit}`

  for (const mirror of mirrors) {
    const url = buildApiUrl(mirror, path)
    try {
      const response = await opts.fetch(url, { timeoutMs, signal: opts.signal })
      if (!isOkStatus(response.status)) {
        attempts.push({ source: mirror.name, error: statusError(response.status), statusCode: response.status })
        continue
      }
      const list = parseJsonArray(response.text)
      if (!list) {
        attempts.push({ source: mirror.name, error: '响应内容不是合法的 JSON 数组' })
        continue
      }
      const releases: ReleaseSummary[] = []
      for (const item of list) {
        const tag = String(item.tag_name ?? '').trim()
        const name = String(item.name ?? '').trim()
        if (!tag && !name) continue
        releases.push({
          tag: tag || name,
          name: name || tag,
          latestVersion: (tag || name).replace(/^v/i, ''),
          publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
          prerelease: item.prerelease === true,
          notes: String(item.body ?? '').slice(0, RELEASE_LIST_NOTES_LIMIT),
          url: typeof item.html_url === 'string' ? item.html_url : `https://github.com/${slug.slug}/releases`,
          assets: parseAssets(item.assets, mirror, platform)
        })
      }
      log.info(`版本历史拉取成功（源=${mirror.name}）：${releases.length} 条`)
      return { ok: true, source: mirror.name, sourceId: mirror.id, releases, attempts, checkedAt: new Date().toISOString() }
    } catch (err) {
      attempts.push({ source: mirror.name, error: describeError(err) })
    }
  }

  const everyAttempt404 = attempts.length > 0 && attempts.every((attempt) => attempt.statusCode === 404)
  return {
    ok: false,
    reason: everyAttempt404 ? 'no-release' : 'network',
    message: everyAttempt404
      ? '仓库中还没有发布任何 Release。'
      : '无法连接到 GitHub（所有更新源均失败）：可在「设置 → 更新」中切换更新源，或稍后重试。',
    releases: [],
    attempts,
    checkedAt: new Date().toISOString()
  }
}
