/** 轻量日志模块：主进程与核心引擎共用，支持文件落盘与内存环缓冲。 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

interface LogEntry {
  ts: number
  level: LogLevel
  scope: string
  message: string
}

class Logger {
  private buffer: LogEntry[] = []
  private bufferLimit = 3000
  private filePath: string | null = null
  private minLevel: LogLevel = 'debug'
  private writeQueue: Promise<void> = Promise.resolve()
  private listeners = new Set<(e: LogEntry) => void>()

  setFilePath(path: string | null): void {
    this.filePath = path
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level
  }

  onLog(cb: (e: LogEntry) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  recent(limit = 300): LogEntry[] {
    return this.buffer.slice(-limit)
  }

  log(scope: string, level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    const entry: LogEntry = { ts: Date.now(), level, scope, message }
    this.buffer.push(entry)
    if (this.buffer.length > this.bufferLimit) this.buffer.splice(0, this.buffer.length - this.bufferLimit)

    const line = `[${new Date(entry.ts).toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)

    for (const cb of this.listeners) {
      try {
        cb(entry)
      } catch {
        /* 监听器异常不影响日志 */
      }
    }

    if (this.filePath) {
      const target = this.filePath
      this.writeQueue = this.writeQueue
        .then(async () => {
          await mkdir(dirname(target), { recursive: true })
          await appendFile(target, line + '\n', 'utf8')
        })
        .catch(() => {
          /* 落盘失败静默，避免日志系统自身抛出 */
        })
    }
  }

  debug(scope: string, message: string): void {
    this.log(scope, 'debug', message)
  }
  info(scope: string, message: string): void {
    this.log(scope, 'info', message)
  }
  warn(scope: string, message: string): void {
    this.log(scope, 'warn', message)
  }
  error(scope: string, message: string): void {
    this.log(scope, 'error', message)
  }

  /** 为某个 scope 生成绑定好的 logger，便于核心类内部使用 */
  scoped(scope: string) {
    return {
      debug: (m: string) => this.debug(scope, m),
      info: (m: string) => this.info(scope, m),
      warn: (m: string) => this.warn(scope, m),
      error: (m: string) => this.error(scope, m),
      scoped: (sub: string) => this.scoped(`${scope}:${sub}`)
    }
  }
}

export const logger = new Logger()
export type ScopedLogger = ReturnType<Logger['scoped']>
