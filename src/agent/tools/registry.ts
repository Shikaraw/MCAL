/**
 * 工具注册中心。
 *
 * 设计要点：
 * - 工具是 Agent 唯一的「动手」途径，因此所有文件/命令操作都在这里统一做
 *   权限门控与路径沙箱，而不是散落在各工具实现里。
 * - 只读工具可并行执行，写工具串行执行，避免并发写同一文件造成混乱。
 */

import type { PermissionRequest, ToolDefinition, ToolInvocationContext } from '@shared/types'
import { isAbsolute, resolve } from 'node:path'
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

/** 访问级别的执行上下文：决定「工作区」这条边界画在哪里 */
export interface ToolAccessPolicy {
  mode: 'workspace' | 'full'
  roots: string[]
  /** 敏感操作是否强制授权（即使处于 full + auto-all） */
  confirmSensitive: boolean
}

/** 参数里可能承载路径的键名：只在这些键上做越界判断，避免把正文误当路径 */
const PATH_ARG_KEYS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'target',
  'targets',
  'dest',
  'destination',
  'source',
  'src',
  'dir',
  'directory',
  'folder',
  'root',
  'cwd',
  'workdir',
  'input',
  'output',
  'outdir',
  'from',
  'to',
  'save',
  'savepath'
])

function normalizeForCompare(input: string): string {
  return resolve(input).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/** 取出参数中像路径的值（只看已知键名，支持字符串与字符串数组） */
export function collectPathArgs(args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_ARG_KEYS.has(key.toLowerCase())) continue
    if (typeof value === 'string' && value.trim() !== '') out.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim() !== '') out.push(item)
    }
  }
  return out
}

/** 目标是否在工作区之外；相对路径按 roots[0] 解析，与 fs 工具保持一致 */
export function isOutsideWorkspace(target: string, roots: string[]): boolean {
  if (roots.length === 0) return false
  const absolute = isAbsolute(target) ? resolve(target) : resolve(roots[0], target)
  const normalized = normalizeForCompare(absolute)
  return !roots.some((root) => {
    const rootNorm = normalizeForCompare(root)
    return normalized === rootNorm || normalized.startsWith(`${rootNorm}/`)
  })
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
      requiresPaths: tool.requiresPaths,
      escapesWorkspace: tool.escapesWorkspace
    }))
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly === true
  }

  /**
   * 判断某次调用是否需要用户确认，或应当直接拒绝。
   *
   * 两层策略叠加：
   * 1) 访问级别（access.mode）：workspace = 只允许工作区内的路径，越界直接拒绝；
   *    full = 允许任意路径，但越界写操作一律弹授权。
   * 2) 权限模式（mode）：readonly 只读 / auto-safe 低风险自动 / auto-all 全自动 / ask 每次问。
   *
   * 敏感操作（删除、执行命令、工作区外写入）在 access.confirmSensitive 开启时
   * 永远需要授权，即使处于 full + auto-all。
   */
  resolvePermission(
    name: string,
    args: Record<string, unknown>,
    mode: 'ask' | 'auto-safe' | 'auto-all' | 'readonly',
    access?: ToolAccessPolicy
  ): { spec: PermissionSpec | null; denied?: string } {
    const tool = this.tools.get(name)
    if (!tool) return { spec: null, denied: `未知工具：${name}` }
    const readOnly = tool.readOnly === true
    const policy: ToolAccessPolicy = access ?? { mode: 'workspace', roots: [], confirmSensitive: true }

    if (mode === 'readonly') {
      if (readOnly) return { spec: null }
      return { spec: null, denied: `当前为「只读模式」，不允许执行 ${name}。如需执行请在设置中调整 Agent 权限模式。` }
    }

    // 能绕过工作区边界的工具（如 shell）在「仅工作区」下不执行：无法既保证沙箱又放行命令
    if (policy.mode === 'workspace' && tool.escapesWorkspace) {
      return {
        spec: null,
        denied:
          `当前访问级别为「仅工作区」，${name} 可以执行任意命令、绕过该限制，因此被阻止。\n` +
          '请把需要执行的命令直接告诉用户，由用户自行运行；' +
          '或者由用户在「设置 → AI 模型 → 访问权限」中改为「完全访问」后重试。'
      }
    }

    const outsidePaths =
      tool.requiresPaths === true
        ? collectPathArgs(args).filter((target) => isOutsideWorkspace(target, policy.roots))
        : []

    if (policy.mode === 'workspace' && outsidePaths.length > 0) {
      return {
        spec: null,
        denied:
          `以下路径不在允许范围内：\n${outsidePaths.map((p) => `  - ${p}`).join('\n')}\n` +
          `当前允许的根目录：\n${policy.roots.map((r) => `  - ${r}`).join('\n') || '  （无）'}\n` +
          '当前访问级别为「仅工作区」。如需读取/修改其它位置，请让用户在「设置 → AI 模型 → 访问权限」中改为「完全访问」。'
      }
    }

    const outsideWrite = policy.mode === 'full' && !readOnly && outsidePaths.length > 0
    const sensitive = !readOnly && (tool.dangerous === true || tool.escapesWorkspace === true)
    const mustConfirm = policy.confirmSensitive && (sensitive || outsideWrite)
    const sensitiveNote = outsideWrite && sensitive
      ? `操作对象在工作区之外：\n${outsidePaths.map((p) => `  - ${p}`).join('\n')}`
      : outsideWrite
        ? `工作区之外的写入：\n${outsidePaths.map((p) => `  - ${p}`).join('\n')}`
        : undefined

    if (mode === 'auto-all') {
      if (!mustConfirm) return { spec: null }
      return {
        spec: {
          summary: `敏感操作：执行 ${name}`,
          detail: [summarizeArgs(args), sensitiveNote].filter(Boolean).join('\n'),
          risk: 'high'
        }
      }
    }

    const explicit = tool.permissionFor?.(args) ?? null
    if (explicit) {
      if (!mustConfirm) {
        if (mode === 'auto-safe' && explicit.risk === 'low' && !tool.dangerous) return { spec: null }
        return { spec: explicit }
      }
      // 敏感操作：保留工具自己写好的说明，但把风险级别抬高并附带越界信息
      return {
        spec: {
          summary: explicit.summary,
          detail: [explicit.detail, sensitiveNote].filter(Boolean).join('\n') || summarizeArgs(args),
          risk: outsideWrite || sensitive ? 'high' : explicit.risk
        }
      }
    }
    if (readOnly) return { spec: null }
    if (!mustConfirm && mode === 'auto-safe' && !tool.dangerous && !tool.escapesWorkspace) return { spec: null }
    if (!mustConfirm && !tool.dangerous && tool.category === 'knowledge') return { spec: null }

    return {
      spec: {
        summary: `执行 ${name}`,
        detail: [summarizeArgs(args), sensitiveNote].filter(Boolean).join('\n'),
        risk: mustConfirm || tool.dangerous ? 'high' : 'medium'
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
