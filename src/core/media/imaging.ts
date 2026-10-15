/**
 * 像素图后处理（MC 美术资源的关键工具）
 *
 * 全部自写，不引第三方依赖：
 *  - PNG 解码：支持 colorType 0/2/3/4/6、位深 1/2/4/8/16（16 位取高字节降到 8）、
 *    interlace 0；遇到 Adam7 隔行扫描明确抛错；支持 tRNS（调色板/灰度/真彩透明）；
 *  - PNG 编码：只输出 8 位 RGBA（colorType 6，可选 2），使用 filter 0(none)/1(sub)
 *    自适应（按「有符号字节绝对值之和」最小的行滤波，代价低、压缩率足够）；
 *  - 缩放：nearest（MC 像素画必需）/ box（平均，缩小时质量最好）/ bilinear；
 *  - 量化：中位切分（median cut）+ 可选 Floyd–Steinberg 抖动；
 *  - 去背：从四角/边缘做颜色一致的区域洪泛填充（只去掉与边缘连通的背景，
 *    不会误删图案内部的白色像素）。
 *
 * 所有函数都是纯计算，不读写磁盘；落盘由 media/service.ts 负责。
 */

import { deflateSync, inflateSync } from 'node:zlib'

export interface RgbaImage {
  width: number
  height: number
  /** RGBA8，长度 = width * height * 4 */
  rgba: Buffer
}

export interface ResizeOptions {
  targetSize: number
  /** 采样方式 */
  mode: 'nearest' | 'box' | 'bilinear'
  /** 是否做调色板量化（MC 风格限制色数） */
  quantizeColors?: number
  /** 是否锐化边缘 */
  sharpen?: boolean
}

export interface EncodeOptions {
  colorType?: 2 | 6
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/* ------------------------------------------------------------------ *
 *  CRC32（PNG chunk 校验）
 * ------------------------------------------------------------------ */

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/* ------------------------------------------------------------------ *
 *  PNG 解码
 * ------------------------------------------------------------------ */

interface PngHeader {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
}

/** 取某像素某通道的原始样本值（位深 < 8 时按位解包，16 位取高字节降到 8 位） */
function getSample(row: Buffer, sampleIndex: number, bitDepth: number): number {
  if (bitDepth === 8) return row[sampleIndex]
  if (bitDepth === 16) return row[sampleIndex * 2]
  const bitOffset = sampleIndex * bitDepth
  const byte = row[bitOffset >> 3]
  const shift = 8 - bitDepth - (bitOffset & 7)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

/** 反滤波（就地修改 row）：支持 filter 0~4 */
function unfilterRow(filterType: number, row: Buffer, prev: Buffer, bpp: number): void {
  const length = row.length
  switch (filterType) {
    case 0:
      break
    case 1:
      for (let i = bpp; i < length; i++) row[i] = (row[i] + row[i - bpp]) & 0xff
      break
    case 2:
      for (let i = 0; i < length; i++) row[i] = (row[i] + prev[i]) & 0xff
      break
    case 3:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0
        row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff
      }
      break
    case 4:
      for (let i = 0; i < length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        row[i] = (row[i] + pr) & 0xff
      }
      break
    default:
      throw new Error(`不支持的 PNG 行滤波类型：${filterType}`)
  }
}

/** 同步解码 PNG（内部实现；对外用 async 包装） */
function decodePngSync(data: Buffer): RgbaImage {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是合法的 PNG 文件（签名不匹配）')
  }

  let header: PngHeader | null = null
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idatParts: Buffer[] = []

  let offset = 8
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > data.length) throw new Error(`PNG 数据被截断（chunk ${type}）`)
    const chunkData = data.subarray(start, end)
    // 说明：这里不校验 CRC32（为解码性能考虑）；如需严格校验可加 crc32() 比对

    if (type === 'IHDR') {
      header = {
        width: chunkData.readUInt32BE(0),
        height: chunkData.readUInt32BE(4),
        bitDepth: chunkData[8],
        colorType: chunkData[9],
        interlace: chunkData[12]
      }
      if (chunkData[10] !== 0) throw new Error('不支持的 PNG 压缩方式（compression != 0）')
      if (chunkData[11] !== 0) throw new Error('不支持的 PNG 滤波方式（filter method != 0）')
    } else if (type === 'PLTE') {
      palette = Buffer.from(chunkData)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(chunkData)
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(chunkData))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }

  if (!header) throw new Error('PNG 缺少 IHDR')
  const { width, height, bitDepth, colorType, interlace } = header
  const channels = CHANNELS[colorType]
  if (!channels) throw new Error(`不支持的 PNG colorType：${colorType}`)
  if (interlace !== 0) {
    throw new Error('不支持 Adam7 隔行扫描（interlace = 1）的 PNG，请先用图像工具另存为非隔行 PNG')
  }
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`不支持的 PNG 位深：${bitDepth}`)
  if (bitDepth < 8 && colorType !== 0 && colorType !== 3) {
    throw new Error(`位深 ${bitDepth} 只支持灰度/调色板 PNG（colorType 0/3），当前为 ${colorType}`)
  }
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE 数据')

  const rowBytes = Math.ceil((width * channels * bitDepth) / 8)
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  const raw = inflateSync(Buffer.concat(idatParts))
  const expected = (rowBytes + 1) * height
  if (raw.length < expected) {
    throw new Error(`PNG IDAT 数据不足：期望 ${expected} 字节，实际 ${raw.length} 字节`)
  }

  // 逐行反滤波
  const unfiltered = Buffer.alloc(rowBytes * height)
  let prev = Buffer.alloc(rowBytes)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1)
    const filterType = raw[rowStart]
    const row = unfiltered.subarray(y * rowBytes, (y + 1) * rowBytes)
    raw.copy(row, 0, rowStart + 1, rowStart + 1 + rowBytes)
    unfilterRow(filterType, row, prev, bpp)
    prev = row
  }

  // 展开为 RGBA8
  const rgba = Buffer.alloc(width * height * 4)
  const maxValue = (1 << bitDepth) - 1
  for (let y = 0; y < height; y++) {
    const row = unfiltered.subarray(y * rowBytes, (y + 1) * rowBytes)
    for (let x = 0; x < width; x++) {
      const outIndex = (y * width + x) * 4
      const base = x * channels
      switch (colorType) {
        case 0: {
          const rawGray = getSample(row, base, bitDepth)
          const gray = bitDepth === 8 || bitDepth === 16 ? rawGray : Math.round((rawGray * 255) / maxValue)
          let alpha = 255
          // 灰度 tRNS：2 字节的大端值表示「透明灰阶」
          if (transparency && transparency.length >= 2) {
            const key = transparency.readUInt16BE(0)
            // 16 位图已降到 8 位，比较时同样取高字节
            if (rawGray === (bitDepth === 16 ? key >> 8 : key)) alpha = 0
          }
          rgba[outIndex] = gray
          rgba[outIndex + 1] = gray
          rgba[outIndex + 2] = gray
          rgba[outIndex + 3] = alpha
          break
        }
        case 2: {
          const r = getSample(row, base, bitDepth)
          const g = getSample(row, base + 1, bitDepth)
          const b = getSample(row, base + 2, bitDepth)
          rgba[outIndex] = r
          rgba[outIndex + 1] = g
          rgba[outIndex + 2] = b
          let alpha = 255
          if (transparency && transparency.length >= 6) {
            // 真彩 tRNS：三个 16 位大端值；与 8 位像素比较时取高字节
            const keyR = transparency.readUInt16BE(0) >> 8
            const keyG = transparency.readUInt16BE(2) >> 8
            const keyB = transparency.readUInt16BE(4) >> 8
            if (r === keyR && g === keyG && b === keyB) alpha = 0
          }
          rgba[outIndex + 3] = alpha
          break
        }
        case 3: {
          const index = getSample(row, base, bitDepth)
          const p = palette as Buffer
          const pIndex = index * 3
          rgba[outIndex] = p[pIndex] ?? 0
          rgba[outIndex + 1] = p[pIndex + 1] ?? 0
          rgba[outIndex + 2] = p[pIndex + 2] ?? 0
          rgba[outIndex + 3] = transparency && index < transparency.length ? transparency[index] : 255
          break
        }
        case 4: {
          const rawGray = getSample(row, base, bitDepth)
          const gray = bitDepth === 8 || bitDepth === 16 ? rawGray : Math.round((rawGray * 255) / maxValue)
          rgba[outIndex] = gray
          rgba[outIndex + 1] = gray
          rgba[outIndex + 2] = gray
          rgba[outIndex + 3] = getSample(row, base + 1, bitDepth)
          break
        }
        case 6:
        default: {
          rgba[outIndex] = getSample(row, base, bitDepth)
          rgba[outIndex + 1] = getSample(row, base + 1, bitDepth)
          rgba[outIndex + 2] = getSample(row, base + 2, bitDepth)
          rgba[outIndex + 3] = getSample(row, base + 3, bitDepth)
          break
        }
      }
    }
  }

  return { width, height, rgba }
}

/* ------------------------------------------------------------------ *
 *  PNG 编码
 * ------------------------------------------------------------------ */

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function filterRowBytes(
  row: Buffer,
  prev: Buffer,
  bpp: number,
  filterType: number,
  out: Buffer
): number {
  let score = 0
  const length = row.length
  for (let i = 0; i < length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0
    const up = prev[i]
    const upLeft = i >= bpp ? prev[i - bpp] : 0
    let value: number
    switch (filterType) {
      case 1:
        value = row[i] - left
        break
      case 2:
        value = row[i] - up
        break
      case 3:
        value = row[i] - ((left + up) >> 1)
        break
      case 4: {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        value = row[i] - pr
        break
      }
      default:
        value = row[i]
        break
    }
    const byte = value & 0xff
    out[i] = byte
    score += byte < 128 ? byte : 256 - byte
  }
  return score
}

/* ------------------------------------------------------------------ *
 *  缩放 / 量化 / 去背
 * ------------------------------------------------------------------ */

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0
}

interface ColorEntry {
  r: number
  g: number
  b: number
  count: number
}

interface ColorBox {
  colors: ColorEntry[]
}

/** 中位切分：把颜色集合递归切分成 maxColors 个盒子 */
function medianCut(colors: ColorEntry[], maxColors: number): ColorEntry[][] {
  let boxes: ColorBox[] = [{ colors }]
  while (boxes.length < maxColors) {
    // 选出「颜色数 > 1 且颜色范围最大」的盒子来切
    let targetIndex = -1
    let bestRange = 0
    let bestChannel: 'r' | 'g' | 'b' = 'r'
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.colors.length < 2) continue
      for (const channel of ['r', 'g', 'b'] as const) {
        let min = 255
        let max = 0
        for (const c of box.colors) {
          const v = c[channel]
          if (v < min) min = v
          if (v > max) max = v
        }
        const range = max - min
        if (range > bestRange) {
          bestRange = range
          targetIndex = i
          bestChannel = channel
        }
      }
    }
    if (targetIndex < 0 || bestRange === 0) break

    const box = boxes[targetIndex]
    const sorted = [...box.colors].sort((a, b) => a[bestChannel] - b[bestChannel])
    const total = sorted.reduce((sum, c) => sum + c.count, 0)
    let cumulative = 0
    let splitAt = 1
    for (let i = 0; i < sorted.length - 1; i++) {
      cumulative += sorted[i].count
      splitAt = i + 1
      if (cumulative >= total / 2) break
    }
    const left = sorted.slice(0, splitAt)
    const right = sorted.slice(splitAt)
    if (left.length === 0 || right.length === 0) break

    // 用切分后的两个盒子替换原盒子（新盒子优先被继续切分）
    boxes = [...boxes.slice(0, targetIndex), ...boxes.slice(targetIndex + 1), { colors: left }, { colors: right }]
  }
  return boxes.map((box) => box.colors)
}

function averageColor(colors: ColorEntry[]): { r: number; g: number; b: number } {
  let r = 0
  let g = 0
  let b = 0
  let total = 0
  for (const c of colors) {
    r += c.r * c.count
    g += c.g * c.count
    b += c.b * c.count
    total += c.count
  }
  if (total === 0) return { r: 0, g: 0, b: 0 }
  return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) }
}

function nearestPaletteIndex(palette: { r: number; g: number; b: number }[], r: number, g: number, b: number): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < palette.length; i++) {
    const dr = palette[i].r - r
    const dg = palette[i].g - g
    const db = palette[i].b - b
    // 加权欧氏距离（人眼对绿色更敏感）
    const distance = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/** 简单 unsharp 锐化（只作用于 RGB，不动 alpha） */
function sharpenImage(image: RgbaImage, amount = 0.6): RgbaImage {
  const { width, height, rgba } = image
  const out = Buffer.from(rgba)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      if (rgba[index + 3] === 0) continue
      for (let c = 0; c < 3; c++) {
        let sum = 0
        let count = 0
        if (x > 0) {
          sum += rgba[index - 4 + c]
          count++
        }
        if (x < width - 1) {
          sum += rgba[index + 4 + c]
          count++
        }
        if (y > 0) {
          sum += rgba[index - width * 4 + c]
          count++
        }
        if (y < height - 1) {
          sum += rgba[index + width * 4 + c]
          count++
        }
        if (count === 0) continue
        const average = sum / count
        out[index + c] = clamp255(rgba[index + c] + amount * (rgba[index + c] - average))
      }
    }
  }
  return { width, height, rgba: out }
}

export class ImageProcessor {
  /** 用纯 JS 解码/编码 PNG（自己写，不引依赖） */
  static async decodePng(data: Buffer): Promise<RgbaImage> {
    return decodePngSync(data)
  }

  static async encodePng(image: RgbaImage, opts: EncodeOptions = {}): Promise<Buffer> {
    return ImageProcessor.encodePngSync(image, opts)
  }

  /** 同步编码（service 内部需要，避免不必要的 await 链） */
  static encodePngSync(image: RgbaImage, opts: EncodeOptions = {}): Buffer {
    const colorType = opts.colorType ?? 6
    const channels = colorType === 2 ? 3 : 4
    // 不改动调用方的 Buffer：丢 alpha 时透明像素压成黑色，避免「透明却有色」的脏数据
    const source = colorType === 2 ? Buffer.from(image.rgba) : image.rgba
    if (colorType === 2) {
      for (let i = 3; i < source.length; i += 4) {
        if (source[i] === 0) {
          source[i - 3] = 0
          source[i - 2] = 0
          source[i - 1] = 0
        }
      }
    }
    const stride = image.width * channels
    const raw = Buffer.alloc((stride + 1) * image.height)
    const prevRow = Buffer.alloc(stride)
    const scratch = Buffer.alloc(stride)

    for (let y = 0; y < image.height; y++) {
      const row = Buffer.alloc(stride)
      for (let x = 0; x < image.width; x++) {
        const src = (y * image.width + x) * 4
        const dst = x * channels
        row[dst] = source[src]
        row[dst + 1] = source[src + 1]
        row[dst + 2] = source[src + 2]
        if (channels === 4) row[dst + 3] = source[src + 3]
      }

      // 自适应选择 none(0) / sub(1) 滤波：谁的有符号字节绝对值之和小就用谁。
      // （没有实现 up/average/paeth，换来更简单的代码；压缩率略低但完全合法）
      const scopeNone = filterRowBytes(row, prevRow, channels, 0, raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
      const subOut = scratch
      const scopeSub = filterRowBytes(row, prevRow, channels, 1, subOut)
      if (scopeSub < scopeNone) {
        raw[y * (stride + 1)] = 1
        subOut.copy(raw, y * (stride + 1) + 1)
      } else {
        raw[y * (stride + 1)] = 0
      }
      row.copy(prevRow)
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(image.width, 0)
    ihdr.writeUInt32BE(image.height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = colorType
    ihdr[10] = 0 // compression
    ihdr[11] = 0 // filter
    ihdr[12] = 0 // interlace

    const idat = deflateSync(raw, { level: 9 })
    return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
  }

  /**
   * 缩放：targetSize 作为目标宽度，高度按比例缩放（保持宽高比，最小 1）。
   * MC 像素画请用 nearest，避免出现抗锯齿产生的过渡色。
   */
  static resize(image: RgbaImage, opts: ResizeOptions): RgbaImage {
    const { width: srcW, height: srcH, rgba: src } = image
    if (srcW <= 0 || srcH <= 0) throw new Error('resize：源图尺寸非法')
    const targetW = Math.max(1, Math.round(opts.targetSize))
    const targetH = Math.max(1, Math.round((srcH * targetW) / srcW))
    const dst = Buffer.alloc(targetW * targetH * 4)

    const sampleAt = (x: number, y: number): [number, number, number, number] => {
      const sx = Math.min(srcW - 1, Math.max(0, x))
      const sy = Math.min(srcH - 1, Math.max(0, y))
      const i = (sy * srcW + sx) * 4
      return [src[i], src[i + 1], src[i + 2], src[i + 3]]
    }

    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const dstIndex = (y * targetW + x) * 4
        if (opts.mode === 'nearest') {
          // 取源像素中心，保证放大时边缘不丢
          const sx = Math.floor(((x + 0.5) * srcW) / targetW)
          const sy = Math.floor(((y + 0.5) * srcH) / targetH)
          const [r, g, b, a] = sampleAt(sx, sy)
          dst[dstIndex] = r
          dst[dstIndex + 1] = g
          dst[dstIndex + 2] = b
          dst[dstIndex + 3] = a
          continue
        }

        if (opts.mode === 'bilinear') {
          const fx = ((x + 0.5) * srcW) / targetW - 0.5
          const fy = ((y + 0.5) * srcH) / targetH - 0.5
          const x0 = Math.floor(fx)
          const y0 = Math.floor(fy)
          const tx = fx - x0
          const ty = fy - y0
          const p00 = sampleAt(x0, y0)
          const p10 = sampleAt(x0 + 1, y0)
          const p01 = sampleAt(x0, y0 + 1)
          const p11 = sampleAt(x0 + 1, y0 + 1)
          for (let c = 0; c < 4; c++) {
            const top = p00[c] * (1 - tx) + p10[c] * tx
            const bottom = p01[c] * (1 - tx) + p11[c] * tx
            dst[dstIndex + c] = clamp255(top * (1 - ty) + bottom * ty)
          }
          continue
        }

        // box：按源矩形面积加权平均（缩小时质量最好）
        const x0 = (x * srcW) / targetW
        const x1 = ((x + 1) * srcW) / targetW
        const y0 = (y * srcH) / targetH
        const y1 = ((y + 1) * srcH) / targetH
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        let weight = 0
        for (let sy = Math.floor(y0); sy < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); sy++) {
          if (sy < 0 || sy >= srcH) continue
          const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
          if (wy <= 0) continue
          for (let sx = Math.floor(x0); sx < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); sx++) {
            if (sx < 0 || sx >= srcW) continue
            const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
            if (wx <= 0) continue
            const w = wx * wy
            const i = (sy * srcW + sx) * 4
            r += src[i] * w
            g += src[i + 1] * w
            b += src[i + 2] * w
            a += src[i + 3] * w
            weight += w
          }
        }
        if (weight === 0) continue
        dst[dstIndex] = clamp255(r / weight)
        dst[dstIndex + 1] = clamp255(g / weight)
        dst[dstIndex + 2] = clamp255(b / weight)
        dst[dstIndex + 3] = clamp255(a / weight)
      }
    }

    let result: RgbaImage = { width: targetW, height: targetH, rgba: dst }
    if (opts.sharpen) result = sharpenImage(result)
    if (opts.quantizeColors && opts.quantizeColors > 0) {
      result = ImageProcessor.quantize(result, opts.quantizeColors)
    }
    return result
  }

  /**
   * 量化：中位切分（median cut），比朴素 k-means 快且效果可接受。
   * @param maxColors 允许的最大色数（不透明像素）
   * @param opts.dither 是否使用 Floyd–Steinberg 抖动
   */
  static quantize(
    image: RgbaImage,
    maxColors: number,
    opts: { dither?: boolean } = {}
  ): RgbaImage {
    if (maxColors < 1) throw new Error('quantize：maxColors 必须 >= 1')
    const { width, height, rgba } = image
    const counts = new Map<number, number>()
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 8) continue // 近透明像素不参与调色板统计
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (counts.size === 0) return { width, height, rgba: Buffer.from(rgba) }
    if (counts.size <= maxColors) return { width, height, rgba: Buffer.from(rgba) }

    const entries: ColorEntry[] = [...counts.entries()].map(([key, count]) => ({
      r: (key >> 16) & 0xff,
      g: (key >> 8) & 0xff,
      b: key & 0xff,
      count
    }))
    const palette = medianCut(entries, maxColors).map(averageColor)

    const out = Buffer.from(rgba)
    if (!opts.dither) {
      // 无抖动：按唯一颜色缓存映射，速度更快
      const cache = new Map<number, { r: number; g: number; b: number }>()
      for (let i = 0; i < out.length; i += 4) {
        if (rgba[i + 3] < 8) continue
        const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]
        let mapped = cache.get(key)
        if (!mapped) {
          mapped = palette[nearestPaletteIndex(palette, rgba[i], rgba[i + 1], rgba[i + 2])]
          cache.set(key, mapped)
        }
        out[i] = mapped.r
        out[i + 1] = mapped.g
        out[i + 2] = mapped.b
      }
      return { width, height, rgba: out }
    }

    // Floyd–Steinberg 抖动：误差向右侧/下侧四个邻居扩散
    const errorR = new Float32Array(width + 2)
    const errorG = new Float32Array(width + 2)
    const errorB = new Float32Array(width + 2)
    const nextR = new Float32Array(width + 2)
    const nextG = new Float32Array(width + 2)
    const nextB = new Float32Array(width + 2)
    for (let y = 0; y < height; y++) {
      nextR.fill(0)
      nextG.fill(0)
      nextB.fill(0)
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4
        if (rgba[index + 3] < 8) continue
        const dr = clamp255(rgba[index] + errorR[x + 1])
        const dg = clamp255(rgba[index + 1] + errorG[x + 1])
        const db = clamp255(rgba[index + 2] + errorB[x + 1])
        const paletteIndex = nearestPaletteIndex(palette, dr, dg, db)
        const chosen = palette[paletteIndex]
        out[index] = chosen.r
        out[index + 1] = chosen.g
        out[index + 2] = chosen.b

        const diffR = dr - chosen.r
        const diffG = dg - chosen.g
        const diffB = db - chosen.b
        errorR[x + 2] += diffR * (7 / 16)
        errorG[x + 2] += diffG * (7 / 16)
        errorB[x + 2] += diffB * (7 / 16)
        nextR[x] += diffR * (3 / 16)
        nextG[x] += diffG * (3 / 16)
        nextB[x] += diffB * (3 / 16)
        nextR[x + 1] += diffR * (5 / 16)
        nextG[x + 1] += diffG * (5 / 16)
        nextB[x + 1] += diffB * (5 / 16)
        nextR[x + 2] += diffR * (1 / 16)
        nextG[x + 2] += diffG * (1 / 16)
        nextB[x + 2] += diffB * (1 / 16)
      }
      errorR.set(nextR)
      errorG.set(nextG)
      errorB.set(nextB)
    }
    return { width, height, rgba: out }
  }

  /**
   * 去除近白/近黑背景为透明（生成物品图常用）。
   *
   * 实现为「从边框向内洪泛填充」：只去掉与边界连通的背景色，
   * 图案内部的白色高光不会被误删。
   *
   * @param opts.threshold 颜色匹配阈值（每个通道最大差值，0~255，默认 24）
   * @param opts.sampleCorners 从四角取色作为背景色（默认 true，适合纯色/渐变背景）；
   *        为 false 时使用纯白与纯黑作为背景色。
   */
  static removeBackground(
    image: RgbaImage,
    opts: { threshold?: number; sampleCorners?: boolean } = {}
  ): RgbaImage {
    const { width, height, rgba } = image
    const threshold = opts.threshold ?? 24
    const sampleCorners = opts.sampleCorners ?? true

    const candidates: { r: number; g: number; b: number }[] = []
    if (sampleCorners) {
      const corners = [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1]
      ]
      for (const [x, y] of corners) {
        const i = (y * width + x) * 4
        candidates.push({ r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] })
      }
      // 背景是渐变时四角取色也能覆盖大部分情况；再补上四边中点提高命中率
      const mids = [
        [Math.floor(width / 2), 0],
        [Math.floor(width / 2), height - 1],
        [0, Math.floor(height / 2)],
        [width - 1, Math.floor(height / 2)]
      ]
      for (const [x, y] of mids) {
        const i = (y * width + x) * 4
        candidates.push({ r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] })
      }
    } else {
      candidates.push({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })
    }

    const matches = (index: number): boolean => {
      if (rgba[index + 3] === 0) return true
      for (const candidate of candidates) {
        const dr = Math.abs(rgba[index] - candidate.r)
        const dg = Math.abs(rgba[index + 1] - candidate.g)
        const db = Math.abs(rgba[index + 2] - candidate.b)
        if (dr <= threshold && dg <= threshold && db <= threshold) return true
      }
      return false
    }

    const out = Buffer.from(rgba)
    const visited = new Uint8Array(width * height)
    const stack: number[] = []
    const push = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= width || y >= height) return
      const pixelIndex = y * width + x
      if (visited[pixelIndex]) return
      visited[pixelIndex] = 1
      if (!matches(pixelIndex * 4)) return
      stack.push(pixelIndex)
    }

    for (let x = 0; x < width; x++) {
      push(x, 0)
      push(x, height - 1)
    }
    for (let y = 0; y < height; y++) {
      push(0, y)
      push(width - 1, y)
    }

    while (stack.length > 0) {
      const pixelIndex = stack.pop() as number
      const index = pixelIndex * 4
      out[index + 3] = 0
      const x = pixelIndex % width
      const y = Math.floor(pixelIndex / width)
      push(x - 1, y)
      push(x + 1, y)
      push(x, y - 1)
      push(x, y + 1)
    }
    return { width, height, rgba: out }
  }

  /** 生成多种尺寸（16/32/64/128 等），全部用 nearest 采样保持像素感 */
  static generateMipmaps(image: RgbaImage, sizes: number[]): { size: number; png: Buffer }[] {
    const unique = [...new Set(sizes.filter((s) => Number.isFinite(s) && s > 0))].sort((a, b) => a - b)
    return unique.map((size) => {
      const scaled = ImageProcessor.resize(image, { targetSize: size, mode: 'nearest' })
      return { size, png: ImageProcessor.encodePngSync(scaled) }
    })
  }

  /** 生成 MC 风格物品/方块图标的分层切分提示（返回建议而不是真的切分） */
  static suggestMcLayout(opts: { width: number; height: number }): { kind: 'item' | 'block' | 'gui' | 'unknown'; note: string } {
    const { width, height } = opts
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { kind: 'unknown', note: '尺寸非法，无法判断用途。' }
    }
    if (height % width === 0 && height > width) {
      return {
        kind: 'item',
        note: `高度是宽度的 ${height / width} 倍，疑似动画贴图的竖向帧序列（MC 动画纹理按帧从上到下排列，帧数与 mcmeta 的 frametime 需与之一致）。`
      }
    }
    if (width === 256 && height === 256) {
      return {
        kind: 'gui',
        note: '256x256 通常是 GUI 容器贴图（箱子/熔炉界面），建议保持 256x256 并注意九宫格拉伸的边缘像素。'
      }
    }
    if (width === height && width <= 64) {
      return {
        kind: 'item',
        note: `${width}x${height} 是典型的物品图标尺寸；物品贴图建议居中、四周留 1px 透明边距，遮罩由模型（item/generated）决定。`
      }
    }
    if (width === height && width > 64 && width <= 512) {
      return {
        kind: 'block',
        note: `${width}x${height} 若是方块贴图属于 HD 材质：方块六个面会被平铺，注意接缝处的像素连续性。`
      }
    }
    return {
      kind: 'unknown',
      note: `尺寸 ${width}x${height} 不常见：确认是物品（16x16 起）、方块（16x16 平铺）、GUI（256x256）还是粒子/自定义模型贴图。`
    }
  }
}
