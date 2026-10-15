/**
 * 记忆库页面。
 *
 * 记忆库是「越用越聪明」的核心：诊断成功、用户确认过的解决过程会被记住，
 * 下次遇到同样报错时会先在这里召回，直接把上次有效的方案给出来。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MemoryRecord } from '@shared/types'
import { mcal } from '../lib/api'
import { formatDateTime, formatRelativeTime, loaderLabel } from '../lib/format'
import { reportError, toast } from '../state/store'
import { Badge, Button, Input, Modal, SearchInput, Stat, Switch, Textarea } from '../components/ui/primitives'
import { Markdown } from '../components/ui/Markdown'
import {
  IconAlert,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconWrench
} from '../components/ui/icons'

interface Stats {
  total: number
  verified: number
  topSymptoms: string[]
}

const ORIGIN_META: Record<MemoryRecord['origin'], { label: string; tone: 'default' | 'info' | 'violet' }> = {
  'auto-diagnose': { label: '自动诊断', tone: 'info' },
  agent: { label: '助手记录', tone: 'violet' },
  user: { label: '用户记录', tone: 'default' }
}

export function MemoryView(): React.JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null)
  const [records, setRecords] = useState<MemoryRecord[]>([])
  const [scores, setScores] = useState<Record<string, number>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])
  const [editing, setEditing] = useState<MemoryRecord | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<MemoryRecord | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [statsResult, list] = await Promise.all([mcal.memoryStats(), mcal.listMemory({ limit: 200 })])
      setStats(statsResult)
      setRecords(list)
      setScores({})
    } catch (error) {
      reportError(error, '读取记忆库失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runSearch = useCallback(async (text: string) => {
    setQuery(text)
    if (!text.trim()) {
      await load()
      return
    }
    setLoading(true)
    try {
      const hits = await mcal.searchMemory(text, 50)
      const map: Record<string, number> = {}
      for (const hit of hits) map[hit.record.id] = hit.score
      setScores(map)
      // 召回不到时保留全量列表，避免用户以为记忆库是空的
      setRecords(hits.length > 0 ? hits.map((hit) => hit.record) : await mcal.listMemory({ limit: 200 }))
    } catch (error) {
      reportError(error, '搜索记忆失败')
    } finally {
      setLoading(false)
    }
  }, [load])

  const toggleVerified = useCallback(async (record: MemoryRecord) => {
    try {
      const updated = await mcal.updateMemory(record.id, { verified: !record.verified })
      setRecords((list) => list.map((item) => (item.id === record.id ? updated : item)))
      void mcal.memoryStats().then(setStats)
      toast.ok(updated.verified ? '已标记为「验证有效」' : '已取消验证标记')
    } catch (error) {
      reportError(error, '更新失败')
    }
  }, [])

  const handleDelete = useCallback(async () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    try {
      await mcal.deleteMemory(target.id)
      setRecords((list) => list.filter((item) => item.id !== target.id))
      void mcal.memoryStats().then(setStats)
      toast.ok('记忆已删除')
    } catch (error) {
      reportError(error, '删除失败')
    }
  }, [deleteTarget])

  const handleSave = useCallback(
    async (draft: MemoryDraft, id?: string) => {
      if (!draft.problem.trim() || !draft.solution.trim()) {
        toast.warn('请填写问题与解决方案')
        return
      }
      try {
        if (id) {
          const updated = await mcal.updateMemory(id, {
            problem: draft.problem.trim(),
            cause: draft.cause.trim() || undefined,
            solution: draft.solution.trim(),
            symptoms: splitList(draft.symptoms),
            tags: splitList(draft.tags)
          })
          setRecords((list) => list.map((item) => (item.id === id ? updated : item)))
          toast.ok('记忆已更新')
        } else {
          const created = await mcal.writeMemory({
            problem: draft.problem.trim(),
            cause: draft.cause.trim() || undefined,
            solution: draft.solution.trim(),
            symptoms: splitList(draft.symptoms),
            tags: splitList(draft.tags),
            origin: 'user'
          })
          setRecords((list) => [created, ...list])
          toast.ok('已写入记忆库', '下次遇到相同症状时会优先召回')
        }
        setEditing(null)
        setCreating(false)
        void mcal.memoryStats().then(setStats)
      } catch (error) {
        reportError(error, '保存失败')
      }
    },
    []
  )

  const verifiedRatio = stats && stats.total > 0 ? stats.verified / stats.total : 0

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>记忆库</h2>
          <span className="fs-sm muted">
            记录你解决过的问题。下次遇到同样报错时，AI 会先在这里检索，直接给出上次有效的方案
          </span>
        </div>
        <div className="row gap-2">
          <Button icon={<IconRefresh size={14} />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            新增记忆
          </Button>
        </div>
      </div>

      <div className="page__body">
        {/* ------------------------------ 统计 ------------------------------ */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 14,
            marginBottom: 16
          }}
        >
          <div className="mcal-card" style={{ padding: 16 }}>
            <Stat label="记忆总条数" value={stats ? stats.total : '—'} hint="自动诊断会持续累积" />
          </div>
          <div className="mcal-card" style={{ padding: 16 }}>
            <Stat
              label="已验证有效"
              value={stats ? stats.verified : '—'}
              tone={verifiedRatio >= 0.5 ? 'ok' : undefined}
              hint={stats ? `占比 ${(verifiedRatio * 100).toFixed(0)}%` : undefined}
            />
          </div>
          <div className="mcal-card" style={{ padding: 16 }}>
            <div className="fs-xs muted" style={{ marginBottom: 6 }}>
              最常出现的症状
            </div>
            {stats && stats.topSymptoms.length > 0 ? (
              <div className="row gap-2 wrap">
                {stats.topSymptoms.slice(0, 6).map((symptom) => (
                  <button key={symptom} type="button" className="mcal-chip" onClick={() => void runSearch(symptom)}>
                    {symptom}
                  </button>
                ))}
              </div>
            ) : (
              <div className="fs-sm muted">还没有统计数据，先让 AI 诊断一次崩溃试试</div>
            )}
          </div>
        </div>

        {/* ------------------------------ 搜索 ------------------------------ */}
        <div className="row gap-2" style={{ marginBottom: 14 }}>
          <div className="grow" style={{ maxWidth: 420 }}>
            <SearchInput
              value={query}
              onChange={(value) => setQuery(value)}
              onEnter={() => void runSearch(query)}
              placeholder="搜索症状 / 报错关键词，例如：OutOfMemoryError、模组冲突"
            />
          </div>
          <Button onClick={() => void runSearch(query)}>搜索</Button>
          {query ? (
            <Button variant="ghost" onClick={() => void runSearch('')}>
              清除
            </Button>
          ) : null}
          {query ? <span className="fs-xs muted">共 {records.length} 条结果，列表按相关度排序</span> : null}
        </div>

        {/* ------------------------------ 列表 ------------------------------ */}
        {records.length === 0 && !loading ? (
          <div className="mcal-card" style={{ padding: 8 }}>
            <div className="mcal-empty">
              <div className="mcal-empty__icon">
                <IconBrain />
              </div>
              <div className="fs-md bold">记忆库还是空的</div>
              <div className="fs-sm muted" style={{ maxWidth: 520, lineHeight: 'var(--lh-relaxed)' }}>
                记忆库会自动记录你解决过的问题：AI 诊断出崩溃原因、你确认方案有效之后，它会连同报错特征一起存下来。
                下次再出现同样的报错，AI 会直接说「你上次也遇到过，这样做就好了」。
              </div>
              <div className="fs-sm muted" style={{ maxWidth: 520 }}>
                你也可以现在手动写入一条（例如从别处抄来的经验），或者先让 AI 分析一次崩溃日志。
              </div>
              <div className="row gap-2" style={{ marginTop: 4 }}>
                <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
                  手动新增
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="col gap-3 stagger">
            {records.map((record) => (
              <MemoryCard
                key={record.id}
                record={record}
                score={scores[record.id]}
                expanded={expanded.includes(record.id)}
                onToggle={() =>
                  setExpanded((list) => (list.includes(record.id) ? list.filter((id) => id !== record.id) : [...list, record.id]))
                }
                onVerify={() => void toggleVerified(record)}
                onEdit={() => setEditing(record)}
                onDelete={() => setDeleteTarget(record)}
              />
            ))}
            {loading ? <div className="skeleton" style={{ height: 90 }} /> : null}
          </div>
        )}
      </div>

      {/* ------------------------------ 编辑 / 新增 ------------------------------ */}
      <MemoryEditor
        open={creating || editing !== null}
        record={editing}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        onSave={(draft) => void handleSave(draft, editing?.id)}
      />

      {/* ------------------------------ 删除确认 ------------------------------ */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="删除这条记忆？"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => void handleDelete()}>
              删除
            </Button>
          </>
        }
      >
        <div className="col gap-2">
          <div className="fs-md">{deleteTarget?.problem}</div>
          <div className="fs-sm muted">删除后 AI 不会再召回这条经验。如果是记错了，建议直接编辑修正而不是删除。</div>
        </div>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  记忆卡片
 * ------------------------------------------------------------------ */

function MemoryCard({
  record,
  score,
  expanded,
  onToggle,
  onVerify,
  onEdit,
  onDelete
}: {
  record: MemoryRecord
  score?: number
  expanded: boolean
  onToggle: () => void
  onVerify: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const origin = ORIGIN_META[record.origin] ?? ORIGIN_META.user
  const context = record.context
  const contextBits = [
    context?.gameVersion ? `MC ${context.gameVersion}` : null,
    context?.loaderType ? loaderLabel(context.loaderType) : null,
    context?.instanceName ? `实例 ${context.instanceName}` : null,
    context?.javaMajor ? `Java ${context.javaMajor}` : null
  ].filter((item): item is string => Boolean(item))

  return (
    <div className="mcal-card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 16px' }}>
        <div className="row-start gap-3">
          <span
            className="center"
            style={{
              width: 30,
              height: 30,
              flexShrink: 0,
              borderRadius: 9,
              background: record.verified ? 'rgba(61,220,132,0.14)' : 'rgba(255,255,255,0.05)',
              color: record.verified ? 'var(--c-verdant)' : 'var(--c-text-muted)',
              border: '1px solid var(--c-hairline)'
            }}
          >
            {record.verified ? <IconCheck size={15} /> : <IconWrench size={15} />}
          </span>
          <div className="col grow gap-2" style={{ minWidth: 0 }}>
            <div className="row-between gap-3 wrap">
              <span className="fs-md bold selectable" style={{ lineHeight: 'var(--lh-tight)' }}>
                {record.problem}
              </span>
              <div className="row gap-2">
                {typeof score === 'number' ? <Badge tone="gold">相关度 {score.toFixed(1)}</Badge> : null}
                <Badge tone={origin.tone}>{origin.label}</Badge>
                {record.verified ? <Badge tone="ok">已验证</Badge> : null}
              </div>
            </div>

            {record.symptoms.length > 0 ? (
              <div className="row gap-2 wrap">
                {record.symptoms.map((symptom) => (
                  <span key={symptom} className="mcal-badge mono">
                    {symptom.length > 42 ? `${symptom.slice(0, 42)}…` : symptom}
                  </span>
                ))}
              </div>
            ) : null}

            {record.cause ? (
              <div className="fs-sm dim selectable">
                <span className="muted">根因：</span>
                {record.cause}
              </div>
            ) : null}

            {contextBits.length > 0 || (record.tags && record.tags.length > 0) ? (
              <div className="row gap-2 wrap fs-xs muted">
                {contextBits.map((bit) => (
                  <span key={bit} className="mcal-badge">
                    {bit}
                  </span>
                ))}
                {(record.tags ?? []).map((tag) => (
                  <span key={tag} className="mcal-badge">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}

            <button
              type="button"
              className="row gap-1 fs-sm accent"
              style={{ alignSelf: 'flex-start' }}
              onClick={onToggle}
            >
              {expanded ? '收起解决方案' : '查看解决方案'}
              <IconChevronDown size={13} style={{ transform: expanded ? 'none' : 'rotate(-90deg)', transition: 'transform var(--t-fast)' }} />
            </button>

            {expanded ? (
              <div className="anim-fade" style={{ marginTop: 2 }}>
                <Markdown content={record.solution} />
              </div>
            ) : null}

            <div className="row-between gap-3 wrap" style={{ marginTop: 2 }}>
              <div className="row gap-3 fs-xs muted">
                <span>命中 {record.hits} 次</span>
                <span>创建 {formatDateTime(record.createdAt)}</span>
                <span>更新 {formatRelativeTime(record.updatedAt)}</span>
              </div>
              <div className="row gap-2">
                <span className="row gap-2 fs-xs muted">
                  <Switch checked={record.verified} onChange={onVerify} label="验证有效" />
                  验证有效
                </span>
                <Button size="sm" variant="ghost" onClick={onEdit}>
                  编辑
                </Button>
                <Button size="sm" variant="ghost" icon={<IconTrash size={13} />} onClick={onDelete}>
                  删除
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  编辑弹窗
 * ------------------------------------------------------------------ */

interface MemoryDraft {
  problem: string
  cause: string
  solution: string
  symptoms: string
  tags: string
}

function MemoryEditor({
  open,
  record,
  onClose,
  onSave
}: {
  open: boolean
  record: MemoryRecord | null
  onClose: () => void
  onSave: (draft: MemoryDraft) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!open) return
    if (record) {
      setDraft({
        problem: record.problem,
        cause: record.cause ?? '',
        solution: record.solution,
        symptoms: record.symptoms.join(', '),
        tags: (record.tags ?? []).join(', ')
      })
    } else {
      setDraft(EMPTY_DRAFT)
    }
    setDirty(false)
  }, [open, record])

  const update = (patch: Partial<MemoryDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }))
    setDirty(true)
  }

  const valid = draft.problem.trim().length > 0 && draft.solution.trim().length > 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <span className="row gap-2">
          <IconSparkles size={16} className="accent" />
          {record ? '编辑记忆' : '新增记忆'}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!valid || (record ? !dirty : false)} onClick={() => onSave(draft)}>
            {record ? '保存修改' : '写入记忆库'}
          </Button>
        </>
      }
    >
      <div className="col gap-4">
        <label className="col gap-2">
          <span className="mcal-field__label">
            问题描述 <span className="err">*</span>
          </span>
          <Input
            value={draft.problem}
            onChange={(value) => update({ problem: value })}
            placeholder="例如：1.20.1 Fabric 启动时崩溃，报 NoClassDefFoundError"
          />
          <span className="mcal-field__hint">从用户视角描述症状，越具体越容易被召回</span>
        </label>

        <label className="col gap-2">
          <span className="mcal-field__label">症状关键词</span>
          <Input
            value={draft.symptoms}
            onChange={(value) => update({ symptoms: value })}
            placeholder="用英文逗号分隔，例如：NoClassDefFoundError, 启动崩溃, Fabric"
          />
          <span className="mcal-field__hint">这些关键词会参与检索。报错原文（异常类名等）写这里最有价值</span>
        </label>

        <label className="col gap-2">
          <span className="mcal-field__label">根因</span>
          <Input value={draft.cause} onChange={(value) => update({ cause: value })} placeholder="例如：缺少 Fabric API 前置模组" />
        </label>

        <label className="col gap-2">
          <span className="mcal-field__label">
            解决方案 <span className="err">*</span>
          </span>
          <Textarea
            value={draft.solution}
            onChange={(value) => update({ solution: value })}
            rows={8}
            placeholder={'支持 Markdown，建议写成步骤：\n1. 下载 Fabric API 并放进 mods 目录\n2. 确认版本与游戏版本一致'}
          />
        </label>

        <label className="col gap-2">
          <span className="mcal-field__label">标签</span>
          <Input value={draft.tags} onChange={(value) => update({ tags: value })} placeholder="用英文逗号分隔，例如：依赖缺失, 模组" />
        </label>

        {!valid ? (
          <div className="row gap-2 fs-xs warn">
            <IconAlert size={13} />
            问题描述与解决方案为必填项
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

const EMPTY_DRAFT: MemoryDraft = { problem: '', cause: '', solution: '', symptoms: '', tags: '' }

function splitList(text: string): string[] {
  return text
    .split(/[,，;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
