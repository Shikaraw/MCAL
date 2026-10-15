/**
 * 整合包导入导出页
 *   导入：选择 / 拖入 .zip / .mrpack → 预览清单 → 选目录 → 导入（长任务，显示日志与进度，可取消）
 *   导出：选实例 → 选格式 → 导出（产物路径可一键定位）
 *
 * 说明：主进程的导入导出都会创建任务（kind: import-modpack / export-modpack），
 * 进度与日志通过 useTasks().tasks 实时展示，无需自己轮询。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Instance, ModpackManifest, TaskState } from '@shared/types'
import { mcal } from '../lib/api'
import { formatBytes, formatNumber, loaderLabel } from '../lib/format'
import { reportError, toast, useInstances, useSettings, useTasks, useView } from '../state/store'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Progress,
  Segmented,
  Select,
  Switch,
  Tooltip
} from '../components/ui/primitives'
import {
  IconAlert,
  IconBook,
  IconBox,
  IconCheck,
  IconDownload,
  IconExternal,
  IconFile,
  IconFolder,
  IconLayers,
  IconRefresh,
  IconSparkles,
  IconTrash
} from '../components/ui/icons'

/* ------------------------------ 类型与工具 ------------------------------ */

/** 主进程返回的导入结果（api.ts 的声明与实际略有出入，这里按运行时字段读取） */
interface ModpackInstallResultLike {
  instanceDir?: string
  name?: string
  gameVersion?: string
  loaderType?: string
  loaderVersion?: string
  installedFiles?: string[]
  skippedFiles?: { path: string; reason: string }[]
  failedFiles?: { path: string; reason: string }[]
  warnings?: string[]
  manualDownloads?: { fileName: string; projectId?: string; url?: string }[]
}

interface ModpackImportOutcome {
  instanceId?: string
  result?: ModpackInstallResultLike
  /** 兼容直接返回实例的情况 */
  id?: string
  name?: string
}

type ExportFormat = 'modrinth' | 'mcal' | 'curseforge'

const FORMATS: { value: ExportFormat; name: string; badge: string; summary: string; detail: string; icon: React.ReactNode }[] = [
  {
    value: 'modrinth',
    name: 'Modrinth 格式（推荐）',
    badge: '通用性最好',
    summary: '只记录每个 mod 的下载地址与校验值，不打包 mod 文件本身，体积小巧。',
    detail:
      '其他 Modrinth / 支持 .mrpack 的启动器都能直接导入。缺点：接收方需要联网重新下载，遇到已下架的 mod 可能失败。分享给朋友首选这个格式。',
    icon: <IconSparkles size={15} />
  },
  {
    value: 'mcal',
    name: 'MCAL 格式',
    badge: '完整备份',
    summary: '把 mods、配置等文件完整打包进压缩包，离线也能还原。',
    detail:
      '最适合自己备份或整机迁移：即使原下载链接失效也能完整恢复。缺点是包体积大（等于整个内容目录）。注意不要分发包含未授权 mod 的包。',
    icon: <IconLayers size={15} />
  },
  {
    value: 'curseforge',
    name: 'CurseForge 格式',
    badge: '兼容 CF 启动器',
    summary: '生成 CurseForge 启动器可识别的 manifest.json，需要 API Key 才能自动下载。',
    detail:
      '面向 CurseForge 生态：对方用 CurseForge 启动器可以导入。但自动下载依赖 CurseForge API Key；没有 Key 时会给出需要手动下载的 mod 清单。',
    icon: <IconBox size={15} />
  }
]

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function latestTask(tasks: TaskState[], kind: string): TaskState | undefined {
  return tasks
    .filter((task) => task.kind === kind)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
}

async function copyText(text: string, label = '路径'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.ok(`${label}已复制`)
  } catch {
    toast.warn('复制失败', '系统剪贴板不可用，请手动选择复制')
  }
}

/* ------------------------------ 页面 ------------------------------ */

export function ModpackView(): React.JSX.Element {
  const settings = useSettings((state) => state.settings)
  const instances = useInstances((state) => state.instances)
  const activeInstanceId = useInstances((state) => state.activeInstanceId)
  const refreshInstances = useInstances((state) => state.refresh)
  const tasks = useTasks((state) => state.tasks)
  const navigate = useView((state) => state.navigate)

  /* -------- 导入状态 -------- */
  const [file, setFile] = useState<string | null>(null)
  const [manifest, setManifest] = useState<ModpackManifest | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [targetDir, setTargetDir] = useState('')
  const [packName, setPackName] = useState('')
  const [importing, setImporting] = useState(false)
  const [importOutcome, setImportOutcome] = useState<ModpackImportOutcome | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragTimer = useRef<number | null>(null)

  /* -------- 导出状态 -------- */
  const [exportInstanceId, setExportInstanceId] = useState(activeInstanceId ?? instances[0]?.id ?? '')
  const [format, setFormat] = useState<ExportFormat>('modrinth')
  const [includeSaves, setIncludeSaves] = useState(false)
  const [includeConfig, setIncludeConfig] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<{ file: string; fileCount: number } | null>(null)

  const importTask = useMemo(() => (importing ? latestTask(tasks, 'import-modpack') : undefined), [tasks, importing])
  const exportTask = useMemo(() => (exporting ? latestTask(tasks, 'export-modpack') : undefined), [tasks, exporting])

  useEffect(() => {
    if (!exportInstanceId && activeInstanceId) setExportInstanceId(activeInstanceId)
  }, [activeInstanceId, exportInstanceId])

  const inspect = useCallback(async (path: string): Promise<void> => {
    setFile(path)
    setManifest(null)
    setImportOutcome(null)
    setInspecting(true)
    try {
      const found = await mcal.inspectModpack(path)
      if (!found) {
        toast.warn('无法识别这个整合包', '请确认是有效的 .zip / .mrpack 文件')
        return
      }
      setManifest(found)
      setPackName(found.name ?? '')
      setTargetDir((current) => current || settings?.defaultGameDir || '')
      toast.ok('已读取整合包清单', `${found.name ?? baseName(path)}（${found.format} 格式）`)
    } catch (error) {
      reportError(error, '读取整合包失败')
    } finally {
      setInspecting(false)
    }
  }, [settings?.defaultGameDir])

  const pickFile = async (): Promise<void> => {
    try {
      const files = await mcal.pickFile({
        title: '选择整合包文件',
        filters: [
          { name: '整合包', extensions: ['zip', 'mrpack'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      const path = files?.[0]
      if (!path) return
      await inspect(path)
    } catch (error) {
      reportError(error, '选择文件失败')
    }
  }

  const pickTargetDir = async (): Promise<void> => {
    try {
      const dir = await mcal.pickDir({ title: '选择整合包安装位置', defaultPath: targetDir || settings?.defaultGameDir })
      if (dir) setTargetDir(dir)
    } catch (error) {
      reportError(error, '选择目录失败')
    }
  }

  const startImport = async (): Promise<void> => {
    if (!file) {
      toast.warn('请先选择整合包文件')
      return
    }
    if (!targetDir.trim()) {
      toast.warn('请选择安装位置', '整合包会解压到这个目录，并注册为实例')
      return
    }
    setImporting(true)
    setImportOutcome(null)
    try {
      const outcome = (await mcal.importModpack({
        file,
        targetDir: targetDir.trim(),
        name: packName.trim() || undefined
      })) as unknown as ModpackImportOutcome | null
      if (!outcome) {
        toast.info('已取消导入')
        return
      }
      const result = outcome.result ?? {}
      const failed = result.failedFiles?.length ?? 0
      const installed = result.installedFiles?.length ?? 0
      if (failed > 0) {
        toast.warn(
          `导入完成，但有 ${failed} 个文件失败`,
          `成功 ${installed} 个。${result.warnings?.[0] ?? '请查看下方的失败清单手动补齐。'}`
        )
      } else {
        toast.ok(`整合包导入完成`, `已安装 ${installed} 个文件，实例正在创建`)
      }
      setImportOutcome(outcome)
      await refreshInstances()
    } catch (error) {
      reportError(error, '导入整合包失败')
      toast.info('可以重试或换个下载源', '网络不稳时下载失败的 mod 会列在失败清单里，可稍后重新导入补齐')
    } finally {
      setImporting(false)
    }
  }

  const startExport = async (): Promise<void> => {
    const instance = instances.find((item) => item.id === exportInstanceId)
    if (!instance) {
      toast.warn('请先选择要导出的实例')
      return
    }
    setExporting(true)
    setExportResult(null)
    try {
      // outFile 传空字符串：主进程会弹出系统保存对话框
      const payload: {
        instanceId: string
        outFile: string
        includeSaves: boolean
        includeConfig: boolean
        format?: string
      } = { instanceId: instance.id, outFile: '', includeSaves, includeConfig, format }
      const raw = (await mcal.exportModpack(payload)) as unknown as { file?: string; fileCount?: number } | null
      if (!raw || !raw.file) {
        toast.info('已取消导出')
        return
      }
      setExportResult({ file: raw.file, fileCount: raw.fileCount ?? 0 })
      toast.ok('整合包导出完成', `共 ${raw.fileCount ?? 0} 个文件`)
      if (format !== 'modrinth') {
        toast.warn('当前导出的实际格式为 Modrinth', '后端暂未实现 MCAL / CurseForge 格式，已自动回退')
      }
    } catch (error) {
      reportError(error, '导出整合包失败')
    } finally {
      setExporting(false)
    }
  }

  const manualCount = useMemo(
    () => (manifest?.files ?? []).filter((item) => !(item.downloads?.length ?? 0) && !item.platform).length,
    [manifest]
  )

  return (
    <div
      className="page"
      style={{ position: 'relative' }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        // 400ms 内没有新的 dragover 事件就熄灭提示层，避免拖出窗口后残留
        if (dragTimer.current !== null) window.clearTimeout(dragTimer.current)
        dragTimer.current = window.setTimeout(() => setDragging(false), 400)
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        if (dragTimer.current !== null) window.clearTimeout(dragTimer.current)
        setDragging(false)
        const paths = Array.from(event.dataTransfer.files)
          .map((dropped) => (dropped as File & { path?: string }).path)
          .filter((path): path is string => Boolean(path))
        if (paths.length === 0) {
          toast.warn('无法读取拖入的文件路径', '请改用「选择整合包文件」按钮')
          return
        }
        const candidate = paths.find((path) => /\.(zip|mrpack)$/i.test(path))
        if (!candidate) {
          toast.warn('只支持 .zip / .mrpack 整合包', paths.slice(0, 3).map(baseName).join('、'))
          return
        }
        void inspect(candidate)
      }}
    >
      <div className="page__header">
        <div className="page__title">
          <h2>整合包导入导出</h2>
          <span className="fs-sm muted">导入现成整合包，或把自己的实例打包分享 / 备份</span>
        </div>
        <div className="row gap-2">
          <Button variant="primary" icon={<IconFolder size={14} />} onClick={() => void pickFile()}>
            选择整合包文件
          </Button>
        </div>
      </div>

      <div className="page__body">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.15fr) minmax(320px, 1fr)',
            gap: 16,
            alignItems: 'start'
          }}
        >
          {/* ------------------------------ 导入 ------------------------------ */}
          <Card padding={18}>
            <div className="row gap-2" style={{ marginBottom: 14 }}>
              <IconDownload size={16} className="accent" />
              <span className="fs-md bold">导入整合包</span>
              <Badge tone="info">支持 .zip / .mrpack</Badge>
            </div>

            <div
              style={{
                border: `1.5px dashed ${dragging ? 'var(--c-verdant)' : 'var(--c-hairline-strong)'}`,
                borderRadius: 'var(--r-lg)',
                padding: 22,
                textAlign: 'center',
                background: dragging ? 'var(--c-verdant-glow)' : 'transparent',
                transition: 'all var(--t-base) var(--ease-out)'
              }}
            >
              <div className="col gap-2 center">
                <IconBox size={30} className={dragging ? 'accent' : 'muted'} />
                <div className="fs-sm">{file ? baseName(file) : '把 .zip / .mrpack 拖到这里'}</div>
                <div className="fs-xs muted">
                  {file
                    ? '已选中文件，确认清单后点击「开始导入」'
                    : '也可以点击右上角「选择整合包文件」；导入不会覆盖已存在的世界存档'}
                </div>
                {file ? (
                  <div className="row gap-2" style={{ marginTop: 6 }}>
                    <Button size="sm" loading={inspecting} onClick={() => void inspect(file)}>
                      重新解析清单
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setFile(null)
                        setManifest(null)
                        setImportOutcome(null)
                      }}
                    >
                      清除选择
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>

            {inspecting ? (
              <div className="col gap-2" style={{ marginTop: 14 }}>
                <div className="skeleton" style={{ height: 64 }} />
                <div className="fs-xs muted">正在解析整合包清单…</div>
              </div>
            ) : manifest ? (
              <div className="col gap-3" style={{ marginTop: 14 }}>
                <div className="mcal-panel col gap-3" style={{ padding: 14 }}>
                  <div className="row gap-2 wrap">
                    <span className="fs-md bold truncate">{manifest.name || baseName(file ?? '')}</span>
                    <Badge tone={manifest.format === 'modrinth' ? 'ok' : manifest.format === 'curseforge' ? 'gold' : 'info'}>
                      {manifest.format === 'modrinth'
                        ? 'Modrinth 格式'
                        : manifest.format === 'curseforge'
                          ? 'CurseForge 格式'
                          : manifest.format === 'mcal'
                            ? 'MCAL 格式'
                            : manifest.format}
                    </Badge>
                    {manifest.version ? <Badge>v{manifest.version}</Badge> : null}
                  </div>
                  {manifest.description ? <div className="fs-xs muted clamp-3">{manifest.description}</div> : null}
                  <div className="row gap-4 wrap fs-xs muted">
                    <span>作者：{manifest.author ?? '未知'}</span>
                    <span>游戏版本：{manifest.gameVersion ?? '未声明'}</span>
                    <span>加载器：{loaderLabel(manifest.loaderType)}</span>
                    <span>
                      文件数：<span className="mono">{formatNumber(manifest.files.length)}</span>
                    </span>
                    {manualCount > 0 ? (
                      <span className="warn">
                        需手动下载：<span className="mono">{manualCount}</span>
                      </span>
                    ) : null}
                  </div>
                  {manifest.files.length > 0 ? (
                    <div className="col gap-1" style={{ maxHeight: 140, overflowY: 'auto' }}>
                      {manifest.files.slice(0, 8).map((entry, index) => (
                        <div key={`${entry.path}-${index}`} className="row-between gap-2 fs-xs">
                          <span className="mono truncate" title={entry.path} style={{ maxWidth: 300 }}>
                            {entry.path}
                          </span>
                          <span className="muted" style={{ flexShrink: 0 }}>
                            {entry.fileSize ? formatBytes(entry.fileSize) : '—'}
                          </span>
                        </div>
                      ))}
                      {manifest.files.length > 8 ? (
                        <span className="fs-xs muted">…另有 {manifest.files.length - 8} 个文件</span>
                      ) : null}
                    </div>
                  ) : null}
                  {manualCount > 0 ? (
                    <div className="row-start gap-2 fs-xs warn">
                      <IconAlert size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        有 {manualCount} 个文件没有直链（常见于 CurseForge 缺少 API Key），导入后需要手动补齐，清单会在结果里列出。
                      </span>
                    </div>
                  ) : null}
                </div>

                <Field label="安装位置" hint="整合包会解压到这个目录，并自动注册为实例">
                  <div className="row gap-2">
                    <div className="grow">
                      <Input value={targetDir} onChange={setTargetDir} monospace placeholder={settings?.defaultGameDir ?? '选择目录'} />
                    </div>
                    <Button icon={<IconFolder size={14} />} onClick={() => void pickTargetDir()}>
                      选择
                    </Button>
                  </div>
                </Field>

                <Field label="实例名称" hint="留空则使用整合包自带的名称">
                  <Input value={packName} onChange={setPackName} placeholder={manifest.name ?? '整合包实例'} />
                </Field>

                <div className="row gap-2">
                  <Button
                    variant="primary"
                    icon={<IconDownload size={14} />}
                    loading={importing}
                    disabled={inspecting}
                    onClick={() => void startImport()}
                  >
                    {importing ? '导入中…' : '开始导入'}
                  </Button>
                  {importOutcome ? (
                    <Button variant="ghost" icon={<IconRefresh size={14} />} onClick={() => void refreshInstances()}>
                      刷新实例列表
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="col gap-2" style={{ marginTop: 14 }}>
                <div className="fs-xs muted">
                  导入流程：解析清单 → 下载（或复制）文件 → 覆盖 overrides 配置 → 创建实例。整个过程都可以取消，失败的文件会列出来。
                </div>
              </div>
            )}

            {importing && importTask ? (
              <div style={{ marginTop: 14 }}>
                <LiveTask
                  task={importTask}
                  label="正在导入整合包"
                  onCancel={() => void mcal.cancelTask(importTask.taskId)}
                />
              </div>
            ) : null}

            {importOutcome ? <ImportResultPanel outcome={importOutcome} onGoInstances={() => navigate('instances')} /> : null}
          </Card>

          {/* ------------------------------ 导出 ------------------------------ */}
          <Card padding={18}>
            <div className="row gap-2" style={{ marginBottom: 14 }}>
              <IconBox size={16} className="accent" />
              <span className="fs-md bold">导出整合包</span>
            </div>

            <div className="col gap-4">
              <Field label="选择实例" hint="导出会打包该实例目录里的 mods、配置等内容">
                <Select
                  value={exportInstanceId}
                  onChange={setExportInstanceId}
                  options={
                    instances.length === 0
                      ? [{ value: '', label: '还没有实例' }]
                      : instances.map((item: Instance) => ({
                          value: item.id,
                          label: `${item.name}（${item.versionId}，${loaderLabel(item.loaderType)}）`
                        }))
                  }
                />
              </Field>

              <Field label="导出格式" hint="三种格式的区别见下方说明卡片">
                <div className="col gap-2">
                  <Segmented
                    value={format}
                    onChange={setFormat}
                    options={[
                      { value: 'modrinth', label: 'Modrinth（推荐）' },
                      { value: 'mcal', label: 'MCAL' },
                      { value: 'curseforge', label: 'CurseForge' }
                    ]}
                  />
                  <div className="row-start gap-2 fs-xs muted">
                    <Tooltip content={FORMATS.find((item) => item.value === format)?.detail ?? ''}>
                      <span className="row gap-1 accent" style={{ cursor: 'help' }}>
                        <IconBook size={12} />
                        这种格式是什么？
                      </span>
                    </Tooltip>
                    <span>{FORMATS.find((item) => item.value === format)?.summary}</span>
                  </div>
                </div>
              </Field>

              <div className="col gap-3">
                <div className="row-between gap-3">
                  <div className="col gap-1">
                    <span className="fs-sm">包含存档（saves）</span>
                    <span className="fs-xs muted">体积可能很大，分享给他人时请注意隐私</span>
                  </div>
                  <Switch checked={includeSaves} onChange={setIncludeSaves} label="包含存档" />
                </div>
                <div className="row-between gap-3">
                  <div className="col gap-1">
                    <span className="fs-sm">包含配置（config）</span>
                    <span className="fs-xs muted">保留按键、画质与 mod 配置，建议勾选</span>
                  </div>
                  <Switch checked={includeConfig} onChange={setIncludeConfig} label="包含配置" />
                </div>
              </div>

              <div className="row gap-2">
                <Button
                  variant="primary"
                  icon={<IconDownload size={14} />}
                  loading={exporting}
                  disabled={!exportInstanceId}
                  onClick={() => void startExport()}
                >
                  {exporting ? '导出中…' : '导出整合包'}
                </Button>
                {exportResult ? (
                  <Button
                    icon={<IconFolder size={14} />}
                    onClick={() => void mcal.revealPath(exportResult.file).catch((error) => reportError(error, '打开失败'))}
                  >
                    打开所在文件夹
                  </Button>
                ) : null}
              </div>

              <div className="fs-xs muted">点击导出后会弹出保存对话框，可以选择保存位置与文件名。</div>

              {exporting && exportTask ? (
                <LiveTask task={exportTask} label="正在导出整合包" onCancel={() => void mcal.cancelTask(exportTask.taskId)} />
              ) : null}

              {exportResult ? (
                <div className="mcal-panel col gap-2 anim-rise" style={{ padding: 12 }}>
                  <div className="row gap-2">
                    <Badge tone="ok">导出完成</Badge>
                    <span className="fs-xs muted">
                      共 <span className="mono">{exportResult.fileCount}</span> 个文件
                    </span>
                  </div>
                  <div className="mono fs-xs break-all">{exportResult.file}</div>
                  <div className="row gap-2">
                    <Button size="sm" icon={<IconFolder size={13} />} onClick={() => void copyText(exportResult.file, '导出路径')}>
                      复制路径
                    </Button>
                    <Button
                      size="sm"
                      icon={<IconExternal size={13} />}
                      onClick={() => void mcal.revealPath(exportResult.file).catch((error) => reportError(error, '打开失败'))}
                    >
                      在资源管理器中显示
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        {/* ------------------------------ 格式说明 ------------------------------ */}
        <div style={{ marginTop: 16 }}>
          <Card padding={18}>
            <div className="row gap-2" style={{ marginBottom: 14 }}>
              <IconBook size={16} className="accent" />
              <span className="fs-md bold">三种格式怎么选？</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
              {FORMATS.map((item) => (
                <div key={item.value} className="mcal-panel col gap-2" style={{ padding: 14 }}>
                  <div className="row gap-2">
                    <span className="accent">{item.icon}</span>
                    <span className="fs-sm bold">{item.name}</span>
                    <Badge tone={item.value === 'modrinth' ? 'ok' : 'default'}>{item.badge}</Badge>
                  </div>
                  <div className="fs-xs dim">{item.summary}</div>
                  <div className="fs-xs muted">{item.detail}</div>
                </div>
              ))}
            </div>
            <div className="row-start gap-2" style={{ marginTop: 14 }}>
              <IconAlert size={13} className="warn" style={{ flexShrink: 0, marginTop: 2 }} />
              <span className="fs-xs muted">
                版权提醒：导出包只应包含你有权分发的文件。请不要公开分享未获授权的付费 / 闭源模组，Modrinth
                格式只记录下载地址、不打包模组文件，是最安全的分享方式。
              </span>
            </div>
          </Card>
        </div>
      </div>

      {dragging ? (
        <div className="mcal-overlay">
          <div
            className="col gap-2 center"
            style={{
              border: '2px dashed var(--c-verdant)',
              borderRadius: 'var(--r-lg)',
              background: 'var(--c-obsidian)',
              padding: '44px 60px'
            }}
          >
            <IconBox size={36} className="accent" />
            <div className="fs-lg bold">松手开始解析整合包</div>
            <div className="fs-sm muted">支持 .zip 与 .mrpack，解析后可以确认清单再导入</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------ 导入结果 ------------------------------ */

function ImportResultPanel({
  outcome,
  onGoInstances
}: {
  outcome: ModpackImportOutcome
  onGoInstances: () => void
}): React.JSX.Element {
  const [showAllFailed, setShowAllFailed] = useState(false)
  const result = outcome.result ?? {}
  const installed = result.installedFiles ?? []
  const failed = result.failedFiles ?? []
  const warnings = result.warnings ?? []
  const manual = result.manualDownloads ?? []
  const instanceDir = result.instanceDir

  return (
    <div className="mcal-panel col gap-3 anim-rise" style={{ padding: 14, marginTop: 14 }}>
      <div className="row-between gap-3 wrap">
        <div className="row gap-2">
          <Badge tone={failed.length > 0 ? 'warn' : 'ok'}>{failed.length > 0 ? '部分完成' : '导入完成'}</Badge>
          <span className="fs-sm">
            已安装 <span className="mono bold">{installed.length}</span> 个文件
            {failed.length > 0 ? (
              <>
                ，失败 <span className="mono bold err">{failed.length}</span> 个
              </>
            ) : null}
            {manual.length > 0 ? (
              <>
                ，需手动下载 <span className="mono bold warn">{manual.length}</span> 个
              </>
            ) : null}
          </span>
        </div>
        <div className="row gap-2">
          {instanceDir ? (
            <Button
              size="sm"
              icon={<IconFolder size={13} />}
              onClick={() => void mcal.openPath(instanceDir).catch((error) => reportError(error, '打开目录失败'))}
            >
              打开安装目录
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={onGoInstances}>
            去实例页查看
          </Button>
        </div>
      </div>

      <div className="row gap-4 wrap fs-xs muted">
        <span>名称：{result.name ?? '—'}</span>
        <span>游戏版本：{result.gameVersion ?? '未知'}</span>
        <span>加载器：{loaderLabel(result.loaderType)}</span>
        {result.loaderVersion ? <span className="mono">{result.loaderVersion}</span> : null}
        {(result.skippedFiles ?? []).length > 0 ? <span>跳过 {(result.skippedFiles ?? []).length} 个</span> : null}
      </div>

      {instanceDir ? <div className="mono fs-xs break-all faint">{instanceDir}</div> : null}

      {warnings.length > 0 ? (
        <div className="col gap-1">
          <span className="fs-xs bold warn">注意事项</span>
          {warnings.map((warning, index) => (
            <div key={index} className="row-start gap-2 fs-xs muted">
              <IconAlert size={11} className="warn" style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      {failed.length > 0 ? (
        <div className="col gap-1">
          <div className="row-between gap-2">
            <span className="fs-xs bold err">下载失败的文件</span>
            {failed.length > 5 ? (
              <button type="button" className="fs-xs accent" onClick={() => setShowAllFailed((value) => !value)}>
                {showAllFailed ? '收起' : `展开全部 ${failed.length} 条`}
              </button>
            ) : null}
          </div>
          {(showAllFailed ? failed : failed.slice(0, 5)).map((item, index) => (
            <div key={`${item.path}-${index}`} className="col gap-1 fs-xs">
              <span className="mono truncate" title={item.path}>
                {item.path}
              </span>
              <span className="muted">{item.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      {manual.length > 0 ? (
        <div className="col gap-1">
          <span className="fs-xs bold warn">需要手动下载的文件</span>
          <div className="col gap-1" style={{ maxHeight: 140, overflowY: 'auto' }}>
            {manual.slice(0, 30).map((item, index) => (
              <div key={`${item.fileName}-${index}`} className="row-between gap-2 fs-xs">
                <span className="row gap-2" style={{ minWidth: 0 }}>
                  <IconFile size={11} className="muted" />
                  <span className="mono truncate" title={item.fileName}>
                    {item.fileName}
                  </span>
                </span>
                <span className="muted" style={{ flexShrink: 0 }}>
                  {item.projectId ?? '—'}
                </span>
              </div>
            ))}
            {manual.length > 30 ? <span className="fs-xs muted">…另有 {manual.length - 30} 个</span> : null}
          </div>
          <div className="fs-xs muted">
            这些文件清单里没有直链（例如 CurseForge 缺少 API Key）。可以到「内容管理 → 浏览并安装」里按名称逐个补齐。
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------ 长任务进度 ------------------------------ */

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
  const logs = (task.logs ?? []).slice(-6)

  return (
    <div className="mcal-panel col gap-2" style={{ padding: 12 }}>
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
        {task.state === 'running' ? (
          <Button size="sm" variant="ghost" icon={<IconTrash size={12} />} onClick={onCancel} title="取消任务">
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
                <span className="mono">{formatBytes(progress.bytesDone)}</span> /{' '}
                <span className="mono">{formatBytes(progress.bytesTotal)}</span>
              </span>
            ) : null}
            {progress.speed > 0 ? <span className="mono">{formatBytes(progress.speed)}/s</span> : null}
          </>
        ) : (
          <span>正在处理（导入的覆盖复制阶段没有字节进度）…</span>
        )}
      </div>

      {logs.length > 0 ? (
        <div className="log-view" style={{ maxHeight: 120, minHeight: 54 }}>
          {logs.map((line, index) => (
            <div key={index} className="log-view__line--info">
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {task.state === 'completed' ? (
        <div className="row gap-2 fs-xs ok">
          <IconCheck size={12} />
          <span>任务已完成</span>
        </div>
      ) : null}
      {task.error ? <div className="fs-xs err pre-wrap break-all">{task.error}</div> : null}
    </div>
  )
}
