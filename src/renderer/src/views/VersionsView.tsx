/**
 * 版本下载与安装页
 *   三个标签页：已安装（可创建实例 / 删除）、可下载（Mojang 清单，分页加载）、加载器（各加载器版本 + 安装）
 *
 * 交互约定：
 *  - 安装版本 / 加载器都是长任务：进度来自 useTasks().tasks（主进程事件推送），显示速率与剩余时间，支持取消；
 *  - 所有网络请求都有加载态；失败时给出可操作提示（切换到 BMCLAPI 镜像等）；
 *  - 顶部提供下载源（镜像）快捷切换。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Instance,
  LoaderType,
  LoaderVersion,
  McalSettings,
  MirrorId,
  TaskState,
  VersionManifest,
  VersionSummary
} from '@shared/types'
import { mcal } from '../lib/api'
import { formatBytes, formatDateTime, formatDuration, formatRelativeTime, loaderLabel } from '../lib/format'
import { reportError, toast, useInstances, useSettings, useTasks, useView } from '../state/store'
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
  Segmented,
  Tabs,
  Tooltip
} from '../components/ui/primitives'
import {
  IconAlert,
  IconBox,
  IconCheck,
  IconDownload,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconServer,
  IconTrash,
  IconWrench
} from '../components/ui/icons'

const PAGE_SIZE = 40

type TabId = 'installed' | 'remote' | 'loader'
type TypeFilter = 'all' | 'release' | 'snapshot' | 'old'

const LOADER_CHOICES: { value: LoaderType; label: string }[] = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'optifine', label: 'OptiFine' }
]

const MIRROR_LABELS: Record<string, string> = {
  official: '官方',
  bmclapi: 'BMCLAPI',
  custom: '自定义'
}

function guessBaseGameVersion(versionId: string): string {
  const match = /1\.\d+(?:\.\d+)?/.exec(versionId)
  return match ? match[0] : versionId
}

function latestTask(tasks: TaskState[], kind: string): TaskState | undefined {
  return tasks
    .filter((task) => task.kind === kind)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
}

/**
 * listVersions() 在主进程返回轻量结构：本地版本（installed=true）与清单版本（installed=false）。
 * api.ts 上声明的 InstalledVersion 与实际字段略有出入，这里按运行时字段读取并容忍可选扩展字段。
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
  return Array.isArray(list) ? list : []
}

function typeLabel(type: string): string {
  switch (type) {
    case 'release':
      return '正式版'
    case 'snapshot':
      return '快照'
    case 'old_beta':
      return '远古 Beta'
    case 'old_alpha':
      return '远古 Alpha'
    default:
      return type
  }
}

function typeTone(type: string): 'ok' | 'info' | 'default' | 'gold' {
  if (type === 'release') return 'ok'
  if (type === 'snapshot') return 'info'
  if (type === 'old_beta') return 'gold'
  return 'default'
}

export function VersionsView(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('installed')

  const settings = useSettings((state) => state.settings)
  const updateSettings = useSettings((state) => state.update)
  const instances = useInstances((state) => state.instances)
  const activeId = useInstances((state) => state.activeInstanceId)
  const refreshInstances = useInstances((state) => state.refresh)

  const [versions, setVersions] = useState<VersionEntry[] | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [switchingMirror, setSwitchingMirror] = useState(false)
  // 版本清单缓存放在页面级：切换标签页不会丢失已拉取的清单
  const [manifest, setManifest] = useState<VersionManifest | null>(null)
  const [loadingManifest, setLoadingManifest] = useState(false)
  const [manifestError, setManifestError] = useState<string | null>(null)

  const loadManifest = useCallback(async (refresh = true): Promise<void> => {
    setLoadingManifest(true)
    setManifestError(null)
    try {
      const data = await mcal.getManifest(refresh)
      setManifest(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setManifestError(message)
      reportError(err, '获取版本清单失败')
      toast.info('可以试试切换下载源', '点击顶部「Mojang / BMCLAPI」切到 BMCLAPI 镜像后重试')
    } finally {
      setLoadingManifest(false)
    }
  }, [])

  const activeInstance = useMemo(
    () => instances.find((item) => item.id === activeId) ?? instances[0],
    [instances, activeId]
  )
  const installedCount = useMemo(() => (versions ?? []).filter((item) => item.installed).length, [versions])

  const loadVersions = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoadingVersions(true)
    try {
      setVersions(await fetchVersionEntries())
    } catch (error) {
      reportError(error, '读取已安装版本失败')
      setVersions([])
    } finally {
      if (!silent) setLoadingVersions(false)
    }
  }, [])

  useEffect(() => {
    void loadVersions()
  }, [loadVersions])

  const mirror = settings?.mirror

  const setMojangSource = async (channel: 'mojang' | 'forge' | 'fabric' | 'modrinth'): Promise<void> => {
    if (!settings || !mirror) return
    const current = mirror[channel] ?? 'official'
    const next: MirrorId = current === 'bmclapi' ? 'official' : 'bmclapi'
    setSwitchingMirror(true)
    try {
      const patch: McalSettings['mirror'] = { ...mirror, [channel]: next }
      await updateSettings({ mirror: patch })
      toast.ok(
        `${channel === 'mojang' ? 'Mojang 资源' : channel} 下载源已切换为 ${MIRROR_LABELS[next] ?? next}`,
        next === 'bmclapi' ? '国内网络使用 BMCLAPI 通常更快' : '已使用官方源，下载失败时可切换到 BMCLAPI'
      )
    } catch (error) {
      reportError(error, '切换下载源失败')
    } finally {
      setSwitchingMirror(false)
    }
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>版本下载与安装</h2>
          <span className="fs-sm muted">
            已安装 {installedCount} 个版本 · 下载源决定文件从哪里拉取，网络慢时优先选 BMCLAPI 镜像
          </span>
        </div>
        <div className="row gap-2 wrap">
          {(['mojang', 'forge', 'fabric', 'modrinth'] as const).map((channel) => (
            <Tooltip key={channel} content={`点击在 官方 / BMCLAPI 之间切换${channel === 'mojang' ? '（同时影响依赖库与资源文件）' : ''}`}>
              <Chip
                active={(mirror?.[channel] ?? 'official') === 'bmclapi'}
                onClick={() => void setMojangSource(channel)}
                title={`切换 ${channel} 下载源`}
              >
                <IconServer size={12} />
                {channel === 'mojang' ? 'Mojang' : channel === 'modrinth' ? 'Modrinth' : channel.charAt(0).toUpperCase() + channel.slice(1)}
                <span className="muted">{MIRROR_LABELS[mirror?.[channel] ?? 'official'] ?? '官方'}</span>
              </Chip>
            </Tooltip>
          ))}
          {switchingMirror ? <span className="mcal-spinner accent" /> : null}
        </div>
      </div>

      <div className="page__body">
        <div style={{ marginBottom: 16 }}>
          <Card>
            <div style={{ padding: '0 var(--s-2)' }}>
              <Tabs
                value={tab}
                onChange={setTab}
                options={[
                  {
                    value: 'installed',
                    label: '已安装',
                    badge: versions ? <Badge tone={installedCount > 0 ? 'ok' : 'default'}>{installedCount}</Badge> : null
                  },
                  { value: 'remote', label: '可下载' },
                  { value: 'loader', label: '加载器' }
                ]}
              />
            </div>
          </Card>
        </div>

        {tab === 'installed' ? (
          <InstalledTab
            versions={versions}
            loading={loadingVersions}
            instances={instances}
            onReload={() => void loadVersions()}
            onChanged={() => void loadVersions(true)}
            onGoRemote={() => setTab('remote')}
          />
        ) : tab === 'remote' ? (
          <RemoteTab
            manifest={manifest}
            loading={loadingManifest}
            error={manifestError}
            onLoad={loadManifest}
            installedIds={new Set((versions ?? []).filter((item) => item.installed).map((item) => item.id))}
            onInstalled={() => void loadVersions(true)}
          />
        ) : (
          <LoaderTab
            instance={activeInstance}
            defaultGameDir={settings?.defaultGameDir ?? ''}
            onDone={() => {
              void loadVersions(true)
              void refreshInstances()
            }}
          />
        )}
      </div>
    </div>
  )
}

/* ------------------------------ 已安装 ------------------------------ */

function InstalledTab({
  versions,
  loading,
  instances,
  onReload,
  onChanged,
  onGoRemote
}: {
  versions: VersionEntry[] | null
  loading: boolean
  instances: Instance[]
  onReload: () => void
  onChanged: () => void
  onGoRemote: () => void
}): React.JSX.Element {
  const [createFor, setCreateFor] = useState<VersionEntry | null>(null)
  const [deleteFor, setDeleteFor] = useState<VersionEntry | null>(null)

  const installed = (versions ?? []).filter((item) => item.installed)
  const instanceNameById = useMemo(() => new Map(instances.map((item) => [item.id, item.name])), [instances])

  return (
    <div className="col gap-4">
      <div className="row-between gap-3 wrap">
        <span className="fs-sm muted">
          这些版本已经下载到本地。同一版本可以被多个实例共用（各自独立目录、独立 mods）。
        </span>
        <Button size="sm" icon={<IconRefresh size={13} />} loading={loading} onClick={onReload}>
          刷新
        </Button>
      </div>

      {loading && versions === null ? (
        <div className="col gap-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="skeleton" style={{ height: 84 }} />
          ))}
        </div>
      ) : installed.length === 0 ? (
        <Card padding={8}>
          <Empty
            icon={<IconBox />}
            title="还没有安装任何版本"
            description="切换到「可下载」标签页挑一个版本安装；安装完成后就能创建实例开始游戏。"
            action={
              <Button variant="primary" icon={<IconDownload size={15} />} onClick={onGoRemote}>
                去「可下载」挑选版本
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="col gap-3 stagger">
          {installed.map((item) => {
            // 引用关系：优先用主进程给出的 usedByInstances，再补上 gameDir 里版本 id 匹配的实例
            const referenced = new Set(item.usedByInstances ?? [])
            for (const instance of instances) {
              if (instance.versionId === item.id) referenced.add(instance.id)
            }
            const usedBy = [...referenced]
            return (
              <Card key={item.id} padding={16}>
                <div className="row-between gap-3 wrap">
                  <div className="col gap-2" style={{ minWidth: 0 }}>
                    <div className="row gap-2 wrap">
                      <span className="mono fs-md bold" title={item.id}>
                        {item.id}
                      </span>
                      <Badge tone={item.loaderType === 'vanilla' ? 'default' : 'info'}>{loaderLabel(item.loaderType)}</Badge>
                      {item.loaderVersion ? <Badge tone="violet">{item.loaderVersion}</Badge> : null}
                      {item.valid === false ? <Badge tone="err">文件异常</Badge> : null}
                      {item.isIsolated ? <Badge tone="gold">版本隔离</Badge> : null}
                    </div>
                    <div className="row gap-3 wrap fs-xs muted">
                      {item.gameVersion ? <span>游戏版本 {item.gameVersion}</span> : <span>本地已安装</span>}
                      {item.sizeBytes ? <span>占用 {formatBytes(item.sizeBytes)}</span> : null}
                      {item.installedAt ? <span>安装于 {formatRelativeTime(item.installedAt)}</span> : null}
                    </div>
                    {item.dir ? (
                      <div className="fs-xs muted" title={item.dir}>
                        目录：<span className="mono">{item.dir}</span>
                      </div>
                    ) : null}
                    <div className="row gap-2 wrap fs-xs">
                      {usedBy.length === 0 ? (
                        <span className="muted">尚未被任何实例引用</span>
                      ) : (
                        <>
                          <span className="muted">被 {usedBy.length} 个实例使用：</span>
                          {usedBy.slice(0, 4).map((id) => (
                            <Badge key={id} tone="ok">
                              {instanceNameById.get(id) ?? id}
                            </Badge>
                          ))}
                          {usedBy.length > 4 ? <span className="muted">等</span> : null}
                        </>
                      )}
                    </div>
                    {item.valid === false && item.error ? <div className="fs-xs err">{item.error}</div> : null}
                  </div>
                  <div className="row gap-2 wrap" style={{ flexShrink: 0 }}>
                    {item.dir ? (
                      <Button
                        size="sm"
                        icon={<IconFolder size={13} />}
                        onClick={() => void mcal.revealPath(item.dir as string).catch((error) => reportError(error, '打开目录失败'))}
                      >
                        查看文件
                      </Button>
                    ) : null}
                    <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => setCreateFor(item)}>
                      创建实例
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<IconTrash size={13} />}
                      disabled={usedBy.length > 0}
                      title={usedBy.length > 0 ? '仍有实例引用该版本，先删除实例或切换版本' : '删除该版本'}
                      onClick={() => setDeleteFor(item)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <CreateFromVersionModal version={createFor} onClose={() => setCreateFor(null)} onCreated={onChanged} />
      <DeleteVersionModal
        version={deleteFor}
        onClose={() => setDeleteFor(null)}
        onDeleted={() => {
          onChanged()
        }}
      />
    </div>
  )
}

function CreateFromVersionModal({
  version,
  onClose,
  onCreated
}: {
  version: VersionEntry | null
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element | null {
  const settings = useSettings((state) => state.settings)
  const refresh = useInstances((state) => state.refresh)
  const setActive = useInstances((state) => state.setActive)
  const navigate = useView((state) => state.navigate)

  const [name, setName] = useState('')
  const [gameDir, setGameDir] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!version) return
    setName(`${version.id} 实例`)
    setGameDir('')
  }, [version])

  if (!version) return null

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.warn('请填写实例名称')
      return
    }
    setCreating(true)
    try {
      const created = await mcal.createInstance({
        name: trimmed,
        versionId: version.id,
        gameDir: gameDir || undefined,
        loaderType: version.loaderType,
        loaderVersion: version.loaderVersion
      })
      toast.ok(`实例「${created.name}」已创建`, '可以到实例页调整内存与 Java 设置')
      await refresh()
      setActive(created.id)
      onCreated()
      onClose()
      navigate('instances')
    } catch (error) {
      reportError(error, '创建实例失败')
    } finally {
      setCreating(false)
    }
  }

  const pickDir = async (): Promise<void> => {
    try {
      const dir = await mcal.pickDir({ title: '选择该实例的游戏目录', defaultPath: settings?.defaultGameDir })
      if (dir) setGameDir(dir)
    } catch (error) {
      reportError(error, '选择目录失败')
    }
  }

  return (
    <Modal
      open={version !== null}
      onClose={onClose}
      title={`用 ${version.id} 创建实例`}
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
        <div className="mcal-panel col gap-2" style={{ padding: 12 }}>
          <div className="row-between fs-sm">
            <span className="muted">版本</span>
            <span className="mono">{version.id}</span>
          </div>
          <div className="row-between fs-sm">
            <span className="muted">加载器</span>
            <span>
              {loaderLabel(version.loaderType)}
              {version.loaderVersion ? ` ${version.loaderVersion}` : ''}
            </span>
          </div>
        </div>
        <Field label="实例名称" required>
          <Input value={name} onChange={setName} onEnter={() => void create()} autoFocus />
        </Field>
        <Field label="游戏目录" hint="留空则创建在默认游戏目录下（不同实例目录互相隔离，mod 不会串味）">
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

function DeleteVersionModal({
  version,
  onClose,
  onDeleted
}: {
  version: VersionEntry | null
  onClose: () => void
  onDeleted: () => void
}): React.JSX.Element | null {
  const [deleting, setDeleting] = useState(false)

  const confirm = async (): Promise<void> => {
    if (!version) return
    setDeleting(true)
    try {
      await mcal.removeVersion(version.id)
      toast.ok(`版本 ${version.id} 已删除`, '磁盘空间已释放')
      onDeleted()
      onClose()
    } catch (error) {
      reportError(error, '删除版本失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Modal
      open={version !== null}
      onClose={onClose}
      title="删除已安装版本"
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
      {version ? (
        <div className="col gap-3">
          <div className="row-start gap-3">
            <IconAlert size={18} className="err" style={{ flexShrink: 0, marginTop: 2 }} />
            <div className="col gap-2">
              <div className="fs-md bold">会从磁盘删除该版本的所有文件</div>
              <div className="fs-sm muted">
                将删除版本目录下的客户端 jar、json 与本地库文件。使用该版本的实例会无法启动，需要重新下载。
              </div>
            </div>
          </div>
          <div className="mcal-panel col gap-2" style={{ padding: 12 }}>
            <div className="row-between fs-sm">
              <span className="muted">版本</span>
              <span className="mono">{version.id}</span>
            </div>
            <div className="col gap-1">
              <span className="fs-xs muted">目录</span>
              <span className="mono fs-xs break-all">
                {version.dir ?? '（默认游戏目录下 versions 文件夹中的同名目录）'}
              </span>
            </div>
            {version.sizeBytes ? (
              <div className="row-between fs-sm">
                <span className="muted">预计释放</span>
                <span>{formatBytes(version.sizeBytes)}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

/* ------------------------------ 可下载 ------------------------------ */

function RemoteTab({
  manifest,
  loading,
  error,
  onLoad,
  installedIds,
  onInstalled
}: {
  manifest: VersionManifest | null
  loading: boolean
  error: string | null
  onLoad: (refresh?: boolean) => Promise<void>
  installedIds: Set<string>
  onInstalled: () => void
}): React.JSX.Element {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('release')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [installing, setInstalling] = useState<string | null>(null)

  const tasks = useTasks((state) => state.tasks)

  const liveTask = useMemo(() => {
    if (!installing) return undefined
    return tasks
      .filter((task) => task.kind === 'install-version' && task.label === `安装 Minecraft ${installing}`)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
  }, [tasks, installing])

  useEffect(() => {
    if (manifest === null && !loading) void onLoad(true)
    // 仅在首次进入且没有缓存清单时拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setLimit(PAGE_SIZE)
  }, [typeFilter, search])

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return (manifest?.versions ?? []).filter((item) => {
      if (typeFilter === 'release' && item.type !== 'release') return false
      if (typeFilter === 'snapshot' && item.type !== 'snapshot') return false
      if (typeFilter === 'old' && item.type !== 'old_beta' && item.type !== 'old_alpha') return false
      if (keyword && !item.id.toLowerCase().includes(keyword)) return false
      return true
    })
  }, [manifest, typeFilter, search])

  const visible = filtered.slice(0, limit)

  const install = async (item: VersionSummary): Promise<void> => {
    setInstalling(item.id)
    try {
      await mcal.installVersion(item.id)
      toast.ok(`Minecraft ${item.id} 安装完成`, '现在可以创建实例开始游戏了')
      onInstalled()
    } catch (err) {
      reportError(err, `安装 ${item.id} 失败`)
      toast.info('下载源可能不可用', '试试切换到 BMCLAPI 镜像后重试，或检查网络代理设置')
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="col gap-4">
      <div className="row-between gap-3 wrap">
        <div className="row gap-3 wrap">
          <Segmented
            value={typeFilter}
            onChange={setTypeFilter}
            options={[
              { value: 'release', label: '正式版' },
              { value: 'snapshot', label: '快照' },
              { value: 'old', label: '远古版本' },
              { value: 'all', label: '全部' }
            ]}
          />
          <div style={{ width: 220 }}>
            <SearchInput value={search} onChange={setSearch} placeholder="按版本号搜索，如 1.20.1" />
          </div>
        </div>
        <div className="row gap-3">
          <span className="fs-xs muted">
            {manifest ? `共 ${filtered.length} 个版本` : loading ? '正在获取清单…' : '尚未获取清单'}
            {manifest?.latest ? ` · 最新正式版 ${manifest.latest.release}` : ''}
          </span>
          <Button size="sm" icon={<IconRefresh size={13} />} loading={loading} onClick={() => void onLoad(true)}>
            刷新清单
          </Button>
        </div>
      </div>

      {installing && liveTask ? (
        <LiveTask
          task={liveTask}
          label={`正在安装 Minecraft ${installing}`}
          onCancel={() => void mcal.cancelTask(liveTask.taskId)}
        />
      ) : null}

      {loading && !manifest ? (
        <div className="col gap-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="skeleton" style={{ height: 58 }} />
          ))}
        </div>
      ) : error && !manifest ? (
        <Card padding={8}>
          <Empty
            icon={<IconAlert />}
            title="版本清单获取失败"
            description={
              <span className="pre-wrap break-all">
                {error}。这通常是网络问题：可以在顶部把下载源切换到 BMCLAPI 镜像后重试。
              </span>
            }
            action={
              <div className="row gap-2" style={{ marginTop: 8 }}>
                <Button variant="primary" icon={<IconRefresh size={14} />} onClick={() => void onLoad(true)}>
                  重新获取
                </Button>
              </div>
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card padding={8}>
          <Empty
            icon={<IconDownload />}
            title="没有匹配的版本"
            description="换个类型筛选或清空搜索关键词试试。"
            action={
              <Button variant="ghost" onClick={() => { setSearch(''); setTypeFilter('all') }}>
                查看全部版本
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="mcal-list stagger">
          {visible.map((item) => {
            const isInstalled = installedIds.has(item.id)
            const isBusy = installing === item.id
            return (
              <div key={item.id} className="mcal-list__row">
                <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                  <div className="row gap-2">
                    <span className="mono bold" title={item.id}>
                      {item.id}
                    </span>
                    <Badge tone={typeTone(item.type)}>{typeLabel(item.type)}</Badge>
                    {isInstalled ? <Badge tone="ok">已安装</Badge> : null}
                    {item.id === manifest?.latest.release ? <Badge tone="gold">最新正式版</Badge> : null}
                  </div>
                  <div className="fs-xs muted">发布于 {formatDateTime(item.releaseTime || item.time)}</div>
                </div>
                <Button
                  size="sm"
                  variant={isInstalled ? 'default' : 'primary'}
                  icon={<IconDownload size={13} />}
                  loading={isBusy}
                  disabled={installing !== null && !isBusy}
                  onClick={() => void install(item)}
                >
                  {isBusy ? '安装中…' : isInstalled ? '重新安装' : '安装'}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {visible.length < filtered.length ? (
        <div className="center" style={{ paddingBottom: 8 }}>
          <Button onClick={() => setLimit((value) => value + PAGE_SIZE)}>
            加载更多（还有 {filtered.length - visible.length} 个）
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------ 加载器 ------------------------------ */

function LoaderTab({
  instance,
  defaultGameDir,
  onDone
}: {
  instance?: Instance
  defaultGameDir: string
  onDone: () => void
}): React.JSX.Element {
  const [loaderType, setLoaderType] = useState<LoaderType>('fabric')
  const [gameVersion, setGameVersion] = useState(guessBaseGameVersion(instance?.versionId ?? ''))
  const [targetDir, setTargetDir] = useState(instance?.gameDir ?? defaultGameDir)
  const [instanceName, setInstanceName] = useState('')
  const [versions, setVersions] = useState<LoaderVersion[] | null>(null)
  const [querying, setQuerying] = useState(false)
  const [selected, setSelected] = useState<LoaderVersion | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [search, setSearch] = useState('')

  const tasks = useTasks((state) => state.tasks)
  const liveTask = useMemo(() => (installing ? latestTask(tasks, 'install-loader') : undefined), [tasks, installing])

  useEffect(() => {
    if (instance && !targetDir) setTargetDir(instance.gameDir)
  }, [instance, targetDir])

  const query = async (): Promise<void> => {
    const target = gameVersion.trim()
    if (!target) {
      toast.warn('请填写游戏版本', '例如 1.20.1；加载器只会安装到指定版本上')
      return
    }
    setQuerying(true)
    setVersions(null)
    setSelected(null)
    try {
      const list = await mcal.listLoaderVersions({ loaderType, gameVersion: target })
      setVersions(list)
      setSelected(list.find((item) => item.stable) ?? list[0] ?? null)
      if (list.length === 0) {
        toast.info('没有查到可用版本', `${loaderLabel(loaderType)} 可能还不支持 ${target}`)
      }
    } catch (error) {
      reportError(error, '查询加载器版本失败')
      toast.info('查询失败通常是网络问题', '可以切换顶部下载源到 BMCLAPI 后重试')
    } finally {
      setQuerying(false)
    }
  }

  const pickDir = async (): Promise<void> => {
    try {
      const dir = await mcal.pickDir({ title: '选择加载器安装目录', defaultPath: targetDir || defaultGameDir })
      if (dir) setTargetDir(dir)
    } catch (error) {
      reportError(error, '选择目录失败')
    }
  }

  const install = async (): Promise<void> => {
    if (!selected) return
    if (!targetDir.trim()) {
      toast.warn('请先指定安装目录')
      return
    }
    setConfirming(false)
    setInstalling(true)
    try {
      const result = await mcal.installLoader({
        gameDir: targetDir.trim(),
        versionId: gameVersion.trim(),
        loaderType,
        loaderVersion: selected.version,
        createInstance: true,
        instanceName: instanceName.trim() || undefined
      })
      toast.ok(
        `${loaderLabel(loaderType)} ${selected.version} 安装完成`,
        `新版本 ${result.versionId} 已就绪，已创建对应实例`
      )
      for (const warning of result.warnings.slice(0, 2)) toast.warn('安装提示', warning)
      onDone()
    } catch (error) {
      reportError(error, '安装加载器失败')
      toast.info('如果卡在下载步骤', '试试切换顶部下载源到 BMCLAPI 镜像')
    } finally {
      setInstalling(false)
    }
  }

  const filtered = useMemo(() => {
    const list = versions ?? []
    const keyword = search.trim().toLowerCase()
    if (!keyword) return list
    return list.filter((item) => item.version.toLowerCase().includes(keyword))
  }, [versions, search])

  return (
    <div className="col gap-4">
      <Card padding={18}>
        <div className="col gap-4">
          <Field label="加载器类型" hint="Fabric / Quilt 轻量；Forge / NeoForge 适合大型整合包；OptiFine 建议光影用户选择 Iris 替代">
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
            <div style={{ width: 180 }}>
              <Field label="游戏版本" hint="加载器挂载到哪个 MC 版本">
                <Input value={gameVersion} onChange={setGameVersion} monospace placeholder="1.20.1" onEnter={() => void query()} />
              </Field>
            </div>
            <div style={{ width: 200 }}>
              <Field label="实例名称" hint="安装完成后创建的实例名（可留空）">
                <Input value={instanceName} onChange={setInstanceName} placeholder={`${loaderLabel(loaderType)} ${gameVersion}`} />
              </Field>
            </div>
            <div className="col gap-2" style={{ paddingTop: 22 }}>
              <Button variant="primary" loading={querying} onClick={() => void query()}>
                查询可用版本
              </Button>
            </div>
          </div>

          <Field label="安装目录" hint="加载器的库文件与版本 json 会写入这里；该目录会被注册为新实例">
            <div className="row gap-2">
              <div className="grow">
                <Input value={targetDir} onChange={setTargetDir} monospace placeholder={defaultGameDir || '选择游戏目录'} />
              </div>
              <Button icon={<IconFolder size={14} />} onClick={() => void pickDir()}>
                选择
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      {installing && liveTask ? (
        <LiveTask
          task={liveTask}
          label={`正在安装 ${loaderLabel(loaderType)} ${selected?.version ?? ''}`}
          onCancel={() => void mcal.cancelTask(liveTask.taskId)}
        />
      ) : null}

      {versions === null ? (
        <Card padding={8}>
          <Empty
            icon={<IconWrench />}
            title="先查询可用的加载器版本"
            description="选择加载器类型、填写游戏版本后点击「查询可用版本」。安装需要联网下载加载器文件与依赖库。"
          />
        </Card>
      ) : (
        <div className="col gap-3">
          <div className="row-between gap-3 wrap">
            <div className="row gap-2">
              <span className="fs-sm muted">共 {((versions ?? []).length) || 0} 个版本</span>
              {versions.length > 8 ? (
                <div style={{ width: 180 }}>
                  <SearchInput value={search} onChange={setSearch} placeholder="筛选版本号…" />
                </div>
              ) : null}
            </div>
            <Button size="sm" variant="primary" disabled={!selected || installing} onClick={() => setConfirming(true)}>
              安装选中的版本
            </Button>
          </div>

          {filtered.length === 0 ? (
            <Card padding={8}>
              <Empty
                icon={<IconAlert />}
                title="没有匹配的加载器版本"
                description={`${loaderLabel(loaderType)} 没有找到支持 ${gameVersion} 的版本，换个游戏版本试试。`}
              />
            </Card>
          ) : (
            <div className="mcal-list stagger">
              {filtered.slice(0, 80).map((item) => (
                <div
                  key={`${item.loaderType}-${item.version}`}
                  className="mcal-list__row"
                  style={
                    selected?.version === item.version
                      ? { borderColor: 'var(--c-verdant)', background: 'var(--c-verdant-glow)' }
                      : undefined
                  }
                  onClick={() => setSelected(item)}
                >
                  <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                    <div className="row gap-2">
                      <span className="mono bold">{item.version}</span>
                      {item.stable ? <Badge tone="ok">稳定版</Badge> : <Badge tone="warn">测试版</Badge>}
                      {item.label ? <Badge>{item.label}</Badge> : null}
                      {selected?.version === item.version ? <Badge tone="info">已选中</Badge> : null}
                    </div>
                    <div className="fs-xs muted">
                      {item.gameVersion} · {loaderLabel(item.loaderType)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={selected?.version === item.version ? 'primary' : 'default'}
                    onClick={() => {
                      setSelected(item)
                      setConfirming(true)
                    }}
                  >
                    安装
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Card flat padding={14}>
        <div className="row-start gap-2 fs-xs muted">
          <IconAlert size={13} className="warn" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            安装加载器会修改目标目录：写入库文件、版本 json，Forge / NeoForge 还会执行安装器（需要本机有可用的 Java）。
            安装是长任务，可以随时取消；中断后重新安装即可。
          </span>
        </div>
      </Card>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="确认安装加载器"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              再想想
            </Button>
            <Button variant="primary" icon={<IconCheck size={14} />} onClick={() => void install()}>
              开始安装
            </Button>
          </>
        }
      >
        <div className="col gap-3">
          <div className="mcal-panel col gap-2" style={{ padding: 12 }}>
            <div className="row-between fs-sm">
              <span className="muted">加载器</span>
              <span className="mono">
                {loaderLabel(loaderType)} {selected?.version}
              </span>
            </div>
            <div className="row-between fs-sm">
              <span className="muted">游戏版本</span>
              <span className="mono">{gameVersion}</span>
            </div>
            <div className="col gap-1">
              <span className="fs-xs muted">安装目录</span>
              <span className="mono fs-xs break-all">{targetDir || '（未指定）'}</span>
            </div>
            <div className="row-between fs-sm">
              <span className="muted">安装后</span>
              <span>{instanceName.trim() || `${loaderLabel(loaderType)} ${gameVersion}`}（新实例）</span>
            </div>
          </div>
          <div className="fs-xs muted">
            安装期间需要下载加载器文件与依赖库；Forge / NeoForge 还需要执行安装器进程。安装完成后会自动创建一个指向该目录的实例。
          </div>
          {instance ? (
            <div className="fs-xs muted">
              提示：如果你只想给现有实例「{instance.name}」换加载器，可以在实例详情页里操作，避免重复创建实例。
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}

/* ------------------------------ 长任务进度（本地副本，保持页面自包含） ------------------------------ */

function LiveTask({
  task,
  label,
  onCancel
}: {
  task: TaskState
  label: string
  onCancel: () => void
}): React.JSX.Element {
  const progress = task.progress
  const ratio =
    progress && progress.bytesTotal > 0
      ? progress.bytesDone / progress.bytesTotal
      : progress && progress.total > 0
        ? progress.completed / progress.total
        : undefined
  const logs = (task.logs ?? []).slice(-5)

  return (
    <div className="mcal-card" style={{ padding: 16, borderColor: 'var(--c-diamond-glow)' }}>
      <div className="row-between gap-3 wrap" style={{ marginBottom: 12 }}>
        <div className="row gap-2">
          {task.state === 'running' ? <span className="mcal-spinner info" /> : null}
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
        {task.state === 'running' ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消任务
          </Button>
        ) : null}
      </div>

      <Progress value={ratio ?? 0} indeterminate={ratio === undefined && task.state === 'running'} tone="info" />

      <div className="row gap-4 wrap fs-xs muted" style={{ marginTop: 10 }}>
        {progress ? (
          <>
            <span>
              文件 <span className="mono">{progress.completed}</span>/<span className="mono">{progress.total}</span>
            </span>
            {progress.bytesTotal > 0 ? (
              <span>
                <span className="mono">{formatBytes(progress.bytesDone)}</span> /{' '}
                <span className="mono">{formatBytes(progress.bytesTotal)}</span>
              </span>
            ) : null}
            {progress.speed > 0 ? <span className="mono">{formatBytes(progress.speed)}/s</span> : null}
            {progress.etaSeconds !== null ? <span>剩余约 {formatDuration(progress.etaSeconds)}</span> : null}
            {progress.currentFile ? (
              <span className="truncate" style={{ maxWidth: 320 }} title={progress.currentFile}>
                {progress.currentFile}
              </span>
            ) : null}
          </>
        ) : (
          <span>正在准备下载队列…</span>
        )}
        {ratio !== undefined ? <span className="mono">{Math.round(ratio * 100)}%</span> : null}
      </div>

      {logs.length > 0 ? (
        <div className="log-view" style={{ maxHeight: 100, minHeight: 54, marginTop: 10 }}>
          {logs.map((line, index) => (
            <div key={index} className="log-view__line--info">
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {task.error ? <div className="fs-xs err pre-wrap break-all" style={{ marginTop: 8 }}>{task.error}</div> : null}
    </div>
  )
}
