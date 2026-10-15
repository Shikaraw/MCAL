/** 通用工具函数：哈希、字节格式化、重试、平台判定等。 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { platform, arch } from 'node:os'
import type { ArchName, OsName } from '@shared/types'

export function sha1Of(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex')
}

export function sha256Of(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha1OfFile(path: string): Promise<string> {
  return hashOfFile(path, 'sha1')
}

export function sha256OfFile(path: string): Promise<string> {
  return hashOfFile(path, 'sha256')
}

export function hashOfFile(path: string, algo: 'sha1' | 'sha256' | 'md5'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo)
    const stream = createReadStream(path, { highWaterMark: 1024 * 512 })
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function formatBytes(bytes: number, fractionDigits = 2): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : fractionDigits)} ${units[i]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond, 1)}/s`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m < 60) return `${m} 分 ${s} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RetryOptions {
  retries: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, error: Error) => void
  /** 返回 false 时放弃重试 */
  shouldRetry?: (error: Error) => boolean
}

/** 指数退避重试，默认 3 次。 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500
  const maxDelay = opts.maxDelayMs ?? 10_000
  let lastError: Error = new Error('unknown')
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (opts.signal?.aborted) throw lastError
      if (attempt > opts.retries) break
      if (opts.shouldRetry && !opts.shouldRetry(lastError)) break
      opts.onRetry?.(attempt, lastError)
      const delay = Math.min(maxDelay, base * Math.pow(2, attempt - 1)) + Math.random() * 250
      await sleep(delay, opts.signal)
    }
  }
  throw lastError
}

export function currentOs(): OsName {
  const p = platform()
  if (p === 'win32') return 'windows'
  if (p === 'darwin') return 'osx'
  return 'linux'
}

export function currentArch(): ArchName {
  const a = arch()
  if (a === 'x64') return 'x64'
  if (a === 'arm64') return 'arm64'
  if (a === 'ia32') return 'x86'
  return 'arm32'
}

/** Mojang 规则中的 os.name 取值 */
export function mojangOsName(): string {
  return currentOs()
}

/** 将 Java 的 `1.8.0_392` / `17.0.9` 形式归一为主版本号 */
export function parseJavaMajor(versionString: string): number {
  const clean = versionString.trim().replace(/^java version\s+/i, '').replace(/^"|"$/g, '')
  if (!clean) return 0
  if (clean.startsWith('1.')) {
    const second = Number.parseInt(clean.split('.')[1] ?? '0', 10)
    return Number.isFinite(second) ? second : 0
  }
  const first = Number.parseInt(clean.split(/[.\-+_]/)[0] ?? '0', 10)
  return Number.isFinite(first) ? first : 0
}

/** 比较点分版本号：a>b 返回正数 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_+]/).map((x) => (/^\d+$/.test(x) ? Number.parseInt(x, 10) : Number.NaN))
  const pb = b.split(/[.\-_+]/).map((x) => (/^\d+$/.test(x) ? Number.parseInt(x, 10) : Number.NaN))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i]
    const vb = pb[i]
    const na = Number.isNaN(va) ? 0 : (va ?? 0)
    const nb = Number.isNaN(vb) ? 0 : (vb ?? 0)
    if (na !== nb) return na - nb
  }
  return 0
}

/**
 * 解析 Maven 坐标 `group:artifact:version[:classifier][@ext]`
 * 例如 `net.fabricmc:sponge-mixin:0.12.5+mixin.0.8.5` 或
 * `org.lwjgl:lwjgl:3.3.1:natives-windows`
 */
export interface MavenCoordinate {
  group: string
  artifact: string
  version: string
  classifier?: string
  extension: string
}

export function parseMavenName(name: string): MavenCoordinate | null {
  if (!name) return null
  let extension = 'jar'
  let core = name
  const atIndex = name.indexOf('@')
  if (atIndex > 0) {
    extension = name.slice(atIndex + 1)
    core = name.slice(0, atIndex)
  }
  const parts = core.split(':')
  if (parts.length < 3) return null
  return {
    group: parts[0],
    artifact: parts[1],
    version: parts[2],
    classifier: parts[3],
    extension
  }
}

export function mavenToPath(coord: MavenCoordinate): string {
  const groupPath = coord.group.replace(/\./g, '/')
  const classified = coord.classifier ? `${coord.artifact}-${coord.version}-${coord.classifier}` : `${coord.artifact}-${coord.version}`
  return `${groupPath}/${coord.artifact}/${coord.version}/${classified}.${coord.extension}`
}

export function mavenBaseName(coord: MavenCoordinate): string {
  const classified = coord.classifier ? `${coord.artifact}-${coord.version}-${coord.classifier}` : `${coord.artifact}-${coord.version}`
  return `${classified}.${coord.extension}`
}

/** 文件锁：避免同一目标被并发下载 */
export class KeyedLock {
  private queues = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.queues.set(
      key,
      next.catch(() => undefined)
    )
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key)
    })
    return next
  }
}

/** 有限并发执行器（不引入 p-limit 依赖） */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length || 1))
  const runners: Promise<void>[] = []
  for (let i = 0; i < size; i++) {
    runners.push(
      (async () => {
        for (;;) {
          if (signal?.aborted) throw new Error('aborted')
          const index = cursor++
          if (index >= items.length) return
          results[index] = await worker(items[index], index)
        }
      })()
    )
  }
  await Promise.all(runners)
  return results
}

/** 读取文件头部若干字节（用于魔数嗅探） */
export async function readHead(path: string, length = 32): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const info = await stat(path)
    const size = Math.min(length, info.size)
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, 0)
    return buffer
  } finally {
    await handle.close()
  }
}

export function isProbablyText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  let suspicious = 0
  for (const byte of buffer) {
    if (byte === 0) return false
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++
  }
  return suspicious / buffer.length < 0.1
}

/** 简易语义化版本解析：返回 {major, minor, patch, pre} */
export function parseSemver(v: string): { major: number; minor: number; patch: number; pre?: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(v.trim())
  if (!match) return { major: 0, minor: 0, patch: 0, pre: v }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    pre: match[4]
  }
}

/** 判断某 MC 版本是否属于「新版本（1.13+ 扁平化之后）」 */
export function isModernVersion(gameVersion: string): boolean {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(gameVersion)
  if (!m) return false
  const minor = Number.parseInt(m[1], 10)
  return minor >= 13
}

export function normalizePathForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 用于日志与提示的游戏版本号清洗（去掉快照前缀等） */
export function cleanGameVersion(v: string): string {
  return v.trim().replace(/^Minecraft\s+/i, '')
}

/** 从任意字符串中提取 MC 版本候选（例如 mod 文件名里的 1.20.1） */
export function extractGameVersions(text: string): string[] {
  const found = new Set<string>()
  const re = /(?:^|[^0-9a-zA-Z.])(1\.(?:[7-9]|1\d|2\d)(?:\.\d{1,2})?)(?![0-9])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) found.add(m[1])
  return [...found]
}
