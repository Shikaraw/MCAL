/** 各下载源的地址解析：官方 / BMCLAPI / 自定义镜像。 */

import type { MirrorConfig, MirrorId, McalSettings } from '@shared/types'
import { logger } from '@core/util/logger'

const log = logger.scoped('mirror')

export const OFFICIAL_ENDPOINTS = {
  /** 版本清单（v2 带 sha1 与 complianceLevel） */
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  versionManifestV1: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  resources: 'https://resources.download.minecraft.net',
  libraries: 'https://libraries.minecraft.net',
  launcherMeta: 'https://launchermeta.mojang.com',
  pistonData: 'https://piston-data.mojang.com',
  /** Mojang 官方 Java 运行时清单 */
  javaRuntimeAll: 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
  forgeMaven: 'https://maven.minecraftforge.net',
  neoforgeMaven: 'https://maven.neoforged.net/releases',
  fabricMeta: 'https://meta.fabricmc.net',
  quiltMeta: 'https://meta.quiltmc.org',
  optifine: 'https://optifine.net',
  modrinthApi: 'https://api.modrinth.com/v2',
  paperApi: 'https://api.papermc.io/v2',
  purpurApi: 'https://api.purpurmc.org/v2',
  spigotApi: 'https://hub.spigotmc.org/versions',
  adoptiumApi: 'https://api.adoptium.net/v3',
  zuluApi: 'https://api.azul.com/metadata/v1/zulu/packages',
  curseforgeApi: 'https://api.curseforge.com/v1',
  forgePromotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
} as const

export const BMCLAPI_ENDPOINTS = {
  root: 'https://bmclapi2.bangbang93.com',
  versionManifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  library: 'https://bmclapi2.bangbang93.com/maven',
  assets: 'https://bmclapi2.bangbang93.com/assets',
  forgeMaven: 'https://bmclapi2.bangbang93.com/maven',
  forgePromotions: 'https://bmclapi2.bangbang93.com/forge/promotions_slim.json',
  fabricMeta: 'https://bmclapi2.bangbang93.com/fabric-meta',
  quiltMeta: 'https://bmclapi2.bangbang93.com/quilt-meta',
  optifine: 'https://bmclapi2.bangbang93.com/optifine',
  modrinth: 'https://bmclapi2.bangbang93.com/modrinth/v2',
  /** NeoForge 的 maven 也走同一个前缀 */
  neoforgeMaven: 'https://bmclapi2.bangbang93.com/maven'
} as const

export type MirrorScope = 'mojang' | 'forge' | 'fabric' | 'modrinth'

export interface MirrorResolution {
  mirror: MirrorId
  baseUrl: string
}

/** 镜像解析器：把「官方 URL」映射到当前设置对应的镜像 URL。 */
export class MirrorResolver {
  private settings: McalSettings['mirror']

  constructor(settings: McalSettings['mirror']) {
    this.settings = settings
  }

  update(settings: McalSettings['mirror']): void {
    this.settings = settings
  }

  get(scope: MirrorScope): MirrorId {
    switch (scope) {
      case 'mojang':
        return this.settings.mojang
      case 'forge':
        return this.settings.forge
      case 'fabric':
        return this.settings.fabric
      case 'modrinth':
        return this.settings.modrinth
      default:
        return 'official'
    }
  }

  customBase(scope: MirrorScope): string | undefined {
    switch (scope) {
      case 'mojang':
        return this.settings.customMojang
      case 'forge':
        return this.settings.customForge
      case 'fabric':
        return this.settings.customFabric
      case 'modrinth':
        return this.settings.customModrinth
      default:
        return undefined
    }
  }

  /**
   * 把官方 URL 转换为实际请求 URL。若当前是官方源则原样返回。
   * 支持：版本清单、版本 json、资源对象、库、fabric/quilt meta、optifine、modrinth。
   */
  resolve(url: string, scope: MirrorScope = 'mojang'): string {
    const mirror = this.get(scope)
    if (mirror === 'official') return url
    const custom = this.customBase(scope)
    if (mirror === 'custom') {
      return custom ? this.applyCustom(custom, url) : url
    }
    // bmclapi
    if (scope === 'modrinth') {
      if (url.startsWith(OFFICIAL_ENDPOINTS.modrinthApi)) {
        return url.replace(OFFICIAL_ENDPOINTS.modrinthApi, BMCLAPI_ENDPOINTS.modrinth)
      }
      return url
    }
    if (scope === 'fabric') {
      if (url.startsWith(OFFICIAL_ENDPOINTS.fabricMeta)) {
        return url.replace(OFFICIAL_ENDPOINTS.fabricMeta, BMCLAPI_ENDPOINTS.fabricMeta)
      }
      if (url.startsWith(OFFICIAL_ENDPOINTS.quiltMeta)) {
        return url.replace(OFFICIAL_ENDPOINTS.quiltMeta, BMCLAPI_ENDPOINTS.quiltMeta)
      }
      return url
    }
    if (scope === 'forge') {
      if (url.startsWith(OFFICIAL_ENDPOINTS.forgeMaven)) {
        return url.replace(OFFICIAL_ENDPOINTS.forgeMaven, BMCLAPI_ENDPOINTS.forgeMaven)
      }
      if (url.startsWith(OFFICIAL_ENDPOINTS.neoforgeMaven)) {
        return url.replace(OFFICIAL_ENDPOINTS.neoforgeMaven, BMCLAPI_ENDPOINTS.neoforgeMaven)
      }
      return url
    }
    // mojang 全域
    return this.mapMojangUrlToBmclapi(url)
  }

  private applyCustom(customBase: string, url: string): string {
    const base = customBase.replace(/\/+$/, '')
    const mappings: [string, string][] = [
      [OFFICIAL_ENDPOINTS.versionManifest, `${base}/mc/game/version_manifest_v2.json`],
      [OFFICIAL_ENDPOINTS.resources, `${base}/assets`],
      [OFFICIAL_ENDPOINTS.libraries, `${base}/maven`],
      [OFFICIAL_ENDPOINTS.launcherMeta, base],
      [OFFICIAL_ENDPOINTS.pistonData, base],
      [OFFICIAL_ENDPOINTS.fabricMeta, base],
      [OFFICIAL_ENDPOINTS.quiltMeta, base],
      [OFFICIAL_ENDPOINTS.forgeMaven, base],
      [OFFICIAL_ENDPOINTS.neoforgeMaven, base],
      [OFFICIAL_ENDPOINTS.modrinthApi, base]
    ]
    for (const [from, to] of mappings) {
      if (url.startsWith(from)) return to + url.slice(from.length)
    }
    return url
  }

  /** Mojang 官方域名 → BMCLAPI 路径映射 */
  private mapMojangUrlToBmclapi(url: string): string {
    try {
      const parsed = new URL(url)
      const host = parsed.hostname
      const path = parsed.pathname
      if (host === 'piston-meta.mojang.com' || host === 'launchermeta.mojang.com') {
        return `https://bmclapi2.bangbang93.com${path}`
      }
      if (host === 'resources.download.minecraft.net') {
        // /ab/abcdef... → /assets/ab/abcdef...
        return `${BMCLAPI_ENDPOINTS.root}/assets${path}`
      }
      if (host === 'libraries.minecraft.net') {
        return `${BMCLAPI_ENDPOINTS.root}/maven${path}`
      }
      if (host === 'piston-data.mojang.com' || host === 'launcher.mojang.com') {
        // 客户端 / 服务端 jar 形如 /v1/objects/xx/<sha1>/client.jar。
        // BMCLAPI 的等价地址需要「版本 id」而非 sha1，而 URL 里只有 sha1，
        // 因此这里无法安全映射：交由调用方用 mirror.bmclapiClientJar(versionId) 作为备用地址，
        // 这里保持官方地址不动（会由下载器的多地址回退机制处理）。
        return url
      }
      if (host === 'api.modrinth.com') {
        return url.replace('https://api.modrinth.com', BMCLAPI_ENDPOINTS.root + '/modrinth')
      }
      return url
    } catch {
      return url
    }
  }

  /** 构造 BMCLAPI 的版本 json 地址（用于加速版本详情获取） */
  bmclapiVersionJson(versionId: string): string {
    return `${BMCLAPI_ENDPOINTS.root}/version/${versionId}/json`
  }

  /** 构造 BMCLAPI 的客户端 jar 地址 */
  bmclapiClientJar(versionId: string): string {
    return `${BMCLAPI_ENDPOINTS.root}/version/${versionId}/client`
  }

  /** 构造 BMCLAPI 的资源对象地址 */
  bmclapiAsset(hash: string): string {
    return `${BMCLAPI_ENDPOINTS.root}/assets/${hash.slice(0, 2)}/${hash}`
  }

  /** 构造资源索引地址 */
  bmclapiAssetIndex(versionId: string): string {
    return `${BMCLAPI_ENDPOINTS.root}/version/${versionId}/assetIndex`
  }

  describe(): string {
    return `mojang=${this.get('mojang')} forge=${this.get('forge')} fabric=${this.get('fabric')} modrinth=${this.get('modrinth')}`
  }

  /** 供 UI 展示当前全局加速状态 */
  isAccelerated(): boolean {
    return (
      this.get('mojang') !== 'official' ||
      this.get('forge') !== 'official' ||
      this.get('fabric') !== 'official' ||
      this.get('modrinth') !== 'official'
    )
  }

  static default(): McalSettings['mirror'] {
    return {
      mojang: 'bmclapi',
      forge: 'bmclapi',
      fabric: 'bmclapi',
      modrinth: 'official'
    }
  }

  static presets(): MirrorConfig[] {
    return [
      { id: 'official', forMojang: true, forForge: true, forFabric: true, forModrinth: true },
      { id: 'bmclapi', baseUrl: BMCLAPI_ENDPOINTS.root, forMojang: true, forForge: true, forFabric: true, forModrinth: true },
      { id: 'custom', forMojang: true, forForge: true, forFabric: true, forModrinth: true }
    ]
  }
}

function stripJar(name: string): string {
  return name.replace(/\.jar$/i, '')
}

/** 常用附加下载地址（用于网络受限时的备用源） */
export function fallbackMirrors(url: string): string[] {
  const out: string[] = []
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'bmclapi2.bangbang93.com') {
      // 镜像失败时回退官方
      const official = url
        .replace('https://bmclapi2.bangbang93.com/maven', OFFICIAL_ENDPOINTS.libraries)
        .replace('https://bmclapi2.bangbang93.com/assets', OFFICIAL_ENDPOINTS.resources)
      if (official !== url) out.push(official)
    }
  } catch {
    log.debug(`无法解析 URL: ${url}`)
  }
  return out
}
