/**
 * 生成应用图标（resources/icon.png）。
 *
 * 不依赖任何图形库：手写 PNG 编码（zlib deflate + CRC32），
 * 用超采样的等腰立方体拼出「MC 方块 + 智能体」的视觉。
 *
 *   node scripts/gen-icon.mjs [输出路径] [尺寸]
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = resolve(process.argv[2] ?? resolve(root, 'resources/icon.png'))
const SIZE = Number(process.argv[3] ?? 512)
const SS = 4 // 每像素 4x4 超采样

/* --------------------------------- 颜色 --------------------------------- */

const hex = (value) => [
  Number.parseInt(value.slice(1, 3), 16),
  Number.parseInt(value.slice(3, 5), 16),
  Number.parseInt(value.slice(5, 7), 16)
]

const BG_TOP = hex('#101722')
const BG_BOTTOM = hex('#080b11')
const GLOW = hex('#22c55e')

/** 立方体三个面的配色：顶面最亮，右侧次之，左侧最暗。 */
const FACE_TOP = [hex('#4ade80'), hex('#16a34a')]
const FACE_RIGHT = [hex('#22c55e'), hex('#0f7c46')]
const FACE_LEFT = [hex('#15803d'), hex('#0a4f2c')]

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/* ------------------------------ 几何：多边形 ------------------------------ */

/** 射线法判断点是否在多边形内。 */
function inPolygon(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 圆角矩形的有符号距离场（<0 在内部）。 */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius)
  const dy = Math.abs(py - cy) - (halfH - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius
}

/* ------------------------------ PNG 编码 ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 把 RGBA 像素缓冲编码为 PNG。 */
function encodePng(rgba, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* -------------------------------- 绘制 -------------------------------- */

/** 采样一个点的颜色，返回 [r,g,b,a]（a 为 0~255 的覆盖率）。 */
function sample(x, y) {
  const u = x / SIZE
  const v = y / SIZE
  const cx = SIZE / 2
  const cy = SIZE / 2

  // 1. 底板：圆角矩形 + 垂直渐变
  const sdf = roundedRectSdf(x, y, cx, cy, SIZE * 0.44, SIZE * 0.44, SIZE * 0.22)
  if (sdf > 0) return [0, 0, 0, 0]
  let color = mix(BG_TOP, BG_BOTTOM, clamp01(v * 1.08 - 0.02))

  // 2. 背光：中心偏上的绿色辉光
  const glowDist = Math.hypot(x - cx, y - cy * 0.95) / (SIZE * 0.5)
  const glow = Math.pow(clamp01(1 - glowDist), 2.6) * 0.5
  color = mix(color, GLOW, glow)

  // 3. 立方体：等腰六边形切出三个面
  const halfW = SIZE * 0.275
  const halfH = SIZE * 0.16
  const bodyH = SIZE * 0.175
  const A = [cx, cy - bodyH - halfH]
  const B = [cx + halfW, cy - bodyH]
  const C = [cx + halfW, cy + halfH]
  const D = [cx, cy + bodyH + halfH]
  const E = [cx - halfW, cy + halfH]
  const F = [cx - halfW, cy - bodyH]
  const G = [cx, cy]

  const faces = [
    { poly: [A, B, G, F], ramp: FACE_TOP, shade: 0 },
    { poly: [B, C, D, G], ramp: FACE_RIGHT, shade: 1 },
    { poly: [F, G, D, E], ramp: FACE_LEFT, shade: 2 }
  ]

  for (const face of faces) {
    if (!inPolygon(x, y, face.poly)) continue
    // 用纵向位置做渐变，让每个面有方向感
    const localV = clamp01((y - (cy - bodyH - halfH)) / ((bodyH + halfH) * 2))
    let faceColor = mix(face.ramp[0], face.ramp[1], localV * 0.85 + 0.05)
    // 顶面加一道高光，模拟光照
    if (face.shade === 0) {
      const sheen = clamp01(1 - Math.abs(x - cx) / (halfW * 1.5)) * clamp01(1 - (y - (cy - bodyH)) / (halfH * 1.2))
      faceColor = mix(faceColor, [255, 255, 255], sheen * 0.28)
    }
    color = faceColor
    break
  }

  // 4. 立方体棱线：靠近任意一条棱就压暗，形成描边
  const edges = [
    [A, B], [B, C], [C, D], [D, E], [E, F], [F, A], [G, B], [G, D], [G, F]
  ]
  let edgeDist = Infinity
  for (const [p, q] of edges) {
    const vx = q[0] - p[0]
    const vy = q[1] - p[1]
    const t = clamp01(((x - p[0]) * vx + (y - p[1]) * vy) / (vx * vx + vy * vy))
    edgeDist = Math.min(edgeDist, Math.hypot(x - (p[0] + vx * t), y - (p[1] + vy * t)))
  }
  const stroke = 1 - clamp01(edgeDist / (SIZE * 0.004))
  if (stroke > 0 && inPolygon(x, y, [A, B, C, D, E, F])) {
    color = mix(color, [6, 20, 14], stroke * 0.85)
  }

  // 5. 底板边缘抗锯齿（SDF 过渡带）
  const alpha = clamp01(-sdf / (SIZE * 0.0045)) * 255
  return [color[0], color[1], color[2], alpha]
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4)
  const step = 1 / SS
  const offset = step / 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(x + offset + sx * step, y + offset + sy * step)
          const w = sa / 255
          r += sr * w
          g += sg * w
          b += sb * w
          a += sa
        }
      }
      const total = SS * SS
      const alpha = a / total
      const weight = alpha > 0 ? a / 255 : 1
      const index = (y * SIZE + x) * 4
      rgba[index] = Math.round(r / weight)
      rgba[index + 1] = Math.round(g / weight)
      rgba[index + 2] = Math.round(b / weight)
      rgba[index + 3] = Math.round(alpha)
    }
  }
  return rgba
}

const pixels = render()
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, encodePng(pixels, SIZE, SIZE))
console.log(`图标已生成：${outPath} (${SIZE}x${SIZE})`)
