/**
 * 服务端管理。
 *
 * 开服三件套最容易踩的坑，都在页面上直接说明：
 *   1) EULA 必须由用户自己确认（未接受是启动失败第一原因）
 *   2) 需要本机 Java（版本要对得上）
 *   3) 端口要开放（本机防火墙 / 路由器端口映射）
 *
 * 注意：主进程只维护「移除记录」不删文件，删除确认里也照实说明。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ServerCoreDownload, ServerCoreType, ServerInstance } from '@shared/types'
import { mcal } from '../lib/api'
import { formatDateTime, formatRelativeTime, recommendMaxHeapMB } from '../lib/format'
import { reportError, toast, useInstances, useSystem } from '../state/store'
import { Badge, Button, Card, Field, Input, Modal, Progress, Select, Switch } from '../components/ui/primitives'
import {
  IconAlert,
  IconChevronDown,
  IconChevronRight,
  IconExternal,
  IconFolder,
  IconInfo,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconServer,
  IconStop,
  IconTerminal,
  IconTrash
} from '../components/ui/icons'

/* ------------------------------------------------------------------ *
 *  服务端运行状态：主进程没有暴露查询接口，
 *  这里用模块级 store 记住「本会话内启动过」的服务端，
 *  视图切换后状态不丢；点「刷新」可重新对齐列表。
 * ------------------------------------------------------------------ */

interface ServerRuntime {
  running: boolean
  pid?: number
  startedAt?: number
}

let runtimeSnapshot: Record<string, ServerRuntime> = {}
const runtimeListeners = new Set<() => void>()

function setServerRuntime(id: string, value: ServerRuntime | null): void {
  const next: Record<string, ServerRuntime> = { ...runtimeSnapshot }
  if (value) next[id] = value
  else delete next[id]
  runtimeSnapshot = next
  for (const listener of runtimeListeners) listener()
}

function subscribeRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener)
  return () => runtimeListeners.delete(listener)
}

function useServerRuntimes(): Record<string, ServerRuntime> {
  return useSyncExternalStore(subscribeRuntime, () => runtimeSnapshot)
}

/* ------------------------------------------------------------------ *
 *  元数据
 * ------------------------------------------------------------------ */

const CORE_META: { id: ServerCoreType; name: string; note: string }[] = [
  { id: 'paper', name: 'Paper', note: '插件生态最好、性能优秀，绝大多数开服首选' },
  { id: 'purpur', name: 'Purpur', note: '基于 Paper 的增强分支，可调选项更多（如飞行、刷怪控制）' },
  { id: 'vanilla', name: 'Vanilla（官方原版）', note: '最纯净，不支持插件与模组，适合原汁原味联机' },
  { id: 'fabric', name: 'Fabric', note: '轻量模组端，装模组更方便（注意客户端也要装一样的模组）' },
  { id: 'forge', name: 'Forge', note: '老牌模组端，1.12~1.16 时代的整合包大多是它' },
  { id: 'neoforge', name: 'NeoForge', note: 'Forge 分叉出的现代分支，1.20.2+ 新整合包主流' },
  { id: 'quilt', name: 'Quilt', note: 'Fabric 的衍生加载器，兼容多数 Fabric 模组' },
  { id: 'spigot', name: 'Spigot', note: 'Paper 的上游，功能少一些，兼容部分老插件' },
  { id: 'custom', name: '自定义 / 已有服务端目录', note: '已经有服务端 jar 时，指定目录由启动器托管启动' }
]

const CORE_LABELS: Record<string, string> = Object.fromEntries(CORE_META.map((item) => [item.id, item.name]))

/** 常用 server.properties 项（其余项走 key-value 表格） */
interface PropertyDoc {
  key: string
  label: string
  group: 'network' | 'game' | 'perf'
  kind: 'boolean' | 'number' | 'text' | 'select'
  options?: { value: string; label: string }[]
  hint?: string
}

const COMMON_PROPERTIES: PropertyDoc[] = [
  { key: 'online-mode', label: '正版验证（online-mode）', group: 'network', kind: 'boolean', hint: 'true 时只允许正版账号进入；关掉后离线客户端才能连（盗版服常关）' },
  { key: 'server-port', label: '端口（server-port）', group: 'network', kind: 'number', hint: '默认 25565，被占用时改这里' },
  { key: 'motd', label: '服务器标语（motd）', group: 'network', kind: 'text', hint: '服务器列表里显示的一行字，支持 § 颜色代码' },
  { key: 'max-players', label: '最大玩家数（max-players）', group: 'network', kind: 'number' },
  { key: 'white-list', label: '白名单（white-list）', group: 'network', kind: 'boolean', hint: '开启后只有 /whitelist add 加过的玩家能进' },
  {
    key: 'difficulty',
    label: '难度（difficulty）',
    group: 'game',
    kind: 'select',
    options: [
      { value: 'peaceful', label: '和平 peaceful' },
      { value: 'easy', label: '简单 easy' },
      { value: 'normal', label: '普通 normal' },
      { value: 'hard', label: '困难 hard' }
    ]
  },
  {
    key: 'gamemode',
    label: '默认游戏模式（gamemode）',
    group: 'game',
    kind: 'select',
    options: [
      { value: 'survival', label: '生存 survival' },
      { value: 'creative', label: '创造 creative' },
      { value: 'adventure', label: '冒险 adventure' },
      { value: 'spectator', label: '旁观 spectator' }
    ]
  },
  { key: 'pvp', label: '允许 PVP', group: 'game', kind: 'boolean' },
  { key: 'enable-command-block', label: '启用命令方块', group: 'game', kind: 'boolean' },
  { key: 'spawn-protection', label: '出生点保护半径', group: 'game', kind: 'number', hint: '0 表示关闭保护（开了 OP 却拆不了方块时先看这里）' },
  { key: 'level-name', label: '世界文件夹名（level-name）', group: 'game', kind: 'text', hint: '改这个名字等于切到另一个存档目录' },
  { key: 'view-distance', label: '视距（view-distance）', group: 'perf', kind: 'number', hint: '服务器发给客户端的区块半径，越大越吃带宽与 CPU' },
  { key: 'simulation-distance', label: '模拟距离（simulation-distance）', group: 'perf', kind: 'number', hint: '怪物与红石的活动半径，高配降到 6~8 能显著省 CPU' }
]

const GROUP_LABELS: Record<PropertyDoc['group'], string> = {
  network: '网络与联机',
  game: '玩法',
  perf: '性能'
}

/* ------------------------------------------------------------------ *
 *  主组件
 * ------------------------------------------------------------------ */

export function ServerView(): React.JSX.Element {
  const serversFromStore = useInstances((state) => state.servers)
  const refreshInstances = useInstances((state) => state.refresh)
  const java = useInstances((state) => state.java)
  const systemInfo = useSystem((state) => state.info)
  const runtimes = useServerRuntimes()

  const [servers, setServers] = useState<ServerInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showFaq, setShowFaq] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [forceTarget, setForceTarget] = useState<ServerInstance | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ServerInstance | null>(null)

  const loadServers = useCallback(async () => {
    setLoading(true)
    try {
      const list = await mcal.listServers()
      setServers(list)
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null))
    } catch (error) {
      reportError(error, '读取服务端列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadServers()
  }, [loadServers])

  // 主进程才是进程状态的真相来源：服务端自己崩了 UI 也要同步过来
  useEffect(() => {
    let disposed = false
    const sync = async (): Promise<void> => {
      try {
        const live = await mcal.runningServers()
        if (disposed) return
        const liveIds = new Set(live.map((item) => item.id))
        for (const entry of live) {
          setServerRuntime(entry.id, {
            running: entry.state === 'running' || entry.state === 'starting',
            pid: entry.pid,
            startedAt: entry.startedAt
          })
        }
        // 主进程里已经不存在的，把本地残留状态清掉
        for (const [id, runtime] of Object.entries(runtimes)) {
          if (runtime?.running && !liveIds.has(id)) setServerRuntime(id, null)
        }
      } catch {
        /* 轮询失败不打扰用户 */
      }
    }
    void sync()
    const timer = window.setInterval(() => void sync(), 4000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
    // runtimes 只需要在挂载时读一次快照，后续由轮询结果驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 其它页面刷新过实例列表时，同步一次服务端
  useEffect(() => {
    if (serversFromStore.length > 0) setServers(serversFromStore)
  }, [serversFromStore])

  const selected = useMemo(() => servers.find((item) => item.id === selectedId) ?? null, [servers, selectedId])

  const handleStart = useCallback(
    async (server: ServerInstance) => {
      setBusyId(server.id)
      try {
        const { pid } = await mcal.startServer(server.id)
        setServerRuntime(server.id, { running: true, pid, startedAt: Date.now() })
        toast.ok(`服务端「${server.name}」正在启动`, `pid ${pid}，首次启动生成世界较慢，稍等再看日志`)
        void refreshInstances()
      } catch (error) {
        reportError(error, '启动服务端失败')
      } finally {
        setBusyId(null)
      }
    },
    [refreshInstances]
  )

  const handleStop = useCallback(
    async (server: ServerInstance, force: boolean) => {
      setBusyId(server.id)
      try {
        await mcal.stopServer(server.id, force)
        setServerRuntime(server.id, null)
        toast.ok(force ? '已强制结束服务端进程' : '已发送关闭指令', force ? undefined : '正在等待服务端保存世界并退出（最多 30 秒）')
      } catch (error) {
        reportError(error, force ? '强制停止失败' : '停止失败')
      } finally {
        setBusyId(null)
      }
    },
    []
  )

  const handleDelete = useCallback(async () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    try {
      await mcal.deleteServer(target.id)
      setServerRuntime(target.id, null)
      setServers((list) => list.filter((item) => item.id !== target.id))
      toast.ok('已从启动器移除', '磁盘上的服务端目录没有被删除')
      void refreshInstances()
    } catch (error) {
      reportError(error, '删除失败')
    }
  }, [deleteTarget, refreshInstances])

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>服务端</h2>
          <span className="fs-sm muted">开服、装核心、改 server.properties、启停与日志，都在这里</span>
        </div>
        <div className="row gap-2">
          <Button icon={<IconRefresh size={14} />} onClick={() => void loadServers()} loading={loading}>
            刷新
          </Button>
          <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            创建服务端
          </Button>
        </div>
      </div>

      <div className="page__body">
        {/* ------------------------------ 开服须知 ------------------------------ */}
        <div className="mcal-card" style={{ padding: '12px 16px', marginBottom: 14 }}>
          <div className="row-between gap-3 wrap">
            <div className="row-start gap-3">
              <IconInfo size={16} className="accent" style={{ marginTop: 2 }} />
              <div className="col gap-1">
                <div className="fs-sm">
                  开服前请确认：<span className="bold">接受 EULA</span> · <span className="bold">本机有合适的 Java</span> ·{' '}
                  <span className="bold">端口已开放</span>
                </div>
                <div className="fs-xs muted">
                  Java 状态：{java.length > 0 ? `已检测到 ${java.length} 个运行时（${java.map((item) => `Java ${item.majorVersion}`).join(' / ')}）` : '未检测到 Java，服务端无法启动，请先到「Java」页面安装'}
                </div>
              </div>
            </div>
            <button type="button" className="row gap-1 fs-sm accent" onClick={() => setShowFaq((value) => !value)}>
              {showFaq ? '收起' : '开服后客户端连不上怎么办'}
              <IconChevronDown size={13} style={{ transform: showFaq ? 'none' : 'rotate(-90deg)', transition: 'transform var(--t-fast)' }} />
            </button>
          </div>

          {showFaq ? (
            <div className="col gap-2 anim-fade" style={{ marginTop: 12, paddingLeft: 28 }}>
              <FaqItem title="同一局域网（家里 / 宿舍）连不上" text="把服务器地址填成内网 IP（ipconfig 查 192.168.x.x）+ 端口，例如 192.168.1.5:25565。Address already in use 说明端口被占用，改 server-port 即可。" />
              <FaqItem title="外网的朋友连不上" text="需要路由器做端口映射（把外部端口的 TCP/UDP 转发到你电脑的内网 IP），并在 Windows 防火墙里放行 Java 程序或该端口。IPv6 或内网穿透（如 frp）通常比端口映射更省事。" />
              <FaqItem title="提示“你未通过身份验证” / 无法加入" text="服务端 online-mode=true 时只允许正版账号。让朋友用正版登录，或者把 online-mode 改成 false（注意会让服务器对外完全开放）。" />
              <FaqItem title="连上就掉线 / 卡在“正在加入世界”" text="多为模组不一致：服务端装的模组客户端也要装同版本，而且必须先装好 Loader（Fabric/Forge）。也检查 view-distance 是否过大导致超时。" />
            </div>
          ) : null}
        </div>

        <div className="split" style={{ height: 'auto' }}>
          {/* ------------------------------ 列表 ------------------------------ */}
          <aside className="split__aside col gap-2">
            {loading && servers.length === 0 ? <div className="skeleton" style={{ height: 120 }} /> : null}
            <div className="col gap-2 stagger">
              {servers.map((server) => {
                const runtime = runtimes[server.id]
                const running = runtime?.running ?? false
                return (
                  <button
                    key={server.id}
                    type="button"
                    className={`mcal-card ${server.id === selectedId ? 'mcal-card--selected' : 'mcal-card--interactive'}`}
                    style={{ padding: '12px 14px', textAlign: 'left' }}
                    onClick={() => setSelectedId(server.id)}
                  >
                    <div className="row-between gap-2">
                      <span className="row gap-2" style={{ minWidth: 0 }}>
                        <IconServer size={14} className={running ? 'accent' : 'muted'} />
                        <span className="fs-sm bold truncate">{server.name}</span>
                      </span>
                      <Badge tone={running ? 'ok' : 'default'}>{running ? '运行中' : '已停止'}</Badge>
                    </div>
                    <div className="row gap-2 wrap fs-xs muted" style={{ marginTop: 6 }}>
                      <span>{CORE_LABELS[server.coreType] ?? server.coreType}</span>
                      <span className="faint">·</span>
                      <span>MC {server.gameVersion}</span>
                      {server.port ? (
                        <>
                          <span className="faint">·</span>
                          <span>端口 {server.port}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="row gap-2 fs-xs" style={{ marginTop: 6 }}>
                      <Badge tone={server.eulaAccepted ? 'ok' : 'err'}>{server.eulaAccepted ? 'EULA 已接受' : 'EULA 未接受'}</Badge>
                      <span className="faint">{server.memory.maxMB} MB</span>
                    </div>
                  </button>
                )
              })}
            </div>

            {!loading && servers.length === 0 ? (
              <div className="mcal-card" style={{ padding: 8 }}>
                <div className="mcal-empty">
                  <div className="mcal-empty__icon">
                    <IconServer />
                  </div>
                  <div className="fs-md bold">还没有服务端</div>
                  <div className="fs-sm muted" style={{ maxWidth: 420, lineHeight: 'var(--lh-relaxed)' }}>
                    和朋友联机只需三步：选核心（推荐 Paper）→ 选游戏版本 → 接受 EULA，然后点启动。
                    启动器会自动下载核心、写配置，并把输出接到日志里。
                  </div>
                  <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
                    创建服务端
                  </Button>
                </div>
              </div>
            ) : null}
          </aside>

          {/* ------------------------------ 详情 ------------------------------ */}
          <main className="split__main">
            {selected ? (
              <ServerDetail
                key={selected.id}
                server={selected}
                runtime={runtimes[selected.id]}
                busy={busyId === selected.id}
                totalMemoryMB={systemInfo?.totalMemoryMB ?? 0}
                onStart={() => void handleStart(selected)}
                onStop={() => void handleStop(selected, false)}
                onForceStop={() => setForceTarget(selected)}
                onDelete={() => setDeleteTarget(selected)}
                onUpdate={(patch) => {
                  setServers((list) => list.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)))
                  void refreshInstances()
                }}
              />
            ) : (
              <div className="mcal-card" style={{ padding: 6 }}>
                <div className="mcal-empty">
                  <div className="mcal-empty__icon">
                    <IconTerminal />
                  </div>
                  <div className="fs-md bold">选择左侧的服务端查看详情</div>
                  <div className="fs-sm muted">这里可以接受 EULA、启停、编辑 server.properties。</div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* ------------------------------ 创建 ------------------------------ */}
      <CreateServerModal
        open={creating}
        totalMemoryMB={systemInfo?.totalMemoryMB ?? 0}
        onClose={() => setCreating(false)}
        onCreated={(server) => {
          setCreating(false)
          setServers((list) => [server, ...list])
          setSelectedId(server.id)
          void refreshInstances()
        }}
      />

      {/* ------------------------------ 强制停止确认 ------------------------------ */}
      <Modal
        open={forceTarget !== null}
        onClose={() => setForceTarget(null)}
        title="强制结束服务端进程？"
        footer={
          <>
            <Button onClick={() => setForceTarget(null)}>取消</Button>
            <Button
              variant="danger"
              icon={<IconStop size={14} />}
              onClick={() => {
                const target = forceTarget
                setForceTarget(null)
                if (target) void handleStop(target, true)
              }}
            >
              强制结束
            </Button>
          </>
        }
      >
        <div className="col gap-2">
          <div className="fs-md">强制结束会直接杀掉进程树，相当于拔电源。</div>
          <div className="fs-sm muted">
            未保存的世界区块可能损坏，玩家背包与建筑有可能回档。请优先用「停止」按钮（它会向控制台发送 stop 指令并等待保存）。
          </div>
        </div>
      </Modal>

      {/* ------------------------------ 删除确认 ------------------------------ */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="从启动器移除这个服务端？"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => void handleDelete()}>
              移除记录
            </Button>
          </>
        }
      >
        <div className="col gap-2">
          <div className="fs-md">「{deleteTarget?.name}」的启动器记录会被删除（含端口、内存、属性快照）。</div>
          <div className="fs-sm muted">
            磁盘上的服务端目录（{deleteTarget?.dir}）与存档<span className="bold">不会被删除</span>，需要清理请手动删除该目录。
          </div>
        </div>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  服务端详情
 * ------------------------------------------------------------------ */

function ServerDetail({
  server,
  runtime,
  busy,
  totalMemoryMB,
  onStart,
  onStop,
  onForceStop,
  onDelete,
  onUpdate
}: {
  server: ServerInstance
  runtime?: ServerRuntime
  busy: boolean
  totalMemoryMB: number
  onStart: () => void
  onStop: () => void
  onForceStop: () => void
  onDelete: () => void
  onUpdate: (patch: Partial<ServerInstance>) => void
}): React.JSX.Element {
  const running = runtime?.running ?? false
  const [properties, setProperties] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [loadingProps, setLoadingProps] = useState(true)
  const [saving, setSaving] = useState(false)
  const [eulaBusy, setEulaBusy] = useState(false)

  const loadProperties = useCallback(async () => {
    setLoadingProps(true)
    try {
      const props = await mcal.serverProperties(server.id)
      setProperties(props)
      setDraft(props)
    } catch (error) {
      reportError(error, '读取 server.properties 失败')
    } finally {
      setLoadingProps(false)
    }
  }, [server.id])

  useEffect(() => {
    void loadProperties()
  }, [loadProperties])

  const dirtyKeys = useMemo(
    () => Object.keys(draft).filter((key) => draft[key] !== properties[key]),
    [draft, properties]
  )

  const handleSaveProperties = useCallback(async () => {
    if (dirtyKeys.length === 0) return
    setSaving(true)
    try {
      const patch: Record<string, string> = {}
      for (const key of dirtyKeys) patch[key] = draft[key]
      await mcal.setServerProperties(server.id, patch)
      setProperties(draft)
      const parsedPort = Number.parseInt(draft['server-port'] ?? '', 10)
      if (Number.isFinite(parsedPort)) onUpdate({ port: parsedPort })
      toast.ok('配置已保存', '需要重启服务端后生效')
    } catch (error) {
      reportError(error, '保存失败')
    } finally {
      setSaving(false)
    }
  }, [draft, dirtyKeys, onUpdate, server.id])

  const handleEula = useCallback(
    async (accept: boolean) => {
      setEulaBusy(true)
      try {
        await mcal.acceptEula(server.id, accept)
        onUpdate({ eulaAccepted: accept })
        toast.ok(accept ? '已写入 eula=true' : '已写入 eula=false')
      } catch (error) {
        reportError(error, '写入 EULA 失败')
      } finally {
        setEulaBusy(false)
      }
    },
    [onUpdate, server.id]
  )

  const otherKeys = useMemo(
    () => Object.keys(draft).filter((key) => !COMMON_PROPERTIES.some((doc) => doc.key === key)).sort(),
    [draft]
  )

  return (
    <div className="col gap-4">
      {/* 概览 + 启停 */}
      <Card>
        <div style={{ padding: 18 }}>
          <div className="row-between gap-3 wrap">
            <div className="col gap-2" style={{ minWidth: 220 }}>
              <div className="row gap-2">
                <Badge tone={running ? 'ok' : 'default'}>{running ? '运行中' : '已停止'}</Badge>
                <Badge tone="info">{CORE_LABELS[server.coreType] ?? server.coreType}</Badge>
                {server.loaderVersion ? <Badge tone="violet">{server.loaderVersion}</Badge> : null}
              </div>
              <div className="fs-xl bold">{server.name}</div>
              <div className="row gap-3 fs-sm dim wrap">
                <span>MC {server.gameVersion}</span>
                <span className="faint">·</span>
                <span>端口 {server.port ?? draft['server-port'] ?? '—'}</span>
                <span className="faint">·</span>
                <span>内存 {server.memory.maxMB} MB</span>
                {running && runtime?.pid ? (
                  <>
                    <span className="faint">·</span>
                    <span className="mono">pid {runtime.pid}</span>
                  </>
                ) : null}
              </div>
              <div className="fs-xs muted break-all">{server.dir}</div>
            </div>

            <div className="col gap-2" style={{ minWidth: 180 }}>
              {running ? (
                <>
                  <Button variant="danger" loading={busy} icon={<IconStop size={15} />} onClick={onStop}>
                    停止（优雅关闭）
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onForceStop}>
                    强制结束进程
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  loading={busy}
                  icon={<IconPlay size={15} />}
                  disabled={!server.eulaAccepted}
                  onClick={onStart}
                  title={server.eulaAccepted ? undefined : '需要先接受 EULA'}
                >
                  启动服务端
                </Button>
              )}
              <Button
                size="sm"
                icon={<IconFolder size={13} />}
                onClick={() => void mcal.openPath(server.dir).catch((error: unknown) => reportError(error, '打开目录失败'))}
              >
                打开服务端目录
              </Button>
            </div>
          </div>

          <div className="row gap-3 fs-xs muted" style={{ marginTop: 12 }}>
            <span>创建于 {formatDateTime(server.createdAt)}</span>
            {server.lastStartedAt ? <span>上次启动 {formatRelativeTime(server.lastStartedAt)}</span> : null}
            {totalMemoryMB > 0 ? <span>本机内存 {Math.round(totalMemoryMB / 1024)} GB，建议堆 ≤ {recommendMaxHeapMB(totalMemoryMB)} MB</span> : null}
          </div>
        </div>
      </Card>

      {/* EULA */}
      <div
        className="mcal-card"
        style={{
          padding: 16,
          borderColor: server.eulaAccepted ? 'rgba(61,220,132,0.22)' : 'rgba(255,95,109,0.4)',
          background: server.eulaAccepted ? undefined : 'rgba(255,95,109,0.06)'
        }}
      >
        <div className="row-between gap-4 wrap">
          <div className="row-start gap-3" style={{ flex: 1, minWidth: 260 }}>
            {server.eulaAccepted ? <IconInfo size={16} className="accent" style={{ marginTop: 2 }} /> : <IconAlert size={16} className="err" style={{ marginTop: 2 }} />}
            <div className="col gap-1">
              <div className="fs-sm bold">{server.eulaAccepted ? 'EULA 已接受' : 'EULA 未接受 —— 这是启动失败最常见的原因'}</div>
              <div className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
                接受 Minecraft EULA 意味着你同意 Minecraft 最终用户许可协议
                （https://aka.ms/MinecraftEULA）的条款。<span className="bold">必须由你自己确认</span>，
                启动器不会替你同意；未接受时服务端会在启动的第一秒退出。
              </div>
            </div>
          </div>
          <div className="row gap-3" style={{ flexShrink: 0 }}>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconExternal size={13} />}
              onClick={() => void mcal.openExternal('https://aka.ms/MinecraftEULA').catch((error: unknown) => reportError(error, '打开链接失败'))}
            >
              阅读 EULA
            </Button>
            <div className="row gap-2">
              <Switch checked={server.eulaAccepted} onChange={(value) => void handleEula(value)} disabled={eulaBusy} label="接受 EULA" />
              <span className="fs-sm">{server.eulaAccepted ? '已接受（可撤销）' : '我已阅读并同意'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* server.properties */}
      <Card>
        <div style={{ padding: 18 }}>
          <div className="row-between gap-3" style={{ marginBottom: 14 }}>
            <div className="col gap-1">
              <span className="fs-md bold">server.properties</span>
              <span className="fs-xs muted">修改后需要重启服务端生效{dirtyKeys.length > 0 ? ` · 有 ${dirtyKeys.length} 项未保存` : ''}</span>
            </div>
            <div className="row gap-2">
              <Button size="sm" variant="ghost" icon={<IconRefresh size={12} />} onClick={() => void loadProperties()} loading={loadingProps}>
                重新读取
              </Button>
              <Button size="sm" variant="primary" disabled={dirtyKeys.length === 0} loading={saving} onClick={() => void handleSaveProperties()}>
                保存修改
              </Button>
            </div>
          </div>

          {loadingProps ? (
            <div className="skeleton" style={{ height: 160 }} />
          ) : Object.keys(draft).length === 0 ? (
            <div className="fs-sm muted">还没有 server.properties（首次启动服务端后会自动生成）。可以先启动一次，再回来调整。</div>
          ) : (
            <div className="col gap-5">
              {(Object.keys(GROUP_LABELS) as PropertyDoc['group'][]).map((group) => (
                <div key={group} className="col gap-3">
                  <div className="fs-sm bold dim">{GROUP_LABELS[group]}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
                    {COMMON_PROPERTIES.filter((doc) => doc.group === group).map((doc) => (
                      <PropertyField
                        key={doc.key}
                        doc={doc}
                        value={draft[doc.key] ?? ''}
                        missing={!(doc.key in draft)}
                        dirty={draft[doc.key] !== properties[doc.key]}
                        onChange={(value) => setDraft((previous) => ({ ...previous, [doc.key]: value }))}
                      />
                    ))}
                  </div>
                </div>
              ))}

              {otherKeys.length > 0 ? (
                <div className="col gap-3">
                  <div className="fs-sm bold dim">其他项（key-value）</div>
                  <div className="col gap-2">
                    {otherKeys.map((key) => (
                      <div key={key} className="row gap-2">
                        <span
                          className="mono fs-xs muted truncate"
                          style={{ width: 220, flexShrink: 0, paddingTop: 8 }}
                          title={key}
                        >
                          {key}
                        </span>
                        <Input
                          value={draft[key] ?? ''}
                          onChange={(value) => setDraft((previous) => ({ ...previous, [key]: value }))}
                          monospace
                          invalid={draft[key] !== properties[key]}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </Card>

      {/* 危险区 */}
      <Card>
        <div className="row-between gap-3 wrap" style={{ padding: 16 }}>
          <div className="col gap-1">
            <span className="fs-sm bold">移除服务端</span>
            <span className="fs-xs muted">仅删除启动器记录，磁盘上的目录与存档会保留</span>
          </div>
          <Button size="sm" variant="ghost" icon={<IconTrash size={13} />} onClick={onDelete}>
            移除
          </Button>
        </div>
      </Card>
    </div>
  )
}

function PropertyField({
  doc,
  value,
  missing,
  dirty,
  onChange
}: {
  doc: PropertyDoc
  value: string
  missing: boolean
  dirty: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <Field label={doc.label} hint={missing ? `${doc.hint ?? ''}${doc.hint ? ' · ' : ''}当前文件里没有这一项，保存后会新增` : doc.hint}>
      {doc.kind === 'boolean' ? (
        <div className="row gap-2">
          <Switch checked={value === 'true'} onChange={(next) => onChange(next ? 'true' : 'false')} label={doc.label} />
          <span className="fs-sm muted">{value === 'true' ? '开启' : '关闭'}</span>
          {dirty ? <Badge tone="warn">未保存</Badge> : null}
        </div>
      ) : doc.kind === 'select' ? (
        <div className="row gap-2">
          <Select value={value} onChange={onChange} options={[{ value: '', label: '（未设置）' }, ...(doc.options ?? [])]} />
          {dirty ? <Badge tone="warn">未保存</Badge> : null}
        </div>
      ) : (
        <div className="row gap-2">
          <Input
            value={value}
            onChange={onChange}
            monospace={doc.kind === 'number'}
            invalid={dirty}
            placeholder={missing ? '未设置' : undefined}
          />
          {dirty ? <Badge tone="warn">未保存</Badge> : null}
        </div>
      )}
    </Field>
  )
}

/* ------------------------------------------------------------------ *
 *  创建服务端
 * ------------------------------------------------------------------ */

function CreateServerModal({
  open,
  totalMemoryMB,
  onClose,
  onCreated
}: {
  open: boolean
  totalMemoryMB: number
  onClose: () => void
  onCreated: (server: ServerInstance) => void
}): React.JSX.Element {
  const [name, setName] = useState('我的服务器')
  const [coreType, setCoreType] = useState<ServerCoreType>('paper')
  const [gameVersion, setGameVersion] = useState('')
  const [manualVersion, setManualVersion] = useState(false)
  const [coreVersions, setCoreVersions] = useState<string[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [build, setBuild] = useState('')
  const [builds, setBuilds] = useState<ServerCoreDownload[]>([])
  const [loadingBuilds, setLoadingBuilds] = useState(false)
  const [memoryMB, setMemoryMB] = useState(() => Math.max(2048, Math.min(4096, recommendMaxHeapMB(totalMemoryMB || 8192))))
  const [port, setPort] = useState('25565')
  const [dir, setDir] = useState('')
  const [installing, setInstalling] = useState(false)
  const [acceptEulaNow, setAcceptEulaNow] = useState(false)

  const loadVersions = useCallback(async (core: ServerCoreType) => {
    setLoadingVersions(true)
    setCoreVersions([])
    setGameVersion('')
    setBuilds([])
    setBuild('')
    try {
      const result = await mcal.serverCores({ coreType: core })
      const versions = result.gameVersions ?? []
      setCoreVersions(versions)
      if (versions.length > 0) setGameVersion(versions[0])
      else setManualVersion(true)
    } catch (error) {
      reportError(error, '获取可用版本失败，可手动填写')
      setManualVersion(true)
    } finally {
      setLoadingVersions(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setManualVersion(false)
    void loadVersions(coreType)
    // coreType 变化时重新拉一次版本列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, coreType, loadVersions])

  const loadBuilds = useCallback(async (core: ServerCoreType, version: string) => {
    if (!version) {
      setBuilds([])
      return
    }
    setLoadingBuilds(true)
    try {
      const result = await mcal.serverCores({ coreType: core, gameVersion: version })
      const list = result.builds ?? []
      setBuilds(list)
      setBuild(list[0]?.build ?? '')
    } catch {
      setBuilds([])
    } finally {
      setLoadingBuilds(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !gameVersion) return
    void loadBuilds(coreType, gameVersion)
  }, [open, coreType, gameVersion, loadBuilds])

  const pickDir = useCallback(async () => {
    const picked = await mcal.pickDir({ title: '选择服务端安装目录' }).catch((error: unknown) => {
      reportError(error, '选择目录失败')
      return null
    })
    if (picked) {
      setDir(picked)
      if (!name || name === '我的服务器') {
        const folder = picked.split(/[\\/]/).pop()
        if (folder) setName(folder)
      }
    }
  }, [name])

  const install = useCallback(async () => {
    if (!name.trim()) {
      toast.warn('请填写服务端名称')
      return
    }
    if (!gameVersion.trim()) {
      toast.warn('请选择或填写游戏版本')
      return
    }
    if (!dir) {
      toast.warn('请选择安装目录', '服务端文件会下载到这里')
      return
    }
    setInstalling(true)
    try {
      const server = await mcal.installServer({
        name: name.trim(),
        coreType,
        gameVersion: gameVersion.trim(),
        dir,
        build: build || undefined,
        acceptEula: acceptEulaNow
      })
      // 端口与内存不在安装参数里，装完后落到实例记录 / server.properties
      const patch: Partial<ServerInstance> = {}
      if (memoryMB > 0) patch.memory = { minMB: Math.min(1024, memoryMB), maxMB: memoryMB, auto: false }
      if (port.trim()) patch.port = Number.parseInt(port, 10)
      let finalServer = server
      if (Object.keys(patch).length > 0) {
        finalServer = await mcal.updateServer(server.id, patch).catch(() => server)
      }
      if (port.trim()) {
        await mcal.setServerProperties(server.id, { 'server-port': port.trim() }).catch(() => undefined)
      }
      toast.ok('服务端已创建', acceptEulaNow ? '已同时写入 EULA' : '别忘了接受 EULA，否则无法启动')
      onCreated(finalServer)
    } catch (error) {
      reportError(error, '安装服务端失败')
    } finally {
      setInstalling(false)
    }
  }, [acceptEulaNow, build, coreType, dir, gameVersion, memoryMB, name, onCreated, port])

  const coreNote = CORE_META.find((item) => item.id === coreType)?.note ?? ''

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <span className="row gap-2">
          <IconServer size={16} className="accent" />
          创建服务端
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={installing}>
            取消
          </Button>
          <Button variant="primary" loading={installing} icon={<IconPlay size={14} />} onClick={() => void install()}>
            下载并创建
          </Button>
        </>
      }
    >
      <div className="col gap-4">
        <Field label="名称" required hint="只用于启动器里显示">
          <Input value={name} onChange={setName} placeholder="例如：和朋友联机" />
        </Field>

        <Field label="核心类型" required hint={coreNote}>
          <Select
            value={coreType}
            onChange={(value) => setCoreType(value as ServerCoreType)}
            options={CORE_META.map((item) => ({ value: item.id, label: item.name }))}
          />
        </Field>

        <Field
          label="游戏版本"
          required
          hint={manualVersion ? '手动填写，例如 1.20.1' : `共 ${coreVersions.length} 个可用版本`}
        >
          <div className="row gap-2">
            {manualVersion ? (
              <Input value={gameVersion} onChange={setGameVersion} placeholder="1.20.1" monospace />
            ) : (
              <Select
                value={gameVersion}
                onChange={setGameVersion}
                disabled={loadingVersions}
                options={
                  coreVersions.length > 0
                    ? coreVersions.map((version) => ({ value: version, label: version }))
                    : [{ value: '', label: loadingVersions ? '读取中…' : '（没有可用版本，改用手填）' }]
                }
              />
            )}
            <Button size="sm" variant="ghost" onClick={() => setManualVersion((value) => !value)}>
              {manualVersion ? '用列表选择' : '手动填写'}
            </Button>
          </div>
        </Field>

        {builds.length > 0 ? (
          <Field label="构建号" hint={`该版本共 ${builds.length} 个构建，默认选最新`}>
            <Select
              value={build}
              onChange={setBuild}
              disabled={loadingBuilds}
              options={builds.map((item) => ({
                value: item.build ?? item.fileName,
                label: `${item.build ?? item.fileName}${item.channel ? `（${item.channel}）` : ''}`
              }))}
            />
          </Field>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field
            label="启动内存"
            required
            hint={
              totalMemoryMB > 0
                ? `本机约 ${Math.round(totalMemoryMB / 1024)} GB，推荐 ${recommendMaxHeapMB(totalMemoryMB)} MB`
                : '按物理内存的 50%~70% 比较合适'
            }
          >
            <Input
              value={String(memoryMB)}
              onChange={(value) => {
                const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10)
                setMemoryMB(Number.isFinite(parsed) ? Math.max(1024, Math.min(65536, parsed)) : 2048)
              }}
              type="number"
            />
          </Field>
          <Field label="端口" required hint="同一个端口只能被一个程序占用">
            <Input value={port} onChange={setPort} monospace />
          </Field>
        </div>

        <Field label="安装目录" required hint="服务端文件（jar、配置、世界）都会放在这里">
          <div className="row gap-2">
            <Input value={dir} onChange={setDir} placeholder="未选择" monospace />
            <Button icon={<IconFolder size={14} />} onClick={() => void pickDir()}>
              选择
            </Button>
          </div>
        </Field>

        <div
          className="row-start gap-2"
          style={{ padding: '10px 12px', borderRadius: 'var(--r-md)', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--c-hairline)' }}
        >
          <Switch checked={acceptEulaNow} onChange={setAcceptEulaNow} label="同时接受 EULA" />
          <div className="col gap-1">
            <span className="fs-sm">同时接受 EULA</span>
            <span className="fs-xs muted">
              勾选表示你现在就阅读并同意 https://aka.ms/MinecraftEULA 的条款。不勾也可以，创建后在这个页面随时接受，
              但没接受之前服务端不会启动。
            </span>
          </div>
        </div>

        {installing ? (
          <div className="col gap-2">
            <div className="row gap-2 fs-sm dim">
              <span className="mcal-spinner" style={{ width: 13, height: 13, borderWidth: 1.8 }} />
              正在下载核心并生成配置（视网络情况可能需要一两分钟）…
            </div>
            <Progress indeterminate />
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 *  FAQ 行
 * ------------------------------------------------------------------ */

function FaqItem({ title, text }: { title: string; text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="col gap-1">
      <button
        type="button"
        className="row gap-2 fs-sm"
        style={{ alignSelf: 'flex-start', textAlign: 'left' }}
        onClick={() => setOpen((value) => !value)}
      >
        <IconChevronRight size={13} className="muted" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--t-fast)' }} />
        {title}
      </button>
      {open ? (
        <div className="fs-xs muted anim-fade" style={{ paddingLeft: 21, lineHeight: 'var(--lh-relaxed)' }}>
          {text}
        </div>
      ) : null}
    </div>
  )
}
