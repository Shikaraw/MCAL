/**
 * Preload：向渲染进程暴露受控的 API（window.mcal）。
 *
 * 只暴露白名单方法，不做任何通用 ipcRenderer 透传，
 * 这样即使渲染进程被注入脚本也无法调用未授权通道。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type {
  AgentEvent,
  ChatAttachment,
  ChatMessage,
  ContentKind,
  DeepPartial,
  Instance,
  JavaInstallCandidate,
  LaunchRequest,
  LoaderInstallRequest,
  VersionInstallPlan,
  VersionInstallResult,
  McalApi,
  McalSettings,
  PermissionResponse,
  Platform,
  ProjectType,
  ServerCoreType,
  ServerInstance,
  TaskState
} from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: McalApi = {
  settings: {
    get: () => invoke<McalSettings>(IPC.settingsGet),
    update: (patch: DeepPartial<McalSettings>) => invoke<McalSettings>(IPC.settingsUpdate, patch),
    pickDir: (opts) => invoke(IPC.settingsPickDir, opts),
    pickFile: (opts) => invoke(IPC.settingsPickFile, opts)
  },
  gameDir: {
    detect: () => invoke(IPC.gameDirDetect),
    probe: (path: string) => invoke(IPC.gameDirProbe, path),
    add: (path: string, label?: string) => invoke(IPC.gameDirAdd, path, label),
    remove: (path: string) => invoke(IPC.gameDirRemove, path)
  },
  update: {
    check: (opts) => invoke(IPC.updateCheck, opts),
    download: (asset) => invoke(IPC.updateDownload, asset),
    openRelease: (url: string) => invoke<void>(IPC.updateOpenRelease, url),
    onEvent: (cb) => {
      const listener = (_event: unknown, payload: unknown): void => cb(payload as never)
      ipcRenderer.on(IPC.updateEvent, listener)
      return () => ipcRenderer.removeListener(IPC.updateEvent, listener)
    }
  },
  instance: {
    list: () => invoke<Instance[]>(IPC.instanceList),
    create: (patch) => invoke<Instance>(IPC.instanceCreate, patch),
    update: (id, patch) => invoke<Instance>(IPC.instanceUpdate, id, patch),
    delete: (id) => invoke<void>(IPC.instanceDelete, id),
    openDir: (id) => invoke<void>(IPC.instanceOpenDir, id)
  },
  version: {
    list: () => invoke(IPC.versionList),
    manifest: (refresh) => invoke(IPC.versionManifest, refresh),
    install: (gameVersion) => invoke(IPC.versionInstall, gameVersion),
    installPlan: (plan: VersionInstallPlan) => invoke<VersionInstallResult>(IPC.versionInstallPlan, plan),
    remove: (versionId) => invoke<void>(IPC.versionDelete, versionId),
    loaderVersions: (opts) => invoke(IPC.loaderVersions, opts),
    installLoader: (req: LoaderInstallRequest) => invoke(IPC.loaderInstall, req)
  },
  launch: (req: LaunchRequest) => invoke<{ pid: number }>(IPC.launch, req),
  stop: (instanceId: string, force?: boolean) => invoke<void>(IPC.launchStop, instanceId, force),
  running: () => invoke(IPC.launchRunning),
  log: {
    list: (instanceId) => invoke(IPC.logList, instanceId),
    read: (instanceId, opts) => invoke<string>(IPC.logRead, instanceId, opts),
    analyze: (opts) => invoke(IPC.logAnalyze, opts)
  },
  content: {
    scan: (gameDir) => invoke(IPC.contentScan, gameDir),
    toggle: (path, enabled) => invoke<void>(IPC.contentToggle, path, enabled),
    remove: (paths) => invoke(IPC.contentDelete, paths),
    import: (gameDir: string, kind: ContentKind, paths?: string[]) => invoke<string[]>(IPC.contentImport, gameDir, kind, paths),
    meta: (path) => invoke(IPC.contentMeta, path),
    validate: (opts) => invoke(IPC.contentValidate, opts)
  },
  project: {
    search: (opts) => invoke(IPC.projectSearch, opts),
    versions: (opts) => invoke(IPC.projectVersions, opts),
    detail: (opts) => invoke(IPC.projectDetail, opts),
    install: (opts) => invoke(IPC.projectInstall, opts)
  },
  java: {
    list: (refresh) => invoke(IPC.javaList, refresh),
    candidates: (opts) => invoke(IPC.javaCandidates, opts),
    install: (candidate: JavaInstallCandidate) => invoke(IPC.javaInstall, candidate)
  },
  server: {
    list: () => invoke<ServerInstance[]>(IPC.serverList),
    create: (patch) => invoke<ServerInstance>(IPC.serverCreate, patch),
    update: (id, patch) => invoke<ServerInstance>(IPC.serverUpdate, id, patch),
    delete: (id) => invoke<void>(IPC.serverDelete, id),
    cores: (opts: { coreType: ServerCoreType; gameVersion?: string }) => invoke(IPC.serverCores, opts),
    install: (opts) => invoke<ServerInstance>(IPC.serverInstall, opts),
    start: (id) => invoke<{ pid: number }>(IPC.serverStart, id),
    stop: (id, force) => invoke<void>(IPC.serverStop, id, force),
    running: () => invoke(IPC.serverRunning),
    acceptEula: (id, accept) => invoke<void>(IPC.serverAcceptEula, id, accept),
    properties: (id) => invoke(IPC.serverProps, id),
    setProperties: (id, props) => invoke<void>(IPC.serverPropsSet, id, props)
  },
  modpack: {
    inspect: (file: string) => invoke(IPC.modpackInspect, { file }),
    import: (opts) => invoke(IPC.modpackImport, opts),
    export: (opts) => invoke<void>(IPC.modpackExport, opts)
  },
  account: {
    list: () => invoke(IPC.accountList),
    createOffline: (name: string) => invoke(IPC.accountCreateOffline, name),
    remove: (id) => invoke<void>(IPC.accountRemove, id),
    setActive: (id) => invoke<void>(IPC.accountSetActive, id),
    loginMicrosoft: () => invoke(IPC.accountLoginMicrosoft)
  },
  agent: {
    newSession: (opts) => invoke<string>(IPC.agentNewSession, opts),
    sessions: () => invoke(IPC.agentSessions),
    loadSession: (id) => invoke<{ id: string; title: string; messages: ChatMessage[] }>(IPC.agentLoadSession, id),
    deleteSession: (id) => invoke<void>(IPC.agentDeleteSession, id),
    send: (opts: { sessionId: string; text: string; attachments?: ChatAttachment[]; contextHint?: string }) =>
      invoke<void>(IPC.agentSend, opts),
    abort: (sessionId) => invoke<void>(IPC.agentAbort, sessionId),
    respondPermission: (res: PermissionResponse) => invoke<void>(IPC.agentPermissionRespond, res),
    onEvent: (cb: (e: { sessionId: string; event: AgentEvent }) => void) => {
      const listener = (_event: unknown, payload: { sessionId: string; event: AgentEvent }): void => cb(payload)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    },
    providers: () => invoke(IPC.agentProviders),
    presets: () => invoke(IPC.agentPresets),
    testProvider: (id: string) => invoke(IPC.agentTestProvider, id),
    contextUsage: (sessionId: string) => invoke(IPC.agentContextUsage, sessionId),
    skills: () => invoke(IPC.agentSkills),
    readSkill: (name: string) => invoke(IPC.agentSkillRead, name),
    tools: () => invoke(IPC.agentTools)
  },
  memory: {
    list: (opts) => invoke(IPC.memoryList, opts),
    search: (query, limit) => invoke(IPC.memorySearch, query, limit),
    write: (record) => invoke(IPC.memoryWrite, record),
    update: (id, patch) => invoke(IPC.memoryUpdate, id, patch),
    remove: (id) => invoke<void>(IPC.memoryDelete, id),
    stats: () => invoke(IPC.memoryStats)
  },
  knowledge: {
    search: (query, limit) => invoke(IPC.knowledgeSearch, query, limit),
    list: (category) => invoke(IPC.knowledgeList, category),
    read: (id) => invoke(IPC.knowledgeRead, id)
  },
  dev: {
    templates: () => invoke(IPC.devTemplates),
    scaffold: (opts) => invoke(IPC.devScaffold, opts),
    build: (opts) => invoke(IPC.devBuild, opts)
  },
  media: {
    providers: () => invoke(IPC.mediaProviders),
    generate: (opts) => invoke(IPC.mediaGenerate, opts),
    readImage: (path) => invoke<{ dataUrl: string; bytes: number } | null>(IPC.mediaReadImage, path)
  },
  task: {
    list: () => invoke<TaskState[]>(IPC.taskList),
    cancel: (taskId) => invoke<void>(IPC.taskCancel, taskId),
    onEvent: (cb: (task: TaskState) => void) => {
      const listener = (_event: unknown, task: TaskState): void => cb(task)
      ipcRenderer.on('task:event', listener)
      return () => ipcRenderer.removeListener('task:event', listener)
    }
  },
  system: {
    info: () => invoke(IPC.systemInfo),
    openPath: (path) => invoke<void>(IPC.systemOpenPath, path),
    revealPath: (path) => invoke<void>(IPC.systemRevealPath, path),
    openExternal: (url) => invoke<void>(IPC.shellOpenExternal, url),
    version: () => invoke(IPC.appVersion)
  },
  window: {
    platform: process.platform,
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    maximize: () => ipcRenderer.send(IPC.windowMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    isMaximized: () => invoke<boolean>(IPC.windowIsMaximized),
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const listener = (_event: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on(IPC.windowMaximizedChanged, listener)
      return () => ipcRenderer.removeListener(IPC.windowMaximizedChanged, listener)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('mcal', api)
} else {
  // 理论上不会走到（contextIsolation 始终开启），保留兜底避免白屏
  ;(globalThis as unknown as { mcal: McalApi }).mcal = api
}

export type { McalApi, Platform, ProjectType }
