/** 渲染进程访问主进程 API 的唯一入口（window.mcal 的强类型封装）。 */

import type {
  Account,
  AgentEvent,
  ChatAttachment,
  ChatMessage,
  ContentFile,
  ContentIssue,
  ContentKind,
  ContentMeta,
  DeepPartial,
  DevTemplate,
  DiagnosticReport,
  GameDirCandidate,
  GameDirEntry,
  ImagePreset,
  Instance,
  JavaInstallCandidate,
  JavaRuntimeInfo,
  KnowledgeArticle,
  KnowledgeHit,
  LaunchRequest,
  LoaderInstallRequest,
  LoaderInstallResult,
  LoaderVersion,
  McalSettings,
  MemoryRecord,
  ModpackManifest,
  PermissionResponse,
  Platform,
  ProjectDetail,
  ProjectSearchResult,
  ProjectType,
  ProjectVersion,
  RunningGameInfo,
  ServerCoreDownload,
  ServerCoreType,
  ServerInstance,
  SkillContent,
  SkillMeta,
  SystemInfo,
  TaskState,
  ToolDefinition,
  UpdateAsset,
  UpdateCheckResult,
  UpdateDownloadResult,
  VersionListing,
  VersionInstallPlan,
  VersionInstallResult,
  VersionManifest
} from '@shared/types'

declare global {
  interface Window {
    mcal: import('@shared/types').McalApi
  }
}

function api(): Window['mcal'] {
  if (!window.mcal) {
    throw new Error('MCAL API 未注入：preload 脚本可能未加载（请重启应用）。')
  }
  return window.mcal
}

export const mcal = {
  /* ---------- 设置 ---------- */
  getSettings: () => api().settings.get(),
  updateSettings: (patch: DeepPartial<McalSettings>) => api().settings.update(patch),
  pickDir: (opts?: { title?: string; defaultPath?: string }) => api().settings.pickDir(opts),
  pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }) =>
    api().settings.pickFile(opts),

  /* ---------- 实例 ---------- */
  listInstances: () => api().instance.list(),
  createInstance: (patch: Partial<Instance> & { name: string }) => api().instance.create(patch),
  updateInstance: (id: string, patch: Partial<Instance>) => api().instance.update(id, patch),
  deleteInstance: (id: string) => api().instance.delete(id),
  openInstanceDir: (id: string) => api().instance.openDir(id),

  /* ---------- 版本 ---------- */
  listVersions: () => api().version.list() as Promise<VersionListing[]>,
  getManifest: (refresh?: boolean) => api().version.manifest(refresh),
  installVersion: (gameVersion: string) => api().version.install(gameVersion),
  installVersionPlan: (plan: VersionInstallPlan) =>
    api().version.installPlan(plan) as Promise<VersionInstallResult>,
  removeVersion: (versionId: string) => api().version.remove(versionId),
  listLoaderVersions: (opts: { loaderType: LoaderInstallRequest['loaderType']; gameVersion?: string }) =>
    api().version.loaderVersions(opts) as Promise<LoaderVersion[]>,
  installLoader: (req: LoaderInstallRequest) => api().version.installLoader(req) as Promise<LoaderInstallResult>,

  /* ---------- 启动 ---------- */
  launch: (req: LaunchRequest) => api().launch(req),
  stopGame: (instanceId: string, force?: boolean) => api().stop(instanceId, force),
  runningGames: () => api().running() as Promise<RunningGameInfo[]>,

  /* ---------- 日志 ---------- */
  listLogs: (instanceId: string) => api().log.list(instanceId),
  readLog: (instanceId: string, opts?: { tailLines?: number; file?: string }) => api().log.read(instanceId, opts),
  analyzeLog: (opts: { instanceId?: string; file?: string; text?: string }) =>
    api().log.analyze(opts) as Promise<DiagnosticReport>,

  /* ---------- 内容 ---------- */
  scanContent: (gameDir: string) => api().content.scan(gameDir) as Promise<ContentFile[]>,
  toggleContent: (path: string, enabled: boolean) => api().content.toggle(path, enabled),
  deleteContent: (paths: string[]) => api().content.remove(paths),
  importContent: (gameDir: string, kind: ContentKind, paths?: string[]) => api().content.import(gameDir, kind, paths),
  contentMeta: (path: string) => api().content.meta(path) as Promise<ContentMeta | null>,
  validateContent: (opts: { gameDir: string; gameVersion?: string; loaderType?: LoaderInstallRequest['loaderType']; side?: 'client' | 'server' }) =>
    api().content.validate(opts) as Promise<ContentIssue[]>,

  /* ---------- 平台 ---------- */
  searchProjects: (opts: {
    query: string
    platform?: Platform
    projectType?: ProjectType
    gameVersion?: string
    loader?: LoaderInstallRequest['loaderType']
    limit?: number
    offset?: number
  }) => api().project.search(opts) as Promise<ProjectSearchResult[]>,
  projectVersions: (opts: { platform: Platform; projectId: string; gameVersion?: string; loader?: LoaderInstallRequest['loaderType'] }) =>
    api().project.versions(opts) as Promise<ProjectVersion[]>,
  projectDetail: (opts: { platform: Platform; projectId: string }) =>
    api().project.detail(opts) as Promise<ProjectDetail | null>,
  installProject: (opts: {
    platform: Platform
    projectId: string
    versionId?: string
    gameDir: string
    kind: ProjectType
    gameVersion?: string
    loader?: LoaderInstallRequest['loaderType']
  }) => api().project.install(opts),

  /* ---------- Java ---------- */
  listJava: (refresh?: boolean) => api().java.list(refresh) as Promise<JavaRuntimeInfo[]>,
  javaCandidates: (opts?: { majorVersion?: number }) =>
    api().java.candidates(opts) as Promise<JavaInstallCandidate[]>,
  installJava: (candidate: JavaInstallCandidate) => api().java.install(candidate) as Promise<JavaRuntimeInfo>,

  /* ---------- 服务端 ---------- */
  listServers: () => api().server.list() as Promise<ServerInstance[]>,
  createServer: (patch: Partial<ServerInstance> & { name: string; gameVersion: string; coreType: ServerCoreType }) =>
    api().server.create(patch) as Promise<ServerInstance>,
  updateServer: (id: string, patch: Partial<ServerInstance>) => api().server.update(id, patch),
  deleteServer: (id: string) => api().server.delete(id),
  serverCores: (opts: { coreType: ServerCoreType; gameVersion?: string }) =>
    api().server.cores(opts) as unknown as Promise<{
      gameVersion: string | null
      builds?: ServerCoreDownload[]
      gameVersions?: string[]
    }>,
  installServer: (opts: { coreType: ServerCoreType; gameVersion: string; dir: string; name: string; build?: string; acceptEula?: boolean }) =>
    api().server.install(opts) as Promise<ServerInstance>,
  startServer: (id: string) => api().server.start(id),
  stopServer: (id: string, force?: boolean) => api().server.stop(id, force),
  runningServers: () =>
    api().server.running() as Promise<
      { id: string; pid: number; state: string; startedAt: number; uptimeMs: number; exitCode?: number | null; players?: { online: number; max: number } }[]
    >,
  acceptEula: (id: string, accept: boolean) => api().server.acceptEula(id, accept),
  serverProperties: (id: string) => api().server.properties(id),
  setServerProperties: (id: string, props: Record<string, string>) => api().server.setProperties(id, props),

  /* ---------- 整合包 ---------- */
  inspectModpack: (file: string) => api().modpack.inspect(file) as Promise<ModpackManifest | null>,
  importModpack: (opts: { file?: string; dir?: string; targetDir: string; name?: string }) =>
    api().modpack.import(opts),
  exportModpack: (opts: { instanceId: string; outFile: string; includeSaves?: boolean; includeConfig?: boolean }) =>
    api().modpack.export(opts),

  /* ---------- 账号 ---------- */
  listAccounts: () => api().account.list() as Promise<Account[]>,
  createOfflineAccount: (name: string) => api().account.createOffline(name) as Promise<Account>,
  removeAccount: (id: string) => api().account.remove(id),
  setActiveAccount: (id: string) => api().account.setActive(id),
  loginMicrosoft: () => api().account.loginMicrosoft() as Promise<Account>,

  /* ---------- Agent ---------- */
  newAgentSession: (opts?: { title?: string }) => api().agent.newSession(opts),
  agentSessions: () => api().agent.sessions(),
  loadAgentSession: (id: string) => api().agent.loadSession(id) as Promise<{ id: string; title: string; messages: ChatMessage[] }>,
  deleteAgentSession: (id: string) => api().agent.deleteSession(id),
  sendAgentMessage: (opts: { sessionId: string; text: string; attachments?: ChatAttachment[]; contextHint?: string }) =>
    api().agent.send(opts),
  abortAgent: (sessionId: string) => api().agent.abort(sessionId),
  respondPermission: (res: PermissionResponse) => api().agent.respondPermission(res),
  onAgentEvent: (cb: (payload: { sessionId: string; event: AgentEvent }) => void) => api().agent.onEvent(cb),
  agentProviders: () => api().agent.providers(),
  agentPresets: () => api().agent.presets() as Promise<
    {
      id: string
      name: string
      baseUrl: string
      model: string
      models: string[]
      note: string
      docsUrl?: string
      supportsTools: boolean
      supportsVision: boolean
      supportsReasoning: boolean
      supportsPromptCache: boolean
    }[]
  >,
  testProvider: (id: string) => api().agent.testProvider(id),
  agentContextUsage: (sessionId: string) => api().agent.contextUsage(sessionId),
  agentSkills: () => api().agent.skills() as Promise<SkillMeta[]>,
  agentSkillRead: (name: string) => api().agent.readSkill(name) as Promise<SkillContent | null>,
  agentTools: () => api().agent.tools() as Promise<ToolDefinition[]>,

  /* ---------- 记忆 ---------- */
  listMemory: (opts?: { limit?: number; offset?: number }) => api().memory.list(opts) as Promise<MemoryRecord[]>,
  searchMemory: (query: string, limit?: number) => api().memory.search(query, limit),
  writeMemory: (record: Partial<MemoryRecord> & { problem: string; solution: string }) =>
    api().memory.write(record) as Promise<MemoryRecord>,
  updateMemory: (id: string, patch: Partial<MemoryRecord>) => api().memory.update(id, patch),
  deleteMemory: (id: string) => api().memory.remove(id),
  memoryStats: () => api().memory.stats(),

  /* ---------- 知识库 ---------- */
  searchKnowledge: (query: string, limit?: number) => api().knowledge.search(query, limit) as Promise<KnowledgeHit[]>,
  listKnowledge: (category?: string) => api().knowledge.list(category),
  readKnowledge: (id: string) => api().knowledge.read(id) as Promise<KnowledgeArticle | null>,

  /* ---------- 开发 ---------- */
  devTemplates: () => api().dev.templates() as Promise<DevTemplate[]>,
  devScaffold: (opts: { templateId: string; targetDir: string; options: Record<string, string> }) =>
    api().dev.scaffold(opts),
  devBuild: (opts: { dir: string; task?: string }) => api().dev.build(opts),

  /* ---------- 游戏目录 ---------- */
  detectGameDirs: () => api().gameDir.detect() as Promise<GameDirCandidate[]>,
  probeGameDir: (path: string) => api().gameDir.probe(path) as Promise<GameDirCandidate>,
  addGameDir: (path: string, label?: string) => api().gameDir.add(path, label) as Promise<GameDirEntry[]>,
  removeGameDir: (path: string) => api().gameDir.remove(path) as Promise<GameDirEntry[]>,

  /* ---------- 自动更新 ---------- */
  checkUpdate: (opts?: { manual?: boolean }) => api().update.check(opts) as Promise<UpdateCheckResult>,
  downloadUpdate: (asset: UpdateAsset) => api().update.download(asset) as Promise<UpdateDownloadResult>,
  openUpdateRelease: (url: string) => api().update.openRelease(url),
  onUpdateEvent: (cb: Parameters<ReturnType<typeof api>['update']['onEvent']>[0]) => api().update.onEvent(cb),

  /* ---------- 媒体 ---------- */
  mediaProviders: () => api().media.providers(),
  generateImage: (opts: {
    prompt: string
    negativePrompt?: string
    width?: number
    height?: number
    count?: number
    outputDir?: string
    pixelSize?: number
    preset?: ImagePreset
    seed?: number
  }) => api().media.generate(opts),
  /** 生成结果在磁盘上，渲染进程受 CSP 限制读不了 file://，统一走主进程转 data URL */
  readLocalImage: (path: string) => api().media.readImage(path),

  /* ---------- 任务与系统 ---------- */
  listTasks: () => api().task.list() as Promise<TaskState[]>,
  cancelTask: (taskId: string) => api().task.cancel(taskId),
  onTaskEvent: (cb: (task: TaskState) => void) => api().task.onEvent(cb),
  systemInfo: () => api().system.info() as Promise<SystemInfo>,
  openPath: (path: string) => api().system.openPath(path),
  revealPath: (path: string) => api().system.revealPath(path),
  openExternal: (url: string) => api().system.openExternal(url),
  versions: () => api().system.version()
}
