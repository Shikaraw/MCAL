/**
 * 加载器安装统一入口。
 *
 * 设计要点：
 *  - 各加载器的实现互相独立，这里只做「依赖注入 + 分派 + 类型契约」；
 *  - listVersions 的 gameVersion 语义：fabric/quilt/optifine 必须给（meta 接口按版本查询），
 *    forge/neoforge 可省略（forge 省略时用 promotions_slim.json 的推荐版本，neoforge 返回全部）；
 *  - install(req) 里的 req.versionId 是「安装目标」：
 *      · fabric/quilt/forge/neoforge → 基础原版版本（若传加载器版本 id，会自动取其父版本）
 *      · optifine → 要挂载的目标版本（原版或 Forge/NeoForge 实例版本）
 *  - 实例创建由上层负责，本模块只在结果里返回新的 versionId。
 */

import type {
  DownloadProgress,
  JavaRuntimeInfo,
  LoaderInstallRequest,
  LoaderInstallResult,
  LoaderType,
  LoaderVersion
} from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import type { DownloadManager } from '@core/net/downloader'
import type { VersionRepository } from '@core/mojang/version'
import type { JavaProvider } from './installer-jar'
import { FabricLoader } from './fabric'
import { QuiltLoader } from './quilt'
import { ForgeInstaller } from './forge'
import { NeoForgeInstaller } from './neoforge'
import { OptiFineInstaller, optifineToLoaderVersion } from './optifine'
import { parseLoaderVersionId, type ParsedLoaderVersionId } from './version-id'

export interface LoaderInstallDeps {
  gameDir: string
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  repository: VersionRepository
  java: { scan(): Promise<JavaRuntimeInfo[]>; probe(path: string): Promise<JavaRuntimeInfo | null> }
  /** 已选定的 java 路径（上层可能已解析） */
  javaPath?: string
  onProgress?: (p: LoaderInstallProgress) => void
  signal?: AbortSignal
}

export interface LoaderInstallProgress {
  phase: string
  message: string
  ratio: number
  download?: DownloadProgress
}

export interface LoaderCapability {
  type: LoaderType
  name: string
  note: string
  needsJava: boolean
}

/** 统一入口：按 loaderType 分派 */
export class LoaderManager {
  private readonly deps: Omit<LoaderInstallDeps, 'gameDir'>
  private fabricLoader?: FabricLoader
  private quiltLoader?: QuiltLoader
  private forgeInstaller?: ForgeInstaller
  private neoForgeInstaller?: NeoForgeInstaller
  private optiFineInstaller?: OptiFineInstaller

  constructor(deps: Omit<LoaderInstallDeps, 'gameDir'>) {
    this.deps = deps
  }

  /** 当前依赖（供上层组合，例如把 javaPath 换成实例级配置） */
  withDeps(patch: Partial<Omit<LoaderInstallDeps, 'gameDir'>>): LoaderManager {
    return new LoaderManager({ ...this.deps, ...patch })
  }

  getFabric(): FabricLoader {
    this.fabricLoader ??= new FabricLoader({
      client: this.deps.client,
      mirror: this.deps.mirror,
      repository: this.deps.repository
    })
    return this.fabricLoader
  }

  getQuilt(): QuiltLoader {
    this.quiltLoader ??= new QuiltLoader({
      client: this.deps.client,
      mirror: this.deps.mirror,
      repository: this.deps.repository
    })
    return this.quiltLoader
  }

  getForge(): ForgeInstaller {
    this.forgeInstaller ??= new ForgeInstaller({
      client: this.deps.client,
      mirror: this.deps.mirror,
      downloadManager: this.deps.downloadManager,
      repository: this.deps.repository,
      javaScanner: this.javaProvider()
    })
    return this.forgeInstaller
  }

  getNeoForge(): NeoForgeInstaller {
    this.neoForgeInstaller ??= new NeoForgeInstaller({
      client: this.deps.client,
      mirror: this.deps.mirror,
      downloadManager: this.deps.downloadManager,
      repository: this.deps.repository,
      javaScanner: this.javaProvider()
    })
    return this.neoForgeInstaller
  }

  getOptiFine(): OptiFineInstaller {
    this.optiFineInstaller ??= new OptiFineInstaller({
      client: this.deps.client,
      mirror: this.deps.mirror,
      downloadManager: this.deps.downloadManager,
      repository: this.deps.repository,
      javaScanner: this.javaProvider()
    })
    return this.optiFineInstaller
  }

  private javaProvider(): JavaProvider {
    return { scan: () => this.deps.java.scan(), probe: (path: string) => this.deps.java.probe(path) }
  }

  /* ---------------- 版本列表 ---------------- */

  async listVersions(
    loaderType: LoaderType,
    gameVersion?: string,
    opts: { refresh?: boolean } = {}
  ): Promise<LoaderVersion[]> {
    switch (loaderType) {
      case 'fabric': {
        if (!gameVersion) throw new Error('查询 Fabric 版本需要 gameVersion')
        return this.getFabric().listVersions(gameVersion, opts)
      }
      case 'quilt': {
        if (!gameVersion) throw new Error('查询 Quilt 版本需要 gameVersion')
        return this.getQuilt().listVersions(gameVersion, opts)
      }
      case 'forge':
        return this.getForge().listVersions(gameVersion, opts)
      case 'neoforge':
        return this.getNeoForge().listVersions(gameVersion, opts)
      case 'optifine': {
        if (!gameVersion) throw new Error('查询 OptiFine 版本需要 gameVersion')
        const versions = await this.getOptiFine().listVersions(gameVersion, { refresh: opts.refresh })
        return versions.map(optifineToLoaderVersion)
      }
      case 'vanilla':
        return []
      default:
        return []
    }
  }

  /* ---------------- 安装 ---------------- */

  async install(req: LoaderInstallRequest): Promise<LoaderInstallResult> {
    const deps: LoaderInstallDeps = { ...this.deps, gameDir: req.gameDir }
    switch (req.loaderType) {
      case 'fabric':
        return this.getFabric().install(req, deps)
      case 'quilt':
        return this.getQuilt().install(req, deps)
      case 'forge':
        return this.getForge().install(req, deps)
      case 'neoforge':
        return this.getNeoForge().install(req, deps)
      case 'optifine':
        return this.getOptiFine().install(req, deps)
      case 'vanilla':
        throw new Error('vanilla 无需安装加载器；请使用 VersionInstaller 安装原版')
      case 'liteloader':
        throw new Error('LiteLoader 安装尚未实现（LiteLoader 已停止维护，建议改用 Fabric/Forge + 对应功能 mod）')
      default:
        throw new Error(`不支持的加载器类型：${req.loaderType}`)
    }
  }

  /** 支持的加载器与特性说明（供 UI 与 Agent 查询） */
  capabilities(): LoaderCapability[] {
    return [
      {
        type: 'vanilla',
        name: '原版',
        note: '不需要加载器；由 VersionInstaller 安装，加载器均要求先装好原版',
        needsJava: false
      },
      {
        type: 'fabric',
        name: 'Fabric',
        note: 'meta.fabricmc.net 的 profile json 直写（版本 id: fabric-loader-<loader>-<mc>）；轻量、更新快，仅支持 1.14+ 与快照',
        needsJava: false
      },
      {
        type: 'quilt',
        name: 'Quilt',
        note: 'quiltmc.org v3 meta（版本 id: quilt-loader-<loader>-<mc>）；与 Fabric 同构，库来自 profile json',
        needsJava: false
      },
      {
        type: 'forge',
        name: 'Forge',
        note: '优先运行官方 installer（下载库并执行 processors），失败回退手工安装（版本 id: <mc>-forge-<ver>）',
        needsJava: true
      },
      {
        type: 'neoforge',
        name: 'NeoForge',
        note: 'maven.neoforged.net 版本列表（版本 id: neoforge-<ver>）；installer 必须执行 processors，手工回退仅作兜底',
        needsJava: true
      },
      {
        type: 'optifine',
        name: 'OptiFine',
        note: '原版：optifine.Patcher 打补丁 + launchwrapper 版本 json；Forge/NeoForge：作为 mod 放入 mods/；建议光影改用 Iris/Oculus',
        needsJava: true
      },
      {
        type: 'liteloader',
        name: 'LiteLoader',
        note: '已停止维护，本启动器未实现安装',
        needsJava: true
      },
      {
        type: 'custom',
        name: '自定义',
        note: '不提供安装，仅支持直接导入的版本 json',
        needsJava: false
      }
    ]
  }

  /** 从已安装版本反查加载器信息 */
  detectFromVersionId(versionId: string): ParsedLoaderVersionId {
    return parseLoaderVersionId(versionId)
  }
}

export { parseLoaderVersionId, baseGameVersionOf, neoforgeGameVersionFor } from './version-id'
export type { ParsedLoaderVersionId } from './version-id'
