/**
 * LauncherServiceApi 实现：Agent 工具与 UI 的统一操作入口。
 *
 * 这一层负责把「用户/模型意图」翻译成核心引擎调用，并处理：
 * - 实例默认值推导（版本、内存、目录）
 * - 长任务的进度上报（tasks）
 * - 失败信息的中文化包装（不要把英文堆栈直接抛给 UI）
 */

import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  Account,
  ContentFile,
  ContentIssue,
  ContentKind,
  DiagnosticReport,
  Instance,
  JavaRuntimeInfo,
  LaunchRequest,
  LaunchContextInfo,
  LoaderInstallRequest,
  LoaderInstallResult,
  LoaderType,
  ModpackManifest,
  Platform,
  ProjectDetail,
  ProjectSearchResult,
  ProjectType,
  ProjectVersion,
  RunningGameInfo,
  ServerCoreDownload,
  ServerCoreType,
  ServerInstance,
  VersionInstallPlan,
  VersionInstallProgress,
  VersionInstallResult,
  VersionManifest
} from '@shared/types'
import type { ServiceContainer } from './container'
import { logger } from '@core/util/logger'
import { ensureDir, isDirectory, pathExists, readTextSmart, removePath } from '@core/util/fsx'
import { requiredJavaMajor } from '@core/java/requirement'
import {
  InstallProgressAggregator,
  defaultInstanceName,
  describeInstallPlan,
  loaderLabel,
  normalizeInstallPlan,
  splitOptiFineVersion
} from '@core/mojang/install-plan'

const log = logger.scoped('api')

export interface LauncherApiOptions {
  container: ServiceContainer
  /** 获取当前账号（未登录时用离线账号兜底） */
  getAccount: () => Account | null
}

export class LauncherApi {
  private container: ServiceContainer
  private getAccount: () => Account | null

  constructor(options: LauncherApiOptions) {
    this.container = options.container
    this.getAccount = options.getAccount
  }

  /* ------------------------------ 实例 ------------------------------ */

  async listInstances(): Promise<Instance[]> {
    return this.container.instances.list()
  }

  async getInstance(id: string): Promise<Instance | null> {
    return this.container.instances.get(id)
  }

  async createInstance(patch: Partial<Instance> & { name: string }): Promise<Instance> {
    const settings = this.container.settings.get()
    const id = patch.id ?? `ins_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const name = patch.name.trim() || '新实例'
    const gameDir = patch.gameDir
      ? resolve(patch.gameDir)
      : join(settings.defaultGameDir, name.replace(/[<>:"/\\|?*]/g, '_'))
    await ensureDir(gameDir)

    // 版本推导：优先用户指定（且已安装），否则用已安装的正式版，最后用最新正式版
    let versionId = patch.versionId ?? ''
    const installed = await this.container.repository.listLocalVersions(gameDir).catch(() => [])
    if (!versionId || !installed.some((v) => v.id === versionId)) {
      const manifest = await this.container.manifest.getManifest().catch(() => null)
      const candidates = installed.filter((v) => v.loaderType === 'vanilla')
      versionId =
        candidates.find((v) => v.id === manifest?.latest.release)?.id ??
        candidates[candidates.length - 1]?.id ??
        installed[installed.length - 1]?.id ??
        manifest?.latest.release ??
        versionId ??
        ''
    }

    const instance: Instance = {
      id,
      name,
      gameDir,
      versionId,
      loaderType: patch.loaderType ?? 'vanilla',
      loaderVersion: patch.loaderVersion,
      isolatedVersionDir: patch.isolatedVersionDir,
      java: patch.java ?? {},
      memory: patch.memory ?? { minMB: 0, maxMB: 4096, auto: true },
      window: patch.window ?? { width: 1280, height: 720, fullscreen: false },
      extraGameArgs: patch.extraGameArgs,
      isolatedAssets: patch.isolatedAssets,
      iconPath: patch.iconPath,
      notes: patch.notes,
      tags: patch.tags,
      createdAt: new Date().toISOString()
    }
    await this.container.instances.upsert(instance)
    await this.container.refreshMemo()
    log.info(`创建实例 ${instance.name}（${instance.id}）`)
    return instance
  }

  async updateInstance(id: string, patch: Partial<Instance>): Promise<Instance> {
    const existing = await this.container.instances.get(id)
    if (!existing) throw new Error(`实例不存在：${id}`)
    const updated: Instance = {
      ...existing,
      ...patch,
      id: existing.id,
      // 嵌套对象要深合并，避免只传 java.javaPath 时把 extraJvmArgs 清空
      java: { ...existing.java, ...(patch.java ?? {}) },
      memory: { ...existing.memory, ...(patch.memory ?? {}) },
      window: { ...existing.window, ...(patch.window ?? {}) }
    }
    await this.container.instances.upsert(updated)
    await this.container.refreshMemo()
    return updated
  }

  async deleteInstance(id: string): Promise<void> {
    const instance = await this.container.instances.get(id)
    if (!instance) return
    // 只删记录，不删游戏文件（用户可能仍想保留目录）
    await this.container.instances.remove(id)
    await this.container.refreshMemo()
    log.info(`删除实例记录 ${instance.name}（游戏目录保留：${instance.gameDir}）`)
  }

  /* ------------------------------ 版本 ------------------------------ */

  async listVersions(): Promise<{ id: string; type: string; installed: boolean; loaderType: LoaderType; gameDir?: string }[]> {
    // 版本可能不在默认目录：安装向导允许自选目录，用户登记的游戏目录与实例目录也该被看到
    const local: { id: string; loaderType: LoaderType; gameDir: string }[] = []
    const localIds = new Set<string>()
    for (const dir of this.versionDirs()) {
      const versions = await this.container.repository.listLocalVersions(dir).catch(() => [])
      for (const version of versions) {
        if (localIds.has(version.id)) continue
        localIds.add(version.id)
        local.push({ id: version.id, loaderType: version.loaderType, gameDir: dir })
      }
    }
    let manifest: VersionManifest | null = null
    try {
      manifest = await this.container.manifest.getManifest()
    } catch (err) {
      log.warn(`获取版本清单失败（将只显示本地版本）：${err instanceof Error ? err.message : String(err)}`)
    }
    const out: { id: string; type: string; installed: boolean; loaderType: LoaderType; gameDir?: string }[] = []
    for (const version of local) {
      out.push({ id: version.id, type: 'installed', installed: true, loaderType: version.loaderType, gameDir: version.gameDir })
    }
    if (manifest) {
      for (const summary of manifest.versions) {
        if (localIds.has(summary.id)) continue
        out.push({ id: summary.id, type: summary.type, installed: false, loaderType: 'vanilla' })
      }
    }
    return out
  }

  async getManifest(forceRefresh = false): Promise<VersionManifest> {
    return this.container.manifest.getManifest({ forceRefresh })
  }

  async installVersion(gameVersion: string, options?: { onProgress?: (progress: unknown) => void }): Promise<{ versionId: string }> {
    const settings = this.container.settings.get()
    const task = this.container.tasks.create({ kind: 'install-version', label: `安装 Minecraft ${gameVersion}` })
    const controller = new AbortController()
    this.container.tasks.registerCancel(task.taskId, () => controller.abort())
    try {
      const result = await this.container.installer.install({
        gameDir: settings.defaultGameDir,
        versionId: gameVersion,
        signal: controller.signal,
        onProgress: (progress) => {
          this.container.tasks.progress(task.taskId, {
            taskId: task.taskId,
            label: task.label,
            completed: progress.progress?.completed ?? 0,
            total: progress.progress?.total ?? 0,
            bytesDone: progress.progress?.bytesDone ?? 0,
            bytesTotal: progress.progress?.bytesTotal ?? 0,
            speed: progress.progress?.speed ?? 0,
            etaSeconds: progress.progress?.etaSeconds ?? null,
            failures: progress.progress?.failures ?? [],
            state: 'running'
          })
          this.container.tasks.update(task.taskId, { logs: [...(task.logs ?? []).slice(-50), progress.message] })
          options?.onProgress?.(progress)
        }
      })
      this.container.tasks.complete(task.taskId, result)
      return { versionId: result.versionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (controller.signal.aborted) {
        this.container.tasks.cancel(task.taskId)
        throw new Error(`安装 ${gameVersion} 已取消`)
      }
      this.container.tasks.fail(task.taskId, message)
      throw new Error(`安装 ${gameVersion} 失败：${message}`)
    }
  }

  /**
   * 安装向导：把「原版 + 可选加载器 + 可选建实例」作为一次任务完成。
   * 与 installVersion / installLoader 的区别是一次性决定全部选项，
   * 中途失败会带上失败阶段，UI 只需展示一个任务的进度。
   */
  async installVersionPlan(plan: VersionInstallPlan): Promise<VersionInstallResult> {
    const settings = this.container.settings.get()
    const normalized = normalizeInstallPlan(plan, { gameDir: settings.defaultGameDir })
    // 统一成绝对路径：实例记录里存的是 resolve 后的路径，
    // 直接比字符串会因为尾随分隔符或大小写差异漏判，进而重复建实例
    const gameDir = resolve(normalized.gameDir ?? settings.defaultGameDir)
    const task = this.container.tasks.create({ kind: 'install-version', label: describeInstallPlan(normalized) })
    // 「取消任务」必须真的停下来：把 abort 一路传到下载器，否则界面显示已取消、后台还在写文件
    const controller = new AbortController()
    this.container.tasks.registerCancel(task.taskId, () => controller.abort())
    const aggregator = new InstallProgressAggregator()
    let lastMessage = ''

    const publish = (progress: VersionInstallProgress): void => {
      this.container.tasks.progress(task.taskId, {
        taskId: task.taskId,
        label: task.label,
        completed: progress.completed,
        total: progress.total,
        bytesDone: progress.bytesDone,
        bytesTotal: progress.bytesTotal,
        speed: progress.speed,
        etaSeconds: progress.etaSeconds,
        failures: [],
        state: 'running'
      })
      if (progress.message && progress.message !== lastMessage) {
        lastMessage = progress.message
        this.container.tasks.log(task.taskId, progress.message)
      }
    }

    const warnings: string[] = []
    let loaderVersion = normalized.loaderVersion
    let versionId = normalized.gameVersion

    try {
      aggregator.enterPhase('vanilla', `下载 Minecraft ${normalized.gameVersion}`)
      publish(aggregator.snapshot())
      const vanilla = await this.container.installer.install({
        gameDir,
        versionId: normalized.gameVersion,
        signal: controller.signal,
        onProgress: (progress) => {
          // 同一阶段内的文案变化用 setStatus：用 enterPhase 会重复累加已冻结的字节
          if (progress.message) aggregator.setStatus('vanilla', progress.message)
          publish(
            aggregator.update({
              completed: progress.progress?.completed,
              total: progress.progress?.total,
              bytesDone: progress.progress?.bytesDone,
              bytesTotal: progress.progress?.bytesTotal,
              speed: progress.progress?.speed,
              etaSeconds: progress.progress?.etaSeconds
            })
          )
        }
      })
      versionId = vanilla.versionId

      if (normalized.loaderType !== 'vanilla') {
        if (!loaderVersion) {
          // 没说版本就取最新稳定版（列表按版本号降序返回）
          const candidates = await this.container.loaders.listVersions(normalized.loaderType, normalized.gameVersion)
          const picked = candidates.find((item) => item.stable) ?? candidates[0]
          if (!picked) {
            throw new Error(`没有找到 ${loaderLabel(normalized.loaderType)} 适配 ${normalized.gameVersion} 的版本`)
          }
          loaderVersion = picked.version
          if (normalized.loaderType === 'optifine') {
            const parsed = splitOptiFineVersion(picked.version)
            normalized.optifineType = normalized.optifineType ?? parsed?.type
            normalized.optifinePatch = parsed?.patch ?? picked.version
          }
        }

        aggregator.enterPhase('loader', `安装 ${loaderLabel(normalized.loaderType)} ${loaderVersion}`)
        publish(aggregator.snapshot())
        const manager = this.container.loaders.withDeps({
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.download) {
              publish(
                aggregator.update({
                  completed: progress.download.completed,
                  total: progress.download.total,
                  bytesDone: progress.download.bytesDone,
                  bytesTotal: progress.download.bytesTotal,
                  speed: progress.download.speed,
                  etaSeconds: progress.download.etaSeconds
                })
              )
            } else if (progress.message) {
              aggregator.setStatus('loader', `${progress.phase}：${progress.message}`)
              publish(aggregator.snapshot())
            }
          }
        })
        const result = await manager.install({
          gameDir,
          versionId: normalized.gameVersion,
          loaderType: normalized.loaderType,
          loaderVersion: loaderVersion ?? '',
          optifineType: normalized.optifineType,
          optifinePatch: normalized.optifinePatch
        })
        versionId = result.versionId
        loaderVersion = result.loaderVersion ?? loaderVersion
        warnings.push(...(result.warnings ?? []))
      }

      let instanceId: string | undefined
      if (normalized.createInstance) {
        if (controller.signal.aborted) throw new Error('已取消')
        aggregator.enterPhase('instance', '创建实例')
        publish(aggregator.snapshot())
        const existing = await this.container.instances.list()
        const sameOne = existing.find((instance) => instance.versionId === versionId && instance.gameDir === gameDir)
        if (sameOne) {
          instanceId = sameOne.id
          this.container.tasks.log(task.taskId, `已存在相同实例「${sameOne.name}」，直接复用`)
        } else {
          const instance = await this.createInstance({
            name: normalized.instanceName,
            gameDir,
            versionId,
            loaderType: normalized.loaderType,
            loaderVersion
          })
          instanceId = instance.id
        }
      }

      const finalProgress = aggregator.finish()
      publish(finalProgress)
      const result: VersionInstallResult = {
        gameVersion: normalized.gameVersion,
        versionId,
        loaderType: normalized.loaderType,
        loaderVersion,
        gameDir,
        instanceId,
        warnings
      }
      this.container.tasks.complete(task.taskId, result)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const phase = aggregator.snapshot().phase
      const phaseText = phase === 'loader' ? '加载器安装阶段' : phase === 'instance' ? '创建实例阶段' : '原版下载阶段'
      if (controller.signal.aborted) {
        // 用户主动取消：不要报成失败，也不要让 UI 提示去换镜像
        this.container.tasks.cancel(task.taskId)
        throw new Error(`${describeInstallPlan(normalized)} 已取消（${phaseText}）`)
      }
      this.container.tasks.fail(task.taskId, message)
      throw new Error(`${describeInstallPlan(normalized)} 失败（${phaseText}）：${message}`)
    }
  }

  /** 可能放着版本的目录：默认目录 + 登记的游戏目录 + 实例目录 */
  private versionDirs(): string[] {
    const settings = this.container.settings.get()
    const candidates = [
      settings.defaultGameDir,
      ...settings.gameDirs.map((entry) => entry.path),
      ...this.container.instancesMemo.map((instance) => instance.gameDir)
    ]
    const seen = new Set<string>()
    const out: string[] = []
    for (const dir of candidates) {
      if (!dir) continue
      const absolute = resolve(dir)
      const key = absolute.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(absolute)
    }
    return out
  }

  /** 删除已安装版本：按 id 在候选目录里找出真实位置 */
  async deleteVersion(versionId: string, gameDir?: string): Promise<void> {
    if (!/^[\w.+-]+$/.test(versionId)) throw new Error(`非法的版本 id：${versionId}`)
    const candidates = gameDir ? [resolve(gameDir)] : this.versionDirs()
    const removed: string[] = []
    for (const dir of candidates) {
      const target = join(dir, 'versions', versionId)
      if (!(await pathExists(target))) continue
      await removePath(target)
      removed.push(target)
      log.info(`已删除版本 ${versionId}：${target}`)
    }
    if (removed.length === 0) throw new Error(`没有找到已安装的版本 ${versionId}`)
  }

  async verifyVersion(gameDir: string, versionId: string): Promise<{ ok: boolean; detail: string[] }> {
    const result = await this.container.installer.verify({ gameDir, versionId })
    const detail: string[] = []
    detail.push(`客户端 jar：${result.clientJarOk ? '完整' : '缺失或损坏'}`)
    detail.push(`缺失库文件：${result.missingLibraries}`)
    detail.push(`缺失资源文件：${result.missingAssets}`)
    detail.push(...(result.detail ?? []))
    return { ok: result.ok, detail }
  }

  async installLoader(req: LoaderInstallRequest): Promise<LoaderInstallResult> {
    const gameDir = req.gameDir || this.container.settings.get().defaultGameDir
    const task = this.container.tasks.create({
      kind: 'install-loader',
      label: `安装 ${req.loaderType} ${req.loaderVersion || ''}`
    })
    const controller = new AbortController()
    this.container.tasks.registerCancel(task.taskId, () => controller.abort())
    try {
      const manager = this.container.loaders.withDeps({
        signal: controller.signal,
        onProgress: (progress) => {
          this.container.tasks.log(task.taskId, `${progress.phase}：${progress.message}`)
          if (progress.download) {
            this.container.tasks.update(task.taskId, { progress: { ...progress.download, taskId: task.taskId } })
          }
        }
      })
      const result = await manager.install({ ...req, gameDir })
      // 安装成功后可选创建实例
      if (req.createInstance) {
        const existing = await this.container.instances.list()
        // 与安装向导用同一套命名规则，避免出现「fabric 1.20.1」这种生硬的实例名
        const name = req.instanceName ?? defaultInstanceName(req.versionId, req.loaderType, result.loaderVersion)
        if (!existing.some((instance) => instance.versionId === result.versionId && instance.gameDir === gameDir)) {
          await this.createInstance({
            name,
            gameDir,
            versionId: result.versionId,
            loaderType: req.loaderType,
            loaderVersion: result.loaderVersion
          })
        }
      }
      this.container.tasks.complete(task.taskId, result)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (controller.signal.aborted) {
        this.container.tasks.cancel(task.taskId)
        throw new Error(`安装 ${req.loaderType} 已取消`)
      }
      this.container.tasks.fail(task.taskId, message)
      throw err
    }
  }

  async listLoaderVersions(opts: { loaderType: LoaderType; gameVersion?: string }) {
    return this.container.loaders.listVersions(opts.loaderType, opts.gameVersion)
  }

  /* ------------------------------ 启动 ------------------------------ */

  async launch(req: LaunchRequest): Promise<{ pid: number }> {
    const instance = await this.container.instances.get(req.instanceId)
    if (!instance) throw new Error(`实例不存在：${req.instanceId}`)
    const account = this.getAccount() ?? offlineAccount('Player')
    const result = await this.container.launcher.launch(req, instance, account)
    // 记录游玩信息
    await this.container.instances.upsert({
      ...instance,
      lastPlayedAt: new Date().toISOString(),
      lastLaunchedVersion: result.preparation.version.id
    })
    if (result.preparation.warnings.length > 0) {
      log.warn(`启动警告：${result.preparation.warnings.join('；')}`)
    }
    return { pid: result.pid }
  }

  /** 启动前的信息预览（不真的启动），供 UI 展示与 Agent 诊断 */
  async prepareLaunch(req: LaunchRequest): Promise<LaunchContextInfo> {
    const instance = await this.container.instances.get(req.instanceId)
    if (!instance) throw new Error(`实例不存在：${req.instanceId}`)
    const account = this.getAccount() ?? offlineAccount('Player')
    const preparation = await this.container.launcher.prepare(req, instance, account)
    return preparation.context
  }

  async stopGame(instanceId: string, force = false): Promise<void> {
    await this.container.launcher.stop(instanceId, force)
  }

  async listRunningGames(): Promise<RunningGameInfo[]> {
    return this.container.launcher.getRunning()
  }

  /* ------------------------------ 日志与诊断 ------------------------------ */

  async listLogs(instance: Instance): Promise<{ name: string; path: string; size: number; mtimeMs: number }[]> {
    const dirs = [
      { dir: join(instance.gameDir, 'logs'), label: '' },
      { dir: join(instance.gameDir, 'crash-reports'), label: 'crash-reports/' }
    ]
    const out: { name: string; path: string; size: number; mtimeMs: number }[] = []
    const { readdir, stat } = await import('node:fs/promises')
    for (const entry of dirs) {
      if (!(await isDirectory(entry.dir))) continue
      const files = await readdir(entry.dir).catch(() => [])
      for (const file of files) {
        if (!/\.(log|txt|gz)$/i.test(file)) continue
        const full = join(entry.dir, file)
        const info = await stat(full).catch(() => null)
        if (!info) continue
        out.push({ name: `${entry.label}${file}`, path: full, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 60)
  }

  async readGameLog(instanceId: string, opts?: { tailLines?: number; file?: string }): Promise<string> {
    const instance = await this.container.instances.get(instanceId)
    if (!instance) throw new Error(`实例不存在：${instanceId}`)
    const { readTailLines, readTextSmart } = await import('@core/util/fsx')
    if (opts?.file) {
      const candidate = opts.file.includes('/') || opts.file.includes('\\')
        ? join(instance.gameDir, opts.file)
        : (await this.findLogFile(instance, opts.file)) ?? join(instance.gameDir, 'logs', opts.file)
      if (!(await pathExists(candidate))) throw new Error(`日志文件不存在：${opts.file}`)
      if (candidate.endsWith('.gz')) {
        const { gunzipSync } = await import('node:zlib')
        const { readFile } = await import('node:fs/promises')
        const buffer = gunzipSync(await readFile(candidate))
        const text = buffer.toString('utf8')
        return text.split('\n').slice(-(opts.tailLines ?? 100_000)).join('\n')
      }
      if (opts.tailLines) return readTailLines(candidate, opts.tailLines)
      const { text } = await readTextSmart(candidate)
      return text
    }
    const tailLines = opts?.tailLines ?? 200
    for (const name of ['logs/mcal-latest.log', 'logs/latest.log']) {
      const full = join(instance.gameDir, name)
      if (await pathExists(full)) return readTailLines(full, tailLines)
    }
    // 没有任何日志时，挑最新一个
    const logs = await this.listLogs(instance)
    if (logs.length > 0) return readTailLines(logs[0].path, tailLines)
    throw new Error(`实例「${instance.name}」还没有日志文件（游戏可能从未启动过）。`)
  }

  private async findLogFile(instance: Instance, name: string): Promise<string | null> {
    const logs = await this.listLogs(instance)
    return logs.find((entry) => entry.name === name || entry.name.endsWith(name))?.path ?? null
  }

  async diagnose(opts: { instanceId?: string; logPath?: string; text?: string }): Promise<DiagnosticReport> {
    const engine = this.container.diagnostics
    let text = opts.text ?? ''
    let facts: Parameters<typeof engine.diagnose>[0]['facts'] = {}

    if (opts.instanceId) {
      const instance = await this.container.instances.get(opts.instanceId)
      if (!instance) throw new Error(`实例不存在：${opts.instanceId}`)
      const java = await this.container.javaScanner.scan().catch(() => [])
      const requiredMajor = requiredJavaMajor(instance.versionId)
      const javaInfo = java.find((j) => j.majorVersion === requiredMajor) ?? java[0]
      const instanceFacts = await engine.collectFactsFromInstance({
        gameDir: instance.gameDir,
        versionId: instance.versionId,
        javaMajor: javaInfo?.majorVersion,
        javaPath: instance.java.javaPath ?? javaInfo?.path,
        maxHeapMB: instance.memory.auto ? undefined : instance.memory.maxMB
      })
      facts = { ...instanceFacts, loaderType: instance.loaderType, exitCode: undefined }
      if (!text) {
        // 优先崩溃报告，其次日志尾部
        const crashDir = join(instance.gameDir, 'crash-reports')
        if (await isDirectory(crashDir)) {
          const { readdir, stat } = await import('node:fs/promises')
          const files = (await readdir(crashDir).catch(() => [])).filter((f) => f.endsWith('.txt'))
          const newest = (
            await Promise.all(
              files.map(async (file) => ({ file, info: await stat(join(crashDir, file)).catch(() => null) }))
            )
          )
            .filter((entry) => entry.info)
            .sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0))[0]
          if (newest) {
            const { text: crashText } = await readTextSmart(join(crashDir, newest.file))
            text = crashText
          }
        }
        if (!text) {
          text = await this.readGameLog(instance.id, { tailLines: 3000 }).catch(() => '')
        }
      }
    } else if (opts.logPath) {
      if (!(await pathExists(opts.logPath))) throw new Error(`文件不存在：${opts.logPath}`)
      const { text: fileText } = await readTextSmart(opts.logPath)
      text = fileText
    }

    if (!text.trim()) {
      throw new Error('没有可分析的日志内容：请提供实例、日志路径或直接给出报错文本。')
    }

    return engine.diagnose({
      text,
      facts,
      knowledge: this.container.knowledge
    })
  }

  /* ------------------------------ 内容 ------------------------------ */

  async scanContent(gameDir: string): Promise<ContentFile[]> {
    return this.container.content.scan({ gameDir, withMeta: true })
  }

  async setContentEnabled(filePath: string, enabled: boolean): Promise<void> {
    await this.container.content.setEnabled(filePath, enabled)
  }

  async deleteContent(paths: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
    return this.container.content.remove(paths)
  }

  async validateContent(opts: {
    gameDir: string
    gameVersion?: string
    loaderType?: LoaderType
    side?: 'client' | 'server'
  }): Promise<ContentIssue[]> {
    return this.container.content.validate(opts)
  }

  async importContent(gameDir: string, sources: string[], kind?: ContentKind): Promise<string[]> {
    const result = await this.container.content.importFiles(gameDir, sources, { kind })
    return result.imported
  }

  /* ------------------------------ 平台 ------------------------------ */

  async searchProjects(opts: {
    query: string
    platform?: Platform
    projectType?: ProjectType
    gameVersion?: string
    loader?: LoaderType
    limit?: number
    offset?: number
  }): Promise<ProjectSearchResult[]> {
    const result = await this.container.platform.search({
      query: opts.query,
      platform: opts.platform ?? 'modrinth',
      projectType: opts.projectType,
      gameVersion: opts.gameVersion,
      loader: opts.loader,
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0
    })
    return result
  }

  async listProjectVersions(opts: {
    platform: Platform
    projectId: string
    gameVersion?: string
    loader?: LoaderType
  }): Promise<ProjectVersion[]> {
    return this.container.platform.versions({
      platform: opts.platform,
      projectId: opts.projectId,
      gameVersion: opts.gameVersion,
      loader: opts.loader
    })
  }

  async getProjectDetail(opts: { platform: Platform; projectId: string }): Promise<ProjectDetail | null> {
    return this.container.platform.detail(opts)
  }

  async installProject(opts: {
    platform: Platform
    projectId: string
    versionId?: string
    gameDir: string
    kind: ProjectType
    gameVersion?: string
    loader?: LoaderType
    withDependencies?: boolean
  }): Promise<{ files: string[]; installed: { projectId: string; versionId: string; fileName: string }[]; warnings: string[] }> {
    const task = this.container.tasks.create({ kind: 'install-project', label: `安装 ${opts.projectId}` })
    try {
      const result = await this.container.platform.install({
        platform: opts.platform,
        projectId: opts.projectId,
        versionId: opts.versionId,
        gameDir: opts.gameDir,
        kind: opts.kind,
        gameVersion: opts.gameVersion,
        loader: opts.loader,
        withDependencies: opts.withDependencies ?? true,
        onProgress: (progress) => this.container.tasks.update(task.taskId, { progress: { ...progress, taskId: task.taskId } })
      })
      this.container.tasks.complete(task.taskId, result)
      return {
        files: result.files,
        installed: result.installed.map((item) => ({
          projectId: item.projectId,
          versionId: item.versionId,
          fileName: item.fileName
        })),
        warnings: result.warnings ?? []
      }
    } catch (err) {
      this.container.tasks.fail(task.taskId, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /* ------------------------------ Java ------------------------------ */

  async listJava(refresh = false): Promise<JavaRuntimeInfo[]> {
    return this.container.javaScanner.scan({ force: refresh })
  }

  async installJava(candidate: Parameters<ServiceContainer['javaInstaller']['install']>[0]) {
    const label = `${candidate.vendor} ${candidate.version}`.trim()
    const task = this.container.tasks.create({ kind: 'install-java', label: `安装 ${label}` })
    const controller = new AbortController()
    this.container.tasks.registerCancel(task.taskId, () => controller.abort())
    try {
      const installed = await this.container.javaInstaller.install(candidate, {
        signal: controller.signal,
        onProgress: (progress) => {
          this.container.tasks.progress(task.taskId, {
            taskId: task.taskId,
            label: task.label,
            completed: progress.completed ?? 0,
            total: progress.total ?? 0,
            bytesDone: progress.bytesDone ?? 0,
            bytesTotal: progress.bytesTotal ?? 0,
            speed: progress.speed ?? 0,
            etaSeconds: progress.etaSeconds ?? null,
            failures: progress.failures ?? [],
            state: 'running'
          })
        }
      })
      this.container.tasks.complete(task.taskId, installed)
      // 安装目录变了，让下一次查询重新扫描而不是命中旧缓存
      await this.container.javaScanner.scan({ force: true }).catch(() => undefined)
      return installed
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.container.tasks.fail(task.taskId, message)
      throw new Error(`安装 Java 失败：${message}`)
    }
  }

  /* ------------------------------ 服务端 ------------------------------ */

  async listServerInstances(): Promise<ServerInstance[]> {
    return this.container.servers.list()
  }

  async getServerInstance(id: string): Promise<ServerInstance | null> {
    return this.container.servers.get(id)
  }

  async createServer(
    patch: Partial<ServerInstance> & { name: string; gameVersion: string; coreType: ServerCoreType }
  ): Promise<ServerInstance> {
    const settings = this.container.settings.get()
    const dir = patch.dir
      ? resolve(patch.dir)
      : join(settings.rootDir, 'servers', patch.name.replace(/[<>:"/\\|?*]/g, '_'))
    return this.container.serverManager.create({
      name: patch.name,
      dir,
      coreType: patch.coreType,
      gameVersion: patch.gameVersion,
      build: patch.coreVersion,
      memory: patch.memory,
      port: patch.port,
      javaPath: patch.javaPath,
      acceptEula: (patch as { eulaAccepted?: boolean }).eulaAccepted,
      autoInstall: true
    })
  }

  async updateServer(id: string, patch: Partial<ServerInstance>): Promise<ServerInstance> {
    return this.container.serverManager.update(id, patch)
  }

  async deleteServer(id: string): Promise<void> {
    await this.container.serverManager.remove(id)
  }

  async listServerCores(coreType: ServerCoreType, gameVersion?: string): Promise<ServerCoreDownload[]> {
    if (!gameVersion) return []
    return this.container.serverCores.listBuilds(coreType, gameVersion)
  }

  async listServerGameVersions(coreType: ServerCoreType): Promise<string[]> {
    return this.container.serverCores.listGameVersions(coreType)
  }

  async installServer(opts: {
    coreType: ServerCoreType
    gameVersion: string
    dir: string
    name: string
    build?: string
    acceptEula?: boolean
  }): Promise<ServerInstance> {
    return this.container.serverManager.create({
      name: opts.name,
      dir: resolve(opts.dir),
      coreType: opts.coreType,
      gameVersion: opts.gameVersion,
      build: opts.build,
      acceptEula: opts.acceptEula,
      autoInstall: true
    })
  }

  async startServer(id: string): Promise<{ pid: number }> {
    return this.container.serverManager.start(id)
  }

  async stopServer(id: string, force = false): Promise<void> {
    await this.container.serverManager.stop(id, { force })
  }

  async serverProperties(id: string): Promise<Record<string, string>> {
    return this.container.serverManager.readProperties(id)
  }

  async setServerProperties(id: string, props: Record<string, string>): Promise<void> {
    await this.container.serverManager.writeProperties(id, props)
  }

  async acceptEula(serverId: string, accept: boolean): Promise<void> {
    await this.container.serverManager.acceptEula(serverId, accept)
  }

  /* ------------------------------ 整合包 ------------------------------ */

  async inspectModpack(opts: { file?: string; dir?: string }): Promise<ModpackManifest> {
    const result = await this.container.modpackInspector.inspect(opts)
    return result.manifest
  }

  async importModpack(opts: { file?: string; dir?: string; targetDir: string; name?: string }): Promise<{ instanceId: string; result: unknown }> {
    const task = this.container.tasks.create({ kind: 'import-modpack', label: `导入整合包` })
    try {
      const installation = await this.container.modpackInstaller.install({
        file: opts.file,
        dir: opts.dir,
        targetGameDir: resolve(opts.targetDir),
        name: opts.name,
        platform: this.container.platform as never,
        onProgress: (progress) =>
          this.container.tasks.log(task.taskId, `${progress.phase}：${progress.message}（${(progress.ratio * 100).toFixed(0)}%）`)
      })
      const instance = await this.createInstance({
        name: opts.name ?? installation.name,
        gameDir: installation.instanceDir,
        versionId: installation.gameVersion,
        loaderType: installation.loaderType,
        loaderVersion: installation.loaderVersion,
        notes: `由整合包导入${installation.warnings.length > 0 ? `\n注意事项：\n${installation.warnings.join('\n')}` : ''}`
      })
      this.container.tasks.complete(task.taskId, installation)
      return { instanceId: instance.id, result: installation }
    } catch (err) {
      this.container.tasks.fail(task.taskId, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async exportModpack(opts: { instanceId: string; outFile: string; format?: 'modrinth' | 'mcal' | 'curseforge' }): Promise<{ file: string; fileCount: number }> {
    const instance = await this.container.instances.get(opts.instanceId)
    if (!instance) throw new Error(`实例不存在：${opts.instanceId}`)
    const task = this.container.tasks.create({ kind: 'export-modpack', label: '导出整合包' })
    try {
      // 尝试用 Modrinth 反查 mod 来源，命中的文件只写 hash+url 而不打包（体积小很多）
      let recognized: Record<string, { platform: 'modrinth'; projectId: string; versionId: string; url?: string; sha1?: string; size?: number }> = {}
      try {
        const modsDir = join(instance.gameDir, 'mods')
        if (await isDirectory(modsDir)) {
          const { readdir } = await import('node:fs/promises')
          const files = (await readdir(modsDir)).filter((f) => f.endsWith('.jar'))
          if (files.length > 0 && files.length <= 300) {
            const hashes = await this.container.content.hashFiles(files.map((f) => join(modsDir, f)))
            const lookup = await this.container.modrinth.lookupByHash(Object.values(hashes))
            for (const [path, hash] of Object.entries(hashes)) {
              const hit = lookup[hash.toLowerCase()] ?? lookup[hash]
              if (hit) {
                recognized[path] = {
                  platform: 'modrinth',
                  projectId: hit.projectId,
                  versionId: hit.versionId,
                  sha1: hash
                }
              }
            }
          }
        }
      } catch (err) {
        log.debug(`Modrinth 反查失败（将全部打包）：${err instanceof Error ? err.message : String(err)}`)
        recognized = {}
      }

      const result = await this.container.modpackExporter.export({
        gameDir: instance.gameDir,
        outFile: resolve(opts.outFile),
        name: instance.name,
        gameVersion: instance.versionId,
        loaderType: instance.loaderType,
        loaderVersion: instance.loaderVersion,
        format: opts.format ?? 'modrinth',
        recognized
      })
      this.container.tasks.complete(task.taskId, result)
      return { file: result.file, fileCount: result.fileCount }
    } catch (err) {
      this.container.tasks.fail(task.taskId, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /* ------------------------------ 目录操作 ------------------------------ */

  async openInstanceDir(id: string): Promise<string> {
    const instance = await this.container.instances.get(id)
    if (!instance) throw new Error(`实例不存在：${id}`)
    if (!(await isDirectory(instance.gameDir))) await ensureDir(instance.gameDir)
    return instance.gameDir
  }
}

/** 离线账号兜底（未创建任何账号时） */
export function offlineAccount(name: string): Account {
  return {
    id: 'offline-default',
    type: 'offline',
    name,
    uuid: '',
    createdAt: new Date().toISOString()
  }
}

export { basename, dirname }
