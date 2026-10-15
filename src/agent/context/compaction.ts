/**
 * 上下文管理：token 估算与历史压缩。
 *
 * Minecraft 诊断场景的上下文特点是「又长又碎」：日志片段、mod 清单、
 * 崩溃报告。因此估算必须偏保守（宁可早压缩），压缩必须保留结构化信息
 * （版本号、报错类名、文件路径），否则 Agent 会失去判断依据。
 */

import type { ChatMessage, ToolDefinition } from '@shared/types'
import type { ChatProvider } from '@agent/provider/types'
import { logger } from '@core/util/logger'

const log = logger.scoped('context')

/** 估算文本 token 数（CJK 与 ASCII 权重不同，偏保守 = 高估） */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0
  let cjk = 0
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x2e80 && code <= 0x9fff) cjk++
    else if (code < 0x80) ascii++
    else other++
  }
  // 中文约 1 字 ≈ 0.7 token；ASCII 约 4 字符 ≈ 1 token；其它按 1 字符 ≈ 1 token
  return Math.ceil(cjk * 0.7 + ascii / 4 + other)
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = estimateTokens(typeof message.content === 'string' ? message.content : '') + 6
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name) + estimateTokens(call.arguments) + 10
    }
  }
  if (message.attachments) {
    for (const att of message.attachments) {
      // 图片按视觉 token 粗估
      total += att.kind === 'image' ? 800 : estimateTokens(att.name) + 20
    }
  }
  return total
}

export function estimateConversationTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  if (tools) {
    // 工具定义的 schema 也占 token，经验值：每个工具约 120 token
    total += tools.length * 120
  }
  return total
}

export interface CompactionOptions {
  /** 触发压缩的 token 阈值 */
  threshold: number
  /** 保留的最近消息条数（不参与压缩） */
  keepRecent: number
  /** 模型上下文窗口（用于计算剩余空间） */
  contextWindow: number
  /** 为响应预留的 token */
  reserveForResponse: number
  provider?: ChatProvider
  model?: string
  signal?: AbortSignal
}

export interface CompactionResult {
  messages: ChatMessage[]
  removed: number
  summary: string
  /** 压缩后的 token 估算 */
  tokens: number
  usedProvider: boolean
}

/** 需要压缩吗 */
export function needsCompaction(messages: ChatMessage[], tools: ToolDefinition[] | undefined, options: CompactionOptions): boolean {
  const tokens = estimateConversationTokens(messages, tools)
  const budget = Math.min(options.threshold, options.contextWindow - options.reserveForResponse)
  return tokens > budget
}

/**
 * 压缩历史：
 * 1. 切出「旧消息」与「最近消息」；
 * 2. 旧消息优先用模型生成结构化摘要（保留报错、版本号、文件路径、结论）；
 * 3. 模型不可用/失败时退化为启发式摘要（抽取关键行），保证功能不中断。
 */
export async function compactConversation(
  messages: ChatMessage[],
  options: CompactionOptions
): Promise<CompactionResult> {
  const systemMessages = messages.filter((m) => m.role === 'system')
  const conversation = messages.filter((m) => m.role !== 'system')
  if (conversation.length <= options.keepRecent) {
    return {
      messages,
      removed: 0,
      summary: '',
      tokens: estimateConversationTokens(messages),
      usedProvider: false
    }
  }
  const splitAt = conversation.length - options.keepRecent

  // 保证不切断 tool_call / tool 消息对：向前回溯到安全的切分点
  let safeSplit = splitAt
  while (safeSplit > 0) {
    const msg = conversation[safeSplit - 1]
    const next = conversation[safeSplit]
    if (msg.role === 'assistant' && msg.toolCalls?.length && next?.role === 'tool') {
      safeSplit-- // 把 assistant 一起移到「最近」一侧，或继续前移
      continue
    }
    if (msg.role === 'tool') {
      safeSplit--
      continue
    }
    break
  }

  const oldMessages = conversation.slice(0, safeSplit)
  const recentMessages = conversation.slice(safeSplit)
  if (oldMessages.length === 0) {
    return { messages, removed: 0, summary: '', tokens: estimateConversationTokens(messages), usedProvider: false }
  }

  let summary = ''
  let usedProvider = false
  if (options.provider && options.model) {
    try {
      summary = await summarizeWithModel(oldMessages, options)
      usedProvider = true
    } catch (err) {
      log.warn(`模型摘要失败，回退启发式摘要：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!summary) summary = summarizeHeuristically(oldMessages)

  const summaryMessage: ChatMessage = {
    role: 'system',
    content: `## 早前对话的压缩摘要（原始 ${oldMessages.length} 条消息已省略）\n${summary}`,
    compacted: true,
    createdAt: Date.now()
  }

  const result = [...systemMessages, summaryMessage, ...recentMessages]
  const tokens = estimateConversationTokens(result)
  log.info(`上下文压缩：省略 ${oldMessages.length} 条消息，${estimateConversationTokens(messages)} → ${tokens} token`)
  return { messages: result, removed: oldMessages.length, summary, tokens, usedProvider }
}

async function summarizeWithModel(messages: ChatMessage[], options: CompactionOptions): Promise<string> {
  const transcript = renderTranscript(messages)
  const completion = await options.provider!.complete({
    model: options.model!,
    temperature: 0.2,
    maxTokens: 1200,
    toolChoice: 'none',
    signal: options.signal,
    messages: [
      {
        role: 'system',
        content: [
          '你是对话压缩器。把 Minecraft 启动器助手的对话历史压缩成结构化摘要，供后续继续工作。',
          '必须保留（不要丢失或改写）：',
          '- 用户的目标与已确认的结论',
          '- 涉及的游戏版本、加载器、Java 版本、内存参数等具体数值',
          '- 报错原文关键片段（异常类名、错误码、崩溃报告 Description）',
          '- 文件路径、mod 名称与版本',
          '- 已经尝试过并失败的方案（避免重复建议）',
          '- 尚未完成的任务与下一步计划',
          '用简体中文，Markdown 小标题 + 要点列表，控制在 600 字以内。不要寒暄。'
        ].join('\n')
      },
      { role: 'user', content: `请压缩以下对话历史：\n\n${transcript}` }
    ]
  })
  return completion.content.trim()
}

function renderTranscript(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      parts.push(`[工具结果 ${message.name ?? ''}] ${truncate(message.content ?? '', 1200)}`)
      continue
    }
    if (message.role === 'assistant') {
      const calls = message.toolCalls?.map((c) => `${c.name}(${truncate(c.arguments, 200)})`).join(', ')
      parts.push(`[助手] ${truncate(message.content ?? '', 1500)}${calls ? `\n[调用工具] ${calls}` : ''}`)
      continue
    }
    parts.push(`[${message.role === 'user' ? '用户' : '系统'}] ${truncate(message.content ?? '', 2000)}`)
  }
  return parts.join('\n\n')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断 ${text.length - max} 字）` : text
}

/** 无模型时的启发式摘要：保留报错与结论行 */
export function summarizeHeuristically(messages: ChatMessage[]): string {
  const keyLine = /(Exception|Error|Caused by|Exit Code|FAILED|failed|crash|崩溃|错误|无法|失败|修复|解决|版本|java|Java|loader|forge|fabric)/
  const picked: string[] = []
  for (const message of messages) {
    const text = message.content ?? ''
    if (!text) continue
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (keyLine.test(trimmed) && trimmed.length > 8) {
        picked.push(trimmed.slice(0, 200))
      }
    }
  }
  const unique = [...new Set(picked)]
  const limited = unique.slice(-60)
  const toolSummary = messages
    .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    .flatMap((m) => m.toolCalls!.map((c) => c.name))
  const toolCounts = new Map<string, number>()
  for (const name of toolSummary) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
  return [
    `- 已省略 ${messages.length} 条历史消息（无模型可用时的启发式摘要）`,
    toolCounts.size > 0
      ? `- 期间调用过的工具：${[...toolCounts.entries()].map(([name, count]) => `${name}×${count}`).join('、')}`
      : '',
    limited.length > 0 ? `- 关键信息摘录：\n${limited.map((l) => `  - ${l}`).join('\n')}` : '- 未提取到关键行'
  ]
    .filter(Boolean)
    .join('\n')
}
