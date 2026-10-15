/**
 * 记忆系统：把「用户遇到的问题 + 解决方案」沉淀成可复用的知识。
 *
 * 设计要点：
 * - 与知识库（静态事实）分离：记忆是「这台机器上真实发生过的事」，
 *   因此检索时上下文匹配（同版本/同加载器）权重很高。
 * - 用症状关键词 + 数据版本/加载器作为召回信号，不依赖外部嵌入模型，
 *   保证离线可用；接口留了 embedding 扩展点。
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { DiagnosticReport, Instance, LoaderType, MemoryRecord } from '@shared/types'
import { logger } from '@core/util/logger'
import { readJsonSafe, writeFileAtomic, ensureDir } from '@core/util/fsx'
import { sleep } from '@core/util/misc'

const log = logger.scoped('memory')

interface MemoryFile {
  version: number
  records: MemoryRecord[]
}

const FILE_VERSION = 1

/** 中文/英文混合的轻量分词，与知识库保持一致的思路（但更简单，因为记忆条目很短） */
export function tokenizeMemory(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9_.\-]{2,}/g)) {
    const token = match[0]
    tokens.push(token)
    // 形如 java.lang.OutOfMemoryError 的类名，补充末段
    if (token.includes('.')) {
      const parts = token.split('.')
      tokens.push(parts[parts.length - 1])
      tokens.push(parts[parts.length - 2] ?? '')
    }
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const chunk = match[0]
    for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2))
    if (chunk.length >= 3) for (let i = 0; i < chunk.length - 2; i++) tokens.push(chunk.slice(i, i + 3))
  }
  return tokens.filter(Boolean)
}

export interface MemorySearchResult {
  record: MemoryRecord
  score: number
}

export interface MemoryStoreOptions {
  /** 存储文件路径（默认 <root>/agent/memory.json） */
  file: string
  /** 写入节流（ms），避免频繁落盘 */
  flushDelayMs?: number
}

export class MemoryStore {
  private file: string
  private records: MemoryRecord[] = []
  private loaded = false
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null
  private flushDelayMs: number
  private index = new Map<string, Set<string>>()
  private docTokens = new Map<string, string[]>()

  constructor(options: MemoryStoreOptions) {
    this.file = options.file
    this.flushDelayMs = options.flushDelayMs ?? 400
  }

  async load(): Promise<MemoryRecord[]> {
    const data = await readJsonSafe<MemoryFile>(this.file, { version: FILE_VERSION, records: [] })
    this.records = Array.isArray(data.records) ? data.records : []
    this.loaded = true
    this.rebuildIndex()
    log.info(`已加载 ${this.records.length} 条记忆`)
    return this.records
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  private rebuildIndex(): void {
    this.index.clear()
    this.docTokens.clear()
    for (const record of this.records) {
      const tokens = this.tokensOf(record)
      this.docTokens.set(record.id, tokens)
      for (const token of new Set(tokens)) {
        let bucket = this.index.get(token)
        if (!bucket) {
          bucket = new Set()
          this.index.set(token, bucket)
        }
        bucket.add(record.id)
      }
    }
  }

  private tokensOf(record: MemoryRecord): string[] {
    const parts = [
      record.problem,
      record.symptoms.join(' '),
      record.cause ?? '',
      record.solution,
      (record.tags ?? []).join(' '),
      record.context?.gameVersion ?? '',
      record.context?.loaderType ?? ''
    ]
    return tokenizeMemory(parts.join('\n'))
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.flushDelayMs)
    // 不阻塞进程退出
    this.flushTimer.unref?.()
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await ensureDir(dirname(this.file))
    await writeFileAtomic(this.file, JSON.stringify({ version: FILE_VERSION, records: this.records }, null, 2))
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  list(opts: { limit?: number; offset?: number } = {}): MemoryRecord[] {
    const sorted = [...this.records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const offset = opts.offset ?? 0
    return sorted.slice(offset, offset + (opts.limit ?? 200))
  }

  get(id: string): MemoryRecord | null {
    return this.records.find((r) => r.id === id) ?? null
  }

  /** 记忆检索：关键词命中 + 上下文匹配 + 验证加分 + 时间衰减 */
  search(
    query: string,
    opts: { limit?: number; context?: MemoryRecord['context'] } = {}
  ): MemorySearchResult[] {
    const queryTokens = tokenizeMemory(query)
    if (queryTokens.length === 0) return []
    const querySet = new Set(queryTokens)
    const results: MemorySearchResult[] = []
    const now = Date.now()

    for (const record of this.records) {
      const tokens = this.docTokens.get(record.id) ?? []
      if (tokens.length === 0) continue
      const docSet = new Set(tokens)
      let overlap = 0
      for (const token of querySet) if (docSet.has(token)) overlap++
      if (overlap === 0) continue

      // 归一化命中率 + 覆盖率，避免长条目刷分
      const precision = overlap / querySet.size
      const coverage = overlap / Math.min(docSet.size, 60)
      let score = precision * 2 + coverage

      // 上下文匹配（同版本 / 同加载器 / 同 Java）显著加分
      if (opts.context) {
        if (opts.context.gameVersion && record.context?.gameVersion === opts.context.gameVersion) score *= 1.35
        if (opts.context.loaderType && record.context?.loaderType === opts.context.loaderType) score *= 1.2
        if (opts.context.javaMajor && record.context?.javaMajor === opts.context.javaMajor) score *= 1.1
      }
      // 验证过的方案更可信
      if (record.verified) score *= 1.25
      // 命中次数说明普适性
      score *= 1 + Math.min(0.3, record.hits * 0.02)
      // 时间衰减：1 年内线性衰减到 0.7
      const ageDays = (now - Date.parse(record.updatedAt || record.createdAt)) / 86_400_000
      if (Number.isFinite(ageDays) && ageDays > 0) {
        score *= Math.max(0.7, 1 - (ageDays / 365) * 0.3)
      }
      results.push({ record, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, opts.limit ?? 5)
  }

  /** 写入或合并：问题高度相似时合并方案而不是新增条目 */
  write(input: Partial<MemoryRecord> & { problem: string; solution: string }): MemoryRecord {
    const now = new Date().toISOString()
    const existing = this.findSimilar(input.problem)
    if (existing && !input.id) {
      // 合并：补充新信息，保留更完整的方案
      if (input.solution && !existing.solution.includes(input.solution)) {
        existing.solution = `${existing.solution}\n\n---\n\n补充方案（${now.slice(0, 10)}）：\n${input.solution}`
      }
      if (input.cause && !existing.cause) existing.cause = input.cause
      if (input.symptoms?.length) {
        existing.symptoms = [...new Set([...existing.symptoms, ...input.symptoms])]
      }
      if (input.tags?.length) existing.tags = [...new Set([...(existing.tags ?? []), ...input.tags])]
      if (input.verified) existing.verified = true
      if (input.context) existing.context = { ...existing.context, ...input.context }
      existing.updatedAt = now
      this.reindexRecord(existing)
      this.scheduleFlush()
      log.info(`合并已有记忆 ${existing.id}`)
      return existing
    }

    const record: MemoryRecord = {
      id: input.id ?? `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      problem: input.problem,
      symptoms: input.symptoms ?? deriveSymptoms(input.problem, input.solution),
      cause: input.cause,
      solution: input.solution,
      verified: input.verified ?? false,
      context: input.context,
      origin: input.origin ?? 'agent',
      hits: input.hits ?? 0,
      tags: input.tags,
      knowledgeIds: input.knowledgeIds
    }
    this.records.push(record)
    this.reindexRecord(record)
    this.scheduleFlush()
    log.info(`新增记忆 ${record.id}：${record.problem.slice(0, 40)}`)
    return record
  }

  update(id: string, patch: Partial<MemoryRecord>): MemoryRecord {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error(`记忆不存在：${id}`)
    Object.assign(record, patch, { id: record.id, updatedAt: new Date().toISOString() })
    this.reindexRecord(record)
    this.scheduleFlush()
    return record
  }

  remove(id: string): boolean {
    const index = this.records.findIndex((r) => r.id === id)
    if (index < 0) return false
    const [removed] = this.records.splice(index, 1)
    for (const token of new Set(this.docTokens.get(removed.id) ?? [])) {
      this.index.get(token)?.delete(removed.id)
    }
    this.docTokens.delete(removed.id)
    this.scheduleFlush()
    return true
  }

  /** 记录被引用（检索命中后调用，用于统计普适性） */
  markHit(ids: string[]): void {
    let changed = false
    for (const id of ids) {
      const record = this.records.find((r) => r.id === id)
      if (record) {
        record.hits++
        changed = true
      }
    }
    if (changed) this.scheduleFlush()
  }

  stats(): { total: number; verified: number; topSymptoms: string[] } {
    const counter = new Map<string, number>()
    for (const record of this.records) {
      for (const symptom of record.symptoms) counter.set(symptom, (counter.get(symptom) ?? 0) + 1)
    }
    return {
      total: this.records.length,
      verified: this.records.filter((r) => r.verified).length,
      topSymptoms: [...counter.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([symptom]) => symptom)
    }
  }

  private reindexRecord(record: MemoryRecord): void {
    const oldTokens = this.docTokens.get(record.id)
    if (oldTokens) {
      for (const token of new Set(oldTokens)) this.index.get(token)?.delete(record.id)
    }
    const tokens = this.tokensOf(record)
    this.docTokens.set(record.id, tokens)
    for (const token of new Set(tokens)) {
      let bucket = this.index.get(token)
      if (!bucket) {
        bucket = new Set()
        this.index.set(token, bucket)
      }
      bucket.add(record.id)
    }
  }

  /** 找出与给定问题高度相似（token 重合度 > 0.75）的已有记忆 */
  private findSimilar(problem: string): MemoryRecord | null {
    const tokens = new Set(tokenizeMemory(problem))
    if (tokens.size === 0) return null
    let best: { record: MemoryRecord; ratio: number } | null = null
    for (const record of this.records) {
      const docSet = new Set(this.docTokens.get(record.id) ?? [])
      let overlap = 0
      for (const token of tokens) if (docSet.has(token)) overlap++
      const ratio = overlap / tokens.size
      if (ratio >= 0.75 && (!best || ratio > best.ratio)) best = { record, ratio }
    }
    return best?.record ?? null
  }

  /**
   * 从一次诊断自动沉淀记忆。
   * 只有找到「有可执行步骤」的 finding 才记录，避免把噪音写入记忆。
   */
  recordDiagnosis(report: DiagnosticReport, opts?: { instance?: Instance; appliedFix?: string }): MemoryRecord | null {
    const significant = report.findings.filter((f) => f.severity !== 'info' && f.steps.length > 0)
    if (significant.length === 0) return null
    const primary = significant[0]
    const problem = `${primary.title}${significant.length > 1 ? `（等 ${significant.length} 个问题）` : ''}`
    const solution = [
      `诊断结论：${primary.detail}`,
      '',
      '处理步骤：',
      ...primary.steps.map((step, index) => `${index + 1}. ${step}`)
    ].join('\n')
    return this.write({
      problem,
      symptoms: [...new Set([...primary.evidence.map((e) => e.slice(0, 80)), ...significant.flatMap((f) => f.evidence.slice(0, 1).map((e) => e.slice(0, 80)))])].slice(0, 8),
      cause: primary.detail,
      solution,
      verified: false,
      origin: 'auto-diagnose',
      context: {
        instanceId: opts?.instance?.id,
        instanceName: opts?.instance?.name,
        gameVersion: report.gameVersion ?? opts?.instance?.versionId,
        loaderType: report.loaderType ?? opts?.instance?.loaderType
      },
      knowledgeIds: primary.knowledgeIds,
      tags: [primary.category, primary.id]
    })
  }

  /** 生成注入系统提示的记忆摘要（控制 token） */
  renderForPrompt(results: MemorySearchResult[], maxChars = 1600): string {
    if (results.length === 0) return ''
    const lines: string[] = ['## 相关历史经验（来自本机的记忆库，可能对当前问题有帮助）']
    let used = lines[0].length
    for (const { record, score } of results) {
      const head = `- [${record.id}] ${record.problem}${record.verified ? '（已验证）' : ''} · 相关度 ${score.toFixed(2)}`
      const body = record.solution.replace(/\n+/g, ' ').slice(0, 220)
      const block = `${head}\n  处理：${body}`
      if (used + block.length > maxChars) break
      lines.push(block)
      used += block.length
    }
    return lines.join('\n')
  }
}

function deriveSymptoms(problem: string, solution: string): string[] {
  const source = `${problem}\n${solution}`
  const out = new Set<string>()
  // 抽取错误类名、错误码、退出码
  for (const match of source.matchAll(/[a-z][a-z0-9]*(\.[a-z0-9_]+)*\.[A-Z][A-Za-z0-9_]*(Error|Exception|Throwable)/g)) {
    out.add(match[0])
  }
  for (const match of source.matchAll(/Exit Code:?\s*(-?\d+)/gi)) out.add(`Exit Code ${match[1]}`)
  for (const match of source.matchAll(/\b(0x[0-9A-Fa-f]{8})\b/g)) out.add(match[1])
  if (out.size === 0) out.add(problem.slice(0, 30))
  return [...out].slice(0, 8)
}

export function memoryFilePath(rootDir: string): string {
  return join(rootDir, 'agent', 'memory.json')
}

export { sleep }
export type { LoaderType }
