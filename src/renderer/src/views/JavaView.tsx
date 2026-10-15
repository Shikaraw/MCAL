/**
 * Java 环境管理页
 *   已安装运行时（重新扫描 / 复制路径 / 定位文件）
 *   兼容性对照（MC 版本 → 需要的 Java，标出本机缺哪个）
 *   自动下载安装（Mojang 官方 / Adoptium，下载到启动器数据目录，不污染系统）
 *   手动添加（选择 java 可执行文件，供实例设置里选用）
 *
 * 说明：Java 下载在下载引擎里运行，主进程尚未把它注册成 TaskManager 任务，
 * 因此这里用「不定量进度 + 已耗时」表达长任务状态，安装期间禁止重复点击。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JavaInstallCandidate, JavaRuntimeInfo, SystemInfo } from '@shared/types'
import { mcal } from '../lib/api'
import { formatBytes } from '../lib/format'
import { reportError, toast, useInstances, useSystem, useView } from '../state/store'
import {
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  Field,
  Modal,
  Progress,
  Segmented,
  Tooltip
} from '../components/ui/primitives'
import {
  IconAlert,
  IconCheck,
  IconCoffee,
  IconDownload,
  IconExternal,
  IconFolder,
  IconGauge,
  IconInfo,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconSparkles
} from '../components/ui/icons'

type JavaSource = 'auto' | 'mojang' | 'adoptium'

const MAJOR_CHOICES = [8, 17, 21]

/** 常见 MC 版本与 Java 的对应关系 */
const JAVA_MATRIX: { range: string; java: number; examples: string; note: string }[] = [
  {
    range: '1.16.5 及更早',
    java: 8,
    examples: '1.7.10 / 1.12.2 / 1.16.5',
    note: '大量经典整合包都在这个区间，必须用 Java 8'
  },
  {
    range: '1.17 ~ 1.20.4',
    java: 17,
    examples: '1.19.2 / 1.20.1',
    note: '1.17 开始 Mojang 要求 Java 16+，社区主流是 Java 17'
  },
  {
    range: '1.20.5 及更新',
    java: 21,
    examples: '1.21 / 1.21.4',
    note: '1.20.5 起要求 Java 21，用旧 Java 会直接报 UnsupportedClassVersionError'
  }
]

function vendorLabel(runtime: JavaRuntimeInfo): string {
  if (runtime.vendor) return runtime.vendor
  if (runtime.component) return `Mojang ${runtime.component}`
  return '未知发行版'
}

function archLabel(runtime: JavaRuntimeInfo): string {
  if (runtime.is64Bit === false) return '32 位'
  if (runtime.arch === 'x86') return '32 位'
  if (runtime.arch === 'arm64') return 'ARM64'
  if (runtime.arch === 'arm32') return 'ARM32'
  return '64 位'
}

function sourceLabel(source: JavaInstallCandidate['source']): string {
  switch (source) {
    case 'mojang':
      return 'Mojang 官方'
    case 'adoptium':
      return 'Adoptium Temurin'
    case 'zulu':
      return 'Zulu'
    default:
      return '自定义'
  }
}

function candidateArchLabel(candidate: JavaInstallCandidate): string {
  if (candidate.arch === 'x64') return '64 位'
  if (candidate.arch === 'x86') return '32 位'
  return candidate.arch
}

async function copyText(text: string, label = '路径'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.ok(`${label}已复制`)
  } catch {
    toast.warn('复制失败', '系统剪贴板不可用，请手动选择复制')
  }
}

export function JavaView(): React.JSX.Element {
  const java = useInstances((state) => state.java)
  const refresh = useInstances((state) => state.refresh)
  const systemInfo: SystemInfo | null = useSystem((state) => state.info)
  const navigate = useView((state) => state.navigate)

  const [scanning, setScanning] = useState(false)
  const [major, setMajor] = useState(21)
  const [source, setSource] = useState<JavaSource>('auto')
  const [candidates, setCandidates] = useState<JavaInstallCandidate[] | null>(null)
  const [querying, setQuerying] = useState(false)
  const [candidateError, setCandidateError] = useState<string | null>(null)
  const [confirmCandidate, setConfirmCandidate] = useState<JavaInstallCandidate | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [manualPath, setManualPath] = useState<string | null>(null)

  const downloadRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!installingId) {
      setElapsed(0)
      return
    }
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [installingId])

  const installedMajors = useMemo(() => new Set(java.map((runtime) => runtime.majorVersion)), [java])

  const rescan = async (refreshScan: boolean): Promise<void> => {
    setScanning(true)
    try {
      const list = await mcal.listJava(refreshScan)
      await refresh()
      toast.ok(`检测到 ${list.length} 个 Java 运行时`, refreshScan ? '已完成全盘重新扫描' : undefined)
    } catch (error) {
      reportError(error, '扫描 Java 失败')
    } finally {
      setScanning(false)
    }
  }

  const queryCandidates = async (): Promise<void> => {
    setQuerying(true)
    setCandidateError(null)
    try {
      // 运行时的候选接口支持 source（auto / mojang / adoptium），类型声明里没有写全，这里按运行时能力传入
      const opts: { majorVersion: number; source: JavaSource } = { majorVersion: major, source }
      const list = await mcal.javaCandidates(opts)
      setCandidates(list)
      if (list.length === 0) {
        toast.info('没有查到可下载的 Java', '换一个主版本或来源再试')
      }
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : String(error))
      reportError(error, '获取 Java 下载列表失败')
    } finally {
      setQuerying(false)
    }
  }

  const install = async (candidate: JavaInstallCandidate): Promise<void> => {
    setConfirmCandidate(null)
    setInstallingId(candidate.id)
    try {
      const installed = await mcal.installJava(candidate)
      toast.ok(`Java ${installed.majorVersion} 安装完成`, `${vendorLabel(installed)} · ${installed.path}`)
      setCandidates((prev) => prev?.filter((item) => item.id !== candidate.id) ?? prev)
      await refresh()
    } catch (error) {
      reportError(error, '安装 Java 失败')
    } finally {
      setInstallingId(null)
    }
  }

  const pickManualJava = async (): Promise<void> => {
    try {
      const files = await mcal.pickFile({
        title: '选择 java 可执行文件',
        filters: [
          { name: 'Java 可执行文件', extensions: ['exe'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      const path = files?.[0]
      if (!path) return
      setManualPath(path)
      toast.ok('已记录手动添加的 Java', '该路径会作为可选项出现在实例的 Java 设置里')
    } catch (error) {
      reportError(error, '选择文件失败')
    }
  }

  const jumpToDownload = (targetMajor: number): void => {
    setMajor(targetMajor)
    setCandidates(null)
    downloadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const installingCandidate = candidates?.find((item) => item.id === installingId) ?? null

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>Java 环境</h2>
          <span className="fs-sm muted">
            检测到 {java.length} 个运行时
            {systemInfo ? ` · 物理内存 ${formatBytes(systemInfo.totalMemoryMB * 1024 * 1024, 0)}` : ''}
          </span>
        </div>
        <div className="row gap-2">
          <Button icon={<IconPlus size={14} />} onClick={() => void pickManualJava()}>
            手动添加
          </Button>
          <Button variant="primary" icon={<IconRefresh size={14} />} loading={scanning} onClick={() => void rescan(true)}>
            重新扫描
          </Button>
        </div>
      </div>

      <div className="page__body">
        <div className="col gap-4">
          {/* ------------------------------ 一句话解释 ------------------------------ */}
          <Card padding={16}>
            <div className="row-start gap-3">
              <IconCoffee size={18} className="accent" style={{ flexShrink: 0, marginTop: 2 }} />
              <div className="col gap-1">
                <span className="fs-sm bold">为什么 Minecraft 需要 Java？</span>
                <span className="fs-sm muted">
                  Minecraft（Java 版）本身就是用 Java 写的程序，启动器需要调用一个 Java 运行时来运行它。
                  版本必须与游戏匹配：用错版本会看到
                  <span className="mono"> UnsupportedClassVersionError</span>（例如用 Java 8 启动 1.20.1），
                  或者卡在启动画面无响应。装了多个 Java 不会互相冲突，启动器会按实例的版本自动选择。
                </span>
              </div>
            </div>
          </Card>

          {/* ------------------------------ 已安装运行时 ------------------------------ */}
          <Card padding={18}>
            <div className="row-between gap-3 wrap" style={{ marginBottom: 14 }}>
              <div className="row gap-2">
                <IconCoffee size={16} className="accent" />
                <span className="fs-md bold">已检测到的 Java 运行时</span>
                <Badge>{java.length} 个</Badge>
              </div>
              <Button size="sm" icon={<IconRefresh size={13} />} loading={scanning} onClick={() => void rescan(false)}>
                快速重扫
              </Button>
            </div>

            {java.length === 0 ? (
              <Empty
                icon={<IconAlert />}
                title="没有检测到任何 Java"
                description="游戏无法在这个状态下启动。可以从下面的列表自动下载一个（不会污染系统：文件都放在启动器数据目录），也可以手动指定已有的 java 可执行文件。"
                action={
                  <div className="row gap-3 wrap" style={{ marginTop: 8 }}>
                    <Button variant="primary" icon={<IconDownload size={14} />} onClick={() => jumpToDownload(21)}>
                      下载 Java 21
                    </Button>
                    <Button icon={<IconPlus size={14} />} onClick={() => void pickManualJava()}>
                      手动指定 Java
                    </Button>
                  </div>
                }
              />
            ) : (
              <div className="mcal-list stagger">
                {java.map((runtime) => (
                  <div key={runtime.path} className="mcal-list__row">
                    <div
                      className="mono accent bold"
                      style={{ fontSize: 26, lineHeight: 1, minWidth: 56, textAlign: 'center', flexShrink: 0 }}
                    >
                      {runtime.majorVersion}
                    </div>
                    <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                      <div className="row gap-2 wrap">
                        <span className="fs-sm bold">{vendorLabel(runtime)}</span>
                        <Badge tone="info">{archLabel(runtime)}</Badge>
                        {runtime.managed ? <Badge tone="violet">启动器安装</Badge> : null}
                        {runtime.error ? <Badge tone="err">探测失败</Badge> : null}
                      </div>
                      <div className="fs-xs muted">
                        完整版本：<span className="mono">{runtime.version ?? '未知'}</span>
                        {runtime.os ? ` · ${runtime.os}` : ''}
                      </div>
                      <div className="mono fs-xs faint truncate" title={runtime.path}>
                        {runtime.path}
                      </div>
                      {runtime.error ? <div className="fs-xs err">{runtime.error}</div> : null}
                    </div>
                    <div className="row gap-2" style={{ flexShrink: 0 }}>
                      <Tooltip content="复制 java 可执行文件路径（可以在实例设置里手动指定）">
                        <Button
                          size="sm"
                          icon={<IconLayers size={13} />}
                          onClick={() => void copyText(runtime.path, 'Java 路径')}
                        >
                          复制路径
                        </Button>
                      </Tooltip>
                      <Tooltip content="在资源管理器中定位这个 java 文件">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<IconExternal size={13} />}
                          title="定位文件"
                          onClick={() => void mcal.revealPath(runtime.path).catch((error) => reportError(error, '打开失败'))}
                        />
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ------------------------------ 兼容性对照 ------------------------------ */}
          <Card padding={18}>
            <div className="row gap-2" style={{ marginBottom: 14 }}>
              <IconGauge size={16} className="accent" />
              <span className="fs-md bold">兼容性对照</span>
              <span className="fs-xs muted">标出本机缺哪个版本 —— 多版本玩家最常踩的坑</span>
            </div>
            <div className="col gap-2">
              {JAVA_MATRIX.map((row) => {
                const ready = installedMajors.has(row.java)
                return (
                  <div key={row.range} className="mcal-list__row">
                    <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                      <div className="row gap-2 wrap">
                        <span className="fs-sm bold">{row.range}</span>
                        <Badge tone={ready ? 'ok' : 'err'}>
                          {ready ? `Java ${row.java} 已就绪` : `缺少 Java ${row.java}`}
                        </Badge>
                      </div>
                      <div className="fs-xs muted">{row.note}</div>
                      <div className="mono fs-xs faint">{row.examples}</div>
                    </div>
                    {ready ? (
                      <div className="row gap-2 fs-xs ok" style={{ flexShrink: 0 }}>
                        <IconCheck size={14} />
                        可用
                      </div>
                    ) : (
                      <Button size="sm" variant="primary" icon={<IconDownload size={13} />} onClick={() => jumpToDownload(row.java)}>
                        去下载 Java {row.java}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>

          {/* ------------------------------ 自动下载安装 ------------------------------ */}
          <div ref={downloadRef}>
            <Card padding={18}>
              <div className="row gap-2" style={{ marginBottom: 14 }}>
                <IconDownload size={16} className="accent" />
                <span className="fs-md bold">自动下载安装</span>
                <span className="fs-xs muted">下载到启动器数据目录，不污染系统环境</span>
              </div>

              <div className="col gap-4">
                <Field label="Java 主版本">
                  <div className="row gap-2 wrap">
                    {MAJOR_CHOICES.map((choice) => (
                      <Chip
                        key={choice}
                        active={major === choice}
                        onClick={() => {
                          setMajor(choice)
                          setCandidates(null)
                        }}
                        title={installedMajors.has(choice) ? '本机已检测到该主版本' : '本机还没有这个主版本'}
                      >
                        Java {choice}
                        {installedMajors.has(choice) ? <IconCheck size={11} /> : null}
                      </Chip>
                    ))}
                  </div>
                </Field>

                <Field label="下载来源" hint="Mojang 官方是游戏同款运行时；Adoptium Temurin 获取速度快、长期支持">
                  <div className="row gap-3 wrap">
                    <Segmented
                      value={source}
                      onChange={(value) => {
                        setSource(value)
                        setCandidates(null)
                      }}
                      options={[
                        { value: 'auto', label: '自动（优先 Mojang）' },
                        { value: 'mojang', label: 'Mojang 官方' },
                        { value: 'adoptium', label: 'Adoptium Temurin' }
                      ]}
                    />
                    <Button variant="primary" loading={querying} onClick={() => void queryCandidates()}>
                      查询可下载版本
                    </Button>
                  </div>
                </Field>

                {installingId ? (
                  <div className="mcal-panel col gap-2 anim-fade" style={{ padding: 14 }}>
                    <div className="row-between gap-3">
                      <div className="row gap-2">
                        <span className="mcal-spinner accent" />
                        <span className="fs-sm bold">
                          正在下载并安装 Java {installingCandidate?.majorVersion ?? major}
                          {installingCandidate?.vendor ? `（${installingCandidate.vendor}）` : ''}
                        </span>
                      </div>
                      <span className="fs-xs muted mono">已耗时 {elapsed} 秒</span>
                    </div>
                    <Progress indeterminate />
                    <div className="fs-xs muted">
                      运行时约 {installingCandidate?.size ? formatBytes(installingCandidate.size) : '几百 MB'}
                      ，包含下载与解压两步，网速一般时需要几分钟。文件会安装到启动器数据目录，不会修改系统环境变量，
                      也不需要管理员权限。
                    </div>
                  </div>
                ) : null}

                {candidates === null ? (
                  <div className="fs-sm muted">
                    选择主版本与来源后点击「查询可下载版本」。安装完成后，新运行时会自动出现在上方的列表里，可以立即给实例使用。
                  </div>
                ) : candidates.length === 0 ? (
                  <Empty
                    icon={<IconAlert />}
                    title="没有查到可下载的 Java"
                    description={
                      candidateError
                        ? `${candidateError}。可以换一个来源（例如 Adoptium）或主版本再试。`
                        : '可以换一个来源（例如 Adoptium）或主版本再试。'
                    }
                  />
                ) : (
                  <div className="mcal-list stagger">
                    {candidates.map((candidate) => {
                      const busy = installingId === candidate.id
                      return (
                        <div key={candidate.id} className="mcal-list__row">
                          <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                            <div className="row gap-2 wrap">
                              <span className="fs-sm bold">
                                Java {candidate.majorVersion} · {candidate.vendor}
                              </span>
                              <Badge tone={candidate.source === 'mojang' ? 'info' : 'violet'}>
                                {sourceLabel(candidate.source)}
                              </Badge>
                              <Badge>{candidateArchLabel(candidate)}</Badge>
                              {installedMajors.has(candidate.majorVersion) ? <Badge tone="warn">本机已有该主版本</Badge> : null}
                            </div>
                            <div className="row gap-3 wrap fs-xs muted">
                              <span className="mono">{candidate.version}</span>
                              <span>{candidate.os}</span>
                              <span>{candidate.size ? formatBytes(candidate.size) : '大小未知'}</span>
                              <span className="faint">安装为 {candidate.dirName}</span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="primary"
                            icon={<IconDownload size={13} />}
                            loading={busy}
                            disabled={installingId !== null && !busy}
                            onClick={() => setConfirmCandidate(candidate)}
                          >
                            {busy ? '安装中…' : '安装'}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* ------------------------------ 手动添加 ------------------------------ */}
          <Card padding={18}>
            <div className="row gap-2" style={{ marginBottom: 14 }}>
              <IconPlus size={16} className="accent" />
              <span className="fs-md bold">手动添加</span>
              <span className="fs-xs muted">已经装过 Java？直接指向它的 java.exe 即可</span>
            </div>
            <div className="col gap-3">
              <div className="row gap-2">
                <Button icon={<IconFolder size={14} />} onClick={() => void pickManualJava()}>
                  选择 java 可执行文件
                </Button>
                {manualPath ? (
                  <Button icon={<IconLayers size={14} />} onClick={() => void copyText(manualPath, 'Java 路径')}>
                    复制路径
                  </Button>
                ) : null}
              </div>
              {manualPath ? (
                <div className="mcal-panel col gap-2 anim-fade" style={{ padding: 12 }}>
                  <div className="row gap-2">
                    <Badge tone="ok">已记录</Badge>
                    <span className="fs-xs muted">
                      该路径会作为候选项出现在「实例管理 → Java 设置」里，无需重新扫描即可直接选用
                    </span>
                  </div>
                  <div className="mono fs-xs break-all">{manualPath}</div>
                  <div className="row gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconExternal size={13} />}
                      onClick={() => void mcal.revealPath(manualPath as string).catch((error) => reportError(error, '打开失败'))}
                    >
                      在资源管理器中显示
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setManualPath(null)}>
                      清除记录
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="row-start gap-2 fs-xs muted">
                  <IconInfo size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    常见位置：<span className="mono">C:\Program Files\Java\jdk-17\bin\java.exe</span>、
                    <span className="mono"> C:\Program Files\Eclipse Adoptium\jre-17\bin\java.exe</span>。
                    也可以直接把路径粘贴到实例的 Java 设置里。
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* ------------------------------ 给 AI 的入口 ------------------------------ */}
          <Card padding={16}>
            <div className="row-between gap-3 wrap">
              <div className="row-start gap-3">
                <IconSparkles size={16} className="accent" style={{ flexShrink: 0, marginTop: 2 }} />
                <div className="col gap-1">
                  <span className="fs-sm bold">Java 问题交给 AI 排查</span>
                  <span className="fs-xs muted">
                    启动报 UnsupportedClassVersionError、内存不足崩溃或其他环境问题，都可以让 AI 读取日志给出结论。
                  </span>
                </div>
              </div>
              <Button
                variant="primary"
                icon={<IconSparkles size={14} />}
                onClick={() =>
                  navigate('agent', {
                    prompt:
                      '请帮我检查当前电脑的 Java 环境：列出已检测到的 Java 版本与路径，判断每个 Minecraft 实例需要的 Java 版本是否满足，指出缺少哪个版本并给出安装建议（可以用启动器的 Java 页面自动下载）。'
                  })
                }
              >
                让 AI 检查 Java 环境
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={confirmCandidate !== null}
        onClose={() => setConfirmCandidate(null)}
        title="确认下载安装 Java"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCandidate(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={<IconDownload size={14} />}
              onClick={() => confirmCandidate && void install(confirmCandidate)}
            >
              开始下载
            </Button>
          </>
        }
      >
        {confirmCandidate ? (
          <div className="col gap-3">
            <div className="mcal-panel col gap-2" style={{ padding: 12 }}>
              <div className="row-between fs-sm">
                <span className="muted">发行版</span>
                <span>
                  {confirmCandidate.vendor}（Java {confirmCandidate.majorVersion}）
                </span>
              </div>
              <div className="row-between fs-sm">
                <span className="muted">版本</span>
                <span className="mono">{confirmCandidate.version}</span>
              </div>
              <div className="row-between fs-sm">
                <span className="muted">架构</span>
                <span>{candidateArchLabel(confirmCandidate)}</span>
              </div>
              <div className="row-between fs-sm">
                <span className="muted">体积</span>
                <span>{confirmCandidate.size ? formatBytes(confirmCandidate.size) : '未知'}</span>
              </div>
            </div>
            <div className="fs-xs muted">
              安装位置：启动器数据目录下的运行时文件夹（{confirmCandidate.dirName}）。不会写入系统环境变量，也不会影响其他软件使用的
              Java，卸载时直接删除该目录即可。
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
