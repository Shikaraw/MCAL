/** 文件系统辅助：原子写、安全路径、文本解码、目录扫描。 */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import iconv from 'iconv-lite'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** 原子写入：先写临时文件再 rename，避免中断导致半个文件。 */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, data)
  try {
    await rename(tmp, path)
  } catch (err) {
    // 目标被别的进程占用时 Windows 的 rename 会直接失败：清掉临时文件再抛错，别在用户目录里留垃圾
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(stripBom(text)) as T
  } catch (err) {
    if (fallback !== undefined) return fallback
    throw err
  }
}

export async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  return readJson<T>(path, fallback)
}

export async function writeJson(path: string, data: unknown, pretty = true): Promise<void> {
  await writeFileAtomic(path, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data))
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 解码可能包含中文的文本。
 * 中文 Windows 下的 Minecraft 日志 / 启动器输出经常是 GBK 编码，
 * 因此先尝试 UTF-8，出现替换字符或非法字节时回退 GB18030。
 */
export function decodeText(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.length === 0) return { text: '', encoding: 'utf8' }
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  }
  // UTF-16 BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: iconv.decode(buffer, 'utf16be'), encoding: 'utf16be' }
  }

  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) {
    // 进一步确认：utf8 解码后重新编码应还原
    const roundTrip = Buffer.from(utf8, 'utf8')
    if (roundTrip.length === buffer.length) return { text: utf8, encoding: 'utf8' }
  }

  // 回退 GB18030（GBK 超集，覆盖简繁与生僻字）
  const gbk = iconv.decode(buffer, 'gb18030')
  if (!gbk.includes('\uFFFD')) return { text: gbk, encoding: 'gb18030' }
  return { text: utf8, encoding: 'utf8-lossy' }
}

export async function readTextSmart(path: string, maxBytes = 64 * 1024 * 1024): Promise<{ text: string; encoding: string }> {
  const size = await fileSize(path)
  if (size <= maxBytes) {
    return decodeText(await readFile(path))
  }
  // 超大文件只读取尾部（日志场景）
  const handle = await open(path, 'r')
  try {
    const length = maxBytes
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return decodeText(buffer)
  } finally {
    await handle.close()
  }
}

export interface WalkOptions {
  maxDepth?: number
  filter?: (name: string, fullPath: string, depth: number) => boolean
  followSymlinks?: boolean
  limit?: number
}

/** 递归遍历目录，返回文件相对路径列表（相对 root）。 */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 12
  const out: string[] = []
  const limit = options.limit ?? 200_000

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= limit) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = join(dir, entry.name)
      if (options.filter && !options.filter(entry.name, full, depth)) continue
      if (entry.isDirectory()) {
        await visit(full, depth + 1)
      } else if (entry.isFile() || (options.followSymlinks && entry.isSymbolicLink())) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }

  await visit(root, 0)
  return out
}

export async function dirSize(root: string, limit = 500_000): Promise<number> {
  let total = 0
  let count = 0
  async function visit(dir: string): Promise<void> {
    if (count > limit) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
      } else if (entry.isFile()) {
        count++
        try {
          total += (await stat(full)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  await visit(root)
  return total
}

/**
 * 校验路径是否位于允许的根目录内，防止 Agent 越权写入。
 * 返回解析后的绝对路径，越界时抛错。
 */
export function assertInsideRoots(target: string, roots: string[]): string {
  const abs = resolve(target)
  const normalizedAbs = normalize(abs).toLowerCase()
  for (const root of roots) {
    const rootAbs = normalize(resolve(root)).toLowerCase()
    if (normalizedAbs === rootAbs) return abs
    const withSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
    if (normalizedAbs.startsWith(withSep)) return abs
  }
  throw new Error(`路径超出允许范围：${target}`)
}

export function isInsideRoots(target: string, roots: string[]): boolean {
  try {
    assertInsideRoots(target, roots)
    return true
  } catch {
    return false
  }
}

/** 生成短 id */
export function shortId(prefix = ''): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function sha1Short(input: string, length = 10): string {
  return createHash('sha1').update(input).digest('hex').slice(0, length)
}

/** 安全的文件名（去掉 Windows 非法字符） */
export function sanitizeFileName(name: string, replacement = '_'): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, replacement)
    .replace(/[. ]+$/, '')
    .slice(0, 180)
}

export async function copyDir(src: string, dest: string, filter?: (relPath: string) => boolean): Promise<void> {
  const files = await walkFiles(src)
  for (const rel of files) {
    if (filter && !filter(rel)) continue
    const from = join(src, rel)
    const to = join(dest, rel)
    await ensureDir(dirname(to))
    await copyFile(from, to)
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** 轮转日志：保留最近 N 个文件 */
export async function rotateFile(path: string, keep = 5): Promise<void> {
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${path}.${i}`
    const to = `${path}.${i + 1}`
    if (await pathExists(from)) {
      await rm(to, { force: true })
      await rename(from, to).catch(() => undefined)
    }
  }
  if (await pathExists(path)) {
    await rename(path, `${path}.1`).catch(() => undefined)
  }
}

/** 流式读取最后 N 行，避免读取整个大日志 */
export async function readTailLines(path: string, lineCount: number, maxBytes = 8 * 1024 * 1024): Promise<string> {
  const info = await stat(path)
  const start = Math.max(0, info.size - maxBytes)
  const handle = await open(path, 'r')
  try {
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const { text } = decodeText(buffer)
    const lines = text.split(/\r?\n/)
    if (start > 0) lines.shift()
    return lines.slice(-lineCount).join('\n')
  } finally {
    await handle.close()
  }
}

export function toPosix(p: string): string {
  return p.split(sep).join('/')
}

export { readFile, writeFile, readdir, stat, createReadStream }
