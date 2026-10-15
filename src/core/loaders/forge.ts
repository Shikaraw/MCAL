/**
 * Forge 安装器。
 *
 * 协议依据：
 *  - 官方 installer CLI：`java -jar <installer> --installClient <gameDir>`（reference 中
 *    HMCL 走的是自研 ForgeNewInstallTask/ForgeOldInstallTask 分支；我们首选官方 installer，
 *    手工回退才复用 HMCL 的解析逻辑）。
 *  - installer 形态判定与版本 json 抽取：reference/HMCL/.../download/forge/ForgeInstallTask.java
 *    （detectForgeInstallerType）、ForgeOldInstallTask.java（install.filePath → universal jar）、
 *    ForgeNewInstallTask.java（install_profile.libraries / maven 内嵌库 / processors）。
 *  - Forge maven 目录名规则 `<mcVersion>-<forgeVersion>`；1.8.9 之前（含 1.7.10）是
 *    `<mc>-<forge>-<mc>`（末尾重复一次 MC 版本），例如 `1.7.10-10.13.4.1614-1.7.10`。
 *    LoaderVersion.version 只暴露 forge 自身版本，maven 目录名单独保存。
 *  - 版本 id：`<mc>-forge-<forgeVersion>`（Forge 官方 installer 生成的版本目录名）。
 *  - promotions_slim.json 形如 {"homepage":"...","promos":{"1.20.1-latest":"47.2.0",...}}，
 *    用于标注 recommended / latest（HMCL 的 ForgeVersionRoot 里也有 promos 字段）。
 */

import { join } from 'node:path'
import { copyFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import type {
  Library,
  LoaderInstallRequest,
  LoaderInstallResult,
  LoaderVersion,
  VersionDetail
} from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import { BMCLAPI_ENDPOINTS, OFFICIAL_ENDPOINTS } from '@core/net/mirror'
import { DownloadManager } from '@core/net/downloader'
import type { VersionRepository } from '@core/mojang/version'
import { createRuleContext } from '@core/mojang/rules'
import { dedupeLibraries, libraryDownloadItems, resolveLibraries } from '@core/mojang/library'
import { compareVersions, mavenToPath, parseMavenName } from '@core/util/misc'
import { ensureDir, pathExists, writeFileAtomic } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import {
  detectInstallerKind,
  extractEmbeddedMavenFiles,
  readInstallProfile,
  resolveInstallerJava,
  runInstallerJar,
  type InstallerJarKind,
  type InstallerJarResult,
  type JavaProvider
} from './installer-jar'
import { forgeVersionId, parseLoaderVersionId } from './version-id'
import type { LoaderInstallDeps } from './index'

const log = logger.scoped('loader:forge')

export interface ForgeInstallerOptions {
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  repository: VersionRepository
  javaScanner: JavaProvider
}

export interface ForgeMavenVersionParts {
  /** MC 版本，例如 1.20.1 / 1.7.10 */
  mcVersion: string
  /** Forge 自身版本，例如 47.2.0 / 10.13.4.1614 */
  forgeVersion: string
  /** maven 目录名原串（1.7.10 时代带末尾 MC 重复） */
  mavenVersion: string
}

/**
 * 解析 Forge maven 目录名为 MC 版本 + Forge 版本。
 * 兼容两种形态：
 *   - `1.20.1-47.2.0`（现代）
 *   - `1.7.10-10.13.4.1614-1.7.10`（旧版目录名末尾重复 MC 版本）
 *   - `1.7.10-pre4-10.12.2.1121` / `1.7.10_pre4-...`（pre4 特殊版本）
 * 非 Forge 目录名（例如裸 `7.8.1.738`）返回 null。
 */
export function parseForgeMavenVersion(mavenVersion: string): ForgeMavenVersionParts | null {
  const raw = (mavenVersion ?? '').trim()
  if (!raw) return null
  const match = /^(\d+\.\d+(?:\.\d+)?(?:[-_]pre\d+)?)-(.+)$/.exec(raw)
  if (!match) return null
  const mcVersion = match[1].replace('_pre', '-pre')
  let rest = match[2]
  const suffix = `-${mcVersion}`
  if (rest.endsWith(suffix) && rest.length > suffix.length) rest = rest.slice(0, -suffix.length)
  if (!/^\d+(?:\.\d+)+/.test(rest)) return null
  return { mcVersion, forgeVersion: rest, mavenVersion: raw }
}

/** maven 目录名优选项：精确 `<mc>-<forge>` 最优，否则取更短的（带分支后缀的更长） */
function preferMavenDir(current: string | undefined, candidate: string, mcVersion: string, forgeVersion: string): boolean {
  const exact = `${mcVersion}-${forgeVersion}`
  if (candidate === exact) return true
  if (current === undefined) return true
  if (current === exact) return false
  return candidate.length < current.length
}

export class ForgeInstaller {
  protected readonly client: HttpClient
  protected readonly mirror: MirrorResolver
  protected readonly downloadManager: DownloadManager
  protected readonly repository: VersionRepository
  protected readonly javaScanner: JavaProvider
  /** 供子类覆盖（NeoForge 复用同一个安装流程） */
  protected readonly loaderType: 'forge' | 'neoforge' = 'forge'
  protected readonly displayName: string = 'Forge'

  private readonly mavenCache = new Map<string, { at: number; versions: string[] }>()
  private promosCache: { at: number; promos: Record<string, string> } | null = null
  private static readonly MAVEN_CACHE_TTL_MS = 10 * 60_000
  private static readonly PROMOS_CACHE_TTL_MS = 30 * 60_000

  constructor(opts: ForgeInstallerOptions) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.downloadManager = opts.downloadManager
    this.repository = opts.repository
    this.javaScanner = opts.javaScanner
  }

  /* ---------------- 地址 ---------------- */

  /** maven 仓库地址（已按镜像解析），例如 https://bmclapi2.bangbang93.com/maven */
  protected mavenBase(): string {
    return this.mirror.resolve(OFFICIAL_ENDPOINTS.forgeMaven, 'forge').replace(/\/+$/, '')
  }

  /** 官方 maven（用于镜像失败回退） */
  protected officialMavenBase(): string {
    return OFFICIAL_ENDPOINTS.forgeMaven
  }

  /** maven 中 artifact 的相对目录，例如 net/minecraftforge/forge */
  protected mavenArtifactPath(): string {
    return 'net/minecraftforge/forge'
  }

  /** installer jar 文件名：forge-<mavenDir>-installer.jar（NeoForge 覆写） */
  protected installerFileName(mavenDir: string): string {
    return `forge-${mavenDir}-installer.jar`
  }

  /** promotions_slim.json 地址（bmclapi 有自己的镜像） */
  protected promotionsUrl(): string {
    const mirror = this.mirror.get('forge')
    if (mirror === 'bmclapi') return BMCLAPI_ENDPOINTS.forgePromotions
    if (mirror === 'custom') {
      const base = this.mirror.customBase('forge')
      if (base) return `${base.replace(/\/+$/, '')}/forge/promotions_slim.json`
    }
    return OFFICIAL_ENDPOINTS.forgePromotions
  }

  /** 镜像地址失败时回退官方 maven 的等价地址 */
  protected mavenFallbackUrls(url: string): string[] {
    for (const base of [BMCLAPI_ENDPOINTS.forgeMaven, BMCLAPI_ENDPOINTS.neoforgeMaven]) {
      if (url.startsWith(base)) {
        const official = this.officialMavenBase()
        const replaced = url.replace(base, official)
        if (replaced !== url) return [replaced]
      }
    }
    return []
  }

  /* ---------------- 版本列表 ---------------- */

  /** 带镜像回退的文本获取 */
  protected async fetchText(path: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const primary = `${this.mavenBase()}/${path}`
    try {
      return await this.client.getText(primary, { signal: opts.signal })
    } catch (err) {
      const fallback = `${this.officialMavenBase()}/${path}`
      if (primary !== fallback && !opts.signal?.aborted) {
        log.warn(`maven 主源失败，回退官方：${fallback}（${err instanceof Error ? err.message : String(err)}）`)
        return await this.client.getText(fallback, { signal: opts.signal })
      }
      throw err
    }
  }

  /** GET {mavenBase}/{artifact}/maven-metadata.xml → <version> 列表（降序） */
  async listMavenVersions(opts: { refresh?: boolean } = {}): Promise<string[]> {
    return this.listMavenVersionsOf(this.mavenArtifactPath(), opts)
  }

  /** 指定 artifact 的 maven 目录列举（NeoForge 需要同时查 neoForge / legacy forge 两个 artifact） */
  protected async listMavenVersionsOf(artifactPath: string, opts: { refresh?: boolean } = {}): Promise<string[]> {
    const cached = this.mavenCache?.get(artifactPath)
    if (!opts.refresh && cached && Date.now() - cached.at < ForgeInstaller.MAVEN_CACHE_TTL_MS) {
      return cached.versions
    }
    const text = await this.fetchText(`${artifactPath}/maven-metadata.xml`)
    const versions: string[] = []
    for (const match of text.matchAll(/<version>([^<]+)<\/version>/g)) {
      const value = match[1].trim()
      if (value) versions.push(value)
    }
    if (versions.length === 0) throw new Error(`${this.displayName} maven-metadata.xml 未解析出任何版本（${artifactPath}）`)
    versions.sort((a, b) => compareVersions(b, a))
    this.mavenCache.set(artifactPath, { at: Date.now(), versions })
    return versions
  }

  /** promotions_slim.json → promos 映射 */
  protected async fetchPromotions(opts: { refresh?: boolean } = {}): Promise<Record<string, string>> {
    if (!opts.refresh && this.promosCache && Date.now() - this.promosCache.at < ForgeInstaller.PROMOS_CACHE_TTL_MS) {
      return this.promosCache.promos
    }
    const url = this.promotionsUrl()
    const raw = await this.client.getJson<{ promos?: Record<string, string> } & Record<string, unknown>>(url, {
      retries: 1
    })
    const promos = raw?.promos && typeof raw.promos === 'object' ? raw.promos : {}
    this.promosCache = { at: Date.now(), promos }
    return promos
  }

  /**
   * 版本列表：
   *  - 给定 gameVersion：maven 目录列举（过滤出该 MC 版本）+ promos 标注 recommended/latest
   *  - 未给定：只返回 promos 里的 (MC 版本, recommended/latest) 组合
   */
  async listVersions(gameVersion?: string, opts: { refresh?: boolean } = {}): Promise<LoaderVersion[]> {
    const promos = await this.fetchPromotions(opts).catch((err: unknown) => {
      log.warn(`获取 ${this.displayName} promotions 失败：${err instanceof Error ? err.message : String(err)}`)
      return {} as Record<string, string>
    })

    if (!gameVersion) {
      const out: LoaderVersion[] = []
      for (const [key, version] of Object.entries(promos)) {
        const match = /^(.+)-(latest|recommended)$/.exec(key)
        if (!match) continue
        out.push({
          loaderType: this.loaderType,
          version,
          gameVersion: match[1],
          stable: match[2] === 'recommended',
          label: match[2]
        })
      }
      out.sort(
        (a, b) => compareVersions(b.gameVersion, a.gameVersion) || compareVersions(b.version, a.version)
      )
      return out
    }

    const mavenVersions = await this.listMavenVersions(opts).catch((err: unknown) => {
      log.warn(`获取 ${this.displayName} maven 列表失败：${err instanceof Error ? err.message : String(err)}`)
      return [] as string[]
    })

    const byForgeVersion = new Map<string, LoaderVersion>()
    const mavenDirByForgeVersion = new Map<string, string>()
    for (const raw of mavenVersions) {
      const parsed = parseForgeMavenVersion(raw)
      if (!parsed || parsed.mcVersion !== gameVersion) continue
      if (preferMavenDir(mavenDirByForgeVersion.get(parsed.forgeVersion), raw, parsed.mcVersion, parsed.forgeVersion)) {
        mavenDirByForgeVersion.set(parsed.forgeVersion, raw)
      }
      if (!byForgeVersion.has(parsed.forgeVersion)) {
        byForgeVersion.set(parsed.forgeVersion, {
          loaderType: this.loaderType,
          version: parsed.forgeVersion,
          gameVersion,
          stable: false
        })
      }
    }

    const recommended = promos[`${gameVersion}-recommended`]
    const latest = promos[`${gameVersion}-latest`]
    const ensureEntry = (version: string, label: string, stable: boolean): void => {
      const existing = byForgeVersion.get(version)
      if (existing) {
        existing.label = existing.label ? `${existing.label}+${label}` : label
        existing.stable = existing.stable || stable
      } else {
        byForgeVersion.set(version, { loaderType: this.loaderType, version, gameVersion, stable, label })
      }
    }
    if (recommended) ensureEntry(recommended, 'recommended', true)
    if (latest) ensureEntry(latest, 'latest', false)

    const out = [...byForgeVersion.values()]
    for (const item of out) {
      const dir = mavenDirByForgeVersion.get(item.version) ?? `${gameVersion}-${item.version}`
      const base = `${this.mavenBase()}/${this.mavenArtifactPath()}/${dir}`
      item.installerUrl = `${base}/${this.installerFileName(dir)}`
    }
    // promos 标注的版本排前面（recommended → latest），其余按版本降序
    const rank = (v: LoaderVersion): number => (v.label?.includes('recommended') ? 0 : v.label?.includes('latest') ? 1 : 2)
    out.sort((a, b) => rank(a) - rank(b) || compareVersions(b.version, a.version))
    return out
  }

  /* ---------------- 安装 ---------------- */

  /** 目标版本 id（NeoForge 覆写） */
  protected versionIdFor(gameVersion: string, loaderVersion: string): string {
    return forgeVersionId(gameVersion, loaderVersion)
  }

  /** installer 下载地址（需要 maven 目录名；NeoForge 覆写） */
  protected async installerUrlFor(gameVersion: string, loaderVersion: string): Promise<string> {
    const dir = await this.resolveMavenDir(gameVersion, loaderVersion)
    return `${this.mavenBase()}/${this.mavenArtifactPath()}/${dir}/${this.installerFileName(dir)}`
  }

  /** 找到 forge 版本对应的 maven 目录名；列表不可用时退回 `<mc>-<forge>` */
  protected async resolveMavenDir(gameVersion: string, loaderVersion: string): Promise<string> {
    try {
      const mavenVersions = await this.listMavenVersions()
      let best: string | undefined
      for (const raw of mavenVersions) {
        const parsed = parseForgeMavenVersion(raw)
        if (!parsed || parsed.mcVersion !== gameVersion || parsed.forgeVersion !== loaderVersion) continue
        if (preferMavenDir(best, raw, parsed.mcVersion, parsed.forgeVersion)) best = raw
      }
      if (best) return best
    } catch (err) {
      log.warn(`maven 列表不可用，按现代命名推导安装地址：${err instanceof Error ? err.message : String(err)}`)
    }
    return `${gameVersion}-${loaderVersion}`
  }

  /** 校验请求里的基础版本是原版（Forge/NeoForge 不能叠在其它加载器上） */
  protected resolveBaseGameVersion(req: LoaderInstallRequest, warnings: string[]): string {
    const parsed = parseLoaderVersionId(req.versionId)
    if (parsed.loaderType === 'forge' || parsed.loaderType === 'neoforge') {
      warnings.push(`目标版本 ${req.versionId} 已经是 ${parsed.loaderType} 版本，将把 ${this.displayName} 安装在其父版本上进行覆盖`)
    } else if (parsed.loaderType === 'fabric' || parsed.loaderType === 'quilt' || parsed.loaderType === 'optifine') {
      throw new Error(`${this.displayName} 只能安装在原版版本上，目标 ${req.versionId} 是 ${parsed.loaderType} 版本`)
    }
    return parsed.gameVersion ?? req.versionId
  }

  /** 是否存在原版 client jar（只警告不阻塞：新版 installer 可能自行下载） */
  protected async vanillaJarPath(gameDir: string, gameVersion: string): Promise<string | null> {
    const direct = join(gameDir, 'versions', gameVersion, `${gameVersion}.jar`)
    if (await pathExists(direct)) return direct
    try {
      const resolved = await this.repository.resolve(gameDir, gameVersion, { allowNetwork: false })
      const viaParent = join(gameDir, 'versions', resolved.jarVersionId, `${resolved.jarVersionId}.jar`)
      if (await pathExists(viaParent)) return viaParent
    } catch {
      /* 继承链不完整时忽略 */
    }
    return null
  }

  /**
   * 安装 Forge：
   *  1. 下载官方 installer 到 `versions/<id>/`；
   *  2. 首选运行官方 installer（它负责下库、跑 processors、写版本 json）；
   *  3. 失败则回退手工安装（解析 install_profile / version.json，落盘库，写版本 json）；
   *  4. 最后校验版本 json 可解析，并把 mcalMeta 补进去。
   */
  async install(req: LoaderInstallRequest, deps: LoaderInstallDeps): Promise<LoaderInstallResult> {
    const warnings: string[] = []
    const loaderVersion = req.loaderVersion?.trim()
    if (!loaderVersion) throw new Error(`安装 ${this.displayName} 需要 loaderVersion`)

    const gameVersion = this.resolveBaseGameVersion(req, warnings)
    const versionId = this.versionIdFor(gameVersion, loaderVersion)

    // 原版 json 必须存在（手工安装与启动都依赖继承链）
    const vanillaJsonPath = this.repository.versionJsonPath(deps.gameDir, gameVersion)
    const vanilla = await this.repository.readVersionJson(deps.gameDir, gameVersion)
    if (!vanilla) {
      throw new Error(`安装 ${this.displayName} 前需要先安装原版 ${gameVersion}：缺少 ${vanillaJsonPath}`)
    }
    if (!(await this.vanillaJarPath(deps.gameDir, gameVersion))) {
      warnings.push(
        `未找到原版 client jar（versions/${gameVersion}/${gameVersion}.jar）：` +
          `新版 installer 可能自行下载，若 installer 失败请先安装原版 ${gameVersion}`
      )
    }

    /* 1. 下载 installer */
    const versionDir = this.repository.versionDir(deps.gameDir, versionId)
    await ensureDir(versionDir)
    const installerUrl = await this.installerUrlFor(gameVersion, loaderVersion)
    const installerPath = join(versionDir, this.installerFileName(`${gameVersion}-${loaderVersion}`))
    const fallbackUrls = this.mavenFallbackUrls(installerUrl)
    deps.onProgress?.({ phase: 'download', message: `下载 ${this.displayName} installer`, ratio: 0.05 })
    const downloadResult = await this.downloadManager.fetchFiles(
      `loader-${this.loaderType}-${versionId}`,
      `${this.displayName} installer`,
      [{ key: installerUrl, url: installerUrl, fallbackUrls: fallbackUrls.length ? fallbackUrls : undefined, dest: installerPath }],
      {
        signal: deps.signal,
        onProgress: (p) => deps.onProgress?.({ phase: 'download', message: DownloadManager.describeProgress(p), ratio: 0.05, download: p })
      }
    )
    if (!downloadResult.ok) {
      throw new Error(
        `下载 ${this.displayName} installer 失败：${downloadResult.failures.map((f) => `${f.url}（${f.error}）`).join('；')}`
      )
    }

    const installerKind = detectInstallerKind(installerPath)
    log.info(`${this.displayName} installer 形态：${installerKind}（${installerPath}）`)

    /* 2. 首选官方 installer */
    deps.onProgress?.({
      phase: 'installer',
      message: `运行 ${this.displayName} installer（联网下载库，可能需要数分钟）`,
      ratio: 0.15
    })
    // 注意：installer 抛错（例如没有可用 Java、installer 文件损坏）也要进入手工回退分支，
    // 因此这里统一 catch 成 ok:false 的结果（旧版 Forge 的手工流程不需要 Java）。
    let result: InstallerJarResult
    try {
      const javaPath = await resolveInstallerJava({
        java: this.javaScanner,
        javaPath: deps.javaPath,
        gameVersion,
        detail: vanilla,
        signal: deps.signal
      })
      result = await runInstallerJar({
        installerPath,
        gameDir: deps.gameDir,
        javaPath,
        side: 'client',
        signal: deps.signal,
        onOutput: (line) => deps.onProgress?.({ phase: 'installer', message: line, ratio: 0.5 })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`${this.displayName} installer 执行异常，转入手工安装回退：${message}`)
      result = { code: null, output: `installer 执行异常：${message}`, ok: false, installerKind }
    }
    if (deps.signal?.aborted) throw new Error(`${this.displayName} 安装已取消`)

    /* 3. 校验产物，失败则手工安装回退 */
    const expectedIds = this.installedCandidateIds(gameVersion, loaderVersion, versionId)
    let detail = await this.locateInstalledVersion(deps.gameDir, expectedIds)
    let files: string[] = [this.repository.versionJsonPath(deps.gameDir, versionId)]
    let usedManual = false

    if (result.ok && detail) {
      warnings.push(`installer 执行成功（kind=${result.installerKind}，退出码 0）`)
    } else {
      usedManual = true
      warnings.push(
        `官方 installer 未能完成安装（kind=${installerKind}，退出码 ${result.code ?? 'null'}），已回退到手工安装`
      )
      // installer 的 stdout/stderr 必须回传（供 Agent 诊断），最多 40 行
      if (result.output.trim()) {
        warnings.push(`installer 输出尾部：\n${result.output.split('\n').slice(-40).join('\n')}`)
      }
      const manual = await this.manualInstall({
        installerPath,
        gameDir: deps.gameDir,
        versionId,
        gameVersion,
        loaderVersion,
        installerKind: result.installerKind,
        installerOutput: result.output,
        deps,
        warnings
      })
      detail = manual.detail
      files = manual.files
    }

    /* 4. 规范 id / 补 mcalMeta / 校验 */
    if (!detail) {
      throw new Error(
        `${this.displayName} ${loaderVersion} 安装失败：installer 与手工回退都没有生成版本 json。\n` +
          `installer 输出尾部：\n${result.output}`
      )
    }
    const normalized: VersionDetail = {
      ...detail,
      id: versionId,
      inheritsFrom: detail.inheritsFrom ?? gameVersion,
      mcalMeta: {
        ...(detail.mcalMeta ?? {}),
        loaderType: this.loaderType,
        loaderVersion,
        installedAt: new Date().toISOString(),
        source: usedManual ? `${this.loaderType}-installer-manual` : `${this.loaderType}-installer`,
        notes: detail.id !== versionId ? `原始 id=${detail.id}` : undefined
      }
    }
    const jsonPath = await this.repository.writeVersionJson(deps.gameDir, normalized)
    if (usedManual) {
      files = [...new Set([jsonPath, ...files])]
    } else {
      // installer 可能还生成了版本目录内的 jar（旧版 Forge 的 patched client jar）
      const installedJar = join(this.repository.versionDir(deps.gameDir, versionId), `${versionId}.jar`)
      files = [jsonPath]
      if (await pathExists(installedJar)) files.push(installedJar)
    }
    if (normalized.inheritsFrom !== gameVersion) {
      warnings.push(`版本 json 的 inheritsFrom 已修正为 ${gameVersion}`)
    }

    // 最终校验：必须能从磁盘读回且可解析
    const verify = await this.repository.readVersionJson(deps.gameDir, versionId)
    if (!verify) {
      throw new Error(
        `安装后校验失败：${jsonPath} 不存在或无法解析。\ninstaller 输出尾部：\n${result.output || '(无输出)'}`
      )
    }

    deps.onProgress?.({ phase: 'done', message: `${this.displayName} ${loaderVersion} 安装完成`, ratio: 1 })
    if (req.createInstance) {
      log.info(`版本 ${versionId} 已就绪，供上层创建实例（instanceName=${req.instanceName ?? '-'}）`)
    }
    return { versionId, loaderType: this.loaderType, loaderVersion, files, warnings }
  }

  /** 可能的 installer 产物目录名（不同版本 installer 生成不同 id） */
  protected installedCandidateIds(gameVersion: string, loaderVersion: string, targetId: string): string[] {
    return [
      targetId,
      `${gameVersion}-forge-${loaderVersion}`,
      `${gameVersion}-Forge${loaderVersion}`,
      `${gameVersion}-Forge${loaderVersion}-${gameVersion}`
    ]
  }

  /**
   * 在候选 id 中寻找 installer 生成的真实版本目录，并迁移到目标 id。
   * 说明：旧版 Forge installer（1.7.10 等）生成的目录名带大写 Forge、甚至末尾重复 MC 版本，
   * 而官方 launcher 的规范命名是 `<mc>-forge-<ver>`；这里只做「复制 + 改写 id」，
   * 不删除旧目录（避免误删用户既有版本），并在 warnings 里说明。
   */
  protected async locateInstalledVersion(gameDir: string, candidateIds: string[]): Promise<VersionDetail | null> {
    for (const id of candidateIds) {
      const detail = await this.repository.readVersionJson(gameDir, id)
      if (!detail) continue
      if (id === candidateIds[0]) return detail
      // 迁移到规范目录
      const migrated: VersionDetail = { ...detail, id: candidateIds[0] }
      await this.repository.writeVersionJson(gameDir, migrated)
      const srcDir = this.repository.versionDir(gameDir, id)
      const srcJar = join(srcDir, `${id}.jar`)
      if (await pathExists(srcJar)) {
        await copyFile(srcJar, join(this.repository.versionDir(gameDir, candidateIds[0]), `${candidateIds[0]}.jar`))
      }
      log.warn(`installer 生成的版本目录 ${id} 已复制为规范 id ${candidateIds[0]}（原目录保留）`)
      return migrated
    }
    return null
  }

  /* ---------------- 手工回退 ---------------- */

  protected async manualInstall(ctx: {
    installerPath: string
    gameDir: string
    versionId: string
    gameVersion: string
    loaderVersion: string
    installerKind: InstallerJarKind
    installerOutput: string
    deps: LoaderInstallDeps
    warnings: string[]
  }): Promise<{ detail: VersionDetail; files: string[] }> {
    const { installerPath, gameDir, versionId, gameVersion, deps, warnings } = ctx
    const files: string[] = []
    const info = readInstallProfile(installerPath)
    let detail = info.versionJson
    if (!detail) {
      throw new Error(
        `无法从 installer 中提取版本 json（install_profile.json ${info.profile ? '存在但缺少 versionInfo/version.json' : '缺失'}）。\n` +
          `installer 输出尾部：\n${ctx.installerOutput || '(无输出)'}`
      )
    }

    const librariesDir = join(gameDir, 'libraries')
    // 现代 installer 把 processors 依赖打包在 maven/ 下（HMCL ForgeNewInstallTask#preExecute 同款处理）
    if (info.spec >= 1) {
      const extracted = await extractEmbeddedMavenFiles(installerPath, librariesDir)
      // files 只回传前 20 个，避免超长列表淹没诊断信息（完整数量在 warning 里）
      files.push(...extracted.slice(0, 20))
      if (extracted.length > 0) {
        warnings.push(`已从 installer 中解出 ${extracted.length} 个内嵌 maven 库到 libraries/`)
      }
    }

    // 新版 install_profile 的 libraries（processors 依赖）；旧版没有该字段
    const profileLibraries: Library[] = []
    const profile = info.profile
    if (profile && Array.isArray(profile.libraries)) {
      for (const lib of profile.libraries as Library[]) {
        if (lib && typeof lib.name === 'string') profileLibraries.push(lib)
      }
    }

    // 旧形态：install.filePath 指向内嵌 universal jar，落到 install.path 的 maven 路径
    // （HMCL ForgeOldInstallTask 就是把 universal jar 写到该坐标对应的库文件路径）
    const install = profile && typeof profile.install === 'object' ? (profile.install as Record<string, unknown>) : null
    if (install && typeof install.path === 'string' && typeof install.filePath === 'string') {
      const coordinate = parseMavenName(install.path)
      if (coordinate) {
        const relative = mavenToPath(coordinate)
        const dest = join(librariesDir, relative)
        const extractedPath = await this.extractZipEntry(installerPath, install.filePath, dest)
        if (extractedPath) {
          files.push(extractedPath)
          profileLibraries.push({ name: install.path, url: `${this.officialMavenBase()}/` })
          warnings.push(`旧版 Forge：已把内嵌 ${install.filePath} 解压到 ${relative}`)
        } else {
          warnings.push(`旧版 Forge：installer 中未找到 ${install.filePath}，universal jar 缺失`)
        }
      }
    }

    const libraries = dedupeLibraries([...profileLibraries, ...(detail.libraries ?? [])])
    const merged: VersionDetail = {
      ...detail,
      id: versionId,
      // 手工安装必须补 inheritsFrom，否则启动时缺原版库与参数
      inheritsFrom: detail.inheritsFrom ?? gameVersion,
      libraries
    }
    const jsonPath = await this.repository.writeVersionJson(gameDir, merged)
    files.unshift(jsonPath)

    // 下载库（continueOnError：processor 产物的下载失败会以 warning 暴露，而不是中断）
    const resolved = resolveLibraries(libraries, {
      librariesDir,
      rules: createRuleContext(),
      mirror: this.mirror
    })
    const items = libraryDownloadItems(resolved)
    if (items.length > 0) {
      deps.onProgress?.({ phase: 'libraries', message: `补全 ${items.length} 个 ${this.displayName} 库`, ratio: 0.6 })
      const libResult = await this.downloadManager.fetchFiles(
        `loader-${this.loaderType}-libs-${versionId}`,
        `${this.displayName} 库`,
        items,
        {
          signal: deps.signal,
          continueOnError: true,
          onProgress: (p) => deps.onProgress?.({ phase: 'libraries', message: DownloadManager.describeProgress(p), ratio: 0.7, download: p })
        }
      )
      if (libResult.failures.length > 0) {
        warnings.push(
          `有 ${libResult.failures.length} 个库未能下载（processor 产物通常不在 maven 上，属预期）：` +
            libResult.failures
              .slice(0, 3)
              .map((f) => `${f.url.split('/').slice(-1)[0] || f.key}（${f.error.slice(0, 80)}）`)
              .join('；')
        )
      }
    }

    // processors 提示：Forge 1.13+ / 全部 NeoForge 依赖 processor 生成 patched client jar
    if (info.hasProcessors || ctx.installerKind === 'forge-new' || ctx.installerKind === 'neoforge') {
      warnings.push(this.manualProcessorWarning(gameDir, ctx.installerPath))
    } else {
      warnings.push('已按旧版 Forge 手工流程安装（无 processors，universal jar 已落盘）')
    }

    return { detail: merged, files }
  }

  /** processors 缺失警告文案（NeoForge 覆写为更明确的指引） */
  protected manualProcessorWarning(gameDir: string, installerPath: string): string {
    return (
      `手工安装未运行 installer 的 processors：Forge 1.13+ 的 patched client jar / 依赖变换由 processor 生成，` +
      `跳过它们后游戏很可能无法启动。请在有网络的环境重新安装，或手动执行：` +
      `java -jar "${installerPath}" --installClient "${gameDir}"`
    )
  }

  /** 从 installer zip 里解压单个条目到 dest */
  protected async extractZipEntry(installerPath: string, entryName: string, dest: string): Promise<string | null> {
    try {
      const zip = new AdmZip(installerPath)
      const entry = zip.getEntry(entryName) ?? zip.getEntry(entryName.replace(/\\/g, '/'))
      if (!entry) return null
      // writeFileAtomic 会自行创建父目录
      await writeFileAtomic(dest, entry.getData())
      return dest
    } catch (err) {
      log.warn(`解压 installer 条目失败：${entryName}（${err instanceof Error ? err.message : String(err)}）`)
      return null
    }
  }
}
