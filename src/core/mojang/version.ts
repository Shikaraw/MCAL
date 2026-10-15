/**
 * 版本 json 的继承合并与本地仓库。
 *
 * Minecraft 的版本 json 支持 inheritsFrom 继承（Forge/OptiFine 等加载器都依赖它）：
 * 子版本 json 只写自己「新增」或「覆盖」的部分，其余字段从父版本继承。
 * 合并语义是启动器正确性的核心，特别是：
 *  - libraries 按 group:artifact 去重，子版本覆盖同 artifact 的父库；
 *  - arguments.game / arguments.jvm 是「拼接」（父在前），不是覆盖；
 *  - 老格式 minecraftArguments（1.12 及以前）子有则覆盖父，且合并后必须转换成
 *    arguments.game 的等价 token 列表，否则启动参数会丢；
 *  - client jar 属于继承链中实际携带 downloads.client 的那个版本（通常是原版根版本），
 *    所以 ResolvedVersion 单独给出 jarVersionId / hasOwnJar，下载与启动都不能想当然用目标版本 id。
 */

import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { InstalledVersion, VersionDetail } from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import { fileSize, pathExists, readdir, readJsonSafe, stat, writeJson } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { KeyedLock } from '@core/util/misc'
import { dedupeLibraries } from './library'
import type { VersionManifestService } from './manifest'

const log = logger.scoped('mojang:version')

export interface ResolvedVersion {
  id: string
  /** 继承链：从最底层父版本到目标版本 */
  chain: string[]
  /** 合并后的完整版本（已合并 libraries/arguments/mainClass/downloads/assets/javaVersion） */
  detail: VersionDetail
  /** client.jar 实际所在的版本 id（继承时是父版本） */
  jarVersionId: string
  /** 该版本是否有自己的 client jar */
  hasOwnJar: boolean
}

/**
 * 旧格式参数串的切分（供 convertLegacyArguments 使用）。
 *
 * 为什么不能直接 `split(/\s+/)`：
 *  - 旧版 json 偶尔会把带空格的取值用引号包起来（例如 `--version "1.20 (test)"`），
 *    引号内的空格不能作为分隔符，引号本身要去掉；
 *  - `${...}` 占位符必须整体保留（不展开、不按空格拆开），它是启动时替换的变量。
 */
export function tokenizeLegacyArguments(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let hasValue = false
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        i++
      } else if (ch === '$' && input[i + 1] === '{') {
        const end = input.indexOf('}', i + 2)
        if (end > 0) {
          current += input.slice(i, end + 1)
          i = end + 1
        } else {
          current += ch
          i++
        }
      } else {
        current += ch
        i++
      }
      hasValue = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasValue = true
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (hasValue) {
        tokens.push(current)
        current = ''
        hasValue = false
      }
      i++
      continue
    }
    if (ch === '$' && input[i + 1] === '{') {
      const end = input.indexOf('}', i + 2)
      if (end > 0) {
        current += input.slice(i, end + 1)
        hasValue = true
        i = end + 1
      } else {
        current += ch
        hasValue = true
        i++
      }
      continue
    }
    current += ch
    hasValue = true
    i++
  }
  if (hasValue) tokens.push(current)
  return tokens
}

/**
 * 把旧格式 `minecraftArguments` 转成 `arguments.game` 的等价 token 列表。
 *
 * 背景：1.12.2 及以前（以及一部分加载器的 v1 profile）用一整条命令行字符串描述游戏参数，
 * 没有 arguments 字段；下游统一按 arguments.game 取参数，所以合并后必须补齐。
 * 转换条件按规范只在「没有 arguments.game」时进行：少数 json 同时给出两者时，
 * 视为明确使用新格式，保持原样（minecraftArguments 字段仍然保留，供启动流程参考）。
 */
export function convertLegacyArguments(detail: VersionDetail): VersionDetail {
  const legacy = detail.minecraftArguments
  if (!legacy) return detail
  if (detail.arguments?.game && detail.arguments.game.length > 0) return detail
  const game = tokenizeLegacyArguments(legacy)
  if (game.length === 0) return detail
  return { ...detail, arguments: { ...(detail.arguments ?? {}), game } }
}

/**
 * 合并父、子两份版本 json（child 覆盖 parent 的适用部分）。
 * 返回的对象是一个「扁平化」的完整版本：不再带 inheritsFrom，
 * 调用方（启动 / 安装）不应该也不需要再解析继承链。
 */
export function mergeVersionDetail(parent: VersionDetail, child: VersionDetail): VersionDetail {
  // 先浅合并，保留双方所有未知字段（加载器自定义元数据不能丢）；
  // 值为 undefined 的子字段不参与覆盖，避免把父版本的有效值抹掉。
  const childDefined: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined) childDefined[key] = value
  }
  const merged = { ...parent, ...childDefined } as VersionDetail

  merged.id = child.id || parent.id
  // 标量字段：子在则有则覆盖
  if (child.mainClass !== undefined) merged.mainClass = child.mainClass
  if (child.type !== undefined) merged.type = child.type
  if (child.assets !== undefined) merged.assets = child.assets
  if (child.assetIndex !== undefined) merged.assetIndex = child.assetIndex
  if (child.javaVersion !== undefined) merged.javaVersion = child.javaVersion
  if (child.releaseTime !== undefined) merged.releaseTime = child.releaseTime
  if (child.time !== undefined) merged.time = child.time
  if (child.complianceLevel !== undefined) merged.complianceLevel = child.complianceLevel
  if (parent.downloads || child.downloads) {
    // downloads 是「字段级覆盖」：子版本没有 client 时父版本的 client 仍然可见，
    // 这正是 jarVersionId 存在的原因 —— 安装时不能用合并结果里的 client 决定落地目录。
    merged.downloads = { ...(parent.downloads ?? {}), ...(child.downloads ?? {}) }
  }
  if (parent.mcalMeta || child.mcalMeta) {
    merged.mcalMeta = { ...(parent.mcalMeta ?? {}), ...(child.mcalMeta ?? {}) }
  }

  // 库：父在前子在后，按 group:artifact 去重（后出现的覆盖先出现的）
  if (parent.libraries?.length || child.libraries?.length) {
    merged.libraries = dedupeLibraries([...(parent.libraries ?? []), ...(child.libraries ?? [])])
  }

  // 启动参数：game / jvm 分别拼接（父在前），这是 Mojang 的合并语义
  const game = [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])]
  const jvm = [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])]
  if (parent.arguments || child.arguments) merged.arguments = { game, jvm }

  // 旧格式 minecraftArguments：子有则覆盖父。合并完成后若链上只有 minecraftArguments
  // 而没有 arguments.game，必须转换成 arguments.game 等价形式（见 convertLegacyArguments），
  // 否则只认 arguments 的启动流程会完全丢掉基础命令（--username / --tweakClass …）。
  const legacy = child.minecraftArguments !== undefined ? child.minecraftArguments : parent.minecraftArguments
  if (typeof legacy === 'string') merged.minecraftArguments = legacy

  // 合并结果不再保留 inheritsFrom，防止下游误以为还需要再解析一次继承链
  delete merged.inheritsFrom
  return convertLegacyArguments(merged)
}

export class VersionRepository {
  private readonly manifest: VersionManifestService
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly locks = new KeyedLock()

  constructor(opts: { manifest: VersionManifestService; client: HttpClient; mirror: MirrorResolver }) {
    this.manifest = opts.manifest
    this.client = opts.client
    this.mirror = opts.mirror
  }

  versionDir(gameDir: string, versionId: string): string {
    return join(gameDir, 'versions', versionId)
  }

  versionJsonPath(gameDir: string, versionId: string): string {
    return join(this.versionDir(gameDir, versionId), `${versionId}.json`)
  }

  async readVersionJson(gameDir: string, versionId: string): Promise<VersionDetail | null> {
    const path = this.versionJsonPath(gameDir, versionId)
    const detail = await readJsonSafe<VersionDetail | null>(path, null)
    if (!detail || typeof detail !== 'object' || typeof detail.id !== 'string') return null
    return detail
  }

  async writeVersionJson(gameDir: string, detail: VersionDetail): Promise<string> {
    const path = this.versionJsonPath(gameDir, detail.id)
    // 同一版本 json 可能被多个安装流程并发写入，串行化避免半写状态
    return this.locks.run(path, async () => {
      await writeJson(path, detail)
      return path
    })
  }

  /** 本地不存在则联网获取（用于加载器安装后的补全 / 原版首次安装） */
  async ensureVersionJson(gameDir: string, versionId: string, opts: { allowNetwork?: boolean } = {}): Promise<VersionDetail> {
    const local = await this.readVersionJson(gameDir, versionId)
    if (local) return local
    if (opts.allowNetwork === false) {
      throw new Error(`本地缺少版本 ${versionId} 的 json（${this.versionJsonPath(gameDir, versionId)}），且已禁止联网补全`)
    }
    const detail = await this.manifest.fetchVersionDetail(versionId)
    await this.writeVersionJson(gameDir, detail)
    log.info(`已缓存版本 json：${versionId} → ${this.versionJsonPath(gameDir, versionId)}`)
    return detail
  }

  /** 解析继承链并合并，返回完整可用版本 */
  async resolve(gameDir: string, versionId: string, opts: { allowNetwork?: boolean } = {}): Promise<ResolvedVersion> {
    const allowNetwork = opts.allowNetwork !== false
    const nodes: VersionDetail[] = [] // 顺序：目标版本 → 父版本 → … → 最底层父版本
    const seen = new Set<string>()
    let cursor: string | undefined = versionId
    while (cursor) {
      if (seen.has(cursor)) {
        throw new Error(`版本继承链存在循环：${[...seen, cursor].join(' → ')}`)
      }
      if (seen.size >= 20) {
        throw new Error(`版本继承链过深（超过 20 层），已中止：${versionId}`)
      }
      seen.add(cursor)
      const node: VersionDetail | null = allowNetwork
        ? await this.ensureVersionJson(gameDir, cursor)
        : await this.readVersionJson(gameDir, cursor)
      if (!node) {
        throw new Error(`解析版本 ${versionId} 失败：本地缺少 ${cursor} 的 json（${this.versionJsonPath(gameDir, cursor)}）`)
      }
      nodes.push(node)
      cursor = node.inheritsFrom
    }

    // 从最底层父版本开始逐级合并
    const chain = [...nodes].reverse()
    const detail = chain.reduce<VersionDetail>(
      (acc, node, index) => (index === 0 ? node : mergeVersionDetail(acc, node)),
      chain[0]
    )

    // client jar 在继承链中「最靠近目标」且携带 downloads.client 的版本里；
    // 目标自己带就是目标（hasOwnJar=true），否则落在父版本上。
    let jarVersionId = nodes[nodes.length - 1].id
    let hasOwnJar = false
    for (const node of nodes) {
      if (node.downloads?.client?.url) {
        jarVersionId = node.id
        hasOwnJar = node === nodes[0]
        break
      }
    }

    if (chain.length > 1) {
      log.debug(`版本继承链：${chain.map((n) => n.id).join(' → ')}（jar 来自 ${jarVersionId}）`)
    }
    return { id: versionId, chain: chain.map((n) => n.id), detail, jarVersionId, hasOwnJar }
  }

  /** 扫描游戏目录下的本地版本 */
  async listLocalVersions(gameDir: string): Promise<InstalledVersion[]> {
    const versionsDir = join(gameDir, 'versions')
    let entries: Dirent[]
    try {
      entries = await readdir(versionsDir, { withFileTypes: true })
    } catch {
      return []
    }

    const out: InstalledVersion[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const dir = join(versionsDir, id)
      const jsonPath = join(dir, `${id}.json`)
      const detail = await readJsonSafe<VersionDetail | null>(jsonPath, null)
      const valid = !!detail && typeof detail === 'object' && typeof detail.id === 'string'

      const ownJar = join(dir, `${id}.jar`)
      let jarPath: string | undefined
      let sizeBytes = await fileSize(jsonPath)
      if (await pathExists(ownJar)) {
        jarPath = ownJar
        sizeBytes += await fileSize(ownJar)
      } else if (detail?.inheritsFrom) {
        // 加载器版本通常没有自己的 jar，jar 落在父版本目录
        const parentJar = join(versionsDir, detail.inheritsFrom, `${detail.inheritsFrom}.jar`)
        if (await pathExists(parentJar)) jarPath = parentJar
      }

      let installedAt = new Date(0).toISOString()
      try {
        installedAt = new Date((await stat(jsonPath)).mtimeMs).toISOString()
      } catch {
        /* json 缺失时保持 epoch */
      }

      const gameVersion = valid ? await this.rootGameVersion(versionsDir, detail!) : id
      out.push({
        id,
        gameVersion,
        loaderType: detail?.mcalMeta?.loaderType ?? (detail?.inheritsFrom ? 'custom' : 'vanilla'),
        loaderVersion: detail?.mcalMeta?.loaderVersion,
        dir,
        jarPath,
        jsonPath: valid ? jsonPath : undefined,
        installedAt,
        // 实例引用关系由上层（实例管理器）填充
        usedByInstances: [],
        sizeBytes,
        valid,
        error: valid ? undefined : `版本 json 缺失或无法解析：${jsonPath}`
      })
    }
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  /**
   * 补全 vanilla 版本缺失的 downloads.client（老版本 json 或加载器版本继承）。
   * 查找顺序：本地父版本 json → 联网获取父版本（可继续向上追溯）→ bmclapi 直链兜底。
   * 返回的是副本，不会就地修改传入的 detail。
   */
  async ensureClientDownload(gameDir: string, detail: VersionDetail): Promise<VersionDetail> {
    if (detail.downloads?.client?.url) return detail

    const tried = new Set<string>()
    let cursor: string | undefined = detail.inheritsFrom ?? detail.id
    while (cursor && !tried.has(cursor)) {
      tried.add(cursor)
      let node = await this.readVersionJson(gameDir, cursor)
      if (!node) {
        try {
          node = await this.manifest.fetchVersionDetail(cursor)
        } catch (err) {
          log.warn(`获取 ${cursor} 的版本 json 失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (node) {
        if (node.downloads?.client?.url) {
          return { ...detail, downloads: { ...(detail.downloads ?? {}), client: node.downloads.client } }
        }
        cursor = node.inheritsFrom
        continue
      }
      cursor = undefined
    }

    if (this.mirror.get('mojang') === 'bmclapi') {
      // 版本 json 里确实没有下载信息（极老版本）时，bmclapi 的 /version/<id>/client
      // 仍然可用；此时没有 sha1 可校验，只能尽力而为并告警。
      const sourceId = detail.inheritsFrom ?? detail.id
      log.warn(`版本 ${detail.id} 缺少 downloads.client，回退 BMCLAPI 直链（无哈希校验）`)
      return {
        ...detail,
        downloads: { ...(detail.downloads ?? {}), client: { url: this.mirror.bmclapiClientJar(sourceId) } }
      }
    }

    throw new Error(`版本 ${detail.id} 缺少客户端下载信息（downloads.client），无法完成安装`)
  }

  /** 沿本地 inheritsFrom 链找到真正的游戏版本号（原版根版本 id） */
  private async rootGameVersion(versionsDir: string, detail: VersionDetail, depth = 0): Promise<string> {
    if (!detail.inheritsFrom || depth > 12) return detail.id
    const parentId = detail.inheritsFrom
    const parent = await readJsonSafe<VersionDetail | null>(join(versionsDir, parentId, `${parentId}.json`), null)
    if (!parent || typeof parent.id !== 'string') return parentId
    return this.rootGameVersion(versionsDir, parent, depth + 1)
  }
}
