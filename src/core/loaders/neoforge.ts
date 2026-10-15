/**
 * NeoForge 安装器。
 *
 * 协议依据（reference/HMCL/.../download/neoforge/NeoForgeRemoteVersion.java 与
 * NeoForgeInstallTask.java）：
 *
 *  1. 版本号 → MC 版本映射（本文件的核心映射，测试重点）：
 *     - 现代 artifact `net.neoforged:neoforge`，版本形如 `20.4.237` / `21.0.167` / `21.1.209`：
 *         `20.4.237` → 1.20.4（minor 非 0 时带上补丁位）
 *         `21.0.167` → 1.21  （minor == 0 时省略补丁位）
 *         `21.1.209` → 1.21.1
 *         主版本 >= 26（Minecraft 26.x 新命名）：`26.1.0` → 26.1，`26.1.2` → 26.1.2
 *     - 1.20.1 时代处于 legacy artifact `net.neoforged:forge`，
 *       maven 版本形如 `1.20.1-47.1.106`（或 `1.20.1-forge-47.1.99`），
 *       selfVersion 归一化为 `47.1.106`。
 *  2. installer 地址：
 *     - 现代：`{neoforgeMaven}/net/neoforged/neoforge/<version>/neoforge-<version>-installer.jar`
 *     - legacy：`{neoforgeMaven}/net/neoforged/forge/<version>/forge-<version>-installer.jar`
 *  3. 版本 id：`neoforge-<version>`（NeoForge 官方 installer 的版本目录命名）。
 *  4. installer 形态：全部是带 processors 的 Forge 新格式（NeoForgeInstallTask 直接复用
 *     ForgeNewInstallTask / NeoForgeOldInstallTask），因此手工回退必须给出 processors 警告。
 *
 * 安装流程与 Forge 共用一个基类（NeoForge 是 Forge 的 fork，installer 格式同源），
 * 只覆盖「版本列表 / 命名 / 地址 / 产物 id」。
 */

import type { LoaderVersion } from '@shared/types'
import { OFFICIAL_ENDPOINTS } from '@core/net/mirror'
import { compareVersions } from '@core/util/misc'
import { logger } from '@core/util/logger'
import { ForgeInstaller, type ForgeInstallerOptions } from './forge'
import { neoforgeGameVersionFor, neoForgeVersionId } from './version-id'

const log = logger.scoped('loader:neoforge')

/** NeoForge 1.20.1 时代的 legacy artifact */
const LEGACY_ARTIFACT_PATH = 'net/neoforged/forge'
const MODERN_ARTIFACT_PATH = 'net/neoforged/neoforge'

export interface NeoForgeMavenVersionParts {
  /** 是否为 1.20.1 时代的 legacy 命名 */
  legacy: boolean
  /** NeoForge 自身版本（用于版本 id 与 LoaderVersion.version） */
  selfVersion: string
  /** 映射出的 MC 版本（无法映射时为 null） */
  mcVersion: string | null
  /** maven 目录名原串 */
  mavenVersion: string
}

/**
 * 解析 NeoForge maven 目录名。
 * - `1.20.1-47.1.106` / `1.20.1-forge-47.1.99` → legacy，selfVersion=47.1.106
 * - `21.1.209` / `20.4.237` / `21.1.0-beta` → 现代，MC 映射由 neoforgeGameVersionFor 完成
 */
export function parseNeoForgeMavenVersion(mavenVersion: string): NeoForgeMavenVersionParts | null {
  const raw = (mavenVersion ?? '').trim()
  if (!raw) return null
  const legacy = /^1\.20\.1(?:-forge)?-/.exec(raw)
  if (legacy) {
    const selfVersion = raw.slice(legacy[0].length)
    if (!/^\d/.test(selfVersion)) return null
    return { legacy: true, selfVersion, mcVersion: '1.20.1', mavenVersion: raw }
  }
  const mcVersion = neoforgeGameVersionFor(raw)
  return { legacy: false, selfVersion: raw, mcVersion, mavenVersion: raw }
}

export class NeoForgeInstaller extends ForgeInstaller {
  protected override readonly loaderType = 'neoforge' as const
  protected override readonly displayName: string = 'NeoForge'

  constructor(opts: ForgeInstallerOptions) {
    super(opts)
  }

  /** NeoForge 的 maven 与 Forge 不同源（maven.neoforged.net/releases） */
  protected override mavenBase(): string {
    return this.mirror.resolve(OFFICIAL_ENDPOINTS.neoforgeMaven, 'forge').replace(/\/+$/, '')
  }

  protected override officialMavenBase(): string {
    return OFFICIAL_ENDPOINTS.neoforgeMaven
  }

  protected override mavenArtifactPath(): string {
    return MODERN_ARTIFACT_PATH
  }

  protected override installerFileName(mavenDir: string): string {
    // legacy 用 forge- 前缀（net/neoforged/forge 目录里就是 forge-<v>-installer.jar）
    if (/^1\.20\.1(?:-forge)?-/.test(mavenDir)) return `forge-${mavenDir}-installer.jar`
    return `neoforge-${mavenDir}-installer.jar`
  }

  protected override versionIdFor(_gameVersion: string, loaderVersion: string): string {
    return neoForgeVersionId(loaderVersion)
  }

  /**
   * 版本列表：现代与 legacy 两个 maven 目录合并。
   * - 给定 gameVersion：只保留映射到该 MC 版本的条目
   * - 未给定：两个 artifact 的全部版本（由上层按需使用）
   */
  override async listVersions(gameVersion?: string, opts: { refresh?: boolean } = {}): Promise<LoaderVersion[]> {
    const byId = new Map<string, LoaderVersion>()

    const add = (parts: NeoForgeMavenVersionParts): void => {
      if (!parts.mcVersion) return
      if (gameVersion && parts.mcVersion !== gameVersion) return
      const stable = !/alpha|beta/i.test(parts.selfVersion)
      const key = `${parts.selfVersion}@${parts.mcVersion}`
      if (!byId.has(key)) {
        byId.set(key, {
          loaderType: 'neoforge',
          version: parts.selfVersion,
          gameVersion: parts.mcVersion,
          stable,
          label: stable ? undefined : 'beta',
          installerUrl: this.installerUrlForParts(parts)
        })
      }
    }

    const modern = await this.listMavenVersionsOf(MODERN_ARTIFACT_PATH, opts).catch((err: unknown) => {
      log.warn(`获取 NeoForge maven 列表失败：${err instanceof Error ? err.message : String(err)}`)
      return [] as string[]
    })
    for (const raw of modern) {
      const parts = parseNeoForgeMavenVersion(raw)
      if (parts) add(parts)
    }

    // 1.20.1 的 legacy 版本只在 net/neoforged/forge 下
    if (!gameVersion || gameVersion === '1.20.1') {
      const legacy = await this.listMavenVersionsOf(LEGACY_ARTIFACT_PATH, opts).catch(() => [] as string[])
      for (const raw of legacy) {
        const parts = parseNeoForgeMavenVersion(raw)
        if (parts) add(parts)
      }
    }

    const out = [...byId.values()]
    out.sort(
      (a, b) => compareVersions(b.gameVersion, a.gameVersion) || compareVersions(b.version, a.version)
    )
    return out
  }

  protected override async installerUrlFor(gameVersion: string, loaderVersion: string): Promise<string> {
    const parts = await this.resolveTarget(gameVersion, loaderVersion)
    return this.installerUrlForParts(parts)
  }

  /**
   * 确定 (artifact, mavenDir)：优先在 maven 列表中查实，查不到时按 gameVersion 推导
   * （1.20.1 → legacy net/neoforged/forge；其余 → 现代 net/neoforged/neoforge）。
   */
  protected async resolveTarget(gameVersion: string, loaderVersion: string): Promise<NeoForgeMavenVersionParts> {
    const requested = loaderVersion.startsWith('neoforge-') ? loaderVersion.slice('neoforge-'.length) : loaderVersion
    const search = async (artifactPath: string, legacyExpected: boolean): Promise<NeoForgeMavenVersionParts | null> => {
      try {
        const versions = await this.listMavenVersionsOf(artifactPath)
        for (const raw of versions) {
          const parts = parseNeoForgeMavenVersion(raw)
          if (!parts || parts.legacy !== legacyExpected) continue
          if (parts.selfVersion === requested && (!gameVersion || parts.mcVersion === gameVersion)) return parts
        }
      } catch (err) {
        log.warn(`查找 NeoForge maven 版本失败（${artifactPath}）：${err instanceof Error ? err.message : String(err)}`)
      }
      return null
    }

    const legacyFirst = gameVersion === '1.20.1' || /^47\.\d+\.\d+/.test(requested)
    const modern = legacyFirst ? null : await search(MODERN_ARTIFACT_PATH, false)
    if (modern) return modern
    const legacy = await search(LEGACY_ARTIFACT_PATH, true)
    if (legacy) return legacy
    // maven 列表不可用：按命名规则推导
    if (legacyFirst) {
      const mavenVersion = requested.startsWith('1.20.1') ? requested : `1.20.1-${requested}`
      return { legacy: true, selfVersion: mavenVersion.replace(/^1\.20\.1(?:-forge)?-/, ''), mcVersion: '1.20.1', mavenVersion }
    }
    return { legacy: false, selfVersion: requested, mcVersion: gameVersion, mavenVersion: requested }
  }

  protected installerUrlForParts(parts: NeoForgeMavenVersionParts): string {
    const artifactPath = parts.legacy ? LEGACY_ARTIFACT_PATH : MODERN_ARTIFACT_PATH
    return `${this.mavenBase()}/${artifactPath}/${parts.mavenVersion}/${this.installerFileName(parts.mavenVersion)}`
  }

  /** installer 产物目录名候选（legacy 可能生成 forge/neoforge 两种命名） */
  protected override installedCandidateIds(gameVersion: string, loaderVersion: string, targetId: string): string[] {
    return [
      targetId,
      `neoforge-${gameVersion}-${loaderVersion}`,
      `${gameVersion}-forge-${loaderVersion}`,
      `${gameVersion}-neoforge-${loaderVersion}`,
      `forge-${loaderVersion}`,
      `neoforge-${loaderVersion}`
    ]
  }

  /** NeoForge 的 installer 一定带 processors，手工安装必须强调风险与指引 */
  protected override manualProcessorWarning(gameDir: string, installerPath: string): string {
    return (
      `NeoForge 的手工安装未运行 installer 的 processors：patched client jar、依赖注入（如 fmlcore）都由 processor 生成，` +
      `跳过这些步骤后游戏无法启动。请在能联网的环境重试，或手动执行：` +
      `java -jar "${installerPath}" --installClient "${gameDir}"`
    )
  }
}
