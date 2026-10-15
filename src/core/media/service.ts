/**
 * 生图服务：把「provider 生成」与「MC 像素化后处理」串起来。
 *
 * 职责边界：
 *  - 本模块只负责生成与落盘（返回文件路径），**不负责图片展示**；
 *  - 单个 provider 失败时**不会**自动切换其它 provider（避免不一致的计费与画风），
 *    直接抛出带原始响应片段的错误；listProviders() 会标出未配置的 provider 供 UI 引导；
 *  - preset 的提示词与后处理参数都按 MC 美术风格调过（见 presets()）。
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { ImagePreset, ImageProviderSettings } from '@shared/types'
import type { HttpClient } from '@core/net/http'
import { ensureDir, sanitizeFileName, writeFileAtomic } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { ImageProcessor, type RgbaImage } from '@core/media/imaging'
import {
  createProvider,
  type ImageGenRequest,
  type ImageProvider,
  type ProviderDeps
} from '@core/media/providers'

const log = logger.scoped('media:service')

export interface MediaServiceOptions {
  client: HttpClient
  settings: { providers: ImageProviderSettings[]; activeProviderId?: string }
  /** 默认输出目录 */
  outputRoot: string
  /** 测试用：注入假 fetch / HttpClient */
  deps?: ProviderDeps
}

/** preset 的提示词与后处理参数 */
export interface PresetInfo {
  id: ImagePreset
  name: string
  promptPrefix: string
  promptSuffix: string
  pixelSize?: number
  quantizeColors?: number
  note: string
}

/** 哪些 preset 应做「去背景」（生成物品图标常用；方块贴图不能去背） */
const PRESET_REMOVE_BACKGROUND: Record<ImagePreset, boolean> = {
  'mc-item': true,
  'mc-block': false,
  'mc-gui': false,
  'concept-art': false,
  logo: true,
  raw: false
}

const MC_ITEM_NEGATIVE =
  'blurry, photorealistic, 3d render, text, watermark, anti-aliasing, gradients'
const MC_BLOCK_NEGATIVE =
  'perspective, 3d render, shadows, text, watermark, blurry, gradients, anti-aliasing'

const PRESETS: PresetInfo[] = [
  {
    id: 'mc-item',
    name: 'MC 物品图标（16x16）',
    promptPrefix:
      'Minecraft item icon, 16x16 pixel art, clean silhouette, limited palette, dark outline, no anti-aliasing, centered, plain background',
    promptSuffix: ', single object, front view, flat lighting, crisp pixels, game inventory icon',
    pixelSize: 16,
    quantizeColors: 24,
    note: `负向提示词：${MC_ITEM_NEGATIVE}。生成后会自动去背（去四角背景）→ nearest 缩到 16x16 → 量化到 24 色，并输出 16/32/64/128 的 mipmap。`
  },
  {
    id: 'mc-block',
    name: 'MC 方块贴图（16x16，可平铺）',
    promptPrefix:
      'Minecraft block texture, 16x16 seamless tileable pixel art, top-down flat view, consistent lighting, no shadows, limited palette',
    promptSuffix: ', evenly distributed detail across the whole tile, edges tile seamlessly',
    pixelSize: 16,
    quantizeColors: 32,
    note: `负向提示词：${MC_BLOCK_NEGATIVE}。方块贴图必须整格铺满（不做去背），缩放到 16x16 后量化到 32 色。`
  },
  {
    id: 'mc-gui',
    name: 'MC GUI 界面贴图（256x256）',
    promptPrefix:
      'Minecraft GUI texture, flat pixel art interface, 256x256, panel with beveled borders, muted gray palette, no text',
    promptSuffix: ', clean symmetrical layout, slot grid, no anti-aliasing',
    pixelSize: 256,
    quantizeColors: 64,
    note: 'GUI 贴图不做去背；注意九宫格拉伸的边缘像素与四角保持规整。生成后可再按需裁切。'
  },
  {
    id: 'concept-art',
    name: '概念图 / 宣传图',
    promptPrefix:
      'Minecraft-inspired concept art, blocky voxel aesthetic, painterly lighting, vibrant colors, wide composition',
    promptSuffix: ', high detail, dramatic lighting, game key art',
    note: '不做像素化处理（保留生成分辨率），适合做 mod 宣传图、图标背景素材。'
  },
  {
    id: 'logo',
    name: '模组 Logo（透明背景）',
    promptPrefix:
      'Minecraft mod logo, flat vector emblem, bold simple shapes, limited palette, transparent background, centered, no text',
    promptSuffix: ', crisp edges, high contrast, readable at small size',
    pixelSize: 128,
    quantizeColors: 32,
    note: '会去背后缩到 128x128 并量化到 32 色；生成 128/256 两档满足不同用途。'
  },
  {
    id: 'raw',
    name: '原图（不做处理）',
    promptPrefix: '',
    promptSuffix: '',
    note: '不加风格前缀，也不做像素化/量化/去背：只把模型返回的原图落盘。'
  }
]

/** 组合 preset 前缀/后缀与用户提示词（纯函数，便于单测） */
export function composePrompt(
  preset: PresetInfo,
  prompt: string,
  negativePrompt?: string,
  presetNegative?: string
): { prompt: string; negativePrompt: string } {
  const positive = prompt.trim()
  const prefixed = preset.promptPrefix ? `${preset.promptPrefix}${positive ? `, ${positive}` : ''}` : positive
  const withSuffix = preset.promptSuffix ? `${prefixed}${preset.promptSuffix}` : prefixed
  const negatives = [presetNegative, negativePrompt?.trim()].filter((x): x is string => Boolean(x && x.trim()))
  return { prompt: withSuffix, negativePrompt: negatives.join(', ') }
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function dateFolder(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/webp') return '.webp'
  if (mimeType === 'image/gif') return '.gif'
  return '.png'
}

/** preset id 需要去背吗（导出的纯函数便于 UI/测试使用） */
export function presetRemovesBackground(preset: ImagePreset): boolean {
  return PRESET_REMOVE_BACKGROUND[preset] ?? false
}

export class MediaService {
  private readonly client: HttpClient
  private readonly settings: { providers: ImageProviderSettings[]; activeProviderId?: string }
  private readonly outputRoot: string
  private readonly deps: ProviderDeps

  constructor(opts: MediaServiceOptions) {
    this.client = opts.client
    this.settings = opts.settings
    this.outputRoot = opts.outputRoot
    this.deps = { httpClient: opts.client, ...(opts.deps ?? {}) }
  }

  listProviders(): { id: string; name: string; configured: boolean; models: string[] }[] {
    return this.settings.providers.map((providerSettings) => {
      const provider = createProvider(providerSettings, this.deps)
      if (!provider) {
        // 未知 kind：仍然列出来，让 UI 引导用户改用受支持的 kind
        return {
          id: providerSettings.id,
          name: providerSettings.name || providerSettings.kind,
          configured: false,
          models: providerSettings.model ? [providerSettings.model] : []
        }
      }
      return {
        id: provider.id,
        name: provider.name,
        configured: provider.configured(providerSettings),
        models: provider.models
      }
    })
  }

  /** preset 对应的提示词前缀/后缀与后处理参数（MC 美术风格引导） */
  presets(): PresetInfo[] {
    return PRESETS.map((preset) => ({ ...preset }))
  }

  /**
   * 生成图片并按 preset 做后处理，写入 outputDir（默认 outputRoot/日期/），返回文件路径。
   */
  async generate(opts: {
    prompt: string
    negativePrompt?: string
    width?: number
    height?: number
    count?: number
    outputDir?: string
    pixelSize?: number
    preset?: ImagePreset
    seed?: number
    signal?: AbortSignal
    /** 处理失败时是否保留原图 */
    keepOriginalOnError?: boolean
  }): Promise<{ files: string[]; provider: string; warnings: string[] }> {
    const prompt = (opts.prompt ?? '').trim()
    if (!prompt) throw new Error('生成图片需要提供 prompt（提示词不能为空）。')

    const persistedOutputRoot = opts.outputDir?.trim() || join(this.outputRoot, dateFolder())
    const presetId: ImagePreset = opts.preset ?? 'raw'
    const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[PRESETS.length - 1]

    const { provider, settings } = this.resolveProvider()
    const composed = composePrompt(preset, prompt, opts.negativePrompt, preset.id === 'mc-item' ? MC_ITEM_NEGATIVE : preset.id === 'mc-block' ? MC_BLOCK_NEGATIVE : undefined)

    const request: ImageGenRequest = {
      prompt: composed.prompt,
      width: opts.width,
      height: opts.height,
      count: opts.count,
      seed: opts.seed,
      signal: opts.signal
    }
    if (composed.negativePrompt) request.negativePrompt = composed.negativePrompt

    log.info(`开始生成：provider=${provider.id} preset=${preset.id} pixelSize=${opts.pixelSize ?? preset.pixelSize ?? '-'}`)
    const response = await provider.generate(settings, request)

    const warnings: string[] = []
    const files: string[] = []
    const stamp = timestamp()
    const baseName = sanitizeFileName(prompt.slice(0, 30), '_') || 'image'
    const pixelSize = opts.pixelSize && opts.pixelSize > 0 ? opts.pixelSize : preset.pixelSize

    await ensureDir(persistedOutputRoot)

    for (let i = 0; i < response.images.length; i++) {
      const image = response.images[i]
      const stem = `${baseName}-${stamp}-${i + 1}`
      if (!pixelSize) {
        const target = join(persistedOutputRoot, `${stem}${extensionForMime(image.mimeType)}`)
        await writeFileAtomic(target, image.data)
        files.push(target)
        continue
      }

      try {
        const processed = await this.pixelateBuffer(image.data, {
          pixelSize,
          quantizeColors: preset.quantizeColors,
          removeBackground: PRESET_REMOVE_BACKGROUND[preset.id] ?? false
        })
        const mainPath = join(persistedOutputRoot, `${stem}_${pixelSize}.png`)
        await writeFileAtomic(mainPath, processed.png)
        files.push(mainPath)
        for (const mip of processed.mipmaps) {
          const mipPath = join(persistedOutputRoot, `${stem}_${mip.size}.png`)
          await writeFileAtomic(mipPath, mip.png)
          files.push(mipPath)
        }
      } catch (err) {
        const message = (err as Error).message
        if (!opts.keepOriginalOnError) {
          throw new Error(
            `图片后处理失败（preset=${preset.id}, pixelSize=${pixelSize}）：${message}\n可设置 keepOriginalOnError=true 保留原图，或改用 preset=raw。`
          )
        }
        const fallback = join(persistedOutputRoot, `${stem}_original${extensionForMime(image.mimeType)}`)
        await writeFileAtomic(fallback, image.data)
        files.push(fallback)
        warnings.push(`图片后处理失败已保留原图：${message}`)
      }
    }

    return { files, provider: provider.id, warnings }
  }

  /** 直接对已有图片做 MC 化处理（不需要生图模型） */
  async pixelate(opts: {
    inputPath: string
    outputPath?: string
    pixelSize: number
    quantizeColors?: number
    removeBackground?: boolean
    mipmaps?: number[]
  }): Promise<{ files: string[] }> {
    if (!opts.pixelSize || opts.pixelSize <= 0) throw new Error('pixelate：pixelSize 必须为正整数')
    const buffer = await readFile(opts.inputPath)
    const processed = await this.pixelateBuffer(buffer, opts)

    const outputPath =
      opts.outputPath ??
      join(dirname(opts.inputPath), `${basename(opts.inputPath, extname(opts.inputPath))}_pixel_${opts.pixelSize}.png`)
    await writeFileAtomic(outputPath, processed.png)

    const files = [outputPath]
    if (opts.mipmaps && opts.mipmaps.length > 0) {
      const stem = basename(outputPath, extname(outputPath))
      for (const mip of processed.mipmaps) {
        const mipPath = join(dirname(outputPath), `${stem}_${mip.size}.png`)
        await writeFileAtomic(mipPath, mip.png)
        files.push(mipPath)
      }
    }
    return { files }
  }

  /** 内部流水线：解码 -> 去背 -> nearest 缩放 -> 量化 -> 编码 + mipmap */
  private async pixelateBuffer(
    buffer: Buffer,
    opts: {
      pixelSize: number
      quantizeColors?: number
      removeBackground?: boolean
      mipmaps?: number[]
    }
  ): Promise<{ png: Buffer; mipmaps: { size: number; png: Buffer }[] }> {
    const decoded = await ImageProcessor.decodePng(buffer)
    let image: RgbaImage = decoded
    if (opts.removeBackground) image = ImageProcessor.removeBackground(image)
    const scaled = ImageProcessor.resize(image, {
      targetSize: opts.pixelSize,
      mode: 'nearest',
      quantizeColors: opts.quantizeColors
    })
    const png = await ImageProcessor.encodePng(scaled)

    // 默认生成 2x/4x/8x（最大 128）的 mipmap，便于资源包/模组直接取用
    const sizes = opts.mipmaps && opts.mipmaps.length > 0
      ? opts.mipmaps
      : [opts.pixelSize * 2, opts.pixelSize * 4, opts.pixelSize * 8].filter((s) => s <= 128)
    const mipmaps = ImageProcessor.generateMipmaps(scaled, sizes)
    return { png, mipmaps }
  }

  /** 选择 provider：优先 activeProviderId，否则第一个已配置的；都没有则抛出可读错误 */
  private resolveProvider(): { provider: ImageProvider; settings: ImageProviderSettings } {
    if (this.settings.providers.length === 0) {
      throw new Error('还没有配置任何生图服务：请到「设置 → 生图模型」添加 OpenAI 兼容服务、智谱、SiliconFlow 或本地 SD WebUI。')
    }

    const active = this.settings.activeProviderId
      ? this.settings.providers.find((p) => p.id === this.settings.activeProviderId)
      : undefined
    const candidates = active ? [active] : this.settings.providers

    const missing: string[] = []
    for (const candidate of candidates) {
      const provider = createProvider(candidate, this.deps)
      if (!provider) {
        missing.push(`${candidate.name || candidate.id}（不支持的 kind：${candidate.kind}）`)
        continue
      }
      if (provider.configured(candidate)) return { provider, settings: candidate }
      missing.push(`${candidate.name || candidate.id}（缺少 baseUrl 或 apiKey）`)
    }

    throw new Error(
      `没有可用的生图服务：${missing.join('；')}。\n` +
        '请在「设置 → 生图模型」里补全信息（本地 SD WebUI 只需 baseUrl，如 http://127.0.0.1:7860）。'
    )
  }
}
