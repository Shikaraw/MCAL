/**
 * 游戏进程封装：启动 / 输出采集 / 停止。
 *
 * 实现要点与坑：
 *  - stdout 与 stderr 合并成同一路日志（Minecraft 的崩溃栈大多走 stderr，而正常日志走 stdout）；
 *  - 行切分支持 `\r\n`、裸 `\n`、裸 `\r`（Forge 安装器/进度条的覆盖式输出）；
 *  - 单行超过 8KB 时截断并追加「[已截断]」：某些 mod 会打印超长 Base64/JSON，
 *    不截断会吃光内存并拖垮 UI；
 *  - 行解码以「整行字节」为单位做 UTF-8/GB18030 自动判定，避免多字节字符被 chunk 边界切断；
 *  - Windows 停止进程用 `taskkill /PID <pid> /T`（/T 连子孙进程一起，Forge 会 fork），
 *    超时后加 /F 强杀；POSIX 用 SIGTERM → SIGKILL。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import type { GameLogLine } from '@shared/types'
import { decodeText } from '@core/util/fsx'
import { logger } from '@core/util/logger'
import { parseLogLine } from './logparse'

const log = logger.scoped('launch:process')

/** 单行上限（字节）：超过即截断 */
const MAX_LINE_BYTES = 8 * 1024
const TRUNCATION_SUFFIX = ' [已截断]'

export interface GameProcessEvents {
  onLog?(line: GameLogLine): void
  onRawOutput?(chunk: string): void
  onExit?(code: number | null, signal: string | null): void
  onError?(error: Error): void
}

export interface GameProcessOptions {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  events?: GameProcessEvents
  windowsHide?: boolean
  /** 原始输出的落盘路径（以 UTF-8 追加；GBK 转换已在行解码时完成） */
  logFile?: string
}

export interface ProcessDiagnostics {
  /** 出现过 FATAL 级别日志 */
  sawFatal: boolean
  /** 出现过 JVM 致命错误（hs_err 标志行） */
  sawFatalJvmCrash: boolean
  /** 出现过异常栈（java 栈帧或 Caused by） */
  sawStackTrace: boolean
}

export class GameProcess {
  readonly startedAt: number

  private readonly opts: GameProcessOptions
  private readonly events: GameProcessEvents
  private child: ChildProcess | null = null
  private stdoutBuffer: Buffer = Buffer.alloc(0)
  private stderrBuffer: Buffer = Buffer.alloc(0)
  private logStream: WriteStream | null = null
  private exited = false
  private exitCodeValue: number | null = null
  private exitSignalValue: string | null = null
  private stopRequested = false
  private diagnosticsValue: ProcessDiagnostics = { sawFatal: false, sawFatalJvmCrash: false, sawStackTrace: false }

  constructor(opts: GameProcessOptions) {
    this.opts = opts
    this.events = opts.events ?? {}
    this.startedAt = Date.now()
  }

  get pid(): number {
    return this.child?.pid ?? 0
  }

  get exitCode(): number | null {
    return this.exitCodeValue
  }

  /** 进程被信号终止时记录信号名（例如 SIGKILL），自然退出为 null */
  get exitSignal(): string | null {
    return this.exitSignalValue
  }

  get logFilePath(): string | undefined {
    return this.opts.logFile
  }

  /** 采集到的崩溃相关信号，供上层判定 crashed 状态 */
  get diagnostics(): ProcessDiagnostics {
    return { ...this.diagnosticsValue }
  }

  /** 是否由 stop() 主动请求退出（用于区分「正常关闭」与「崩溃」） */
  get wasStopRequested(): boolean {
    return this.stopRequested
  }

  isRunning(): boolean {
    return this.child !== null && !this.exited
  }

  start(): void {
    if (this.child) throw new Error('GameProcess 已启动，不能重复调用 start()')

    if (this.opts.logFile) {
      try {
        mkdirSync(dirname(this.opts.logFile), { recursive: true })
        const stream = createWriteStream(this.opts.logFile, { flags: 'a' })
        stream.on('error', (err) => {
          log.warn(`游戏日志写入失败：${err instanceof Error ? err.message : String(err)}`)
          this.logStream = null
        })
        this.logStream = stream
      } catch (err) {
        log.warn(`无法创建游戏日志文件：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    let child: ChildProcess
    try {
      child = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        windowsHide: this.opts.windowsHide ?? true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.events.onError?.(error)
      throw error
    }

    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.consume('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.consume('stderr', chunk))
    child.on('error', (err) => {
      // ENOENT 等启动失败：同时会触发 close，onExit 仍会被调用
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
    })
    child.on('close', (code, signal) => this.finalize(code, signal))
    log.info(`游戏进程已启动：pid=${child.pid} ${this.opts.command}`)
  }

  writeStdin(data: string): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return
    try {
      stdin.write(data)
    } catch (err) {
      log.debug(`写入 stdin 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 停止进程。默认先尝试优雅关闭（Windows: taskkill /T；POSIX: SIGTERM），
   * 超时后再强杀（/F 或 SIGKILL）。
   */
  async stop(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    this.stopRequested = true
    const timeoutMs = opts.timeoutMs ?? 8000

    const waitExit = (ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (this.exited) return resolve(true)
        let settled = false
        const onClose = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(true)
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.removeListener('close', onClose)
          resolve(false)
        }, ms)
        child.once('close', onClose)
      })

    if (process.platform === 'win32' && child.pid) {
      if (!opts.force) {
        await runTaskkill(child.pid, false)
        if (await waitExit(2000)) return
      }
      await runTaskkill(child.pid, true)
      if (await waitExit(3000)) return
    } else {
      if (!opts.force) {
        killQuietly(child, 'SIGTERM')
        if (await waitExit(timeoutMs)) return
      }
      killQuietly(child, 'SIGKILL')
      if (await waitExit(3000)) return
    }

    // 兜底：taskkill 失败（权限/已退出）时直接对 process 对象动手
    killQuietly(child, 'SIGKILL')
    const exited = await waitExit(2000)
    if (!exited) log.warn(`进程 ${child.pid} 未能确认退出，可能仍在运行`)
  }

  /* ---------------- 内部：输出处理 ---------------- */

  private consume(kind: 'stdout' | 'stderr', chunk: Buffer): void {
    this.events.onRawOutput?.(decodeText(chunk).text)

    let buffer = Buffer.concat([kind === 'stdout' ? this.stdoutBuffer : this.stderrBuffer, chunk])
    for (;;) {
      const index = findLineBreak(buffer, 0)
      if (index < 0) break
      const lineBytes = buffer.subarray(0, index)
      const skip = buffer[index] === 0x0d && buffer[index + 1] === 0x0a ? 2 : 1
      this.emitLine(decodeText(lineBytes).text)
      buffer = buffer.subarray(index + skip)
    }

    // 超长行（无换行的巨型输出）：截断以免内存无限增长
    if (buffer.length > MAX_LINE_BYTES) {
      this.emitLine(decodeText(buffer.subarray(0, MAX_LINE_BYTES)).text + TRUNCATION_SUFFIX)
      buffer = Buffer.alloc(0)
    }

    if (kind === 'stdout') this.stdoutBuffer = buffer
    else this.stderrBuffer = buffer
  }

  private emitLine(text: string): void {
    if (text.length === 0) return
    const line = parseLogLine(text)
    if (line.level === 'fatal') this.diagnosticsValue.sawFatal = true
    if (line.level === 'fatal' && /fatal error has been detected by the java runtime environment/i.test(text)) {
      this.diagnosticsValue.sawFatalJvmCrash = true
    }
    if (/^\s*at\s+[\w$./<>[\]]+\(.*\)\s*$/.test(text) || /(^|\]\s*)Caused by:/i.test(text)) {
      this.diagnosticsValue.sawStackTrace = true
    }
    this.events.onLog?.(line)
    this.logStream?.write(`${text}\n`)
  }

  private finalize(code: number | null, signal: string | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCodeValue = code
    this.exitSignalValue = signal

    // 冲刷两个流的残余缓冲（最后一行可能没有换行）
    for (const kind of ['stdout', 'stderr'] as const) {
      const buffer = kind === 'stdout' ? this.stdoutBuffer : this.stderrBuffer
      if (buffer.length > 0) this.emitLine(decodeText(buffer).text)
      if (kind === 'stdout') this.stdoutBuffer = Buffer.alloc(0)
      else this.stderrBuffer = Buffer.alloc(0)
    }

    this.logStream?.end()
    log.info(`游戏进程退出：pid=${this.pid} code=${code ?? '-'} signal=${signal ?? '-'}`)
    this.events.onExit?.(code, signal)
  }
}

/* ------------------------------------------------------------------ *
 *  平台相关辅助
 * ------------------------------------------------------------------ */

function findLineBreak(buffer: Buffer, from: number): number {
  for (let i = from; i < buffer.length; i++) {
    if (buffer[i] === 0x0a || buffer[i] === 0x0d) return i
  }
  return -1
}

function killQuietly(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* 进程可能已退出 */
  }
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    // /T 连子孙进程一起结束（Forge/NeoForge 会派生子进程）
    const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    let killer: ChildProcess
    try {
      killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      log.debug(`taskkill 启动失败：${err instanceof Error ? err.message : String(err)}`)
      resolve()
      return
    }
    const timer = setTimeout(() => {
      killQuietly(killer, 'SIGKILL')
      done()
    }, 5000)
    killer.on('error', done)
    killer.on('close', done)
  })
}
