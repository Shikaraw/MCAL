/**
 * Gradle 工程构建器
 *
 * 在项目目录里执行 gradle（优先 wrapper，回退系统 gradle），逐行回调输出、
 * 支持超时与取消，并解析常见的 Java/Gradle 报错与产物路径。
 *
 * 说明：
 *  - 平台差异：Windows 用 `gradlew.bat`，POSIX 用 `./gradlew`；
 *  - 不引入任何外部依赖，纯 child_process；
 *  - 超时默认 15 分钟（首次构建要下依赖，给足时间）。
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '@core/util/logger'

const log = logger.scoped('dev:builder')

export interface BuildResult {
  ok: boolean
  code: number | null
  output: string
  durationMs: number
  /** 识别出的错误摘要 */
  errors: string[]
  artifactPaths: string[]
}

export interface BuildOptions {
  dir: string
  task?: string
  args?: string[]
  signal?: AbortSignal
  onOutput?: (line: string) => void
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** 编译错误：`X.java:12: error: 具体信息`（javac 输出，含中文/英文） */
const JAVAC_ERROR_RE = /^(.+?\.java):(\d+):\s*(?:error|错误)[:：]\s*(.+)$/i
/** Kotlin 编译错误：`e: file.kt:12:34 message` */
const KOTLIN_ERROR_RE = /^e:\s*(.+?):\s*(?:\((\d+),\s*(\d+)\))?\s*(.+)$/
/** Gradle 失败行 */
const GRADLE_FAILURE_PATTERNS: RegExp[] = [
  /^FAILURE:\s*Build failed with an exception/i,
  /^>\s*Task .+ FAILED\s*$/i,
  /^Execution failed for task .+$/i,
  /^Could not resolve .+$/i,
  /^Could not find .+$/i,
  /^Could not determine the dependencies of task .+$/i,
  /^Could not compile .+$/i,
  /^Unable to find method .+$/i,
  /^Caused by:\s*.+$/i,
  /error: cannot find symbol/i,
  /^No matching variant of .+$/i,
  /^Plugin \[id: .+\] was not found/i,
  /Unsupported class file major version/i,
  /^\* What went wrong:/
]

export class ProjectBuilder {
  private readonly javaHome?: string
  private readonly timeoutMs: number

  constructor(opts: { javaHome?: string; timeoutMs?: number } = {}) {
    this.javaHome = opts.javaHome
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 执行 gradle 构建。优先 ./gradlew（Windows 为 gradlew.bat），
   * 不存在时回退到系统 `gradle`。
   */
  async build(opts: BuildOptions): Promise<BuildResult> {
    const task = opts.task ?? 'build'
    const extraArgs = opts.args ?? []
    const command = this.resolveCommand(opts.dir)
    const commandLine = [command.display, task, ...extraArgs].join(' ')
    const started = Date.now()
    const lines: string[] = []

    log.info(`构建开始：${commandLine}（cwd=${opts.dir}）`)

    const env = { ...process.env }
    if (this.javaHome) {
      env.JAVA_HOME = this.javaHome
      // Windows 下把 bin 也塞进 PATH，避免子进程找不到 java
      env.PATH = `${join(this.javaHome, 'bin')}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`
    }

    const code = await new Promise<number | null>((resolvePromise) => {
      const child = spawn(command.display, [task, ...extraArgs], {
        cwd: opts.dir,
        env,
        // .bat / .cmd 在 Windows 上必须走 shell；POSIX 下直接执行脚本
        shell: command.useShell,
        windowsHide: true
      })

      let settled = false
      const finish = (value: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        resolvePromise(value)
      }

      const timer = setTimeout(() => {
        lines.push(`[MCAL] 构建超时（${Math.round(this.timeoutMs / 1000)} 秒），已终止进程。`)
        opts.onOutput?.(lines[lines.length - 1])
        child.kill('SIGKILL')
        finish(null)
      }, this.timeoutMs)

      const onAbort = (): void => {
        lines.push('[MCAL] 构建已被取消。')
        opts.onOutput?.(lines[lines.length - 1])
        child.kill('SIGKILL')
        finish(null)
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      const handleChunk = (chunk: Buffer): void => {
        // gradle 输出里既有 \n 也有 \r（进度条），统一按行切分
        for (const rawLine of chunk.toString('utf8').split(/\r?\n|\r/)) {
          const line = rawLine.trimEnd()
          if (line === '') continue
          lines.push(line)
          if (lines.length > 20_000) lines.splice(0, lines.length - 20_000)
          opts.onOutput?.(line)
        }
      }

      child.stdout?.on('data', handleChunk)
      child.stderr?.on('data', handleChunk)
      child.on('error', (err) => {
        lines.push(`[MCAL] 无法启动构建进程（${command.display}）：${err.message}`)
        opts.onOutput?.(lines[lines.length - 1])
        finish(null)
      })
      child.on('close', (exitCode) => finish(exitCode))
    })

    const output = lines.join('\n')
    const errors = this.parseErrors(output)
    const artifactPaths = code === 0 ? await this.findArtifacts(opts.dir) : []
    const durationMs = Date.now() - started
    const ok = code === 0

    log.info(`构建结束：ok=${ok} code=${code} 用时 ${durationMs}ms 产物 ${artifactPaths.length} 个`)
    return { ok, code, output, durationMs, errors, artifactPaths }
  }

  /** 从 gradle 输出里提取编译错误（形如 `X.java:12: error: ...`） */
  parseErrors(output: string): string[] {
    const errors: string[] = []
    const seen = new Set<string>()
    const push = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed || seen.has(trimmed)) return
      seen.add(trimmed)
      errors.push(trimmed)
    }

    const rawLines = output.split(/\r?\n/)
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]
      const javac = JAVAC_ERROR_RE.exec(line.trim())
      if (javac) {
        push(`${javac[1]}:${javac[2]} 编译错误：${javac[3]}`)
        // javac 会在后面几行给出源码片段、^ 指示符，以及 symbol/location 明细
        for (let j = i + 1; j < Math.min(i + 5, rawLines.length); j++) {
          const next = rawLines[j].trim()
          if (/^[a-zA-Z_].*\.java:\d+:/.test(next)) break // 下一条错误
          if (!next || next === '^') continue
          if (/^(symbol|location|符号|位置)\b/i.test(next)) push(next)
        }
        continue
      }
      const kotlin = KOTLIN_ERROR_RE.exec(line.trim())
      if (kotlin) {
        push(`${kotlin[1]}${kotlin[2] ? `:${kotlin[2]}` : ''} 编译错误：${kotlin[4]}`)
        continue
      }
      for (const pattern of GRADLE_FAILURE_PATTERNS) {
        if (pattern.test(line.trim())) {
          push(line.trim())
          break
        }
      }
    }

    // 去重同时保留出现顺序，最多 50 条，避免刷屏
    return errors.slice(0, 50)
  }

  /** 猜测产物路径（build/libs/*.jar，排除 -sources/-dev/-slim/-javadoc） */
  async findArtifacts(dir: string): Promise<string[]> {
    const libsDir = join(dir, 'build', 'libs')
    let entries: string[] = []
    try {
      entries = await readdir(libsDir)
    } catch {
      return []
    }
    const exclude = /-(sources|dev|slim|javadoc|api|plain|universal)\.jar$/i
    return entries
      .filter((name) => name.toLowerCase().endsWith('.jar'))
      .filter((name) => !exclude.test(name))
      .map((name) => join(libsDir, name))
      .sort()
  }

  /** 决定用 wrapper 还是系统 gradle */
  resolveCommand(dir: string): { display: string; useShell: boolean } {
    const isWindows = process.platform === 'win32'
    const wrapperName = isWindows ? 'gradlew.bat' : 'gradlew'
    const wrapperPath = join(dir, wrapperName)
    if (existsSync(wrapperPath)) {
      // Windows 的 .bat 需要 shell 才能执行
      return { display: isWindows ? wrapperPath : `./${wrapperName}`, useShell: isWindows }
    }
    // 回退系统 gradle（Windows 上是 gradle.bat，通过 shell 解析）
    return { display: 'gradle', useShell: true }
  }
}
