/** 应用外壳：动态背景、侧边栏导航、主内容区、通知层。 */

import { useEffect, useRef, useState } from 'react'
import { IconClose, IconSparkles, IconTerminal } from '../ui/icons'
import { Button, Tooltip } from '../ui/primitives'
import { mcal } from '../../lib/api'
import { useInstances, useSettings, useSystem, useTasks, useToasts, useView } from '../../state/store'
import { loaderLabel } from '../../lib/format'
import { NAV_ITEMS, type NavItem } from './nav'

/** 极光 + 网格背景：给深色界面一点"活"的感觉，但不抢内容注意力 */
export function Background(): React.JSX.Element {
  return (
    <>
      <div className="aurora-bg" aria-hidden>
        <div className="aurora-bg__blob aurora-bg__blob--1" />
        <div className="aurora-bg__blob aurora-bg__blob--2" />
        <div className="aurora-bg__blob aurora-bg__blob--3" />
      </div>
      <div className="grid-texture" aria-hidden />
    </>
  )
}

export function Sidebar(): React.JSX.Element {
  const view = useView((state) => state.view)
  const navigate = useView((state) => state.navigate)
  const settings = useSettings((state) => state.settings)
  const updateSettings = useSettings((state) => state.update)
  const instances = useInstances((state) => state.instances)
  const running = useInstances((state) => state.running)
  const activeId = useInstances((state) => state.activeInstanceId)
  const collapsed = settings?.ui?.sidebarCollapsed ?? false

  const activeInstance = instances.find((instance) => instance.id === activeId) ?? instances[0]
  const runningGame = running.find((game) => game.instanceId === activeInstance?.id)
  const agentRunning = running.length > 0

  const groups: { key: NavItem['group']; label: string }[] = [
    { key: 'game', label: '游戏' },
    { key: 'ai', label: '智能' },
    { key: 'system', label: '系统' }
  ]

  return (
    <aside
      style={{
        width: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--c-hairline)',
        background: 'linear-gradient(180deg, rgba(15,19,28,0.86) 0%, rgba(10,13,20,0.92) 100%)',
        backdropFilter: 'blur(18px)',
        transition: 'width var(--t-slow) var(--ease-out)',
        position: 'relative',
        zIndex: 2
      }}
    >
      {/* 品牌区 */}
      <div className="row gap-3" style={{ padding: collapsed ? '18px 0' : '18px 18px', justifyContent: collapsed ? 'center' : 'flex-start' }}>
        <div
          className="center"
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            borderRadius: 9,
            background: 'var(--g-verdant)',
            boxShadow: '0 3px 14px var(--c-verdant-glow)',
            color: '#04140b',
            fontWeight: 800,
            fontSize: 13,
            letterSpacing: '-0.03em'
          }}
        >
          MC
        </div>
        {!collapsed ? (
          <div className="col" style={{ lineHeight: 1.15 }}>
            <div className="bold" style={{ fontSize: 14, letterSpacing: '-0.01em' }}>
              MCAL
            </div>
            <div className="fs-xs muted">Agent Launcher</div>
          </div>
        ) : null}
      </div>

      {/* 导航 */}
      <nav className="grow scroll-y no-scrollbar" style={{ padding: collapsed ? '0 8px' : '0 10px' }}>
        {groups.map((group) => (
          <div key={group.key} style={{ marginBottom: 14 }}>
            {!collapsed ? (
              <div className="fs-xs faint" style={{ padding: '6px 8px 4px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {group.label}
              </div>
            ) : null}
            <div className="col gap-1">
              {NAV_ITEMS.filter((item) => item.group === group.key).map((item) => {
                const active = view === item.id
                const dot = item.id === 'agent' && agentRunning
                const button = (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className="row gap-3"
                    style={{
                      width: '100%',
                      padding: collapsed ? '9px 0' : '8px 10px',
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      borderRadius: 9,
                      color: active ? 'var(--c-text)' : 'var(--c-text-soft)',
                      background: active ? 'rgba(61, 220, 132, 0.13)' : 'transparent',
                      boxShadow: active ? 'inset 0 0 0 1px rgba(61, 220, 132, 0.22)' : 'none',
                      transition: 'background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out)',
                      position: 'relative'
                    }}
                    onMouseEnter={(event) => {
                      if (!active) event.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    }}
                    onMouseLeave={(event) => {
                      if (!active) event.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <span style={{ color: active ? 'var(--c-verdant)' : 'currentColor', display: 'flex' }}>{item.icon}</span>
                    {!collapsed ? <span style={{ fontSize: 13 }}>{item.label}</span> : null}
                    {dot ? (
                      <span
                        className="anim-pulse"
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: 'var(--c-verdant)',
                          boxShadow: '0 0 8px var(--c-verdant)',
                          marginLeft: collapsed ? 0 : 'auto',
                          position: collapsed ? 'absolute' : 'static',
                          top: collapsed ? 6 : undefined,
                          right: collapsed ? 10 : undefined
                        }}
                      />
                    ) : null}
                  </button>
                )
                return collapsed ? (
                  <Tooltip key={item.id} content={item.label} side="bottom">
                    {button}
                  </Tooltip>
                ) : (
                  button
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* 底部：当前实例 + 折叠 + 版本 */}
      <div className="col gap-2" style={{ padding: collapsed ? '10px 8px' : '10px 12px', borderTop: '1px solid var(--c-hairline)' }}>
        {!collapsed && activeInstance ? (
          <button
            type="button"
            onClick={() => navigate('instances')}
            className="row gap-2"
            style={{ padding: '7px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.035)' }}
            title={`${activeInstance.name} · ${activeInstance.versionId}`}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                flexShrink: 0,
                background: runningGame ? 'var(--c-verdant)' : 'var(--c-text-faint)',
                boxShadow: runningGame ? '0 0 8px var(--c-verdant)' : 'none'
              }}
            />
            <span className="col" style={{ minWidth: 0, textAlign: 'left' }}>
              <span className="fs-sm truncate" style={{ maxWidth: 130 }}>
                {activeInstance.name}
              </span>
              <span className="fs-xs muted truncate" style={{ maxWidth: 130 }}>
                {activeInstance.versionId} · {loaderLabel(activeInstance.loaderType)}
              </span>
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className="row gap-2 fs-xs muted"
          style={{ padding: '6px 8px', justifyContent: collapsed ? 'center' : 'flex-start' }}
          onClick={() => void updateSettings({ ui: { sidebarCollapsed: !collapsed } })}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <IconTerminal size={14} />
          {!collapsed ? <VersionBadge /> : null}
        </button>
      </div>
    </aside>
  )
}

function VersionBadge(): React.JSX.Element {
  const version = useSystem((state) => state.version)
  return <span className="fs-xs faint">{version ? `v${version.app}` : '读取中…'}</span>
}

/* ------------------------------- 通知层 ------------------------------- */

export function Toasts(): React.JSX.Element {
  const toasts = useToasts((state) => state.toasts)
  const dismiss = useToasts((state) => state.dismiss)
  return (
    <div className="mcal-toasts">
      {toasts.map((item) => (
        <div key={item.id} className={`mcal-toast mcal-toast--${item.level}`} onClick={() => dismiss(item.id)} role="status">
          <div className="col gap-1 grow">
            <div className="bold fs-sm">{item.title}</div>
            {item.description ? <div className="fs-xs dim pre-wrap">{item.description}</div> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------- 更新提示条 ------------------------------- */

/**
 * 发现新版本时的提示条（内容区顶部，普通文档流，不遮挡页面按钮）。
 *
 * 数据来自主进程启动后的静默检查：命中新版本时会推 { type: 'available' }。
 * 正在下载（收到过 progress 事件）就不提示，避免和下载进度互相干扰；
 * 点「关闭」后本次会话不再显示。
 */
export function UpdateBanner(): React.JSX.Element | null {
  const navigate = useView((state) => state.navigate)
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const downloading = useRef(false)

  useEffect(() => {
    const off = mcal.onUpdateEvent((event) => {
      if (event.type === 'progress') {
        downloading.current = true
        return
      }
      // 下载结束或失败都要复位，否则以后的「发现新版本」提示会被一直忽略
      if (event.type === 'done' || event.type === 'failed') {
        downloading.current = false
        return
      }
      if (downloading.current || !event.result.hasUpdate || !event.result.latestVersion) return
      setVersion(event.result.latestVersion)
    })
    return off
  }, [])

  if (!version || dismissed) return null

  return (
    <div
      className="row gap-3 wrap anim-rise"
      style={{
        padding: '6px 20px',
        borderBottom: '1px solid var(--c-hairline)',
        background: 'linear-gradient(90deg, rgba(61, 220, 132, 0.16) 0%, rgba(79, 214, 232, 0.08) 55%, transparent 100%)',
        flexShrink: 0
      }}
    >
      <span className="row gap-2">
        <IconSparkles size={13} className="accent" />
        <span className="fs-sm">
          发现新版本 <span className="mono bold">v{version}</span>
        </span>
      </span>
      <span className="fs-xs muted">可以先看更新说明，再决定要不要下载安装包</span>
      <div className="row gap-2" style={{ marginLeft: 'auto' }}>
        <Button size="sm" variant="primary" onClick={() => navigate('settings', { tab: 'about' })}>
          查看
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="mcal-btn--icon"
          icon={<IconClose size={13} />}
          title="关闭"
          onClick={() => setDismissed(true)}
        />
      </div>
    </div>
  )
}

/* ------------------------------- 顶部状态条 ------------------------------- */

export function StatusStrip(): React.JSX.Element | null {
  const tasks = useTasks((state) => state.tasks)
  const running = useInstances((state) => state.running)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const active = tasks.filter((task) => task.state === 'running')

  return (
    <>
      <UpdateBanner />
      {active.length === 0 && running.length === 0 ? null : (
        <div
          className="row gap-4 anim-rise"
          style={{
            padding: '6px 20px',
            borderBottom: '1px solid var(--c-hairline)',
            background: 'rgba(10, 13, 20, 0.7)',
            fontSize: 12,
            flexShrink: 0
          }}
        >
          {running.map((game) => (
            <span key={game.instanceId} className="row gap-2">
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--c-verdant)',
                  boxShadow: '0 0 8px var(--c-verdant)'
                }}
              />
              <span className="dim">游戏运行中</span>
              <span className="mono">
                {Math.floor((now - Date.parse(game.startedAt)) / 1000) > 0
                  ? `${Math.floor((now - Date.parse(game.startedAt)) / 1000)}s`
                  : '启动中'}
              </span>
            </span>
          ))}
          {active.map((task) => (
            <span key={task.taskId} className="row gap-2 grow" style={{ minWidth: 0 }}>
              <span className="mcal-spinner" style={{ width: 11, height: 11, borderWidth: 1.6 }} />
              <span className="dim truncate">{task.label}</span>
              {task.progress ? (
                <span className="mono faint truncate">
                  {task.progress.completed}/{task.progress.total} · {(task.progress.speed / 1024 / 1024).toFixed(1)} MB/s
                </span>
              ) : null}
            </span>
          ))}
        </div>
      )}
    </>
  )
}
