/**
 * 文件系统工具集。
 * 所有路径都经过 ctx.roots 沙箱校验；写入类工具默认需要用户确认。
 * 访问级别为 full 时沙箱放开（越界操作已由 registry 在调用前要求用户授权）。
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolInvocationContext } from '@shared/types'
import {
  ensureDir,
  pathExists,
  readTextSmart,
  removePath,
  walkFiles,
  writeFileAtomic,
  fileSize,
  isDirectory,
  isFile
} from '@core/util/fsx'
import { formatBytes } from '@core/util/misc'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  summarizeArgs,
  type ToolDefinitionWithHandler,
  type ToolResult
} from './registry'

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_CHARS = 60_000

function resolveInRoots(ctx: ToolInvocationContext, target: string): string {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(ctx.roots[0] ?? process.cwd(), target)
  assertInside(absolute, ctx)
  return absolute
}

function assertInside(absolute: string, ctx: ToolInvocationContext): void {
  // 完全访问：不再限制路径，越界写操作在 registry 层已经请求过授权
  if (ctx.accessMode === 'full') return
  const normalized = absolute.replace(/\\/g, '/').toLowerCase()
  for (const root of ctx.roots) {
    const rootNorm = resolve(root).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    if (normalized === rootNorm || normalized.startsWith(`${rootNorm}/`)) return
  }
  throw new Error(
    `路径不在允许范围内：${absolute}\n允许的根目录：\n${ctx.roots.map((r) => `  - ${r}`).join('\n')}\n` +
      '当前访问级别为「仅工作区」，如需访问其它位置请在「设置 → AI 模型 → 访问权限」中改为「完全访问」。'
  )
}

function clampOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（输出被截断，共 ${text.length} 字符，已显示前 ${max} 字符）`
}

/** 行号前缀，便于模型引用具体行 */
function withLineNumbers(text: string, startLine = 1, maxLines = 2000): string {
  const lines = text.split('\n')
  if (lines.length > maxLines) {
    const shown = lines.slice(0, maxLines)
    return `${shown.map((line, i) => `${startLine + i}\t${line}`).join('\n')}\n…（共 ${lines.length} 行，已显示前 ${maxLines} 行）`
  }
  return lines.map((line, i) => `${startLine + i}\t${line}`).join('\n')
}

export const readFileTool: ToolDefinitionWithHandler = {
  name: 'read_file',
  description:
    '读取文本文件内容，返回带行号的文本。适合读取配置、日志、源码、json（如 crash-reports、logs/latest.log、mods.toml）。对大文件可指定 offset/limit 分页读取。二进制文件会返回提示而不是乱码。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径或相对于工作目录）' },
      offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
      limit: { type: 'number', description: '读取行数，默认 2000' },
      maxBytes: { type: 'number', description: '最大读取字节数，默认 1MB' }
    },
    required: ['path']
  },
  category: 'filesystem',
  readOnly: true,
  requiresPaths: true,
  handler: async (args, ctx) => {
    const target = resolveInRoots(ctx, requireString(args, 'path'))
    if (!(await pathExists(target))) {
      return { ok: false, output: `文件不存在：${target}` }
    }
    if (await isDirectory(target)) {
      return { ok: false, output: `${target} 是目录，请用 list_dir 查看目录内容。` }
    }
    const size = await fileSize(target)
    const maxBytes = Math.min(optionalNumber(args, 'maxBytes', MAX_READ_BYTES) ?? MAX_READ_BYTES, MAX_READ_BYTES)
    const { text, encoding } = await readTextSmart(target, maxBytes)
    if (text.includes('\u0000')) {
      return {
        ok: true,
        output: `${target} 看起来是二进制文件（${formatBytes(size)}）。如需查看内容请说明你想了解什么，我可以用其他工具分析。`
      }
    }
    const offset = Math.max(1, optionalNumber(args, 'offset', 1) ?? 1)
    const limit = Math.max(1, optionalNumber(args, 'limit', 2000) ?? 2000)
    const lines = text.split('\n')
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const header = `${target}（${formatBytes(size)}，共 ${lines.length} 行，编码 ${encoding}）`
    return {
      ok: true,
      output: clampOutput(`${header}\n${withLineNumbers(slice.join('\n'), offset)}`),
      files: [target],
      meta: { size, lines: lines.length, encoding }
    }
  }
}

export const writeFileTool: ToolDefinitionWithHandler = {
  name: 'write_file',
  description:
    '写入（覆盖）文本文件。用于创建新文件或整体替换文件内容。修改已有文件时优先用 edit_file 做精确替换，避免误删内容。会自动创建不存在的父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '完整的文件内容' },
      createBackup: { type: 'boolean', description: '覆盖已存在文件前是否备份为 .bak，默认 false' }
    },
    required: ['path', 'content']
  },
  category: 'filesystem',
  dangerous: false,
  requiresPaths: true,
  permissionFor: (args) => ({
    summary: `写入文件：${String(args.path ?? '')}`,
    detail: `将写入 ${String(args.content ?? '').length} 个字符`,
    risk: 'medium'
  }),
  handler: async (args, ctx) => {
    const target = resolveInRoots(ctx, requireString(args, 'path'))
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
    const existed = await pathExists(target)
    if (existed && optionalBoolean(args, 'createBackup')) {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(target, `${target}.bak`)
    }
    await ensureDir(dirname(target))
    await writeFileAtomic(target, content)
    const lines = content.split('\n').length
    return {
      ok: true,
      output: `${existed ? '已覆盖' : '已创建'} ${target}（${lines} 行，${formatBytes(Buffer.byteLength(content, 'utf8'))}）`,
      files: [target],
      meta: { created: !existed, lines }
    }
  }
}

export const editFileTool: ToolDefinitionWithHandler = {
  name: 'edit_file',
  description:
    '在文件里做精确的字符串替换。old_string 必须与文件内容完全一致（包含缩进），且默认只能匹配到一处。用于修改配置、修正一行代码等小改动。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要替换的原文（必须精确匹配，含缩进）' },
      new_string: { type: 'string', description: '替换后的内容' },
      replaceAll: { type: 'boolean', description: '是否替换全部匹配项，默认 false' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  category: 'filesystem',
  requiresPaths: true,
  permissionFor: (args) => ({
    summary: `编辑文件：${String(args.path ?? '')}`,
    detail: summarizeArgs({ old: args.old_string, new: args.new_string }, 300),
    risk: 'medium'
  }),
  handler: async (args, ctx) => {
    const target = resolveInRoots(ctx, requireString(args, 'path'))
    const oldString = requireString(args, 'old_string')
    const newString = typeof args.new_string === 'string' ? args.new_string : String(args.new_string ?? '')
    if (!(await pathExists(target))) return { ok: false, output: `文件不存在：${target}` }
    const { text } = await readTextSmart(target, MAX_READ_BYTES)
    const occurrences = text.split(oldString).length - 1
    if (occurrences === 0) {
      return {
        ok: false,
        output: `未找到要替换的内容。请先用 read_file 确认原文（注意缩进与换行必须完全一致）。`
      }
    }
    const replaceAll = optionalBoolean(args, 'replaceAll')
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        output: `原文在文件中出现 ${occurrences} 次，无法确定要改哪一处。请提供更长的上下文让匹配唯一，或设置 replaceAll=true。`
      }
    }
    const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString)
    await writeFileAtomic(target, updated)
    return {
      ok: true,
      output: `已修改 ${target}（替换 ${replaceAll ? occurrences : 1} 处）`,
      files: [target],
      meta: { occurrences }
    }
  }
}

export const listDirTool: ToolDefinitionWithHandler = {
  name: 'list_dir',
  description:
    '列出目录内容（文件与子目录，含大小与修改时间）。用于探索项目结构、查看 mods 目录、查看游戏目录。默认不递归。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认为工作目录' },
      recursive: { type: 'boolean', description: '是否递归列出，默认 false' },
      maxDepth: { type: 'number', description: '递归深度，默认 3' },
      limit: { type: 'number', description: '最多列出多少项，默认 200' }
    },
    required: []
  },
  category: 'filesystem',
  readOnly: true,
  requiresPaths: true,
  handler: async (args, ctx) => {
    const raw = optionalString(args, 'path') ?? ctx.roots[0] ?? '.'
    const target = resolveInRoots(ctx, raw || '.')
    if (!(await pathExists(target))) return { ok: false, output: `目录不存在：${target}` }
    if (!(await isDirectory(target))) return { ok: false, output: `${target} 不是目录，请用 read_file 读取。` }
    const recursive = optionalBoolean(args, 'recursive')
    const limit = optionalNumber(args, 'limit', 200) ?? 200

    if (!recursive) {
      const entries = await readdir(target, { withFileTypes: true })
      const rows: string[] = []
      for (const entry of entries.slice(0, limit)) {
        if (entry.isDirectory()) {
          rows.push(`[目录] ${entry.name}/`)
        } else {
          const info = await stat(join(target, entry.name)).catch(() => null)
          rows.push(`[文件] ${entry.name}  ${info ? formatBytes(info.size) : '?'}  ${info ? info.mtime.toISOString().slice(0, 16).replace('T', ' ') : ''}`)
        }
      }
      return {
        ok: true,
        output: `${target}（${entries.length} 项${entries.length > limit ? `，已列出前 ${limit} 项` : ''}）\n${rows.join('\n')}`,
        files: [target],
        meta: { count: entries.length }
      }
    }

    const files = await walkFiles(target, { maxDepth: optionalNumber(args, 'maxDepth', 3) ?? 3, limit })
    return {
      ok: true,
      output: `${target}（递归，${files.length} 个文件）\n${files.map((f) => `- ${f}`).join('\n')}`,
      files: [target],
      meta: { count: files.length }
    }
  }
}

export const globTool: ToolDefinitionWithHandler = {
  name: 'glob',
  description:
    '按文件名模式查找文件，支持 * 与 ** 通配符。例如 "**/*.jar"、"logs/*.log"、"config/**/*.toml"。用于快速定位文件。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '通配符模式，如 **/*.jar' },
      path: { type: 'string', description: '搜索根目录，默认工作目录' },
      limit: { type: 'number', description: '最多返回多少条，默认 200' }
    },
    required: ['pattern']
  },
  category: 'search',
  readOnly: true,
  requiresPaths: true,
  handler: async (args, ctx) => {
    const pattern = requireString(args, 'pattern')
    const root = resolveInRoots(ctx, optionalString(args, 'path') ?? ctx.roots[0] ?? '.')
    const limit = optionalNumber(args, 'limit', 200) ?? 200
    const regex = globToRegex(pattern)
    const files = await walkFiles(root, { maxDepth: 20, limit: 200_000 })
    const matched = files.filter((file) => regex.test(file) || regex.test(basename(file))).slice(0, limit)
    if (matched.length === 0) {
      return { ok: true, output: `在 ${root} 下没有匹配 ${pattern} 的文件。` }
    }
    return {
      ok: true,
      output: `匹配 ${pattern} 的文件（${matched.length} 个${matched.length >= limit ? '，已截断' : ''}）：\n${matched.map((f) => `- ${join(root, f)}`).join('\n')}`,
      meta: { count: matched.length }
    }
  }
}

export const grepTool: ToolDefinitionWithHandler = {
  name: 'grep',
  description:
    '在文件内容中搜索文本或正则表达式，返回匹配行（带文件名与行号）。适合在日志里找报错、在配置里找某一项、在源码里找某个类。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的文本或正则表达式' },
      path: { type: 'string', description: '搜索目录或文件，默认工作目录' },
      include: { type: 'string', description: '文件名通配过滤，如 *.log 或 *.json' },
      ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 true' },
      isRegex: { type: 'boolean', description: 'pattern 是否为正则，默认 false（按普通文本搜索）' },
      contextLines: { type: 'number', description: '每处匹配前后各显示几行，默认 0' },
      maxResults: { type: 'number', description: '最多返回多少条匹配，默认 80' }
    },
    required: ['pattern']
  },
  category: 'search',
  readOnly: true,
  requiresPaths: true,
  handler: async (args, ctx) => {
    const pattern = requireString(args, 'pattern')
    const rawPath = optionalString(args, 'path') ?? ctx.roots[0] ?? '.'
    const root = resolveInRoots(ctx, rawPath)
    const ignoreCase = optionalBoolean(args, 'ignoreCase', true)
    const isRegex = optionalBoolean(args, 'isRegex')
    const contextLines = Math.max(0, optionalNumber(args, 'contextLines', 0) ?? 0)
    const maxResults = optionalNumber(args, 'maxResults', 80) ?? 80
    const include = optionalString(args, 'include')

    let regex: RegExp
    try {
      regex = isRegex ? new RegExp(pattern, ignoreCase ? 'gi' : 'g') : new RegExp(escapeRegex(pattern), ignoreCase ? 'gi' : 'g')
    } catch (err) {
      return { ok: false, output: `正则表达式无效：${err instanceof Error ? err.message : String(err)}` }
    }
    const includeRegex = include ? globToRegex(include) : null

    const targets: string[] = []
    if (await isFile(root)) {
      targets.push(root)
    } else {
      const files = await walkFiles(root, { maxDepth: 20, limit: 200_000 })
      for (const file of files) {
        if (includeRegex && !includeRegex.test(basename(file))) continue
        targets.push(join(root, file))
        if (targets.length >= 3000) break
      }
    }

    const results: { file: string; line: number; text: string }[] = []
    let scanned = 0
    for (const file of targets) {
      if (results.length >= maxResults) break
      const size = await fileSize(file)
      if (size > 8 * 1024 * 1024) continue // 跳过超大文件
      scanned++
      try {
        const { text } = await readTextSmart(file, 4 * 1024 * 1024)
        if (text.includes('\u0000')) continue
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0
          if (!regex.test(lines[i])) continue
          const start = Math.max(0, i - contextLines)
          const end = Math.min(lines.length - 1, i + contextLines)
          const snippet = lines
            .slice(start, end + 1)
            .map((line, offset) => `${start + offset + 1}: ${line.slice(0, 300)}`)
            .join('\n')
          results.push({ file, line: i + 1, text: snippet })
          if (results.length >= maxResults) break
        }
      } catch {
        /* 跳过无法读取的文件 */
      }
    }

    if (results.length === 0) {
      return { ok: true, output: `在 ${scanned} 个文件里没有找到「${pattern}」。` }
    }
    const grouped = new Map<string, { line: number; text: string }[]>()
    for (const result of results) {
      const list = grouped.get(result.file) ?? []
      list.push({ line: result.line, text: result.text })
      grouped.set(result.file, list)
    }
    const blocks = [...grouped.entries()].map(
      ([file, items]) => `${relative(root, file) || basename(file)}:\n${items.map((item) => `  ${item.text.split('\n').join('\n  ')}`).join('\n')}`
    )
    return {
      ok: true,
      output: clampOutput(`找到 ${results.length} 处匹配（扫描 ${scanned} 个文件）\n\n${blocks.join('\n\n')}`),
      meta: { count: results.length, scanned }
    }
  }
}

export const deletePathTool: ToolDefinitionWithHandler = {
  name: 'delete_path',
  description:
    '删除文件或目录（危险操作，需确认）。删除 mod/存档前建议先备份。批量删除大量文件时请先用 list_dir 确认。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件或目录路径' },
      recursive: { type: 'boolean', description: '删除目录时必须显式设为 true' }
    },
    required: ['path']
  },
  category: 'filesystem',
  dangerous: true,
  requiresPaths: true,
  permissionFor: (args) => ({
    summary: `删除：${String(args.path ?? '')}`,
    detail: args.recursive ? '将递归删除整个目录，无法撤销' : '将删除该文件，无法撤销',
    risk: 'high'
  }),
  handler: async (args, ctx) => {
    const target = resolveInRoots(ctx, requireString(args, 'path'))
    if (!(await pathExists(target))) return { ok: false, output: `路径不存在：${target}` }
    const dir = await isDirectory(target)
    if (dir && !optionalBoolean(args, 'recursive')) {
      return { ok: false, output: `${target} 是目录。删除目录需要显式传 recursive=true，请确认这是你要的。` }
    }
    const size = dir ? 0 : await fileSize(target)
    await removePath(target)
    return {
      ok: true,
      output: `已删除${dir ? '目录' : '文件'} ${target}${size > 0 ? `（${formatBytes(size)}）` : ''}`,
      files: [target]
    }
  }
}

/** 创建目录（供备份、脚手架等场景） */
export const makeDirTool: ToolDefinitionWithHandler = {
  name: 'make_dir',
  description: '创建目录（含多级父目录）。已存在时不报错。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '目录路径' } },
    required: ['path']
  },
  category: 'filesystem',
  requiresPaths: true,
  permissionFor: (args) => ({ summary: `创建目录：${String(args.path ?? '')}`, risk: 'low' }),
  handler: async (args, ctx) => {
    const target = resolveInRoots(ctx, requireString(args, 'path'))
    await ensureDir(target)
    return { ok: true, output: `已确保目录存在：${target}`, files: [target] }
  }
}

/* ----------------------------- 辅助函数 ----------------------------- */

export function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let out = ''
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        out += '.*'
        i++
        if (normalized[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('+.^$()|{}[]'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const filesystemTools: ToolDefinitionWithHandler[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  makeDirTool,
  deletePathTool
]

export type { ToolResult }
