/**
 * 会话持久化：把对话历史存成 JSON 文件，支持列表/加载/删除。
 * 每个会话一个文件，便于增量写入与单文件损坏隔离。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/types'
import { logger } from '@core/util/logger'
import { ensureDir, pathExists, readJsonSafe, removePath, writeJson } from '@core/util/fsx'

const log = logger.scoped('session')

export interface SessionRecord {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** 使用的模型（记录以便回溯） */
  model?: string
  messages: ChatMessage[]
  /** 会话级待办 */
  todos?: { id: string; content: string; status: string; note?: string }[]
  /** 绑定的实例（对话上下文） */
  instanceId?: string
  /** 本会话的 token 统计 */
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number }
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: string
  messageCount: number
}

export class SessionStore {
  private dir: string

  constructor(opts: { dir: string }) {
    this.dir = opts.dir
  }

  private fileOf(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  async create(opts: { title?: string; instanceId?: string } = {}): Promise<SessionRecord> {
    const now = new Date().toISOString()
    const record: SessionRecord = {
      id: `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: opts.title ?? '新对话',
      createdAt: now,
      updatedAt: now,
      messages: [],
      instanceId: opts.instanceId
    }
    await this.save(record)
    return record
  }

  async load(id: string): Promise<SessionRecord | null> {
    const file = this.fileOf(id)
    if (!(await pathExists(file))) return null
    const record = await readJsonSafe<SessionRecord | null>(file, null)
    if (!record) return null
    return { ...record, messages: record.messages ?? [] }
  }

  async save(record: SessionRecord): Promise<void> {
    record.updatedAt = new Date().toISOString()
    await ensureDir(this.dir)
    await writeJson(this.fileOf(record.id), record)
  }

  async list(): Promise<SessionSummary[]> {
    if (!(await pathExists(this.dir))) return []
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(this.dir).catch(() => [])
    const summaries: SessionSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const record = await readJsonSafe<SessionRecord | null>(join(this.dir, entry), null)
      if (!record) continue
      summaries.push({
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        messageCount: record.messages?.length ?? 0
      })
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async remove(id: string): Promise<void> {
    await removePath(this.fileOf(id))
    log.info(`已删除会话 ${id}`)
  }

  /**
   * 用首条用户消息生成标题。
   * 不调用模型（省 token、避免延迟），用启发式截断即可。
   */
  static deriveTitle(firstUserMessage: string): string {
    const cleaned = firstUserMessage
      .replace(/```[\s\S]*?```/g, '（代码）')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) return '新对话'
    return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned
  }
}

export function sessionDir(rootDir: string): string {
  return join(rootDir, 'agent', 'sessions')
}
