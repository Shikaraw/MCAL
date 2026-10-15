/**
 * OpenAI 兼容 Chat Completions Provider。
 * DeepSeek / Moonshot / 通义 / 本地 vLLM / Ollama(OpenAI 兼容层) 等都走这套协议。
 */

import type { ChatMessage, ToolDefinition } from '@shared/types'
import { logger } from '@core/util/logger'
import { sleep } from '@core/util/misc'
import {
  ProviderError,
  type ChatCompletionRequest,
  type ChatProvider,
  type ProviderCapabilities,
  type ProviderCompletion,
  type ProviderStreamEvent,
  type ProviderToolSchema
} from './types'

const log = logger.scoped('provider')

export interface OpenAiCompatibleOptions {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  capabilities?: Partial<ProviderCapabilities>
  /** 额外请求头 */
  headers?: Record<string, string>
  timeoutMs?: number
  /** 是否在请求体里带上 stream_options.include_usage（DeepSeek/OpenAI 支持） */
  includeUsage?: boolean
  /** 单次请求最大重试次数（仅对可重试错误） */
  retries?: number
}

/** 把消息转换成 OpenAI 协议格式（含 reasoning_content 与 tool_calls） */
export function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const msg of messages) {
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content ?? ''
      })
      continue
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' }
        }))
      })
      continue
    }
    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      const parts: Record<string, unknown>[] = []
      if (msg.content) parts.push({ type: 'text', text: msg.content })
      for (const att of msg.attachments) {
        if (att.kind === 'image' && (att.dataUrl || att.path)) {
          parts.push({ type: 'image_url', image_url: { url: att.dataUrl ?? att.path } })
        } else {
          parts.push({ type: 'text', text: `[附件] ${att.name}${att.path ? ` (${att.path})` : ''}` })
        }
      }
      out.push({ role: 'user', content: parts })
      continue
    }
    out.push({ role: msg.role, content: msg.content ?? '' })
  }
  return out
}

export function toOpenAiTools(tools: ToolDefinition[]): ProviderToolSchema[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>
    }
  }))
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: string
  readonly name: string
  readonly capabilities: ProviderCapabilities
  private baseUrl: string
  private apiKey: string
  private headers: Record<string, string>
  private timeoutMs: number
  private includeUsage: boolean
  private retries: number

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id
    this.name = options.name
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.headers = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.includeUsage = options.includeUsage ?? true
    this.retries = options.retries ?? 2
    this.capabilities = {
      tools: options.capabilities?.tools ?? true,
      vision: options.capabilities?.vision ?? false,
      reasoning: options.capabilities?.reasoning ?? false,
      promptCache: options.capabilities?.promptCache ?? false
    }
  }

  private endpoint(): string {
    // 允许用户填 https://api.deepseek.com 或 https://api.deepseek.com/v1 或完整路径
    if (/\/chat\/completions$/.test(this.baseUrl)) return this.baseUrl
    if (/\/v\d+$/.test(this.baseUrl)) return `${this.baseUrl}/chat/completions`
    return `${this.baseUrl}/v1/chat/completions`
  }

  private buildBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.messages),
      stream
    }
    if (this.capabilities.tools && request.tools && request.tools.length > 0) {
      body.tools = toOpenAiTools(request.tools)
      body.tool_choice = request.toolChoice ?? 'auto'
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (stream && this.includeUsage) body.stream_options = { include_usage: true }
    if (this.capabilities.reasoning && request.reasoning !== undefined) {
      // DeepSeek 的思考开关（不同网关字段名不同，做兼容透传）
      body.thinking = { type: request.reasoning ? 'enabled' : 'disabled' }
    }
    if (request.extra) Object.assign(body, request.extra)
    return body
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers
    }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  async *stream(request: ChatCompletionRequest): AsyncIterable<ProviderStreamEvent> {
    let attempt = 0
    for (;;) {
      attempt++
      try {
        yield* this.streamOnce(request)
        return
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const retryable = err instanceof ProviderError ? err.retryable : true
        if (!retryable || attempt > this.retries || request.signal?.aborted) {
          yield { type: 'error', message: error.message, retryable: false }
          return
        }
        const delay = Math.min(8000, 600 * Math.pow(2, attempt - 1))
        log.warn(`请求失败（第 ${attempt} 次），${delay}ms 后重试：${error.message}`)
        yield { type: 'error', message: `请求失败，${Math.round(delay / 1000)} 秒后重试：${error.message}`, retryable: true }
        await sleep(delay, request.signal)
      }
    }
  }

  private async *streamOnce(request: ChatCompletionRequest): AsyncIterable<ProviderStreamEvent> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('响应超时')), this.timeoutMs)
    const onAbort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(request, true)),
        signal: controller.signal
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const retryable = response.status >= 500 || response.status === 429 || response.status === 408
        throw new ProviderError(
          `模型请求失败：HTTP ${response.status} ${response.statusText}${text ? ` · ${text.slice(0, 300)}` : ''}`,
          response.status,
          retryable,
          text
        )
      }
      if (!response.body) throw new ProviderError('模型未返回响应体', undefined, true)

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      // 工具调用按 index 累积
      const toolAcc = new Map<number, { id: string; name: string }>()
      let finished = false

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (!line || line.startsWith(':')) continue
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            finished = true
            break
          }
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>
          } catch {
            continue
          }
          yield* this.handleChunk(parsed, toolAcc)
        }
        if (finished) break
      }

      // 处理残留（部分网关不发 [DONE]）
      if (!finished && buffer.trim().startsWith('data:')) {
        const payload = buffer.trim().slice(5).trim()
        if (payload && payload !== '[DONE]') {
          try {
            yield* this.handleChunk(JSON.parse(payload) as Record<string, unknown>, toolAcc)
          } catch {
            /* 忽略尾部残片 */
          }
        }
      }
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  private *handleChunk(
    parsed: Record<string, unknown>,
    toolAcc: Map<number, { id: string; name: string }>
  ): Generator<ProviderStreamEvent> {
    if (parsed.error) {
      const errObj = parsed.error as Record<string, unknown>
      const message = String(errObj.message ?? '模型返回错误')
      throw new ProviderError(message, undefined, false)
    }
    if (parsed.usage) {
      const usage = parsed.usage as Record<string, unknown>
      yield {
        type: 'usage',
        promptTokens: numOrUndef(usage.prompt_tokens),
        completionTokens: numOrUndef(usage.completion_tokens),
        totalTokens: numOrUndef(usage.total_tokens),
        cachedTokens:
          numOrUndef((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) ??
          numOrUndef(usage.prompt_cache_hit_tokens)
      }
    }

    const choices = parsed.choices as Record<string, unknown>[] | undefined
    if (!choices || choices.length === 0) return
    const choice = choices[0]
    const delta = choice.delta as Record<string, unknown> | undefined
    const finish = choice.finish_reason as string | null | undefined

    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'reasoning_delta', delta: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content) {
        yield { type: 'text_delta', delta: content }
      }
      const toolCalls = delta.tool_calls as Record<string, unknown>[] | undefined
      if (toolCalls) {
        for (const call of toolCalls) {
          const index = typeof call.index === 'number' ? call.index : 0
          const fn = call.function as Record<string, unknown> | undefined
          if (!toolAcc.has(index)) {
            const id = typeof call.id === 'string' ? call.id : `call_${index}_${Date.now().toString(36)}`
            toolAcc.set(index, { id, name: String(fn?.name ?? '') })
            yield { type: 'tool_call_start', index, id, name: String(fn?.name ?? '') }
          }
          const argsDelta = fn?.arguments
          if (typeof argsDelta === 'string' && argsDelta) {
            yield { type: 'tool_call_delta', index, delta: argsDelta }
          }
        }
      }
    }

    if (finish) {
      yield {
        type: 'finish',
        reason: normalizeFinish(finish)
      }
    }
  }

  async complete(request: ChatCompletionRequest): Promise<ProviderCompletion> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('响应超时')), this.timeoutMs)
    const onAbort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody({ ...request, toolChoice: request.toolChoice ?? 'auto' }, false)),
        signal: controller.signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ProviderError(`模型请求失败：HTTP ${response.status} · ${text.slice(0, 300)}`, response.status, response.status >= 500)
      }
      const json = (await response.json()) as Record<string, unknown>
      const choices = json.choices as Record<string, unknown>[] | undefined
      const choice = choices?.[0] ?? {}
      const message = (choice.message ?? {}) as Record<string, unknown>
      const usage = (json.usage ?? {}) as Record<string, unknown>
      const toolCalls = (message.tool_calls as Record<string, unknown>[] | undefined ?? []).map((call, index) => {
        const fn = (call.function ?? {}) as Record<string, unknown>
        return {
          id: typeof call.id === 'string' ? call.id : `call_${index}`,
          name: String(fn.name ?? ''),
          arguments: String(fn.arguments ?? '{}')
        }
      })
      return {
        content: typeof message.content === 'string' ? message.content : '',
        reasoning:
          typeof message.reasoning_content === 'string'
            ? message.reasoning_content
            : typeof message.reasoning === 'string'
              ? message.reasoning
              : undefined,
        toolCalls,
        finishReason: normalizeFinish(String(choice.finish_reason ?? 'stop')) as ProviderCompletion['finishReason'],
        usage: {
          promptTokens: numOrUndef(usage.prompt_tokens),
          completionTokens: numOrUndef(usage.completion_tokens),
          totalTokens: numOrUndef(usage.total_tokens),
          cachedTokens: numOrUndef((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens)
        }
      }
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  async ping(signal?: AbortSignal): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
    const started = Date.now()
    try {
      const result = await this.complete({
        messages: [{ role: 'user', content: 'ping' }],
        model: (await this.modelNameForPing()) ?? 'unknown',
        maxTokens: 4,
        signal
      })
      return { ok: true, message: `连接正常（模型返回：${(result.content || '(空)').slice(0, 40)}）`, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started }
    }
  }

  /** ping 时使用的模型名由外部注入（构造后设置） */
  private pingModel?: string

  setPingModel(model: string): void {
    this.pingModel = model
  }

  private async modelNameForPing(): Promise<string | undefined> {
    return this.pingModel
  }
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function normalizeFinish(reason: string): 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown' {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'unknown'
  }
}
