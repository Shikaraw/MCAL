/**
 * 实例管理页
 *   左栏：实例列表（搜索 / 新建 / 刷新），选中即时切换
 *   右栏：实例详情分区编辑（基本信息 / 版本与加载器 / 内存 / Java / 窗口 / 参数 / 备注标签 / 危险操作）
 *
 * 交互约定：
 *  - 所有修改即时保存（updateInstance），成功 toast.ok、失败 reportError；
 *  - 加载器安装是长任务，进度来自 useTasks().tasks（由主进程事件推送，无需轮询），支持取消；
 *  - 删除实例只删记录，游戏文件保留在磁盘上 —— 确认弹窗里明确说明并展示目录。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Instance, LoaderType, LoaderVersion, TaskState } from '@shared/types'
import { mcal } from '../lib/api'
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  loaderLabel,
  recommendMaxHeapMB
} from '../lib/format'
import { reportError, toast, useInstances, useSettings, useSystem, useTasks, useView } from '../state/store'
import {
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  Field,
  Input,
  Modal,
  Progress,
  SearchInput,
  Select,
  Switch,
  Textarea
} from '../components/ui/primitives'
import {
  IconAlert,
  IconBox,
  IconChevronRight,
  IconClose,
  IconCoffee,
  IconCube,
  IconDownload,
  IconExternal,
  IconFolder,
  IconGauge,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconWrench
} from '../components/ui/icons'

const LOADER_CHOICES: { value: LoaderType; label: string }[] = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'optifine', label: 'OptiFine' }
]

const MEMORY_MIN = 512
const MEMORY_MAX = 32768
const MEMORY_STEP = 512

/** 从版本 id 里猜出基础游戏版本（实例可能已经指向加载器版本 id） */
function guessBaseGameVersion(versionId: string): string {
  const match = /1\.\d+(?:\.\d+)?/.exec(versionId)
  return match ? match[0] : versionId
}

/** 取最近一条指定 kind 的任务（长任务进度用） */
function latestTask(tasks: TaskState[], kind: string): TaskState | undefined {
  return tasks
    .filter((task) => task.kind === kind)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
}

/**
 * listVersions() 在主进程返回的是轻量结构（{ id, type, installed, loaderType }），
 * 与 api.ts 上声明的 InstalledVersion 略有出入。这里按运行时字段读取，
 * 同时容忍更丰富的可选字段，缺失时优雅降级。
 */
interface VersionEntry {
  id: string
  type?: string
  installed: boolean
  loaderType: LoaderType
  gameVersion?: string
  loaderVersion?: string
  dir?: string
  sizeBytes?: number
  installedAt?: string
  isIsolated?: boolean
  usedByInstances?: string[]
  valid?: boolean
  error?: string
}

async function fetchVersionEntries(): Promise<VersionEntry[]> {
  const list = (await mcal.listVersions()) as unknown as VersionEntry[]
  return Array.isArray(list) ? list.filter((item) => item.installed) : []
}

async function copyText(text: string, label = '路径'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.ok(`${label}已复制`)
  } catch {
    toast.warn('复制失败', '系统剪贴板不可用，请手动选择复制')
  }
}

export function InstancesView(): React.JSX.Element {
  const instances = useInstances((state) => state.instances)
  const running = useInstances((state) => state.running)
  const loading = useInstances((state) => state.loading)
  const activeInstanceId = useInstances((state) => state.activeInstanceId)
  const setActive = useInstances((state) => state.setActive)
  const refresh = useInstances((state) => state.refresh)
  const navigate = useView((state) => state.navigate)

  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const selected = useMemo(
    () => instances.find((item) => item.id === activeInstanceId) ?? instances[0],
    [instances, activeInstanceId]
  )

  const runningIds = useMemo(
    () =>
      new Set(
        running.filter((game) => game.state === 'running' || game.state === 'starting').map((game) => game.instanceId)
      ),
    [running]
  )

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return instances
    return instances.filter((item) =>
      [item.name, item.versionId, loaderLabel(item.loaderType), ...(item.tags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    )
  }, [instances, query])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
      toast.ok('实例列表已刷新')
    } catch (error) {
      reportError(error, '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  /* ------------------------------ 空状态：引导下一步 ------------------------------ */
  if (instances.length === 0) {
    return (
      <div className="page">
        <div className="page__header">
          <div className="page__title">
            <h2>实例管理</h2>
            <span className="fs-sm muted">每个实例是一个独立的游戏目录：版本、内存、Java 与 mod 互不干扰</span>
          </div>
          <div className="row gap-2">
            <Button icon={<IconRefresh size={14} />} loading={refreshing} onClick={() => void handleRefresh()}>
              刷新
            </Button>
            <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreateOpen(true)}>
              新建实例
            </Button>
          </div>
        </div>
        <div className="page__body center" style={{ height: '100%' }}>
          {loading ? (
            <SkeletonList />
          ) : (
            <Card padding={40}>
              <Empty
                icon={<IconCube />}
                title="还没有任何实例"
                description="实例就是一套独立的游戏环境。先下载一个 Minecraft 版本，或者在已有游戏目录上创建一个实例；也可以让 AI 助手帮你从零搭好整合包环境。"
                action={
                  <div className="row gap-3 wrap" style={{ marginTop: 8 }}>
                    <Button variant="primary" icon={<IconDownload size={15} />} onClick={() => navigate('versions')}>
                      去下载游戏版本
                    </Button>
                    <Button icon={<IconSparkles size={15} />} onClick={() => setCreateOpen(true)}>
                      手动创建实例
                    </Button>
                    <Button
                      variant="ghost"
                      icon={<IconChevronRight size={15} />}
                      onClick={() =>
                        navigate('agent', {
                          prompt: '我还没有任何 Minecraft 实例，请帮我选一个适合新手的版本，并指导我完成第一次安装与启动。'
                        })
                      }
                    >
                      让 AI 帮我配置
                    </Button>
                  </div>
                }
              />
            </Card>
          )}
          <CreateInstanceModal open={createOpen} onClose={() => setCreateOpen(false)} />
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>实例管理</h2>
          <span className="fs-sm muted">
            共 {instances.length} 个实例
            {runningIds.size > 0 ? `，${runningIds.size} 个正在运行` : ''}
          </span>
        </div>
        <div className="row gap-2">
          <Button icon={<IconRefresh size={14} />} loading={refreshing} onClick={() => void handleRefresh()}>
            刷新
          </Button>
          <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreateOpen(true)}>
            新建实例
          </Button>
        </div>
      </div>

      <div className="page__body" style={{ overflow: 'hidden' }}>
        <div className="split">
          {/* ------------------------------ 左栏：实例列表 ------------------------------ */}
          <div className="split__aside col gap-3" style={{ paddingRight: 2 }}>
            <Card padding={14}>
              <SearchInput value={query} onChange={setQuery} placeholder="搜索名称 / 版本 / 加载器…" />
              <div className="row-between fs-xs muted" style={{ marginTop: 10 }}>
                <span>{filtered.length} 个结果</span>
                {query ? (
                  <button type="button" className="fs-xs accent" onClick={() => setQuery('')}>
                    清除筛选
                  </button>
                ) : null}
              </div>
            </Card>

            {loading && instances.length === 0 ? (
              <SkeletonList />
            ) : (
              <div className="col gap-2 stagger">
                {filtered.map((item) => (
                  <InstanceRow
                    key={item.id}
                    instance={item}
                    selected={item.id === selected?.id}
                    running={runningIds.has(item.id)}
                    onSelect={() => setActive(item.id)}
                  />
                ))}
                {filtered.length === 0 ? (
                  <Card flat padding={16}>
                    <div className="fs-sm muted">没有匹配的实例，换个关键词试试。</div>
                  </Card>
                ) : null}
              </div>
            )}
          </div>

          {/* ------------------------------ 右栏：实例详情 ------------------------------ */}
          <div className="split__main">
            {selected ? (
              <InstanceDetail key={selected.id} instance={selected} />
            ) : (
              <Card padding={24}>
                <Empty
                  icon={<IconCube />}
                  title="选择一个实例"
                  description="从左侧列表中选中实例，即可在这里调整版本、加载器、内存、Java 与窗口设置。"
                />
              </Card>
            )}
          </div>
        </div>
      </div>

      <CreateInstanceModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}

/* ------------------------------ 列表项 ------------------------------ */

function InstanceRow({
  instance,
  selected,
  running,
  onSelect
}: {
  instance: Instance
  selected: boolean
  running: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <Card flat interactive selected={selected} padding={12} onClick={onSelect}>
      <div className="row-between gap-2">
        <div className="row gap-2" style={{ minWidth: 0 }}>
          <span className="fs-md bold truncate" title={instance.name}>
            {instance.name}
          </span>
          {running ? <Badge tone="ok">运行中</Badge> : null}
        </div>
        <span className="fs-xs muted" style={{ flexShrink: 0 }}>
          {instance.lastPlayedAt ? `${formatRelativeTime(instance.lastPlayedAt)}玩过` : '从未启动'}
        </span>
      </div>
      <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
        <span className="mono fs-xs dim">{instance.versionId || '未指定版本'}</span>
        <Badge tone={instance.loaderType === 'vanilla' ? 'default' : 'info'}>{loaderLabel(instance.loaderType)}</Badge>
        <span className="fs-xs muted">{instance.memory.auto ? '内存自动' : `${instance.memory.maxMB} MB`}</span>
      </div>
      {(instance.tags ?? []).length > 0 ? (
        <div className="row gap-1 wrap" style={{ marginTop: 8 }}>
          {(instance.tags ?? []).slice(0, 4).map((tag) => (
            <span key={tag} className="mcal-badge">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

function SkeletonList(): React.JSX.Element {
  return (
    <div className="col gap-2">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="skeleton" style={{ height: 74 }} />
      ))}
    </div>
  )
}

/* ------------------------------ 详情 ------------------------------ */

function SectionCard({
  icon,
  title,
  description,
  actions,
  children
}: {
  icon: React.ReactNode
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card padding={18}>
      <div className="row-between gap-3 wrap" style={{ marginBottom: 14 }}>
        <div className="row gap-2" style={{ minWidth: 0 }}>
          <span className="accent">{icon}</span>
          <div className="col" style={{ minWidth: 0 }}>
            <span className="fs-md bold">{title}</span>
            {description ? <span className="fs-xs muted">{description}</span> : null}
          </div>
        </div>
        {actions ? <div className="row gap-2 wrap">{actions}</div> : null}
      </div>
      {children}
    </Card>
  )
}

function InstanceDetail({ instance }: { instance: Instance }): React.JSX.Element {
  const refresh = useInstances((state) => state.refresh)
  const java = useInstances((state) => state.java)
  const systemInfo = useSystem((state) => state.info)
  const running = useInstances((state) => state.running)

  const [name, setName] = useState(instance.name)
  const [notes, setNotes] = useState(instance.notes ?? '')
  const [jvmArgs, setJvmArgs] = useState((instance.java.extraJvmArgs ?? []).join('\n'))
  const [gameArgs, setGameArgs] = useState((instance.extraGameArgs ?? []).join('\n'))
  const [maxMB, setMaxMB] = useState(instance.memory.maxMB)
  const [winWidth, setWinWidth] = useState(String(instance.window.width))
  const [winHeight, setWinHeight] = useState(String(instance.window.height))
  const [tagInput, setTagInput] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [switchOpen, setSwitchOpen] = useState(false)
  const [loaderOpen, setLoaderOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  // 切换实例时重置草稿（同一实例刷新不回滚用户正在编辑的内容）
  useEffect(() => {
    setName(instance.name)
    setNotes(instance.notes ?? '')
    setJvmArgs((instance.java.extraJvmArgs ?? []).join('\n'))
    setGameArgs((instance.extraGameArgs ?? []).join('\n'))
    setMaxMB(instance.memory.maxMB)
    setWinWidth(String(instance.window.width))
    setWinHeight(String(instance.window.height))
    setTagInput('')
  }, [instance.id])

  const isRunning = running.some(
    (game) => game.instanceId === instance.id && (game.state === 'running' || game.state === 'starting')
  )

  const save = useCallback(
    async (patch: Partial<Instance>, label: string, key: string): Promise<void> => {
      setSavingKey(key)
      try {
        await mcal.updateInstance(instance.id, patch)
        await refresh()
        toast.ok(`${label}已保存`)
      } catch (error) {
        reportError(error, `${label}保存失败`)
      } finally {
        setSavingKey(null)
      }
    },
    [instance.id, refresh]
  )

  const recommendedMB = systemInfo ? recommendMaxHeapMB(systemInfo.totalMemoryMB) : 4096
  const totalMemoryMB = systemInfo?.totalMemoryMB ?? 0

  /* -------- 名称 -------- */
  const commitName = (): void => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.warn('实例名称不能为空')
      setName(instance.name)
      return
    }
    if (trimmed === instance.name) return
    void save({ name: trimmed }, '名称', 'name')
  }

  /* -------- 内存 -------- */
  const clampMB = (value: number): number => {
    if (!Number.isFinite(value)) return MEMORY_MIN
    return Math.min(MEMORY_MAX, Math.max(MEMORY_MIN, Math.round(value / MEMORY_STEP) * MEMORY_STEP))
  }
  const commitMemory = (): void => {
    const next = clampMB(maxMB)
    setMaxMB(next)
    if (next === instance.memory.maxMB && !instance.memory.auto) return
    void save({ memory: { ...instance.memory, maxMB: next, auto: false } }, '内存设置', 'memory')
  }

  /* -------- 窗口 -------- */
  const commitWindow = (): void => {
    const width = Math.min(7680, Math.max(640, Number.parseInt(winWidth, 10) || instance.window.width))
    const height = Math.min(4320, Math.max(480, Number.parseInt(winHeight, 10) || instance.window.height))
    setWinWidth(String(width))
    setWinHeight(String(height))
    if (width === instance.window.width && height === instance.window.height) return
    void save({ window: { ...instance.window, width, height } }, '窗口设置', 'window')
  }

  /* -------- 参数 -------- */
  const commitArgs = (): void => {
    const jvm = jvmArgs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const game = gameArgs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    void save({ java: { ...instance.java, extraJvmArgs: jvm }, extraGameArgs: game }, '启动参数', 'args')
  }

  /* -------- 标签 -------- */
  const addTag = (): void => {
    const value = tagInput.trim()
    if (!value) return
    setTagInput('')
    const tags = instance.tags ?? []
    if (tags.includes(value)) {
      toast.info('标签已存在', value)
      return
    }
    void save({ tags: [...tags, value] }, '标签', 'tags')
  }
  const removeTag = (tag: string): void => {
    void save({ tags: (instance.tags ?? []).filter((item) => item !== tag) }, '标签', 'tags')
  }

  const javaOptions = useMemo(
    () => [
      { value: '', label: '自动选择（按版本匹配最合适的 Java）' },
      ...java.map((runtime) => ({
        value: runtime.path,
        label: `Java ${runtime.majorVersion} · ${runtime.vendor ?? '未知发行版'} · ${
          runtime.is64Bit === false ? '32 位' : '64 位'
        } · ${runtime.path}`
      }))
    ],
    [java]
  )

  return (
    <div className="col gap-4 stagger">
      {/* ------------------------------ 基本信息 ------------------------------ */}
      <SectionCard
        icon={<IconCube size={16} />}
        title="基本信息"
        description={`创建于 ${formatDateTime(instance.createdAt)}`}
        actions={
          <Badge tone={isRunning ? 'ok' : 'default'}>{isRunning ? '运行中' : '未运行'}</Badge>
        }
      >
        <div className="col gap-4">
          <Field label="实例名称" hint="用于区分不同环境，修改后按回车或点击「保存」生效">
            <div className="row gap-2">
              <div className="grow">
                <Input value={name} onChange={setName} onEnter={commitName} disabled={savingKey === 'name'} />
              </div>
              <Button variant="primary" loading={savingKey === 'name'} onClick={commitName}>
                保存
              </Button>
            </div>
          </Field>

          <div className="row gap-4 wrap fs-xs muted">
            <span>创建时间：{formatDateTime(instance.createdAt)}</span>
            <span>最后游玩：{instance.lastPlayedAt ? formatDateTime(instance.lastPlayedAt) : '从未启动'}</span>
            {instance.totalPlayTimeMs ? (
              <span>累计游玩：{formatDuration(instance.totalPlayTimeMs / 1000)}</span>
            ) : null}
            <span>最近启动版本：{instance.lastLaunchedVersion ?? '—'}</span>
          </div>

          <Field label="游戏目录" hint="该实例的 mods / 存档 / 配置都保存在这里">
            <div className="row gap-2">
              <div
                className="mcal-input mono"
                style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}
                title={instance.gameDir}
              >
                <span className="truncate grow">{instance.gameDir}</span>
                <button
                  type="button"
                  className="mcal-btn mcal-btn--ghost mcal-btn--icon mcal-btn--sm"
                  title="复制路径"
                  onClick={() => void copyText(instance.gameDir, '游戏目录')}
                >
                  <IconLayers size={13} />
                </button>
              </div>
              <Button
                icon={<IconFolder size={14} />}
                onClick={() => void mcal.openInstanceDir(instance.id).catch((error) => reportError(error, '打开目录失败'))}
              >
                打开目录
              </Button>
            </div>
          </Field>
        </div>
      </SectionCard>

      {/* ------------------------------ 版本与加载器 ------------------------------ */}
      <SectionCard
        icon={<IconDownload size={16} />}
        title="版本与加载器"
        description="切换已安装版本，或为当前目录安装新的加载器"
        actions={
          <>
            <Button size="sm" icon={<IconRefresh size={13} />} onClick={() => setSwitchOpen(true)}>
              切换版本
            </Button>
            <Button size="sm" variant="primary" icon={<IconWrench size={13} />} onClick={() => setLoaderOpen(true)}>
              安装加载器
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
          <div className="col gap-1">
            <span className="fs-xs muted">当前版本</span>
            <span className="mono bold" title={instance.versionId}>
              {instance.versionId || '未指定'}
            </span>
          </div>
          <div className="col gap-1">
            <span className="fs-xs muted">加载器</span>
            <span className="row gap-2">
              <Badge tone={instance.loaderType === 'vanilla' ? 'default' : 'info'}>
                {loaderLabel(instance.loaderType)}
              </Badge>
              {instance.loaderVersion ? <span className="mono fs-xs dim">{instance.loaderVersion}</span> : null}
            </span>
          </div>
          <div className="col gap-1">
            <span className="fs-xs muted">最近启动版本</span>
            <span className="mono fs-sm dim">{instance.lastLaunchedVersion ?? '—'}</span>
          </div>
        </div>
        {instance.loaderType === 'vanilla' ? (
          <div className="row gap-2 fs-xs muted" style={{ marginTop: 14 }}>
            <IconAlert size={13} className="warn" />
            原版没有加载器，安装 Fabric / Forge 后才能加载 mod。
          </div>
        ) : null}
      </SectionCard>

      {/* ------------------------------ 内存设置 ------------------------------ */}
      <SectionCard
        icon={<IconGauge size={16} />}
        title="内存设置"
        description="决定游戏可用堆内存，过大或过小都会影响流畅度"
      >
        <div className="col gap-4">
          <div className="row-between gap-3">
            <div className="col gap-1">
              <span className="fs-sm">自动分配</span>
              <span className="fs-xs muted">
                自动模式下按物理内存的 60% 计算（当前建议 {recommendedMB} MB）
              </span>
            </div>
            <Switch
              checked={instance.memory.auto}
              disabled={savingKey === 'memory'}
              label="自动分配内存"
              onChange={(value) =>
                void save({ memory: { ...instance.memory, auto: value } }, '内存设置', 'memory')
              }
            />
          </div>

          {instance.memory.auto ? (
            <div className="mcal-panel" style={{ padding: 14 }}>
              <div className="row-between gap-3">
                <span className="fs-sm dim">当前生效上限</span>
                <span className="mono bold">{recommendedMB} MB</span>
              </div>
              <div className="fs-xs muted" style={{ marginTop: 6 }}>
                物理内存 {totalMemoryMB ? formatBytes(totalMemoryMB * 1024 * 1024, 0) : '未知'}。整合包较多时建议改为手动并分配
                4096 MB 以上。
              </div>
            </div>
          ) : (
            <div className="col gap-3">
              <div className="row gap-4 wrap">
                <input
                  className="mcal-slider grow"
                  type="range"
                  min={MEMORY_MIN}
                  max={MEMORY_MAX}
                  step={MEMORY_STEP}
                  value={maxMB}
                  disabled={savingKey === 'memory'}
                  onChange={(event) => setMaxMB(Number.parseInt(event.target.value, 10))}
                  onMouseUp={commitMemory}
                  onTouchEnd={commitMemory}
                  onKeyUp={commitMemory}
                  aria-label="最大内存"
                />
                <div style={{ width: 160 }}>
                  <Input
                    type="number"
                    value={String(maxMB)}
                    onChange={(value) => setMaxMB(Number.parseInt(value, 10) || MEMORY_MIN)}
                    onEnter={commitMemory}
                    monospace
                    suffix={<span className="fs-xs muted">MB</span>}
                  />
                </div>
              </div>
              <div className="row-between gap-3 fs-xs muted">
                <span>
                  范围 {MEMORY_MIN} ~ {MEMORY_MAX} MB，步进 {MEMORY_STEP} MB
                </span>
                <span>
                  物理内存 {totalMemoryMB ? formatBytes(totalMemoryMB * 1024 * 1024, 0) : '未知'} · 建议 {recommendedMB} MB
                </span>
              </div>
              <div className="row gap-2">
                <Button size="sm" onClick={commitMemory} loading={savingKey === 'memory'}>
                  应用内存设置
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMaxMB(recommendedMB)}>
                  填入建议值
                </Button>
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ------------------------------ Java 设置 ------------------------------ */}
      <SectionCard
        icon={<IconCoffee size={16} />}
        title="Java 设置"
        description="不同 MC 版本需要不同 Java：1.16 及更早用 Java 8，1.17~1.20.4 用 Java 17，1.20.5 之后用 Java 21"
      >
        <div className="col gap-3">
          <Field label="使用的 Java 运行时">
            <Select
              value={instance.java.javaPath ?? ''}
              disabled={savingKey === 'java'}
              onChange={(value) =>
                void save({ java: { ...instance.java, javaPath: value || undefined } }, 'Java 设置', 'java')
              }
              options={javaOptions}
            />
          </Field>
          {java.length === 0 ? (
            <div className="row gap-2 fs-xs muted">
              <IconAlert size={13} className="warn" />
              本机还没有检测到 Java，可以到 Java 页面自动下载安装。
            </div>
          ) : (
            <div className="col gap-2">
              {java.slice(0, 4).map((runtime) => (
                <div key={runtime.path} className="row-between gap-3 fs-xs">
                  <span className="row gap-2" style={{ minWidth: 0 }}>
                    <Badge tone="info">Java {runtime.majorVersion}</Badge>
                    <span className="dim truncate" title={runtime.path}>
                      {runtime.vendor ?? '未知发行版'} {runtime.version ?? ''}
                    </span>
                  </span>
                  <span className="muted" style={{ flexShrink: 0 }}>
                    {runtime.is64Bit === false ? '32 位' : '64 位'}
                    {runtime.managed ? ' · 启动器安装' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {/* ------------------------------ 窗口设置 ------------------------------ */}
      <SectionCard icon={<IconBox size={16} />} title="窗口设置" description="首次启动时的窗口尺寸与全屏状态">
        <div className="row gap-4 wrap">
          <div style={{ width: 120 }}>
            <Field label="宽度">
              <Input type="number" value={winWidth} onChange={setWinWidth} onEnter={commitWindow} monospace />
            </Field>
          </div>
          <div style={{ width: 120 }}>
            <Field label="高度">
              <Input type="number" value={winHeight} onChange={setWinHeight} onEnter={commitWindow} monospace />
            </Field>
          </div>
          <div className="col gap-2" style={{ paddingTop: 22 }}>
            <div className="row gap-3">
              <Switch
                checked={instance.window.fullscreen}
                disabled={savingKey === 'window'}
                label="全屏启动"
                onChange={(value) =>
                  void save({ window: { ...instance.window, fullscreen: value } }, '窗口设置', 'window')
                }
              />
              <span className="fs-sm">全屏启动</span>
            </div>
          </div>
          <div className="col gap-2" style={{ paddingTop: 22 }}>
            <Button size="sm" onClick={commitWindow} loading={savingKey === 'window'}>
              保存窗口设置
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* ------------------------------ 启动参数 ------------------------------ */}
      <SectionCard
        icon={<IconWrench size={16} />}
        title="启动参数"
        description="每行一个参数；留空表示使用默认值"
      >
        <div className="col gap-4">
          <Field
            label="额外 JVM 参数"
            hint="例如 -XX:+UseG1GC、-Dfile.encoding=UTF-8。不确定含义时不要随意添加。"
          >
            <Textarea
              value={jvmArgs}
              onChange={setJvmArgs}
              rows={3}
              monospace
              placeholder={'-XX:+UseG1GC\n-Dfile.encoding=UTF-8'}
            />
          </Field>
          <Field label="游戏参数" hint="追加到游戏参数后面，例如 --width 1920 或自定义 quickPlay 参数">
            <Textarea value={gameArgs} onChange={setGameArgs} rows={2} monospace placeholder={'--width 1920\n--height 1080'} />
          </Field>
          <div className="row gap-2">
            <Button size="sm" variant="primary" onClick={commitArgs} loading={savingKey === 'args'}>
              保存参数
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setJvmArgs('')
                setGameArgs('')
              }}
            >
              清空
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* ------------------------------ 备注与标签 ------------------------------ */}
      <SectionCard icon={<IconLayers size={16} />} title="备注与标签" description="记录这个实例的用途，方便日后检索">
        <div className="col gap-4">
          <Field label="备注" hint="AI 诊断结论也会写在这里">
            <Textarea
              value={notes}
              onChange={setNotes}
              rows={3}
              placeholder="例如：1.20.1 主玩整合包，装了 200 个 mod…"
            />
          </Field>
          <Field label="标签" hint="回车添加，点击标签上的 × 删除">
            <div className="row gap-2">
              <Input value={tagInput} onChange={setTagInput} onEnter={addTag} placeholder="输入标签后回车" />
              <Button size="sm" icon={<IconPlus size={13} />} onClick={addTag}>
                添加
              </Button>
            </div>
          </Field>
          <div className="row gap-2 wrap">
            {(instance.tags ?? []).length === 0 ? (
              <span className="fs-xs muted">还没有标签</span>
            ) : (
              (instance.tags ?? []).map((tag) => (
                <Chip key={tag} title="点击删除该标签" onClick={() => removeTag(tag)}>
                  {tag}
                  <IconClose size={11} />
                </Chip>
              ))
            )}
          </div>
          <div>
            <Button size="sm" onClick={() => void save({ notes }, '备注', 'notes')} loading={savingKey === 'notes'}>
              保存备注
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* ------------------------------ 危险操作 ------------------------------ */}
      <div className="mcal-card" style={{ padding: 18, borderColor: 'var(--c-redstone-glow)' }}>
        <div className="row-between gap-3 wrap">
          <div className="col gap-1" style={{ minWidth: 0 }}>
            <span className="row gap-2 fs-md bold">
              <IconAlert size={15} className="err" />
              危险操作
            </span>
            <span className="fs-xs muted">
              删除实例只会移除启动器里的记录，游戏文件（mods、存档、配置）保留在磁盘目录中。
            </span>
            <span className="mono fs-xs faint truncate" title={instance.gameDir}>
              {instance.gameDir}
            </span>
          </div>
          <div className="row gap-2">
            <Button
              size="sm"
              onClick={() => void mcal.revealPath(instance.gameDir).catch((error) => reportError(error, '打开目录失败'))}
            >
              查看目录
            </Button>
            <Button size="sm" variant="danger" icon={<IconTrash size={13} />} onClick={() => setDeleteOpen(true)}>
              删除实例
            </Button>
          </div>
        </div>
      </div>

      <SwitchVersionModal
        open={switchOpen}
        instance={instance}
        onClose={() => setSwitchOpen(false)}
        onSaved={() => void refresh()}
      />
      <InstallLoaderModal
        open={loaderOpen}
        instance={instance}
        onClose={() => setLoaderOpen(false)}
        onInstalled={() => void refresh()}
      />
      <DeleteInstanceModal open={deleteOpen} instance={instance} onClose={() => setDeleteOpen(false)} />
    </div>
  )
}

/* ------------------------------ 新建实例 ------------------------------ */

function CreateInstanceModal({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const refresh = useInstances((state) => state.refresh)
  const setActive = useInstances((state) => state.setActive)
  const settings = useSettings((state) => state.settings)

  const [name, setName] = useState('')
  const [versionId, setVersionId] = useState('')
  const [gameDir, setGameDir] = useState('')
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetchVersionEntries()
      .then((installed) => {
        if (cancelled) return
        setVersions(installed)
        setVersionId((current) => current || installed[0]?.id || '')
      })
      .catch((error) => reportError(error, '读取已安装版本失败'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const pickDir = async (): Promise<void> => {
    try {
      const dir = await mcal.pickDir({ title: '选择游戏目录', defaultPath: settings?.defaultGameDir })
      if (dir) setGameDir(dir)
    } catch (error) {
      reportError(error, '选择目录失败')
    }
  }

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.warn('请先填写实例名称')
      return
    }
    setCreating(true)
    try {
      const created = await mcal.createInstance({
        name: trimmed,
        versionId: versionId || undefined,
        gameDir: gameDir || undefined
      })
      await refresh()
      setActive(created.id)
      toast.ok(`实例「${created.name}」已创建`, created.gameDir)
      setName('')
      setGameDir('')
      onClose()
    } catch (error) {
      reportError(error, '创建实例失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建实例"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={creating} onClick={() => void create()}>
            创建实例
          </Button>
        </>
      }
    >
      <div className="col gap-4">
        <Field label="实例名称" required hint="例如「1.20.1 生存」「1.7.10 怀旧」">
          <Input value={name} onChange={setName} onEnter={() => void create()} placeholder="给这个实例起个名字" autoFocus />
        </Field>

        <Field label="游戏版本" hint={loading ? '正在读取已安装版本…' : '选择已经安装好的版本，之后也可以在详情里切换'}>
          <Select
            value={versionId}
            onChange={setVersionId}
            disabled={loading}
            options={
              versions.length === 0
                ? [{ value: '', label: loading ? '加载中…' : '没有已安装版本（将自动选择最新正式版）' }]
                : versions.map((item) => ({
                    value: item.id,
                    label: `${item.id}（${loaderLabel(item.loaderType)}${
                      item.loaderVersion ? ` ${item.loaderVersion}` : ''
                    }）`
                  }))
            }
          />
        </Field>

        <Field label="游戏目录" hint="留空则自动创建在默认游戏目录下；选择已有目录可以复用现成的 mods 与存档">
          <div className="row gap-2">
            <div className="grow">
              <Input value={gameDir} onChange={setGameDir} monospace placeholder={settings?.defaultGameDir ?? '默认游戏目录'} />
            </div>
            <Button icon={<IconFolder size={14} />} onClick={() => void pickDir()}>
              选择
            </Button>
          </div>
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------ 切换版本 ------------------------------ */

function SwitchVersionModal({
  open,
  instance,
  onClose,
  onSaved
}: {
  open: boolean
  instance: Instance
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element | null {
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(instance.versionId)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSelected(instance.versionId)
    setLoading(true)
    fetchVersionEntries()
      .then((list) => {
        if (!cancelled) setVersions(list)
      })
      .catch((error) => reportError(error, '读取已安装版本失败'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, instance.versionId])

  const apply = async (): Promise<void> => {
    const target = versions.find((item) => item.id === selected)
    if (!target) return
    setSaving(true)
    try {
      await mcal.updateInstance(instance.id, {
        versionId: target.id,
        loaderType: target.loaderType,
        loaderVersion: target.loaderVersion
      })
      toast.ok('已切换版本', `${target.id}（${loaderLabel(target.loaderType)}）`)
      onSaved()
      onClose()
    } catch (error) {
      reportError(error, '切换版本失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="切换游戏版本"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!selected || selected === instance.versionId}
            onClick={() => void apply()}
          >
            应用并保存
          </Button>
        </>
      }
    >
      <div className="col gap-3">
        <div className="fs-sm muted">
          只列出已经安装到磁盘上的版本。没有想要的版本？到「版本下载」页面安装后再回来切换。
        </div>
        {loading ? (
          <div className="col gap-2">
            {[0, 1, 2].map((index) => (
              <div key={index} className="skeleton" style={{ height: 52 }} />
            ))}
          </div>
        ) : versions.length === 0 ? (
          <Empty
            icon={<IconDownload />}
            title="还没有已安装的版本"
            description="先去版本页面下载一个 Minecraft 版本，再回到这里切换。"
          />
        ) : (
          <div className="col gap-2" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {versions.map((item) => (
              <Card
                key={item.id}
                flat
                interactive
                selected={selected === item.id}
                padding={12}
                onClick={() => setSelected(item.id)}
              >
                <div className="row-between gap-2">
                  <span className="row gap-2" style={{ minWidth: 0 }}>
                    <span className="mono bold truncate">{item.id}</span>
                    {item.valid === false ? <Badge tone="err">文件异常</Badge> : null}
                  </span>
                  <div className="row gap-2" style={{ flexShrink: 0 }}>
                    {item.id === instance.versionId ? <Badge tone="ok">当前</Badge> : null}
                    <Badge tone="info">{loaderLabel(item.loaderType)}</Badge>
                  </div>
                </div>
                <div className="row gap-3 fs-xs muted" style={{ marginTop: 6 }}>
                  {item.gameVersion ? <span>游戏版本 {item.gameVersion}</span> : null}
                  {item.type && item.type !== 'installed' ? <span>{item.type}</span> : null}
                  {item.loaderVersion ? <span className="mono">{item.loaderVersion}</span> : null}
                  {item.sizeBytes ? <span>{formatBytes(item.sizeBytes)}</span> : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ------------------------------ 安装加载器 ------------------------------ */

function InstallLoaderModal({
  open,
  instance,
  onClose,
  onInstalled
}: {
  open: boolean
  instance: Instance
  onClose: () => void
  onInstalled: () => void
}): React.JSX.Element | null {
  const tasks = useTasks((state) => state.tasks)

  const [loaderType, setLoaderType] = useState<LoaderType>('fabric')
  const [gameVersion, setGameVersion] = useState(guessBaseGameVersion(instance.versionId))
  const [versions, setVersions] = useState<LoaderVersion[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const task = useMemo(() => latestTask(tasks, 'install-loader'), [tasks])
  const liveTask = installing ? task : undefined

  useEffect(() => {
    if (!open) return
    setGameVersion(guessBaseGameVersion(instance.versionId))
    setVersions(null)
    setSelected(null)
    setConfirming(false)
    setInstalling(false)
    setError(null)
  }, [open, instance.id, instance.versionId])

  const query = async (): Promise<void> => {
    const target = gameVersion.trim()
    if (!target) {
      toast.warn('请先填写游戏版本', '例如 1.20.1')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const list = await mcal.listLoaderVersions({ loaderType, gameVersion: target })
      setVersions(list)
      setSelected(list.find((item) => item.stable)?.version ?? list[0]?.version ?? null)
      if (list.length === 0) {
        toast.info('没有查到可用版本', `请确认 ${loaderLabel(loaderType)} 是否支持 ${target}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      reportError(err, '查询加载器版本失败')
    } finally {
      setLoading(false)
    }
  }

  const install = async (): Promise<void> => {
    if (!selected) return
    setConfirming(false)
    setInstalling(true)
    try {
      const result = await mcal.installLoader({
        gameDir: instance.gameDir,
        versionId: instance.versionId,
        loaderType,
        loaderVersion: selected,
        createInstance: false
      })
      await mcal.updateInstance(instance.id, {
        versionId: result.versionId,
        loaderType: result.loaderType,
        loaderVersion: result.loaderVersion
      })
      toast.ok(
        `${loaderLabel(loaderType)} ${selected} 安装完成`,
        result.warnings.length > 0 ? result.warnings[0] : `实例版本已切换为 ${result.versionId}`
      )
      onInstalled()
      onClose()
    } catch (err) {
      reportError(err, '安装加载器失败')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const confirmOpen = confirming && selected !== null

  return (
    <Modal
      open={open}
      onClose={installing ? () => undefined : onClose}
      closeOnOverlay={!installing}
      wide
      title="安装 mod 加载器"
    >
      <div className="col gap-4">
        <div className="col gap-3">
          <Field label="加载器类型">
            <div className="row gap-2 wrap">
              {LOADER_CHOICES.map((choice) => (
                <Chip
                  key={choice.value}
                  active={loaderType === choice.value}
                  onClick={() => {
                    setLoaderType(choice.value)
                    setVersions(null)
                    setSelected(null)
                  }}
                >
                  {choice.label}
                </Chip>
              ))}
            </div>
          </Field>

          <div className="row-start gap-3 wrap">
            <div style={{ width: 200 }}>
              <Field label="游戏版本" hint="加载器要装到哪个 MC 版本上">
                <Input value={gameVersion} onChange={setGameVersion} monospace placeholder="1.20.1" onEnter={() => void query()} />
              </Field>
            </div>
            <div className="col gap-2" style={{ paddingTop: 22 }}>
              <Button variant="primary" loading={loading} onClick={() => void query()}>
                查询可用版本
              </Button>
            </div>
          </div>

          <div className="mcal-panel" style={{ padding: 12 }}>
            <div className="row gap-2 fs-xs muted">
              <IconFolder size={13} />
              安装目标目录：
              <span className="mono truncate" title={instance.gameDir}>
                {instance.gameDir}
              </span>
            </div>
          </div>
        </div>

        {versions === null ? (
          <div className="fs-sm muted">
            选择加载器类型并填写游戏版本后，点击「查询可用版本」。安装会向该目录写入库文件与版本 json，需要联网下载。
          </div>
        ) : versions.length === 0 ? (
          <Empty
            icon={<IconWrench />}
            title="没有找到可用版本"
            description={`${loaderLabel(loaderType)} 可能不支持 ${gameVersion}，换个游戏版本或加载器试试。`}
          />
        ) : (
          <div className="col gap-2" style={{ maxHeight: 300, overflowY: 'auto' }}>
            {versions.slice(0, 60).map((item) => (
              <Card
                key={`${item.loaderType}-${item.version}`}
                flat
                interactive
                selected={selected === item.version}
                padding={12}
                onClick={() => setSelected(item.version)}
              >
                <div className="row-between gap-2">
                  <span className="mono bold">{item.version}</span>
                  <div className="row gap-2">
                    {item.stable ? <Badge tone="ok">推荐</Badge> : null}
                    {item.label ? <Badge>{item.label}</Badge> : null}
                  </div>
                </div>
                <div className="fs-xs muted" style={{ marginTop: 4 }}>
                  {item.gameVersion} · {loaderLabel(item.loaderType)}
                </div>
              </Card>
            ))}
          </div>
        )}

        {liveTask ? (
          <TaskProgressPanel task={liveTask} label="正在安装加载器" onCancel={() => void mcal.cancelTask(liveTask.taskId)} />
        ) : null}

        {error ? (
          <div className="row-start gap-2 fs-sm err">
            <IconAlert size={14} />
            <span className="pre-wrap break-all">{error}</span>
          </div>
        ) : null}

        <div className="row-between gap-3">
          <span className="fs-xs muted">安装完成后，实例的版本会自动切换为带加载器的版本。</span>
          <div className="row gap-2">
            <Button variant="ghost" onClick={onClose} disabled={installing}>
              取消
            </Button>
            <Button variant="primary" disabled={!selected || installing} onClick={() => setConfirming(true)}>
              安装
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirming(false)}
        title="确认安装加载器"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              再想想
            </Button>
            <Button variant="primary" icon={<IconDownload size={14} />} onClick={() => void install()}>
              开始安装
            </Button>
          </>
        }
      >
        <div className="col gap-3">
          <div className="fs-sm">即将执行以下操作：</div>
          <div className="mcal-panel col gap-2" style={{ padding: 12 }}>
            <div className="row-between fs-sm">
              <span className="muted">加载器</span>
              <span className="mono">
                {loaderLabel(loaderType)} {selected}
              </span>
            </div>
            <div className="row-between fs-sm">
              <span className="muted">目标版本</span>
              <span className="mono">{instance.versionId}</span>
            </div>
            <div className="row-between fs-sm">
              <span className="muted">目录</span>
              <span className="mono fs-xs truncate" style={{ maxWidth: 320 }} title={instance.gameDir}>
                {instance.gameDir}
              </span>
            </div>
          </div>
          <div className="fs-xs muted">
            安装会向该目录写入新的库文件与版本 json，同名文件会被覆盖；同时需要联网下载若干文件。安装期间请保持网络畅通。
          </div>
        </div>
      </Modal>
    </Modal>
  )
}

/* ------------------------------ 共享：长任务进度 ------------------------------ */

export function TaskProgressPanel({
  task,
  label,
  onCancel
}: {
  task: TaskState
  label: string
  onCancel?: () => void
}): React.JSX.Element {
  const progress = task.progress
  const ratio =
    progress && progress.bytesTotal > 0
      ? progress.bytesDone / progress.bytesTotal
      : progress && progress.total > 0
        ? progress.completed / progress.total
        : undefined
  const logs = (task.logs ?? []).slice(-6)

  return (
    <div className="mcal-panel col gap-3" style={{ padding: 14 }}>
      <div className="row-between gap-3">
        <div className="row gap-2">
          {task.state === 'running' ? <span className="mcal-spinner accent" /> : null}
          <span className="fs-sm bold">{label}</span>
          <Badge tone={task.state === 'failed' ? 'err' : task.state === 'completed' ? 'ok' : 'info'}>
            {task.state === 'running'
              ? '进行中'
              : task.state === 'completed'
                ? '已完成'
                : task.state === 'failed'
                  ? '失败'
                  : '已取消'}
          </Badge>
        </div>
        {onCancel && task.state === 'running' ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        ) : null}
      </div>

      <Progress value={ratio ?? 0} indeterminate={ratio === undefined && task.state === 'running'} />

      <div className="row gap-4 wrap fs-xs muted">
        {progress ? (
          <>
            <span>
              文件 <span className="mono">{progress.completed}</span>/<span className="mono">{progress.total}</span>
            </span>
            {progress.bytesTotal > 0 ? (
              <span>
                数据 <span className="mono">{formatBytes(progress.bytesDone)}</span>/
                <span className="mono">{formatBytes(progress.bytesTotal)}</span>
              </span>
            ) : null}
            {progress.speed > 0 ? <span className="mono">{formatBytes(progress.speed)}/s</span> : null}
            {progress.etaSeconds !== null ? <span>剩余约 {formatDuration(progress.etaSeconds)}</span> : null}
          </>
        ) : (
          <span>正在处理（该阶段不提供字节进度）…</span>
        )}
        {ratio !== undefined ? <span className="mono">{Math.round(ratio * 100)}%</span> : null}
      </div>

      {logs.length > 0 ? (
        <div className="log-view" style={{ maxHeight: 120, minHeight: 60 }}>
          {logs.map((line, index) => (
            <div key={index} className="log-view__line--info">
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {task.error ? <div className="fs-xs err pre-wrap break-all">{task.error}</div> : null}
    </div>
  )
}

/* ------------------------------ 删除实例 ------------------------------ */

function DeleteInstanceModal({
  open,
  instance,
  onClose
}: {
  open: boolean
  instance: Instance
  onClose: () => void
}): React.JSX.Element | null {
  const refresh = useInstances((state) => state.refresh)
  const [deleting, setDeleting] = useState(false)

  const confirm = async (): Promise<void> => {
    setDeleting(true)
    try {
      await mcal.deleteInstance(instance.id)
      await refresh()
      toast.ok('实例记录已删除', '游戏文件仍保留在磁盘上')
      onClose()
    } catch (error) {
      reportError(error, '删除实例失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="删除实例"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" icon={<IconTrash size={14} />} loading={deleting} onClick={() => void confirm()}>
            确认删除
          </Button>
        </>
      }
    >
      <div className="col gap-3">
        <div className="row-start gap-3">
          <IconAlert size={18} className="err" style={{ flexShrink: 0, marginTop: 2 }} />
          <div className="col gap-2">
            <div className="fs-md bold">只会删除实例记录，游戏文件保留在磁盘上</div>
            <div className="fs-sm muted">
              删除后，「{instance.name}」不再出现在启动器里；目录中的 mods、存档、配置文件都不会被删除，随时可以重新创建实例指向它。
            </div>
          </div>
        </div>
        <div className="mcal-panel col gap-2" style={{ padding: 12 }}>
          <div className="fs-xs muted">游戏目录</div>
          <div className="mono fs-xs break-all">{instance.gameDir}</div>
          <div className="row gap-2">
            <Button size="sm" icon={<IconFolder size={13} />} onClick={() => void mcal.openInstanceDir(instance.id).catch((error) => reportError(error))}>
              打开目录
            </Button>
            <Button size="sm" icon={<IconLayers size={13} />} onClick={() => void copyText(instance.gameDir, '游戏目录')}>
              复制路径
            </Button>
            <Button size="sm" icon={<IconExternal size={13} />} onClick={() => void mcal.revealPath(instance.gameDir).catch((error) => reportError(error))}>
              在资源管理器中显示
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
