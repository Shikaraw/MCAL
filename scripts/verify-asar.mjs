/**
 * 校验 asar 内容：确认打包产物里真的带上了 out/ 与 resources/。
 * 用法：node scripts/verify-asar.mjs release/win-unpacked/resources/app.asar
 */

import { existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const file = process.argv[2] ?? 'release/win-unpacked/resources/app.asar'
const fd = openSync(file, 'r')
const fileSize = statSync(file).size
const chunk = Buffer.alloc(Math.min(fileSize, 4 * 1024 * 1024))
const read = readSync(fd, chunk, 0, chunk.length, 0)
const text = chunk.subarray(0, read).toString('utf8')

// asar 头部是一个 V8 pickle，里面装着文件表 JSON。直接定位到 JSON 起始并用括号配对截出完整对象。
const start = text.indexOf('{"files":')
if (start < 0) throw new Error('未找到 asar 文件表')

let depth = 0
let inString = false
let escaped = false
let end = -1
for (let i = start; i < text.length; i++) {
  const ch = text[i]
  if (inString) {
    if (escaped) escaped = false
    else if (ch === '\\') escaped = true
    else if (ch === '"') inString = false
    continue
  }
  if (ch === '"') inString = true
  else if (ch === '{') depth++
  else if (ch === '}') {
    depth--
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
if (end < 0) throw new Error('asar 文件表未闭合（可能超出了读取窗口）')

const table = JSON.parse(text.slice(start, end))
const files = []
const walk = (node, prefix) => {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (value.files) walk(value, path)
    else files.push({ path, size: value.size ?? 0 })
  }
}
walk(table, '')

console.log(`asar: ${file}`)
console.log(`打包文件总数：${files.length}\n`)

console.log('按目录统计：')
const groups = new Map()
for (const entry of files) {
  const key = entry.path.split('/').slice(0, 3).join('/')
  groups.set(key, (groups.get(key) ?? 0) + 1)
}
for (const [key, count] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${key.padEnd(32)}${count}`)
}

const required = [
  '/out/main/index.js',
  '/out/preload/index.mjs',
  '/out/renderer/index.html',
  '/resources/skills/diagnose-crash/SKILL.md',
  '/package.json'
]
console.log('\n关键文件：')
let missing = 0
for (const path of required) {
  const hit = files.find((entry) => entry.path === path)
  if (!hit) missing++
  console.log(`  ${hit ? '✓' : '✗'} ${path}${hit ? `  ${(hit.size / 1024).toFixed(1)} KB` : '  —— 缺失'}`)
}

// 图标不在 asar 里：electron-builder 通过 extraResources 放到 resourcesPath（与 app.asar 同级）
const iconPath = file.replace(/[\\/]app\.asar$/, '/icon.png')
const iconOk = existsSync(iconPath)
if (!iconOk) missing++
console.log(`  ${iconOk ? '✓' : '✗'} ${iconPath}（extraResources，位于 asar 外）`)

const knowledge = files.filter((entry) => /^\/resources\/knowledge\/.*\.md$/.test(entry.path)).length
const templates = files.filter((entry) => /^\/resources\/templates\//.test(entry.path)).length
const skills = files.filter((entry) => /^\/resources\/skills\/.*SKILL\.md$/.test(entry.path)).length
console.log(`\n知识库文章：${knowledge} 篇`)
console.log(`技能手册：  ${skills} 份`)
console.log(`模板文件：  ${templates} 个`)

// 渲染进程产物里应包含打包后的 CSS 与 JS
const rendererAssets = files.filter((entry) => /^\/out\/renderer\/assets\//.test(entry.path))
console.log(`渲染产物：  ${rendererAssets.length} 个（${rendererAssets.map((entry) => entry.path.split('/').pop()).join(', ')}）`)

// 逐文件比对模板：确认没有因为打包规则被漏掉
const localTemplatesDir = resolve('resources/templates')
if (existsSync(localTemplatesDir)) {
  const local = []
  const walkLocal = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walkLocal(join(dir, entry.name), rel)
      else local.push(rel)
    }
  }
  walkLocal(localTemplatesDir, '')
  const packaged = new Set(
    files.filter((entry) => entry.path.startsWith('/resources/templates/')).map((entry) => entry.path.replace('/resources/templates/', ''))
  )
  const dropped = local.filter((rel) => !packaged.has(rel))
  console.log(`模板比对：  本地 ${local.length} 个 / 打包 ${packaged.size} 个`)
  if (dropped.length > 0) {
    missing += dropped.length
    console.log(`  ✗ 未被打包：${dropped.join(', ')}`)
  } else {
    console.log('  ✓ 全部打包')
  }
}

if (missing > 0) {
  console.error(`\n✗ 有 ${missing} 个关键文件缺失`)
  process.exit(1)
}
console.log('\n✓ asar 内容完整')
