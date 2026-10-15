/**
 * Modrinth API 客户端（v2）。
 *
 * 协议要点（依据 api.modrinth.com/v2 的公开文档）：
 *  - 搜索：GET /search?query=&facets=&limit=&offset=&index=
 *    facets 是「嵌套数组的 JSON 字符串」，外层数组之间是 AND、内层是 OR，
 *    例如 `[["project_type:mod"],["categories:fabric"],["versions:1.20.1"]]`，
 *    作为 query 参数时必须整体 URL 编码。加载器（fabric/forge/…）属于 categories facet。
 *    index 取值：relevance | downloads | updated | newest。
 *  - 版本：GET /project/{id|slug}/version?game_versions=["1.20.1"]&loaders=["fabric"]
 *    数组参数同样是 JSON 字符串。
 *  - 依赖：version.dependencies[] 里 dependency_type ∈ required|optional|incompatible|embedded。
 *  - 反查：POST /version_files  body { hashes: string[], algorithm: 'sha1'|'sha512' }，
 *    单次最多 1000 个哈希（超出必须分批）。
 *  - 速率限制：无 API Key 时约 300 请求/分钟；429 响应带 X-Ratelimit-Reset（距重置的秒数），
 *    因此这里做「最小间隔 120ms + 队列串行 + 429 读 header 退避重试」。
 *  - 镜像：api.modrinth.com 会被 MirrorResolver 映射到 BMCLAPI 的 /modrinth/v2 前缀，
 *    但 BMCLAPI 的该代理不保证覆盖全部端点；这里在镜像失败时自动回退官方地址，
 *    并把「该端点镜像不可用」的结论缓存下来，避免每次请求都白试一轮。
 */

import { join } from 'node:path'
import type {
  DownloadItem,
  LoaderType,
  ProjectDetail,
  ProjectSearchResult,
  ProjectType,
  ProjectVersion,
  ProjectVersionFile
} from '@shared/types'
import { HttpClient, HttpError } from '@core/net/http'
import { OFFICIAL_ENDPOINTS } from '@core/net/mirror'
import type { MirrorResolver } from '@core/net/mirror'
import { sleep } from '@core/util/misc'
import { logger } from '@core/util/logger'

const log = logger.scoped('modrinth')

/** Modrinth 官方 API 根地址（镜像由 MirrorResolver 处理） */
export const MODRINTH_API_BASE = OFFICIAL_ENDPOINTS.modrinthApi

const MIN_REQUEST_INTERVAL_MS = 120
const MAX_RATE_LIMIT_RETRIES = 3
const DEFAULT_CACHE_TTL_MS = 5 * 60_000

/** Modrinth 侧已知的加载器名（出现在 categories / loaders 字段里） */
const MODRINTH_LOADER_NAMES = new Set([
  'fabric',
  'quilt',
  'forge',
  'neoforge',
  'liteloader',
  'modloader',
  'rift',
  'iris',
  'optifine',
  'canvas',
  'vanilla',
  'minecraft'
])

/** 把 @shared 的 ProjectType 映射到 Modrinth 的 project_type 取值 */
export function mapProjectType(kind: ProjectType): string {
  switch (kind) {
    case 'mod':
      return 'mod'
    case 'modpack':
      return 'modpack'
    case 'resourcepack':
      return 'resourcepack'
    case 'shader':
      return 'shader'
    case 'datapack':
      return 'datapack'
    case 'plugin':
      return 'plugin'
    default:
      // Modrinth 目前没有 world 类型（返回 0 命中也在预期内）
      return 'world'
  }
}

/** 把 @shared 的 LoaderType 映射到 Modrinth 的加载器名；无对应返回 null（不加过滤） */
export function mapLoader(loader: LoaderType): string | null {
  switch (loader) {
    case 'fabric':
      return 'fabric'
    case 'quilt':
      return 'quilt'
    case 'forge':
      return 'forge'
    case 'neoforge':
      return 'neoforge'
    case 'liteloader':
      return 'liteloader'
    default:
      // vanilla / optifine / custom 在 Modrinth 没有对应的加载器 facet
      return null
  }
}

/**
 * 构造 facets 查询串（纯函数，便于测试）。
 * 返回 null 表示没有任何过滤条件（调用方不要带 facets 参数）。
 */
export function buildFacets(opts: {
  projectType?: ProjectType
  gameVersion?: string
  loader?: LoaderType
  categories?: string[]
}): string | null {
  const groups: string[][] = []
  if (opts.projectType) groups.push([`project_type:${mapProjectType(opts.projectType)}`])
  const loader = opts.loader ? mapLoader(opts.loader) : null
  if (loader) groups.push([`categories:${loader}`])
  if (opts.gameVersion) groups.push([`versions:${opts.gameVersion}`])
  for (const category of opts.categories ?? []) {
    const value = category.trim()
    if (value) groups.push([`categories:${value}`])
  }
  if (groups.length === 0) return null
  return JSON.stringify(groups)
}

/** 从 categories 里提取加载器名（Modrinth 把加载器也算作 category） */
export function extractLoaders(categories: string[]): string[] {
  return categories.filter((c) => MODRINTH_LOADER_NAMES.has(c.toLowerCase()))
}

/** 搜索响应 hits[] → ProjectSearchResult */
export function mapSearchHit(hit: Record<string, unknown>): ProjectSearchResult {
  const categories = toStringArray(hit.categories)
  const projectTypeRaw = typeof hit.project_type === 'string' ? hit.project_type : 'mod'
  const projectType = (
    ['mod', 'modpack', 'resourcepack', 'shader', 'datapack', 'plugin', 'world'].includes(projectTypeRaw)
      ? projectTypeRaw
      : 'mod'
  ) as ProjectType
  return {
    platform: 'modrinth',
    projectId: String(hit.project_id ?? hit.id ?? ''),
    slug: typeof hit.slug === 'string' ? hit.slug : undefined,
    title: typeof hit.title === 'string' ? hit.title : '',
    description: typeof hit.description === 'string' ? hit.description : '',
    // 搜索命中里 author 可能缺失；调用方需要时用 getProject 补
    author: typeof hit.author === 'string' && hit.author.length > 0 ? hit.author : undefined,
    downloads: toNumber(hit.downloads),
    follows: hit.follows === undefined ? undefined : toNumber(hit.follows),
    iconUrl: typeof hit.icon_url === 'string' ? hit.icon_url : undefined,
    categories,
    loaders: extractLoaders(categories),
    gameVersions: toStringArray(hit.versions),
    projectType,
    updatedAt: typeof hit.date_modified === 'string' ? hit.date_modified : undefined,
    license: typeof hit.license === 'string' ? hit.license : undefined
  }
}

/** /version 响应 → ProjectVersion */
export function mapVersion(raw: unknown): ProjectVersion {
  const v = asRecord(raw)
  const files: ProjectVersionFile[] = Array.isArray(v.files)
    ? v.files.map((item) => {
        const file = asRecord(item)
        return {
          url: String(file.url ?? ''),
          filename: String(file.filename ?? ''),
          size: toNumber(file.size),
          primary: file.primary === true,
          hashes: toStringRecord(file.hashes)
        }
      })
    : []
  const dependencies = Array.isArray(v.dependencies)
    ? v.dependencies.map((item) => {
        const dep = asRecord(item)
        return {
          projectId: dep.project_id === undefined || dep.project_id === null ? undefined : String(dep.project_id),
          versionId: dep.version_id === undefined || dep.version_id === null ? undefined : String(dep.version_id),
          dependencyType: typeof dep.dependency_type === 'string' ? dep.dependency_type : 'required'
        }
      })
    : []
  const versionType =
    v.version_type === 'release' || v.version_type === 'beta' || v.version_type === 'alpha'
      ? (v.version_type as ProjectVersion['versionType'])
      : 'release'
  return {
    platform: 'modrinth',
    versionId: String(v.id ?? ''),
    projectId: String(v.project_id ?? ''),
    name: typeof v.name === 'string' ? v.name : '',
    versionNumber: typeof v.version_number === 'string' ? v.version_number : '',
    versionType,
    gameVersions: toStringArray(v.game_versions),
    loaders: toStringArray(v.loaders),
    dependencies,
    files,
    publishedAt: typeof v.date_published === 'string' ? v.date_published : undefined,
    downloads: toNumber(v.downloads)
  }
}

/**
 * 从候选版本中挑最合适的一个：
 * 1. 若给定 gameVersion / loader，先按「命中优先」过滤（过滤后为空则回退全集，避免误杀）
 * 2. 版本类型 release > beta > alpha
 * 3. 下载量更大者优先
 * 4. 发布时间更晚者优先
 */
export function pickBestVersion(
  versions: readonly ProjectVersion[],
  opts: { gameVersion?: string; loader?: LoaderType } = {}
): ProjectVersion | null {
  let candidates = [...versions].filter((v) => v.versionId)
  if (candidates.length === 0) return null
  if (opts.gameVersion) {
    const filtered = candidates.filter((v) => v.gameVersions.includes(opts.gameVersion!))
    if (filtered.length > 0) candidates = filtered
  }
  if (opts.loader) {
    const loader = mapLoader(opts.loader)
    if (loader) {
      const filtered = candidates.filter((v) => v.loaders.some((l) => l.toLowerCase() === loader))
      if (filtered.length > 0) candidates = filtered
    }
  }
  const rank = (type: ProjectVersion['versionType']): number =>
    type === 'release' ? 3 : type === 'beta' ? 2 : 1
  candidates.sort((a, b) => {
    const byType = rank(b.versionType) - rank(a.versionType)
    if (byType !== 0) return byType
    const byDownloads = (b.downloads ?? 0) - (a.downloads ?? 0)
    if (byDownloads !== 0) return byDownloads
    return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')
  })
  return candidates[0]
}

/**
 * 镜像缓存键：把路径里的动态 id 替换为 *，用于「该端点镜像不可用」的记忆。
 * 例如 /v2/project/<id>/version 归一化为 v2/project/*\/version
 */
export function mirrorCacheKey(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  const idParents = new Set(['project', 'version', 'team', 'user'])
  return parts.map((part, index) => (index > 0 && idParents.has(parts[index - 1] ?? '') ? '*' : part)).join('/')
}

export interface ModrinthSearchOptions {
  query: string
  projectType?: ProjectType
  gameVersion?: string
  loader?: LoaderType
  categories?: string[]
  limit?: number
  offset?: number
  sortBy?: 'relevance' | 'downloads' | 'updated' | 'newest'
  signal?: AbortSignal
}

interface ModrinthSearchResponse {
  hits?: unknown[]
  total_hits?: number
  offset?: number
  limit?: number
}

export class ModrinthClient {
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly userAgent: string
  /** 已确认不支持镜像的端点（镜像键），避免每次请求都先打一次失败的镜像 */
  private readonly mirrorUnsupported = new Set<string>()
  private readonly cache = new Map<string, { expires: number; value: unknown }>()
  private queue: Promise<void> = Promise.resolve()
  private lastRequestAt = 0

  constructor(opts: { client: HttpClient; mirror: MirrorResolver; userAgent: string }) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.userAgent = opts.userAgent
  }

  /* -------------------- 公开 API -------------------- */

  async search(opts: ModrinthSearchOptions): Promise<{ hits: ProjectSearchResult[]; total: number }> {
    const facets = buildFacets({
      projectType: opts.projectType,
      gameVersion: opts.gameVersion,
      loader: opts.loader,
      categories: opts.categories
    })
    const params: Record<string, string> = {
      query: opts.query ?? '',
      limit: String(clamp(opts.limit ?? 20, 1, 100)),
      offset: String(Math.max(0, opts.offset ?? 0)),
      index: normalizeIndex(opts.sortBy)
    }
    if (facets) params.facets = facets
    const data = await this.request<ModrinthSearchResponse>('/search', { params, signal: opts.signal })
    const hits = (Array.isArray(data?.hits) ? data.hits : []).map((hit) => mapSearchHit(asRecord(hit)))
    return { hits, total: typeof data?.total_hits === 'number' ? data.total_hits : hits.length }
  }

  async getProject(projectId: string): Promise<ProjectDetail | null> {
    let data: Record<string, unknown>
    try {
      data = await this.request<Record<string, unknown>>(`/project/${encodeURIComponent(projectId)}`, {
        cacheKey: `project:${projectId}`,
        cacheTtlMs: 10 * 60_000
      })
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    }
    const base = mapSearchHit({ ...data, project_id: data.id, project_type: data.project_type })
    let author = typeof data.author === 'string' && data.author.length > 0 ? data.author : undefined
    if (!author && typeof data.team === 'string') {
      // 搜索接口不一定带 author，项目详情里只有 team id，需要再查一次成员取 owner
      author = await this.teamOwner(data.team).catch((err) => {
        log.debug(`获取团队 owner 失败：${err instanceof Error ? err.message : String(err)}`)
        return undefined
      })
    }
    const gallery: { url: string; title?: string }[] = []
    if (Array.isArray(data.gallery)) {
      for (const item of data.gallery) {
        const record = asRecord(item)
        if (typeof record.url !== 'string') continue
        gallery.push({
          url: record.url,
          title: typeof record.title === 'string' ? record.title : undefined
        })
      }
    }
    return {
      ...base,
      author,
      body: typeof data.body === 'string' ? data.body : undefined,
      issuesUrl: typeof data.issues_url === 'string' ? data.issues_url : undefined,
      sourceUrl: typeof data.source_url === 'string' ? data.source_url : undefined,
      gallery: gallery.length > 0 ? gallery : undefined
    }
  }

  async listVersions(opts: {
    projectId: string
    gameVersion?: string
    loader?: LoaderType
    limit?: number
  }): Promise<ProjectVersion[]> {
    const params: Record<string, string> = {}
    // game_versions / loaders 都是 JSON 数组字符串，必须整体编码
    if (opts.gameVersion) params.game_versions = JSON.stringify([opts.gameVersion])
    const loader = opts.loader ? mapLoader(opts.loader) : null
    if (loader) params.loaders = JSON.stringify([loader])
    const limit = clamp(opts.limit ?? 50, 1, 200)
    params.limit = String(limit)
    const data = await this.request<unknown[]>(`/project/${encodeURIComponent(opts.projectId)}/version`, {
      params,
      cacheKey: `versions:${opts.projectId}:${opts.gameVersion ?? '*'}:${loader ?? '*'}:${limit}`,
      cacheTtlMs: 3 * 60_000
    })
    return Array.isArray(data) ? data.map(mapVersion) : []
  }

  async getVersion(versionId: string): Promise<ProjectVersion | null> {
    try {
      const data = await this.request<Record<string, unknown>>(`/version/${encodeURIComponent(versionId)}`, {
        cacheKey: `version:${versionId}`,
        cacheTtlMs: 10 * 60_000
      })
      return mapVersion(data)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    }
  }

  /**
   * 递归解析依赖（BFS，默认两层）。
   * 只跟随 required（includeOptional 时含 optional）；incompatible/embedded 一律跳过
   * （前者是冲突声明，后者文件已内嵌在发布包里）。
   */
  async resolveDependencies(
    version: ProjectVersion,
    opts: { gameVersion?: string; loader?: LoaderType; includeOptional?: boolean; maxDepth?: number }
  ): Promise<{ version: ProjectVersion; reason: string }[]> {
    const maxDepth = Math.max(1, opts.maxDepth ?? 2)
    const allowed = new Set(opts.includeOptional ? ['required', 'optional'] : ['required'])
    const seenProjects = new Map<string, string>()
    seenProjects.set(version.projectId, version.versionId)
    const out: { version: ProjectVersion; reason: string }[] = []
    let frontier: { version: ProjectVersion; depth: number }[] = [{ version, depth: 0 }]

    while (frontier.length > 0) {
      const next: typeof frontier = []
      for (const node of frontier) {
        if (node.depth >= maxDepth) continue
        for (const dep of node.version.dependencies) {
          if (!allowed.has(dep.dependencyType)) continue
          let target: ProjectVersion | null = null
          if (dep.versionId) {
            target = await this.getVersion(dep.versionId)
          }
          const projectId = dep.projectId ?? target?.projectId
          if (!target && projectId) {
            const list = await this.listVersions({
              projectId,
              gameVersion: opts.gameVersion,
              loader: opts.loader,
              limit: 30
            })
            target = pickBestVersion(list, { gameVersion: opts.gameVersion, loader: opts.loader })
          }
          if (!target || !target.versionId) continue
          const targetProject = target.projectId || projectId || ''
          if (targetProject && seenProjects.has(targetProject)) continue
          if (targetProject) seenProjects.set(targetProject, target.versionId)
          const reason = `「${node.version.name || node.version.versionNumber || node.version.versionId}」的${dep.dependencyType === 'optional' ? '可选' : '必需'}依赖`
          out.push({ version: target, reason })
          next.push({ version: target, depth: node.depth + 1 })
        }
      }
      frontier = next
    }
    return out
  }

  /**
   * 生成下载项（目标目录与文件名由调用方决定）。
   * 注意：Modrinth 的文件由 cdn.modrinth.com 提供，BMCLAPI 的 /modrinth 前缀只代理 API，
   * 因此这里不放镜像备用地址，由下载器自身的重试机制处理。
   */
  buildDownloadItems(versions: ProjectVersion[], targetDir: string): DownloadItem[] {
    const items: DownloadItem[] = []
    const seenDest = new Set<string>()
    for (const version of versions) {
      const file = version.files.find((f) => f.primary && f.url) ?? version.files.find((f) => f.url)
      if (!file) continue
      const dest = join(targetDir, file.filename || `${version.versionId}.jar`)
      if (seenDest.has(dest)) continue
      seenDest.add(dest)
      items.push({
        key: `modrinth:${version.versionId}:${file.filename}`,
        url: file.url,
        dest,
        sha1: file.hashes?.sha1?.toLowerCase(),
        size: file.size > 0 ? file.size : undefined
      })
    }
    return items
  }

  /** 按哈希反查版本（Modrinth 支持 sha1/sha512）；单次最多 1000 个，超出自动分批。 */
  async lookupByHash(
    hashes: string[],
    algorithm: 'sha1' | 'sha512' = 'sha1'
  ): Promise<Record<string, { projectId: string; versionId: string } | null>> {
    const out: Record<string, { projectId: string; versionId: string } | null> = {}
    const unique = [...new Set(hashes.map((h) => h.trim().toLowerCase()).filter(Boolean))]
    for (let i = 0; i < unique.length; i += 1000) {
      const batch = unique.slice(i, i + 1000)
      const response = await this.request<Record<string, unknown>>('/version_files', {
        method: 'POST',
        body: { hashes: batch, algorithm }
      })
      for (const hash of batch) {
        const found = response?.[hash]
        const record = asRecord(found)
        out[hash] = found
          ? { projectId: String(record.project_id ?? ''), versionId: String(record.id ?? '') }
          : null
      }
    }
    return out
  }

  mapProjectType(kind: ProjectType): string {
    return mapProjectType(kind)
  }

  mapLoader(loader: LoaderType): string | null {
    return mapLoader(loader)
  }

  /* -------------------- 内部：请求管线 -------------------- */

  private async teamOwner(teamId: string): Promise<string | undefined> {
    const members = await this.request<unknown[]>(`/team/${encodeURIComponent(teamId)}/members`, {
      cacheKey: `team:${teamId}`,
      cacheTtlMs: 30 * 60_000
    })
    if (!Array.isArray(members) || members.length === 0) return undefined
    const parsed = members.map(asRecord)
    const owner = parsed.find((m) => m.role === 'owner') ?? parsed[0]
    const user = asRecord(owner.user)
    return typeof user.username === 'string' ? user.username : undefined
  }

  private request<T>(
    path: string,
    opts: {
      params?: Record<string, string>
      method?: 'GET' | 'POST'
      body?: unknown
      signal?: AbortSignal
      cacheKey?: string
      cacheTtlMs?: number
    }
  ): Promise<T> {
    const cacheKey = opts.cacheKey
    if (cacheKey) {
      const hit = this.cache.get(cacheKey)
      if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T)
    }
    const query = opts.params && Object.keys(opts.params).length > 0 ? `?${new URLSearchParams(opts.params).toString()}` : ''
    const official = `${MODRINTH_API_BASE}${path}${query}`
    const key = mirrorCacheKey(new URL(official).pathname)
    const mirrored = this.mirror.resolve(official, 'modrinth')
    const attempts: string[] = []
    if (mirrored !== official && !this.mirrorUnsupported.has(key)) attempts.push(mirrored)
    attempts.push(official)

    const run = async (): Promise<T> => {
      let lastError: Error | null = null
      for (const url of attempts) {
        try {
          const data = await this.send<T>(url, { method: opts.method ?? 'GET', body: opts.body, signal: opts.signal })
          if (cacheKey) {
            this.cache.set(cacheKey, { expires: Date.now() + (opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS), value: data })
          }
          return data
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (url !== official) {
            // 镜像端点不可用：记住结论并回退官方（BMCLAPI 的 modrinth 代理并不保证所有端点）
            this.mirrorUnsupported.add(key)
            log.warn(`Modrinth 镜像不可用（${key}），回退官方地址：${lastError.message}`)
            if (opts.signal?.aborted) throw lastError
          } else {
            throw lastError
          }
        }
      }
      throw lastError ?? new Error(`Modrinth 请求失败：${path}`)
    }
    return run()
  }

  /** 节流 + 429 退避；整个客户端的请求串行执行，保证最小间隔生效 */
  private send<T>(url: string, opts: { method: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
    const task = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        await this.waitSlot(opts.signal)
        const response = await this.client.raw(url, {
          method: opts.method,
          headers: { 'User-Agent': this.userAgent },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: opts.signal,
          allowError: true,
          expectJson: false
        })
        if (response.status === 429) {
          const resetRaw = Number(response.headers.get('x-ratelimit-reset') ?? '5')
          const resetSeconds = Number.isFinite(resetRaw) ? Math.max(resetRaw, 1) : 5
          if (attempt >= MAX_RATE_LIMIT_RETRIES) {
            throw new HttpError('Modrinth 触发速率限制（429），已重试多次', 429, url)
          }
          const waitMs = Math.min(resetSeconds * 1000, 30_000) + 250
          log.warn(`Modrinth 429：等待 ${Math.round(waitMs / 1000)}s 后重试（第 ${attempt + 1} 次）`)
          await sleep(waitMs, opts.signal)
          continue
        }
        if (!response.ok) {
          let bodyText: string | undefined
          try {
            bodyText = (await response.text()).slice(0, 300)
          } catch {
            /* ignore */
          }
          throw new HttpError(`Modrinth 请求失败 HTTP ${response.status}（${url}）`, response.status, url, bodyText)
        }
        const text = await response.text()
        if (!text) return undefined as T
        try {
          return JSON.parse(text) as T
        } catch {
          throw new Error(`Modrinth 响应不是合法 JSON：${text.slice(0, 120)}`)
        }
      }
    }
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async waitSlot(signal?: AbortSignal): Promise<void> {
    const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt)
    if (wait > 0) await sleep(wait, signal)
    this.lastRequestAt = Date.now()
  }

  /** 清理内存缓存（设置变更或需要强制刷新时调用） */
  clearCache(): void {
    this.cache.clear()
    this.mirrorUnsupported.clear()
  }
}

/* ------------------------------------------------------------------ *
 *  内部小工具
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(record)) if (typeof val === 'string') out[key] = val
  return Object.keys(out).length > 0 ? out : undefined
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeIndex(sortBy?: ModrinthSearchOptions['sortBy']): string {
  switch (sortBy) {
    case 'downloads':
      return 'downloads'
    case 'updated':
      return 'updated'
    case 'newest':
      return 'newest'
    default:
      return 'relevance'
  }
}
