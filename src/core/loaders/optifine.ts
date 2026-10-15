/**
 * OptiFine 安装器。
 *
 * 协议依据（逐条核对过参考源码）：
 *
 *  1. BMCLAPI 清单：`GET {optifine}/<mcVersion>`（1.8 → 1.8.0、1.9 → 1.9.0 的查询名转换来自
 *     reference/HMCL/.../download/optifine/OptiFineRemoteVersion.java#toLookupVersion，
 *     PCL2 ModDownload.vb 的 DlOptiFineListBmclapiMain 也用同一接口）。条目字段为
 *     `mcversion / type / patch / filename / forge`，本实现对 `mcVersion`、`date` 等变体做容错。
 *  2. 安装器下载：`{optifine}/<mc>/<type>/<patch>`（BMCLAPI 302 到真实文件），
 *     与 HMCL OptiFineRemoteVersion 构造的 mirror URL 一致。
 *  3. 原版（standalone）安装 —— 核心参考 HMCL OptiFineInstallTask#execute（第 152-251 行）：
 *       - 输入必须有原版 client jar（HMCL 直接抛 "Minecraft client JAR not found"）；
 *       - installer 内若存在 `optifine/Patcher.class`：
 *           `java -cp <installer.jar> optifine.Patcher <vanilla.jar> <installer.jar> <out.jar>`
 *         输出落到库路径 `optifine/OptiFine/<mc>_<type>_<patch>/OptiFine-<mc>_<type>_<patch>.jar`；
 *       - 若没有 Patcher.class（1.13+ 的 installer）：直接把 installer jar 复制为库文件；
 *       - 两种情况都会把 installer 复制到 `...-installer.jar`（classifier installer）并
 *         删除其中的 `META-INF/mods.toml`（HMCL 第 164-169、192-194 行），
 *         避免这个 jar 被 Forge 当作普通 mod 加载；
 *       - launchwrapper：installer 内若有 `launchwrapper-2.0.jar` 或
 *         `launchwrapper-of.txt` + `launchwrapper-of-<v>.jar`，把它们解到
 *         `libraries/optifine/launchwrapper[-of]/...` 并作为库引用；都没有才加
 *         `net.minecraft:launchwrapper:1.12`（HMCL 第 196-239 行）；
 *       - 版本补丁：mainClass = net.minecraft.launchwrapper.Launch，
 *         参数追加 `--tweakClass optifine.OptiFineTweaker`（HMCL 第 241-248 行）；
 *       - HMCL 会校验目标 mainClass ∈ FORGE_OPTIFINE_MAIN（含原生 Main / LaunchWrapper /
 *         BootstrapLauncher），否则抛 UNSUPPORTED_LAUNCH_WRAPPER。我们改成警告 + 继续，
 *         因为目标是用户显式指定的版本。
 *     注意 HMCL 并没有把 installer 内的 `optifine/**` 手工合并进输出 jar —— Patcher 的输出本身
 *     就是完整的 OptiFine 库；本实现遵循 HMCL（不做多余的资源合并，避免破坏签名/重复类）。
 *  4. 库版本号采用 `optifine:OptiFine:<mc>_<type>_<patch>`（下划线），与 HMCL/OptiFine 官方
 *     maven 布局一致（任务书里的 `<mc>-<type>-<patch>` 形式在 maven 语义上等价，这里选前者）。
 *  5. Forge/NeoForge 目标：现代 OptiFine 的 installer jar 本身就是带 `META-INF/mods.toml`
 *     的 Forge mod 形态，放进实例 mods/ 即可被 Forge 加载（PCL2 的 ModCrash 诊断条目也把
 *     `optifine\OptiFine*.jar` 当作 mods 目录里的 mod）。我们校验 mods.toml 后复制到
 *     `mods/OptiFine_<mc>_<type>_<patch>.jar`，并在 warnings 里明确兼容性限制。
 *  6. 内嵌 version json：先尝试 `extractEmbeddedVersionJson`，存在则优先作为基础
 *     （HMCL 没有这个分支，属于防御性处理，避免某些第三方 installer 自带启动描述时被丢弃）。
 */

import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import type {
  ArgumentNode,
  DownloadProgress,
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
import { dedupeLibraries } from '@core/mojang/library'
import { compareVersions } from '@core/util/misc'
import { ensureDir, pathExists, removePath, writeFileAtomic } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import {
  extractEmbeddedVersionJson,
  resolveInstallerJava,
  runJavaProcess,
  type JavaProvider
} from './installer-jar'
import { baseGameVersionOf, optifineVersionId, parseLoaderVersionId } from './version-id'
import type { LoaderInstallDeps } from './index'

const log = logger.scoped('loader:optifine')

/** OptiFine 的 launchwrapper 主类（HMCL GameComponentAnalyzer.LAUNCH_WRAPPER_MAIN） */
export const LAUNCHWRAPPER_MAIN_CLASS = 'net.minecraft.launchwrapper.Launch'
/** 原版 + launchwrapper 的 tweaker（HMCL OptiFineInstallTask 固定值） */
export const OPTIFINE_TWEAKER = 'optifine.OptiFineTweaker'
/** OptiFine patcher 的超时（老版本可能几十秒，给 5 分钟） */
const PATCHER_TIMEOUT_MS = 5 * 60_000

export interface OptiFineVersion {
  type: string
  patch: string
  mcVersion: string
  fileName: string
  label: string
  releaseTime?: string
}

export interface OptiFineInstallerOptions {
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  repository: VersionRepository
  javaScanner: JavaProvider
}

/* ------------------------------------------------------------------ *
 *  纯函数（供测试）
 * ------------------------------------------------------------------ */

/** BMCLAPI 的 OptiFine 清单查询名：1.8 → 1.8.0、1.9 → 1.9.0（HMCL OptiFineRemoteVersion#toLookupVersion） */
export function optifineLookupVersion(mcVersion: string): string {
  const v = mcVersion.trim()
  if (v === '1.8') return '1.8.0'
  if (v === '1.9') return '1.9.0'
  return v
}

/** 反向：清单里的 1.8.0 → 游戏侧 1.8（HMCL #fromLookupVersion） */
export function optifineFromLookupVersion(lookup: string): string {
  const v = lookup.trim()
  if (v === '1.8.0') return '1.8'
  if (v === '1.9.0') return '1.9'
  return v
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * patch 段的形态：`I6` / `G5` / `E1_pre1` / `pre1` / `alpha2` 等。
 * type 段形如 `HD_U`（自身带下划线），所以只能靠「patch 的形态」从尾部反推切分点。
 */
const OPTIFINE_TYPE_PATCH_RE =
  /^([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z][A-Za-z0-9]*)*)_((?:pre|alpha)\d*|[A-Za-z]\d+(?:_pre\d*)?)$/i

/** 拆分 `<type>_<patch>`（type 可能含下划线，如 HD_U） */
function splitTypePatch(value: string): { type: string; patch: string } {
  const match = OPTIFINE_TYPE_PATCH_RE.exec(value)
  if (match) return { type: match[1], patch: match[2] }
  return { type: value, patch: '' }
}

/** 从 `OptiFine_1.20.1_HD_U_I6.jar` / `preview_OptiFine_1.11_HD_U_E1_pre.jar` 抽取基本信息 */
function parseOptifineFileName(fileName: string): { mcVersion?: string; type?: string; patch?: string } {
  const base = fileName.replace(/^preview_/i, '').replace(/^OptiFine_/i, '').replace(/\.jar$/i, '')
  const parts = base.split('_')
  if (parts.length < 3) return {}
  const mcVersion = parts[0]
  const { type, patch } = splitTypePatch(parts.slice(1).join('_'))
  return { mcVersion, type, patch: patch || undefined }
}

/**
 * 解析 BMCLAPI 的 OptiFine 清单数组。
 * 字段容错：`mcversion` / `mcVersion`；`type` / `patch` 缺失时从 `filename` 回退解析。
 * preview（patch 以 pre/alpha 开头或文件名带 preview_）按原样保留，由 includePreview 过滤。
 */
export function parseOptiFineList(raw: unknown, requestedMcVersion?: string): OptiFineVersion[] {
  if (!Array.isArray(raw)) return []
  const out = new Map<string, OptiFineVersion>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    let fileName = asString(entry.filename) ?? asString(entry.fileName)
    let mcVersion = asString(entry.mcversion) ?? asString(entry.mcVersion)
    let type = asString(entry.type)
    let patch = asString(entry.patch)

    if (fileName && (!type || !patch || !mcVersion)) {
      const parsed = parseOptifineFileName(fileName)
      mcVersion = mcVersion ?? parsed.mcVersion
      type = type ?? parsed.type
      patch = patch ?? parsed.patch
    }
    if (!mcVersion || !type) continue
    if (!patch) patch = ''
    mcVersion = optifineFromLookupVersion(mcVersion)
    if (requestedMcVersion && mcVersion !== requestedMcVersion) continue
    if (!fileName) {
      const preview = /^(pre|alpha)/i.test(patch)
      fileName = `${preview ? 'preview_' : ''}OptiFine_${mcVersion}_${type}_${patch}.jar`
    }
    const key = `${mcVersion}/${type}/${patch}`
    if (out.has(key)) continue
    out.set(key, {
      type,
      patch,
      mcVersion,
      fileName,
      label: `${mcVersion} ${type.replace(/_/g, ' ')} ${patch}`.trim(),
      releaseTime: asString(entry.date) ?? asString(entry.releaseTime)
    })
  }
  return [...out.values()]
}

/** 是否为预览版 patch（形如 pre1 / E1_pre1 / alpha2） */
export function isOptiFinePreviewPatch(patch: string): boolean {
  return /(^|_)(pre|alpha)/i.test(patch)
}

/** 是否为预览版：patch 形态或文件名带 preview_（PCL2 用 contains("pre")，HMCL 用 startsWith("pre")，这里取更宽容的并集） */
export function isOptiFinePreview(v: OptiFineVersion): boolean {
  return isOptiFinePreviewPatch(v.patch) || /^preview_/i.test(v.fileName)
}

/** BMCLAPI 安装器地址：{base}/<mc>/<type>/<patch>（HMCL OptiFineRemoteVersion 构造方式） */
export function optifineInstallerUrl(base: string, v: OptiFineVersion): string {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(optifineLookupVersion(v.mcVersion))}/${encodeURIComponent(v.type)}/${encodeURIComponent(v.patch)}`
}

/** 从请求里解析 type / patch（loaderVersion 形如 `HD_U_I6`，type 本身含下划线） */
export function splitOptiFineLoaderVersion(loaderVersion?: string): { type?: string; patch?: string } {
  const value = loaderVersion?.trim()
  if (!value) return {}
  const { type, patch } = splitTypePatch(value)
  return patch ? { type, patch } : { type }
}

/* ------------------------------------------------------------------ *
 *  工具
 * ------------------------------------------------------------------ */

function zipHasEntry(installerPath: string, entryName: string): boolean {
  try {
    const zip = new AdmZip(installerPath)
    return !!zip.getEntry(entryName)
  } catch {
    return false
  }
}

function zipReadText(installerPath: string, entryName: string): string | null {
  try {
    const zip = new AdmZip(installerPath)
    const entry = zip.getEntry(entryName)
    if (!entry) return null
    return entry.getData().toString('utf8').replace(/^\uFEFF/, '').trim() || null
  } catch {
    return null
  }
}

async function extractZipEntryTo(installerPath: string, entryName: string, dest: string): Promise<string | null> {
  try {
    const zip = new AdmZip(installerPath)
    const entry = zip.getEntry(entryName)
    if (!entry) return null
    // writeFileAtomic 会自行创建父目录
    await writeFileAtomic(dest, entry.getData())
    return dest
  } catch (err) {
    log.warn(`解压 OptiFine installer 条目失败：${entryName}（${err instanceof Error ? err.message : String(err)}）`)
    return null
  }
}

/** 删除 jar 内的某个条目（HMCL 会删 META-INF/mods.toml，避免 OptiFine 库被 Forge 当 mod 加载） */
async function removeZipEntry(jarPath: string, entryName: string): Promise<boolean> {
  try {
    const zip = new AdmZip(jarPath)
    const entry = zip.getEntry(entryName) ?? zip.getEntry(`/${entryName}`)
    if (!entry) return false
    zip.deleteFile(entry)
    zip.writeZip(jarPath)
    return true
  } catch (err) {
    log.warn(`删除 ${entryName} 失败：${jarPath}（${err instanceof Error ? err.message : String(err)}）`)
    return false
  }
}

/* ------------------------------------------------------------------ *
 *  OptiFineInstaller
 * ------------------------------------------------------------------ */

export class OptiFineInstaller {
  private readonly client: HttpClient
  private readonly mirror: MirrorResolver
  private readonly downloadManager: DownloadManager
  private readonly repository: VersionRepository
  private readonly javaScanner: JavaProvider
  private readonly cache = new Map<string, { at: number; versions: OptiFineVersion[] }>()
  private static readonly CACHE_TTL_MS = 10 * 60_000

  constructor(opts: OptiFineInstallerOptions) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.downloadManager = opts.downloadManager
    this.repository = opts.repository
    this.javaScanner = opts.javaScanner
  }

  /**
   * 清单与下载的基地址。
   * OptiFine 官方没有 JSON 清单（只有网页），HMCL 也只实现 BMCLAPI 清单，因此
   * 清单固定走 BMCLAPI；下载地址跟随 forge 镜像配置（custom 时用自定义源，其余为 BMCLAPI）。
   */
  private listBase(): string {
    return BMCLAPI_ENDPOINTS.optifine
  }

  private downloadBase(): string {
    const mirror = this.mirror.get('forge')
    if (mirror === 'custom') {
      const base = this.mirror.customBase('forge')
      if (base) return `${base.replace(/\/+$/, '')}/optifine`
    }
    return BMCLAPI_ENDPOINTS.optifine
  }

  /** `GET {optifine}/<mcVersion>`（BMCLAPI 的 OptiFine 清单） */
  async listVersions(
    mcVersion: string,
    opts: { refresh?: boolean; includePreview?: boolean } = {}
  ): Promise<OptiFineVersion[]> {
    const gameVersion = optifineFromLookupVersion(mcVersion.trim())
    const cached = this.cache.get(gameVersion)
    if (!opts.refresh && cached && Date.now() - cached.at < OptiFineInstaller.CACHE_TTL_MS) {
      return cached.versions
    }
    const url = `${this.listBase()}/${encodeURIComponent(optifineLookupVersion(gameVersion))}`
    log.debug(`获取 OptiFine 清单：${url}`)
    const raw = await this.client.getJson<unknown>(url)
    const all = parseOptiFineList(raw, gameVersion)
    all.sort((a, b) => compareVersions(b.patch, a.patch))
    this.cache.set(gameVersion, { at: Date.now(), versions: all })
    return opts.includePreview ? all : all.filter((v) => !isOptiFinePreview(v))
  }

  /** 下载 installer jar 到临时目录，返回文件路径（调用方负责清理其父目录） */
  async downloadInstaller(
    v: OptiFineVersion,
    opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}
  ): Promise<string> {
    const url = optifineInstallerUrl(this.downloadBase(), v)
    const dir = join(tmpdir(), `mcal-optifine-${randomUUID().slice(0, 8)}`)
    const dest = join(dir, v.fileName || `OptiFine_${v.mcVersion}_${v.type}_${v.patch}.jar`)
    const result = await this.downloadManager.fetchFiles(
      `optifine-${v.mcVersion}-${v.type}-${v.patch}`,
      `OptiFine ${v.label}`,
      [{ key: url, url, dest, skipIfExists: false }],
      { signal: opts.signal, onProgress: opts.onProgress }
    )
    if (!result.ok) {
      throw new Error(
        `下载 OptiFine 安装包失败（${url}）：${result.failures.map((f) => f.error).join('；')}\n` +
          `提示：BMCLAPI 的 OptiFine 接口会 302 到实际文件，若镜像不可用请在设置中切换镜像。`
      )
    }
    const size = await this.downloadManager.sizeOf(dest)
    if (size < 64 * 1024) {
      // 302 到 HTML 错误页的典型症状；OptiFine jar 至少数百 KB
      throw new Error(`下载到的 OptiFine 文件异常（${size} 字节，${dest}），可能被重定向到了错误页面`)
    }
    return dest
  }

  /* ---------------- 安装入口 ---------------- */

  async install(req: LoaderInstallRequest, deps: LoaderInstallDeps): Promise<LoaderInstallResult> {
    const warnings: string[] = []
    const version = this.resolveRequestedVersion(req)
    if (!version.type || !version.patch) {
      throw new Error(
        '安装 OptiFine 需要 optifineType（如 HD_U）与 optifinePatch（如 I6），或 loaderVersion=<type>_<patch>'
      )
    }

    const target = await this.repository.readVersionJson(deps.gameDir, req.versionId)
    if (!target) {
      throw new Error(
        `请先安装目标版本 ${req.versionId}（${this.repository.versionJsonPath(deps.gameDir, req.versionId)} 不存在），再安装 OptiFine`
      )
    }
    const parsed = parseLoaderVersionId(req.versionId)
    const targetLoader = target.mcalMeta?.loaderType ?? parsed.loaderType
    // MC 版本：优先取 id 解析结果，其次沿 inheritsFrom 上溯（自定义版本目录的场景）
    const mcVersion =
      parsed.gameVersion ??
      (target.inheritsFrom ? baseGameVersionOf(target.inheritsFrom) : undefined) ??
      target.id
    if (parsed.gameVersion && parsed.gameVersion !== mcVersion) {
      warnings.push(`OptiFine 将安装到 ${req.versionId}（MC ${mcVersion}）而非 id 中的 ${parsed.gameVersion}`)
    }
    version.mcVersion = mcVersion
    version.fileName = isOptiFinePreviewPatch(version.patch)
      ? `preview_OptiFine_${mcVersion}_${version.type}_${version.patch}.jar`
      : `OptiFine_${mcVersion}_${version.type}_${version.patch}.jar`
    version.label = `${mcVersion} ${version.type.replace(/_/g, ' ')} ${version.patch}`.trim()

    // 预热清单：拿到官方文件名/发布时间（失败不影响安装）
    try {
      const listed = (await this.listVersions(mcVersion, { includePreview: true })).find(
        (v) => v.type === version.type && v.patch === version.patch
      )
      if (listed) {
        version.fileName = listed.fileName
        version.releaseTime = listed.releaseTime
      }
    } catch (err) {
      warnings.push(`获取 OptiFine 清单失败（不影响安装）：${err instanceof Error ? err.message : String(err)}`)
    }

    if (targetLoader === 'forge' || targetLoader === 'neoforge') {
      return await this.installAsMod(req, deps, version, mcVersion, targetLoader, warnings)
    }
    if (targetLoader === 'optifine') {
      throw new Error(`目标版本 ${req.versionId} 已经是 OptiFine 版本，请在原版或 Forge/NeoForge 版本上安装`)
    }
    if (targetLoader !== 'vanilla') {
      warnings.push(`目标版本 ${req.versionId} 的加载器类型为 ${targetLoader}，OptiFine 只保证原版与 Forge 场景可用`)
    }
    return await this.installStandalone(req, deps, version, mcVersion, target, warnings)
  }

  private resolveRequestedVersion(req: LoaderInstallRequest): OptiFineVersion {
    const fromLoader = splitOptiFineLoaderVersion(req.loaderVersion)
    const type = req.optifineType?.trim() || fromLoader.type || ''
    const patch = req.optifinePatch?.trim() || fromLoader.patch || ''
    const mcVersion = baseGameVersionOf(req.versionId)
    return {
      type,
      patch,
      mcVersion,
      fileName: `OptiFine_${mcVersion}_${type}_${patch}.jar`,
      label: `${mcVersion} ${type.replace(/_/g, ' ')} ${patch}`.trim()
    }
  }

  /* ---------------- Forge / NeoForge：作为 mod 安装 ---------------- */

  private async installAsMod(
    req: LoaderInstallRequest,
    deps: LoaderInstallDeps,
    version: OptiFineVersion,
    mcVersion: string,
    targetLoader: string,
    warnings: string[]
  ): Promise<LoaderInstallResult> {
    deps.onProgress?.({ phase: 'download', message: `下载 OptiFine ${version.label}`, ratio: 0.1 })
    const installerPath = await this.downloadInstaller(version, {
      signal: deps.signal,
      onProgress: (p) => deps.onProgress?.({ phase: 'download', message: DownloadManager.describeProgress(p), ratio: 0.2, download: p })
    })
    const workDir = join(installerPath, '..')
    try {
      // 现代 OptiFine installer 自带 META-INF/mods.toml，本身就是 Forge mod 形态。
      // 老版本（如 1.12.2）的 installer 没有该文件，只能在原版上用 launchwrapper + OptiFineForgeTweaker
      // 组合（HMCL 走的是「把 OptiFine 作为版本补丁库」的路径，本模块暂未实现该组合）。
      if (!zipHasEntry(installerPath, 'META-INF/mods.toml')) {
        throw new Error(
          `OptiFine ${version.label} 的安装包不含 META-INF/mods.toml，无法作为 ${targetLoader} mod 使用（1.13 之前的旧版不提供 mod 形态）。\n` +
            `可选做法：1) 在对应的原版版本上安装 OptiFine（本模块的原版流程）；` +
            `2) 使用 Embeddium/Rubidium + Oculus 等现代替代方案。`
        )
      }
      const modsDir = join(deps.gameDir, 'mods')
      await ensureDir(modsDir)
      // 预览版文件名带 preview_ 前缀（version.fileName 已按清单/构造规则给出）
      const modJar = join(modsDir, version.fileName)
      await copyFile(installerPath, modJar)
      deps.onProgress?.({ phase: 'done', message: `OptiFine 已放入 mods/`, ratio: 1 })

      warnings.push(
        `已把 OptiFine（MC ${mcVersion}）作为 ${targetLoader} mod 安装到 ${modJar}（OptiFine 官方 installer jar 的 mod 形态）。`
      )
      if (targetLoader === 'neoforge') {
        warnings.push(
          'NeoForge 官方不支持 OptiFine（1.20.2+ 起基本无法加载），启动失败时请删除该 mod，' +
            '改用 Embeddium/Rubidium + Oculus。'
        )
      }
      warnings.push(
        'OptiFine 与不少模组（尤其渲染/mixin 类）不兼容，且 1.16.5 之后与 Forge 的兼容性持续下降；' +
          '光影场景建议改用 Iris/Oculus + Embeddium/Rubidium。若启动失败请移除 mods/ 下的 OptiFine jar。'
      )
      return {
        versionId: req.versionId,
        loaderType: 'optifine',
        loaderVersion: `${version.type}_${version.patch}`,
        files: [modJar],
        warnings
      }
    } finally {
      await removePath(workDir)
    }
  }

  /* ---------------- 原版：patcher + launchwrapper 版本 json ---------------- */

  private async installStandalone(
    req: LoaderInstallRequest,
    deps: LoaderInstallDeps,
    version: OptiFineVersion,
    mcVersion: string,
    target: VersionDetail,
    warnings: string[]
  ): Promise<LoaderInstallResult> {
    const type = version.type
    const patch = version.patch
    const mavenVersion = `${mcVersion}_${type}_${patch}` // optifine:OptiFine:<mc>_<type>_<patch>
    const versionId = optifineVersionId(mcVersion, type, patch)

    /* 1. 原版 client jar（本模块不负责下载原版，按任务约定直接检查并抛可读错误） */
    const vanillaJar = await this.findClientJar(deps.gameDir, req.versionId)
    if (!vanillaJar) {
      throw new Error(
        `安装 OptiFine 前需要原版 client jar：找不到 versions/${req.versionId}/${req.versionId}.jar（或其继承链上的 jar）。\n` +
          `请先安装原版 ${mcVersion}（安装器不提供原版下载），再重试。`
      )
    }

    /* 2. 下载 installer */
    deps.onProgress?.({ phase: 'download', message: `下载 OptiFine ${version.label}`, ratio: 0.1 })
    const installerPath = await this.downloadInstaller(version, {
      signal: deps.signal,
      onProgress: (p) => deps.onProgress?.({ phase: 'download', message: DownloadManager.describeProgress(p), ratio: 0.2, download: p })
    })
    const workDir = join(installerPath, '..')

    try {
      const hasPatcher = zipHasEntry(installerPath, 'optifine/Patcher.class')
      const libraryDir = join(deps.gameDir, 'libraries', 'optifine', 'OptiFine', mavenVersion)
      const outputJar = join(libraryDir, `OptiFine-${mavenVersion}.jar`)
      const installerLibraryJar = join(libraryDir, `OptiFine-${mavenVersion}-installer.jar`)
      await ensureDir(libraryDir)

      /* 3. patcher 或直接复制 */
      const javaPath = await resolveInstallerJava({
        java: this.javaScanner,
        javaPath: deps.javaPath,
        gameVersion: mcVersion,
        detail: target,
        signal: deps.signal
      })
      deps.onProgress?.({ phase: 'patch', message: '运行 OptiFine patcher', ratio: 0.4 })
      if (hasPatcher) {
        // HMCL OptiFineInstallTask 的命令：java -cp <installer> optifine.Patcher <vanilla.jar> <installer> <out.jar>
        const proc = await runJavaProcess({
          javaPath,
          args: ['-cp', installerPath, 'optifine.Patcher', vanillaJar, installerPath, outputJar],
          cwd: deps.gameDir,
          signal: deps.signal,
          timeoutMs: PATCHER_TIMEOUT_MS,
          tailLines: 400,
          label: 'OptiFine patcher'
        })
        if (!proc.ok) {
          throw new Error(
            `OptiFine patcher 失败（退出码 ${proc.code ?? 'null'}）。\n` +
              `命令：${javaPath} -cp "${installerPath}" optifine.Patcher "${vanillaJar}" "${installerPath}" "${outputJar}"\n` +
              `提示：1.12.2 及更早的 OptiFine patcher 需要 Java 8，请检查已安装的 Java 版本。\n` +
              `完整输出：\n${proc.output}`
          )
        }
      } else {
        // HMCL：没有 Patcher.class 时（1.13+ installer）直接把 installer 作为库
        await copyFile(installerPath, outputJar)
        warnings.push(`installer 内没有 optifine/Patcher.class，已直接使用 installer jar 作为 OptiFine 库`)
      }

      // 同时落盘 classifier=installer 的库（HMCL 同款），并去掉 mods.toml 防止被当作 mod
      await copyFile(installerPath, installerLibraryJar)
      await removeZipEntry(installerLibraryJar, 'META-INF/mods.toml')
      await removeZipEntry(outputJar, 'META-INF/mods.toml')

      /* 4. launchwrapper（HMCL OptiFineInstallTask 第 196-239 行） */
      const libraries: Library[] = [{ name: `optifine:OptiFine:${mavenVersion}` }]
      const files: string[] = [outputJar, installerLibraryJar]

      const launchWrapper2 = await extractZipEntryTo(
        installerPath,
        'launchwrapper-2.0.jar',
        join(deps.gameDir, 'libraries', 'optifine', 'launchwrapper', '2.0', 'launchwrapper-2.0.jar')
      )
      if (launchWrapper2) {
        libraries.push({ name: 'optifine:launchwrapper:2.0' })
        files.push(launchWrapper2)
      } else {
        const ofVersion = zipReadText(installerPath, 'launchwrapper-of.txt')
        if (ofVersion) {
          const lwJar = await extractZipEntryTo(
            installerPath,
            `launchwrapper-of-${ofVersion}.jar`,
            join(deps.gameDir, 'libraries', 'optifine', 'launchwrapper-of', ofVersion, `launchwrapper-of-${ofVersion}.jar`)
          )
          if (lwJar) {
            libraries.push({ name: `optifine:launchwrapper-of:${ofVersion}` })
            files.push(lwJar)
          }
        }
      }
      if (libraries.length === 1) {
        // 没有自带 launchwrapper：加 net.minecraft:launchwrapper:1.12（父版本已有则不重复）
        if (!(await this.parentHasLaunchWrapper(deps.gameDir, req.versionId))) {
          libraries.push({ name: 'net.minecraft:launchwrapper:1.12' })
        } else {
          warnings.push('父版本已包含 net.minecraft:launchwrapper:1.12，未重复添加')
        }
      }

      /* 5. 版本 json（优先使用 installer 内嵌的 version.json） */
      const embedded = extractEmbeddedVersionJson(installerPath)
      if (embedded) {
        warnings.push('已使用 installer 内嵌的 version.json 作为版本描述基础')
      }
      const base: VersionDetail = embedded ?? {
        id: versionId,
        type: 'release',
        mainClass: LAUNCHWRAPPER_MAIN_CLASS
      }
      const gameArgs = ensureTweakClass(base.arguments?.game ?? [])
      const detail: VersionDetail = {
        ...base,
        id: versionId,
        // 继承自用户指定的目标版本（通常是原版），原版库与参数由继承链提供
        inheritsFrom: req.versionId,
        mainClass: base.mainClass ?? LAUNCHWRAPPER_MAIN_CLASS,
        libraries: dedupeLibraries([...(base.libraries ?? []), ...libraries]),
        arguments: { ...(base.arguments ?? {}), game: gameArgs },
        releaseTime: base.releaseTime ?? version.releaseTime,
        mcalMeta: {
          ...(base.mcalMeta ?? {}),
          loaderType: 'optifine',
          loaderVersion: `${type}_${patch}`,
          installedAt: new Date().toISOString(),
          source: hasPatcher ? 'optifine-patcher' : 'optifine-installer-lib'
        }
      }
      const jsonPath = await this.repository.writeVersionJson(deps.gameDir, detail)
      files.unshift(jsonPath)

      /* 6. 提示 */
      warnings.push(`OptiFine ${version.label} 已 patched 到 ${outputJar}`)
      if (!base.mainClass) {
        warnings.push(`版本 mainClass 设为 ${LAUNCHWRAPPER_MAIN_CLASS}，游戏参数追加 --tweakClass ${OPTIFINE_TWEAKER}`)
      }
      if (compareVersions(mcVersion, '1.13') >= 0) {
        warnings.push(
          'OptiFine 1.13+ 在原版上依赖 launchwrapper 兼容层，部分版本可能无法启动；' +
            '若失败请改用 Forge/NeoForge + OptiFine mod 形态，或 Iris/Oculus + Embeddium/Rubidium。'
        )
      }
      warnings.push(
        'OptiFine 与部分模组不兼容；光影场景建议使用 Iris/Oculus + Embeddium/Rubidium 以获得更好的兼容性与性能。'
      )

      deps.onProgress?.({ phase: 'done', message: `OptiFine ${version.label} 安装完成`, ratio: 1 })
      if (req.createInstance) {
        log.info(`版本 ${versionId} 已就绪，供上层创建实例（instanceName=${req.instanceName ?? '-'}）`)
      }
      return {
        versionId,
        loaderType: 'optifine',
        loaderVersion: `${type}_${patch}`,
        files,
        warnings
      }
    } finally {
      await removePath(workDir)
    }
  }

  /** 定位可用的原版 client jar（目标版本目录 → 继承链 jarVersionId） */
  private async findClientJar(gameDir: string, versionId: string): Promise<string | null> {
    const direct = join(gameDir, 'versions', versionId, `${versionId}.jar`)
    if (await pathExists(direct)) return direct
    try {
      const resolved = await this.repository.resolve(gameDir, versionId, { allowNetwork: false })
      const viaParent = join(gameDir, 'versions', resolved.jarVersionId, `${resolved.jarVersionId}.jar`)
      if (await pathExists(viaParent)) return viaParent
    } catch {
      /* 继承链不完整时返回 null，由调用方抛可读错误 */
    }
    return null
  }

  private async parentHasLaunchWrapper(gameDir: string, versionId: string): Promise<boolean> {
    try {
      const resolved = await this.repository.resolve(gameDir, versionId, { allowNetwork: false })
      return (resolved.detail.libraries ?? []).some((lib) => /^net\.minecraft:launchwrapper(:|$)/.test(lib.name ?? ''))
    } catch {
      return false
    }
  }
}

/** 确保游戏参数里有 `--tweakClass optifine.OptiFineTweaker`（不重复添加） */
export function ensureTweakClass(game: (string | ArgumentNode)[]): (string | ArgumentNode)[] {
  const hasTweaker = game.some((node) => {
    const value = typeof node === 'string' ? node : Array.isArray(node.value) ? node.value.join(' ') : node.value
    return typeof value === 'string' && value.includes(OPTIFINE_TWEAKER)
  })
  if (hasTweaker) return game
  return [...game, '--tweakClass', OPTIFINE_TWEAKER]
}

/** 供上层做 LoaderVersion 映射 */
export function optifineToLoaderVersion(v: OptiFineVersion): LoaderVersion {
  return {
    loaderType: 'optifine',
    version: `${v.type}_${v.patch}`,
    gameVersion: v.mcVersion,
    stable: !isOptiFinePreview(v),
    label: v.label
  }
}

/** 供上层查询（UI 展示下载源） */
export function optifineOfficialPage(): string {
  return `${OFFICIAL_ENDPOINTS.optifine}/downloads`
}
