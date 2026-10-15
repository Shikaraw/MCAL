/**
 * HTTP 客户端：统一超时、重试、UA 伪装、限速与进度回调。
 * 使用 Node 内置 fetch（Node 20+ / Electron 主进程可用）。
 */

import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withRetry } from '@core/util/misc'
import { logger } from '@core/util/logger'

const log = logger.scoped('http')

export const DEFAULT_USER_AGENT =
  'MCAL/0.1.0 (Minecraft Agent Launcher; +https://github.com/mcal) Node'

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array | null
  timeoutMs?: number
  signal?: AbortSignal
  retries?: number
  /** 期望返回 JSON 时自动解析 */
  expectJson?: boolean
  /** 允许非 2xx 状态（默认 false 会抛错） */
  allowError?: boolean
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodyText?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 全局限速器（令牌桶），0 表示不限速 */
export class RateLimiter {
  private limitBytesPerSec = 0
  private tokens = 0
  private lastRefill = Date.now()

  setLimit(kbPerSec: number): void {
    this.limitBytesPerSec = Math.max(0, kbPerSec) * 1024
    this.tokens = this.limitBytesPerSec
    this.lastRefill = Date.now()
  }

  get enabled(): boolean {
    return this.limitBytesPerSec > 0
  }

  /** 申请 chunkSize 字节的许可，不够时按需等待 */
  async acquire(chunkSize: number, signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return
    for (;;) {
      const now = Date.now()
      const elapsed = (now - this.lastRefill) / 1000
      this.lastRefill = now
      this.tokens = Math.min(this.limitBytesPerSec, this.tokens + elapsed * this.limitBytesPerSec)
      if (this.tokens >= chunkSize) {
        this.tokens -= chunkSize
        return
      }
      const need = chunkSize - this.tokens
      const waitMs = Math.max(10, Math.ceil((need / this.limitBytesPerSec) * 1000))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, Math.min(waitMs, 500))
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}

export const globalRateLimiter = new RateLimiter()

export class HttpClient {
  private retries: number
  private timeoutMs: number
  private userAgent: string
  readonly limiter = globalRateLimiter

  constructor(opts: { retries?: number; timeoutMs?: number; userAgent?: string } = {}) {
    this.retries = opts.retries ?? 3
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
  }

  configure(opts: { retries?: number; timeoutMs?: number }): void {
    if (opts.retries !== undefined) this.retries = opts.retries
    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs
  }

  buildInit(options: HttpOptions, method: string): RequestInit {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: '*/*',
      ...(options.headers ?? {})
    }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined && options.body !== null) {
      init.body = options.body as BodyInit
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
    }
    return init
  }

  /** 带超时的 fetch（超时与调用方 signal 取并集） */
  async raw(url: string, options: HttpOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET'
    const timeout = options.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`请求超时：${url}`)), timeout)
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(url, { ...this.buildInit(options, method), signal: controller.signal })
      if (!response.ok && !options.allowError) {
        let bodyText: string | undefined
        try {
          bodyText = (await response.text()).slice(0, 500)
        } catch {
          /* ignore */
        }
        throw new HttpError(`HTTP ${response.status} ${response.statusText} <- ${url}`, response.status, url, bodyText)
      }
      return response
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async request<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
    const expectJson = options.expectJson ?? true
    return withRetry(
      async () => {
        const response = await this.raw(url, options)
        const text = await response.text()
        if (!expectJson) return text as unknown as T
        try {
          return JSON.parse(text) as T
        } catch (err) {
          throw new Error(`响应不是合法 JSON（${url}）：${text.slice(0, 200)}`)
        }
      },
      {
        retries: options.retries ?? this.retries,
        signal: options.signal,
        onRetry: (attempt, error) => log.debug(`重试 ${attempt} 次 ${url}：${error.message}`),
        shouldRetry: (error) => {
          if (error instanceof HttpError) {
            // 4xx（除 408/429）不重试
            return error.status >= 500 || error.status === 408 || error.status === 429
          }
          return true
        }
      }
    )
  }

  getJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
    return this.request<T>(url, { ...options, expectJson: true })
  }

  getText(url: string, options: HttpOptions = {}): Promise<string> {
    return this.request<string>(url, { ...options, expectJson: false })
  }

  postJson<T>(url: string, body: unknown, options: HttpOptions = {}): Promise<T> {
    return this.request<T>(url, { ...options, method: 'POST', body: JSON.stringify(body), expectJson: true })
  }

  head(url: string, options: HttpOptions = {}): Promise<Response> {
    return this.raw(url, { ...options, method: 'HEAD', allowError: true })
  }

  /**
   * 下载文件到目标路径。
   * - 支持断点续传（存在 .part 文件且服务器支持 Range）
   * - 支持限速
   * - 先写 .part，完成后 rename，避免半成品被当成完整文件
   */
  async downloadToFile(
    url: string,
    dest: string,
    options: {
      signal?: AbortSignal
      onProgress?: (deltaBytes: number, received: number, total: number) => void
      resume?: boolean
      timeoutMs?: number
      retries?: number
      headers?: Record<string, string>
    } = {}
  ): Promise<{ bytes: number; resumed: boolean }> {
    const resume = options.resume ?? true
    const partPath = `${dest}.part`
    await mkdir(dirname(dest), { recursive: true })

    let startAt = 0
    if (resume) {
      try {
        startAt = (await stat(partPath)).size
      } catch {
        startAt = 0
      }
    } else {
      await rm(partPath, { force: true }).catch(() => undefined)
      startAt = 0
    }

    const doDownload = async (attempt: number): Promise<{ bytes: number; resumed: boolean }> => {
      const headers: Record<string, string> = { ...(options.headers ?? {}) }
      let effectiveStart = attempt === 1 ? startAt : 0
      if (effectiveStart > 0) headers['Range'] = `bytes=${effectiveStart}-`
      const response = await this.raw(url, {
        headers,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 60_000,
        allowError: true
      })

      if (response.status === 416 && effectiveStart > 0) {
        // 已下载完（服务端认为超出范围），直接进入校验阶段
        await rename(partPath, dest).catch(() => undefined)
        const info = await stat(dest).catch(() => ({ size: 0 }))
        return { bytes: Number(info.size), resumed: true }
      }
      if (!response.ok) {
        throw new HttpError(`下载失败 HTTP ${response.status} <- ${url}`, response.status, url)
      }

      let resumed = false
      if (effectiveStart > 0 && response.status === 206) {
        resumed = true
      } else if (effectiveStart > 0 && response.status === 200) {
        // 服务器不支持 Range，重新开始
        effectiveStart = 0
        await rm(partPath, { force: true }).catch(() => undefined)
      }

      const contentLength = Number(response.headers.get('content-length') ?? 0)
      const total = contentLength > 0 ? contentLength + effectiveStart : 0
      let received = effectiveStart

      if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer())
        await this.limiter.acquire(buffer.length, options.signal)
        const handle = await open(partPath, effectiveStart > 0 ? 'r+' : 'w')
        try {
          await handle.write(buffer, 0, buffer.length, effectiveStart)
        } finally {
          await handle.close()
        }
        received += buffer.length
        options.onProgress?.(buffer.length, received, total)
      } else {
        const handle = await open(partPath, effectiveStart > 0 ? 'r+' : 'w')
        const writeStream = createWriteStream(partPath, { fd: handle.fd, start: effectiveStart, autoClose: true })
        try {
          // Node 18+ 的 ReadableStream 支持异步迭代
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            const buf = Buffer.from(chunk)
            await this.limiter.acquire(buf.length, options.signal)
            received += buf.length
            options.onProgress?.(buf.length, received, total)
            if (!writeStream.write(buf)) {
              await new Promise<void>((resolve, reject) => {
                writeStream.once('drain', resolve)
                writeStream.once('error', reject)
              })
            }
          }
          await new Promise<void>((resolve, reject) => {
            writeStream.end(() => resolve())
            writeStream.once('error', reject)
          })
        } catch (err) {
          writeStream.destroy()
          throw err
        }
      }

      await rename(partPath, dest)
      return { bytes: received, resumed }
    }

    return withRetry(doDownload, {
      retries: options.retries ?? this.retries,
      signal: options.signal,
      baseDelayMs: 800,
      onRetry: (attempt, error) => log.debug(`下载重试 ${attempt}：${url} ${error.message}`)
    })
  }

  /** 下载二进制内容到内存（小文件场景，例如图标） */
  async getBuffer(url: string, options: HttpOptions = {}): Promise<Buffer> {
    return withRetry(
      async () => {
        const response = await this.raw(url, { ...options, allowError: false })
        return Buffer.from(await response.arrayBuffer())
      },
      { retries: options.retries ?? this.retries, signal: options.signal }
    )
  }
}

/** 默认单例：供不持有配置的模块使用 */
export const http = new HttpClient()

/** 带备用地址的下载：首个地址失败后依次尝试备用地址 */
export async function downloadWithFallback(
  client: HttpClient,
  urls: string[],
  dest: string,
  options: Parameters<HttpClient['downloadToFile']>[2] = {}
): Promise<{ bytes: number; url: string }> {
  const unique = [...new Set(urls.filter(Boolean))]
  let lastError: Error | null = null
  for (const url of unique) {
    try {
      const result = await client.downloadToFile(url, dest, options)
      return { bytes: result.bytes, url }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      log.debug(`地址失败 ${url}：${lastError.message}`)
      if (options.signal?.aborted) throw lastError
    }
  }
  throw lastError ?? new Error(`全部地址均失败：${dest}`)
}

export function tempPartPath(dest: string): string {
  return `${dest}.${randomUUID().slice(0, 6)}.part`
}
