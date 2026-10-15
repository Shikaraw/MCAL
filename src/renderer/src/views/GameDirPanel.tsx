/**
 * 游戏目录面板（设置页「游戏目录」区块）。
 *
 * 三块内容：
 *  1. 当前使用的游戏目录：下载版本、启动没有单独指定目录的实例都用它，显示探测结果；
 *  2. 已知目录：settings.gameDirs 的收藏列表，可切换当前目录或从列表移除（不会动磁盘上的文件）；
 *  3. 扫描到的目录：detectGameDirs() 扫出的候选，可加入列表或直接切过去。
 *
 * 说明：探测（probeGameDir）只读浅层标记，但会统计 versions/ 与 mods/ 的体积，
 * 目录很大时略慢，因此结果缓存在 state 中：仅路径集合变化、点「重新探测」或增删目录时才重新探测。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GameDirCandidate, McalSettings } from '@shared/types'
import { mcal } from '../lib/api'
import { formatBytes, formatDateTime, formatRelativeTime, loaderLabel } from '../lib/format'
import { reportError, toast, useSettings } from '../state/store'
import { Badge, Button, Card, Empty } from '../components/ui/primitives'
import {
  IconAlert,
  IconCheck,
  IconExternal,
  IconFolder,
  IconGauge,
  IconInfo,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconTrash
} from '../components/ui/icons'

type BadgeTone = 'default' | 'ok' | 'warn' | 'err' | 'info' | 'violet' | 'gold'

const SOURCE_LABELS: Record<GameDirCandidate['source'], string> = {
  official: '官方启动器',
  thirdparty: '第三方启动器',
  common: '常见位置',
  manual: '手动添加'
}

const SOURCE_TONES: Record<GameDirCandidate['source'], BadgeTone> = {
  official: 'info',
  thirdparty: 'violet',
  common: 'default',
  manual: 'gold'
}

/** 版本数超过这个数量就让列表内部滚动，避免把设置页撑得很长 */
const SCROLL_THRESHOLD = 8
/** 列表滚动时的高度上限 */
const LIST_MAX_HEIGHT = 420

/** 路径归一化：只用于比较与缓存 key，不用于展示 */
function pathKey(path: string): string {
  return path
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function listStyle(count: number): { maxHeight?: number; overflowY?: 'auto'; paddingRight?: number } {
  return count > SCROLL_THRESHOLD ? { maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto', paddingRight: 4 } : {}
}

export function GameDirPanel(): React.JSX.Element {
  const settings = useSettings((state) => state.settings)
  if (!settings) {
    return (
      <Card padding={18}>
        <div className="fs-sm muted">设置读取中…</div>
      </Card>
    )
  }
  return <GameDirSection settings={settings} />
}

function GameDirSection({ settings }: { settings: McalSettings }): React.JSX.Element {
  const update = useSettings((state) => state.update)

  const [probes, setProbes] = useState<Record<string, GameDirCandidate>>({})
  const [probing, setProbing] = useState(false)
  const [detected, setDetected] = useState<GameDirCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)

  const current = settings.defaultGameDir
  const entries = settings.gameDirs

  const knownPaths = useMemo(
    () => [current, ...entries.map((entry) => entry.path)].filter((path) => Boolean(path?.trim())),
    [current, entries]
  )
  const knownKey = knownPaths.join('|')

  /* ------------------------------ 探测 ------------------------------ */

  const probePaths = useCallback(async (paths: string[]) => {
    const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
    if (unique.length === 0) {
      setProbes({})
      return
    }
    setProbing(true)
    try {
      const list = await Promise.all(unique.map((path) => mcal.probeGameDir(path).catch(() => null)))
      const next: Record<string, GameDirCandidate> = {}
      for (const candidate of list) {
        if (candidate) next[pathKey(candidate.path)] = candidate
      }
      setProbes(next)
    } catch (error) {
      reportError(error, '探测游戏目录失败')
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    void probePaths(knownPaths)
    // 只在路径集合真的变化时重新探测：knownKey 就是它的稳定序列化
    // （依赖里放 knownKey 而不是 knownPaths，避免设置对象被重新读取时重复探测一遍）
  }, [knownKey, probePaths])

  /* ------------------------------ 自动检测 ------------------------------ */

  const detect = useCallback(async () => {
    setScanning(true)
    try {
      const list = await mcal.detectGameDirs()
      setDetected(list)
      if (list.length === 0) {
        toast.info('没有扫描到游戏目录', '可以用下面的「手动添加目录」直接指定 .minecraft 的位置')
      } else {
        toast.ok(`扫描到 ${list.length} 个可能的游戏目录`, '确认后可以「加入列表」或直接「使用」')
      }
    } catch (error) {
      reportError(error, '扫描游戏目录失败')
    } finally {
      setScanning(false)
    }
  }, [])

  /* ------------------------------ 列表增删 ------------------------------ */

  const markAdded = useCallback((next: { path: string }[]) => {
    const keys = new Set(next.map((entry) => pathKey(entry.path)))
    setDetected((prev) => prev?.map((candidate) => ({ ...candidate, added: keys.has(pathKey(candidate.path)) })) ?? prev)
  }, [])

  const addDir = useCallback(
    async (path: string, label?: string) => {
      setBusyPath(path)
      try {
        const next = await mcal.addGameDir(path, label)
        await update({ gameDirs: next })
        markAdded(next)
        await probePaths([current, ...next.map((entry) => entry.path)])
        toast.ok('已加入已知目录', path)
      } catch (error) {
        reportError(error, '添加游戏目录失败')
      } finally {
        setBusyPath(null)
      }
    },
    [current, markAdded, probePaths, update]
  )

  const removeDir = useCallback(
    async (path: string) => {
      setBusyPath(path)
      try {
        const next = await mcal.removeGameDir(path)
        await update({ gameDirs: next })
        markAdded(next)
        toast.ok('已从列表移除', '磁盘上的文件没有被改动')
      } catch (error) {
        reportError(error, '移除游戏目录失败')
      } finally {
        setBusyPath(null)
      }
    },
    [markAdded, update]
  )

  const manualAdd = useCallback(async () => {
    try {
      const picked = await mcal.pickDir({ title: '选择 .minecraft 游戏目录', defaultPath: current })
      if (!picked) return
      const probe = await mcal.probeGameDir(picked).catch(() => null)
      await addDir(picked)
      if (probe && !probe.valid) {
        toast.warn('这个目录看起来不是有效的 .minecraft', '已加入列表，确认无误后再切换过去')
      }
    } catch (error) {
      reportError(error, '选择目录失败')
    }
  }, [addDir, current])

  /* ------------------------------ 切换当前目录 ------------------------------ */

  const useAsDefault = useCallback(
    async (path: string, label?: string) => {
      setBusyPath(path)
      try {
        const known = entries.some((entry) => pathKey(entry.path) === pathKey(path))
        if (!known) {
          // 从「扫描到的目录」直接用：先登记进列表，避免切换后找不到来源
          const next = await mcal.addGameDir(path, label)
          await update({ gameDirs: next })
          markAdded(next)
        }
        await update({ defaultGameDir: path })
        toast.ok('已切换游戏目录', path)
      } catch (error) {
        reportError(error, '切换游戏目录失败')
      } finally {
        setBusyPath(null)
      }
    },
    [entries, markAdded, update]
  )

  const openDir = useCallback((path: string) => {
    void mcal.openPath(path).catch((error: unknown) => reportError(error, '打开目录失败'))
  }, [])

  const currentProbe = probes[pathKey(current)]
  const currentAdded = entries.some((entry) => pathKey(entry.path) === pathKey(current))

  return (
    <div className="col gap-4">
      {/* ------------------------------ 当前使用的目录 ------------------------------ */}
      <Card padding={18}>
        <div className="row-between gap-3 wrap" style={{ marginBottom: 10 }}>
          <div className="row gap-2 wrap">
            <IconFolder size={16} className="accent" />
            <span className="fs-md bold">当前使用的游戏目录</span>
            {currentProbe ? (
              currentProbe.valid ? (
                <Badge tone="ok">有效目录 · {currentProbe.versionCount} 个版本</Badge>
              ) : (
                <Badge tone="warn">还没创建或不是 .minecraft</Badge>
              )
            ) : (
              <Badge>{probing ? '探测中…' : '未探测'}</Badge>
            )}
            {!currentAdded ? <Badge tone="gold">未加入已知列表</Badge> : null}
          </div>
          <div className="row gap-2">
            <Button
              size="sm"
              icon={<IconRefresh size={13} />}
              loading={probing}
              onClick={() => void probePaths(knownPaths)}
            >
              重新探测
            </Button>
            <Button size="sm" icon={<IconFolder size={13} />} onClick={() => openDir(current)}>
              在文件管理器中打开
            </Button>
          </div>
        </div>

        <div className="mono fs-xs break-all">{current}</div>

        <div className="row gap-4 wrap fs-xs muted" style={{ marginTop: 8 }}>
          <span>已装版本：{currentProbe ? `${currentProbe.versionCount} 个` : '读取中…'}</span>
          {currentProbe && currentProbe.loaders.length > 0 ? (
            <span className="row gap-1 wrap">
              加载器：
              {currentProbe.loaders.map((loader) => (
                <Badge key={loader}>{loaderLabel(loader)}</Badge>
              ))}
            </span>
          ) : null}
          {currentProbe ? <span>体积：{formatBytes(currentProbe.sizeBytes)}</span> : null}
          {currentProbe ? (
            <span title={formatDateTime(currentProbe.lastModified)}>最近修改：{formatRelativeTime(currentProbe.lastModified)}</span>
          ) : null}
        </div>

        {currentProbe && !currentProbe.valid ? (
          <div className="row-start gap-2 fs-xs warn" style={{ marginTop: 10 }}>
            <IconAlert size={13} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              这个目录看起来还不是有效的 .minecraft（没有 versions/ 与 launcher_profiles.json）：
              可能是还没创建，也可能路径已经变了。启动器会在下载第一个版本时自动建好需要的子目录。
            </span>
          </div>
        ) : null}

        <div className="row-start gap-2 fs-xs muted" style={{ marginTop: 10 }}>
          <IconInfo size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            下载游戏版本、以及没有单独指定目录的实例，都会使用这里的路径。想要多个独立目录（例如多份存档 / 不同整合包），
            把它们都加进下面的列表，再按需切换即可。
          </span>
        </div>
      </Card>

      {/* ------------------------------ 已知目录 ------------------------------ */}
      <Card padding={18}>
        <div className="row-between gap-3 wrap" style={{ marginBottom: 12 }}>
          <div className="row gap-2 wrap">
            <IconLayers size={16} className="accent" />
            <span className="fs-md bold">已知目录</span>
            <Badge>{entries.length} 个</Badge>
            {probing ? <span className="fs-xs muted">探测中…</span> : null}
          </div>
          <Button size="sm" icon={<IconPlus size={13} />} onClick={() => void manualAdd()}>
            手动添加目录
          </Button>
        </div>

        {entries.length === 0 ? (
          <Empty
            icon={<IconFolder />}
            title="还没有记录任何游戏目录"
            description="可以点右上角「手动添加目录」选择一个 .minecraft，或者用下面的「自动检测」扫描常见的安装位置（官方启动器 / HMCL / PCL2 / PrismLauncher 等）。"
            action={
              <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
                <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => void manualAdd()}>
                  手动添加目录
                </Button>
                <Button size="sm" icon={<IconGauge size={13} />} loading={scanning} onClick={() => void detect()}>
                  自动检测
                </Button>
              </div>
            }
          />
        ) : (
          <div className="col gap-2 scroll-y stagger" style={listStyle(entries.length)}>
            {entries.map((entry) => {
              const candidate = probes[pathKey(entry.path)]
              const isCurrent = pathKey(entry.path) === pathKey(current)
              const busy = busyPath === entry.path
              return (
                <div
                  key={entry.path}
                  className="mcal-panel col gap-2"
                  style={{
                    padding: '10px 12px',
                    borderColor: isCurrent
                      ? 'rgba(61,220,132,0.45)'
                      : candidate && !candidate.valid
                        ? 'rgba(255,157,77,0.35)'
                        : 'var(--c-hairline)'
                  }}
                >
                  <div className="row gap-2 wrap">
                    <span className="fs-sm bold">{entry.label || entry.path}</span>
                    <Badge tone={SOURCE_TONES[entry.source]}>{SOURCE_LABELS[entry.source]}</Badge>
                    {isCurrent ? <Badge tone="ok">当前使用</Badge> : null}
                    <Badge title={`加入于 ${formatDateTime(entry.addedAt)}`}>
                      加入于 {formatRelativeTime(entry.addedAt)}
                    </Badge>
                    {candidate && !candidate.valid ? <Badge tone="warn">不是有效的 .minecraft</Badge> : null}
                  </div>
                  <div className="mono fs-xs faint break-all">{entry.path}</div>
                  <div className="row gap-4 wrap fs-xs muted">
                    {candidate ? (
                      <>
                        <span>已装版本：{candidate.versionCount} 个</span>
                        {candidate.loaders.length > 0 ? (
                          <span className="row gap-1 wrap">
                            {candidate.loaders.map((loader) => (
                              <Badge key={loader}>{loaderLabel(loader)}</Badge>
                            ))}
                          </span>
                        ) : null}
                        <span>体积：{formatBytes(candidate.sizeBytes)}</span>
                        <span title={formatDateTime(candidate.lastModified)}>
                          最近修改：{formatRelativeTime(candidate.lastModified)}
                        </span>
                      </>
                    ) : (
                      <span className="faint">{probing ? '探测中…' : '未探测'}</span>
                    )}
                  </div>
                  {candidate && !candidate.valid ? (
                    <span className="fs-xs warn">
                      这个目录看起来还不是有效的 .minecraft（没有 versions/ 与 launcher_profiles.json），切换过去也能用，只是暂时没有已装版本。
                    </span>
                  ) : null}
                  <div className="row gap-2 wrap">
                    <Button
                      size="sm"
                      variant={isCurrent ? 'default' : 'primary'}
                      icon={<IconCheck size={13} />}
                      loading={busy}
                      disabled={isCurrent}
                      onClick={() => void useAsDefault(entry.path)}
                    >
                      {isCurrent ? '正在使用' : '切换到此目录'}
                    </Button>
                    <Button size="sm" icon={<IconFolder size={13} />} onClick={() => openDir(entry.path)}>
                      在文件管理器中打开
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconTrash size={13} />}
                      loading={busy}
                      title="只从列表移除，不会删除磁盘上的任何文件"
                      onClick={() => void removeDir(entry.path)}
                    >
                      移除
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ------------------------------ 扫描到的目录 ------------------------------ */}
      <Card padding={18}>
        <div className="row-between gap-3 wrap" style={{ marginBottom: 12 }}>
          <div className="row gap-2 wrap">
            <IconGauge size={16} className="accent" />
            <span className="fs-md bold">扫描到的目录</span>
            {detected ? <Badge>{detected.length} 个候选</Badge> : null}
            <span className="fs-xs muted">扫描官方启动器、HMCL、PCL2、PrismLauncher 等常见位置，不会递归读文件</span>
          </div>
          <Button size="sm" variant="primary" icon={<IconRefresh size={13} />} loading={scanning} onClick={() => void detect()}>
            自动检测
          </Button>
        </div>

        {scanning ? (
          <div className="col gap-2">
            <div className="skeleton" style={{ height: 56 }} />
            <div className="skeleton" style={{ height: 56 }} />
            <div className="fs-xs muted">正在检查常见安装位置与各个盘符下的固定路径，稍等几秒…</div>
          </div>
        ) : detected === null ? (
          <div className="row-start gap-2 fs-xs muted">
            <IconInfo size={13} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              点「自动检测」扫一遍本机。检测到的目录会列出已装版本数、加载器与体积；确认无误后可以「加入列表」备查，
              或直接「使用」切换成当前游戏目录。
            </span>
          </div>
        ) : detected.length === 0 ? (
          <Empty
            icon={<IconAlert />}
            title="没有扫描到游戏目录"
            description={
              <>
                常见原因：还没装过任何启动器、游戏装在非默认位置，或者目录被挪走了。可以用「手动添加目录」直接指定
                .minecraft 的位置（选中后启动器会立刻探测它是不是有效目录）。
              </>
            }
            action={
              <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
                <Button size="sm" variant="primary" icon={<IconPlus size={13} />} onClick={() => void manualAdd()}>
                  手动添加目录
                </Button>
                <Button size="sm" icon={<IconRefresh size={13} />} loading={scanning} onClick={() => void detect()}>
                  重新检测
                </Button>
              </div>
            }
          />
        ) : (
          <div className="col gap-2 scroll-y stagger" style={listStyle(detected.length)}>
            {detected.map((candidate) => {
              const isCurrent = pathKey(candidate.path) === pathKey(current)
              const busy = busyPath === candidate.path
              return (
                <div
                  key={candidate.path}
                  className="mcal-panel col gap-2"
                  style={{
                    padding: '10px 12px',
                    borderColor: candidate.valid
                      ? isCurrent
                        ? 'rgba(61,220,132,0.45)'
                        : 'var(--c-hairline)'
                      : 'rgba(255,157,77,0.35)'
                  }}
                >
                  <div className="row gap-2 wrap">
                    <span className="fs-sm bold">{candidate.label}</span>
                    <Badge tone={SOURCE_TONES[candidate.source]}>{SOURCE_LABELS[candidate.source]}</Badge>
                    {isCurrent ? <Badge tone="ok">当前使用</Badge> : null}
                    {candidate.added ? <Badge tone="info">已添加</Badge> : null}
                    {candidate.valid ? <Badge tone="ok">有效目录</Badge> : <Badge tone="warn">不是有效的 .minecraft</Badge>}
                  </div>
                  <div className="mono fs-xs faint break-all">{candidate.path}</div>
                  <div className="row gap-4 wrap fs-xs muted">
                    <span>已装版本：{candidate.versionCount} 个</span>
                    {candidate.loaders.length > 0 ? (
                      <span className="row gap-1 wrap">
                        {candidate.loaders.map((loader) => (
                          <Badge key={loader}>{loaderLabel(loader)}</Badge>
                        ))}
                      </span>
                    ) : null}
                    <span>体积：{formatBytes(candidate.sizeBytes)}</span>
                    <span title={formatDateTime(candidate.lastModified)}>
                      最近修改：{formatRelativeTime(candidate.lastModified)}
                    </span>
                  </div>
                  {!candidate.valid ? (
                    <span className="fs-xs warn">
                      这个目录看起来还不是有效的 .minecraft（没有 versions/ 与 launcher_profiles.json）：
                      可能是空目录或已被搬走。仍然可以加入列表，切换过去后启动器需要时会自己创建子目录。
                    </span>
                  ) : null}
                  <div className="row gap-2 wrap">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<IconCheck size={13} />}
                      loading={busy}
                      disabled={isCurrent}
                      onClick={() => void useAsDefault(candidate.path, candidate.label)}
                    >
                      {isCurrent ? '正在使用' : '使用'}
                    </Button>
                    <Button
                      size="sm"
                      icon={<IconPlus size={13} />}
                      loading={busy}
                      disabled={candidate.added}
                      title={candidate.added ? '已经在已知目录列表里' : '登记到已知目录列表'}
                      onClick={() => void addDir(candidate.path, candidate.label)}
                    >
                      {candidate.added ? '已加入列表' : '加入列表'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconExternal size={13} />}
                      onClick={() => openDir(candidate.path)}
                      title="在文件管理器中打开"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
