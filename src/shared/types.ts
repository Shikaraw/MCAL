/**
 * MCAL 共享类型契约
 *
 * 该文件是主进程 / 渲染进程 / 核心引擎 / Agent 运行时之间唯一的数据契约来源。
 * 任何跨进程或跨模块传递的结构都必须在这里定义。
 */

/* ------------------------------------------------------------------ *
 *  基础
 * ------------------------------------------------------------------ */

export type LoaderType =
  | 'vanilla'
  | 'forge'
  | 'neoforge'
  | 'fabric'
  | 'quilt'
  | 'optifine'
  | 'liteloader'
  | 'custom'

export type ReleaseChannel = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

export type OsName = 'windows' | 'osx' | 'linux'

export type ArchName = 'x86' | 'x64' | 'arm64' | 'arm32'

/** 下载源类型 */
export type MirrorId = 'official' | 'bmclapi' | 'custom'

export interface MirrorConfig {
  id: MirrorId
  /** 自定义源的根地址，例如 https://bmclapi2.bangbang93.com */
  baseUrl?: string
  /** 是否用于 Mojang 官方资源 */
  forMojang: boolean
  forForge: boolean
  forFabric: boolean
  forModrinth: boolean
}

/* ------------------------------------------------------------------ *
 *  下载引擎
 * ------------------------------------------------------------------ */

export interface DownloadItem {
  /** 唯一键，用于去重与断点续传 */
  key: string
  url: string
  /** 备用地址（镜像回退） */
  fallbackUrls?: string[]
  dest: string
  /** 期望的 sha1，用于校验与跳过已下载文件 */
  sha1?: string
  /** 期望的 sha256 */
  sha256?: string
  /** 期望文件大小 */
  size?: number
  /** true 时若目标已存在则直接跳过（不做哈希校验） */
  skipIfExists?: boolean
  /** 是否可执行文件（Linux/macOS 需要 chmod） */
  executable?: boolean
}

export interface DownloadProgress {
  taskId: string
  label: string
  /** 已完成文件数 */
  completed: number
  total: number
  /** 当前文件进度 */
  currentFile?: string
  currentFileBytesDone?: number
  currentFileBytesTotal?: number
  /** 全量已传输字节 */
  bytesDone: number
  bytesTotal: number
  /** 每秒字节数（滑动平均） */
  speed: number
  /** 预计剩余秒数，未知为 null */
  etaSeconds: number | null
  failures: { url: string; error: string }[]
  state: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
}

/* ------------------------------------------------------------------ *
 *  Mojang 版本元数据
 * ------------------------------------------------------------------ */

export interface VersionSummary {
  id: string
  type: ReleaseChannel
  url: string
  time: string
  releaseTime: string
  sha1?: string
  complianceLevel?: number
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionSummary[]
}

export interface LibraryDownloadsArtifact {
  path?: string
  sha1?: string
  size?: number
  url?: string
}

export interface LibraryDownloads {
  artifact?: LibraryDownloadsArtifact
  classifiers?: Record<string, LibraryDownloadsArtifact>
}

export interface Library {
  name: string
  downloads?: LibraryDownloads
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  rules?: Rule[]
  url?: string
  /** 部分第三方加载器使用 */
  checksums?: string[]
}

export interface Rule {
  action: 'allow' | 'disallow'
  os?: { name?: string; version?: string; arch?: string }
  features?: Record<string, boolean>
}

export interface AssetIndexRef {
  id: string
  sha1: string
  size: number
  totalSize: number
  url: string
}

export interface AssetObject {
  hash: string
  size: number
  /** 部分资源带有虚拟路径映射 */
  path?: string
}

export interface AssetIndex {
  objects: Record<string, AssetObject>
  virtual?: boolean
  map_to_resources?: boolean
}

export interface ArgumentNode {
  rules?: Rule[]
  value: string | string[]
}

export interface VersionArguments {
  game?: (string | ArgumentNode)[]
  jvm?: (string | ArgumentNode)[]
}

export interface JavaVersionRequirement {
  component?: string
  majorVersion: number
}

export interface VersionDetail {
  id: string
  type?: ReleaseChannel
  inheritsFrom?: string
  mainClass?: string
  assetIndex?: AssetIndexRef
  assets?: string
  downloads?: Record<string, { sha1?: string; size?: number; url?: string }>
  libraries?: Library[]
  arguments?: VersionArguments
  minecraftArguments?: string
  javaVersion?: JavaVersionRequirement
  complianceLevel?: number
  releaseTime?: string
  time?: string
  /** 第三方加载器写入的元信息 */
  mcalMeta?: McalVersionMeta
}

export interface McalVersionMeta {
  loaderType?: LoaderType
  loaderVersion?: string
  /** 记录安装来源与时间，便于诊断 */
  installedAt?: string
  source?: string
  /** 关联的实例 id（同一版本可被多实例复用） */
  notes?: string
}

/* ------------------------------------------------------------------ *
 *  实例（Game Directory）
 * ------------------------------------------------------------------ */

export interface MemoryPolicy {
  /** 最小堆（MB） */
  minMB: number
  /** 最大堆（MB） */
  maxMB: number
  /** true 时按物理内存自动计算 maxMB */
  auto: boolean
}

export interface WindowPolicy {
  width: number
  height: number
  fullscreen: boolean
  /** 自定义游戏窗口标题 */
  title?: string
}

export interface InstanceJavaPolicy {
  /** 手动指定的 java 可执行文件路径 */
  javaPath?: string
  /** 手动指定的额外 JVM 参数 */
  extraJvmArgs?: string[]
  /** 跳过 java 版本校验 */
  ignoreJavaVersion?: boolean
}

export interface Instance {
  id: string
  name: string
  /** 游戏目录绝对路径（.minecraft 等价物） */
  gameDir: string
  /** 版本 id，对应 versions/<id> */
  versionId: string
  loaderType: LoaderType
  loaderVersion?: string
  /** 该实例隔离出的版本目录（可选，HMCL 的版本隔离） */
  isolatedVersionDir?: boolean
  java: InstanceJavaPolicy
  memory: MemoryPolicy
  window: WindowPolicy
  /** 启动后追加到 game args 的参数 */
  extraGameArgs?: string[]
  /** 是否启用实例级别的资源包/光影目录隔离 */
  isolatedAssets?: boolean
  iconPath?: string
  createdAt: string
  lastPlayedAt?: string
  totalPlayTimeMs?: number
  lastLaunchedVersion?: string
  /** 备注，Agent 也会写入诊断结论 */
  notes?: string
  tags?: string[]
  /** 是否为服务器实例 */
  isServer?: boolean
}

/* ------------------------------------------------------------------ *
 *  Java
 * ------------------------------------------------------------------ */

export interface JavaRuntimeInfo {
  path: string
  vendor?: string
  version?: string
  /** 主版本号，例如 8 / 17 / 21 */
  majorVersion: number
  arch?: ArchName
  os?: OsName
  /** true 表示这是 MCAL 自己安装的运行时 */
  managed: boolean
  /** 探测失败时的原因 */
  error?: string
  /** 是否为 64 位 */
  is64Bit?: boolean
  /** jvm 目录（用于 Mojang component 运行时） */
  component?: string
}

export interface JavaInstallCandidate {
  id: string
  /** 发行版名称，例如 Temurin / Zulu / Oracle / Mojang */
  vendor: string
  /** 完整版本号 */
  version: string
  majorVersion: number
  os: OsName
  arch: ArchName
  /** 下载地址 */
  url: string
  /** 文件大小 */
  size?: number
  /** 镜像地址 */
  mirrorUrl?: string
  /** 安装后相对目录名 */
  dirName: string
  source: 'mojang' | 'adoptium' | 'zulu' | 'custom'
}

/* ------------------------------------------------------------------ *
 *  内容（mods / 资源包 / 光影 / 数据包）
 * ------------------------------------------------------------------ */

export type ContentKind = 'mod' | 'resourcepack' | 'shaderpack' | 'datapack' | 'world' | 'modpack'

/** 常见 mod 加载器依赖声明 */
export type ModEnvironment = 'client' | 'server' | 'both'

export interface ContentFile {
  /** 绝对路径 */
  path: string
  fileName: string
  kind: ContentKind
  size: number
  mtimeMs: number
  /** 启用状态（.disabled 后缀视为禁用） */
  enabled: boolean
  /** 解析出的元数据 */
  meta?: ContentMeta
  /** 内容哈希（可选，惰性计算） */
  hash?: string
  /** 读取失败原因 */
  error?: string
}

export interface ContentMeta {
  id?: string
  name?: string
  version?: string
  description?: string
  authors?: string[]
  /** 声明支持的 MC 版本 */
  gameVersions?: string[]
  /** 声明支持的加载器 */
  loaders?: string[]
  environment?: ModEnvironment
  /** 依赖 / 冲突 */
  depends?: { id: string; versionRange?: string; required: boolean }[]
  breaks?: { id: string; versionRange?: string }[]
  license?: string
  homepage?: string
  /** 来源标记，例如 Modrinth 安装 */
  source?: { platform: 'modrinth' | 'curseforge' | 'local' | 'manual'; projectId?: string; versionId?: string }
  /** 整合包特有 */
  packFormat?: number
  /** 光影特有 */
  shaderLanguage?: string
  /** 嵌套结构（整合包内的 mod） */
  nested?: ContentMeta[]
}

export interface ContentIssue {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  /** 相关文件 */
  files?: string[]
  /** 建议的修复动作 */
  suggestion?: string
}

/* ------------------------------------------------------------------ *
 *  Modrinth / 平台检索
 * ------------------------------------------------------------------ */

export type Platform = 'modrinth' | 'curseforge'
export type ProjectType = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'datapack' | 'plugin' | 'world'

export interface ProjectSearchResult {
  platform: Platform
  projectId: string
  slug?: string
  title: string
  description: string
  author?: string
  downloads: number
  follows?: number
  iconUrl?: string
  categories: string[]
  loaders: string[]
  gameVersions: string[]
  projectType: ProjectType
  updatedAt?: string
  license?: string
}

export interface ProjectVersionFile {
  url: string
  filename: string
  size: number
  primary: boolean
  hashes?: Record<string, string>
}

export interface ProjectVersion {
  platform: Platform
  versionId: string
  projectId: string
  name: string
  versionNumber: string
  versionType: 'release' | 'beta' | 'alpha'
  gameVersions: string[]
  loaders: string[]
  dependencies: { projectId?: string; versionId?: string; dependencyType: string }[]
  files: ProjectVersionFile[]
  publishedAt?: string
  downloads?: number
}

export interface ProjectDetail extends ProjectSearchResult {
  body?: string
  issuesUrl?: string
  sourceUrl?: string
  gallery?: { url: string; title?: string }[]
}

/* ------------------------------------------------------------------ *
 *  Mod 加载器安装
 * ------------------------------------------------------------------ */

export interface LoaderVersion {
  loaderType: LoaderType
  /** 加载器自身版本，例如 0.15.11 / 47.3.0 */
  version: string
  /** 对应的 MC 版本 */
  gameVersion: string
  stable: boolean
  /** 附加信息（例如 Forge 需要区分 recommended/latest） */
  label?: string
  /** 下载地址（若安装器需要下载） */
  installerUrl?: string
}

export interface LoaderInstallRequest {
  gameDir: string
  versionId: string
  loaderType: LoaderType
  loaderVersion: string
  /** OptiFine 需要的 type（HD_U / preview 等） */
  optifineType?: string
  optifinePatch?: string
  /** 安装完成后是否把新版本注册为实例 */
  createInstance?: boolean
  instanceName?: string
}

export interface LoaderInstallResult {
  versionId: string
  loaderType: LoaderType
  loaderVersion: string
  /** 安装产物路径（版本 json / jar） */
  files: string[]
  warnings: string[]
}

/**
 * 安装向导的计划：一次决定「装哪个版本 + 装不装加载器 + 装到哪 + 建不建实例」。
 * 原版与加载器在同一个任务里顺序完成，中途失败会明确停在哪一步。
 */
export interface VersionInstallPlan {
  /** 基础游戏版本，例如 1.21.1 */
  gameVersion: string
  /** 目标游戏目录，默认 settings.defaultGameDir */
  gameDir?: string
  /** 加载器；null 或省略表示只装原版 */
  loader?:
    | {
        type: LoaderType
        /** 加载器版本；省略表示用最新/推荐版本 */
        version?: string
        /** OptiFine 专用 */
        optifineType?: string
        optifinePatch?: string
      }
    | null
  /** 安装完成后创建实例（默认 true） */
  createInstance?: boolean
  instanceName?: string
}

export interface VersionInstallResult {
  /** 用户选择的基础版本 */
  gameVersion: string
  /** 实际落地的版本 id（带加载器时为加载器版本 id） */
  versionId: string
  loaderType: LoaderType
  loaderVersion?: string
  gameDir: string
  /** 创建出的实例 id（未创建时为空） */
  instanceId?: string
  warnings: string[]
}

/** 安装向导的进度阶段，用于 UI 显示「正在做什么」 */
export type VersionInstallPhase = 'preparing' | 'vanilla' | 'loader' | 'instance' | 'done'

export interface VersionInstallProgress {
  phase: VersionInstallPhase
  message: string
  /** 总体进度（按字节累加原版 + 加载器） */
  completed: number
  total: number
  bytesDone: number
  bytesTotal: number
  speed: number
  etaSeconds: number | null
}

/* ------------------------------------------------------------------ *
 *  启动
 * ------------------------------------------------------------------ */

export interface LaunchQuickPlay {
  type: 'singleplayer' | 'multiplayer' | 'realms'
  /** 世界文件夹名 */
  world?: string
  /** 服务器地址 host:port */
  server?: string
}

export interface LaunchRequest {
  instanceId: string
  /** 覆盖实例默认值时使用 */
  versionId?: string
  accountId?: string
  /** 是否以调试模式启动（附加调试参数、保留控制台） */
  debug?: boolean
  /** 是否离线启动（跳过网络校验、强制离线账号） */
  offline?: boolean
  quickPlay?: LaunchQuickPlay
  /** 自定义启动前/后脚本 */
  preLaunchCommand?: string
  postExitCommand?: string
  /** 覆盖内存设置（服务器实例常用） */
  memoryOverride?: MemoryPolicy
  /** 服务端启动时使用 */
  serverMode?: boolean
  /** 窗口不可见（服务端） */
  headless?: boolean
}

export interface LaunchContextInfo {
  javaPath: string
  javaMajor: number
  mainClass: string
  classpath: string[]
  jvmArgs: string[]
  gameArgs: string[]
  nativeDir: string
  gameDir: string
  assetsDir: string
  librariesDir: string
  versionType: string
  assetIndexId: string
}

export interface RunningGameInfo {
  pid: number
  instanceId: string
  versionId: string
  startedAt: string
  /** 已运行毫秒 */
  uptimeMs: number
  exitCode?: number | null
  state: 'starting' | 'running' | 'exited' | 'crashed'
  logFilePath?: string
  /** 是否为服务端进程 */
  isServer?: boolean
}

export interface GameLogLine {
  ts: number
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown'
  /** 原始行 */
  raw: string
  /** 抽取出的 logger 名（若有） */
  logger?: string
  /** 抽取出的消息体（若有） */
  message?: string
  /** 被诊断引擎命中的模式 */
  findings?: string[]
}

/* ------------------------------------------------------------------ *
 *  诊断
 * ------------------------------------------------------------------ */

export interface DiagnosticFinding {
  id: string
  /** 严重程度 */
  severity: 'info' | 'warning' | 'error' | 'fatal'
  /** 一句话标题 */
  title: string
  /** 详细说明 */
  detail: string
  /** 命中的原始日志片段 */
  evidence: string[]
  /** 可执行的解决步骤 */
  steps: string[]
  /** 相关知识库条目 id */
  knowledgeIds?: string[]
  /** 涉及的文件 */
  files?: string[]
  /** 置信度 0-1 */
  confidence: number
  category:
    | 'java'
    | 'memory'
    | 'mod-conflict'
    | 'mod-missing-dependency'
    | 'mod-version-mismatch'
    | 'loader'
    | 'graphics'
    | 'auth'
    | 'asset'
    | 'network'
    | 'performance'
    | 'world'
    | 'server'
    | 'unknown'
}

export interface DiagnosticReport {
  id: string
  createdAt: string
  source: string
  /** 输入规模 */
  scannedLines: number
  gameVersion?: string
  loaderType?: LoaderType
  findings: DiagnosticFinding[]
  /** 崩溃摘要（若识别为崩溃） */
  crashSummary?: string
  /** 供 Agent 使用的完整上下文（截断后） */
  rawExcerpt: string
}

/* ------------------------------------------------------------------ *
 *  账号
 * ------------------------------------------------------------------ */

export type AccountType = 'offline' | 'microsoft' | 'authlib-injector'

export interface Account {
  id: string
  type: AccountType
  name: string
  uuid: string
  /** 微软账号 token（加密存储） */
  accessToken?: string
  refreshToken?: string
  /** 过期时间戳（ms） */
  expiresAt?: number
  /** authlib-injector 服务器地址 */
  authServer?: string
  skinModel?: 'default' | 'slim'
  /** 头像 url（三方服务） */
  avatarUrl?: string
  createdAt: string
  lastUsedAt?: string
}

/* ------------------------------------------------------------------ *
 *  服务端
 * ------------------------------------------------------------------ */

export type ServerCoreType = 'vanilla' | 'paper' | 'purpur' | 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'spigot' | 'custom'

export interface ServerInstance {
  id: string
  name: string
  dir: string
  coreType: ServerCoreType
  coreVersion: string
  gameVersion: string
  /** 核心 jar 文件名 */
  jarFile: string
  /** 启动内存 */
  memory: MemoryPolicy
  javaPath?: string
  jvmArgs?: string[]
  /** server.properties 的 key-value 快照 */
  properties?: Record<string, string>
  port?: number
  eulaAccepted: boolean
  createdAt: string
  lastStartedAt?: string
  /** 是否安装过 forge/fabric 服务端 */
  loaderVersion?: string
  notes?: string
}

export interface ServerCoreDownload {
  coreType: ServerCoreType
  gameVersion: string
  /** 构建号（Paper 等） */
  build?: string
  url: string
  fileName: string
  size?: number
  channel?: string
}

/* ------------------------------------------------------------------ *
 *  整合包
 * ------------------------------------------------------------------ */

export interface ModpackManifestFile {
  path: string
  hashes?: Record<string, string>
  downloads?: string[]
  fileSize?: number
  /** 平台信息 */
  platform?: { type: Platform; projectId: string; versionId: string }
  /** 是否可选 */
  optional?: boolean
  /** 目标子目录（mods / resourcepacks / shaderpacks / config） */
  targetDir?: string
}

export interface ModpackManifest {
  format: 'mcal' | 'curseforge' | 'modrinth' | 'mmc' | 'unknown'
  name: string
  version?: string
  author?: string
  description?: string
  gameVersion?: string
  loaderType?: LoaderType
  loaderVersion?: string
  files: ModpackManifestFile[]
  overridesDir?: string
  extra?: Record<string, unknown>
}

/* ------------------------------------------------------------------ *
 *  Agent 运行时
 * ------------------------------------------------------------------ */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallRequest {
  id: string
  name: string
  /** 原始 JSON 字符串（流式拼接结果） */
  arguments: string
}

export interface ChatMessage {
  id?: string
  role: ChatRole
  content: string | null
  /** 助手消息中的工具调用 */
  toolCalls?: ToolCallRequest[]
  /** role=tool 时对应的调用 id */
  toolCallId?: string
  name?: string
  /** 该消息是否被压缩摘要替换 */
  compacted?: boolean
  /** 附件（图片 / 文件引用） */
  attachments?: ChatAttachment[]
  createdAt?: number
  /** 统计 */
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface ChatAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  mimeType?: string
  /** 本地路径或 data url */
  path?: string
  dataUrl?: string
  size?: number
}

export type AgentEvent =
  | { type: 'session_start'; sessionId: string; model: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call_start'; call: ToolCallRequest }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; output: string; meta?: Record<string, unknown> }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
  | { type: 'turn_end'; turn: number; reason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error' | 'success'; message: string }
  | { type: 'compaction'; removed: number; summary: string }
  | { type: 'error'; message: string; detail?: string }
  | { type: 'session_end'; reason: string }
  /** 由工具发起的 UI 侧更新（例如安装进度） */
  | { type: 'ui_event'; channel: string; payload: unknown }

export interface PermissionRequest {
  id: string
  callId: string
  toolName: string
  /** 人类可读的意图描述 */
  summary: string
  detail?: string
  /** 风险等级 */
  risk: 'low' | 'medium' | 'high'
  /** 该工具支持的持久化选项 */
  scopes: ('once' | 'session' | 'always')[]
  /** 选择 session 后记忆多久（毫秒）；0 或未提供表示不记忆 */
  rememberMs?: number
  /** 若被拒绝，agent 收到的提示 */
  denyMessage?: string
}

export type PermissionDecision = 'allow' | 'deny'

export interface PermissionResponse {
  id: string
  decision: PermissionDecision
  scope: 'once' | 'session' | 'always'
}

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  name: string
  /** 给模型看的描述，尽量说明何时使用 */
  description: string
  parameters: ToolParameterSchema
  /** 归类，用于 UI 分组与权限默认值 */
  category: 'filesystem' | 'shell' | 'search' | 'minecraft' | 'knowledge' | 'memory' | 'dev' | 'media' | 'meta' | 'network'
  /** 只读工具可以并发执行 */
  readOnly?: boolean
  /** 危险工具默认需要确认 */
  dangerous?: boolean
  /** 是否需要游戏目录访问权限 */
  requiresPaths?: boolean
  /**
   * 执行体可以绕过工作区限制（例如 shell 能 cd 到任意目录再写文件）。
   * 这类工具在「仅工作区」模式下永远不能自动放行，必须逐次授权。
   */
  escapesWorkspace?: boolean
}

export interface ToolInvocationContext {
  sessionId: string
  /** Agent 可操作的工作区根目录（一般是 launcher 工作目录 + 实例目录） */
  roots: string[]
  /** 当前访问权限级别：full 时不再拒绝工作区外的路径 */
  accessMode: 'workspace' | 'full'
  /** 权限询问回调 */
  requestPermission(req: Omit<PermissionRequest, 'id'>): Promise<PermissionResponse>
  /** 向 UI 推送事件 */
  emit(event: AgentEvent): void
  abortSignal: AbortSignal
  /** 允许访问网络 */
  networkAllowed: boolean
  /** 由宿主注入的服务访问点，避免工具层直接依赖 electron */
  services: AgentServices
}

/** 工具 + 宿主能力之间的桥梁，由主进程注入实现 */
export interface AgentServices {
  launcher: LauncherServiceApi
  knowledge: KnowledgeServiceApi
  memory: MemoryServiceApi
  dev: DevServiceApi
  media: MediaServiceApi
  logger: (msg: string, level?: 'info' | 'warn' | 'error') => void
}

export interface LauncherServiceApi {
  listInstances(): Promise<Instance[]>
  getInstance(id: string): Promise<Instance | null>
  createInstance(patch: Partial<Instance> & { name: string }): Promise<Instance>
  updateInstance(id: string, patch: Partial<Instance>): Promise<Instance>
  deleteInstance(id: string): Promise<void>
  listVersions(): Promise<{ id: string; type: string; installed: boolean; loaderType: LoaderType }[]>
  installVersion(gameVersion: string, options?: { mirror?: MirrorId; onProgress?: (p: unknown) => void }): Promise<{ versionId: string }>
  installLoader(req: LoaderInstallRequest): Promise<LoaderInstallResult>
  /** 校验某版本的安装完整性（库/资源/客户端 jar） */
  verifyVersion(gameDir: string, versionId: string): Promise<{ ok: boolean; detail: string[] }>
  launch(req: LaunchRequest): Promise<{ pid: number }>
  stopGame(instanceId: string, force?: boolean): Promise<void>
  listRunningGames(): Promise<RunningGameInfo[]>
  readGameLog(instanceId: string, opts?: { tailLines?: number; file?: string }): Promise<string>
  listLogs(instance: Instance): Promise<{ name: string; path: string; size: number; mtimeMs: number }[]>
  scanContent(gameDir: string): Promise<ContentFile[]>
  setContentEnabled(filePath: string, enabled: boolean): Promise<void>
  deleteContent(paths: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }>
  validateContent(opts: { gameDir: string; gameVersion?: string; loaderType?: LoaderType; side?: 'client' | 'server' }): Promise<ContentIssue[]>
  installProject(opts: {
    platform: Platform
    projectId: string
    versionId?: string
    gameDir: string
    kind: ProjectType
    gameVersion?: string
    loader?: LoaderType
    withDependencies?: boolean
  }): Promise<{ files: string[]; installed: { projectId: string; versionId: string; fileName: string }[]; warnings: string[] }>
  searchProjects(opts: {
    query: string
    platform?: Platform
    projectType?: ProjectType
    gameVersion?: string
    loader?: LoaderType
    limit?: number
    offset?: number
  }): Promise<ProjectSearchResult[]>
  listJava(): Promise<JavaRuntimeInfo[]>
  diagnose(opts: { instanceId?: string; logPath?: string; text?: string }): Promise<DiagnosticReport>
  listServerInstances(): Promise<ServerInstance[]>
  getServerInstance(id: string): Promise<ServerInstance | null>
  createServer(patch: Partial<ServerInstance> & { name: string; gameVersion: string; coreType: ServerCoreType }): Promise<ServerInstance>
  updateServer(id: string, patch: Partial<ServerInstance>): Promise<ServerInstance>
  deleteServer(id: string): Promise<void>
  listServerCores(coreType: ServerCoreType, gameVersion?: string): Promise<ServerCoreDownload[]>
  installServer(opts: { coreType: ServerCoreType; gameVersion: string; dir: string; name: string; build?: string; acceptEula?: boolean }): Promise<ServerInstance>
  startServer(id: string): Promise<{ pid: number }>
  stopServer(id: string, force?: boolean): Promise<void>
  serverProperties(id: string): Promise<Record<string, string>>
  setServerProperties(id: string, props: Record<string, string>): Promise<void>
  /** 需要用户确认的高风险写操作由主进程负责二次校验 */
  acceptEula(serverId: string, accept: boolean): Promise<void>
  /** 整合包 */
  inspectModpack(opts: { file?: string; dir?: string }): Promise<ModpackManifest>
  importModpack(opts: { file?: string; dir?: string; targetDir: string; name?: string }): Promise<{ instanceId: string; result: unknown }>
  exportModpack(opts: { instanceId: string; outFile: string; format?: 'modrinth' | 'mcal' | 'curseforge' }): Promise<{ file: string; fileCount: number }>
}

export interface KnowledgeServiceApi {
  search(query: string, opts?: { limit?: number; category?: string }): Promise<KnowledgeHit[]>
  read(id: string): Promise<KnowledgeArticle | null>
  list(category?: string): Promise<{ id: string; title: string; category: string; tags: string[]; summary: string }[]>
}

export interface KnowledgeArticle {
  id: string
  title: string
  category: string
  tags: string[]
  summary: string
  body: string
  source?: string
  updatedAt?: string
}

export interface KnowledgeHit {
  article: { id: string; title: string; category: string; tags: string[]; summary: string }
  score: number
  /** 命中的片段 */
  excerpt: string
}

export interface MemoryRecord {
  id: string
  createdAt: string
  updatedAt: string
  /** 问题描述（用户视角） */
  problem: string
  /** 症状关键词，便于召回 */
  symptoms: string[]
  /** 根因 */
  cause?: string
  /** 解决方案 */
  solution: string
  /** 是否验证有效 */
  verified: boolean
  /** 关联的实例 / 版本 / 加载器 */
  context?: {
    instanceId?: string
    instanceName?: string
    gameVersion?: string
    loaderType?: LoaderType
    javaMajor?: number
  }
  /** 来源：自动诊断 or 用户/agent 手动记录 */
  origin: 'auto-diagnose' | 'agent' | 'user'
  /** 命中次数 */
  hits: number
  tags?: string[]
  /** 相关的知识库条目 */
  knowledgeIds?: string[]
}

export interface MemoryServiceApi {
  search(query: string, opts?: { limit?: number; limitToContext?: boolean; context?: MemoryRecord['context'] }): Promise<{ record: MemoryRecord; score: number }[]>
  write(record: Partial<MemoryRecord> & { problem: string; solution: string }): Promise<MemoryRecord>
  update(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord>
  list(opts?: { limit?: number; offset?: number }): Promise<MemoryRecord[]>
  remove(id: string): Promise<void>
  /** 汇总统计，注入系统提示 */
  stats(): Promise<{ total: number; verified: number; topSymptoms: string[] }>
}

export interface DevServiceApi {
  listTemplates(): Promise<DevTemplate[]>
  scaffold(templateId: string, targetDir: string, options: Record<string, string>): Promise<{ files: string[]; root: string }>
  /** 在项目目录执行 gradle 构建任务（需要本机 gradle 或 wrapper） */
  buildProject(dir: string, task?: string): Promise<{ ok: boolean; output: string; code: number | null }>
}

export interface DevTemplate {
  id: string
  name: string
  kind: 'mod' | 'plugin' | 'shaderpack' | 'resourcepack' | 'datapack' | 'modpack'
  loader?: LoaderType
  description: string
  variables: { key: string; label: string; default?: string; required?: boolean }[]
  files: { path: string; content: string }[]
}

export interface MediaServiceApi {
  /** 文生图 */
  generateImage(opts: {
    prompt: string
    negativePrompt?: string
    width?: number
    height?: number
    count?: number
    /** 输出到指定目录（可选） */
    outputDir?: string
    /** 期望的像素尺寸（会做像素化处理，例如 16 / 32 / 64） */
    pixelSize?: number
    /** 风格预设 */
    preset?: ImagePreset
    seed?: number
  }): Promise<{ files: string[]; provider: string }>
  listProviders(): Promise<{ id: string; name: string; configured: boolean; models: string[] }[]>
}

export type ImagePreset = 'mc-item' | 'mc-block' | 'mc-gui' | 'concept-art' | 'logo' | 'raw'

/* ------------------------------------------------------------------ *
 *  技能系统（对齐 ZCode / Claude Skill 的渐进式披露模型）
 * ------------------------------------------------------------------ */

export interface SkillMeta {
  name: string
  description: string
  /** 何时使用该技能 */
  whenToUse?: string
  /** 来源目录 */
  root: string
  /** 允许使用的工具白名单（为空则全部允许） */
  allowedTools?: string[]
  /** 技能附带的知识条目 id */
  knowledgeIds?: string[]
  version?: string
  author?: string
  /** 技能文件路径 */
  file: string
  /** 附加资源目录 */
  resources?: string[]
}

export interface SkillContent extends SkillMeta {
  body: string
}

/* ------------------------------------------------------------------ *
 *  设置
 * ------------------------------------------------------------------ */

export interface ProviderSettings {
  id: string
  /** 显示名 */
  name: string
  /** OpenAI 兼容接口的 base url */
  baseUrl: string
  apiKey: string
  model: string
  /** 备用模型（主模型失败时） */
  fallbackModel?: string
  temperature?: number
  maxTokens?: number
  /** 是否支持 tool calling */
  supportsTools: boolean
  /** 是否支持视觉 */
  supportsVision?: boolean
  /** 是否支持深度思考 */
  supportsReasoning?: boolean
  /** 是否支持 prompt caching（deepseek 的缓存计费） */
  supportsPromptCache?: boolean
  /** 是否在请求中带 reasoning 开关 */
  reasoning?: boolean
  timeoutMs?: number
  contextWindow?: number
}

export interface ImageProviderSettings {
  id: string
  name: string
  /** 'openai' | 'zhipu' | 'siliconflow' | 'sd-webui' | 'custom' */
  kind: string
  baseUrl: string
  apiKey: string
  model: string
  sizeParam?: string
}

export interface GameDirEntry {
  path: string
  /** 展示名 */
  label: string
  source: GameDirCandidate['source']
  addedAt: string
}

export interface McalSettings {
  /** 全局工作根目录（启动器数据目录） */
  rootDir: string
  /** 默认游戏目录 */
  defaultGameDir: string
  /** 镜像设置 */
  mirror: {
    mojang: MirrorId
    forge: MirrorId
    fabric: MirrorId
    modrinth: MirrorId
    customMojang?: string
    customForge?: string
    customFabric?: string
    customModrinth?: string
  }
  download: {
    concurrency: number
    /** 全局限速（KB/s），0 为不限速 */
    speedLimitKB: number
    timeoutMs: number
    retries: number
    /** 下载并发线程数（单文件分片） */
    /** 是否在下载完成后校验哈希 */
    verifyHash: boolean
  }
  java: {
    /** 优先使用的 java 路径 */
    preferredJava?: string
    /** 自动扫描的额外目录 */
    scanDirs: string[]
    /** 自动下载缺失的 java */
    autoDownload: boolean
    /** 优先使用的 java 发行版 */
    preferredVendor?: string
  }
  launcher: {
    closeOnLaunch: boolean
    minimizeOnLaunch: boolean
    showGameWindowLog: boolean
    /** 语言 */
    locale: 'zh-CN' | 'en-US'
    /** 主题强调色 */
    accent?: string
    /** 启动动画等级 */
    motion: 'full' | 'reduced' | 'off'
  }
  agent: {
    /** 当前使用的 provider id */
    activeProviderId?: string
    /**
     * 访问权限级别（玩家能看懂的两种）：
     * - workspace：只允许在游戏目录、实例目录、工作区里读写（默认）
     * - full：可以访问任意路径，但敏感操作（删除、执行命令、改系统路径）仍需授权
     */
    accessMode: 'workspace' | 'full'
    /**
     * 细粒度权限模式（accessMode 的具体展开）：
     * readonly 只读 / auto-safe 工作区内自动放行 / auto-all 全部自动 / ask 每次都问
     */
    permissionMode: 'ask' | 'auto-safe' | 'auto-all' | 'readonly'
    /** 敏感操作（删除、shell、系统路径写入）是否强制弹授权，即使处于 full/auto-all */
    confirmSensitive: boolean
    /** 单次授权可以记住多久（毫秒），0 表示不记住 */
    grantRememberMs: number
    /** 会话内自动压缩上下文的阈值（token） */
    compactionThreshold: number
    /** 是否注入记忆 */
    memoryEnabled: boolean
    /** 是否注入知识库检索结果 */
    knowledgeEnabled: boolean
    /** 每次请求注入的最大记忆条数 */
    memoryRecallLimit: number
    /** 是否允许网络工具 */
    networkToolsEnabled: boolean
    /** 是否允许 shell 工具 */
    shellEnabled: boolean
    /** 系统提示附加内容 */
    systemPromptExtra?: string
    /** 使用的技能目录 */
    skillDirs: string[]
    maxTurnsPerRequest: number
    /** 流式响应 */
    stream: boolean
  }
  /** 额外的游戏目录（除 defaultGameDir 外，用户手动添加或自动检测确认的） */
  gameDirs: GameDirEntry[]
  update: {
    /** 启动时自动检查更新 */
    autoCheck: boolean
    /** 更新源：mirror 走国内镜像前缀，direct 直连 GitHub，custom 用自定义前缀 */
    source: 'mirror' | 'direct' | 'custom'
    /** 镜像 id（见 UPDATE_MIRRORS） */
    mirrorId: string
    /** 自定义前缀（source=custom 时使用） */
    customPrefix?: string
    /** 走系统代理（默认 false：国内代理挂掉时直连镜像反而更稳） */
    useSystemProxy: boolean
    /** GitHub 仓库 slug，如 owner/repo */
    repo: string
    /** 用户选择跳过的版本号 */
    skippedVersion?: string
    /** 上次检查时间（ISO） */
    lastCheckAt?: string
  }
  media: {
    activeProviderId?: string
    providers: ImageProviderSettings[]
  }
  providers: ProviderSettings[]
  /** 最近使用的账号 */
  activeAccountId?: string
  accounts: Account[]
  /** UI 状态 */
  ui?: {
    lastView?: string
    sidebarCollapsed?: boolean
  }
}

/* ------------------------------------------------------------------ *
 *  游戏目录检测
 * ------------------------------------------------------------------ */

/** 一个被发现的游戏目录候选 */
export interface GameDirCandidate {
  path: string
  /** 展示名，如「官方启动器」「HMCL」「PCL」 */
  label: string
  /** 来源：官方启动器 / 第三方启动器 / 常见位置 / 用户手动 */
  source: 'official' | 'thirdparty' | 'common' | 'manual'
  /** 是否已存在于设置中 */
  added: boolean
  /** 是否看起来像有效的 .minecraft（有 versions/ 或 launcher_profiles.json） */
  valid: boolean
  /** 已安装的版本 id（最多列 20 个） */
  versions: string[]
  /** 检测到的加载器种类 */
  loaders: LoaderType[]
  /** 版本目录数量 */
  versionCount: number
  /** 目录总大小（字节，可能为 0 表示未知） */
  sizeBytes: number
  /** 最近修改时间（ISO） */
  lastModified?: string
}

/* ------------------------------------------------------------------ *
 *  自动更新
 * ------------------------------------------------------------------ */

export interface UpdateMirror {
  id: string
  name: string
  prefix: string
  note?: string
}

export interface UpdateAsset {
  name: string
  size: number
  /** 直连地址 */
  url: string
  /** 经镜像改写的地址 */
  mirrorUrl: string
  /** 是否被识别为本平台的安装包 */
  recommended: boolean
}

export interface UpdateAttempt {
  source: string
  error: string
  statusCode?: number
}

export interface UpdateCheckResult {
  ok: boolean
  /** 命中的更新源名称 */
  source?: string
  sourceId?: string
  repo: string
  currentVersion: string
  latestVersion?: string
  tagName?: string
  hasUpdate?: boolean
  releaseUrl?: string
  notes?: string
  publishedAt?: string | null
  prerelease?: boolean
  assets?: UpdateAsset[]
  /** 失败原因：no-release（仓库还没发版）/ network / disabled */
  reason?: 'no-release' | 'network' | 'disabled' | 'bad-repo'
  message?: string
  attempts: UpdateAttempt[]
  checkedAt: string
}

export interface UpdateDownloadResult {
  ok: boolean
  file?: string
  bytes?: number
  /** 下载使用的地址 */
  url?: string
  error?: string
}

/* ------------------------------------------------------------------ *
 *  版本列表 / 安装结果
 * ------------------------------------------------------------------ */

export interface InstalledVersion {
  id: string
  gameVersion: string
  loaderType: LoaderType
  loaderVersion?: string
  /** 版本目录 */
  dir: string
  jarPath?: string
  jsonPath?: string
  installedAt: string
  /** 该版本被哪些实例引用 */
  usedByInstances: string[]
  sizeBytes?: number
  isIsolated?: boolean
  /** 版本 JSON 是否可解析 */
  valid: boolean
  error?: string
}

/** 版本页用的轻量列表项（本地已装 + 远程可下） */
export interface VersionListing {
  id: string
  type: string
  installed: boolean
  loaderType: LoaderType
  /** 已安装版本所在的游戏目录（可能不是默认目录：向导允许选目录，登记的游戏目录也会被扫描） */
  gameDir?: string
}

/* ------------------------------------------------------------------ *
 *  任务（长时后台任务）
 * ------------------------------------------------------------------ */

export interface TaskHandle {
  taskId: string
  kind: string
  label: string
}

export interface TaskState extends TaskHandle {
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  progress?: DownloadProgress
  logs?: string[]
  result?: unknown
  error?: string
  startedAt: string
  endedAt?: string
}

/* ------------------------------------------------------------------ *
 *  IPC 通道
 * ------------------------------------------------------------------ */

export const IPC = {
  // 设置
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsPickDir: 'settings:pick-dir',
  settingsPickFile: 'settings:pick-file',
  // 游戏目录
  gameDirDetect: 'game-dir:detect',
  gameDirProbe: 'game-dir:probe',
  gameDirAdd: 'game-dir:add',
  gameDirRemove: 'game-dir:remove',
  // 自动更新
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateOpenRelease: 'update:open-release',
  updateEvent: 'update:event',
  // 实例
  instanceList: 'instance:list',
  instanceCreate: 'instance:create',
  instanceUpdate: 'instance:update',
  instanceDelete: 'instance:delete',
  instanceOpenDir: 'instance:open-dir',
  // 版本
  versionList: 'version:list',
  versionManifest: 'version:manifest',
  versionInstall: 'version:install',
  versionInstallPlan: 'version:install-plan',
  versionDelete: 'version:delete',
  loaderVersions: 'loader:versions',
  loaderInstall: 'loader:install',
  // 启动（强制终止走 launchStop 的 force 参数）
  launch: 'launch',
  launchStop: 'launch:stop',
  launchRunning: 'launch:running',
  // 日志
  logList: 'log:list',
  logRead: 'log:read',
  logAnalyze: 'log:analyze',
  diagnose: 'diagnose:run',
  // 内容
  contentScan: 'content:scan',
  contentToggle: 'content:toggle',
  contentDelete: 'content:delete',
  contentImport: 'content:import',
  contentMeta: 'content:meta',
  contentValidate: 'content:validate',
  // 平台
  projectSearch: 'project:search',
  projectVersions: 'project:versions',
  projectDetail: 'project:detail',
  projectInstall: 'project:install',
  // Java
  javaList: 'java:list',
  javaScan: 'java:scan',
  javaCandidates: 'java:candidates',
  javaInstall: 'java:install',
  // 服务端
  serverList: 'server:list',
  serverCreate: 'server:create',
  serverUpdate: 'server:update',
  serverDelete: 'server:delete',
  serverCores: 'server:cores',
  serverInstall: 'server:install',
  serverStart: 'server:start',
  serverStop: 'server:stop',
  serverRunning: 'server:running',
  serverAcceptEula: 'server:eula',
  serverProps: 'server:props',
  serverPropsSet: 'server:props-set',
  // 整合包
  modpackInspect: 'modpack:inspect',
  modpackImport: 'modpack:import',
  modpackExport: 'modpack:export',
  // 账号
  accountList: 'account:list',
  accountCreateOffline: 'account:create-offline',
  accountRemove: 'account:remove',
  accountLoginMicrosoft: 'account:login-ms',
  accountSetActive: 'account:set-active',
  // Agent
  agentSend: 'agent:send',
  agentAbort: 'agent:abort',
  agentSessions: 'agent:sessions',
  agentLoadSession: 'agent:load-session',
  agentDeleteSession: 'agent:delete-session',
  agentNewSession: 'agent:new-session',
  agentPermissionRespond: 'agent:permission-respond',
  agentEvent: 'agent:event',
  agentProviders: 'agent:providers',
  agentSkills: 'agent:skills',
  agentSkillRead: 'agent:skill-read',
  agentTools: 'agent:tools',
  agentTestProvider: 'agent:test-provider',
  agentPresets: 'agent:presets',
  agentContextUsage: 'agent:context-usage',
  // 记忆
  memoryList: 'memory:list',
  memorySearch: 'memory:search',
  memoryWrite: 'memory:write',
  memoryUpdate: 'memory:update',
  memoryDelete: 'memory:delete',
  memoryStats: 'memory:stats',
  // 知识库
  knowledgeSearch: 'knowledge:search',
  knowledgeList: 'knowledge:list',
  knowledgeRead: 'knowledge:read',
  // 开发
  devTemplates: 'dev:templates',
  devScaffold: 'dev:scaffold',
  devBuild: 'dev:build',
  // 媒体
  mediaProviders: 'media:providers',
  mediaGenerate: 'media:generate',
  mediaReadImage: 'media:read-image',
  // 任务与系统
  taskList: 'task:list',
  taskCancel: 'task:cancel',
  taskEvent: 'task:event',
  systemInfo: 'system:info',
  systemOpenPath: 'system:open-path',
  systemRevealPath: 'system:reveal-path',
  shellOpenExternal: 'shell:open-external',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizedChanged: 'window:maximized-changed',
  appVersion: 'app:version'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 渲染进程可用的 API（preload 暴露） */
export interface McalApi {
  settings: {
    get(): Promise<McalSettings>
    update(patch: DeepPartial<McalSettings>): Promise<McalSettings>
    pickDir(opts?: { title?: string; defaultPath?: string }): Promise<string | null>
    pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }): Promise<string[] | null>
  }
  /** 游戏目录：自动检测 + 手动增删 */
  gameDir: {
    /** 扫描本机常见的 .minecraft 位置（顺带识别已装版本与加载器） */
    detect(): Promise<GameDirCandidate[]>
    /** 探测单个目录（用户手动选了目录后判断是否可用） */
    probe(path: string): Promise<GameDirCandidate>
    /** 加入「已知游戏目录」列表 */
    add(path: string, label?: string): Promise<GameDirEntry[]>
    remove(path: string): Promise<GameDirEntry[]>
  }
  /** 自动更新 */
  update: {
    /** 检查更新；manual=true 时忽略「跳过此版本」与自动检查开关 */
    check(opts?: { manual?: boolean }): Promise<UpdateCheckResult>
    /** 下载指定资源（走当前更新源） */
    download(asset: UpdateAsset): Promise<UpdateDownloadResult>
    /** 在浏览器打开 Release 页面 */
    openRelease(url: string): Promise<void>
    onEvent(
      cb: (
        event:
          | { type: 'progress'; received: number; total: number; label?: string }
          | { type: 'done'; file: string }
          /** 所有候选地址都失败：UI 靠它把「下载中」状态复位 */
          | { type: 'failed'; error: string }
          /** 检查结果（含启动时的静默检查）：有新版本时 UI 弹提示条，没有时只同步「上次检查」时间 */
          | { type: 'available'; result: UpdateCheckResult }
      ) => void
    ): () => void
  }
  instance: {
    list(): Promise<Instance[]>
    create(patch: Partial<Instance> & { name: string }): Promise<Instance>
    update(id: string, patch: Partial<Instance>): Promise<Instance>
    delete(id: string): Promise<void>
    openDir(id: string): Promise<void>
  }
  version: {
    list(): Promise<VersionListing[]>
    manifest(refresh?: boolean): Promise<VersionManifest>
    install(gameVersion: string): Promise<{ versionId: string }>
    /** 安装向导：原版 + 可选加载器 + 可选建实例，走同一个任务 */
    installPlan(plan: VersionInstallPlan): Promise<VersionInstallResult>
    remove(versionId: string): Promise<void>
    loaderVersions(opts: { loaderType: LoaderType; gameVersion?: string }): Promise<LoaderVersion[]>
    installLoader(req: LoaderInstallRequest): Promise<LoaderInstallResult>
  }
  launch(req: LaunchRequest): Promise<{ pid: number }>
  stop(instanceId: string, force?: boolean): Promise<void>
  running(): Promise<RunningGameInfo[]>
  log: {
    list(instanceId: string): Promise<{ name: string; path: string; size: number; mtimeMs: number }[]>
    read(instanceId: string, opts?: { tailLines?: number; file?: string }): Promise<string>
    analyze(opts: { instanceId?: string; file?: string; text?: string }): Promise<DiagnosticReport>
  }
  content: {
    scan(gameDir: string): Promise<ContentFile[]>
    toggle(path: string, enabled: boolean): Promise<void>
    remove(paths: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }>
    /** paths 为空时由主进程弹出文件选择框 */
    import(gameDir: string, kind: ContentKind, paths?: string[]): Promise<string[]>
    meta(path: string): Promise<ContentMeta | null>
    /** 一致性检查（缺失依赖 / 版本不匹配 / 互斥 / pack_format） */
    validate(opts: {
      gameDir: string
      gameVersion?: string
      loaderType?: LoaderType
      side?: 'client' | 'server'
    }): Promise<ContentIssue[]>
  }
  project: {
    search(opts: Parameters<LauncherServiceApi['searchProjects']>[0]): Promise<ProjectSearchResult[]>
    versions(opts: { platform: Platform; projectId: string; gameVersion?: string; loader?: LoaderType }): Promise<ProjectVersion[]>
    detail(opts: { platform: Platform; projectId: string }): Promise<ProjectDetail | null>
    install(opts: Parameters<LauncherServiceApi['installProject']>[0]): Promise<{ files: string[] }>
  }
  java: {
    list(refresh?: boolean): Promise<JavaRuntimeInfo[]>
    candidates(opts?: { majorVersion?: number }): Promise<JavaInstallCandidate[]>
    install(candidate: JavaInstallCandidate): Promise<JavaRuntimeInfo>
  }
  server: {
    list(): Promise<ServerInstance[]>
    create(patch: Partial<ServerInstance> & { name: string; gameVersion: string; coreType: ServerCoreType }): Promise<ServerInstance>
    update(id: string, patch: Partial<ServerInstance>): Promise<ServerInstance>
    delete(id: string): Promise<void>
    cores(opts: { coreType: ServerCoreType; gameVersion?: string }): Promise<ServerCoreDownload[]>
    install(opts: { coreType: ServerCoreType; gameVersion: string; dir: string; name: string; build?: string; acceptEula?: boolean }): Promise<ServerInstance>
    start(id: string): Promise<{ pid: number }>
    stop(id: string, force?: boolean): Promise<void>
    /** 运行中的服务端进程状态 */
    running(): Promise<
      { id: string; pid: number; state: string; startedAt: number; uptimeMs: number; exitCode?: number | null; players?: { online: number; max: number } }[]
    >
    acceptEula(id: string, accept: boolean): Promise<void>
    properties(id: string): Promise<Record<string, string>>
    setProperties(id: string, props: Record<string, string>): Promise<void>
  }
  modpack: {
    inspect(file: string): Promise<ModpackManifest>
    import(opts: { file?: string; dir?: string; targetDir: string; name?: string }): Promise<Instance>
    export(opts: { instanceId: string; outFile: string; includeSaves?: boolean; includeConfig?: boolean }): Promise<void>
  }
  account: {
    list(): Promise<Account[]>
    createOffline(name: string): Promise<Account>
    remove(id: string): Promise<void>
    setActive(id: string): Promise<void>
    loginMicrosoft(): Promise<Account>
  }
  agent: {
    newSession(opts?: { title?: string }): Promise<string>
    sessions(): Promise<{ id: string; title: string; updatedAt: string; messageCount: number }[]>
    loadSession(id: string): Promise<{ id: string; title: string; messages: ChatMessage[] }>
    deleteSession(id: string): Promise<void>
    send(opts: { sessionId: string; text: string; attachments?: ChatAttachment[]; contextHint?: string }): Promise<void>
    abort(sessionId: string): Promise<void>
    respondPermission(res: PermissionResponse): Promise<void>
    onEvent(cb: (e: { sessionId: string; event: AgentEvent }) => void): () => void
    providers(): Promise<ProviderSettings[]>
    /** 内置服务商预设，用于一键配置 */
    presets(): Promise<unknown[]>
    testProvider(id: string): Promise<{ ok: boolean; message: string; latencyMs?: number }>
    contextUsage(sessionId: string): Promise<{ tokens: number; window: number }>
    skills(): Promise<SkillMeta[]>
    readSkill(name: string): Promise<SkillContent | null>
    tools(): Promise<ToolDefinition[]>
  }
  memory: {
    list(opts?: { limit?: number; offset?: number }): Promise<MemoryRecord[]>
    search(query: string, limit?: number): Promise<{ record: MemoryRecord; score: number }[]>
    write(record: Partial<MemoryRecord> & { problem: string; solution: string }): Promise<MemoryRecord>
    update(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord>
    remove(id: string): Promise<void>
    stats(): Promise<{ total: number; verified: number; topSymptoms: string[] }>
  }
  knowledge: {
    search(query: string, limit?: number): Promise<KnowledgeHit[]>
    list(category?: string): Promise<{ id: string; title: string; category: string; tags: string[]; summary: string }[]>
    read(id: string): Promise<KnowledgeArticle | null>
  }
  dev: {
    templates(): Promise<DevTemplate[]>
    scaffold(opts: { templateId: string; targetDir: string; options: Record<string, string> }): Promise<{ files: string[]; root: string }>
    build(opts: { dir: string; task?: string }): Promise<{ ok: boolean; output: string; code: number | null }>
  }
  media: {
    providers(): Promise<{ id: string; name: string; configured: boolean; models: string[] }[]>
    generate(opts: Parameters<MediaServiceApi['generateImage']>[0]): Promise<{ files: string[]; provider: string }>
    /** 读取本地图片为 data URL —— 渲染进程受 CSP 限制，不能直接加载 file:// */
    readImage(path: string): Promise<{ dataUrl: string; bytes: number } | null>
  }
  task: {
    list(): Promise<TaskState[]>
    cancel(taskId: string): Promise<void>
    onEvent(cb: (t: TaskState) => void): () => void
  }
  system: {
    info(): Promise<SystemInfo>
    openPath(path: string): Promise<void>
    revealPath(path: string): Promise<void>
    openExternal(url: string): Promise<void>
    version(): Promise<{ app: string; electron: string; node: string; chrome: string }>
  }
  window: {
    /** 运行平台：Windows/Linux 用自绘窗口按钮，macOS 交给系统红绿灯 */
    platform: NodeJS.Platform
    minimize(): void
    /** 在最大化与还原之间切换 */
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    /** 最大化状态变化（含拖拽到屏幕边缘、双击标题栏等系统手势）；返回取消订阅函数 */
    onMaximizedChange(cb: (maximized: boolean) => void): () => void
  }
}

export interface SystemInfo {
  platform: NodeJS.Platform
  arch: string
  osVersion: string
  cpuModel: string
  cpuCores: number
  totalMemoryMB: number
  freeMemoryMB: number
  /** 推荐的 JVM 最大堆 */
  recommendedMaxHeapMB: number
  gpus?: { model?: string; vendorId?: string; deviceId?: string }[]
  rootDir: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}
