/**
 * 服务容器：把核心引擎装配成一个可用实例。
 *
 * 主进程只依赖这个容器，不直接 new 各引擎；这样测试时可以替换任意组件，
 * 也避免把 Electron API 泄漏进核心引擎。
 */

import { join } from 'node:path'
import type { AgentEvent, AgentServices, McalSettings, PermissionRequest, PermissionResponse } from '@shared/types'
import { HttpClient } from '@core/net/http'
import { DownloadManager } from '@core/net/downloader'
import { MirrorResolver } from '@core/net/mirror'
import { logger } from '@core/util/logger'
import { VersionManifestService } from '@core/mojang/manifest'
import { VersionRepository } from '@core/mojang/version'
import { AssetService } from '@core/mojang/assets'
import { VersionInstaller } from '@core/mojang/install'
import { JavaScanner } from '@core/java/detect'
import { JavaInstaller } from '@core/java/install'
import { GameLauncher } from '@core/launch/launcher'
import { LoaderManager } from '@core/loaders'
import { ContentManager } from '@core/content/manager'
import { ModrinthClient } from '@core/platform/modrinth'
import { PlatformService } from '@core/platform'
import { DiagnosticEngine } from '@core/diagnose/engine'
import { ModpackInspector } from '@core/modpack/inspect'
import { ModpackInstaller } from '@core/modpack/install'
import { ModpackExporter } from '@core/modpack/export'
import { ServerCoreRegistry } from '@core/server/cores'
import { ServerManager } from '@core/server/manager'
import { TemplateRegistry } from '@core/dev/templates'
import { Scaffolder } from '@core/dev/scaffold'
import { ProjectBuilder } from '@core/dev/builder'
import { MediaService } from '@core/media/service'
import { KnowledgeBase } from '@knowledge/index'
import { MemoryStore, memoryFilePath } from '@agent/memory/store'
import { SkillRegistry } from '@agent/skills/registry'
import { SessionStore, sessionDir } from '@agent/session'
import { ToolRegistry } from '@agent/tools/registry'
import { buildToolRegistry } from '@agent/tools'
import { AgentHarness } from '@agent/harness'
import { createProvider } from '@agent/provider'
import { SettingsStore } from './store/config-store'
import { defaultImageProviders, defaultProviders } from './store/defaults'
import { InstanceStore, ServerLlStore } from './store/instance-store'
import { TaskManager } from './tasks'

export interface ContainerOptions {
  /** 启动器数据目录（Electron userData） */
  rootDir: string
  /** 静态资源目录（knowledge/templates/skills） */
  resourcesRoot: string
  appVersion: string
  /** 用户自建资源目录（可写） */
  userResourcesRoot?: string
}

export class ServiceContainer {
  readonly rootDir: string
  readonly resourcesRoot: string
  readonly userResourcesRoot: string
  readonly appVersion: string

  readonly settings: SettingsStore
  readonly instances: InstanceStore
  readonly servers: ServerLlStore
  readonly tasks: TaskManager

  readonly client: HttpClient
  readonly mirror: MirrorResolver
  readonly downloadManager: DownloadManager

  readonly manifest: VersionManifestService
  readonly repository: VersionRepository
  readonly assets: AssetService
  readonly installer: VersionInstaller

  readonly javaScanner: JavaScanner
  readonly javaInstaller: JavaInstaller
  readonly launcher: GameLauncher
  readonly loaders: LoaderManager

  readonly content: ContentManager
  readonly modrinth: ModrinthClient
  readonly platform: PlatformService

  readonly diagnostics: DiagnosticEngine
  readonly modpackInspector: ModpackInspector
  readonly modpackInstaller: ModpackInstaller
  readonly modpackExporter: ModpackExporter

  readonly serverCores: ServerCoreRegistry
  readonly serverManager: ServerManager

  readonly templates: TemplateRegistry
  readonly scaffolder: Scaffolder
  readonly builder: ProjectBuilder
  readonly media: MediaService

  readonly knowledge: KnowledgeBase
  readonly memory: MemoryStore
  readonly skills: SkillRegistry
  readonly sessions: SessionStore
  readonly tools: ToolRegistry
  readonly harness: AgentHarness

  private ready = false

  constructor(options: ContainerOptions) {
    this.rootDir = options.rootDir
    this.resourcesRoot = options.resourcesRoot
    this.userResourcesRoot = options.userResourcesRoot ?? join(options.rootDir, 'user-resources')
    this.appVersion = options.appVersion

    this.settings = new SettingsStore({ rootDir: options.rootDir })
    this.instances = new InstanceStore({ rootDir: options.rootDir })
    this.servers = new ServerLlStore({ rootDir: options.rootDir })
    this.tasks = new TaskManager()

    this.client = new HttpClient()
    this.mirror = new MirrorResolver(this.settings.get().mirror)
    this.downloadManager = new DownloadManager({
      client: this.client,
      mirror: this.mirror,
      concurrency: this.settings.get().download.concurrency,
      verifyHash: this.settings.get().download.verifyHash
    })

    this.manifest = new VersionManifestService({
      client: this.client,
      mirror: this.mirror,
      cacheDir: join(options.rootDir, 'cache')
    })
    this.repository = new VersionRepository({ manifest: this.manifest, client: this.client, mirror: this.mirror })
    this.assets = new AssetService({ client: this.client, mirror: this.mirror, downloadManager: this.downloadManager })
    this.installer = new VersionInstaller({
      client: this.client,
      mirror: this.mirror,
      downloadManager: this.downloadManager,
      repository: this.repository,
      manifest: this.manifest,
      assets: this.assets
    })

    this.javaScanner = new JavaScanner({
      cachePath: join(options.rootDir, 'cache', 'java.json'),
      scanDirs: this.settings.get().java.scanDirs,
      preferredJava: this.settings.get().java.preferredJava
    })
    this.javaScanner.setManagedRoot(join(options.rootDir, 'java'))
    this.javaInstaller = new JavaInstaller({
      client: this.client,
      mirror: this.mirror,
      downloadManager: this.downloadManager,
      installerRoot: join(options.rootDir, 'java')
    })

    this.launcher = new GameLauncher({
      client: this.client,
      mirror: this.mirror,
      downloadManager: this.downloadManager,
      repository: this.repository,
      assets: this.assets,
      javaScanner: this.javaScanner,
      settings: {
        java: this.settings.get().java,
        launcher: this.settings.get().launcher
      }
    })

    this.loaders = new LoaderManager({
      client: this.client,
      mirror: this.mirror,
      downloadManager: this.downloadManager,
      repository: this.repository,
      java: {
        scan: () => this.javaScanner.scan(),
        probe: (path: string) => this.javaScanner.probe(path)
      }
    })

    this.content = new ContentManager({ downloadManager: this.downloadManager })
    this.modrinth = new ModrinthClient({
      client: this.client,
      mirror: this.mirror,
      userAgent: `MCAL/${options.appVersion} (Minecraft Agent Launcher)`
    })
    this.platform = new PlatformService({
      client: this.client,
      mirror: this.mirror,
      downloadManager: this.downloadManager,
      modrinth: this.modrinth
    })

    this.diagnostics = new DiagnosticEngine()
    this.modpackInspector = new ModpackInspector({ client: this.client })
    this.modpackInstaller = new ModpackInstaller({
      downloadManager: this.downloadManager,
      inspector: this.modpackInspector
    })
    this.modpackExporter = new ModpackExporter()

    this.serverCores = new ServerCoreRegistry({
      client: this.client,
      mirror: this.mirror,
      downloadManager: this.downloadManager,
      manifest: this.manifest
    })
    this.serverManager = new ServerManager({
      client: this.client,
      mirror: this.mirror,
      downloadManager: this.downloadManager,
      cores: this.serverCores,
      javaScanner: this.javaScanner,
      store: this.servers,
      logRoot: join(options.rootDir, 'logs', 'servers')
    })

    this.templates = new TemplateRegistry({ templatesRoot: join(this.resourcesRoot, 'templates') })
    this.scaffolder = new Scaffolder({ registry: this.templates })
    this.builder = new ProjectBuilder()
    this.media = new MediaService({
      client: this.client,
      settings: {
        providers: this.settings.get().media.providers,
        activeProviderId: this.settings.get().media.activeProviderId
      },
      outputRoot: join(options.rootDir, 'generated')
    })

    this.knowledge = new KnowledgeBase({
      roots: [join(this.resourcesRoot, 'knowledge')],
      userRoots: [join(this.userResourcesRoot, 'knowledge')]
    })
    this.memory = new MemoryStore({ file: memoryFilePath(options.rootDir) })
    this.skills = new SkillRegistry({
      roots: [join(this.resourcesRoot, 'skills'), join(this.userResourcesRoot, 'skills'), ...this.settings.get().agent.skillDirs]
    })
    this.sessions = new SessionStore({ dir: sessionDir(options.rootDir) })

    // 工具注册表需要 AgentServices，而 AgentServices 又需要容器 —— 用惰性包装打破循环
    const services = this.createAgentServices()
    this.tools = buildToolRegistry({
      services,
      skills: this.skills,
      todos: {
        read: () => [],
        write: () => undefined
      },
      enableShell: this.settings.get().agent.shellEnabled
    })

    this.harness = new AgentHarness({
      registry: this.tools,
      sessions: this.sessions,
      memory: this.memory,
      skills: this.skills,
      knowledge: this.knowledge,
      services,
      getSettings: () => this.settings.get(),
      getProvider: () => {
        const provider = this.settings.getActiveProvider()
        if (!provider || !provider.apiKey) return null
        try {
          return createProvider(provider)
        } catch (err) {
          logger.error('agent', `创建 provider 失败：${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      },
      getPromptContext: () => this.buildPromptContext(),
      emit: (sessionId, event) => this.emitAgentEvent(sessionId, event),
      requestPermission: (sessionId, request) => this.requestAgentPermission(sessionId, request),
      getRoots: () => this.agentRoots(),
      appVersion: options.appVersion
    })
  }

  /** 由主进程覆盖：把 Agent 事件转发到渲染进程 */
  emitAgentEvent: (sessionId: string, event: AgentEvent) => void = () => undefined

  /** 由主进程覆盖：向渲染进程申请授权 */
  requestAgentPermission: (
    sessionId: string,
    request: Omit<PermissionRequest, 'id'>
  ) => Promise<PermissionResponse> = async () => ({ id: '', decision: 'deny', scope: 'once' })

  /** 初始化：加载配置、迁移默认值、准备目录、启动 Agent 运行时 */
  async init(): Promise<void> {
    if (this.ready) return
    const settings = await this.settings.load()
    // 首次运行补默认 provider（用户不需要从零填写）
    const patch: Partial<McalSettings> = {}
    if (settings.providers.length === 0) patch.providers = defaultProviders()
    if (settings.media.providers.length === 0) patch.media = { providers: defaultImageProviders() }
    if (Object.keys(patch).length > 0) {
      this.settings.update(patch)
      await this.settings.flush()
    }
    this.applySettings(this.settings.get())
    await this.instances.load()
    await this.servers.load()
    this.ready = true
    logger.info('container', `服务容器就绪（数据目录 ${this.rootDir}）`)
  }

  /** 设置变更后同步到各引擎 */
  applySettings(settings: McalSettings): void {
    this.mirror.update(settings.mirror)
    this.client.configure({ retries: settings.download.retries, timeoutMs: settings.download.timeoutMs })
    this.downloadManager.configure({
      concurrency: settings.download.concurrency,
      verifyHash: settings.download.verifyHash,
      speedLimitKB: settings.download.speedLimitKB
    })
    this.javaScanner.setManagedRoot(join(this.rootDir, 'java'))
    this.skills.setRoots([
      join(this.resourcesRoot, 'skills'),
      join(this.userResourcesRoot, 'skills'),
      ...settings.agent.skillDirs
    ])
  }

  /** Agent 可写目录：数据目录 + 用户资源目录 + 所有实例/服务端目录 + 用户登记的游戏目录 */
  agentRoots(): string[] {
    const roots = [this.rootDir, this.userResourcesRoot]
    for (const instance of this.instancesMemo) roots.push(instance.gameDir)
    for (const server of this.serversMemo) roots.push(server.dir)
    // 用户手动添加或自动检测到的游戏目录，同样是「工作区」的一部分
    for (const dir of this.settings.get().gameDirs) roots.push(dir.path)
    return [...new Set(roots)]
  }

  /** 实例与服务端列表的内存缓存（由 launcher-api 在变更时刷新） */
  instancesMemo: { id: string; name: string; gameDir: string; versionId: string; loaderType: string }[] = []
  serversMemo: { id: string; name: string; dir: string }[] = []

  async refreshMemo(): Promise<void> {
    this.instancesMemo = (await this.instances.list()).map((instance) => ({
      id: instance.id,
      name: instance.name,
      gameDir: instance.gameDir,
      versionId: instance.versionId,
      loaderType: instance.loaderType
    }))
    this.serversMemo = (await this.servers.list()).map((server) => ({
      id: server.id,
      name: server.name,
      dir: server.dir
    }))
  }

  private async buildPromptContext() {
    const settings = this.settings.get()
    const { platform, arch, totalmem } = await import('node:os')
    const instances = await this.instances.list()
    const servers = await this.servers.list()
    const running = this.launcher.getRunning()
    let java: Awaited<ReturnType<JavaScanner['scan']>> = []
    try {
      java = await this.javaScanner.scan()
    } catch {
      java = []
    }
    return {
      instances,
      servers,
      running,
      java,
      platform: platform(),
      arch: arch(),
      totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
      appVersion: this.appVersion,
      settingsExtra: settings.launcher.locale,
      roots: this.agentRoots()
    }
  }

  /** 组装给 Agent 工具用的服务接口 */
  private createAgentServices(): AgentServices {
    // 延迟到首次调用时才 import，避免循环依赖
    const requireApi = (): AgentServices['launcher'] => {
      if (!this.launcherApiLazy) {
        throw new Error('LauncherServiceApi 尚未注入（主进程启动顺序问题）')
      }
      return this.launcherApiLazy
    }
    let self = this
    return {
      get launcher() {
        return requireApi()
      },
      knowledge: {
        search: (query, opts) => self.knowledge.search(query, opts),
        read: (id) => self.knowledge.read(id),
        list: (category) => self.knowledge.list(category)
      },
      memory: {
        search: async (query, opts) => self.memory.search(query, opts),
        write: async (record) => self.memory.write(record),
        update: async (id, patch) => self.memory.update(id, patch),
        list: async (opts) => self.memory.list(opts),
        remove: async (id) => {
          self.memory.remove(id)
        },
        stats: async () => self.memory.stats()
      },
      dev: {
        listTemplates: async () => {
          const list = await self.templates.list()
          const out = []
          for (const template of list) {
            const files = await self.templates.readFiles(template.id).catch(() => [])
            out.push({
              id: template.id,
              name: template.name,
              kind: template.kind,
              loader: template.loader,
              description: template.description,
              variables: template.variables.map((variable) => ({
                key: variable.key,
                label: variable.label,
                default: variable.default,
                required: variable.required
              })),
              files
            })
          }
          return out
        },
        scaffold: async (templateId, targetDir, variables) => {
          const result = await self.scaffolder.scaffold({ templateId, targetDir, variables, force: true })
          return { files: result.files, root: result.root }
        },
        buildProject: async (dir, task) => {
          const result = await self.builder.build({ dir, task })
          return { ok: result.ok, output: result.output, code: result.code }
        }
      },
      media: {
        generateImage: (opts) => self.media.generate(opts),
        listProviders: async () => self.media.listProviders()
      },
      logger: (message, level) => {
        if (level === 'error') logger.error('agent', message)
        else if (level === 'warn') logger.warn('agent', message)
        else logger.info('agent', message)
      }
    } as AgentServices
  }

  /** 由主进程注入 LauncherServiceApi 实现（打破 harness ↔ api 的循环依赖） */
  launcherApiLazy: AgentServices['launcher'] | null = null

  setLauncherApi(api: AgentServices['launcher']): void {
    this.launcherApiLazy = api
  }

  async shutdown(): Promise<void> {
    await this.harness.shutdown()
    await this.settings.flush()
    this.downloadManager.cancelAll()
    await this.launcher.stopAll().catch(() => undefined)
    await this.serverManager.stopAll().catch(() => undefined)
    logger.info('container', '服务容器已关闭')
  }
}
