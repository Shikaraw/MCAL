/**
 * Agent 主循环（Harness）。
 *
 * 一次 run 的流程：
 *   用户输入 → 组装系统提示（环境 + 技能 + 知识库目录 + 记忆召回）
 *   → 调模型（流式）→ 若有工具调用则按权限执行 → 把结果回灌 → 继续
 *   → 直到模型不再调用工具 或 达到轮次上限 或 用户中止。
 *
 * 设计取舍：
 * - 轮次上限默认 25：既能完成「诊断 → 改配置 → 验证」这类多步任务，
 *   又不会因为模型陷入循环而无限烧 token。
 * - 只读工具并行、写工具串行：读文件可以并发提速，写文件串行避免互相覆盖。
 * - 工具输出统一截断：日志类输出动辄几十万行，不截断会直接撑爆上下文。
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentServices,
  ChatAttachment,
  ChatMessage,
  McalSettings,
  PermissionRequest,
  PermissionResponse,
  ToolCallRequest,
  ToolDefinition,
  ToolInvocationContext
} from '@shared/types'
import type { ChatProvider } from '@agent/provider/types'
import { estimateConversationTokens, compactConversation, needsCompaction } from '@agent/context/compaction'
import type { MemoryStore } from '@agent/memory/store'
import { buildSystemPrompt, type PromptContext } from '@agent/prompt'
import { SessionStore, type SessionRecord, type SessionSummary } from '@agent/session'
import type { SkillRegistry } from '@agent/skills/registry'
import type { KnowledgeBase } from '@knowledge/index'
import { ToolRegistry, type ToolResult } from '@agent/tools/registry'
import { logger } from '@core/util/logger'

const log = logger.scoped('harness')

/** 单个工具结果进入上下文的最大字符数 */
const MAX_TOOL_OUTPUT_CHARS = 30_000
/** 默认最大轮次 */
const DEFAULT_MAX_TURNS = 25

export interface HarnessDeps {
  registry: ToolRegistry
  sessions: SessionStore
  memory: MemoryStore
  skills: SkillRegistry
  knowledge: KnowledgeBase
  services: AgentServices
  getSettings: () => McalSettings
  /** 取当前 provider（可能未配置，返回 null） */
  getProvider: () => ChatProvider | null
  /** 组装系统提示所需的动态上下文 */
  getPromptContext: () => Promise<Omit<PromptContext, 'settings' | 'skills' | 'knowledge' | 'memory'>>
  emit: (sessionId: string, event: AgentEvent) => void
  /** 请求用户授权（由主进程桥接到 UI） */
  requestPermission: (sessionId: string, request: Omit<PermissionRequest, 'id'>) => Promise<PermissionResponse>
  /** Agent 可操作的根目录 */
  getRoots: () => string[]
  appVersion: string
}

interface SessionRuntime {
  controller: AbortController
  running: boolean
  /** 串行化同一会话的请求 */
  queue: Promise<void>
  todos: { id: string; content: string; status: string; note?: string }[]
  /** 会话级权限记忆：toolName → 已授权 */
  sessionAllows: Set<string>
  /** 本次 run 的待授权请求 */
  pendingPermissions: Map<string, (response: PermissionResponse) => void>
}

export interface SendOptions {
  sessionId: string
  text: string
  attachments?: ChatAttachment[]
  /** 附加到本轮的系统提示（例如当前打开的是哪个实例） */
  contextHint?: string
}

export class AgentHarness {
  private deps: HarnessDeps
  private runtime = new Map<string, SessionRuntime>()
  private sessions = new Map<string, SessionRecord>()

  constructor(deps: HarnessDeps) {
    this.deps = deps
  }

  /* ------------------------- 生命周期 ------------------------- */

  async start(): Promise<void> {
    await this.deps.memory.load()
    await this.deps.skills.load()
    await this.deps.knowledge.load()
    log.info('Agent 运行时已就绪')
  }

  async shutdown(): Promise<void> {
    for (const [, runtime] of this.runtime) {
      runtime.controller.abort(new Error('启动器退出'))
    }
    await this.deps.memory.close()
  }

  /* ------------------------- 会话管理 ------------------------- */

  async newSession(opts: { title?: string; instanceId?: string } = {}): Promise<string> {
    const record = await this.deps.sessions.create(opts)
    this.sessions.set(record.id, record)
    this.deps.emit(record.id, { type: 'session_start', sessionId: record.id, model: this.currentModelName() })
    return record.id
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.deps.sessions.list()
  }

  async loadSession(id: string): Promise<SessionRecord | null> {
    const record = await this.deps.sessions.load(id)
    if (record) this.sessions.set(id, record)
    return record
  }

  async deleteSession(id: string): Promise<void> {
    this.abort(id)
    this.sessions.delete(id)
    this.runtime.delete(id)
    await this.deps.sessions.remove(id)
  }

  isRunning(sessionId: string): boolean {
    return this.runtime.get(sessionId)?.running ?? false
  }

  /** 中止当前会话的生成与工具执行 */
  abort(sessionId: string): void {
    const runtime = this.runtime.get(sessionId)
    if (!runtime) return
    runtime.controller.abort(new Error('用户中止'))
    // 释放所有等待中的授权请求，避免 UI 关掉后永远挂起
    for (const [, resolver] of runtime.pendingPermissions) {
      resolver({ id: '', decision: 'deny', scope: 'once' })
    }
    runtime.pendingPermissions.clear()
  }

  /** UI 回传的授权结果 */
  respondPermission(response: PermissionResponse): void {
    for (const [, runtime] of this.runtime) {
      const resolver = runtime.pendingPermissions.get(response.id)
      if (resolver) {
        runtime.pendingPermissions.delete(response.id)
        resolver(response)
        return
      }
    }
  }

  /* ------------------------- 主流程 ------------------------- */

  async send(options: SendOptions): Promise<void> {
    const runtime = this.getRuntime(options.sessionId)
    if (runtime.running) {
      throw new Error('当前会话仍在处理中，请等待完成或先中止。')
    }
    // 串行执行：把本次请求接到队列尾部
    const previous = runtime.queue
    let resolveQueue: () => void = () => undefined
    runtime.queue = new Promise<void>((resolve) => {
      resolveQueue = resolve
    })
    await previous.catch(() => undefined)
    try {
      await this.runTurnLoop(options, runtime)
    } finally {
      resolveQueue()
    }
  }

  private async runTurnLoop(options: SendOptions, runtime: SessionRuntime): Promise<void> {
    const sessionId = options.sessionId
    const settings = this.deps.getSettings()
    const session = await this.requireSession(sessionId)
    const provider = this.deps.getProvider()

    runtime.running = true
    runtime.controller = new AbortController()
    const signal = runtime.controller.signal

    this.deps.emit(sessionId, { type: 'session_start', sessionId, model: this.currentModelName() })

    // 1. 落库用户消息
    const userMessage: ChatMessage = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: 'user',
      content: options.text,
      attachments: options.attachments,
      createdAt: Date.now()
    }
    session.messages.push(userMessage)
    if (session.messages.filter((m) => m.role === 'user').length === 1) {
      session.title = SessionStore.deriveTitle(options.text)
    }
    await this.deps.sessions.save(session)

    if (!provider) {
      this.deps.emit(sessionId, {
        type: 'error',
        message: '还没有配置可用的模型。请在「设置 → Agent 模型」里填写 API Key（推荐 DeepSeek）。'
      })
      this.deps.emit(sessionId, { type: 'session_end', reason: 'no-provider' })
      runtime.running = false
      return
    }

    const maxTurns = settings.agent.maxTurnsPerRequest || DEFAULT_MAX_TURNS
    const tools = this.deps.registry.definitions()
    let aborted = false

    try {
      // 2. 组装系统提示（每轮任务开头构建一次，避免中途环境信息漂移）
      const promptContext = await this.deps.getPromptContext()
      const systemPrompt = await buildSystemPrompt({
        ...promptContext,
        settings,
        skills: this.deps.skills,
        knowledge: this.deps.knowledge,
        memory: this.deps.memory,
        userInput: options.text
      })
      const systemMessage: ChatMessage = {
        role: 'system',
        content: options.contextHint ? `${systemPrompt}\n\n## 本轮上下文\n${options.contextHint}` : systemPrompt
      }

      for (let turn = 1; turn <= maxTurns; turn++) {
        if (signal.aborted) {
          aborted = true
          break
        }
        this.deps.emit(sessionId, { type: 'turn_start', turn })

        // 3. 上下文压缩
        let conversation = session.messages
        const compactionOptions = {
          threshold: settings.agent.compactionThreshold || 120_000,
          keepRecent: 12,
          contextWindow: this.contextWindow(),
          reserveForResponse: 8000,
          provider,
          model: this.currentModelName(),
          signal
        }
        if (needsCompaction(conversation, tools, compactionOptions)) {
          const result = await compactConversation([systemMessage, ...conversation], compactionOptions)
          conversation = result.messages.filter((m) => m.role !== 'system')
          session.messages = conversation
          this.deps.emit(sessionId, { type: 'compaction', removed: result.removed, summary: result.summary })
          await this.deps.sessions.save(session)
        }

        const messages: ChatMessage[] = [systemMessage, ...conversation]

        // 4. 调模型
        const assistant = await this.streamAssistant(provider, messages, tools, sessionId, runtime, turn)
        if (assistant.aborted) {
          aborted = true
          break
        }

        const assistantMessage: ChatMessage = {
          id: `msg_${randomUUID().slice(0, 8)}`,
          role: 'assistant',
          content: assistant.content || null,
          toolCalls: assistant.toolCalls.length > 0 ? assistant.toolCalls : undefined,
          createdAt: Date.now(),
          usage: assistant.usage
        }
        session.messages.push(assistantMessage)

        if (assistant.toolCalls.length === 0) {
          this.deps.emit(sessionId, { type: 'turn_end', turn, reason: normalizeTurnEndReason(assistant.finishReason) })
          await this.deps.sessions.save(session)
          break
        }

        // 5. 执行工具
        const results = await this.executeToolCalls(assistant.toolCalls, sessionId, runtime, signal, settings)
        for (const call of assistant.toolCalls) {
          const result = results.get(call.id)
          session.messages.push({
            id: `msg_${randomUUID().slice(0, 8)}`,
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: result ? truncateToolOutput(result.output) : '（未执行）',
            createdAt: Date.now()
          })
        }
        await this.deps.sessions.save(session)
        this.deps.emit(sessionId, { type: 'turn_end', turn, reason: 'tool_calls' })

        if (turn === maxTurns) {
          this.deps.emit(sessionId, {
            type: 'notice',
            level: 'warn',
            message: `已达到单次请求的最大工具调用轮数（${maxTurns}）。如需继续，请再发一条消息。`
          })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`会话 ${sessionId} 执行失败：${message}`)
      this.deps.emit(sessionId, { type: 'error', message })
    } finally {
      runtime.running = false
      await this.deps.sessions.save(session).catch(() => undefined)
      this.deps.emit(sessionId, { type: 'session_end', reason: aborted ? 'aborted' : 'done' })
    }
  }

  /** 流式接收助手回复，累积文本与工具调用 */
  private async streamAssistant(
    provider: ChatProvider,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    sessionId: string,
    runtime: SessionRuntime,
    turn: number
  ): Promise<{
    content: string
    toolCalls: ToolCallRequest[]
    finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error' | 'unknown' | 'content_filter'
    aborted: boolean
    usage?: ChatMessage['usage']
  }> {
    const settings = this.deps.getSettings()
    let content = ''
    let usage: ChatMessage['usage']
    const partial = new Map<number, { id: string; name: string; args: string }>()
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error' | 'unknown' | 'content_filter' = 'stop'
    let aborted = false

    const stream = provider.stream({
      messages,
      tools: provider.capabilities.tools && settings.agent.shellEnabled !== undefined ? tools : undefined,
      model: this.currentModelName(),
      temperature: this.currentProviderSettings()?.temperature ?? 0.3,
      maxTokens: this.currentProviderSettings()?.maxTokens,
      reasoning: this.currentProviderSettings()?.reasoning,
      signal: runtime.controller.signal
    })

    for await (const event of stream) {
      if (runtime.controller.signal.aborted) {
        aborted = true
        break
      }
      switch (event.type) {
        case 'text_delta':
          content += event.delta
          this.deps.emit(sessionId, { type: 'text_delta', delta: event.delta })
          break
        case 'reasoning_delta':
          this.deps.emit(sessionId, { type: 'reasoning_delta', delta: event.delta })
          break
        case 'tool_call_start': {
          partial.set(event.index, { id: event.id, name: event.name, args: '' })
          this.deps.emit(sessionId, { type: 'tool_call_start', call: { id: event.id, name: event.name, arguments: '' } })
          break
        }
        case 'tool_call_delta': {
          const entry = partial.get(event.index)
          if (entry) {
            entry.args += event.delta
            this.deps.emit(sessionId, { type: 'tool_call_delta', id: entry.id, delta: event.delta })
          }
          break
        }
        case 'usage':
          usage = {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens
          }
          this.deps.emit(sessionId, {
            type: 'usage',
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            cachedTokens: event.cachedTokens
          })
          break
        case 'finish':
          finishReason = event.reason
          break
        case 'error':
          log.warn(`模型流式错误：${event.message}`)
          this.deps.emit(sessionId, { type: 'notice', level: 'warn', message: event.message })
          break
      }
    }

    const toolCalls: ToolCallRequest[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => ({ id: value.id, name: value.name, arguments: value.args || '{}' }))

    if (turn > 0 && finishReason === 'stop' && toolCalls.length > 0) finishReason = 'tool_calls'

    return { content, toolCalls, finishReason: aborted ? 'aborted' : finishReason, aborted, usage }
  }

  /** 执行工具调用：只读并行、写操作串行 */
  private async executeToolCalls(
    calls: ToolCallRequest[],
    sessionId: string,
    runtime: SessionRuntime,
    signal: AbortSignal,
    settings: McalSettings
  ): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>()
    const readOnly: ToolCallRequest[] = []
    const serial: ToolCallRequest[] = []
    for (const call of calls) {
      if (this.deps.registry.isReadOnly(call.name)) readOnly.push(call)
      else serial.push(call)
    }

    const runOne = async (call: ToolCallRequest): Promise<void> => {
      const args = safeParseArguments(call.arguments)
      if (args === null) {
        const output = `工具参数不是合法 JSON：${call.arguments.slice(0, 200)}`
        results.set(call.id, { ok: false, output })
        this.deps.emit(sessionId, { type: 'tool_result', callId: call.id, name: call.name, ok: false, output })
        return
      }

      // 权限判定
      const mode = this.effectivePermissionMode(settings, runtime, call.name)
      const verdict = this.deps.registry.resolvePermission(call.name, args, mode)
      if (verdict.denied) {
        results.set(call.id, { ok: false, output: verdict.denied })
        this.deps.emit(sessionId, { type: 'tool_result', callId: call.id, name: call.name, ok: false, output: verdict.denied })
        return
      }
      if (verdict.spec) {
        const requestId = `perm_${randomUUID().slice(0, 10)}`
        const request = this.deps.registry.buildPermissionRequest(call.id, call.name, verdict.spec, requestId)
        this.deps.emit(sessionId, { type: 'permission_request', request })
        const response = await new Promise<PermissionResponse>((resolve) => {
          runtime.pendingPermissions.set(requestId, resolve)
          // 中止时自动拒绝
          signal.addEventListener(
            'abort',
            () => {
              if (runtime.pendingPermissions.has(requestId)) {
                runtime.pendingPermissions.delete(requestId)
                resolve({ id: requestId, decision: 'deny', scope: 'once' })
              }
            },
            { once: true }
          )
        })
        if (response.decision === 'deny') {
          const output = `用户拒绝了本次操作（${call.name}）。请换一种方式，或向用户说明为什么需要执行它。`
          results.set(call.id, { ok: false, output })
          this.deps.emit(sessionId, { type: 'tool_result', callId: call.id, name: call.name, ok: false, output })
          return
        }
        if (response.scope === 'session') runtime.sessionAllows.add(call.name)
        if (response.scope === 'always') runtime.sessionAllows.add(`always:${call.name}`)
      }

      const context: ToolInvocationContext = {
        sessionId,
        roots: this.deps.getRoots(),
        requestPermission: async (req) => {
          const requestId = `perm_${randomUUID().slice(0, 10)}`
          this.deps.emit(sessionId, { type: 'permission_request', request: { ...req, id: requestId } })
          return new Promise<PermissionResponse>((resolve) => {
            runtime.pendingPermissions.set(requestId, resolve)
          })
        },
        emit: (event) => this.deps.emit(sessionId, event),
        abortSignal: signal,
        networkAllowed: settings.agent.networkToolsEnabled,
        services: this.deps.services
      }

      const started = Date.now()
      const result = await this.deps.registry.execute(call.name, args, context)
      const durationMs = Date.now() - started
      results.set(call.id, result)
      this.deps.emit(sessionId, {
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        ok: result.ok,
        output: result.output.length > 4000 ? `${result.output.slice(0, 4000)}\n…（已截断展示）` : result.output,
        meta: { ...asMetaRecord(result.meta), durationMs }
      })
    }

    // 只读工具并行（限制并发，避免同时打开过多文件）
    const concurrency = 4
    for (let i = 0; i < readOnly.length; i += concurrency) {
      const batch = readOnly.slice(i, i + concurrency)
      await Promise.all(batch.map((call) => runOne(call)))
    }
    for (const call of serial) {
      if (signal.aborted) break
      await runOne(call)
    }

    return results
  }

  private effectivePermissionMode(
    settings: McalSettings,
    runtime: SessionRuntime,
    toolName: string
  ): 'ask' | 'auto-safe' | 'auto-all' | 'readonly' {
    const mode = settings.agent.permissionMode ?? 'ask'
    if (runtime.sessionAllows.has(`always:${toolName}`) && mode !== 'readonly') return 'auto-all'
    if (runtime.sessionAllows.has(toolName) && mode !== 'readonly') {
      // 会话级授权：只对当前工具放开，其它工具仍按原策略
      return 'auto-all'
    }
    return mode
  }

  /* ------------------------- 辅助 ------------------------- */

  private getRuntime(sessionId: string): SessionRuntime {
    let runtime = this.runtime.get(sessionId)
    if (!runtime) {
      runtime = {
        controller: new AbortController(),
        running: false,
        queue: Promise.resolve(),
        todos: [],
        sessionAllows: new Set(),
        pendingPermissions: new Map()
      }
      this.runtime.set(sessionId, runtime)
    }
    return runtime
  }

  private async requireSession(sessionId: string): Promise<SessionRecord> {
    const cached = this.sessions.get(sessionId)
    if (cached) return cached
    const loaded = await this.deps.sessions.load(sessionId)
    if (!loaded) throw new Error(`会话不存在：${sessionId}`)
    this.sessions.set(sessionId, loaded)
    return loaded
  }

  private currentProviderSettings() {
    const settings = this.deps.getSettings()
    return settings.providers.find((p) => p.id === settings.agent.activeProviderId) ?? settings.providers[0] ?? null
  }

  private currentModelName(): string {
    return this.currentProviderSettings()?.model ?? 'unknown'
  }

  private contextWindow(): number {
    return this.currentProviderSettings()?.contextWindow ?? 128_000
  }

  /** 供 UI 计算上下文占用 */
  contextUsage(sessionId: string): { tokens: number; window: number } {
    const session = this.sessions.get(sessionId)
    if (!session) return { tokens: 0, window: this.contextWindow() }
    return {
      tokens: estimateConversationTokens(session.messages, this.deps.registry.definitions()),
      window: this.contextWindow()
    }
  }

  getTodos(sessionId: string): { id: string; content: string; status: string; note?: string }[] {
    return this.getRuntime(sessionId).todos
  }
}

function safeParseArguments(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    // 尝试修复常见问题：模型有时会多包一层引号
    try {
      const trimmed = raw.trim().replace(/^`+|`+$/g, '')
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* 放弃 */
    }
    return null
  }
}

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output
  const half = Math.floor(MAX_TOOL_OUTPUT_CHARS / 2)
  return `${output.slice(0, half)}\n\n…（中间省略 ${output.length - MAX_TOOL_OUTPUT_CHARS} 字符）…\n\n${output.slice(-half)}`
}

/** 工具的 meta 可能是任意结构，统一包成 record 供 UI 使用 */
function asMetaRecord(meta: unknown): Record<string, unknown> {
  if (meta === null || meta === undefined) return {}
  if (typeof meta === 'object' && !Array.isArray(meta)) return meta as Record<string, unknown>
  return { value: meta }
}

/** 把 provider 的 finish_reason 收敛到 UI 认识的值 */
function normalizeTurnEndReason(
  reason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error' | 'unknown' | 'content_filter'
): 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error' {
  if (reason === 'unknown' || reason === 'content_filter') return 'stop'
  return reason
}

export type { AgentServices }
