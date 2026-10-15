/**
 * 命令执行工具。
 * 默认需要用户确认（高危），并且限制工作目录在允许的根目录内。
 * 输出按流式追加，超时或取消时杀掉进程树。
 */

import { spawn } from 'node:child_process'
import { resolve, isAbsolute } from 'node:path'
import type { ToolInvocationContext } from '@shared/types'
import { optionalBoolean, optionalNumber, optionalString, requireString, type ToolDefinitionWithHandler } from './registry'

const MAX_OUTPUT_CHARS = 40_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 30 * 60 * 1000

/** 明显危险、需要更严格确认的命令特征（不阻止，但提示风险等级） */
const HIGH_RISK_PATTERNS: { re: RegExp; note: string }[] = [
  { re: /\brm\s+-rf\b/i, note: '递归强制删除' },
  { re: /\b(del|erase)\b.*\/[sqf]/i, note: '递归/强制删除' },
  { re: /\b(format|diskpart|fdisk|mkfs)\b/i, note: '磁盘级操作' },
  { re: /\b(shutdown|reboot|poweroff)\b/i, note: '关机/重启' },
  { re: /\b(taskkill|killall|pkill)\b/i, note: '结束进程' },
  { re: /Remove-Item\s+.*-Recurse/i, note: 'PowerShell 递归删除' },
  { re: /\breg\s+(add|delete)\b/i, note: '修改注册表' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, note: '丢弃本地改动' },
  { re: /(^|\s)>\s*[A-Za-z]:\\/i, note: '重定向覆盖磁盘根路径文件' }
]

function resolveCwd(ctx: ToolInvocationContext, cwd?: string): string {
  if (!cwd) return ctx.roots[0] ?? process.cwd()
  const absolute = isAbsolute(cwd) ? resolve(cwd) : resolve(ctx.roots[0] ?? process.cwd(), cwd)
  // 完全访问：允许任意工作目录（该命令本身已逐次授权）
  if (ctx.accessMode === 'full') return absolute
  const normalized = absolute.replace(/\\/g, '/').toLowerCase()
  for (const root of ctx.roots) {
    const rootNorm = resolve(root).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    if (normalized === rootNorm || normalized.startsWith(`${rootNorm}/`)) return absolute
  }
  throw new Error(`工作目录不在允许范围内：${absolute}`)
}

export interface CommandRunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

/** 执行命令并收集输出（供工具与内部服务复用） */
export function runCommand(opts: {
  command: string
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  shell?: string
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
  maxOutputChars?: number
}): Promise<CommandRunResult> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const isWindows = process.platform === 'win32'
    const shell = opts.shell ?? (isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh')
    const shellArgs = isWindows ? ['/d', '/s', '/c', opts.command] : ['-c', opts.command]

    const child = spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      detached: false
    })

    const maxChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid, isWindows)
    }, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))

    const onAbort = (): void => {
      aborted = true
      killTree(child.pid, isWindows)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8')
      if (stdout.length < maxChars) stdout += text
      opts.onOutput?.(text, 'stdout')
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8')
      if (stderr.length < maxChars) stderr += text
      opts.onOutput?.(text, 'stderr')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        code,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        aborted,
        durationMs: Date.now() - started
      })
    })
  })
}

function killTree(pid: number | undefined, isWindows: boolean): void {
  if (!pid) return
  try {
    if (isWindows) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 进程可能已退出 */
    }
  }
}

export const runCommandTool: ToolDefinitionWithHandler = {
  name: 'run_command',
  description:
    '在允许的目录内执行系统命令并返回输出。适合：用 git 初始化仓库、用 gradle 构建项目、用 java -version 检查环境、用 dir/ls 查看文件。' +
    '注意：这是真实的命令执行，会修改文件系统的命令必须先向用户解释清楚目的。长时间命令可设 timeoutMs。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（Windows 走 cmd，其他走 sh）' },
      cwd: { type: 'string', description: '工作目录，默认工作区根目录' },
      timeoutMs: { type: 'number', description: '超时毫秒数，默认 120000，最大 1800000' },
      purpose: { type: 'string', description: '这条命令的目的（会展示给用户确认）' }
    },
    required: ['command', 'purpose']
  },
  category: 'shell',
  dangerous: true,
  // 命令可以 cd 到任意目录再写文件，路径沙箱对它无效，因此「仅工作区」级别下直接不放行
  escapesWorkspace: true,
  permissionFor: (args) => {
    const command = String(args.command ?? '')
    const high = HIGH_RISK_PATTERNS.find((pattern) => pattern.re.test(command))
    return {
      summary: `执行命令：${truncate(command, 120)}`,
      detail: [
        args.purpose ? `目的：${String(args.purpose)}` : '',
        args.cwd ? `目录：${String(args.cwd)}` : '',
        high ? `⚠️ 风险提示：${high.note}` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      risk: high ? 'high' : 'medium'
    }
  },
  handler: async (args, ctx) => {
    if (!ctx.networkAllowed && /\b(curl|wget|invoke-webrequest|iwr)\b/i.test(String(args.command ?? ''))) {
      return { ok: false, output: '当前禁止网络工具，无法执行下载类命令。请在设置中开启网络工具。' }
    }
    const command = requireString(args, 'command')
    const cwd = resolveCwd(ctx, optionalString(args, 'cwd'))
    const timeoutMs = optionalNumber(args, 'timeoutMs', DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS
    const result = await runCommand({ command, cwd, timeoutMs, signal: ctx.abortSignal })

    const parts: string[] = []
    parts.push(`命令：${command}`)
    parts.push(`退出码：${result.code ?? 'null'}${result.timedOut ? '（超时被杀）' : ''}${result.aborted ? '（已取消）' : ''}，耗时 ${(result.durationMs / 1000).toFixed(1)} 秒`)
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim().slice(0, MAX_OUTPUT_CHARS)}`)
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim().slice(0, MAX_OUTPUT_CHARS)}`)
    if (!result.stdout.trim() && !result.stderr.trim()) parts.push('（无输出）')

    return {
      ok: result.code === 0 && !result.timedOut,
      output: parts.join('\n'),
      meta: { exitCode: result.code, durationMs: result.durationMs, timedOut: result.timedOut }
    }
  }
}

export const shellTools: ToolDefinitionWithHandler[] = [runCommandTool]

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
