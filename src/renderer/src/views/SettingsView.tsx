/**
 * 设置页。
 *
 * 分组：AI 模型 / 生图模型 / 下载 / Java / 账号 / 外观 / 关于
 *
 * 约定：所有「开关类」改动即时保存（乐观更新由 store 负责），
 * 文本框类改动走「保存」按钮，避免用户每敲一个字就写一次磁盘。
 * 另外 store 的 update() 只做顶层浅合并，所以这里一律传完整的子对象，
 * 保证乐观状态不丢字段。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Account,
  ImageProviderSettings,
  McalSettings,
  ProviderSettings,
  SystemInfo
} from '@shared/types'
import { mcal } from '../lib/api'
import { formatBytes, formatNumber } from '../lib/format'
import { reportError, toast, useInstances, useSettings, useSystem, useView } from '../state/store'
import { Badge, Button, Field, Input, Modal, Segmented, Select, Switch, Tabs, Textarea } from '../components/ui/primitives'
import {
  IconAlert,
  IconCheck,
  IconCoffee,
  IconDownload,
  IconExternal,
  IconFolder,
  IconImage,
  IconInfo,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash
} from '../components/ui/icons'

type SettingsTab = 'ai' | 'image' | 'download' | 'java' | 'account' | 'appearance' | 'about'

const TABS: { value: SettingsTab; label: string }[] = [
  { value: 'ai', label: 'AI 模型' },
  { value: 'image', label: '生图模型' },
  { value: 'download', label: '下载' },
  { value: 'java', label: 'Java' },
  { value: 'account', label: '账号' },
  { value: 'appearance', label: '外观' },
  { value: 'about', label: '关于' }
]

function normalizeTab(value: unknown): SettingsTab {
  return TABS.some((tab) => tab.value === value) ? (value as SettingsTab) : 'ai'
}

export function SettingsView(): React.JSX.Element {
  const params = useView((state) => state.params)
  const settings = useSettings((state) => state.settings)
  const loading = useSettings((state) => state.loading)
  const load = useSettings((state) => state.load)
  const [tab, setTab] = useState<SettingsTab>(() => normalizeTab(params.tab))

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>设置</h2>
          <span className="fs-sm muted">模型、下载、Java、账号与外观</span>
        </div>
        <Button icon={<IconRefresh size={14} />} loading={loading} onClick={() => void load()}>
          重新读取
        </Button>
      </div>

      <div className="page__body">
        <Tabs value={tab} onChange={setTab} options={TABS} />
        <div style={{ marginTop: 16, paddingBottom: 24 }}>
          {!settings ? (
            <div className="col gap-3">
              <div className="skeleton" style={{ height: 120 }} />
              <div className="skeleton" style={{ height: 180 }} />
            </div>
          ) : (
            <>
              {tab === 'ai' ? <AgentTab settings={settings} /> : null}
              {tab === 'image' ? <ImageTab settings={settings} /> : null}
              {tab === 'download' ? <DownloadTab settings={settings} /> : null}
              {tab === 'java' ? <JavaTab settings={settings} /> : null}
              {tab === 'account' ? <AccountTab settings={settings} /> : null}
              {tab === 'appearance' ? <AppearanceTab settings={settings} /> : null}
              {tab === 'about' ? <AboutTab settings={settings} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  通用块
 * ------------------------------------------------------------------ */

function Section({
  title,
  description,
  extra,
  children
}: {
  title: string
  description?: string
  extra?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mcal-card" style={{ padding: 18, marginBottom: 16 }}>
      <div className="row-between gap-3 wrap" style={{ marginBottom: 8 }}>
        <div className="col gap-1">
          <span className="fs-md bold">{title}</span>
          {description ? (
            <span className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)', maxWidth: 720 }}>
              {description}
            </span>
          ) : null}
        </div>
        {extra}
      </div>
      <div className="mcal-divider" style={{ marginBottom: 4 }} />
      {children}
    </div>
  )
}

function Row({
  title,
  hint,
  wide,
  children
}: {
  title: string
  hint?: string
  wide?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="row-between gap-5 wrap" style={{ padding: '10px 0' }}>
      <div className="col gap-1" style={{ minWidth: 240, flex: 1 }}>
        <span className="fs-sm">{title}</span>
        {hint ? (
          <span className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
            {hint}
          </span>
        ) : null}
      </div>
      <div style={{ flex: wide ? '1 1 380px' : '0 1 300px', minWidth: 220, maxWidth: wide ? 640 : undefined }}>
        {children}
      </div>
    </div>
  )
}

function NumberSlider({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hint
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  unit?: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="col gap-2" style={{ width: '100%' }}>
      <div className="row gap-3">
        <input
          className="mcal-slider grow"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <input
          className="mcal-input mono"
          style={{ width: 92, textAlign: 'right' }}
          value={String(value)}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value.replace(/[^0-9]/g, ''), 10)
            if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)))
          }}
        />
        {unit ? <span className="fs-xs muted" style={{ width: 34 }}>{unit}</span> : null}
      </div>
      {hint ? <span className="fs-xs muted">{hint}</span> : null}
    </div>
  )
}

/* ================================================================== *
 *  AI 模型
 * ================================================================== */

const PERMISSION_MODES: { value: McalSettings['agent']['permissionMode']; label: string; risk: string }[] = [
  { value: 'ask', label: '每次询问', risk: '最安全：每个工具调用都弹窗确认。刚开始用 AI 助手时建议保持这个。' },
  {
    value: 'auto-safe',
    label: '自动批准安全操作',
    risk: '推荐：读日志 / 扫描模组 / 检索知识库等只读操作自动执行；写文件、执行命令、装加载器仍会询问。'
  },
  { value: 'auto-all', label: '全部自动', risk: '风险自负：不再弹窗，包括删除文件与执行任意命令。只在你完全信任模型与提示词时使用。' },
  { value: 'readonly', label: '只读', risk: '最保守：只允许查询类工具，任何写操作直接拒绝。适合只让它诊断分析、不想让它动文件。' }
]

function AgentTab({ settings }: { settings: McalSettings }): React.JSX.Element {
  const update = useSettings((state) => state.update)
  const [providers, setProviders] = useState<ProviderSettings[]>(settings.providers)
  const [presets, setPresets] = useState<Awaited<ReturnType<typeof mcal.agentPresets>>>([])
  const [showPresets, setShowPresets] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderSettings | null>(null)

  const agent = settings.agent

  const patchAgent = useCallback(
    (patch: Partial<McalSettings['agent']>) => {
      void update({ agent: { ...agent, ...patch } })
    },
    [agent, update]
  )

  // 外部（比如 Agent 页保存）更新了 providers 时同步一次
  useEffect(() => {
    setProviders(settings.providers)
  }, [settings.providers])

  useEffect(() => {
    void mcal
      .agentPresets()
      .then(setPresets)
      .catch(() => undefined)
  }, [])

  const activeId = agent.activeProviderId ?? providers[0]?.id

  const saveProviders = useCallback(
    async (next: ProviderSettings[], message: string) => {
      setProviders(next)
      await update({ providers: next })
      toast.ok(message)
    },
    [update]
  )

  const addFromPreset = useCallback(
    async (preset: (typeof presets)[number]) => {
      let id = preset.id
      let suffix = 1
      while (providers.some((provider) => provider.id === id)) {
        suffix += 1
        id = `${preset.id}-${suffix}`
      }
      const provider: ProviderSettings = {
        id,
        name: preset.name,
        baseUrl: preset.baseUrl,
        apiKey: '',
        model: preset.model,
        supportsTools: preset.supportsTools,
        supportsVision: preset.supportsVision,
        supportsReasoning: preset.supportsReasoning,
        supportsPromptCache: preset.supportsPromptCache,
        temperature: 0.3,
        contextWindow: 128_000
      }
      const next = [...providers, provider]
      setShowPresets(false)
      await saveProviders(next, `已添加 ${preset.name}，填入 API Key 即可使用`)
      if (!agent.activeProviderId) patchAgent({ activeProviderId: id })
    },
    [agent.activeProviderId, patchAgent, providers, saveProviders]
  )

  const removeProvider = useCallback(
    async (provider: ProviderSettings) => {
      setDeleteTarget(null)
      const next = providers.filter((item) => item.id !== provider.id)
      const patch: Partial<McalSettings> = { providers: next }
      if (agent.activeProviderId === provider.id) patch.agent = { ...agent, activeProviderId: next[0]?.id }
      setProviders(next)
      await update(patch)
      toast.ok('已删除服务商配置')
    },
    [agent, providers, update]
  )

  const current = PERMISSION_MODES.find((mode) => mode.value === agent.permissionMode) ?? PERMISSION_MODES[0]

  return (
    <div className="col">
      <Section
        title="模型服务商"
        description="支持所有 OpenAI 兼容接口（DeepSeek / Kimi / 智谱 / 通义 / 硅基流动 / OpenRouter），也支持本地 Ollama 与 LM Studio。API Key 只保存在本机设置文件里。"
        extra={
          <div className="row gap-2">
            <Button size="sm" icon={<IconPlus size={13} />} onClick={() => setShowPresets(true)}>
              从预设添加
            </Button>
          </div>
        }
      >
        {providers.length === 0 ? (
          <div className="col gap-3" style={{ padding: '14px 0' }}>
            <div className="fs-sm muted">还没有任何服务商。点右上角「从预设添加」，选一个（推荐 DeepSeek，便宜且工具调用稳）。</div>
            <Button variant="primary" size="sm" icon={<IconSparkles size={13} />} onClick={() => setShowPresets(true)}>
              从预设添加
            </Button>
          </div>
        ) : (
          <div className="col gap-3 stagger" style={{ paddingTop: 6 }}>
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                preset={presets.find((item) => item.id === provider.id || provider.id.startsWith(`${item.id}-`))}
                active={provider.id === activeId}
                onSetActive={() => patchAgent({ activeProviderId: provider.id })}
                onSave={async (next) => {
                  await saveProviders(
                    providers.map((item) => (item.id === provider.id ? next : item)),
                    '服务商配置已保存'
                  )
                }}
                onDelete={() => setDeleteTarget(provider)}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Agent 行为" description="这些设置决定 AI 助手能动你电脑上的哪些东西，以及上下文与记忆的使用方式。">
        <Row title="权限模式" hint={current.risk}>
          <Segmented
            value={agent.permissionMode}
            onChange={(value) => patchAgent({ permissionMode: value })}
            options={PERMISSION_MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
          />
        </Row>
        <div className="fs-xs muted" style={{ marginTop: -4, paddingBottom: 6, lineHeight: 'var(--lh-relaxed)' }}>
          {PERMISSION_MODES.map((mode) => (
            <div key={mode.value} style={{ marginTop: 2 }}>
              <span className={agent.permissionMode === mode.value ? 'accent bold' : 'bold'}>{mode.label}：</span>
              {mode.risk}
            </div>
          ))}
        </div>

        <Row title="允许执行命令（shell）" hint="关闭后 run_command 会被拒绝：适合只想让它读写文件、不想让它跑任意命令的场景。">
          <div className="row gap-2">
            <Switch checked={agent.shellEnabled} onChange={(value) => patchAgent({ shellEnabled: value })} label="允许执行命令" />
            <span className="fs-sm muted">{agent.shellEnabled ? '已开启' : '已关闭'}</span>
          </div>
        </Row>

        <Row title="允许网络工具" hint="开启后助手可以联网检索资料、查询版本信息与下载依赖。">
          <div className="row gap-2">
            <Switch checked={agent.networkToolsEnabled} onChange={(value) => patchAgent({ networkToolsEnabled: value })} label="允许网络" />
            <span className="fs-sm muted">{agent.networkToolsEnabled ? '已开启' : '已关闭'}</span>
          </div>
        </Row>

        <Row title="启用记忆库" hint="把解决过的问题记下来，之后自动召回。强烈建议保持开启，这是它越用越聪明的原因。">
          <div className="row gap-2">
            <Switch checked={agent.memoryEnabled} onChange={(value) => patchAgent({ memoryEnabled: value })} label="启用记忆" />
            <span className="fs-sm muted">{agent.memoryEnabled ? '已开启' : '已关闭'}</span>
          </div>
        </Row>

        <Row title="每次注入的记忆条数" hint="注入太多会挤占上下文，4 条通常够用。">
          <NumberSlider
            value={agent.memoryRecallLimit}
            onChange={(value) => patchAgent({ memoryRecallLimit: value })}
            min={0}
            max={10}
            unit="条"
          />
        </Row>

        <Row title="注入知识库检索结果" hint="回答技术问题时先检索内置知识库，显著降低胡编概率。">
          <div className="row gap-2">
            <Switch checked={agent.knowledgeEnabled} onChange={(value) => patchAgent({ knowledgeEnabled: value })} label="启用知识库" />
            <span className="fs-sm muted">{agent.knowledgeEnabled ? '已开启' : '已关闭'}</span>
          </div>
        </Row>

        <Row title="单次请求最大工具轮数" hint="一轮 = 模型调用一次工具并拿到结果。复杂任务（诊断→改配置→验证）通常需要 5~15 轮。">
          <NumberSlider
            value={agent.maxTurnsPerRequest}
            onChange={(value) => patchAgent({ maxTurnsPerRequest: value })}
            min={1}
            max={60}
            unit="轮"
          />
        </Row>

        <Row
          title="上下文压缩阈值"
          hint={`对话历史超过这个 token 量时会自动摘要压缩（约等于 ${Math.round((agent.compactionThreshold * 2) / 1024)} KB 文本）。太小会频繁压缩丢细节，太大容易超出模型窗口。`}
        >
          <NumberSlider
            value={agent.compactionThreshold}
            onChange={(value) => patchAgent({ compactionThreshold: value })}
            min={20_000}
            max={400_000}
            step={5_000}
            unit="tok"
          />
        </Row>

        <Row title="自定义系统提示" wide hint="会追加到内置系统提示之后，优先级更高。适合写「回答用中文、别废话」这类偏好。">
          <Textarea
            value={agent.systemPromptExtra ?? ''}
            onChange={(value) => patchAgent({ systemPromptExtra: value })}
            rows={4}
            placeholder="例如：回答尽量简短；涉及版本号时必须先确认我的实例版本。"
          />
        </Row>
      </Section>

      {/* 预设选择 */}
      <Modal
        open={showPresets}
        onClose={() => setShowPresets(false)}
        wide
        title={
          <span className="row gap-2">
            <IconSparkles size={16} className="accent" />
            从预设添加服务商
          </span>
        }
      >
        <div className="col gap-2 stagger">
          {presets.map((preset) => (
            <div key={preset.id} className="mcal-panel" style={{ padding: '12px 14px' }}>
              <div className="row-between gap-3 wrap">
                <div className="col gap-1" style={{ minWidth: 0, flex: 1 }}>
                  <div className="row gap-2">
                    <span className="fs-sm bold">{preset.name}</span>
                    {preset.supportsTools ? <Badge tone="ok">工具调用</Badge> : null}
                    {preset.supportsVision ? <Badge tone="info">视觉</Badge> : null}
                    {preset.supportsReasoning ? <Badge tone="violet">深度思考</Badge> : null}
                    {preset.supportsPromptCache ? <Badge tone="gold">缓存计费</Badge> : null}
                  </div>
                  <span className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
                    {preset.note}
                  </span>
                  <span className="fs-xs faint mono truncate">
                    {preset.baseUrl} · {preset.model}
                  </span>
                  {preset.models.length > 0 ? (
                    <span className="fs-xs faint truncate">可选模型：{preset.models.slice(0, 6).join(' / ')}</span>
                  ) : null}
                </div>
                <div className="row gap-2">
                  {preset.docsUrl ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconExternal size={12} />}
                      onClick={() => void mcal.openExternal(preset.docsUrl!).catch((error: unknown) => reportError(error, '打开链接失败'))}
                    >
                      获取 Key
                    </Button>
                  ) : null}
                  <Button size="sm" variant="primary" onClick={() => void addFromPreset(preset)}>
                    添加
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {presets.length === 0 ? <div className="fs-sm muted">预设读取中…</div> : null}
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="删除这个服务商配置？"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => deleteTarget && void removeProvider(deleteTarget)}>
              删除
            </Button>
          </>
        }
      >
        <div className="fs-sm">
          「{deleteTarget?.name}」的 Base URL 与 API Key 会一并从本机设置中移除（不会影响服务商侧的账号）。
        </div>
      </Modal>
    </div>
  )
}

/* ------------------------------- 服务商卡片 ------------------------------- */

const COMMON_CONTEXT_WINDOWS = [32_768, 65_536, 128_000, 200_000, 1_000_000]

function ProviderCard({
  provider,
  preset,
  active,
  onSetActive,
  onSave,
  onDelete
}: {
  provider: ProviderSettings
  preset?: { models: string[]; docsUrl?: string }
  active: boolean
  onSetActive: () => void
  onSave: (next: ProviderSettings) => Promise<void>
  onDelete: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(provider)
  const [showKey, setShowKey] = useState(false)
  const [customModel, setCustomModel] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null)

  useEffect(() => {
    setDraft(provider)
    setCustomModel(false)
  }, [provider])

  const dirty = JSON.stringify(draft) !== JSON.stringify(provider)
  const modelOptions = preset?.models ?? []
  const isKnownModel = modelOptions.length === 0 || modelOptions.includes(draft.model)

  const test = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // 先落盘再测试：主进程从设置里读 provider
      if (dirty) await onSave(draft)
      const result = await mcal.testProvider(draft.id)
      setTestResult(result)
      if (result.ok) toast.ok(`${draft.name} 连接正常`, result.latencyMs ? `延迟 ${result.latencyMs} ms` : undefined)
    } catch (error) {
      reportError(error, '测试连接失败')
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }, [draft, dirty, onSave])

  return (
    <div
      className={`mcal-panel ${active ? 'mcal-card--selected' : ''}`}
      style={{ padding: 14, borderWidth: 1, borderStyle: 'solid', borderColor: active ? 'rgba(61,220,132,0.45)' : 'var(--c-hairline)' }}
    >
      <div className="row-between gap-3 wrap" style={{ marginBottom: 10 }}>
        <div className="row gap-2">
          <span className="fs-sm bold">{draft.name || draft.id}</span>
          {active ? <Badge tone="ok">当前使用</Badge> : null}
          {draft.apiKey ? <Badge tone="info">已填 Key</Badge> : <Badge tone="warn">缺 Key</Badge>}
          {dirty ? <Badge tone="warn">未保存</Badge> : null}
        </div>
        <div className="row gap-2">
          {!active ? (
            <Button size="sm" variant="ghost" icon={<IconCheck size={12} />} onClick={onSetActive}>
              设为当前
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon={<IconTrash size={12} />} onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="显示名称">
          <Input value={draft.name} onChange={(value) => setDraft((previous) => ({ ...previous, name: value }))} />
        </Field>
        <Field label="Base URL" hint="OpenAI 兼容接口根地址，一般以 /v1 结尾">
          <Input
            value={draft.baseUrl}
            onChange={(value) => setDraft((previous) => ({ ...previous, baseUrl: value }))}
            monospace
          />
        </Field>
        <Field label="API Key" hint="只保存在本机；本地 Ollama / LM Studio 可留空">
          <div className="row gap-2">
            <Input
              value={draft.apiKey}
              onChange={(value) => setDraft((previous) => ({ ...previous, apiKey: value }))}
              type={showKey ? 'text' : 'password'}
              placeholder={draft.apiKey ? undefined : 'sk-…'}
            />
            <Button size="sm" variant="ghost" onClick={() => setShowKey((value) => !value)}>
              {showKey ? '隐藏' : '显示'}
            </Button>
          </div>
        </Field>
        <Field label="模型名" hint={modelOptions.length > 0 ? `该服务商常用：${modelOptions.slice(0, 5).join(' / ')}` : '手填模型 id'}>
          {modelOptions.length > 0 && !customModel ? (
            <div className="row gap-2">
              <Select
                value={isKnownModel ? draft.model : modelOptions[0]}
                onChange={(value) => setDraft((previous) => ({ ...previous, model: value }))}
                options={modelOptions.map((model) => ({ value: model, label: model }))}
              />
              <Button size="sm" variant="ghost" onClick={() => setCustomModel(true)}>
                手填
              </Button>
            </div>
          ) : (
            <Input
              value={draft.model}
              onChange={(value) => setDraft((previous) => ({ ...previous, model: value }))}
              monospace
              placeholder="deepseek-chat"
            />
          )}
        </Field>
      </div>

      <div className="row gap-5 wrap" style={{ marginTop: 12 }}>
        <label className="row gap-2 fs-sm">
          <Switch
            checked={draft.supportsTools}
            onChange={(value) => setDraft((previous) => ({ ...previous, supportsTools: value }))}
            label="支持工具调用"
          />
          支持工具调用
        </label>
        <label className="row gap-2 fs-sm">
          <Switch
            checked={draft.supportsVision ?? false}
            onChange={(value) => setDraft((previous) => ({ ...previous, supportsVision: value }))}
            label="支持视觉"
          />
          支持视觉（看图）
        </label>
        <label className="row gap-2 fs-sm">
          <Switch
            checked={draft.supportsReasoning ?? false}
            onChange={(value) => setDraft((previous) => ({ ...previous, supportsReasoning: value }))}
            label="支持深度思考"
          />
          深度思考
        </label>
        <label className="row gap-2 fs-sm">
          <Switch
            checked={draft.supportsPromptCache ?? false}
            onChange={(value) => setDraft((previous) => ({ ...previous, supportsPromptCache: value }))}
            label="支持上下文缓存"
          />
          上下文缓存
        </label>
      </div>

      <div className="row gap-5 wrap" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div style={{ width: 230 }}>
          <Field label="温度（temperature）" hint="0 最稳定，1 最发散。诊断类任务建议 0.2~0.4">
            <div className="row gap-3">
              <input
                className="mcal-slider grow"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft.temperature ?? 0.3}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, temperature: Number(event.target.value) }))
                }
              />
              <span className="mono fs-sm" style={{ width: 34, textAlign: 'right' }}>
                {(draft.temperature ?? 0.3).toFixed(2)}
              </span>
            </div>
          </Field>
        </div>
        <div style={{ width: 230 }}>
          <Field label="上下文窗口（tokens）" hint="影响上下文占用进度条与自动压缩时机">
            <div className="col gap-2">
              <Select
                value={String(draft.contextWindow ?? 128_000)}
                onChange={(value) => setDraft((previous) => ({ ...previous, contextWindow: Number(value) }))}
                options={COMMON_CONTEXT_WINDOWS.map((window) => ({ value: String(window), label: formatNumber(window) }))}
              />
            </div>
          </Field>
        </div>
        <div className="row gap-2 grow" style={{ justifyContent: 'flex-end' }}>
          {testResult ? (
            <span className={`fs-xs ${testResult.ok ? 'ok' : 'err'}`} style={{ marginRight: 8 }}>
              {testResult.ok ? '连接正常' : '连接失败'}
              {testResult.latencyMs ? ` · ${testResult.latencyMs} ms` : ''}
              {!testResult.ok ? ` · ${testResult.message}` : ''}
            </span>
          ) : null}
          {preset?.docsUrl ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconExternal size={12} />}
              onClick={() => void mcal.openExternal(preset.docsUrl!).catch((error: unknown) => reportError(error, '打开失败'))}
            >
              获取 Key
            </Button>
          ) : null}
          <Button size="sm" loading={testing} onClick={() => void test()}>
            测试连接
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void onSave(draft)}>
            保存
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ================================================================== *
 *  生图模型
 * ================================================================== */

const IMAGE_KIND_LABELS: Record<string, string> = {
  openai: 'OpenAI 兼容（DALL·E / gpt-image-1）',
  zhipu: '智谱 CogView',
  siliconflow: '硅基流动（Kolors）',
  'sd-webui': '本地 Stable Diffusion WebUI',
  custom: '自定义'
}

const IMAGE_KEY_DOCS: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  siliconflow: 'https://siliconflow.cn',
  'sd-webui': ''
}

function ImageTab({ settings }: { settings: McalSettings }): React.JSX.Element {
  const update = useSettings((state) => state.update)
  const [providers, setProviders] = useState<ImageProviderSettings[]>(settings.media.providers)
  const [status, setStatus] = useState<{ id: string; name: string; configured: boolean; models: string[] }[]>([])

  useEffect(() => {
    setProviders(settings.media.providers)
  }, [settings.media.providers])

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await mcal.mediaProviders())
    } catch {
      setStatus([])
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const save = useCallback(
    async (next: ImageProviderSettings[], message: string) => {
      setProviders(next)
      await update({ media: { ...settings.media, providers: next } })
      toast.ok(message)
      void loadStatus()
    },
    [loadStatus, settings.media, update]
  )

  const setActive = useCallback(
    async (id: string) => {
      await update({ media: { ...settings.media, activeProviderId: id } })
      toast.ok('已切换生图服务')
    },
    [settings.media, update]
  )

  const activeId = settings.media.activeProviderId

  return (
    <div className="col">
      <Section
        title="生图服务"
        description="用于「开发工作台 → 生成贴图」以及 AI 助手生成材质。支持 OpenAI 兼容接口 / 智谱 CogView / 硅基流动 Kolors / 本地 Stable Diffusion WebUI。生成后会自动做像素化与去背处理。"
        extra={
          <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => void loadStatus()}>
            刷新状态
          </Button>
        }
      >
        <div className="col gap-3" style={{ paddingTop: 6 }}>
          {providers.map((provider) => {
            const info = status.find((item) => item.id === provider.id)
            return (
              <div
                key={provider.id}
                className="mcal-panel"
                style={{
                  padding: 14,
                  borderColor: provider.id === activeId ? 'rgba(61,220,132,0.45)' : 'var(--c-hairline)'
                }}
              >
                <div className="row-between gap-3 wrap" style={{ marginBottom: 10 }}>
                  <div className="row gap-2">
                    <IconImage size={14} className={info?.configured ? 'accent' : 'muted'} />
                    <span className="fs-sm bold">{provider.name}</span>
                    <Badge>{IMAGE_KIND_LABELS[provider.kind] ?? provider.kind}</Badge>
                    {provider.id === activeId ? <Badge tone="ok">当前使用</Badge> : null}
                    {info ? (
                      <Badge tone={info.configured ? 'ok' : 'warn'}>{info.configured ? '可用' : '缺 API Key'}</Badge>
                    ) : null}
                  </div>
                  <div className="row gap-2">
                    {provider.id !== activeId ? (
                      <Button size="sm" variant="ghost" onClick={() => void setActive(provider.id)}>
                        设为当前
                      </Button>
                    ) : null}
                    {IMAGE_KEY_DOCS[provider.kind] ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconExternal size={12} />}
                        onClick={() =>
                          void mcal.openExternal(IMAGE_KEY_DOCS[provider.kind]).catch((error: unknown) => reportError(error, '打开链接失败'))
                        }
                      >
                        获取 Key
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                  <Field label="Base URL">
                    <Input
                      value={provider.baseUrl}
                      onChange={(value) =>
                        setProviders((list) =>
                          list.map((item) => (item.id === provider.id ? { ...item, baseUrl: value } : item))
                        )
                      }
                      monospace
                    />
                  </Field>
                  <Field label="API Key" hint={provider.kind === 'sd-webui' ? '本地 WebUI 一般不需要' : undefined}>
                    <Input
                      value={provider.apiKey}
                      onChange={(value) =>
                        setProviders((list) => list.map((item) => (item.id === provider.id ? { ...item, apiKey: value } : item)))
                      }
                      type="password"
                      placeholder="未填写"
                    />
                  </Field>
                  <Field label="模型名">
                    <Input
                      value={provider.model}
                      onChange={(value) =>
                        setProviders((list) => list.map((item) => (item.id === provider.id ? { ...item, model: value } : item)))
                      }
                      monospace
                    />
                  </Field>
                </div>
              </div>
            )
          })}
          {providers.length === 0 ? (
            <div className="fs-sm muted">没有生图服务配置。重新读取设置后应当会自动生成默认配置。</div>
          ) : null}
          <div className="row gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void save(providers, '生图配置已保存')}
            >
              保存生图配置
            </Button>
          </div>
          <div className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
            提示：智谱 CogView 的 cogview-3-flash 有免费额度，适合先试效果；本地 SD WebUI 需要先启动 WebUI 并加上
            --api 参数（默认地址 http://127.0.0.1:7860）。
          </div>
        </div>
      </Section>
    </div>
  )
}

/* ================================================================== *
 *  下载
 * ================================================================== */

const MIRROR_FIELDS: { key: 'mojang' | 'forge' | 'fabric' | 'modrinth'; label: string; customKey: keyof McalSettings['mirror']; desc: string }[] = [
  { key: 'mojang', label: 'Mojang 官方资源', customKey: 'customMojang', desc: '游戏本体、库、资源索引' },
  { key: 'forge', label: 'Forge / NeoForge', customKey: 'customForge', desc: '安装器与安装包' },
  { key: 'fabric', label: 'Fabric / Quilt', customKey: 'customFabric', desc: '加载器与 API' },
  { key: 'modrinth', label: 'Modrinth', customKey: 'customModrinth', desc: '模组 / 整合包下载' }
]

function DownloadTab({ settings }: { settings: McalSettings }): React.JSX.Element {
  const update = useSettings((state) => state.update)
  const download = settings.download

  const patch = (partial: Partial<McalSettings['download']>): void => {
    void update({ download: { ...download, ...partial } })
  }

  const patchMirror = (partial: Partial<McalSettings['mirror']>): void => {
    void update({ mirror: { ...settings.mirror, ...partial } })
  }

  return (
    <div className="col">
      <Section title="下载引擎" description="影响游戏本体、库、资源与模组的下载速度与稳定性。">
        <Row title="并发下载数" hint="同时下载的文件数量。国内网络建议 8~16，太高反而容易被限速。">
          <NumberSlider value={download.concurrency} onChange={(value) => patch({ concurrency: value })} min={1} max={64} unit="个" />
        </Row>
        <Row title="全局限速" hint="0 表示不限速。宿舍 / 公共网络怕影响他人时可以设成 1024 KB/s。">
          <NumberSlider
            value={download.speedLimitKB}
            onChange={(value) => patch({ speedLimitKB: value })}
            min={0}
            max={20480}
            step={128}
            unit="KB/s"
          />
        </Row>
        <Row title="超时时间" hint="单个请求的等待上限，超时后会重试或回退镜像。">
          <NumberSlider
            value={Math.round(download.timeoutMs / 1000)}
            onChange={(value) => patch({ timeoutMs: value * 1000 })}
            min={5}
            max={120}
            unit="秒"
          />
        </Row>
        <Row title="失败重试次数" hint="网络抖动较多时可以提高到 5 次。">
          <NumberSlider value={download.retries} onChange={(value) => patch({ retries: value })} min={0} max={10} unit="次" />
        </Row>
        <Row title="校验文件哈希" hint="下载完成后校验 SHA1/SHA256。强烈建议保持开启，能拦下内容损坏（多见于断点续传后）。">
          <div className="row gap-2">
            <Switch checked={download.verifyHash} onChange={(value) => patch({ verifyHash: value })} label="校验哈希" />
            <span className="fs-sm muted">{download.verifyHash ? '已开启' : '已关闭'}</span>
          </div>
        </Row>
      </Section>

      <Section
        title="镜像源"
        description="国内用户建议使用 BMCLAPI（bangbang93 提供的公益镜像），可显著提升下载成功率与速度；官方源在部分网络下会超时。"
      >
        <div className="col gap-4" style={{ paddingTop: 6 }}>
          {MIRROR_FIELDS.map((field) => {
            const value = settings.mirror[field.key]
            const customValue = (settings.mirror[field.customKey] as string | undefined) ?? ''
            return (
              <div key={field.key} className="col gap-2">
                <div className="row-between gap-3 wrap">
                  <div className="col gap-1">
                    <span className="fs-sm">{field.label}</span>
                    <span className="fs-xs muted">{field.desc}</span>
                  </div>
                  <div style={{ width: 300 }}>
                    <Select
                      value={value}
                      onChange={(next) => patchMirror({ [field.key]: next } as Partial<McalSettings['mirror']>)}
                      options={[
                        { value: 'official', label: '官方源（official）' },
                        { value: 'bmclapi', label: 'BMCLAPI 镜像（推荐国内）' },
                        { value: 'custom', label: '自定义地址' }
                      ]}
                    />
                  </div>
                </div>
                {value === 'custom' ? (
                  <Input
                    value={customValue}
                    onChange={(next) => patchMirror({ [field.customKey]: next } as Partial<McalSettings['mirror']>)}
                    placeholder="https://your-mirror.example.com"
                    monospace
                  />
                ) : null}
              </div>
            )
          })}
          <div className="row gap-2 fs-xs muted">
            <IconInfo size={13} />
            BMCLAPI 是第三方公益服务，偶尔会抽风；下载失败时可以临时切回官方源再试。
          </div>
        </div>
      </Section>
    </div>
  )
}

/* ================================================================== *
 *  Java
 * ================================================================== */

const JAVA_VENDORS = ['任何发行版', 'Temurin', 'Zulu', 'Oracle', 'Mojang', 'Microsoft', 'Corretto', 'Liberica']

function JavaTab({ settings }: { settings: McalSettings }): React.JSX.Element {
  const update = useSettings((state) => state.update)
  const java = useInstances((state) => state.java)
  const refresh = useInstances((state) => state.refresh)
  const [scanning, setScanning] = useState(false)

  const patch = (partial: Partial<McalSettings['java']>): void => {
    void update({ java: { ...settings.java, ...partial } })
  }

  const pickJava = useCallback(async () => {
    const files = await mcal
      .pickFile({
        title: '选择 java 可执行文件',
        filters: [
          { name: 'Java 可执行文件', extensions: ['exe', ''] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      .catch((error: unknown) => {
        reportError(error, '选择文件失败')
        return null
      })
    if (files && files[0]) {
      patch({ preferredJava: files[0] })
      toast.ok('已设置优先 Java')
    }
  }, [patch])

  const addScanDir = useCallback(async () => {
    const dir = await mcal.pickDir({ title: '选择要扫描的 Java 目录' }).catch((error: unknown) => {
      reportError(error, '选择目录失败')
      return null
    })
    if (dir && !settings.java.scanDirs.includes(dir)) patch({ scanDirs: [...settings.java.scanDirs, dir] })
  }, [patch, settings.java.scanDirs])

  const rescan = useCallback(async () => {
    setScanning(true)
    try {
      const list = await mcal.listJava(true)
      await refresh()
      toast.ok('扫描完成', `检测到 ${list.length} 个 Java 运行时`)
    } catch (error) {
      reportError(error, '扫描 Java 失败')
    } finally {
      setScanning(false)
    }
  }, [refresh])

  return (
    <div className="col">
      <Section
        title="Java 环境"
        description="Minecraft 对 Java 版本很敏感：1.16 及以下要 Java 8，1.17~1.20.4 要 Java 17，1.20.5+ 与最新整合包一般要 Java 21。版本不对会直接崩溃。"
        extra={
          <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} loading={scanning} onClick={() => void rescan()}>
            重新扫描
          </Button>
        }
      >
        <Row title="优先使用的 Java" hint="指定后启动游戏优先用它（例如你手动装了 Temurin 21）。留空则按版本要求自动挑选。">
          <div className="row gap-2">
            <Input value={settings.java.preferredJava ?? ''} onChange={(value) => patch({ preferredJava: value })} placeholder="自动选择" monospace />
            <Button icon={<IconFolder size={14} />} onClick={() => void pickJava()}>
              选择
            </Button>
          </div>
        </Row>

        <Row title="自动下载缺失的 Java" hint="需要 Java 17/21 但本机没有时，自动下载 Mojang 官方运行时（不污染系统环境）。">
          <div className="row gap-2">
            <Switch checked={settings.java.autoDownload} onChange={(value) => patch({ autoDownload: value })} label="自动下载 Java" />
            <span className="fs-sm muted">{settings.java.autoDownload ? '已开启' : '已关闭'}</span>
          </div>
        </Row>

        <Row title="优先发行版" hint="有多个可用 Java 时的选择倾向。不确定就选「任何发行版」。">
          <Select
            value={settings.java.preferredVendor ?? JAVA_VENDORS[0]}
            onChange={(value) => patch({ preferredVendor: value === JAVA_VENDORS[0] ? undefined : value })}
            options={JAVA_VENDORS.map((vendor) => ({ value: vendor, label: vendor }))}
          />
        </Row>

        <div className="col gap-2" style={{ paddingTop: 10 }}>
          <div className="row-between">
            <span className="fs-sm">额外扫描目录</span>
            <Button size="sm" variant="ghost" icon={<IconPlus size={12} />} onClick={() => void addScanDir()}>
              添加目录
            </Button>
          </div>
          {settings.java.scanDirs.length === 0 ? (
            <div className="fs-xs muted">默认会扫描系统常见位置（PATH、Program Files、Mojang 运行时目录等）。</div>
          ) : (
            <div className="col gap-1">
              {settings.java.scanDirs.map((dir) => (
                <div key={dir} className="row-between gap-3">
                  <span className="fs-sm mono truncate" title={dir}>
                    {dir}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconTrash size={12} />}
                    onClick={() => patch({ scanDirs: settings.java.scanDirs.filter((item) => item !== dir) })}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section title="检测到的 Java" description="这些运行时当前可用于启动游戏。">
        <div className="col gap-2" style={{ paddingTop: 6 }}>
          {java.length === 0 ? (
            <div className="row gap-2 fs-sm muted">
              <IconAlert size={14} className="warn" />
              没有检测到 Java。可以去「Java」页面下载一个（推荐 Temurin 21）。
            </div>
          ) : (
            java.map((runtime) => (
              <div key={runtime.path} className="row-between gap-3">
                <div className="col" style={{ minWidth: 0 }}>
                  <span className="row gap-2 fs-sm">
                    <IconCoffee size={13} className="accent" />
                    Java {runtime.majorVersion}
                    {runtime.vendor ? <span className="muted">· {runtime.vendor}</span> : null}
                    {runtime.is64Bit ? <Badge tone="info">64 位</Badge> : null}
                    {runtime.managed ? <Badge tone="violet">启动器安装</Badge> : null}
                  </span>
                  <span className="fs-xs faint mono truncate" title={runtime.path}>
                    {runtime.path}
                  </span>
                </div>
                {settings.java.preferredJava === runtime.path ? <Badge tone="ok">优先使用</Badge> : null}
              </div>
            ))
          )}
        </div>
      </Section>
    </div>
  )
}

/* ================================================================== *
 *  账号
 * ================================================================== */

function AccountTab({ settings }: { settings: McalSettings }): React.JSX.Element {
  const update = useSettings((state) => state.update)
  const load = useSettings((state) => state.load)
  const refresh = useInstances((state) => state.refresh)
  const [accounts, setAccounts] = useState<Account[]>(settings.accounts)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await mcal.listAccounts())
    } catch (error) {
      reportError(error, '读取账号失败')
    }
  }, [])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  const nameError = (() => {
    const name = newName.trim()
    if (!name) return ''
    if (name.length > 16) return '不能超过 16 个字符'
    if (!/^[A-Za-z0-9_]+$/.test(name)) return '只能包含字母、数字与下划线'
    return ''
  })()

  const create = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    if (nameError) {
      toast.warn('名称不合法', nameError)
      return
    }
    setCreating(true)
    try {
      const account = await mcal.createOfflineAccount(name)
      setNewName('')
      await loadAccounts()
      await refresh()
      toast.ok('离线账号已创建', `游戏内显示为 ${account.name}`)
    } catch (error) {
      reportError(error, '创建账号失败')
    } finally {
      setCreating(false)
    }
  }, [loadAccounts, nameError, newName, refresh])

  const setActive = useCallback(
    async (account: Account) => {
      try {
        await mcal.setActiveAccount(account.id)
        await load()
        await refresh()
        toast.ok(`已切换到 ${account.name}`)
      } catch (error) {
        reportError(error, '切换账号失败')
      }
    },
    [load, refresh]
  )

  const remove = useCallback(async () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    try {
      await mcal.removeAccount(target.id)
      await loadAccounts()
      await load()
      await refresh()
      toast.ok('账号已删除')
    } catch (error) {
      reportError(error, '删除账号失败')
    }
  }, [deleteTarget, load, loadAccounts, refresh])

  const activeId = settings.activeAccountId

  return (
    <div className="col">
      <Section
        title="账号"
        description="当前版本支持离线账号（单机 / 离线联机可用）。微软正版登录需要 Azure 应用注册（client id），属于后续功能，敬请期待。"
      >
        <div className="col gap-2" style={{ paddingTop: 6 }}>
          {accounts.length === 0 ? (
            <div className="fs-sm muted">还没有账号。创建一个离线账号即可启动游戏。</div>
          ) : (
            accounts.map((account) => (
              <div key={account.id} className="mcal-panel row-between gap-3" style={{ padding: '10px 12px' }}>
                <div className="col gap-1" style={{ minWidth: 0 }}>
                  <span className="row gap-2 fs-sm bold">
                    {account.name}
                    <Badge tone={account.type === 'offline' ? 'default' : 'info'}>
                      {account.type === 'offline' ? '离线' : account.type === 'microsoft' ? '微软正版' : '第三方验证'}
                    </Badge>
                    {account.id === activeId ? <Badge tone="ok">当前使用</Badge> : null}
                  </span>
                  <span className="fs-xs faint mono truncate">
                    {account.uuid || '（离线账号无 UUID）'}
                  </span>
                  <span className="fs-xs muted">
                    创建于 {new Date(account.createdAt).toLocaleDateString('zh-CN')}
                    {account.lastUsedAt ? ` · 上次使用 ${new Date(account.lastUsedAt).toLocaleDateString('zh-CN')}` : ''}
                  </span>
                </div>
                <div className="row gap-2">
                  {account.id !== activeId ? (
                    <Button size="sm" variant="ghost" onClick={() => void setActive(account)}>
                      设为当前
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" icon={<IconTrash size={12} />} onClick={() => setDeleteTarget(account)}>
                    删除
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </Section>

      <Section title="新建离线账号" description="离线账号不需要密码，用户名会作为游戏内 ID（正版服无法进入，联机服务器需要 online-mode=false）。">
        <div className="row gap-3 wrap" style={{ alignItems: 'flex-end' }}>
          <div style={{ width: 260 }}>
            <Field
              label="用户名"
              required
              error={nameError}
              hint="1~16 个字符，只能包含字母、数字、下划线"
            >
              <Input value={newName} onChange={setNewName} placeholder="Steve" invalid={Boolean(nameError)} onEnter={() => void create()} />
            </Field>
          </div>
          <Button variant="primary" loading={creating} icon={<IconPlus size={14} />} disabled={!newName.trim() || Boolean(nameError)} onClick={() => void create()}>
            创建
          </Button>
        </div>
        <div className="row gap-2 fs-xs muted" style={{ marginTop: 12 }}>
          <IconInfo size={13} />
          微软正版登录需要 Azure 应用注册（client id + 回调地址），当前版本尚未开放；请先用离线账号，正版登录作为后续功能提供。
        </div>
      </Section>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="删除这个账号？"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => void remove()}>
              删除
            </Button>
          </>
        }
      >
        <div className="fs-sm">
          删除后「{deleteTarget?.name}」将从本机账号列表移除（离线账号随时可以重新创建，不会丢失任何游戏数据）。
        </div>
      </Modal>
    </div>
  )
}

/* ================================================================== *
 *  外观
 * ================================================================== */

const ACCENTS: { name: string; value: string }[] = [
  { name: '草方块绿', value: '#3ddc84' },
  { name: '钻石青', value: '#4fd6e8' },
  { name: '熔岩橙', value: '#ff9d4d' },
  { name: '紫水晶', value: '#b18cff' },
  { name: '金锭黄', value: '#f5c451' },
  { name: '红石红', value: '#ff5f6d' }
]

function AppearanceTab({ settings }: { settings: McalSettings }): React.JSX.Element {
  const update = useSettings((state) => state.update)
  const launcher = settings.launcher

  const patch = (partial: Partial<McalSettings['launcher']>): void => {
    void update({ launcher: { ...launcher, ...partial } })
  }

  return (
    <div className="col">
      <Section title="外观" description="强调色与动效等级会立即生效（写入 launcher.accent / launcher.motion）。">
        <Row title="语言" hint="当前版本以简体中文为主，English 仍在逐步完善。">
          <Segmented
            value={launcher.locale}
            onChange={(value) => patch({ locale: value })}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en-US', label: 'English' }
            ]}
          />
        </Row>

        <Row title="强调色" hint="影响按钮、进度条、选中态等所有强调色（绿色是默认的「草方块绿」）。">
          <div className="row gap-2 wrap">
            {ACCENTS.map((accent) => {
              const active = (launcher.accent ?? ACCENTS[0].value).toLowerCase() === accent.value.toLowerCase()
              return (
                <button
                  key={accent.value}
                  type="button"
                  title={accent.name}
                  onClick={() => patch({ accent: accent.value })}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    background: accent.value,
                    border: active ? '2px solid #fff' : '1px solid var(--c-hairline-strong)',
                    boxShadow: active ? `0 0 12px ${accent.value}66` : 'none',
                    display: 'grid',
                    placeItems: 'center'
                  }}
                >
                  {active ? <IconCheck size={14} style={{ color: '#04140b' }} /> : null}
                </button>
              )
            })}
            <button
              type="button"
              className="mcal-chip"
              onClick={() => patch({ accent: undefined })}
              title="恢复默认"
            >
              恢复默认
            </button>
          </div>
        </Row>

        <Row title="动效等级" hint="低配机器或觉得晃眼时可以关掉：关闭后所有过渡与动画立即结束。">
          <Segmented
            value={launcher.motion}
            onChange={(value) => patch({ motion: value })}
            options={[
              { value: 'full', label: '完整' },
              { value: 'reduced', label: '精简' },
              { value: 'off', label: '关闭' }
            ]}
          />
        </Row>

        <Row title="启动游戏时" hint="启动后自动最小化可以让游戏尽快拿到前台焦点。">
          <div className="col gap-2">
            <label className="row gap-2 fs-sm">
              <Switch checked={launcher.minimizeOnLaunch} onChange={(value) => patch({ minimizeOnLaunch: value })} label="最小化" />
              最小化启动器
            </label>
            <label className="row gap-2 fs-sm">
              <Switch checked={launcher.closeOnLaunch} onChange={(value) => patch({ closeOnLaunch: value })} label="关闭启动器" />
              关闭启动器（游戏不受影响）
            </label>
            <label className="row gap-2 fs-sm">
              <Switch checked={launcher.showGameWindowLog} onChange={(value) => patch({ showGameWindowLog: value })} label="显示日志" />
              主页显示实时日志
            </label>
          </div>
        </Row>
      </Section>
    </div>
  )
}

/* ================================================================== *
 *  关于
 * ================================================================== */

function AboutTab({ settings }: { settings: McalSettings }): React.JSX.Element {
  const systemInfo = useSystem((state) => state.info)
  const version = useSystem((state) => state.version)
  const loadSystem = useSystem((state) => state.load)
  const accounts = settings.accounts
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    if (!systemInfo) void loadSystem()
  }, [loadSystem, systemInfo])

  const logDir = `${settings.rootDir.replace(/[\\/]+$/, '')}/logs`

  const exportDiagnostics = useCallback(async () => {
    setExporting(true)
    try {
      const text = buildDiagnostics({
        version,
        systemInfo,
        settings,
        accounts: accounts.length
      })
      const copied = await copyText(text)
      if (copied) toast.ok('诊断信息已复制到剪贴板', '直接粘贴到反馈渠道即可（不含 API Key）')
      else toast.warn('复制失败', '可以手动在日志目录打包日志文件')
    } catch (error) {
      reportError(error, '导出诊断信息失败')
    } finally {
      setExporting(false)
    }
  }, [accounts.length, settings, systemInfo, version])

  const activeProvider = settings.providers.find((item) => item.id === settings.agent.activeProviderId) ?? settings.providers[0]

  return (
    <div className="col">
      <Section title="关于 MCAL" description="Minecraft Agent Launcher —— 面向 AI 时代的 Minecraft 智能启动器。">
        <div className="row gap-6 wrap" style={{ paddingTop: 8 }}>
          <div
            className="center"
            style={{
              width: 64,
              height: 64,
              borderRadius: 18,
              background: 'var(--g-aurora)',
              color: '#04140b',
              fontSize: 20,
              fontWeight: 800,
              letterSpacing: '-0.04em',
              boxShadow: '0 8px 30px var(--c-verdant-glow)'
            }}
          >
            MC
          </div>
          <div className="col gap-2">
            <div className="fs-xl bold">MCAL · Minecraft Agent Launcher</div>
            <div className="row gap-2 wrap">
              <Badge tone="ok">版本 {version?.app ?? '—'}</Badge>
              <Badge>Electron {version?.electron ?? '—'}</Badge>
              <Badge>Node {version?.node ?? '—'}</Badge>
              <Badge>Chrome {version?.chrome ?? '—'}</Badge>
            </div>
            <div className="fs-sm muted">
              离线优先、可插拔模型、本地知识库与记忆 —— 所有数据都在你自己的电脑上。
            </div>
          </div>
        </div>
      </Section>

      <Section title="目录" description="数据目录存放实例、设置、记忆、知识库与日志，备份/迁移时整个拷走即可。">
        <div className="col gap-3" style={{ paddingTop: 8 }}>
          <div className="row-between gap-3 wrap">
            <div className="col" style={{ minWidth: 0 }}>
              <span className="fs-sm">数据目录</span>
              <span className="fs-xs faint mono break-all">{settings.rootDir}</span>
            </div>
            <div className="row gap-2">
              <Button size="sm" icon={<IconFolder size={13} />} onClick={() => void mcal.openPath(settings.rootDir).catch((error: unknown) => reportError(error, '打开目录失败'))}>
                打开
              </Button>
            </div>
          </div>
          <div className="row-between gap-3 wrap">
            <div className="col" style={{ minWidth: 0 }}>
              <span className="fs-sm">日志目录</span>
              <span className="fs-xs faint mono break-all">{logDir}</span>
            </div>
            <div className="row gap-2">
              <Button
                size="sm"
                icon={<IconFolder size={13} />}
                onClick={() =>
                  void mcal
                    .openPath(logDir)
                    .catch(() => mcal.openPath(settings.rootDir))
                    .catch((error: unknown) => reportError(error, '打开目录失败'))
                }
              >
                打开
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="系统信息"
        description="这些信息用于自动推荐内存与判断能否跑光影，也可以在反馈问题时一并提供。"
        extra={
          <Button size="sm" loading={exporting} icon={<IconDownload size={13} />} onClick={() => void exportDiagnostics()}>
            导出诊断信息
          </Button>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, paddingTop: 8 }}>
          <InfoCell label="操作系统" value={systemInfo ? `${systemInfo.platform} ${systemInfo.arch}` : '读取中…'} hint={systemInfo?.osVersion} />
          <InfoCell label="CPU" value={systemInfo?.cpuModel ?? '读取中…'} hint={systemInfo ? `${systemInfo.cpuCores} 核心` : undefined} />
          <InfoCell
            label="内存"
            value={systemInfo ? formatBytes(systemInfo.totalMemoryMB * 1024 * 1024, 1) : '读取中…'}
            hint={systemInfo ? `可用 ${formatBytes(systemInfo.freeMemoryMB * 1024 * 1024, 1)} · 推荐堆 ${systemInfo.recommendedMaxHeapMB} MB` : undefined}
          />
          <InfoCell
            label="显卡"
            value={systemInfo?.gpus?.[0]?.model ?? '未检测到'}
            hint={systemInfo && systemInfo.gpus && systemInfo.gpus.length > 1 ? `另有 ${systemInfo.gpus.length - 1} 个 GPU` : undefined}
          />
          <InfoCell
            label="当前模型"
            value={activeProvider ? activeProvider.name : '未配置'}
            hint={activeProvider ? activeProvider.model : '到「AI 模型」标签页添加'}
          />
          <InfoCell label="账号数" value={`${accounts.length} 个`} hint={settings.activeAccountId ? '已设置当前账号' : '默认使用第一个账号'} />
        </div>
      </Section>

      <Section title="开源与致谢" description="MCAL 站在这些开源项目的肩膀上。">
        <div className="col gap-2 fs-sm dim" style={{ paddingTop: 8, lineHeight: 'var(--lh-relaxed)' }}>
          <span>· 参考了 HMCL 与 PCL2（Plain Craft Launcher）在实例管理、版本隔离与崩溃诊断上的设计思路；</span>
          <span>· 下载与镜像方案参考 BMCLAPI（bangbang93）的公益服务；</span>
          <span>· 模组元数据与检索来自 Modrinth 开放 API；</span>
          <span>· 技术栈：Electron + React + TypeScript，未引入任何 UI / 状态 / 图标第三方库。</span>
        </div>
      </Section>

      <Section title="反馈问题" description="遇到 bug 时请提供「导出诊断信息」的内容与复现步骤，能显著加快定位。">
        <div className="row gap-2" style={{ paddingTop: 8 }}>
          <Button loading={exporting} variant="primary" icon={<IconDownload size={14} />} onClick={() => void exportDiagnostics()}>
            导出诊断信息
          </Button>
          <Button
            icon={<IconExternal size={14} />}
            onClick={() => void mcal.openExternal('https://aka.ms/MinecraftEULA').catch(() => undefined)}
            title="顺手确认一下 EULA 链接可用"
          >
            查看 Minecraft EULA
          </Button>
        </div>
      </Section>
    </div>
  )
}

function InfoCell({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return (
    <div className="col gap-1">
      <span className="fs-xs muted">{label}</span>
      <span className="fs-sm bold break-all" style={{ lineHeight: 'var(--lh-tight)' }}>
        {value}
      </span>
      {hint ? <span className="fs-xs faint break-all">{hint}</span> : null}
    </div>
  )
}

function buildDiagnostics(input: {
  version: { app: string; electron: string; node: string; chrome: string } | null
  systemInfo: SystemInfo | null
  settings: McalSettings
  accounts: number
}): string {
  const { version, systemInfo, settings, accounts } = input
  const lines: string[] = []
  lines.push('=== MCAL 诊断信息 ===')
  lines.push(`时间：${new Date().toISOString()}`)
  lines.push(`版本：${version?.app ?? '未知'} · Electron ${version?.electron ?? '?'} · Node ${version?.node ?? '?'} · Chrome ${version?.chrome ?? '?'}`)
  lines.push('')
  lines.push('--- 系统 ---')
  if (systemInfo) {
    lines.push(`平台：${systemInfo.platform} ${systemInfo.arch} (${systemInfo.osVersion})`)
    lines.push(`CPU：${systemInfo.cpuModel} (${systemInfo.cpuCores} 核)`)
    lines.push(`内存：${systemInfo.totalMemoryMB} MB（可用 ${systemInfo.freeMemoryMB} MB，推荐堆 ${systemInfo.recommendedMaxHeapMB} MB）`)
    if (systemInfo.gpus && systemInfo.gpus.length > 0) {
      lines.push(`显卡：${systemInfo.gpus.map((gpu) => gpu.model ?? '未知').join(' / ')}`)
    }
    lines.push(`数据目录：${systemInfo.rootDir}`)
  } else {
    lines.push('（系统信息未读取到）')
  }
  lines.push('')
  lines.push('--- 设置摘要（不含 API Key）---')
  const activeProvider = settings.providers.find((item) => item.id === settings.agent.activeProviderId) ?? settings.providers[0]
  lines.push(`模型服务商：${settings.providers.length} 个${activeProvider ? `（当前：${activeProvider.name} / ${activeProvider.model} / ${activeProvider.baseUrl}）` : ''}`)
  lines.push(`权限模式：${settings.agent.permissionMode} · shell=${settings.agent.shellEnabled} · 网络=${settings.agent.networkToolsEnabled}`)
  lines.push(`记忆：${settings.agent.memoryEnabled ? '开' : '关'}（召回 ${settings.agent.memoryRecallLimit} 条）· 知识库：${settings.agent.knowledgeEnabled ? '开' : '关'}`)
  lines.push(`上下文压缩阈值：${settings.agent.compactionThreshold} tokens · 最大轮数：${settings.agent.maxTurnsPerRequest}`)
  lines.push(`下载：并发 ${settings.download.concurrency} · 限速 ${settings.download.speedLimitKB} KB/s · 超时 ${settings.download.timeoutMs} ms · 重试 ${settings.download.retries} · 校验 ${settings.download.verifyHash}`)
  lines.push(`镜像：Mojang=${settings.mirror.mojang} Forge=${settings.mirror.forge} Fabric=${settings.mirror.fabric} Modrinth=${settings.mirror.modrinth}`)
  lines.push(`账号：${accounts} 个 · 语言 ${settings.launcher.locale} · 强调色 ${settings.launcher.accent ?? '默认'} · 动效 ${settings.launcher.motion}`)
  lines.push('')
  lines.push('（日志文件请从数据目录的 logs/mcal.log 附带提供）')
  return lines.join('\n')
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}
