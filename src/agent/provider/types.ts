/** 模型 Provider 抽象：所有实现对上层暴露统一的流式接口。 */

import type { ChatMessage, ToolDefinition } from '@shared/types'

export interface ProviderToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatCompletionRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  model: string
  temperature?: number
  maxTokens?: number
  /** 是否要求模型必须调用工具 */
  toolChoice?: 'auto' | 'none' | 'required'
  /** 是否启用深度思考（部分模型支持） */
  reasoning?: boolean
  signal?: AbortSignal
  /** 请求级额外参数（透传给 provider） */
  extra?: Record<string, unknown>
}

export type ProviderStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; delta: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown' }
  | { type: 'error'; message: string; retryable: boolean }

export interface ProviderCapabilities {
  tools: boolean
  vision: boolean
  reasoning: boolean
  promptCache: boolean
}

/** 一次完整的模型响应（非流式场景用） */
export interface ProviderCompletion {
  content: string
  reasoning?: string
  toolCalls: { id: string; name: string; arguments: string }[]
  finishReason: ProviderStreamEvent extends { type: 'finish'; reason: infer R } ? R : string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
}

export interface ChatProvider {
  readonly id: string
  readonly name: string
  readonly capabilities: ProviderCapabilities
  /** 流式对话 */
  stream(request: ChatCompletionRequest): AsyncIterable<ProviderStreamEvent>
  /** 非流式对话（用于内部摘要、意图分类等轻量调用） */
  complete(request: ChatCompletionRequest): Promise<ProviderCompletion>
  /** 连通性测试 */
  ping(signal?: AbortSignal): Promise<{ ok: boolean; message: string; latencyMs?: number }>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly body?: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
