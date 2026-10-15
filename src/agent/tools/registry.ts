/**
 * 工具注册中心。
 *
 * 设计要点：
 * - 工具是 Agent 唯一的「动手」途径，因此所有文件/命令操作都在这里统一做
 *   权限门控与路径沙箱，而不是散落在各工具实现里。
 * - 只读工具可并行执行，写工具串行执行，避免并发写同一文件造成混乱。
 */

import type { PermissionRequest, ToolDefinition, ToolInvocationContext } from '@shared/types'
import { logger } from '@core/util/logger'

const log = logger.scoped('tools')

export interface ToolResult {
  ok: boolean
  /** 返回给模型的文本（会被放进 tool 消息） */
  output: string
  /** 给 UI 的附加信息（任意可序列化结构） */
  meta?: unknown
  /** 涉及/生成的文件路径 */
  files?: string[]
  /** 供上层做统计（例如下载字节数） */
  stats?: Record<string, number>
}

export interface PermissionSpec {
  summary: string
  detail?: string
  risk: 'low' | 'medium' | 'high'
}

export interface ToolDefinitionWithHandler extends ToolDefinition {
  /** 执行体 */
  handler: (args: Record<string, unknown>, ctx: ToolInvocationContext) => Promise<ToolResult>
  /**
   * 针对具体参数返回权限请求；返回 null 表示本次调用不需要确认。
   * 未定义时按 definition.dangerous / category 走默认策略。
   */
  permissionFor?: (args: Record<string, unknown>) => PermissionSpec | null
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinitionWithHandler>()

  register(tool: ToolDefinitionWithHandler): void {
    if (this.tools.has(tool.name)) {
      log.warn(`工具重名，后者覆盖：${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: ToolDefinitionWithHandler[]): void {
    for (const tool of tools) this.register(tool)
  }

  get(name: string): ToolDefinitionWithHandler | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  /** 供模型使用的工具定义（去掉实现细节） */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      category: tool.category,
      readOnly: tool.readOnly,
      dangerous: tool.dangerous,
      requiresPaths: tool.requiresPaths
    }))
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly === true
  }

  /**
   * 判断某次调用是否需要用户确认。
   * 策略：
   * - permissionMode 'readonly'：只有只读工具放行，其余一律拒绝（返回 denied）。
   * - 'auto-all'：不询问。
   * - 'auto-safe'：只读工具 + 低风险写操作（写入 agent 工作区内的新文件）不询问。
   * - 'ask'：所有写/命令操作都询问。
   */
  resolvePermission(
    name: string,
    args: Record<string, unknown>,
    mode: 'ask' | 'auto-safe' | 'auto-all' | 'readonly'
  ): { spec: PermissionSpec | null; denied?: string } {
    const tool = this.tools.get(name)
    if (!tool) return { spec: null, denied: `未知工具：${name}` }
    const readOnly = tool.readOnly === true

    if (mode === 'readonly' && !readOnly) {
      return { spec: null, denied: `当前为「只读模式」，不允许执行 ${name}。如需执行请在设置中调整 Agent 权限模式。` }
    }
    if (mode === 'auto-all') return { spec: null }

    const explicit = tool.permissionFor?.(args) ?? null
    if (explicit) {
      if (mode === 'auto-safe' && explicit.risk === 'low' && !tool.dangerous) return { spec: null }
      return { spec: explicit }
    }
    if (readOnly) return { spec: null }
    if (mode === 'auto-safe' && !tool.dangerous) return { spec: null }
    if (!tool.dangerous && tool.category === 'knowledge') return { spec: null }

    return {
      spec: {
        summary: `执行 ${name}`,
        detail: summarizeArgs(args),
        risk: tool.dangerous ? 'high' : 'medium'
      }
    }
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolInvocationContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, output: `错误：不存在名为 ${name} 的工具。可用工具：${this.names().join(', ')}` }
    }
    try {
      const result = await tool.handler(args, ctx)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`工具 ${name} 执行失败：${message}`)
      return { ok: false, output: `工具执行失败：${message}` }
    }
  }

  /** 构造权限请求对象 */
  buildPermissionRequest(
    callId: string,
    toolName: string,
    spec: PermissionSpec,
    requestId: string
  ): PermissionRequest {
    return {
      id: requestId,
      callId,
      toolName,
      summary: spec.summary,
      detail: spec.detail,
      risk: spec.risk,
      scopes: toolName === 'run_command' ? ['once', 'session'] : ['once', 'session', 'always']
    }
  }
}

export function summarizeArgs(args: Record<string, unknown>, maxLength = 400): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    let rendered: string
    if (typeof value === 'string') {
      rendered = value.length > 200 ? `${value.slice(0, 200)}…(${value.length} 字)` : value
    } else if (Array.isArray(value)) {
      rendered = `[${value.length} 项] ${value
        .slice(0, 3)
        .map((v) => String(v).slice(0, 60))
        .join(', ')}`
    } else {
      rendered = JSON.stringify(value).slice(0, 200)
    }
    parts.push(`${key}=${rendered}`)
  }
  return parts.join('\n').slice(0, maxLength)
}

/** 工具参数校验辅助：取必填字符串 */
export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${key} 必须是非空字符串`)
  }
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : String(value)
}

export function optionalNumber(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

export function optionalBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  return value === 'true' || value === 1 || value === '1'
}

export function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`参数 ${key} 必须是字符串数组`)
  }
  return value as string[]
}
