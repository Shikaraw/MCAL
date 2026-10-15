/**
 * 生图能力测试：PNG 编解码 / 缩放 / 量化 / 去背、provider 请求体构造与响应解析、
 * preset 提示词、MediaService 流程。
 *
 * 全部离线：
 *  - 解码用的 PNG fixture 由测试现场手工拼字节（zlib + chunk），不依赖任何图像库；
 *  - provider 测试注入假 fetch 与假 HttpClient，绝不发起真实网络请求。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { ImageProviderSettings } from '@shared/types'
import type { HttpClient } from '@core/net/http'
import { ImageProcessor, type RgbaImage } from '@core/media/imaging'
import {
  buildEndpoint,
  buildImageRequestBody,
  buildOpenAiStyleBody,
  buildSdWebUiBody,
  buildSiliconFlowBody,
  buildZhipuBody,
  createProvider,
  guessMimeType,
  listProviderKinds,
  parseImageResponse,
  type ImageGenRequest
} from '@core/media/providers'
import { MediaService, composePrompt, presetRemovesBackground } from '@core/media/service'

let workDir = ''

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mcal-media-'))
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ *
 *  测试辅助
 * ------------------------------------------------------------------ */

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      const i = (y * width + x) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = a
    }
  }
  return { width, height, rgba }
}

function uniqueOpaqueColors(img: RgbaImage): number {
  const set = new Set<number>()
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i + 3] === 0) continue
    set.add((img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2])
  }
  return set.size
}

/** 手工拼 PNG chunk（CRC 置 0：解码器按约定不校验 CRC） */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function craftPng(opts: {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace?: number
  rows: Buffer
  palette?: Buffer
  trns?: Buffer
}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(opts.width, 0)
  ihdr.writeUInt32BE(opts.height, 4)
  ihdr[8] = opts.bitDepth
  ihdr[9] = opts.colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = opts.interlace ?? 0
  const parts = [PNG_SIG, pngChunk('IHDR', ihdr)]
  if (opts.palette) parts.push(pngChunk('PLTE', opts.palette))
  if (opts.trns) parts.push(pngChunk('tRNS', opts.trns))
  parts.push(pngChunk('IDAT', deflateSync(opts.rows)))
  parts.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/** 假 fetch：记录请求并返回预设响应 */
function makeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown; raw?: boolean }): {
  fetchImpl: typeof fetch
  calls: { url: string; body: Record<string, unknown> }[]
} {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    let parsedBody: Record<string, unknown> = {}
    if (typeof init?.body === 'string') {
      parsedBody = JSON.parse(init.body) as Record<string, unknown>
    }
    calls.push({ url, body: parsedBody })
    const result = handler(url, init ?? {})
    const text = result.raw ? String(result.body) : JSON.stringify(result.body)
    return new Response(text, { status: result.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const SAMPLE_PNG = (() => {
  // 4x2 的彩色 PNG（用于 b64 响应与直链下载测试）
  const img = image(4, 2, (x, y) => [x * 60, y * 120, 200, 255] as [number, number, number, number])
  return ImageProcessor.encodePngSync(img)
})()

const OPENAI_SETTINGS: ImageProviderSettings = {
  id: 'p1',
  name: '假 OpenAI',
  kind: 'openai',
  baseUrl: 'https://fake.local/v1',
  apiKey: 'test-key',
  model: 'dall-e-3'
}

/* ------------------------------------------------------------------ *
 *  PNG 编解码
 * ------------------------------------------------------------------ */

describe('ImageProcessor：PNG 编解码（自写实现）', () => {
  it('encode -> decode 往返一致（含半透明与全透明像素）', async () => {
    const original = image(5, 3, (x, y) => [x * 17, y * 40, (x + y) * 9, x === 4 ? 0 : x === 3 ? 128 : 255] as [number, number, number, number])
    const png = await ImageProcessor.encodePng(original)
    expect(png.subarray(0, 8).equals(PNG_SIG)).toBe(true)
    const decoded = await ImageProcessor.decodePng(png)
    expect(decoded.width).toBe(5)
    expect(decoded.height).toBe(3)
    expect(decoded.rgba.equals(original.rgba)).toBe(true)
  })

  it('encode -> decode 往返一致（32x32 伪随机图，覆盖多行与两种滤波）', async () => {
    let seed = 123456789
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % 256
    }
    const original = image(32, 32, () => [rand(), rand(), rand(), 255] as [number, number, number, number])
    const decoded = await ImageProcessor.decodePng(await ImageProcessor.encodePng(original))
    expect(decoded.width).toBe(32)
    expect(decoded.height).toBe(32)
    expect(decoded.rgba.equals(original.rgba)).toBe(true)
  })

  it('解码 4 位调色板 PNG（含 tRNS 透明索引）', async () => {
    const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
    const trns = Buffer.from([255, 255, 255, 0])
    // 4 像素、位深 4：nibble 序列 0,1,2,3 -> 字节 0x01 0x23
    const rows = Buffer.from([0, 0x01, 0x23])
    const png = craftPng({ width: 4, height: 1, bitDepth: 4, colorType: 3, rows, palette, trns })
    const decoded = await ImageProcessor.decodePng(png)
    expect([...decoded.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 0])
  })

  it('解码 16 位真彩（降到 8 位取高字节）', async () => {
    const rows = Buffer.from([0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc])
    const png = craftPng({ width: 1, height: 1, bitDepth: 16, colorType: 2, rows })
    const decoded = await ImageProcessor.decodePng(png)
    expect([...decoded.rgba]).toEqual([0x12, 0x56, 0x9a, 255])
  })

  it('解码 1 位灰度 PNG', async () => {
    // 8 像素：1 0 1 1 0 0 1 0 -> 0b10110010
    const rows = Buffer.from([0, 0b10110010])
    const png = craftPng({ width: 8, height: 1, bitDepth: 1, colorType: 0, rows })
    const decoded = await ImageProcessor.decodePng(png)
    const grays = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => decoded.rgba[x * 4])
    expect(grays).toEqual([255, 0, 255, 255, 0, 0, 255, 0])
  })

  it('解码 Sub（filter=1）滤波的行', async () => {
    // 3 像素 RGB8：原始 (10,20,30) (40,50,60) (70,80,90)，Sub 滤波后增量 10/30/30
    const rows = Buffer.from([1, 10, 20, 30, 30, 30, 30, 30, 30, 30])
    const png = craftPng({ width: 3, height: 1, bitDepth: 8, colorType: 2, rows })
    const decoded = await ImageProcessor.decodePng(png)
    expect([...decoded.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255])
  })

  it('Adam7 隔行扫描明确抛错', async () => {
    const png = craftPng({ width: 2, height: 2, bitDepth: 8, colorType: 6, interlace: 1, rows: Buffer.alloc(2) })
    await expect(ImageProcessor.decodePng(png)).rejects.toThrow(/Adam7/)
  })

  it('非 PNG 数据明确抛错', async () => {
    await expect(ImageProcessor.decodePng(Buffer.from('not a png at all'))).rejects.toThrow(/签名不匹配/)
  })

  it('编码 colorType 2（丢弃 alpha）可被自己解码', async () => {
    const img = image(2, 1, (x) => [x === 0 ? 10 : 200, 20, 30, x === 0 ? 0 : 255] as [number, number, number, number])
    const png = ImageProcessor.encodePngSync(img, { colorType: 2 })
    const decoded = await ImageProcessor.decodePng(png)
    // 透明像素被压成黑色，避免「透明却有色」
    expect([...decoded.rgba]).toEqual([0, 0, 0, 255, 200, 20, 30, 255])
    // 不改动调用方传入的原始数据
    expect(img.rgba[3]).toBe(0)
    expect(img.rgba[0]).toBe(10)
  })
})

/* ------------------------------------------------------------------ *
 *  缩放 / 量化 / 去背
 * ------------------------------------------------------------------ */

describe('ImageProcessor：缩放', () => {
  it('nearest：2x2 -> 4x4 每个源像素复制成 2x2 块', () => {
    const src = image(2, 2, (x, y) => [(x + 1) * 10, (y + 1) * 20, 0, 255] as [number, number, number, number])
    const out = ImageProcessor.resize(src, { targetSize: 4, mode: 'nearest' })
    expect(out.width).toBe(4)
    expect(out.height).toBe(4)
    const at = (x: number, y: number): number[] => [...out.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)]
    expect(at(0, 0)).toEqual([10, 20, 0, 255])
    expect(at(1, 1)).toEqual([10, 20, 0, 255])
    expect(at(2, 2)).toEqual([20, 40, 0, 255])
    expect(at(3, 3)).toEqual([20, 40, 0, 255])
  })

  it('box：4x4 -> 2x2 做面积平均（缩小时质量好）', () => {
    const src = image(4, 4, (x) => (x < 2 ? [0, 0, 0, 255] : [200, 200, 200, 255]) as [number, number, number, number])
    const out = ImageProcessor.resize(src, { targetSize: 2, mode: 'box' })
    expect(out.width).toBe(2)
    expect(out.height).toBe(2)
    expect(out.rgba[0]).toBe(0) // (0,0) 取左边两列 -> 黑
    expect(out.rgba[4]).toBe(200) // (1,0) 取右边两列 -> 灰
    expect(out.rgba[8]).toBe(0) // (0,1) 同左边
    expect(out.rgba[12]).toBe(200) // (1,1) 同右边
    // alpha 也参与平均（这里全不透明）
    expect(out.rgba[3]).toBe(255)
  })

  it('bilinear：中间像素落在两端之间', () => {
    const src = image(2, 2, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 255] : [200, 200, 200, 255]) as [number, number, number, number])
    const out = ImageProcessor.resize(src, { targetSize: 4, mode: 'bilinear' })
    const center = out.rgba[(1 * 4 + 1) * 4]
    expect(center).toBeGreaterThan(0)
    expect(center).toBeLessThan(200)
  })

  it('非正方形图按宽度缩放并保持宽高比', () => {
    const src = image(64, 32, () => [1, 2, 3, 255] as [number, number, number, number])
    const out = ImageProcessor.resize(src, { targetSize: 16, mode: 'nearest' })
    expect(out.width).toBe(16)
    expect(out.height).toBe(8)
  })

  it('resize 的 quantizeColors / sharpen 选项生效', () => {
    const src = image(8, 8, (x, y) => [x * 30, y * 30, (x * y) % 255, 255] as [number, number, number, number])
    const quantized = ImageProcessor.resize(src, { targetSize: 8, mode: 'nearest', quantizeColors: 4 })
    expect(uniqueOpaqueColors(quantized)).toBeLessThanOrEqual(4)
    const sharpened = ImageProcessor.resize(src, { targetSize: 8, mode: 'nearest', sharpen: true })
    expect(sharpened.width).toBe(8)
    expect(sharpened.rgba.length).toBe(src.rgba.length)
  })
})

describe('ImageProcessor：量化（中位切分 + 抖动）', () => {
  it('把 8 色压到 4 色', () => {
    const src = image(8, 1, (x) => [x * 30, 255 - x * 30, x * 15, 255] as [number, number, number, number])
    expect(uniqueOpaqueColors(src)).toBe(8)
    const out = ImageProcessor.quantize(src, 4)
    expect(uniqueOpaqueColors(out)).toBeLessThanOrEqual(4)
    expect(out.width).toBe(8)
  })

  it('色数不超过上限时保持原样', () => {
    const src = image(4, 1, (x) => [x * 10, 0, 0, 255] as [number, number, number, number])
    const out = ImageProcessor.quantize(src, 16)
    expect(out.rgba.equals(src.rgba)).toBe(true)
  })

  it('Floyd–Steinberg 抖动不改变尺寸且仍受色数约束', () => {
    const src = image(16, 16, (x, y) => [(x * 16) % 256, (y * 16) % 256, 128, 255] as [number, number, number, number])
    const out = ImageProcessor.quantize(src, 3, { dither: true })
    expect(out.width).toBe(16)
    expect(out.height).toBe(16)
    expect(uniqueOpaqueColors(out)).toBeLessThanOrEqual(3)
    // 透明像素保持透明
    const withHole = image(2, 1, (x) => (x === 0 ? [10, 10, 10, 0] : [200, 100, 50, 255]) as [number, number, number, number])
    const dithered = ImageProcessor.quantize(withHole, 1, { dither: true })
    expect(dithered.rgba[3]).toBe(0)
  })

  it('maxColors 非法时抛错', () => {
    expect(() => ImageProcessor.quantize(image(1, 1, () => [0, 0, 0, 255]), 0)).toThrow()
  })
})

describe('ImageProcessor：去背与 mipmap / 布局建议', () => {
  it('只去掉与边界连通的背景，图案内部白色保留', () => {
    // 5x5 全白，中间 3x3 红色（第 3 行 3 列是白色，被红色完全包围）
    const src = image(5, 5, (x, y) => {
      const inRed = x >= 1 && x <= 3 && y >= 1 && y <= 3
      if (inRed && !(x === 2 && y === 2)) return [255, 0, 0, 255]
      return [255, 255, 255, 255]
    })
    const out = ImageProcessor.removeBackground(src)
    const alphaAt = (x: number, y: number): number => out.rgba[(y * 5 + x) * 4 + 3]
    expect(alphaAt(0, 0)).toBe(0) // 外圈白 -> 透明
    expect(alphaAt(4, 4)).toBe(0)
    expect(alphaAt(1, 1)).toBe(255) // 红色保留
    expect(alphaAt(2, 2)).toBe(255) // 被包围的白色保留
    let transparent = 0
    for (let i = 3; i < out.rgba.length; i += 4) if (out.rgba[i] === 0) transparent++
    expect(transparent).toBe(16)
  })

  it('sampleCorners=false 时按纯白/纯黑判定', () => {
    const src = image(3, 3, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]) as [number, number, number, number])
    const out = ImageProcessor.removeBackground(src, { sampleCorners: false })
    // 棋盘格全部是白/黑 -> 全部透明
    for (let i = 3; i < out.rgba.length; i += 4) expect(out.rgba[i]).toBe(0)
  })

  it('generateMipmaps 生成指定尺寸的可解码 PNG', async () => {
    const src = image(16, 16, (x, y) => [x * 8, y * 8, 128, 255] as [number, number, number, number])
    const mips = ImageProcessor.generateMipmaps(src, [32, 16])
    expect(mips.map((m) => m.size)).toEqual([16, 32])
    for (const mip of mips) {
      const decoded = await ImageProcessor.decodePng(mip.png)
      expect(decoded.width).toBe(mip.size)
      expect(decoded.height).toBe(mip.size)
    }
  })

  it('suggestMcLayout 给出尺寸用途建议', () => {
    expect(ImageProcessor.suggestMcLayout({ width: 16, height: 16 }).kind).toBe('item')
    expect(ImageProcessor.suggestMcLayout({ width: 256, height: 256 }).kind).toBe('gui')
    const animated = ImageProcessor.suggestMcLayout({ width: 16, height: 64 })
    expect(animated.note).toContain('动画')
    expect(ImageProcessor.suggestMcLayout({ width: 0, height: 5 }).kind).toBe('unknown')
  })
})

/* ------------------------------------------------------------------ *
 *  provider 请求体与响应解析
 * ------------------------------------------------------------------ */

describe('providers：请求体 / 地址构造', () => {
  const request: ImageGenRequest = { prompt: 'a wooden sword', width: 512, height: 512, count: 2, seed: 42 }

  it('openai：/v1/images/generations + b64_json', () => {
    const body = buildOpenAiStyleBody(OPENAI_SETTINGS, request)
    expect(body.model).toBe('dall-e-3')
    expect(body.n).toBe(2)
    expect(body.size).toBe('512x512')
    expect(body.response_format).toBe('b64_json')
    expect(String(body.prompt)).toContain('a wooden sword')
    expect(buildEndpoint('openai', OPENAI_SETTINGS)).toBe('https://fake.local/v1/images/generations')
    // baseUrl 已带 /v1 时不重复拼接
    expect(buildEndpoint('openai', { ...OPENAI_SETTINGS, baseUrl: 'https://x.local/v1/' })).toBe('https://x.local/v1/images/generations')
  })

  it('自定义 baseUrl 缺省时回退官方默认地址', () => {
    expect(buildEndpoint('openai', { ...OPENAI_SETTINGS, baseUrl: '' })).toBe('https://api.openai.com/v1/images/generations')
    expect(buildEndpoint('sd-webui', { ...OPENAI_SETTINGS, baseUrl: '' })).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')
  })

  it('openai 兼容形态把负向提示词折叠进 prompt', () => {
    const body = buildOpenAiStyleBody(OPENAI_SETTINGS, { ...request, negativePrompt: 'blurry, text' })
    expect(String(body.prompt)).toContain('Avoid the following: blurry, text')
  })

  it('zhipu：CogView 形态（model/prompt/size）', () => {
    const settings: ImageProviderSettings = { ...OPENAI_SETTINGS, kind: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4' }
    const body = buildZhipuBody(settings, { prompt: 'a lantern', width: 1024, height: 1024 })
    expect(body).toEqual({ model: 'cogview-4', prompt: 'a lantern', size: '1024x1024' })
    expect(buildEndpoint('zhipu', settings)).toBe('https://open.bigmodel.cn/api/paas/v4/images/generations')
  })

  it('siliconflow：image_size / batch_size / negative_prompt', () => {
    const settings: ImageProviderSettings = { ...OPENAI_SETTINGS, kind: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: '' }
    const body = buildSiliconFlowBody(settings, { prompt: 'a tree', count: 3, negativePrompt: 'blurry', seed: 7 })
    expect(body.model).toBe('Kwai-Kolors/Kolors')
    expect(body.image_size).toBe('1024x1024')
    expect(body.batch_size).toBe(3)
    expect(body.negative_prompt).toBe('blurry')
    expect(body.seed).toBe(7)
    expect(buildEndpoint('siliconflow', settings)).toBe('https://api.siliconflow.cn/v1/images/generations')
  })

  it('sd-webui：txt2img 形态（width/height/steps/cfg_scale）', () => {
    const settings: ImageProviderSettings = { ...OPENAI_SETTINGS, kind: 'sd-webui', baseUrl: 'http://127.0.0.1:7860', apiKey: '' }
    const body = buildSdWebUiBody(settings, { prompt: 'castle', negativePrompt: 'blurry' }, { steps: 28, cfgScale: 6.5 })
    expect(body.width).toBe(512)
    expect(body.height).toBe(512)
    expect(body.steps).toBe(28)
    expect(body.cfg_scale).toBe(6.5)
    expect(body.negative_prompt).toBe('blurry')
    expect(buildEndpoint('sd-webui', settings)).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')
  })

  it('buildImageRequestBody 按 kind 分派', () => {
    expect(buildImageRequestBody('openai', OPENAI_SETTINGS, { prompt: 'x' })).toHaveProperty('response_format')
    expect(buildImageRequestBody('zhipu', { ...OPENAI_SETTINGS, kind: 'zhipu' }, { prompt: 'x' })).not.toHaveProperty('response_format')
    expect(buildImageRequestBody('siliconflow', { ...OPENAI_SETTINGS, kind: 'siliconflow' }, { prompt: 'x' })).toHaveProperty('image_size')
    expect(buildImageRequestBody('sd-webui', { ...OPENAI_SETTINGS, kind: 'sd-webui' }, { prompt: 'x' })).toHaveProperty('batch_size')
  })

  it('parseImageResponse 兼容 data/images 与 b64/url 四种形态', () => {
    expect(parseImageResponse({ data: [{ b64_json: 'AAA' }] })).toEqual([{ base64: 'AAA' }])
    expect(parseImageResponse({ data: [{ url: 'https://img/a.png' }] })).toEqual([{ url: 'https://img/a.png' }])
    expect(parseImageResponse({ images: [{ url: 'https://img/b.png' }] })).toEqual([{ url: 'https://img/b.png' }])
    expect(parseImageResponse({ images: ['BBB'] })).toEqual([{ base64: 'BBB' }])
    expect(parseImageResponse({ data: [{ b64_json: 'data:image/webp;base64,CCC' }] })).toEqual([{ base64: 'CCC' }])
    expect(parseImageResponse({})).toEqual([])
  })

  it('guessMimeType 按魔数判断', () => {
    expect(guessMimeType(SAMPLE_PNG)).toBe('image/png')
    expect(guessMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(guessMimeType(Buffer.from('RIFF____WEBP'))).toBe('image/webp')
  })

  it('listProviderKinds 列出 5 种 provider 且都有说明', () => {
    const kinds = listProviderKinds()
    expect(kinds.map((k) => k.kind).sort()).toEqual(['custom', 'openai', 'sd-webui', 'siliconflow', 'zhipu'])
    for (const kind of kinds) expect(kind.note.length).toBeGreaterThan(10)
  })

  it('custom：OpenAI 兼容形态 + 自定义 baseUrl', () => {
    const settings: ImageProviderSettings = { id: 'c', name: '本地 one-api', kind: 'custom', baseUrl: 'http://127.0.0.1:3000/v1', apiKey: '', model: 'sd-xl' }
    expect(buildEndpoint('custom', settings)).toBe('http://127.0.0.1:3000/v1/images/generations')
    const body = buildImageRequestBody('custom', settings, { prompt: 'a hut' })
    expect(body).toHaveProperty('response_format', 'b64_json')
    expect(body.model).toBe('sd-xl')
    // 自定义服务通常把 baseUrl 填到域名，版本段会被自动补上
    expect(buildEndpoint('custom', { ...settings, baseUrl: 'http://127.0.0.1:3000' })).toBe(
      'http://127.0.0.1:3000/v1/images/generations'
    )
    const provider = createProvider(settings)
    expect(provider?.configured(settings)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  provider 生成流程（假 fetch）
 * ------------------------------------------------------------------ */

describe('providers：configured 与 generate（假 fetch）', () => {
  it('configured：OpenAI 需要 apiKey，sd-webui 不需要', () => {
    const openai = createProvider(OPENAI_SETTINGS)!
    expect(openai.configured(OPENAI_SETTINGS)).toBe(true)
    expect(openai.configured({ ...OPENAI_SETTINGS, apiKey: '' })).toBe(false)
    expect(openai.name).toBe('假 OpenAI')
    expect(openai.models).toContain('dall-e-3')

    const sd: ImageProviderSettings = { id: 'sd', name: '本地 SD', kind: 'sd-webui', baseUrl: 'http://127.0.0.1:7860', apiKey: '', model: '' }
    const sdProvider = createProvider(sd)!
    expect(sdProvider.configured(sd)).toBe(true)
  })

  it('未知 kind 返回 null', () => {
    expect(createProvider({ ...OPENAI_SETTINGS, kind: 'midjourney' })).toBeNull()
  })

  it('openai 生成：请求地址/请求体正确，b64 响应被解码', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { data: [{ b64_json: SAMPLE_PNG.toString('base64') }] } }))
    const provider = createProvider(OPENAI_SETTINGS, { fetchImpl })!
    const result = await provider.generate(OPENAI_SETTINGS, { prompt: 'a cat', width: 384, height: 384, count: 1 })
    expect(result.provider).toBe('p1')
    expect(result.images).toHaveLength(1)
    expect(result.images[0].mimeType).toBe('image/png')
    expect(result.images[0].data.equals(SAMPLE_PNG)).toBe(true)
    expect(calls[0].url).toBe('https://fake.local/v1/images/generations')
    expect(calls[0].body.size).toBe('384x384')
    expect(calls[0].body.response_format).toBe('b64_json')
  })

  it('zhipu 生成：url 响应通过 HttpClient 下载', async () => {
    const settings: ImageProviderSettings = { id: 'z', name: '智谱', kind: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k', model: 'cogview-3-flash' }
    const { fetchImpl, calls } = makeFetch(() => ({ body: { data: [{ url: 'https://img.local/a.png' }] } }))
    const fakeHttp = { getBuffer: async () => SAMPLE_PNG } as unknown as HttpClient
    const provider = createProvider(settings, { fetchImpl, httpClient: fakeHttp })!
    const result = await provider.generate(settings, { prompt: 'a lantern' })
    expect(result.images[0].data.equals(SAMPLE_PNG)).toBe(true)
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/images/generations')
    expect(calls[0].body).toEqual({ model: 'cogview-3-flash', prompt: 'a lantern', size: '1024x1024' })
  })

  it('sd-webui 生成：images 数组里的裸 base64', async () => {
    const settings: ImageProviderSettings = { id: 'sd', name: '本地 SD', kind: 'sd-webui', baseUrl: 'http://127.0.0.1:7860', apiKey: '', model: '' }
    const { fetchImpl, calls } = makeFetch(() => ({ body: { images: [SAMPLE_PNG.toString('base64')] } }))
    const provider = createProvider(settings, { fetchImpl })!
    const result = await provider.generate(settings, { prompt: 'castle' })
    expect(result.images).toHaveLength(1)
    expect(result.images[0].data.equals(SAMPLE_PNG)).toBe(true)
    expect(calls[0].url).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')
    expect(calls[0].body.width).toBe(512)
  })

  it('HTTP 失败：抛出带状态码与响应片段的可读错误', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 401, body: { error: { message: 'invalid api key' } } }))
    const provider = createProvider(OPENAI_SETTINGS, { fetchImpl })!
    await expect(provider.generate(OPENAI_SETTINGS, { prompt: 'x' })).rejects.toThrow(/HTTP 401/)
    await expect(provider.generate(OPENAI_SETTINGS, { prompt: 'x' })).rejects.toThrow(/invalid api key/)
  })

  it('未配置时直接抛错，不发起请求', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: {} }))
    const provider = createProvider(OPENAI_SETTINGS, { fetchImpl })!
    await expect(provider.generate({ ...OPENAI_SETTINGS, apiKey: '' }, { prompt: 'x' })).rejects.toThrow(/未配置完整/)
    expect(calls).toHaveLength(0)
  })

  it('响应里没有图片数据时抛错', async () => {
    const { fetchImpl } = makeFetch(() => ({ body: { data: [] } }))
    const provider = createProvider(OPENAI_SETTINGS, { fetchImpl })!
    await expect(provider.generate(OPENAI_SETTINGS, { prompt: 'x' })).rejects.toThrow(/没有图片数据/)
  })
})

/* ------------------------------------------------------------------ *
 *  MediaService
 * ------------------------------------------------------------------ */

describe('MediaService：preset 与提示词', () => {
  const service = new MediaService({
    client: {} as HttpClient,
    settings: { providers: [] },
    outputRoot: join(workDir, 'out')
  })

  it('presets 覆盖 6 种预设且提示词有实际内容', () => {
    const presets = service.presets()
    expect(presets.map((p) => p.id).sort()).toEqual(['concept-art', 'logo', 'mc-block', 'mc-gui', 'mc-item', 'raw'].sort())
    const item = presets.find((p) => p.id === 'mc-item')!
    expect(item.promptPrefix).toContain('Minecraft item icon')
    expect(item.promptPrefix).toContain('16x16')
    expect(item.promptPrefix).toContain('no anti-aliasing')
    expect(item.pixelSize).toBe(16)
    expect(item.quantizeColors).toBe(24)
    expect(item.note).toContain('blurry')
    expect(presets.find((p) => p.id === 'mc-block')?.promptPrefix).toContain('seamless')
    expect(presets.find((p) => p.id === 'raw')?.promptPrefix).toBe('')
  })

  it('composePrompt 拼接正/负向提示词', () => {
    const item = service.presets().find((p) => p.id === 'mc-item')!
    const composed = composePrompt(item, 'a wooden sword', 'ugly', 'blurry, text')
    expect(composed.prompt.startsWith('Minecraft item icon')).toBe(true)
    expect(composed.prompt).toContain('a wooden sword')
    expect(composed.negativePrompt).toBe('blurry, text, ugly')
    const raw = service.presets().find((p) => p.id === 'raw')!
    expect(composePrompt(raw, 'plain prompt').prompt).toBe('plain prompt')
  })

  it('去背策略按 preset 区分（物品/logo 去背，方块/GUI 不去）', () => {
    expect(presetRemovesBackground('mc-item')).toBe(true)
    expect(presetRemovesBackground('logo')).toBe(true)
    expect(presetRemovesBackground('mc-block')).toBe(false)
    expect(presetRemovesBackground('mc-gui')).toBe(false)
  })

  it('listProviders 标出未配置的 provider', () => {
    const mixed = new MediaService({
      client: {} as HttpClient,
      settings: {
        activeProviderId: 'b',
        providers: [
          { ...OPENAI_SETTINGS, id: 'a', apiKey: '' },
          { id: 'b', name: '本地 SD', kind: 'sd-webui', baseUrl: 'http://127.0.0.1:7860', apiKey: '', model: '' },
          { id: 'c', name: '未知', kind: 'midjourney', baseUrl: '', apiKey: '', model: '' }
        ]
      },
      outputRoot: join(workDir, 'out2')
    })
    const listed = mixed.listProviders()
    expect(listed.find((p) => p.id === 'a')?.configured).toBe(false)
    expect(listed.find((p) => p.id === 'b')?.configured).toBe(true)
    expect(listed.find((p) => p.id === 'c')?.configured).toBe(false)
  })

  it('没有可用 provider 时抛可读错误', async () => {
    const empty = new MediaService({ client: {} as HttpClient, settings: { providers: [] }, outputRoot: workDir })
    await expect(empty.generate({ prompt: 'x' })).rejects.toThrow(/没有配置任何生图服务/)
  })
})

describe('MediaService：生成与像素化落盘', () => {
  /** 生成一张「白底 + 居中红色方块」的测试原图，模拟生图模型输出 */
  function sourceImage(): Buffer {
    const img = image(64, 64, (x, y) => {
      const inSquare = x >= 16 && x < 48 && y >= 16 && y < 48
      return (inSquare ? [200, 40, 40, 255] : [255, 255, 255, 255]) as [number, number, number, number]
    })
    return ImageProcessor.encodePngSync(img)
  }

  it('preset=mc-item：自动去背 + 16x16 + 量化 + mipmap 命名', async () => {
    const source = sourceImage()
    const { fetchImpl } = makeFetch(() => ({ body: { data: [{ b64_json: source.toString('base64') }] } }))
    const outputDir = join(workDir, 'gen-item')
    const service = new MediaService({
      client: {} as HttpClient,
      settings: { activeProviderId: 'p1', providers: [OPENAI_SETTINGS] },
      outputRoot: join(workDir, 'media-root'),
      deps: { fetchImpl }
    })

    const result = await service.generate({
      prompt: 'a wooden sword with a blue gem',
      preset: 'mc-item',
      outputDir,
      width: 1024,
      height: 1024,
      count: 1
    })

    expect(result.provider).toBe('p1')
    expect(result.warnings).toEqual([])
    expect(result.files).toHaveLength(4) // 16 + 32 + 64 + 128
    expect(result.files[0].endsWith('_16.png')).toBe(true)
    expect(result.files.some((f) => f.endsWith('_128.png'))).toBe(true)

    const decoded = await ImageProcessor.decodePng(readFileSync(result.files[0]))
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
    // 去背生效：四角透明；量化生效：色数不超过 preset 上限
    expect(decoded.rgba[3]).toBe(0)
    expect(uniqueOpaqueColors(decoded)).toBeLessThanOrEqual(24)

    // 文件命名包含 prompt 前 30 字
    expect(result.files[0]).toContain('a wooden sword with a blue ge')
  })

  it('preset=raw 且无 pixelSize：只落原图', async () => {
    const source = sourceImage()
    const { fetchImpl } = makeFetch(() => ({ body: { data: [{ b64_json: source.toString('base64') }] } }))
    const outputDir = join(workDir, 'gen-raw')
    const service = new MediaService({
      client: {} as HttpClient,
      settings: { providers: [OPENAI_SETTINGS] },
      outputRoot: join(workDir, 'media-root'),
      deps: { fetchImpl }
    })
    const result = await service.generate({ prompt: 'concept art', preset: 'raw', outputDir })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].endsWith('.png')).toBe(true)
    const decoded = await ImageProcessor.decodePng(readFileSync(result.files[0]))
    expect(decoded.width).toBe(64)
  })

  it('后处理失败 + keepOriginalOnError：保留原图并给出 warning', async () => {
    const notAnImage = Buffer.from('this is definitely not a png')
    const { fetchImpl } = makeFetch(() => ({ body: { data: [{ b64_json: notAnImage.toString('base64') }] } }))
    const outputDir = join(workDir, 'gen-fallback')
    const service = new MediaService({
      client: {} as HttpClient,
      settings: { providers: [OPENAI_SETTINGS] },
      outputRoot: join(workDir, 'media-root'),
      deps: { fetchImpl }
    })
    const result = await service.generate({
      prompt: 'broken image',
      preset: 'mc-item',
      outputDir,
      keepOriginalOnError: true
    })
    expect(result.warnings.join('\n')).toContain('保留原图')
    expect(result.files).toHaveLength(1)
    expect(result.files[0].endsWith('_original.png')).toBe(true)
  })

  it('后处理失败且不保留原图：抛出可读错误', async () => {
    const notAnImage = Buffer.from('not a png')
    const { fetchImpl } = makeFetch(() => ({ body: { data: [{ b64_json: notAnImage.toString('base64') }] } }))
    const service = new MediaService({
      client: {} as HttpClient,
      settings: { providers: [OPENAI_SETTINGS] },
      outputRoot: join(workDir, 'media-root'),
      deps: { fetchImpl }
    })
    await expect(
      service.generate({ prompt: 'broken', preset: 'mc-item', outputDir: join(workDir, 'gen-fail') })
    ).rejects.toThrow(/后处理失败/)
  })

  it('pixelate：对已有图片做 MC 化处理（8x8 + 4 色 + 去背 + mipmap）', async () => {
    const inputDir = join(workDir, 'pixelate')
    mkdirSync(inputDir, { recursive: true })
    const inputPath = join(inputDir, 'input.png')
    writeFileSync(inputPath, sourceImage())

    const service = new MediaService({ client: {} as HttpClient, settings: { providers: [] }, outputRoot: workDir })
    const result = await service.pixelate({
      inputPath,
      pixelSize: 8,
      quantizeColors: 4,
      removeBackground: true,
      mipmaps: [16]
    })

    expect(result.files).toHaveLength(2)
    const main = await ImageProcessor.decodePng(readFileSync(result.files[0]))
    expect(main.width).toBe(8)
    expect(main.height).toBe(8)
    expect(main.rgba[3]).toBe(0) // 去背
    expect(uniqueOpaqueColors(main)).toBeLessThanOrEqual(4)
    const mip = await ImageProcessor.decodePng(readFileSync(result.files[1]))
    expect(mip.width).toBe(16)
    expect(result.files[0].endsWith('input_pixel_8.png')).toBe(true)
  })

  it('pixelate 的 pixelSize 非法时抛错', async () => {
    const service = new MediaService({ client: {} as HttpClient, settings: { providers: [] }, outputRoot: workDir })
    await expect(service.pixelate({ inputPath: join(workDir, 'nope.png'), pixelSize: 0 })).rejects.toThrow(/pixelSize/)
  })
})
