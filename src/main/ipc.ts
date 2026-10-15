/** IPC 注册：把渲染进程的请求路由到服务容器。 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { cpus, freemem, platform, release, totalmem } from 'node:os'
import { IPC } from '@shared/types'
import type {
  ChatAttachment,
  ContentKind,
  DeepPartial,
  Instance,
  JavaInstallCandidate,
  LaunchRequest,
  LoaderInstallRequest,
  McalSettings,
  ModpackManifest,
  PermissionResponse,
  Platform,
  ProjectType,
  ServerCoreType,
  ServerInstance,
  SystemInfo,
  AgentEvent
} from '@shared/types'
import { logger } from '@core/util/logger'
import { pathExists } from '@core/util/fsx'
import { PROVIDER_PRESETS } from '@agent/provider'
import type { ServiceContainer } from './container'
import type { LauncherApi } from './launcher-api'
import { resolvePendingPermission } from './permissions'

export interface IpcContext {
  container: ServiceContainer
  api: LauncherApi
  getWindow: () => BrowserWindow | null
  /** 把 Agent 事件推给渲染进程 */
  emitAgentEvent: (sessionId: string, event: AgentEvent) => void
  onQuit: () => void
}

/** 渲染进程受 CSP 限制无法加载 file://，图片统一转成 data URL 传过去。 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024

async function readLocalImage(filePath: string): Promise<{ dataUrl: string; bytes: number } | null> {
  if (!filePath) return null
  const mime = IMAGE_MIME[extname(filePath).toLowerCase()]
  if (!mime) return null
  try {
    const buffer = await readFile(filePath)
    if (buffer.byteLength > MAX_PREVIEW_BYTES) return null
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, bytes: buffer.byteLength }
  } catch {
    return null
  }
}

export function registerIpc(ctx: IpcContext): () => void {
  const { container, api } = ctx
  const handles: string[] = []

  const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R): void => {
    // 重复注册会让 Electron 抛错并中断后面所有通道的注册，这里直接跳过并留下线索
    if (handles.includes(channel)) {
      logger.error('ipc', `通道 ${channel} 被注册了两次，已忽略后一次`)
      return
    }
    handles.push(channel)
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await fn(...(args as T))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('ipc', `${channel} 失败：${message}`)
        throw new Error(message)
      }
    })
  }

  /* ------------------------------ 设置 ------------------------------ */
  handle(IPC.settingsGet, () => container.settings.get())
  handle(IPC.settingsUpdate, async (patch: DeepPartial<McalSettings>) => {
    const updated = container.settings.update(patch)
    container.applySettings(updated)
    await container.settings.flush()
    // provider 变更后 Agent 需要重建（getProvider 是惰性的，这里只需清缓存）
    return updated
  })
  handle(IPC.settingsPickDir, async (opts?: { title?: string; defaultPath?: string }) => {
    const window = ctx.getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: opts?.title ?? '选择目录',
          defaultPath: opts?.defaultPath,
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle(
    IPC.settingsPickFile,
    async (opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }) => {
      const window = ctx.getWindow()
      const result = window
        ? await dialog.showOpenDialog(window, {
            title: opts?.title ?? '选择文件',
            filters: opts?.filters,
            properties: opts?.multi ? ['openFile', 'multiSelections'] : ['openFile']
          })
        : await dialog.showOpenDialog({ properties: ['openFile'] })
      return result.canceled ? null : result.filePaths
    }
  )

  /* ------------------------------ 实例 ------------------------------ */
  handle(IPC.instanceList, () => api.listInstances())
  handle(IPC.instanceCreate, (patch: Partial<Instance> & { name: string }) => api.createInstance(patch))
  handle(IPC.instanceUpdate, (id: string, patch: Partial<Instance>) => api.updateInstance(id, patch))
  handle(IPC.instanceDelete, (id: string) => api.deleteInstance(id))
  handle(IPC.instanceOpenDir, async (id: string) => {
    const dir = await api.openInstanceDir(id)
    await shell.openPath(dir)
  })

  /* ------------------------------ 版本 ------------------------------ */
  handle(IPC.versionList, () => api.listVersions())
  handle(IPC.versionManifest, (refresh?: boolean) => api.getManifest(refresh))
  handle(IPC.versionInstall, (gameVersion: string) => api.installVersion(gameVersion))
  handle(IPC.versionDelete, async (versionId: string) => {
    const settings = container.settings.get()
    const { removePath } = await import('@core/util/fsx')
    const dir = join(settings.defaultGameDir, 'versions', versionId)
    await removePath(dir)
  })
  handle(IPC.loaderVersions, (opts: { loaderType: never; gameVersion?: string }) => api.listLoaderVersions(opts))
  handle(IPC.loaderInstall, (req: LoaderInstallRequest) => api.installLoader(req))

  /* ------------------------------ 启动 ------------------------------ */
  handle(IPC.launch, (req: LaunchRequest) => api.launch(req))
  handle(IPC.launchStop, (instanceId: string, force?: boolean) => api.stopGame(instanceId, force))
  handle(IPC.launchRunning, () => api.listRunningGames())

  /* ------------------------------ 日志与诊断 ------------------------------ */
  handle(IPC.logList, async (instanceId: string) => {
    const instance = await api.getInstance(instanceId)
    if (!instance) throw new Error(`实例不存在：${instanceId}`)
    return api.listLogs(instance)
  })
  handle(IPC.logRead, (instanceId: string, opts?: { tailLines?: number; file?: string }) => api.readGameLog(instanceId, opts))
  handle(IPC.diagnose, (opts: { instanceId?: string; logPath?: string; text?: string }) => api.diagnose(opts))
  handle(IPC.logAnalyze, (opts: { instanceId?: string; file?: string; text?: string }) =>
    api.diagnose({ instanceId: opts.instanceId, logPath: opts.file, text: opts.text })
  )

  /* ------------------------------ 内容 ------------------------------ */
  handle(IPC.contentScan, (gameDir: string) => api.scanContent(gameDir))
  handle(IPC.contentToggle, (path: string, enabled: boolean) => api.setContentEnabled(path, enabled))
  handle(IPC.contentDelete, (paths: string[]) => api.deleteContent(paths))
  handle(IPC.contentImport, async (gameDir: string, kind: ContentKind, paths?: string[]) => {
    // 拖拽导入会直接给路径；按钮导入则弹选择框
    let sources = Array.isArray(paths) ? paths.filter(Boolean) : []
    if (sources.length === 0) {
      const picked = await pickFiles(ctx, [
        { name: '内容文件', extensions: ['jar', 'zip', 'mcpack'] },
        { name: '全部文件', extensions: ['*'] }
      ])
      if (!picked || picked.length === 0) return []
      sources = picked
    }
    return api.importContent(gameDir, sources, kind)
  })
  handle(IPC.contentValidate, (opts: { gameDir: string; gameVersion?: string; loaderType?: never; side?: 'client' | 'server' }) =>
    api.validateContent(opts)
  )
  handle(IPC.contentMeta, async (path: string) => {
    const { parseContentFile, guessContentKind } = await import('@core/content/metadata')
    return (await parseContentFile(path, guessContentKind(path))).meta
  })

  /* ------------------------------ 平台 ------------------------------ */
  handle(
    IPC.projectSearch,
    (opts: { query: string; platform?: Platform; projectType?: ProjectType; gameVersion?: string; loader?: never; limit?: number; offset?: number }) =>
      api.searchProjects(opts)
  )
  handle(IPC.projectVersions, (opts: { platform: Platform; projectId: string; gameVersion?: string; loader?: never }) =>
    api.listProjectVersions(opts)
  )
  handle(IPC.projectDetail, (opts: { platform: Platform; projectId: string }) => api.getProjectDetail(opts))
  handle(IPC.projectInstall, (opts: Parameters<LauncherApi['installProject']>[0]) => api.installProject(opts))

  /* ------------------------------ Java ------------------------------ */
  handle(IPC.javaList, (refresh?: boolean) => api.listJava(refresh))
  handle(IPC.javaScan, () => api.listJava(true))
  handle(IPC.javaCandidates, (opts?: { majorVersion?: number }) => container.javaInstaller.listCandidates(opts))
  handle(IPC.javaInstall, (candidate: JavaInstallCandidate) => api.installJava(candidate))

  /* ------------------------------ 服务端 ------------------------------ */
  handle(IPC.serverList, () => api.listServerInstances())
  handle(IPC.serverCreate, (patch: Partial<ServerInstance> & { name: string; gameVersion: string; coreType: ServerCoreType }) =>
    api.createServer(patch)
  )
  handle(IPC.serverUpdate, (id: string, patch: Partial<ServerInstance>) => api.updateServer(id, patch))
  handle(IPC.serverDelete, (id: string) => api.deleteServer(id))
  handle(IPC.serverCores, async (opts: { coreType: ServerCoreType; gameVersion?: string }) => {
    // 同一通道两种用途：给 gameVersion 就是查构建列表，否则查该核心支持的 MC 版本
    if (opts.gameVersion) {
      return { gameVersion: opts.gameVersion, builds: await api.listServerCores(opts.coreType, opts.gameVersion) }
    }
    return { gameVersion: null, gameVersions: await api.listServerGameVersions(opts.coreType) }
  })
  handle(IPC.serverInstall, (opts: Parameters<LauncherApi['installServer']>[0]) => api.installServer(opts))
  handle(IPC.serverStart, (id: string) => api.startServer(id))
  handle(IPC.serverStop, (id: string, force?: boolean) => api.stopServer(id, force))
  handle(IPC.serverRunning, () => container.serverManager.listRunning())
  handle(IPC.serverAcceptEula, (id: string, accept: boolean) => api.acceptEula(id, accept))
  handle(IPC.serverProps, (id: string) => api.serverProperties(id))
  handle(IPC.serverPropsSet, (id: string, props: Record<string, string>) => api.setServerProperties(id, props))

  /* ------------------------------ 整合包 ------------------------------ */
  handle(IPC.modpackInspect, async (opts: { file?: string; dir?: string }) => {
    if (!opts.file && !opts.dir) {
      const files = await pickFiles(ctx, [{ name: '整合包', extensions: ['zip', 'mrpack'] }])
      if (!files || files.length === 0) return null
      opts = { ...opts, file: files[0] }
    }
    return api.inspectModpack(opts)
  })
  handle(IPC.modpackImport, async (opts: { file?: string; dir?: string; targetDir: string; name?: string }) => {
    let target = opts.targetDir
    if (!target) {
      const picked = await pickDir(ctx, '选择整合包安装位置')
      if (!picked) return null
      target = picked
    }
    return api.importModpack({ ...opts, targetDir: target })
  })
  handle(IPC.modpackExport, async (opts: { instanceId: string; outFile: string; format?: 'modrinth' | 'mcal' | 'curseforge' }) => {
    const out = opts.outFile || (await pickSave(ctx, '导出整合包', 'modpack.zip', [{ name: 'Zip 压缩包', extensions: ['zip'] }]))
    if (!out) return null
    return api.exportModpack({ instanceId: opts.instanceId, outFile: out, format: opts.format ?? 'modrinth' })
  })

  /* ------------------------------ 账号 ------------------------------ */
  handle(IPC.accountList, () => container.settings.listAccounts())
  handle(IPC.accountCreateOffline, async (name: string) => {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) throw new Error('账号名称不能为空')
    if (trimmed.length > 16) throw new Error('离线账号名称不能超过 16 个字符')
    if (!/^[A-Za-z0-9_]+$/.test(trimmed)) throw new Error('离线账号名称只能包含字母、数字与下划线')
    const { randomUUID } = await import('node:crypto')
    const account = {
      id: `acc_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      type: 'offline' as const,
      name: trimmed,
      uuid: '',
      createdAt: new Date().toISOString()
    }
    container.settings.addAccount(account)
    return account
  })
  handle(IPC.accountRemove, (id: string) => container.settings.removeAccount(id))
  handle(IPC.accountSetActive, (id: string) => container.settings.setActiveAccount(id))
  handle(IPC.accountLoginMicrosoft, async () => {
    throw new Error(
      '微软登录需要 Azure 应用注册（client id）。请先在「设置 → 账号」中配置，或使用离线账号。'
    )
  })

  /* ------------------------------ Agent ------------------------------ */
  handle(IPC.agentNewSession, (opts?: { title?: string }) => container.harness.newSession(opts ?? {}))
  handle(IPC.agentSessions, () => container.harness.listSessions())
  handle(IPC.agentLoadSession, async (id: string) => {
    const session = await container.harness.loadSession(id)
    if (!session) throw new Error(`会话不存在：${id}`)
    return { id: session.id, title: session.title, messages: session.messages }
  })
  handle(IPC.agentDeleteSession, (id: string) => container.harness.deleteSession(id))
  handle(
    IPC.agentSend,
    async (opts: { sessionId: string; text: string; attachments?: ChatAttachment[]; contextHint?: string }) => {
      const { sessionId, text, attachments, contextHint } = opts
      // 后台执行，事件通过 agentEvent 通道推送
      void container.harness
        .send({ sessionId, text, attachments, contextHint })
        .catch((err) => {
          ctx.emitAgentEvent(sessionId, {
            type: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
        })
    }
  )
  handle(IPC.agentAbort, (sessionId: string) => container.harness.abort(sessionId))
  handle(IPC.agentPermissionRespond, (response: PermissionResponse) => {
    // 先投递给等待中的 harness 请求，再通知 harness 内部记录
    resolvePendingPermission(response)
    container.harness.respondPermission(response)
  })
  handle(IPC.agentProviders, () => container.settings.get().providers)
  handle(IPC.agentPresets, () =>
    PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      models: preset.models,
      note: preset.note,
      docsUrl: preset.docsUrl,
      supportsTools: preset.capabilities?.tools ?? true,
      supportsVision: preset.capabilities?.vision ?? false,
      supportsReasoning: preset.capabilities?.reasoning ?? false,
      supportsPromptCache: preset.capabilities?.promptCache ?? false
    }))
  )
  handle(IPC.agentTestProvider, async (id: string) => {
    const settings = container.settings.get()
    const providerSettings = settings.providers.find((p) => p.id === id)
    if (!providerSettings) return { ok: false, message: `未找到 provider：${id}` }
    if (!providerSettings.apiKey) return { ok: false, message: '尚未填写 API Key' }
    const { createProvider } = await import('@agent/provider')
    const provider = createProvider(providerSettings)
    return provider.ping()
  })
  handle(IPC.agentSkills, () => container.skills.list())
  handle(IPC.agentSkillRead, (name: string) => container.skills.read(name))
  handle(IPC.agentTools, () => container.tools.definitions())

  /* ------------------------------ 记忆 ------------------------------ */
  handle(IPC.memoryList, (opts?: { limit?: number; offset?: number }) => container.memory.list(opts))
  handle(IPC.memorySearch, (query: string, limit?: number) => container.memory.search(query, { limit }))
  handle(IPC.memoryWrite, (record: never) => container.memory.write(record))
  handle(IPC.memoryUpdate, (id: string, patch: never) => container.memory.update(id, patch))
  handle(IPC.memoryDelete, (id: string) => container.memory.remove(id))
  handle(IPC.memoryStats, () => container.memory.stats())

  /* ------------------------------ 知识库 ------------------------------ */
  handle(IPC.knowledgeSearch, (query: string, limit?: number) => container.knowledge.search(query, { limit }))
  handle(IPC.knowledgeList, (category?: string) => container.knowledge.list(category))
  handle(IPC.knowledgeRead, (id: string) => container.knowledge.read(id))

  /* ------------------------------ 开发 ------------------------------ */
  handle(IPC.devTemplates, () => container.templates.list())
  handle(IPC.devScaffold, (opts: { templateId: string; targetDir: string; options: Record<string, string> }) =>
    container.scaffolder.scaffold({
      templateId: opts.templateId,
      targetDir: resolve(opts.targetDir),
      variables: opts.options,
      force: true
    })
  )
  handle(IPC.devBuild, (opts: { dir: string; task?: string }) => container.builder.build(opts))

  /* ------------------------------ 媒体 ------------------------------ */
  handle(IPC.mediaProviders, () => container.media.listProviders())
  handle(IPC.mediaGenerate, (opts: never) => container.media.generate(opts))
  handle(IPC.mediaReadImage, async (filePath: string) => readLocalImage(filePath))

  /* ------------------------------ 任务与系统 ------------------------------ */
  handle(IPC.taskList, () => container.tasks.list())
  handle(IPC.taskCancel, (taskId: string) => container.tasks.invokeCancel(taskId))
  handle(IPC.systemInfo, async (): Promise<SystemInfo> => {
    const settings = container.settings.get()
    const total = Math.round(totalmem() / 1024 / 1024)
    const gpus: { model?: string; vendorId?: string }[] = []
    try {
      const { app } = await import('electron')
      const info = (await app.getGPUInfo('basic')) as {
        gpuDevice?: { deviceString?: string; vendorId?: number }[]
      }
      if (Array.isArray(info?.gpuDevice)) {
        for (const device of info.gpuDevice) {
          gpus.push({ model: device?.deviceString, vendorId: device?.vendorId ? String(device.vendorId) : undefined })
        }
      }
    } catch {
      /* GPU 信息拿不到不影响主流程 */
    }
    return {
      platform: platform(),
      arch: process.arch,
      osVersion: release(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCores: cpus().length,
      totalMemoryMB: total,
      freeMemoryMB: Math.round(freemem() / 1024 / 1024),
      recommendedMaxHeapMB: Math.max(2048, Math.round(total * 0.6)),
      gpus,
      rootDir: settings.rootDir
    }
  })
  handle(IPC.systemOpenPath, async (path: string) => {
    const target = resolve(path)
    if (!(await pathExists(target))) throw new Error(`路径不存在：${target}`)
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })
  handle(IPC.systemRevealPath, async (path: string) => {
    shell.showItemInFolder(resolve(path))
  })
  handle(IPC.shellOpenExternal, async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接')
    await shell.openExternal(url)
  })
  handle(IPC.appVersion, () => ({
    app: container.appVersion,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }))

  /* ------------------------------ 记忆写入的 Agent 事件重放 ------------------------------ */
  handle(IPC.agentContextUsage, (sessionId: string) => container.harness.contextUsage(sessionId))

  /* ------------------------------ 窗口控制 ------------------------------ */
  const windowHandlers: [string, () => void][] = [
    [IPC.windowMinimize, () => ctx.getWindow()?.minimize()],
    [IPC.windowMaximize, () => {
      const window = ctx.getWindow()
      if (!window) return
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    }],
    [IPC.windowClose, () => ctx.getWindow()?.close()]
  ]
  for (const [channel, fn] of windowHandlers) {
    ipcMain.on(channel, () => fn())
  }

  logger.info('ipc', `已注册 ${handles.length} 个 IPC 通道`)
  return () => {
    for (const channel of handles) ipcMain.removeHandler(channel)
    for (const [channel] of windowHandlers) ipcMain.removeAllListeners(channel)
  }
}

async function pickFiles(ctx: IpcContext, filters: { name: string; extensions: string[] }[]): Promise<string[] | null> {
  const window = ctx.getWindow()
  const options = { properties: ['openFile', 'multiSelections'] as const, filters }
  const result = window
    ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
    : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
  return result.canceled ? null : result.filePaths
}

async function pickDir(ctx: IpcContext, title: string): Promise<string | null> {
  const window = ctx.getWindow()
  const properties: ('openDirectory' | 'createDirectory')[] = ['openDirectory', 'createDirectory']
  const result = window
    ? await dialog.showOpenDialog(window, { title, properties })
    : await dialog.showOpenDialog({ title, properties })
  return result.canceled ? null : result.filePaths[0] ?? null
}

async function pickSave(ctx: IpcContext, title: string, defaultFileName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  const window = ctx.getWindow()
  const options = { title, defaultPath: defaultFileName, filters }
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}
