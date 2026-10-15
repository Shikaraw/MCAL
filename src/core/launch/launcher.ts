/**
 * 启动编排：prepare（解析版本/库/Java/natives + 组装参数）与 launch（起进程、管生命周期）。
 *
 * 设计原则：
 *  - prepare 只做「本地可完成」的工作：解析 json、挑 Java、解压本地 native。
 *    绝不触发下载（版本/资源/库的下载由安装流程负责），这样 UI 可以先预览完整的
 *    启动命令与缺失项，再决定是否真的启动。
 *  - 启动命令 = jvmArgs + mainClass + gameArgs；mainClass 单独放，不混进 gameArgs
 *    （gameArgs 会暴露给 UI/Agent 展示与编辑）。
 *  - 离线账号完全本地计算 UUID（md5("OfflinePlayer:"+name) 设置版本位），
 *    与 Mojang 官方离线模式一致，服务器插件（如 Essentials）能识别同一玩家。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { totalmem } from 'node:os'
import type {
  Account,
  Instance,
  JavaRuntimeInfo,
  LaunchContextInfo,
  LaunchRequest,
  MemoryPolicy,
  RunningGameInfo
} from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import type { DownloadManager } from '@core/net/downloader'
import type { AssetService } from '@core/mojang/assets'
import { dedupeLibraries, nativeLibraries, resolveLibraries } from '@core/mojang/library'
import { createRuleContext, type RuleContext } from '@core/mojang/rules'
import type { ResolvedVersion, VersionRepository } from '@core/mojang/version'
import type { JavaScanner } from '@core/java/detect'
import { explainJavaRequirement, javaIsCompatible, pickBestJava, requiredJavaMajor } from '@core/java/requirement'
import { decodeText, ensureDir, pathExists } from '@core/util/fsx'
import { currentOs, normalizePathForCompare } from '@core/util/misc'
import { logger } from '@core/util/logger'
import { MCAL_LAUNCHER_NAME, MCAL_LAUNCHER_VERSION, buildGameArgs, buildJvmArgs, type PlaceholderValues } from './args'
import { buildClasspath, detectDuplicateLibraries } from './classpath'
import { extractNatives, prepareNativeDir } from './natives'
import { GameProcess, type GameProcessEvents } from './process'

const log = logger.scoped('launch')

export interface LauncherDeps {
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  repository: VersionRepository
  assets: AssetService
  javaScanner: JavaScanner
  settings: {
    java: { preferredJava?: string; scanDirs: string[]; autoDownload: boolean; preferredVendor?: string }
    launcher: { showGameWindowLog: boolean }
  }
  /** 解析实例使用的 assets 目录（默认 <gameDir>/assets） */
  resolveAssetsDir?: (instance: Instance) => string
}

export interface LaunchPreparation {
  context: LaunchContextInfo
  version: ResolvedVersion
  java: JavaRuntimeInfo | null
  nativesDir: string
  missingJava: boolean
  javaRecommendation?: { requiredMajor: number; explain: string }
  warnings: string[]
}

interface TrackedGame {
  instanceId: string
  process: GameProcess
  info: RunningGameInfo
  startedAtMs: number
}

/* ------------------------------------------------------------------ *
 *  工具：离线 UUID / 内存 / 版本判断
 * ------------------------------------------------------------------ */

/** 离线模式 UUID：md5("OfflinePlayer:name") 设置 RFC-4122 版本位（与官方离线模式一致） */
export function offlineUuid(name: string): string {
  const digest = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  digest[6] = (digest[6] & 0x0f) | 0x30
  digest[8] = (digest[8] & 0x3f) | 0x80
  return digest.toString('hex')
}

/** 根据物理内存推荐最大堆（MB） */
export function autoMaxHeapMB(totalMemoryMB: number): number {
  let recommended: number
  if (totalMemoryMB >= 16 * 1024) recommended = 8192
  else if (totalMemoryMB >= 8 * 1024) recommended = 4096
  else if (totalMemoryMB >= 4 * 1024) recommended = 2048
  else recommended = 1024
  // 给系统与显存留出余量：最多 60%（且不低于 512MB）
  return Math.max(512, Math.min(recommended, Math.floor(totalMemoryMB * 0.6)))
}

export function resolveMemoryPolicy(policy: MemoryPolicy): MemoryPolicy {
  const maxMB = policy.auto || policy.maxMB <= 0 ? autoMaxHeapMB(Math.floor(totalmem() / 1024 / 1024)) : policy.maxMB
  return { minMB: policy.minMB, maxMB, auto: policy.auto }
}

/** 1.19 起 LWJGL 3.3 自带 native 提取，不再需要启动前解压 */
export function needsLegacyNatives(gameVersion: string): boolean {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(gameVersion)
  if (!m) return false // 快照等未知版本按现代方案处理
  return Number.parseInt(m[1], 10) < 19
}

/** quickPlay 参数需要 1.20+ */
export function quickPlaySupported(gameVersion: string): boolean {
  const release = /^1\.(\d+)/.exec(gameVersion)
  if (release) return Number.parseInt(release[1], 10) >= 20
  const snapshot = /^(\d{2})w/.exec(gameVersion)
  if (snapshot) return Number.parseInt(snapshot[1], 10) >= 23
  return false
}

/* ------------------------------------------------------------------ *
 *  GameLauncher
 * ------------------------------------------------------------------ */

export class GameLauncher {
  private readonly deps: LauncherDeps
  private readonly games = new Map<string, TrackedGame>()
  private readonly finished: RunningGameInfo[] = []

  constructor(deps: LauncherDeps) {
    this.deps = deps
  }

  /** 解析并准备一次启动；不启动进程、不下载任何东西 */
  async prepare(req: LaunchRequest, instance: Instance, account: Account): Promise<LaunchPreparation> {
    const warnings: string[] = []
    const versionId = req.versionId ?? instance.versionId
    const version = await this.deps.repository.resolve(instance.gameDir, versionId, { allowNetwork: !req.offline })
    const baseGameVersion = version.chain[0] ?? versionId
    const gameDir = instance.gameDir
    const librariesDir = join(gameDir, 'libraries')
    const assetsDir = this.deps.resolveAssetsDir?.(instance) ?? join(gameDir, 'assets')

    /* -------- 平台规则与 features -------- */
    const qp = req.quickPlay
    const qpSupported = quickPlaySupported(baseGameVersion)
    const hasCustomResolution = !req.serverMode && instance.window.width > 0 && instance.window.height > 0
    const features: Record<string, boolean> = {
      has_custom_resolution: hasCustomResolution,
      has_quick_plays_support: qpSupported,
      is_quick_play_singleplayer: qpSupported && qp?.type === 'singleplayer',
      is_quick_play_multiplayer: qpSupported && qp?.type === 'multiplayer',
      is_quick_play_realms: qpSupported && qp?.type === 'realms',
      is_demo_user: false
    }
    const rules: RuleContext = createRuleContext({ features })

    /* -------- 库与 classpath -------- */
    const mergedLibraries = dedupeLibraries(version.detail.libraries ?? [])
    const libraries = resolveLibraries(mergedLibraries, { librariesDir, rules, mirror: this.deps.mirror })
    const duplicates = detectDuplicateLibraries(libraries)
    for (const dup of duplicates.slice(0, 5)) {
      warnings.push(`检测到同 artifact 多版本库：${dup.artifact}（${dup.versions.join(' / ')}），可能引起 NoSuchMethodError`)
    }

    const clientJar = join(gameDir, 'versions', version.jarVersionId, `${version.jarVersionId}.jar`)
    const extraJars: string[] = []
    if (version.id !== version.jarVersionId) {
      // 加载器版本自己带 jar（老 Forge 的 patched client / OptiFine）时追加到 classpath 末尾
      const ownJar = join(gameDir, 'versions', version.id, `${version.id}.jar`)
      if (await pathExists(ownJar)) extraJars.push(ownJar)
    }
    const hasClientJar = await pathExists(clientJar)
    if (!hasClientJar && extraJars.length === 0) {
      warnings.push(`客户端 jar 缺失：${clientJar}（请先安装该版本）`)
    }
    const classpath = buildClasspath({ libraries, clientJar, extraJars })

    /* -------- Java -------- */
    const requiredMajor = requiredJavaMajor(baseGameVersion, version.detail.javaVersion)
    const java = await this.selectJava(instance, requiredMajor, warnings)
    const missingJava = java === null
    let javaRecommendation: LaunchPreparation['javaRecommendation']
    if (missingJava) {
      javaRecommendation = { requiredMajor, explain: explainJavaRequirement(baseGameVersion, requiredMajor) }
    } else if (instance.java.ignoreJavaVersion !== true && !javaIsCompatible(java, requiredMajor)) {
      warnings.push(`当前 Java ${java.majorVersion}（${java.path}）与要求 Java ${requiredMajor} 不匹配，启动可能失败`)
      javaRecommendation = { requiredMajor, explain: explainJavaRequirement(baseGameVersion, requiredMajor) }
    }

    /* -------- natives -------- */
    const nativesDir = join(gameDir, 'versions', versionId, 'natives')
    const legacyNatives = needsLegacyNatives(baseGameVersion)
    await prepareNativeDir(nativesDir, legacyNatives)
    const natives = nativeLibraries(libraries)
    if (natives.length > 0) {
      if (!legacyNatives) {
        log.debug(`${baseGameVersion} 属于 1.19+，按现代方案处理 native（仍会解压显式声明的 native 库）`)
      }
      try {
        await extractNatives({ natives, nativeDir: nativesDir })
      } catch (err) {
        warnings.push(`native 解压失败：${messageOf(err)}`)
      }
    } else if (legacyNatives) {
      warnings.push(`未在版本 ${version.id} 的库中找到 native 库，游戏可能因缺少 dll/so 无法启动`)
    }

    /* -------- 内存与账号 -------- */
    const memory = resolveMemoryPolicy(req.memoryOverride ?? instance.memory)
    const offline = req.offline === true || account.type === 'offline'
    let accessToken = offline ? '0' : (account.accessToken ?? '')
    if (!offline && !accessToken) {
      warnings.push('账号缺少有效的 accessToken（可能已过期），正版验证会失败，请重新登录')
      accessToken = '0'
    }
    const uuid = offline ? offlineUuid(account.name) : account.uuid.replace(/-/g, '').toLowerCase() || offlineUuid(account.name)
    const userType = offline ? 'legacy' : account.type === 'microsoft' ? 'msa' : 'mojang'
    const assetIndexId = version.detail.assetIndex?.id ?? version.detail.assets ?? versionId
    const versionType = version.detail.type ?? 'release'

    /* -------- 占位符 -------- */
    const values: PlaceholderValues = {
      auth_player_name: account.name,
      version_name: versionId,
      game_directory: gameDir,
      assets_root: assetsDir,
      assets_index_name: assetIndexId,
      auth_uuid: uuid,
      auth_access_token: accessToken,
      auth_session: accessToken, // 1.5 及更早使用
      user_type: userType,
      version_type: versionType,
      natives_directory: nativesDir,
      launcher_name: MCAL_LAUNCHER_NAME,
      launcher_version: MCAL_LAUNCHER_VERSION,
      classpath: classpath.join(delimiter),
      library_directory: librariesDir,
      classpath_separator: delimiter,
      game_assets: assetsDir, // 极老版本（<=1.5）用 ${game_assets}
      user_properties: '{}',
      profile_name: instance.name,
      resolution_width: hasCustomResolution ? String(instance.window.width) : undefined,
      resolution_height: hasCustomResolution ? String(instance.window.height) : undefined,
      quickPlayMultiplayer: qpSupported && qp?.type === 'multiplayer' ? qp.server ?? '' : undefined,
      quickPlaySingleplayer: qpSupported && qp?.type === 'singleplayer' ? qp.world ?? '' : undefined,
      quickPlayRealms: qpSupported && qp?.type === 'realms' ? qp.server ?? '' : undefined
    }

    /* -------- 额外游戏参数 -------- */
    const extraGameArgs: string[] = []
    if (qp && !qpSupported) {
      if (qp.type === 'multiplayer' && qp.server) {
        // 1.20 之前没有 quickPlay，退化为 --server/--port
        const { host, port } = splitServerAddress(qp.server)
        extraGameArgs.push('--server', host, '--port', port)
      } else {
        warnings.push('该版本不支持快速进入世界（需要 1.20+），已忽略 quickPlay 参数')
      }
    }
    if (instance.window.fullscreen) extraGameArgs.push('--fullscreen')
    if (req.serverMode) extraGameArgs.push('--nogui')
    extraGameArgs.push(...(instance.extraGameArgs ?? []))

    const loaderType = instance.loaderType !== 'vanilla' ? instance.loaderType : version.detail.mcalMeta?.loaderType

    const jvmArgs = buildJvmArgs({
      version: version.detail,
      values,
      memory,
      extraJvmArgs: instance.java.extraJvmArgs,
      nativesDir,
      classpath,
      osName: currentOs(),
      loaderType,
      isDemo: false
    })
    if (req.debug) {
      // 调试模式：保留控制台输出 + 崩溃时弹窗（不自动开调试端口，避免暴露本机）
      jvmArgs.push('-Dmcal.debug=true', '-XX:+ShowMessageBoxOnError')
    }
    const gameArgs = buildGameArgs({ version: version.detail, values, extraGameArgs, rules })

    const mainClass = version.detail.mainClass
    if (!mainClass) {
      throw new Error(`版本 ${version.id} 的 json 缺少 mainClass，无法启动（版本文件可能损坏）`)
    }

    const context: LaunchContextInfo = {
      javaPath: java?.path ?? instance.java.javaPath ?? '',
      javaMajor: java?.majorVersion ?? 0,
      mainClass,
      classpath,
      jvmArgs,
      gameArgs,
      nativeDir: nativesDir,
      gameDir,
      assetsDir,
      librariesDir,
      versionType,
      assetIndexId
    }

    if (java) {
      log.info(
        `启动准备完成：${version.id}（Java ${java.majorVersion}，classpath ${classpath.length} 项，内存 ${memory.maxMB}MB，警告 ${warnings.length} 条）`
      )
    } else {
      log.warn(`启动准备完成但缺少可用 Java：${version.id}（需要 Java ${requiredMajor}）`)
    }

    return {
      context,
      version,
      java,
      nativesDir,
      missingJava,
      javaRecommendation,
      warnings
    }
  }

  /** 启动游戏；返回 pid 与进程句柄 */
  async launch(
    req: LaunchRequest,
    instance: Instance,
    account: Account,
    events: GameProcessEvents = {}
  ): Promise<{ pid: number; process: GameProcess; preparation: LaunchPreparation }> {
    const existing = this.games.get(instance.id)
    if (existing?.process.isRunning()) {
      throw new Error(`实例「${instance.name}」已在运行中（pid ${existing.process.pid}），请先停止后再启动`)
    }

    const preparation = await this.prepare(req, instance, account)
    if (preparation.missingJava) {
      const explain = preparation.javaRecommendation?.explain ?? ''
      throw new Error(`启动失败：未找到可用的 Java 运行时。${explain}`)
    }

    if (req.preLaunchCommand?.trim()) {
      await runHook(req.preLaunchCommand, instance.gameDir, '启动前脚本')
    }

    // 日志轮转：mcal-latest.log → mcal-<时间戳>.log
    const logsDir = join(instance.gameDir, 'logs')
    const logFile = join(logsDir, 'mcal-latest.log')
    await ensureDir(logsDir)
    if (await pathExists(logFile)) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      await rename(logFile, join(logsDir, `mcal-${stamp}.log`)).catch(() => undefined)
    }

    const versionId = preparation.version.id
    const startedAtMs = Date.now()
    const info: RunningGameInfo = {
      pid: 0,
      instanceId: instance.id,
      versionId,
      startedAt: new Date(startedAtMs).toISOString(),
      uptimeMs: 0,
      state: 'starting',
      logFilePath: logFile,
      isServer: req.serverMode === true
    }

    const wrappedEvents: GameProcessEvents = {
      onLog: (line) => {
        const tracked = this.games.get(instance.id)
        if (tracked && tracked.info.state === 'starting') tracked.info.state = 'running'
        events.onLog?.(line)
      },
      onRawOutput: (chunk) => events.onRawOutput?.(chunk),
      onError: (error) => events.onError?.(error),
      onExit: (code, signal) => {
        const tracked = this.games.get(instance.id)
        if (tracked) {
          tracked.info.exitCode = code
          tracked.info.uptimeMs = Date.now() - tracked.startedAtMs
          if (tracked.process.wasStopRequested) tracked.info.state = 'exited'
          else if (code === 0 && !tracked.process.diagnostics.sawFatalJvmCrash) tracked.info.state = 'exited'
          else tracked.info.state = 'crashed'
          this.finished.unshift({ ...tracked.info })
          if (this.finished.length > 50) this.finished.length = 50
          this.games.delete(instance.id)
          log.info(`实例「${instance.name}」结束：state=${tracked.info.state} code=${code ?? '-'}`)
        }
        if (req.postExitCommand?.trim()) {
          runHook(req.postExitCommand, instance.gameDir, '退出后脚本').catch((err) => {
            log.warn(`退出后脚本失败：${messageOf(err)}`)
          })
        }
        events.onExit?.(code, signal)
      }
    }

    const process = new GameProcess({
      command: preparation.context.javaPath,
      args: [...preparation.context.jvmArgs, preparation.context.mainClass, ...preparation.context.gameArgs],
      cwd: instance.gameDir,
      windowsHide: !this.deps.settings.launcher.showGameWindowLog,
      logFile,
      events: wrappedEvents
    })

    process.start()
    info.pid = process.pid
    this.games.set(instance.id, { instanceId: instance.id, process, info, startedAtMs })
    log.info(`实例「${instance.name}」已启动：pid=${process.pid}，版本 ${versionId}，Java ${preparation.java?.majorVersion ?? '?'}`)

    return { pid: process.pid, process, preparation }
  }

  /** 运行中的进程 + 最近结束的记录（UI 可据此显示状态与退出码） */
  getRunning(): RunningGameInfo[] {
    const now = Date.now()
    const running = [...this.games.values()].map((tracked) => ({
      ...tracked.info,
      uptimeMs: now - tracked.startedAtMs
    }))
    return [...running, ...this.finished]
  }

  getProcess(instanceId: string): GameProcess | null {
    return this.games.get(instanceId)?.process ?? null
  }

  async stop(instanceId: string, force = false): Promise<void> {
    const tracked = this.games.get(instanceId)
    if (!tracked) return
    await tracked.process.stop({ force })
  }

  async stopAll(): Promise<void> {
    const all = [...this.games.values()]
    await Promise.all(all.map((tracked) => tracked.process.stop()))
  }

  /* ---------------- 内部：Java 选择 ---------------- */

  private async selectJava(
    instance: Instance,
    requiredMajor: number,
    warnings: string[]
  ): Promise<JavaRuntimeInfo | null> {
    const scanner = this.deps.javaScanner
    const strict = instance.java.ignoreJavaVersion !== true

    // 1) 实例手动指定：用户意图优先，即使版本不匹配也使用（仅提示）
    const explicit = instance.java.javaPath?.trim()
    if (explicit) {
      const probed = await scanner.probe(explicit).catch(() => null)
      if (probed) {
        if (strict && !javaIsCompatible(probed, requiredMajor)) {
          warnings.push(`实例指定的 Java ${probed.majorVersion}（${probed.path}）不满足 Java ${requiredMajor} 的要求，仍按指定使用`)
        }
        return probed
      }
      warnings.push(`实例指定的 Java 无法使用，已回退到自动选择：${explicit}`)
    }

    let candidates = scanner.getCached()
    if (candidates.length === 0) {
      try {
        candidates = await scanner.scan()
      } catch (err) {
        warnings.push(`Java 扫描失败：${messageOf(err)}`)
      }
    }

    // 2) 全局首选 Java
    const preferred = this.deps.settings.java.preferredJava?.trim()
    if (preferred) {
      const key = normalizePathForCompare(preferred)
      let chosen = candidates.find((c) => normalizePathForCompare(c.path) === key) ?? null
      if (!chosen) chosen = await scanner.probe(preferred).catch(() => null)
      if (chosen && (!strict || javaIsCompatible(chosen, requiredMajor))) return chosen
      if (chosen) warnings.push(`全局首选的 Java ${chosen.majorVersion} 与要求 Java ${requiredMajor} 不匹配，已改用其他版本`)
    }

    // 3) 兼容最佳
    const preferredVendor = this.deps.settings.java.preferredVendor
    const best = pickBestJava(candidates, requiredMajor, { preferVendor: preferredVendor })
    if (best) return best

    // 忽略版本校验时：挑一个能跑的最高版本
    if (!strict) {
      const usable = candidates.filter((c) => !c.error && c.majorVersion >= 8)
      if (usable.length > 0) return usable.sort((a, b) => b.majorVersion - a.majorVersion)[0]
    }
    return null
  }
}

/* ------------------------------------------------------------------ *
 *  内部函数
 * ------------------------------------------------------------------ */

function splitServerAddress(address: string): { host: string; port: string } {
  const trimmed = address.trim()
  const match = /^(.*):(\d{1,5})$/.exec(trimmed)
  if (match) return { host: match[1], port: match[2] }
  return { host: trimmed, port: '25565' }
}

/** 执行 preLaunch / postExit 自定义命令（shell 语义，输出进启动器日志） */
async function runHook(command: string, cwd: string, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new Error(`${label}无法执行：${messageOf(err)}`))
      return
    }
    let output = ''
    const collect = (chunk: Buffer): void => {
      if (output.length < 16_000) output += decodeText(chunk).text
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => reject(new Error(`${label}执行失败：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        log.debug(`${label}完成：${command}`)
        resolve()
      } else {
        log.warn(`${label}输出：\n${output.slice(-2000)}`)
        reject(new Error(`${label}失败（退出码 ${code}）`))
      }
    })
  })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
