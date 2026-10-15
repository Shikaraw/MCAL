/**
 * 软件更新面板（设置页「软件更新」区块）。
 *
 * 交互约定：
 *  - 检查与下载都在主进程完成，渲染层只消费 UpdateCheckResult 与 update 事件流；
 *  - 开关类（更新源 / 自动检查 / 系统代理）即时保存，文本框（仓库、自定义前缀）走「保存」按钮，
 *    与设置页其它区块保持一致（见 SettingsView 顶部注释）；
 *  - 启动时的静默检查会推来 { type: 'available' } 事件，收到后直接展示「有新版本」；
 *  - 下载完成只负责把安装包放到下载目录，安装需要用户手动运行（不静默替换当前程序）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { McalSettings, UpdateAsset, UpdateCheckResult } from '@shared/types'
import { mcal } from '../lib/api'
import { formatBytes, formatDateTime, formatRelativeTime } from '../lib/format'
import { reportError, toast, useSettings } from '../state/store'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Progress,
  Segmented,
  Select,
  Switch
} from '../components/ui/primitives'
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconDownload,
  IconExternal,
  IconFolder,
  IconInfo,
  IconRefresh,
  IconSparkles,
  IconWrench
} from '../components/ui/icons'
import { Markdown } from '../components/ui/Markdown'

/**
 * 可选镜像线路。
 * 与 core/update/mirrors.ts 的 MIRROR_PRESETS 对应（渲染层不能 import core，
 * 这里只保留 id / 名称 / 说明；id 与主进程一致即可生效，多余的项会被回退逻辑忽略）。
 */
const MIRROR_OPTIONS: { id: string; name: string; note: string }[] = [
  { id: 'ghproxy', name: 'gh-proxy.com', note: '长期稳定，推荐' },
  { id: 'ghfast', name: 'ghfast.top', note: '备用线路' },
  { id: 'llkk', name: 'gh.llkk.cc', note: '备用线路 2' },
  { id: 'moeyy', name: 'github.moeyy.xyz', note: '备用线路 3' },
  { id: 'direct', name: 'GitHub 官方直连', note: '需要本机能直连 GitHub' }
]

const REASON_LABELS: Record<string, string> = {
  'no-release': '仓库还没有发布 Release',
  network: '所有更新源都连不上',
  disabled: '自动检查已关闭',
  'bad-repo': '更新仓库配置不合法'
}

/** no-release / disabled 属于正常状态，别用红色吓用户 */
function isSoftFailure(result: UpdateCheckResult): boolean {
  return result.reason === 'no-release' || result.reason === 'disabled'
}

function ResultBadge({ result }: { result: UpdateCheckResult | null }): React.JSX.Element | null {
  if (!result) return null
  if (!result.ok) return <Badge tone={isSoftFailure(result) ? 'warn' : 'err'}>检查失败</Badge>
  if (result.hasUpdate) return <Badge tone="ok">有更新 v{result.latestVersion}</Badge>
  return <Badge tone="info">已是最新</Badge>
}

export function UpdatePanel(): React.JSX.Element {
  const settings = useSettings((state) => state.settings)
  if (!settings) {
    return (
      <Card padding={18}>
        <div className="fs-sm muted">设置读取中…</div>
      </Card>
    )
  }
  return <UpdateSection settings={settings} />
}

function UpdateSection({ settings }: { settings: McalSettings }): React.JSX.Element {
  const updateSettings = useSettings((state) => state.update)

  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState<UpdateAsset | null>(null)
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [repoDraft, setRepoDraft] = useState(settings.update.repo)
  const [prefixDraft, setPrefixDraft] = useState(settings.update.customPrefix ?? '')

  const update = settings.update

  useEffect(() => {
    void mcal
      .versions()
      .then((versions) => setAppVersion(versions.app))
      .catch(() => undefined)
  }, [])

  /**
   * 挂载时补一次静默检查：启动时的检查发生在设置页还没打开的时候，
   * 顶部提示条虽然能提示「发现新版本」，但这里的详情是空的。
   * 只在「开了自动检查」且上次检查超过 5 分钟时补，避免每次进来都打网络；
   * 静默检查不打 toast，结果直接落到面板上。
   */
  useEffect(() => {
    if (!settings.update.autoCheck) return
    const last = settings.update.lastCheckAt ? Date.parse(settings.update.lastCheckAt) : Number.NaN
    if (Number.isFinite(last) && Date.now() - last < 5 * 60_000) return
    let cancelled = false
    setChecking(true)
    void mcal
      .checkUpdate()
      .then((next) => {
        if (!cancelled) setResult(next)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /* ------------------------------ 更新事件 ------------------------------ */

  useEffect(() => {
    const off = mcal.onUpdateEvent((event) => {
      if (event.type === 'progress') {
        setProgress({ received: event.received, total: event.total })
        return
      }
      if (event.type === 'done') {
        setSaved(event.file)
        setProgress(null)
        return
      }
      if (event.type === 'failed') {
        // 主进程已经把所有候选地址试过一遍了，这里只负责把状态复位并说明原因
        setProgress(null)
        toast.warn('更新包下载失败', event.error || '所有更新源都不可用，可以稍后重试或改用直连')
        return
      }
      // 启动时的静默检查结果：直接展示出来，用户不需要再点一次检查
      setResult(event.result)
      if (event.result.hasUpdate) {
        toast.info(
          `发现新版本 v${event.result.latestVersion ?? ''}`,
          '可以在「设置 → 关于 → 软件更新」里查看更新说明并下载'
        )
      }
    })
    return off
  }, [])

  /* ------------------------------ 检查更新 ------------------------------ */

  const check = useCallback(async () => {
    setChecking(true)
    try {
      const next = await mcal.checkUpdate({ manual: true })
      setResult(next)
      if (!next.ok) {
        toast.warn(REASON_LABELS[next.reason ?? ''] ?? '检查更新失败', next.message ?? '所有更新源都不可用')
      } else if (next.hasUpdate) {
        toast.ok(`发现新版本 v${next.latestVersion ?? ''}`, `当前版本 v${next.currentVersion}`)
      } else {
        toast.ok('已经是最新版本', `当前版本 v${next.currentVersion}`)
      }
    } catch (error) {
      reportError(error, '检查更新失败')
    } finally {
      setChecking(false)
    }
  }, [])

  /* ------------------------------ 下载安装包 ------------------------------ */

  const download = useCallback(async (asset: UpdateAsset) => {
    setDownloading(asset)
    setProgress(null)
    setSaved(null)
    try {
      const outcome = await mcal.downloadUpdate(asset)
      if (outcome.ok && outcome.file) {
        setSaved(outcome.file)
        toast.ok('安装包已下载', outcome.file)
      } else {
        toast.err('下载更新包失败', outcome.error ?? '所有下载地址都失败了，可以换个更新源再试')
      }
    } catch (error) {
      reportError(error, '下载更新包失败')
    } finally {
      setDownloading(null)
      setProgress(null)
    }
  }, [])

  const openRelease = useCallback((url: string | undefined) => {
    if (!url) return
    void mcal.openUpdateRelease(url).catch((error: unknown) => reportError(error, '打开 Release 页面失败'))
  }, [])

  const revealSaved = useCallback((file: string) => {
    void mcal.revealPath(file).catch((error: unknown) => reportError(error, '打开所在文件夹失败'))
  }, [])

  /* ------------------------------ 设置项 ------------------------------ */

  const patch = useCallback(
    (partial: Partial<McalSettings['update']>) => {
      // store 只做顶层浅合并，所以整个 update 子对象一起传
      void updateSettings({ update: { ...settings.update, ...partial } })
    },
    [settings.update, updateSettings]
  )

  const dirty = repoDraft.trim() !== update.repo || prefixDraft.trim() !== (update.customPrefix ?? '')

  const saveConfig = useCallback(async () => {
    const repo = repoDraft.trim()
    if (!repo) {
      toast.warn('更新仓库不能为空', '需要填 owner/repo 形式，例如 Shikaraw/MinecraftAgentLauncher')
      return
    }
    await updateSettings({ update: { ...update, repo, customPrefix: prefixDraft.trim() } })
    toast.ok('更新设置已保存')
  }, [prefixDraft, repoDraft, update, updateSettings])

  /** 跳过某个版本：写进设置的同时立刻更新界面，用户能马上看到「已被跳过」 */
  const skipVersion = useCallback(
    (version: string) => {
      patch({ skippedVersion: version })
      setResult((prev) =>
        prev ? { ...prev, hasUpdate: false, message: `最新版本 ${version} 已被你跳过；需要升级时可以在下面取消跳过。` } : prev
      )
      toast.ok(`已跳过 v${version}`, '自动检查不再提示这个版本，手动检查仍然会显示')
    },
    [patch]
  )

  const unskipVersion = useCallback(
    async (version: string) => {
      // 先落盘再重新检查：主进程是按设置里的 skippedVersion 判断的，
      // 直接本地把 hasUpdate 置 true 会在「跳过的其实就是当前版本」时给出错误提示
      await updateSettings({ update: { ...settings.update, skippedVersion: '' } })
      toast.ok(`已取消跳过 v${version}`, '正在重新检查这个版本')
      await check()
    },
    [check, settings.update, updateSettings]
  )

  const lastCheckLabel = useMemo(() => {
    if (result) return `${formatRelativeTime(result.checkedAt)}（${formatDateTime(result.checkedAt)}）`
    return formatRelativeTime(update.lastCheckAt)
  }, [result, update.lastCheckAt])

  const skippedLatest = Boolean(
    result?.ok &&
      result.latestVersion &&
      !result.hasUpdate &&
      update.skippedVersion &&
      update.skippedVersion === result.latestVersion
  )

  const percentLabel = useMemo(() => {
    if (!progress) return '准备中…'
    const percent = progress.total > 0 ? ` · ${Math.floor((progress.received / progress.total) * 100)}%` : ''
    return progress.total > 0
      ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}${percent}`
      : formatBytes(progress.received)
  }, [progress])

  const assets = result?.assets ?? []

  return (
    <div id="mcal-update-panel" className="col gap-4">
      {/* ------------------------------ 版本与检查 ------------------------------ */}
      <Card padding={18}>
        <div className="row-between gap-3 wrap">
          <div className="row gap-2 wrap">
            <IconRefresh size={16} className="accent" />
            <span className="fs-md bold">软件更新</span>
            <Badge tone="ok">当前 v{appVersion ?? result?.currentVersion ?? '—'}</Badge>
            <ResultBadge result={result} />
            {update.skippedVersion ? <Badge tone="warn" title="在自动检查里不再提示这个版本">已跳过 v{update.skippedVersion}</Badge> : null}
          </div>
          <Button variant="primary" icon={<IconRefresh size={14} />} loading={checking} onClick={() => void check()}>
            检查更新
          </Button>
        </div>

        <div className="row gap-4 wrap fs-xs muted" style={{ marginTop: 8 }}>
          <span className="row gap-1">
            <IconClock size={12} />
            上次检查：{lastCheckLabel}
          </span>
          {result?.source ? <span>命中更新源：{result.source}</span> : null}
          <span>
            更新仓库：<span className="mono">{update.repo}</span>
          </span>
        </div>

        {!result ? (
          <div className="row-start gap-2 fs-xs muted" style={{ marginTop: 10 }}>
            <IconInfo size={13} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              点「检查更新」会查询上面这个 GitHub 仓库的最新 Release，并把本平台可用的安装包列出来。
              启动时也会静默检查一次（可在下面关掉），发现新版本会在顶部提示，不会自动下载或安装。
            </span>
          </div>
        ) : null}
      </Card>

      {/* ------------------------------ 更新源与策略 ------------------------------ */}
      <Card padding={18}>
        <div className="row gap-2" style={{ marginBottom: 6 }}>
          <IconWrench size={16} className="accent" />
          <span className="fs-md bold">更新源与检查策略</span>
        </div>
        <div className="fs-xs muted" style={{ marginBottom: 14, lineHeight: 'var(--lh-relaxed)', maxWidth: 760 }}>
          国内直连 api.github.com 经常整体超时，所以默认走公共加速前缀：按选中的线路优先，失败后自动换下一条，最后才直连官方。
        </div>

        <div className="col gap-4">
          <Field
            label="更新源"
            hint="镜像加速只影响「查询版本」，下载安装包也会走同一线路的地址改写。"
          >
            <Segmented
              value={update.source}
              onChange={(value) => patch({ source: value })}
              options={[
                { value: 'mirror', label: '镜像加速（推荐）' },
                { value: 'direct', label: '直连 GitHub' },
                { value: 'custom', label: '自定义前缀' }
              ]}
            />
          </Field>

          {update.source === 'mirror' ? (
            <Field label="镜像线路" hint={MIRROR_OPTIONS.find((item) => item.id === update.mirrorId)?.note ?? '按顺序自动回退'}>
              <Select
                value={MIRROR_OPTIONS.some((item) => item.id === update.mirrorId) ? update.mirrorId : 'ghproxy'}
                onChange={(value) => patch({ mirrorId: value })}
                options={MIRROR_OPTIONS.map((item) => ({ value: item.id, label: `${item.name} · ${item.note}` }))}
              />
            </Field>
          ) : null}

          {update.source === 'custom' ? (
            <Field
              label="自定义前缀"
              hint="例如 https://gh-proxy.com/ —— 会拼在 https://api.github.com 前面；留空则自动退回内置镜像列表。"
            >
              <Input value={prefixDraft} onChange={setPrefixDraft} placeholder="https://your-mirror.example.com/" monospace />
            </Field>
          ) : null}

          <div className="row-between gap-4 wrap">
            <div className="col gap-1" style={{ minWidth: 260, flex: 1 }}>
              <span className="fs-sm">走系统代理</span>
              <span className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
                默认直连镜像更快更稳，只有只能靠代理上网时才需要打开。
              </span>
            </div>
            <div className="row gap-2">
              <Switch
                checked={update.useSystemProxy}
                onChange={(value) => patch({ useSystemProxy: value })}
                label="走系统代理"
              />
              <span className="fs-sm muted">{update.useSystemProxy ? '已开启' : '已关闭'}</span>
            </div>
          </div>

          <div className="row-between gap-4 wrap">
            <div className="col gap-1" style={{ minWidth: 260, flex: 1 }}>
              <span className="fs-sm">启动时自动检查更新</span>
              <span className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
                只在启动后静默查询一次，发现新版本时在内容区顶部显示提示条；不会自动下载、不会自动替换程序。
              </span>
            </div>
            <div className="row gap-2">
              <Switch
                checked={update.autoCheck}
                onChange={(value) => patch({ autoCheck: value })}
                label="自动检查更新"
              />
              <span className="fs-sm muted">{update.autoCheck ? '已开启' : '已关闭'}</span>
            </div>
          </div>

          <Field label="更新仓库（owner/repo）" hint="MCAL 的发布仓库，一般不需要改；填错会在检查时提示配置不合法。">
            <Input value={repoDraft} onChange={setRepoDraft} placeholder="owner/repo" monospace />
          </Field>

          <div className="row gap-2 wrap" style={{ alignItems: 'center' }}>
            <Button variant="primary" size="sm" disabled={!dirty} onClick={() => void saveConfig()}>
              保存
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setRepoDraft(update.repo)
                setPrefixDraft(update.customPrefix ?? '')
              }}
            >
              还原
            </Button>
            {dirty ? <Badge tone="warn">未保存</Badge> : <span className="fs-xs faint">修改后需要点「保存」才会写入设置</span>}
          </div>
        </div>
      </Card>

      {/* ------------------------------ 有新版本 ------------------------------ */}
      {result?.ok && result.hasUpdate ? (
        <Card padding={18}>
          <div className="row-between gap-3 wrap" style={{ marginBottom: 10 }}>
            <div className="row gap-2 wrap">
              <IconSparkles size={16} className="accent" />
              <span className="fs-md bold">发现新版本</span>
              <Badge tone="ok">v{result.latestVersion}</Badge>
              {result.prerelease ? <Badge tone="warn">预发布</Badge> : null}
              {result.tagName ? <span className="fs-xs faint mono">{result.tagName}</span> : null}
            </div>
            <div className="row gap-2 wrap">
              {result.releaseUrl ? (
                <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openRelease(result.releaseUrl)}>
                  打开 Release 页面
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (result.latestVersion) skipVersion(result.latestVersion)
                }}
              >
                跳过此版本
              </Button>
            </div>
          </div>

          <div className="row gap-4 wrap fs-xs muted" style={{ marginBottom: 12 }}>
            <span>发布时间：{formatDateTime(result.publishedAt)}</span>
            <span>当前版本：v{result.currentVersion}</span>
            {result.source ? <span>来自：{result.source}</span> : null}
          </div>

          <div className="col gap-2">
            <span className="fs-sm bold">更新说明</span>
            {result.notes && result.notes.trim() ? (
              <div className="mcal-panel scroll-y" style={{ padding: '10px 14px', maxHeight: 300, overflowY: 'auto' }}>
                <Markdown content={result.notes} />
              </div>
            ) : (
              <div className="fs-xs muted">这个版本没有填写更新说明。</div>
            )}
          </div>

          <div className="col gap-2" style={{ marginTop: 14 }}>
            <span className="fs-sm bold">可下载的资源</span>
            {assets.length === 0 ? (
              <div className="fs-xs muted">这个 Release 没有附带资源，可以点上面的「打开 Release 页面」手动下载。</div>
            ) : (
              assets.map((asset) => {
                const busy = downloading?.url === asset.url
                return (
                  <div
                    key={asset.url}
                    className="mcal-panel row-between gap-3 wrap"
                    style={{
                      padding: '10px 12px',
                      borderColor: asset.recommended ? 'rgba(61,220,132,0.45)' : 'var(--c-hairline)'
                    }}
                  >
                    <div className="col gap-1" style={{ minWidth: 0, flex: 1 }}>
                      <div className="row gap-2 wrap">
                        <span className="fs-sm mono break-all">{asset.name}</span>
                        {asset.recommended ? <Badge tone="ok">适合本机</Badge> : null}
                      </div>
                      <span className="fs-xs muted">{formatBytes(asset.size)}</span>
                    </div>
                    <Button
                      size="sm"
                      variant={asset.recommended ? 'primary' : 'default'}
                      icon={<IconDownload size={13} />}
                      loading={busy}
                      disabled={downloading !== null && !busy}
                      onClick={() => void download(asset)}
                    >
                      {asset.recommended ? '下载此安装包' : '下载'}
                    </Button>
                  </div>
                )
              })
            )}
          </div>

          {downloading ? (
            <div className="mcal-panel col gap-2 anim-fade" style={{ padding: 12, marginTop: 14 }}>
              <div className="row-between gap-3 wrap">
                <span className="row gap-2 fs-sm bold">
                  <span className="mcal-spinner accent" style={{ width: 12, height: 12, borderWidth: 1.6 }} />
                  正在下载 {downloading.name}
                </span>
                <span className="fs-xs muted mono">{percentLabel}</span>
              </div>
              <Progress
                value={progress && progress.total > 0 ? progress.received / progress.total : undefined}
                indeterminate={!progress || progress.total <= 0}
              />
              <span className="fs-xs muted">保存到系统下载目录里的 MCAL 文件夹，下载过程不会中断当前游戏。</span>
            </div>
          ) : null}

          {saved ? (
            <div className="mcal-panel col gap-2 anim-fade" style={{ padding: 12, marginTop: 14 }}>
              <div className="row gap-2 wrap">
                <IconCheck size={14} className="ok" />
                <span className="fs-sm bold">安装包已下载完成</span>
                <Badge tone="ok">已完成</Badge>
              </div>
              <span className="fs-xs muted">
                已保存到 <span className="mono break-all">{saved}</span>
              </span>
              <div className="row gap-2 wrap">
                <Button size="sm" icon={<IconFolder size={13} />} onClick={() => revealSaved(saved)}>
                  打开所在文件夹
                </Button>
                {result.releaseUrl ? (
                  <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openRelease(result.releaseUrl)}>
                    打开 Release 页面
                  </Button>
                ) : null}
              </div>
              <span className="fs-xs muted">
                安装前请先关闭启动器并退出正在运行的游戏：安装程序会覆盖当前版本，实例与存档都在数据目录里，不会被删除。
              </span>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------ 已是最新 ------------------------------ */}
      {result?.ok && !result.hasUpdate ? (
        <Card padding={18}>
          <div className="row gap-2 wrap">
            <IconCheck size={15} className="ok" />
            <span className="fs-sm bold">{skippedLatest ? '最新版本已被跳过' : '已经是最新版本'}</span>
            <Badge tone={skippedLatest ? 'warn' : 'ok'}>v{result.currentVersion}</Badge>
            {result.latestVersion && result.latestVersion !== result.currentVersion ? (
              <span className="fs-xs muted">远端最新 v{result.latestVersion}</span>
            ) : null}
            <span className="fs-xs muted">检查于 {formatRelativeTime(result.checkedAt)}</span>
          </div>
          {result.message ? (
            <div className="fs-xs muted" style={{ marginTop: 6, lineHeight: 'var(--lh-relaxed)' }}>
              {result.message}
            </div>
          ) : null}
          {skippedLatest && result.latestVersion ? (
            <div className="row gap-2 wrap" style={{ marginTop: 10 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (result.latestVersion) unskipVersion(result.latestVersion)
                }}
              >
                取消跳过
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------ 检查失败 ------------------------------ */}
      {result && !result.ok ? (
        <Card padding={18}>
          <div className="row gap-2 wrap" style={{ marginBottom: 8 }}>
            <IconAlert size={15} className={isSoftFailure(result) ? 'warn' : 'err'} />
            <span className="fs-sm bold">{REASON_LABELS[result.reason ?? ''] ?? '检查更新失败'}</span>
            <span className="fs-xs muted">检查于 {formatRelativeTime(result.checkedAt)}</span>
          </div>
          <div className="fs-sm muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
            {result.message ?? '没有拿到可用的结果。'}
          </div>

          {result.attempts.length > 0 ? (
            <div className="col gap-1 scroll-y" style={{ marginTop: 12, maxHeight: 160, overflowY: 'auto' }}>
              <span className="fs-xs muted">依次尝试了 {result.attempts.length} 个更新源：</span>
              {result.attempts.map((attempt, index) => (
                <div key={`${attempt.source}-${index}`} className="row-between gap-3 fs-xs">
                  <span className="muted truncate">{attempt.source}</span>
                  <span className="faint mono truncate" title={attempt.error}>
                    {attempt.error}
                    {attempt.statusCode ? `（HTTP ${attempt.statusCode}）` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="row gap-2 wrap" style={{ marginTop: 12 }}>
            {result.repo && result.repo.includes('/') ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<IconExternal size={13} />}
                onClick={() => openRelease(`https://github.com/${result.repo}/releases`)}
              >
                手动打开 Release 页面
              </Button>
            ) : null}
            <Button size="sm" icon={<IconRefresh size={13} />} loading={checking} onClick={() => void check()}>
              重新检查
            </Button>
          </div>

          <div className="fs-xs faint" style={{ marginTop: 10, lineHeight: 'var(--lh-relaxed)' }}>
            换一条镜像线路、改成直连 GitHub，或按上面列出的失败原因处理后再试；「仓库还没有发布 Release」属于正常状态，发布后会自动提示。
          </div>
        </Card>
      ) : null}
    </div>
  )
}
