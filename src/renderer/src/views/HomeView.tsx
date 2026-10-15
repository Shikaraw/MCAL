/**
 * 主页：玩家 90% 的时间都在这个页面上。
 * 结构上遵循「一眼看到状态，一次点击启动」：
 *   左：当前实例 + 大启动按钮 + 关键参数
 *   右：环境体检建议 + 运行中日志 + 快捷操作
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Instance, RunningGameInfo } from '@shared/types'
import { mcal } from '../lib/api'
import { formatRelativeTime, formatUptime, loaderLabel, recommendMaxHeapMB } from '../lib/format'
import { reportError, toast, useInstances, useSettings, useSystem, useView } from '../state/store'
import { Badge, Button, Card, Empty, Progress, Select, Stat, Tooltip } from '../components/ui/primitives'
import {
  IconAlert,
  IconChevronRight,
  IconClock,
  IconCube,
  IconFolder,
  IconInfo,
  IconPlay,
  IconRefresh,
  IconSparkles,
  IconStop,
  IconTerminal,
  IconUser,
  IconWrench
} from '../components/ui/icons'

export function HomeView(): React.JSX.Element {
  const instances = useInstances((state) => state.instances)
  const running = useInstances((state) => state.running)
  const activeId = useInstances((state) => state.activeInstanceId)
  const setActive = useInstances((state) => state.setActive)
  const refresh = useInstances((state) => state.refresh)
  const java = useInstances((state) => state.java)
  const accounts = useInstances((state) => state.accounts)
  const settings = useSettings((state) => state.settings)
  const systemInfo = useSystem((state) => state.info)
  const navigate = useView((state) => state.navigate)

  const [launching, setLaunching] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [versionsInstalled, setVersionsInstalled] = useState<Set<string> | null>(null)
  const [crashReports, setCrashReports] = useState<{ name: string; mtimeMs: number }[]>([])

  const instance: Instance | undefined = useMemo(
    () => instances.find((item) => item.id === activeId) ?? instances[0],
    [instances, activeId]
  )
  const runningGame: RunningGameInfo | undefined = useMemo(
    () => running.find((game) => game.instanceId === instance?.id),
    [running, instance]
  )

  // 已安装版本 & 崩溃报告：用于「环境体检」
  const scanState = useCallback(async () => {
    try {
      const versions = await mcal.listVersions()
      setVersionsInstalled(new Set(versions.filter((v) => v.installed).map((v) => v.id)))
    } catch {
      setVersionsInstalled(null)
    }
    if (instance) {
      try {
        const logs = await mcal.listLogs(instance.id)
        setCrashReports(
          logs
            .filter((log) => log.name.includes('crash-reports'))
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, 3)
        )
      } catch {
        setCrashReports([])
      }
    }
  }, [instance])

  useEffect(() => {
    void scanState()
  }, [scanState])

  // 运行中状态轮询（只在有进程时开启，避免空转）
  useEffect(() => {
    if (running.length === 0) return
    const timer = setInterval(() => {
      void refresh()
    }, 5000)
    return () => clearInterval(timer)
  }, [running.length, refresh])

  const handleLaunch = useCallback(async () => {
    if (!instance) return
    setLaunching(true)
    try {
      await mcal.launch({ instanceId: instance.id })
      toast.ok(`已启动「${instance.name}」`, '游戏窗口正在打开，首次启动可能需要较长时间')
      void refresh()
    } catch (error) {
      reportError(error, '启动失败')
      // 启动失败时把用户引导到 AI 助手，这是最有价值的转化点
      navigate('agent', {
        prompt: `启动实例「${instance.name}」（${instance.versionId}，${loaderLabel(instance.loaderType)}）失败，请帮我诊断原因。`
      })
    } finally {
      setLaunching(false)
    }
  }, [instance, refresh, navigate])

  const handleStop = useCallback(
    async (force = false) => {
      if (!instance) return
      setStopping(true)
      try {
        await mcal.stopGame(instance.id, force)
        toast.info(force ? '已强制结束游戏进程' : '已请求关闭游戏', force ? undefined : '如果几秒后仍在运行，可以点「强制结束」')
        setTimeout(() => void refresh(), force ? 800 : 2500)
      } catch (error) {
        reportError(error, force ? '强制结束失败' : '停止失败')
      } finally {
        setStopping(false)
      }
    },
    [instance, refresh]
  )

  if (instances.length === 0) {
    return (
      <div className="page">
        <div className="page__body center" style={{ height: '100%' }}>
          <Card style={{ maxWidth: 560, padding: 40 }}>
            <Empty
              icon={<IconCube />}
              title="还没有游戏实例"
              description="先下载一个 Minecraft 版本并创建实例，就能开始了。也可以让 AI 助手帮你从头搭建一个整合包环境。"
              action={
                <div className="row gap-3" style={{ marginTop: 8 }}>
                  <Button variant="primary" icon={<IconPlay size={15} />} onClick={() => navigate('versions')}>
                    下载游戏
                  </Button>
                  <Button icon={<IconSparkles size={15} />} onClick={() => navigate('agent')}>
                    让 AI 帮我配置
                  </Button>
                </div>
              }
            />
          </Card>
        </div>
      </div>
    )
  }

  const requiredJava = requiredJavaFor(instance?.versionId ?? '')
  const javaReady = java.some((runtime) => runtime.majorVersion === requiredJava)
  const versionInstalled = versionsInstalled ? versionsInstalled.has(instance?.versionId ?? '') : true
  const activeAccount = accounts.find((account) => account.id === settings?.activeAccountId) ?? accounts[0]

  const advice = buildAdvice({
    instance,
    javaReady,
    requiredJava,
    javaCount: java.length,
    versionInstalled,
    crashReports,
    totalMemoryMB: systemInfo?.totalMemoryMB ?? 0
  })

  return (
    <div className="page">
      <div className="page__body" style={{ paddingTop: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(320px, 1fr)', gap: 20, alignItems: 'start' }}>
          {/* ---------------- 左栏：启动面板 ---------------- */}
          <div className="col gap-5">
            <LaunchHero
              instance={instance}
              runningGame={runningGame}
              launching={launching}
              stopping={stopping}
              account={activeAccount?.name}
              onLaunch={handleLaunch}
              onStop={() => void handleStop(false)}
              onForceStop={() => void handleStop(true)}
            />

            {/* 关键参数 */}
            <Card style={{ padding: 18 }}>
              <div className="row-between" style={{ marginBottom: 14 }}>
                <div className="fs-md bold">启动配置</div>
                <Button size="sm" variant="ghost" icon={<IconWrench size={13} />} onClick={() => navigate('instances')}>
                  调整
                </Button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16 }}>
                <Stat label="游戏版本" value={instance?.versionId || '未设置'} />
                <Stat label="加载器" value={loaderLabel(instance?.loaderType)} hint={instance?.loaderVersion} />
                <Stat
                  label="内存"
                  value={instance?.memory.auto ? '自动' : `${instance.memory.maxMB} MB`}
                  hint={instance?.memory.auto ? `将分配约 ${recommendMaxHeapMB(systemInfo?.totalMemoryMB ?? 8192)} MB` : undefined}
                />
                <Stat
                  label="Java"
                  value={instance?.java.javaPath ? '已指定' : `Java ${requiredJava}`}
                  tone={javaReady ? 'ok' : 'warn'}
                  hint={javaReady ? '环境就绪' : '未找到匹配的 Java'}
                />
              </div>
              <div className="row gap-2 wrap" style={{ marginTop: 16 }}>
                <Button size="sm" icon={<IconFolder size={13} />} onClick={() => void mcal.openInstanceDir(instance!.id).catch((e) => reportError(e))}>
                  打开游戏目录
                </Button>
                <Button size="sm" icon={<IconTerminal size={13} />} onClick={() => navigate('content', { instanceId: instance?.id })}>
                  管理模组
                </Button>
                <Button size="sm" icon={<IconAlert size={13} />} onClick={() => navigate('home', { showLog: true })}>
                  查看日志
                </Button>
              </div>
            </Card>

            {/* 运行中：日志实时尾巴 */}
            {runningGame ? <LiveLogPanel instance={instance!} /> : <LastSessionPanel instance={instance!} />}
          </div>

          {/* ---------------- 右栏：体检 + 助手 ---------------- */}
          <div className="col gap-5">
            <Card style={{ padding: 18 }}>
              <div className="row-between" style={{ marginBottom: 12 }}>
                <div className="row gap-2">
                  <IconInfo size={15} className="accent" />
                  <span className="fs-md bold">环境体检</span>
                </div>
                <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => void scanState()}>
                  重新检查
                </Button>
              </div>
              {advice.length === 0 ? (
                <div className="row gap-2 fs-sm" style={{ color: 'var(--c-verdant)' }}>
                  <IconCheckSmall /> 一切正常，可以直接启动
                </div>
              ) : (
                <div className="col gap-3 stagger">
                  {advice.map((item) => (
                    <div key={item.id} className="row-start gap-3">
                      <Badge tone={item.tone}>{item.tone === 'err' ? '问题' : item.tone === 'warn' ? '注意' : '提示'}</Badge>
                      <div className="col gap-1 grow">
                        <div className="fs-sm">{item.title}</div>
                        <div className="fs-xs muted">{item.detail}</div>
                        {item.action ? (
                          <button
                            type="button"
                            className="row gap-1 fs-xs accent"
                            style={{ marginTop: 2 }}
                            onClick={() => item.action!.run()}
                          >
                            {item.action.label}
                            <IconChevronRight size={12} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card style={{ padding: 18 }}>
              <div className="row gap-2" style={{ marginBottom: 12 }}>
                <IconSparkles size={15} className="accent" />
                <span className="fs-md bold">让 AI 帮你</span>
              </div>
              <div className="col gap-2">
                {[
                  {
                    label: '诊断上次崩溃',
                    prompt: `帮我分析实例「${instance?.name}」最近的崩溃日志，找出原因并给出修复步骤。`
                  },
                  {
                    label: '检查模组兼容性',
                    prompt: `检查实例「${instance?.name}」的模组列表，看看有没有版本不匹配、缺失前置或者互相冲突的模组。`
                  },
                  {
                    label: '优化游戏性能',
                    prompt: `我的实例「${instance?.name}」（${instance?.versionId}，${loaderLabel(instance?.loaderType)}）帧数偏低，帮我分析原因并给出优化方案。该装哪些优化模组？`
                  },
                  {
                    label: '帮我装一个光影',
                    prompt: `帮我给实例「${instance?.name}」安装一个适合当前配置的光影包，并说明需要哪些前置。`
                  }
                ].map((quick) => (
                  <button
                    key={quick.label}
                    type="button"
                    className="row-between gap-3"
                    style={{
                      padding: '9px 12px',
                      borderRadius: 9,
                      background: 'rgba(255,255,255,0.035)',
                      border: '1px solid var(--c-hairline)',
                      textAlign: 'left',
                      transition: 'all var(--t-fast) var(--ease-out)'
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = 'rgba(61,220,132,0.1)'
                      event.currentTarget.style.borderColor = 'rgba(61,220,132,0.3)'
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = 'rgba(255,255,255,0.035)'
                      event.currentTarget.style.borderColor = 'var(--c-hairline)'
                    }}
                    onClick={() => navigate('agent', { prompt: quick.prompt })}
                  >
                    <span className="fs-sm">{quick.label}</span>
                    <IconChevronRight size={14} className="muted" />
                  </button>
                ))}
              </div>
            </Card>

            {crashReports.length > 0 ? (
              <Card style={{ padding: 18 }}>
                <div className="row gap-2" style={{ marginBottom: 10 }}>
                  <IconAlert size={15} className="warn" />
                  <span className="fs-md bold">最近的崩溃报告</span>
                </div>
                <div className="col gap-2">
                  {crashReports.map((report) => (
                    <div key={report.name} className="row-between gap-2 fs-sm">
                      <span className="truncate mono" style={{ maxWidth: 200 }} title={report.name}>
                        {report.name.replace('crash-reports/', '')}
                      </span>
                      <span className="fs-xs muted">{formatRelativeTime(report.mtimeMs)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------- 启动主卡 ------------------------------- */

function LaunchHero({
  instance,
  runningGame,
  launching,
  stopping,
  account,
  onLaunch,
  onStop,
  onForceStop
}: {
  instance?: Instance
  runningGame?: RunningGameInfo
  launching: boolean
  stopping: boolean
  account?: string
  onLaunch: () => void
  onStop: () => void
  onForceStop: () => void
}): React.JSX.Element {
  const instances = useInstances((state) => state.instances)
  const setActive = useInstances((state) => state.setActive)

  return (
    <Card
      style={{
        padding: 28,
        background: 'linear-gradient(150deg, rgba(32,52,44,0.9) 0%, rgba(20,25,36,0.92) 55%, rgba(14,18,26,0.94) 100%)',
        borderColor: 'rgba(61,220,132,0.18)',
        overflow: 'visible'
      }}
    >
      <div className="row-between gap-4 wrap" style={{ marginBottom: 22 }}>
        <div className="col gap-2" style={{ minWidth: 220, flex: 1 }}>
          <div className="row gap-2">
            <Badge tone={runningGame ? 'ok' : 'default'}>{runningGame ? '运行中' : '已就绪'}</Badge>
            {instance?.lastPlayedAt ? (
              <span className="row gap-1 fs-xs muted">
                <IconClock size={12} />
                {formatRelativeTime(instance.lastPlayedAt)}玩过
              </span>
            ) : null}
          </div>
          <div className="fs-2xl bold" style={{ letterSpacing: '-0.02em' }}>
            {instance?.name ?? '未选择实例'}
          </div>
          <div className="row gap-3 fs-sm dim">
            <span>{instance?.versionId || '—'}</span>
            <span className="faint">·</span>
            <span>{loaderLabel(instance?.loaderType)}</span>
            {account ? (
              <>
                <span className="faint">·</span>
                <span className="row gap-1">
                  <IconUser size={12} />
                  {account}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="col gap-2" style={{ minWidth: 180 }}>
          <div className="fs-xs muted">选择实例</div>
          <Select
            value={instance?.id ?? ''}
            onChange={(value) => setActive(value)}
            options={instances.map((item) => ({
              value: item.id,
              label: `${item.name}（${item.versionId}）`
            }))}
          />
        </div>
      </div>

      <div className="row gap-4 wrap">
        {runningGame ? (
          <Button
            variant="danger"
            size="lg"
            icon={<IconStop size={16} />}
            loading={stopping}
            onClick={onStop}
            className="anim-ring"
          >
            结束游戏
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            icon={<IconPlay size={16} />}
            loading={launching}
            disabled={!instance}
            onClick={onLaunch}
          >
            {launching ? '正在启动…' : '启动游戏'}
          </Button>
        )}

        {runningGame ? (
          <Button
            variant="ghost"
            size="lg"
            icon={<IconAlert size={15} />}
            disabled={stopping}
            onClick={onForceStop}
            title="游戏卡死时使用：直接终止进程，不等待游戏自己退出"
          >
            强制结束
          </Button>
        ) : null}

        {runningGame ? (
          <div className="col gap-1">
            <div className="row gap-2 fs-sm">
              <span className="dim">已运行</span>
              <span className="mono bold">{formatUptime(Date.now() - Date.parse(runningGame.startedAt))}</span>
              <span className="dim">· PID {runningGame.pid}</span>
            </div>
            <div className="fs-xs muted">状态：{stateLabel(runningGame.state)}</div>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function stateLabel(state: RunningGameInfo['state']): string {
  switch (state) {
    case 'starting':
      return '正在初始化'
    case 'running':
      return '运行中'
    case 'crashed':
      return '已崩溃'
    case 'exited':
      return '已退出'
    default:
      return state
  }
}

/* ------------------------------- 日志面板 ------------------------------- */

function LiveLogPanel({ instance }: { instance: Instance }): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const text = await mcal.readLog(instance.id, { tailLines: 120 })
        if (!cancelled) setLines(text.split('\n').slice(-120))
      } catch {
        /* 日志尚未创建时忽略 */
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [instance.id])

  useEffect(() => {
    if (autoScroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  return (
    <Card style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: 420 }}>
      <div className="row-between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--c-hairline)' }}>
        <div className="row gap-2">
          <IconTerminal size={15} className="accent" />
          <span className="fs-md bold">实时日志</span>
          <Badge tone="ok">LIVE</Badge>
        </div>
        <div className="row gap-2">
          <Button size="sm" variant="ghost" onClick={() => setAutoScroll((value) => !value)}>
            {autoScroll ? '自动滚动：开' : '自动滚动：关'}
          </Button>
        </div>
      </div>
      <div
        ref={boxRef}
        className="log-view selectable"
        style={{ border: 'none', borderRadius: 0, maxHeight: 360, minHeight: 200, flex: 1 }}
      >
        {lines.length === 0 ? <span className="muted">等待游戏输出…</span> : lines.map((line, index) => renderLogLine(line, index))}
      </div>
    </Card>
  )
}

function renderLogLine(line: string, key: number): React.JSX.Element {
  const level = /\/FATAL|\/ERROR|\bException\b|\bERROR\b/.test(line)
    ? 'error'
    : /\/WARN|\bWARN\b/.test(line)
      ? 'warn'
      : /\/DEBUG|\/TRACE/.test(line)
        ? 'debug'
        : 'info'
  return (
    <div key={key} className={`log-view__line--${level}`}>
      {line}
    </div>
  )
}

/** 未运行时的上一次会话摘要 */
function LastSessionPanel({ instance }: { instance: Instance }): React.JSX.Element {
  const [tail, setTail] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void mcal
      .readLog(instance.id, { tailLines: 40 })
      .then((text) => {
        if (!cancelled) setTail(text)
      })
      .catch(() => {
        if (!cancelled) setTail(null)
      })
    return () => {
      cancelled = true
    }
  }, [instance.id])

  if (!tail) {
    return (
      <Card style={{ padding: 18 }}>
        <div className="row gap-2" style={{ marginBottom: 8 }}>
          <IconTerminal size={15} className="muted" />
          <span className="fs-md bold">上次运行日志</span>
        </div>
        <div className="fs-sm muted">还没有日志。启动一次游戏后这里会显示输出。</div>
      </Card>
    )
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div className="row-between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--c-hairline)' }}>
        <div className="row gap-2">
          <IconTerminal size={15} className="muted" />
          <span className="fs-md bold">上次运行日志（尾部）</span>
        </div>
        <div className="fs-xs muted">{formatRelativeTime(instance.lastPlayedAt)}</div>
      </div>
      <div className="log-view selectable" style={{ border: 'none', borderRadius: 0, maxHeight: 240 }}>
        {tail.split('\n').slice(-30).map((line, index) => renderLogLine(line, index))}
      </div>
    </Card>
  )
}

/* ------------------------------- 环境体检 ------------------------------- */

interface AdviceItem {
  id: string
  tone: 'ok' | 'warn' | 'err' | 'info'
  title: string
  detail: string
  action?: { label: string; run: () => void }
}

function buildAdvice(input: {
  instance?: Instance
  javaReady: boolean
  requiredJava: number
  javaCount: number
  versionInstalled: boolean
  crashReports: { name: string; mtimeMs: number }[]
  totalMemoryMB: number
}): AdviceItem[] {
  const items: AdviceItem[] = []
  const navigate = useView.getState().navigate

  if (!input.instance) return items

  if (input.javaCount === 0) {
    items.push({
      id: 'java-missing',
      tone: 'err',
      title: '未检测到 Java',
      detail: `游戏需要 Java ${input.requiredJava} 才能启动。可以在 Java 页面自动下载安装。`,
      action: { label: '去安装 Java', run: () => navigate('java') }
    })
  } else if (!input.javaReady) {
    items.push({
      id: 'java-version',
      tone: 'warn',
      title: `缺少 Java ${input.requiredJava}`,
      detail: `当前 MC ${input.instance.versionId} 需要 Java ${input.requiredJava}，已检测到的版本不匹配，可能启动失败或崩溃。`,
      action: { label: '查看 Java 环境', run: () => navigate('java') }
    })
  }

  if (!input.versionInstalled) {
    items.push({
      id: 'version-missing',
      tone: 'warn',
      title: `版本 ${input.instance.versionId} 未完整安装`,
      detail: '客户端文件可能缺失，启动时会报错或自动补全。',
      action: { label: '去下载页安装', run: () => navigate('versions') }
    })
  }

  const memory = input.instance.memory
  if (!memory.auto && input.totalMemoryMB > 0) {
    if (memory.maxMB < 2048) {
      items.push({
        id: 'memory-low',
        tone: 'warn',
        title: `内存上限偏低（${memory.maxMB} MB）`,
        detail: '现代整合包通常需要 4 GB 以上，装了大量模组时容易 OutOfMemoryError。',
        action: { label: '调整内存', run: () => navigate('instances') }
      })
    } else if (memory.maxMB > input.totalMemoryMB * 0.8) {
      items.push({
        id: 'memory-high',
        tone: 'warn',
        title: `内存上限过高（${memory.maxMB} MB）`,
        detail: `已超过物理内存的 80%（${Math.round(input.totalMemoryMB / 1024)} GB）。过大的堆反而会因为 GC 停顿导致卡顿，建议设为物理内存的 50%~70%。`,
        action: { label: '调整内存', run: () => navigate('instances') }
      })
    }
  }

  if (input.crashReports.length > 0) {
    const latest = input.crashReports[0]
    items.push({
      id: 'crash',
      tone: 'err',
      title: '检测到崩溃报告',
      detail: `最近一次崩溃：${latest.name.replace('crash-reports/', '')}（${formatRelativeTime(latest.mtimeMs)}）。`,
      action: {
        label: '让 AI 分析崩溃原因',
        run: () =>
          navigate('agent', {
            prompt: `实例「${input.instance?.name}」最近崩溃了（报告文件：${latest.name}），帮我分析原因并给出修复步骤。`
          })
      }
    })
  }

  return items
}

function requiredJavaFor(versionId: string): number {
  const match = /^1\.(\d+)(?:\.(\d+))?/.exec(versionId)
  if (!match) return 17
  const minor = Number.parseInt(match[1], 10)
  const patch = Number.parseInt(match[2] ?? '0', 10)
  if (minor <= 16) return 8
  if (minor <= 20 && !(minor === 20 && patch >= 5)) return 17
  return 21
}

function IconCheckSmall(): React.JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  )
}

export { Progress, Tooltip }
