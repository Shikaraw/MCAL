/**
 * 生图模型接入层
 *
 * 支持 5 种 provider（API 形态严格对齐各自官方文档）：
 *  1. `openai`      —— OpenAI 兼容的 POST {baseUrl}/v1/images/generations
 *                       （SiliconFlow / 智谱 / 本地 one-api / new-api 等大多兼容），
 *                       响应 { data: [{ b64_json } | { url }] }；
 *  2. `zhipu`       —— 智谱 CogView：POST https://open.bigmodel.cn/api/paas/v4/images/generations
 *                       body { model, prompt, size }，响应 { data: [{ url }] }；
 *  3. `siliconflow` —— POST https://api.siliconflow.cn/v1/images/generations
 *                       body { model, prompt, image_size, batch_size, negative_prompt }，
 *                       响应 { images: [{ url }] }（注意字段是 images，同时兼容 data）；
 *  4. `sd-webui`    —— 本地 Stable Diffusion WebUI / Forge：POST {baseUrl}/sdapi/v1/txt2img
 *                       body { prompt, negative_prompt, width, height, batch_size, seed, steps, cfg_scale }，
 *                       响应 { images: ["<base64>"] }，无需 apiKey；
 *  5. `custom`      —— OpenAI 兼容形态 + 用户自定义 baseUrl/model。
 *
 * 设计约束：
 *  - 本模块**不负责**图片展示，也不做后处理（见 media/imaging.ts 与 media/service.ts）；
 *  - 单个 provider 失败时直接抛错（附原始响应片段），**不会**自动切换 provider，
 *    以免产生不一致的计费与风格；
 *  - 测试只使用假 fetch / 纯函数 buildRequestBody，绝不发起真实请求。
 */

import type { ImageProviderSettings } from '@shared/types'
import { HttpClient, http as defaultHttp } from '@core/net/http'
import { logger } from '@core/util/logger'

const log = logger.scoped('media:providers')

export interface ImageGenRequest {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  count?: number
  seed?: number
  model?: string
  signal?: AbortSignal
}

export interface ImageGenResponse {
  images: { data: Buffer; mimeType: string }[]
  raw?: unknown
  provider: string
}

export interface ImageProvider {
  id: string
  name: string
  /** 支持的模型列表（静态声明，不做联网探测） */
  models: string[]
  /** 是否已配置（有 baseUrl + apiKey） */
  configured(settings: ImageProviderSettings): boolean
  generate(settings: ImageProviderSettings, req: ImageGenRequest): Promise<ImageGenResponse>
}

export type ProviderKind = 'openai' | 'zhipu' | 'siliconflow' | 'sd-webui' | 'custom'

/** 可注入依赖（测试时传入假 fetch / HttpClient） */
export interface ProviderDeps {
  fetchImpl?: typeof fetch
  httpClient?: HttpClient
  /** sd-webui 的默认采样参数（可选覆盖） */
  sdDefaults?: { steps?: number; cfgScale?: number }
}

/** 从响应里解析出的单张图片（base64 或 url） */
export interface ImagePayload {
  base64?: string
  url?: string
}

/* ------------------------------------------------------------------ *
 *  Provider 元信息
 * ------------------------------------------------------------------ */

const PROVIDER_META: Record<ProviderKind, {
  name: string
  defaultBaseUrl: string
  /** 资源路径（拼接在版本段之后） */
  apiPath: string
  /** baseUrl 缺少的版本段（用户可能只填到域名） */
  versionPath: string
  models: string[]
  note: string
  requiresApiKey: boolean
}> = {
  openai: {
    name: 'OpenAI（兼容）',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiPath: '/images/generations',
    versionPath: '/v1',
    models: ['gpt-image-1', 'dall-e-3', 'dall-e-2'],
    note: '最通用的 OpenAI 兼容形态（/v1/images/generations）。SiliconFlow、智谱、one-api / new-api 等大多可直接用这个 kind，把 baseUrl 指向对应服务即可。',
    requiresApiKey: true
  },
  zhipu: {
    name: '智谱 CogView',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiPath: '/images/generations',
    versionPath: '/api/paas/v4',
    models: ['cogview-3-flash', 'cogview-4'],
    note: '智谱官方接口。新版直接用 API Key 走 Bearer 认证即可；旧版需要先用 key 生成 JWT（本实现不生成 JWT，如遇 401 请改用新版开放平台的 Key）。',
    requiresApiKey: true
  },
  siliconflow: {
    name: 'SiliconFlow（硅基流动）',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    apiPath: '/images/generations',
    versionPath: '/v1',
    models: ['Kwai-Kolors/Kolors', 'Qwen/Qwen-Image', 'black-forest-labs/FLUX.1-schnell'],
    note: '响应字段是 images（不是 data），本实现两种都兼容；支持 negative_prompt 与 batch_size。',
    requiresApiKey: true
  },
  'sd-webui': {
    name: 'Stable Diffusion WebUI（本地）',
    defaultBaseUrl: 'http://127.0.0.1:7860',
    apiPath: '/sdapi/v1/txt2img',
    versionPath: '',
    models: ['sd-webui'],
    note: '本地部署（A1111 / Forge / reForge）：需要启动参数 --api。model 由 WebUI 当前加载的 checkpoint 决定，此处只作标识。',
    requiresApiKey: false
  },
  custom: {
    name: '自定义（OpenAI 兼容）',
    defaultBaseUrl: '',
    apiPath: '/images/generations',
    versionPath: '/v1',
    models: [],
    note: '任意 OpenAI 兼容的图片接口：自行填写 baseUrl（如 http://127.0.0.1:3000/v1）与模型名。',
    requiresApiKey: false
  }
}

/** 供 UI 展示的 provider 种类列表 */
export function listProviderKinds(): { kind: string; name: string; defaultBaseUrl: string; models: string[]; note: string }[] {
  return (Object.keys(PROVIDER_META) as ProviderKind[]).map((kind) => ({
    kind,
    name: PROVIDER_META[kind].name,
    defaultBaseUrl: PROVIDER_META[kind].defaultBaseUrl,
    models: [...PROVIDER_META[kind].models],
    note: PROVIDER_META[kind].note
  }))
}

/* ------------------------------------------------------------------ *
 *  URL / 请求体构造（纯函数，便于单测）
 * ------------------------------------------------------------------ */

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** 统一尺寸字符串：优先请求参数，其次 settings.sizeParam，最后默认 1024x1024 */
function sizeString(req: ImageGenRequest, fallback = '1024x1024'): string {
  if (req.width && req.height) return `${req.width}x${req.height}`
  return fallback
}

/** 把负向提示词折叠进正向提示词（不支持的接口用，例如 OpenAI / 智谱） */
function foldNegative(prompt: string, negativePrompt?: string): string {
  if (!negativePrompt) return prompt
  return `${prompt}\nAvoid the following: ${negativePrompt}`
}

/** OpenAI 兼容：/v1/images/generations */
export function buildOpenAiStyleBody(settings: ImageProviderSettings, req: ImageGenRequest): Record<string, unknown> {
  const model = req.model || settings.model || PROVIDER_META.openai.models[0]
  const body: Record<string, unknown> = {
    model,
    prompt: foldNegative(req.prompt, req.negativePrompt),
    n: Math.max(1, Math.min(10, req.count ?? 1)),
    // 官方支持 1024x1024 / 1024x1792 / 1792x1024 等，自定义服务端通常也接受
    size: settings.sizeParam || sizeString(req),
    response_format: 'b64_json'
  }
  // GPT-image 系列不接受 response_format（固定返回 b64）；带上一般也不报错，
  // 若遇到 400 "Unsupported parameter" 可把设置里的 model 换成 dall-e-3 或自行去掉该字段。
  return body
}

/**
 * 智谱 CogView：/api/paas/v4/images/generations
 * 认证说明：新版开放平台直接用 `Authorization: Bearer <apiKey>`；
 * 旧版（2024 早期）要求把 apiKey 拆成 id.secret 后做 JWT 签名，本实现不生成 JWT。
 */
export function buildZhipuBody(settings: ImageProviderSettings, req: ImageGenRequest): Record<string, unknown> {
  const model = req.model || settings.model || 'cogview-3-flash'
  return {
    model,
    prompt: foldNegative(req.prompt, req.negativePrompt),
    // CogView 只支持固定几档：1024x1024 / 768x1344 / 1344x768 / 1440x720 / 720x1440
    size: settings.sizeParam || sizeString(req)
  }
}

/** SiliconFlow：字段是 image_size / batch_size / negative_prompt */
export function buildSiliconFlowBody(settings: ImageProviderSettings, req: ImageGenRequest): Record<string, unknown> {
  const model = req.model || settings.model || PROVIDER_META.siliconflow.models[0]
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    image_size: settings.sizeParam || sizeString(req),
    batch_size: Math.max(1, Math.min(4, req.count ?? 1))
  }
  if (req.negativePrompt) body.negative_prompt = req.negativePrompt
  if (req.seed !== undefined) body.seed = req.seed
  return body
}

/** 本地 SD WebUI / Forge：/sdapi/v1/txt2img */
export function buildSdWebUiBody(
  settings: ImageProviderSettings,
  req: ImageGenRequest,
  sdDefaults: { steps?: number; cfgScale?: number } = {}
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    negative_prompt: req.negativePrompt ?? '',
    // SD1.5 系列默认 512，SDXL 用 1024；这里只在调用方显式给出时覆盖
    width: req.width ?? 512,
    height: req.height ?? 512,
    batch_size: Math.max(1, Math.min(8, req.count ?? 1)),
    steps: sdDefaults.steps ?? 20,
    cfg_scale: sdDefaults.cfgScale ?? 7
  }
  if (req.seed !== undefined) body.seed = req.seed
  // 设置里的 model 字段对应 WebUI 的 override_settings（切换 checkpoint），
  // 非必须，一般留空表示使用当前加载的模型。
  return body
}

/** 统一的请求体构造入口（测试主要覆盖这个函数） */
export function buildImageRequestBody(
  kind: string,
  settings: ImageProviderSettings,
  req: ImageGenRequest,
  sdDefaults: { steps?: number; cfgScale?: number } = {}
): Record<string, unknown> {
  switch (normalizeKind(kind)) {
    case 'zhipu':
      return buildZhipuBody(settings, req)
    case 'siliconflow':
      return buildSiliconFlowBody(settings, req)
    case 'sd-webui':
      return buildSdWebUiBody(settings, req, sdDefaults)
    default:
      // openai / custom 都是 OpenAI 兼容
      return buildOpenAiStyleBody(settings, req)
  }
}

/** 生成接口地址：容忍用户把 baseUrl 填到域名、/v1、或完整路径 */
export function buildEndpoint(kind: string, settings: ImageProviderSettings): string {
  const normalized = normalizeKind(kind)
  const meta = PROVIDER_META[normalized]
  const configuredBase = (settings.baseUrl ?? '').trim()
  const base = stripTrailingSlash(configuredBase || meta.defaultBaseUrl)
  if (!base) throw new Error('未配置生图服务的 baseUrl')
  // 用户直接填了完整地址
  if (base.endsWith(meta.apiPath)) return base
  // baseUrl 已带版本段（/v1、/api/paas/v4 …）时只需拼接资源路径
  const versionSegment = /\/(?:v\d+|api\/paas\/v\d+)$/
  if (!meta.versionPath || versionSegment.test(base)) return base + meta.apiPath
  return base + meta.versionPath + meta.apiPath
}

/* ------------------------------------------------------------------ *
 *  响应解析
 * ------------------------------------------------------------------ */

/** 兼容多种响应形态，提取 { base64 } 或 { url } 列表 */
export function parseImageResponse(payload: unknown): ImagePayload[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const candidates: unknown[] = []

  // sd-webui: { images: ["<base64>"] }
  if (Array.isArray(record.images)) candidates.push(...record.images)
  // openai / zhipu: { data: [{ b64_json } | { url }] }
  if (Array.isArray(record.data)) candidates.push(...record.data)
  // 兼容 { data: { url } } / { image: "..." } 之类单图形态
  if (record.data && !Array.isArray(record.data)) candidates.push(record.data)
  if (typeof record.image === 'string') candidates.push(record.image)

  const out: ImagePayload[] = []
  for (const item of candidates) {
    if (typeof item === 'string') {
      // device: 可能带 data url 前缀，也可能是纯 base64
      if (item.startsWith('http://') || item.startsWith('https://')) out.push({ url: item })
      else out.push({ base64: stripDataUrl(item).data })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const b64 = typeof entry.b64_json === 'string' ? entry.b64_json : typeof entry.base64 === 'string' ? entry.base64 : undefined
    const url = typeof entry.url === 'string' ? entry.url : typeof entry.imageUrl === 'string' ? entry.imageUrl : undefined
    if (b64) out.push({ base64: stripDataUrl(b64).data })
    else if (url) out.push({ url })
  }
  return out
}

/** 去掉 `data:image/png;base64,` 前缀 */
export function stripDataUrl(value: string): { mimeType?: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value.trim())
  if (match) return { mimeType: match[1], data: match[2].replace(/\s/g, '') }
  return { data: value.trim().replace(/\s/g, '') }
}

/** 由魔数判断图片类型，识别不出时回退 png */
export function guessMimeType(data: Buffer): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (data.length >= 4 && data.toString('ascii', 0, 2) === 'GIF') return 'image/gif'
  return 'image/png'
}

export function normalizeKind(kind: string | undefined): ProviderKind {
  const lower = (kind ?? '').trim().toLowerCase()
  if (lower === 'zhipu' || lower === 'bigmodel' || lower === 'glm') return 'zhipu'
  if (lower === 'siliconflow' || lower === 'silicon-flow' || lower === 'silicon') return 'siliconflow'
  if (lower === 'sd-webui' || lower === 'sdwebui' || lower === 'sd' || lower === 'a1111' || lower === 'forge') return 'sd-webui'
  if (lower === 'custom') return 'custom'
  if (lower === 'openai' || lower === 'openai-compatible' || lower === '') return 'openai'
  return 'custom'
}

/* ------------------------------------------------------------------ *
 *  Provider 实现
 * ------------------------------------------------------------------ */

interface ResolvedErrorContext {
  url: string
  status?: number
  snippet?: string
}

function httpFailureMessage(ctx: ResolvedErrorContext): string {
  const parts = [`生图请求失败：${ctx.url}`]
  if (ctx.status !== undefined) parts.push(`HTTP ${ctx.status}`)
  if (ctx.snippet) parts.push(`响应片段：${ctx.snippet}`)
  return parts.join('\n')
}

class HttpImageProvider implements ImageProvider {
  readonly id: string
  readonly name: string
  readonly models: string[]
  private readonly kind: ProviderKind
  private readonly deps: ProviderDeps

  constructor(settings: ImageProviderSettings, deps: ProviderDeps = {}) {
    this.kind = normalizeKind(settings.kind)
    const meta = PROVIDER_META[this.kind]
    this.id = settings.id || this.kind
    this.name = settings.name || meta.name
    this.models = settings.model ? [settings.model, ...meta.models] : [...meta.models]
    this.deps = deps
  }

  configured(settings: ImageProviderSettings): boolean {
    const meta = PROVIDER_META[this.kind]
    const baseUrl = (settings.baseUrl || meta.defaultBaseUrl || '').trim()
    if (!baseUrl) return false
    if (!meta.requiresApiKey) return true
    return Boolean((settings.apiKey ?? '').trim())
  }

  async generate(settings: ImageProviderSettings, req: ImageGenRequest): Promise<ImageGenResponse> {
    if (!this.configured(settings)) {
      throw new Error(
        `生图服务未配置完整（provider=${this.id}）：请在设置里填写 baseUrl 与 apiKey 后重试。`
      )
    }
    const url = buildEndpoint(this.kind, settings)
    const body = buildImageRequestBody(this.kind, settings, req, this.deps.sdDefaults)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const apiKey = (settings.apiKey ?? '').trim()
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const fetcher = this.deps.fetchImpl ?? fetch
    log.info(`生成请求：${this.kind} -> ${url}（model=${String(body.model ?? settings.model ?? 'default')}）`)

    let response: Response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal
      })
    } catch (err) {
      throw new Error(`生图请求无法发出（${url}）：${(err as Error).message}`)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new Error(httpFailureMessage({ url, status: response.status, snippet: text.slice(0, 500) }))
    }
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      throw new Error(httpFailureMessage({ url, status: response.status, snippet: text.slice(0, 500) }))
    }

    const parsed = parseImageResponse(payload)
    if (parsed.length === 0) {
      throw new Error(`生图响应中没有图片数据（${url}）：${text.slice(0, 300)}`)
    }

    const images: { data: Buffer; mimeType: string }[] = []
    for (const item of parsed) {
      if (item.base64) {
        const { mimeType, data } = stripDataUrl(item.base64)
        const buffer = Buffer.from(data, 'base64')
        images.push({ data: buffer, mimeType: mimeType ?? guessMimeType(buffer) })
        continue
      }
      if (item.url) {
        const buffer = await this.downloadImage(item.url, req.signal)
        images.push({ data: buffer, mimeType: guessMimeType(buffer) })
      }
    }
    if (images.length === 0) {
      throw new Error(`生图响应解析后没有有效图片（${url}）：请检查返回格式是否与 provider 匹配。`)
    }
    return { images, raw: payload, provider: this.id }
  }

  private async downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
    // 图片直链可能是临时签名 URL，统一走 HttpClient（含重试与超时）
    const client = this.deps.httpClient ?? defaultHttp
    try {
      return await client.getBuffer(url, { signal })
    } catch (err) {
      throw new Error(`下载生成结果失败（${url}）：${(err as Error).message}`)
    }
  }
}

/** 根据设置创建 provider；kind 无法识别时返回 null（UI 应引导用户选择） */
export function createProvider(settings: ImageProviderSettings, deps: ProviderDeps = {}): ImageProvider | null {
  const kind = (settings.kind ?? '').trim().toLowerCase()
  const known = ['openai', 'zhipu', 'siliconflow', 'sd-webui', 'sdwebui', 'custom', 'openai-compatible', 'a1111', 'forge', 'glm', 'bigmodel', 'silicon']
  if (!known.includes(kind)) {
    log.warn(`未知的生图 provider kind：${settings.kind}（可选项：${listProviderKinds().map((k) => k.kind).join(', ')}）`)
    return null
  }
  return new HttpImageProvider(settings, deps)
}

/** 按 kind 判断是否需要 apiKey */
export function kindRequiresApiKey(kind: string): boolean {
  return PROVIDER_META[normalizeKind(kind)].requiresApiKey
}

/** 各 provider 的默认 baseUrl（UI 里做占位提示用） */
export function defaultBaseUrlOf(kind: string): string {
  return PROVIDER_META[normalizeKind(kind)].defaultBaseUrl
}
