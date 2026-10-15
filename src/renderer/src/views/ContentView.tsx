/**
 * 内容管理页：模组 / 资源包 / 光影 / 数据包 / 存档
 *
 * 设计要点：
 *  - 目标实例来自全局状态，也可由 useView().params.instanceId 指定（从主页跳转过来）；
 *  - 数据来自 mcal.scanContent(gameDir)（带元数据解析，慢：先骨架屏，再一次性替换列表）；
 *  - 一致性检查在渲染进程内基于扫描到的元数据完成（主进程内容校验通道尚未暴露），
 *    输出与 ContentIssue 同构，可直接交给 AI 修复；
 *  - 批量删除、安装项目都带确认/进度反馈，长任务进度来自 useTasks().tasks。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContentFile,
  ContentIssue,
  ContentKind,
  Instance,
  LoaderType,
  ProjectSearchResult,
  ProjectType,
  ProjectVersion,
  TaskState
} from '@shared/types'
import { mcal } from '../lib/api'
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatRelativeTime,
  loaderLabel,
  severityTone
} from '../lib/format'
import { reportError, toast, useInstances, useTasks, useView } from '../state/store'
import {
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  Input,
  Modal,
  Progress,
  SearchInput,
  Segmented,
  Select,
  Switch,
  Tabs,
  Tooltip
} from '../components/ui/primitives'
import {
  IconAlert,
  IconBox,
  IconCheck,
  IconClose,
  IconCube,
  IconDownload,
  IconExternal,
  IconFolder,
  IconImage,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconWrench
} from '../components/ui/icons'

/* ------------------------------ 常量与工具 ------------------------------ */

interface KindTab {
  value: ContentKind
  label: string
  dir: string
  hint: string
}

const KIND_TABS: KindTab[] = [
  {
    value: 'mod',
    label: '模组',
    dir: 'mods/',
    hint: '改变游戏内容的插件（新物品、新机制、性能优化）。需要 Fabric / Forge 等加载器才能生效。'
  },
  {
    value: 'resourcepack',
    label: '资源包',
    dir: 'resourcepacks/',
    hint: '替换贴图、模型、音效与字体，不改变玩法。在游戏内「选项 → 资源包」里可以选择启用顺序。'
  },
  {
    value: 'shaderpack',
    label: '光影',
    dir: 'shaderpacks/',
    hint: '改变光照与画面渲染效果，需要 Iris 或 OptiFine 作为前置，对显卡有一定要求。'
  },
  {
    value: 'datapack',
    label: '数据包',
    dir: 'datapacks/',
    hint: '用原版机制扩展玩法（配方、进度、结构），放进存档的 datapacks 目录即可生效。'
  },
  {
    value: 'world',
    label: '存档',
    dir: 'saves/',
    hint: '你的世界存档。移动或删除前请先退出游戏，避免存档损坏。'
  }
]

function kindTab(kind: ContentKind): KindTab {
  return KIND_TABS.find((item) => item.value === kind) ?? KIND_TABS[0]
}

function guessBaseGameVersion(versionId: string): string {
  const match = /1\.\d+(?:\.\d+)?/.exec(versionId)
  return match ? match[0] : versionId
}

/** 元数据里声明的版本是否可以覆盖目标版本（1.20 可覆盖 1.20.1） */
function versionMatches(declared: string, target: string): boolean {
  if (!declared || !target) return false
  return declared === target || target.startsWith(`${declared}.`) || declared.startsWith(`${target}.`)
}

function environmentLabel(environment: string | undefined): string | null {
  if (environment === 'client') return '仅客户端'
  if (environment === 'server') return '仅服务端'
  if (environment === 'both') return '双端'
  return null
}

function projectTypeForKind(kind: ContentKind): ProjectType {
  switch (kind) {
    case 'resourcepack':
      return 'resourcepack'
    case 'shaderpack':
      return 'shader'
    case 'datapack':
      return 'datapack'
    case 'world':
      return 'world'
    default:
      return 'mod'
  }
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

/** 单个文件的可疑点（用于「仅异常」筛选与徽标） */
function fileIssueLabels(file: ContentFile, instance: Instance | undefined): string[] {
  const labels: string[] = []
  if (file.error) labels.push('读取失败')
  if (file.kind !== 'mod' && file.kind !== 'resourcepack') return labels

  const meta = file.meta
  if (!meta && !file.error) labels.push('无元数据')
  if (meta && instance) {
    const base = guessBaseGameVersion(instance.versionId)
    const declared = meta.gameVersions ?? []
    if (declared.length > 0 && !declared.some((version) => versionMatches(version, instance.versionId) || versionMatches(version, base))) {
      labels.push('版本不匹配')
    }
    if (file.kind === 'mod' && (meta.loaders?.length ?? 0) > 0 && instance.loaderType !== 'vanilla' && !meta.loaders?.includes(instance.loaderType)) {
      labels.push('加载器不匹配')
    }
    if (meta.environment === 'server') labels.push('仅服务端')
  }
  return labels
}

/**
 * 渲染进程侧的一致性分析：
 * 主进程的 content:validate 通道目前没有暴露给渲染进程，这里直接基于扫描到的元数据
 * 做同样的判断（版本不匹配 / 加载器不匹配 / 重复模组 / 缺失前置 / 仅服务端等），
 * 输出结构与 ContentIssue 一致，可以直接交给 AI 修复。
 */
function analyzeIssues(files: ContentFile[], instance: Instance | undefined): ContentIssue[] {
  const issues: ContentIssue[] = []
  if (!instance) return issues

  const base = guessBaseGameVersion(instance.versionId)
  const mods = files.filter((file) => file.kind === 'mod')
  const byId = new Map<string, ContentFile[]>()
  for (const file of mods) {
    const id = file.meta?.id
    if (!id) continue
    byId.set(id, [...(byId.get(id) ?? []), file])
  }

  if (instance.loaderType === 'vanilla' && mods.length > 0) {
    issues.push({
      severity: 'error',
      code: 'loader-required',
      message: `当前实例是原版（vanilla），mods 目录里的 ${mods.length} 个模组不会被游戏加载`,
      files: mods.slice(0, 6).map((file) => file.path),
      suggestion: '在「实例管理」里安装 Fabric / Forge 等加载器，或把这些模组移到带加载器的实例目录。'
    })
  }

  const unreadable = files.filter((file) => file.error)
  if (unreadable.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'file-unreadable',
      message: `${unreadable.length} 个文件读取失败（文件被占用或已损坏）`,
      files: unreadable.map((file) => file.path),
      suggestion: '关闭正在使用这些文件的程序后重新扫描；若仍失败请重新下载。'
    })
  }

  const noMeta = mods.filter((file) => !file.meta && !file.error)
  if (noMeta.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'mod-meta-missing',
      message: `${noMeta.length} 个模组无法解析元数据：可能不是标准 mod（例如 1.12 及更早的老 mod），也可能文件已损坏`,
      files: noMeta.slice(0, 8).map((file) => file.path),
      suggestion: '老版本 mod 通常正常；新版本请重新下载后再试。'
    })
  }

  const versionMismatch: ContentFile[] = []
  const loaderMismatch: ContentFile[] = []
  for (const file of files) {
    if (file.kind !== 'mod' && file.kind !== 'resourcepack') continue
    const meta = file.meta
    if (!meta) continue
    const declared = meta.gameVersions ?? []
    if (declared.length > 0 && !declared.some((version) => versionMatches(version, instance.versionId) || versionMatches(version, base))) {
      versionMismatch.push(file)
    }
    if (
      file.kind === 'mod' &&
      (meta.loaders?.length ?? 0) > 0 &&
      instance.loaderType !== 'vanilla' &&
      !meta.loaders?.includes(instance.loaderType)
    ) {
      loaderMismatch.push(file)
    }
  }
  if (versionMismatch.length > 0) {
    issues.push({
      severity: 'error',
      code: 'version-mismatch',
      message: `${versionMismatch.length} 个内容声明的支持版本不包含 ${instance.versionId}，装上后容易崩溃或完全不生效`,
      files: versionMismatch.slice(0, 10).map((file) => file.path),
      suggestion: '换成与当前版本匹配的下载，或把实例版本切换到它们支持的版本。'
    })
  }
  if (loaderMismatch.length > 0) {
    issues.push({
      severity: 'error',
      code: 'loader-mismatch',
      message: `${loaderMismatch.length} 个模组不是为 ${loaderLabel(instance.loaderType)} 构建的，加载器会直接跳过它们`,
      files: loaderMismatch.slice(0, 10).map((file) => file.path),
      suggestion: '下载对应加载器的版本（Forge / Fabric / NeoForge 版）。'
    })
  }

  for (const [id, group] of byId) {
    if (group.length <= 1) continue
    issues.push({
      severity: 'error',
      code: 'duplicate-mod',
      message: `模组 ${id} 存在 ${group.length} 个副本，重复加载通常会在启动阶段直接崩溃`,
      files: group.map((file) => file.path),
      suggestion: '只保留一个最新版本，其余删除（常见于重复下载，文件名带 (1) 或版本号不同）。'
    })
  }

  const serverOnly = mods.filter((file) => file.meta?.environment === 'server')
  if (serverOnly.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'server-only',
      message: `${serverOnly.length} 个模组声明为仅服务端（server），装在客户端不会生效甚至报错`,
      files: serverOnly.map((file) => file.path),
      suggestion: '把这些模组移到服务端实例的 mods 目录。'
    })
  }

  const installedIds = new Set(byId.keys())
  const missingDeps = new Map<string, ContentFile[]>()
  for (const file of mods) {
    for (const dep of file.meta?.depends ?? []) {
      if (!dep.required || installedIds.has(dep.id)) continue
      missingDeps.set(dep.id, [...(missingDeps.get(dep.id) ?? []), file])
    }
  }
  for (const [depId, dependents] of missingDeps) {
    issues.push({
      severity: 'warning',
      code: 'missing-dependency',
      message: `缺少前置模组 ${depId}（有 ${dependents.length} 个已装模组依赖它）`,
      files: dependents.slice(0, 6).map((file) => file.path),
      suggestion: `用「浏览并安装」搜索 ${depId} 安装后再启动。`
    })
  }

  const disabledIds = new Set(
    mods.filter((file) => !file.enabled && file.meta?.id).map((file) => file.meta?.id ?? '')
  )
  const brokenByDisabled = mods.filter(
    (file) => file.enabled && (file.meta?.depends ?? []).some((dep) => dep.required && disabledIds.has(dep.id))
  )
  if (brokenByDisabled.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'dependency-disabled',
      message: `${brokenByDisabled.length} 个已启用模组的前置处于禁用状态`,
      files: brokenByDisabled.map((file) => file.path),
      suggestion: '启用这些前置模组，或者把依赖它们的模组一起禁用。'
    })
  }

  const shaders = files.filter((file) => file.kind === 'shaderpack')
  if (shaders.length > 0 && instance.loaderType === 'vanilla') {
    issues.push({
      severity: 'info',
      code: 'shader-needs-loader',
      message: '光影文件需要 Iris / OptiFine 之类的渲染前置才能在游戏里选择',
      files: shaders.slice(0, 4).map((file) => file.path),
      suggestion: '安装 Iris（Fabric / Quilt 用）或 OptiFine，也可以让 AI 帮你配置。'
    })
  }

  if (files.length > 0 && files.every((file) => !file.enabled)) {
    issues.push({
      severity: 'info',
      code: 'all-disabled',
      message: `当前目录下 ${files.length} 个内容全部处于禁用状态`,
      suggestion: '把需要的内容启用后再启动游戏。'
    })
  }

  if (issues.length === 0) {
    issues.push({
      severity: 'info',
      code: 'all-good',
      message: '检查通过：没有发现版本冲突、加载器不匹配、重复文件或缺失前置',
      suggestion: '可以直接启动游戏。'
    })
  }
  return issues
}

/* ------------------------------ 页面 ------------------------------ */

export function ContentView(): React.JSX.Element {
  const instances = useInstances((state) => state.instances)
  const activeInstanceId = useInstances((state) => state.activeInstanceId)
  const setActiveInstance = useInstances((state) => state.setActive)
  const params = useView((state) => state.params)
  const navigate = useView((state) => state.navigate)
  const tasks = useTasks((state) => state.tasks)

  const paramInstanceId = typeof params.instanceId === 'string' ? params.instanceId : undefined
  const [instanceId, setInstanceId] = useState(paramInstanceId ?? activeInstanceId ?? '')

  useEffect(() => {
    if (paramInstanceId && paramInstanceId !== instanceId) setInstanceId(paramInstanceId)
  }, [paramInstanceId, instanceId])
  useEffect(() => {
    if (!instanceId && activeInstanceId) setInstanceId(activeInstanceId)
  }, [activeInstanceId, instanceId])

  const instance = useMemo(
    () => instances.find((item) => item.id === instanceId) ?? instances[0],
    [instances, instanceId]
  )

  const [kind, setKind] = useState<ContentKind>('mod')
  const [files, setFiles] = useState<ContentFile[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyDisabled, setOnlyDisabled] = useState(false)
  const [onlyIssues, setOnlyIssues] = useState(false)
  const [sort, setSort] = useState<'name' | 'size' | 'mtime'>('name')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [issues, setIssues] = useState<ContentIssue[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragTimer = useRef<number | null>(null)

  /** 拖拽进入时亮起提示层；400ms 内没有新的 dragover 事件就自动熄灭（防止拖出窗口后残留） */
  const markDragActive = (): void => {
    if (dragTimer.current !== null) window.clearTimeout(dragTimer.current)
    dragTimer.current = window.setTimeout(() => setDragging(false), 400)
    setDragging(true)
  }
  const clearDrag = (): void => {
    if (dragTimer.current !== null) window.clearTimeout(dragTimer.current)
    dragTimer.current = null
    setDragging(false)
  }

  const scan = useCallback(async (target: Instance, silent = false): Promise<void> => {
    if (!silent) setScanning(true)
    try {
      const list = await mcal.scanContent(target.gameDir)
      setFiles(list)
    } catch (error) {
      reportError(error, '扫描内容目录失败')
      setFiles([])
    } finally {
      if (!silent) setScanning(false)
    }
  }, [])

  useEffect(() => {
    setSelected(new Set())
    setIssues(null)
    setFiles(null)
    if (instance) void scan(instance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.id, scan])

  const currentTab = kindTab(kind)
  const kindFiles = useMemo(() => (files ?? []).filter((file) => file.kind === kind), [files, kind])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    let list = kindFiles
    if (keyword) {
      list = list.filter((file) =>
        [file.fileName, file.meta?.id, file.meta?.name, file.meta?.version]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      )
    }
    if (onlyDisabled) list = list.filter((file) => !file.enabled)
    if (onlyIssues) list = list.filter((file) => fileIssueLabels(file, instance).length > 0)

    const sorted = [...list]
    if (sort === 'name') sorted.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN'))
    if (sort === 'size') sorted.sort((a, b) => b.size - a.size)
    if (sort === 'mtime') sorted.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return sorted
  }, [kindFiles, query, onlyDisabled, onlyIssues, sort, instance])

  const kindCounts = useMemo(() => {
    const counts = new Map<ContentKind, number>()
    for (const file of files ?? []) counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1)
    return counts
  }, [files])

  const toggleFile = async (file: ContentFile, enabled: boolean): Promise<void> => {
    setBusyPath(file.path)
    try {
      await mcal.toggleContent(file.path, enabled)
      toast.ok(enabled ? '已启用' : '已禁用', file.fileName)
      if (instance) await scan(instance, true)
    } catch (error) {
      reportError(error, '切换启用状态失败')
    } finally {
      setBusyPath(null)
    }
  }

  const bulkToggle = async (enabled: boolean): Promise<void> => {
    const targets = (files ?? []).filter(
      (file) => file.kind !== 'world' && selected.has(file.path) && file.enabled !== enabled
    )
    if (targets.length === 0) {
      toast.info('没有需要处理的项目')
      return
    }
    setBulkBusy(true)
    let done = 0
    const failed: string[] = []
    for (const file of targets) {
      try {
        await mcal.toggleContent(file.path, enabled)
        done += 1
      } catch {
        failed.push(file.fileName)
      }
    }
    setBulkBusy(false)
    if (instance) await scan(instance, true)
    setSelected(new Set())
    if (failed.length === 0) {
      toast.ok(`${enabled ? '已启用' : '已禁用'} ${done} 个内容`)
    } else {
      toast.warn(`完成 ${done} 个，失败 ${failed.length} 个`, failed.slice(0, 3).join('、'))
    }
  }

  const bulkDelete = async (): Promise<void> => {
    const paths = [...selected]
    if (paths.length === 0) return
    setBulkBusy(true)
    try {
      const raw = (await mcal.deleteContent(paths)) as unknown as
        | { removed?: string[]; failed?: { path: string; error: string }[] }
        | void
      const failed = raw && typeof raw === 'object' && Array.isArray(raw.failed) ? raw.failed : []
      if (failed.length === 0) {
        toast.ok(`已删除 ${paths.length} 个文件`)
      } else {
        toast.warn(`已删除 ${paths.length - failed.length} 个，失败 ${failed.length} 个`, failed[0]?.error)
      }
      setSelected(new Set())
      setDeleteOpen(false)
      if (instance) await scan(instance, true)
    } catch (error) {
      reportError(error, '删除文件失败')
    } finally {
      setBulkBusy(false)
    }
  }

  const importFiles = async (): Promise<void> => {
    if (!instance) return
    setImporting(true)
    try {
      const imported = await mcal.importContent(instance.gameDir, kind)
      if (!imported || imported.length === 0) {
        toast.info('没有导入任何文件')
      } else {
        toast.ok(`已导入 ${imported.length} 个文件`, imported.slice(0, 3).join('、'))
        await scan(instance, true)
      }
    } catch (error) {
      reportError(error, '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const handleDrop = async (paths: string[]): Promise<void> => {
    if (!instance) return
    const names = paths.map((path) => path.split(/[\\/]/).pop() ?? path)
    toast.info(`正在导入 ${paths.length} 个文件`, names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' : ''))
    try {
      const imported = await mcal.importContent(instance.gameDir, kind, paths)
      if (!imported || imported.length === 0) {
        toast.info('没有导入任何文件')
        return
      }
      toast.ok(`已导入 ${imported.length} 个文件`, imported.slice(0, 3).join('、'))
      await scan(instance, true)
    } catch (error) {
      reportError(error, '导入失败')
    }
  }

  const runCheck = async (): Promise<void> => {
    if (!instance) return
    setChecking(true)
    try {
      // 优先用后端的一致性检查引擎（含 pack_format 对照与性能模组互斥表）
      let issues: ContentIssue[] | null = null
      try {
        issues = await mcal.validateContent({
          gameDir: instance.gameDir,
          gameVersion: instance.versionId,
          loaderType: instance.loaderType,
          side: 'client'
        })
      } catch {
        issues = null
      }
      const list = files ?? (await mcal.scanContent(instance.gameDir))
      if (!files) setFiles(list)
      setIssues(issues && issues.length >= 0 ? issues : analyzeIssues(list, instance))
    } catch (error) {
      reportError(error, '一致性检查失败')
    } finally {
      setChecking(false)
    }
  }

  /* ------------------------------ 无实例：引导 ------------------------------ */
  if (instances.length === 0) {
    return (
      <div className="page">
        <div className="page__header">
          <div className="page__title">
            <h2>内容管理</h2>
            <span className="fs-sm muted">管理实例的模组、资源包、光影、数据包与存档</span>
          </div>
        </div>
        <div className="page__body center" style={{ height: '100%' }}>
          <Card padding={40}>
            <Empty
              icon={<IconBox />}
              title="还没有实例，先创建实例再管理内容"
              description="mods / resourcepacks / shaderpacks 都放在实例的游戏目录里。创建实例后，这里可以一键导入、批量启停并检查版本冲突。"
              action={
                <div className="row gap-3 wrap" style={{ marginTop: 8 }}>
                  <Button variant="primary" icon={<IconCube size={15} />} onClick={() => navigate('instances')}>
                    去创建实例
                  </Button>
                  <Button icon={<IconDownload size={15} />} onClick={() => navigate('versions')}>
                    先下载游戏
                  </Button>
                </div>
              }
            />
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div
      className="page"
      style={{ position: 'relative' }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        markDragActive()
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        clearDrag()
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => (file as File & { path?: string }).path)
          .filter((path): path is string => Boolean(path))
        if (paths.length === 0) {
          toast.warn('无法读取拖入的文件路径', '请改用「导入文件」按钮选择文件')
          return
        }
        void handleDrop(paths)
      }}
    >
      <div className="page__header">
        <div className="page__title">
          <h2>内容管理</h2>
          <span className="fs-sm muted">
            {instance ? `${currentTab.dir} 位于 ${instance.gameDir}` : '选择实例后开始管理内容'}
          </span>
        </div>
        <div className="row gap-2 wrap">
          <div style={{ width: 220 }}>
            <Select
              value={instance?.id ?? ''}
              onChange={(value) => {
                setInstanceId(value)
                setActiveInstance(value)
              }}
              options={instances.map((item) => ({
                value: item.id,
                label: `${item.name}（${item.versionId}）`
              }))}
            />
          </div>
          <Button
            icon={<IconRefresh size={14} />}
            loading={scanning}
            onClick={() => instance && void scan(instance)}
            title="重新扫描目录"
          >
            刷新
          </Button>
          <Button icon={<IconWrench size={14} />} loading={checking} onClick={() => void runCheck()}>
            检查问题
          </Button>
          <Button icon={<IconDownload size={14} />} onClick={() => setBrowserOpen(true)}>
            浏览并安装
          </Button>
          <Button variant="primary" icon={<IconFolder size={14} />} loading={importing} onClick={() => void importFiles()}>
            导入文件
          </Button>
        </div>
      </div>

      <div className="page__body">
        <Card padding={0}>
          <div style={{ padding: '0 var(--s-2)' }}>
            <Tabs
              value={kind}
              onChange={(value) => {
                setKind(value)
                setSelected(new Set())
              }}
              options={KIND_TABS.map((tab) => ({
                value: tab.value,
                label: tab.label,
                badge:
                  (kindCounts.get(tab.value) ?? 0) > 0 ? <Badge>{kindCounts.get(tab.value)}</Badge> : null
              }))}
            />
          </div>
          <div className="row-between gap-3 wrap" style={{ padding: '12px var(--s-4)' }}>
            <div className="row gap-3 wrap">
              <div style={{ width: 240 }}>
                <SearchInput value={query} onChange={setQuery} placeholder="搜索文件名 / mod id…" />
              </div>
              <Chip active={onlyDisabled} onClick={() => setOnlyDisabled((value) => !value)}>
                仅已禁用
              </Chip>
              <Chip active={onlyIssues} onClick={() => setOnlyIssues((value) => !value)} title="元数据解析失败或版本/加载器不匹配">
                仅异常
              </Chip>
              {onlyDisabled || onlyIssues || query ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOnlyDisabled(false)
                    setOnlyIssues(false)
                    setQuery('')
                  }}
                >
                  清除筛选
                </Button>
              ) : null}
            </div>
            <div className="row gap-2">
              <span className="fs-xs muted">排序</span>
              <Segmented
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'name', label: '名称' },
                  { value: 'size', label: '大小' },
                  { value: 'mtime', label: '修改时间' }
                ]}
              />
            </div>
          </div>
        </Card>

        {selected.size > 0 ? (
          <Card padding={12} className="anim-fade">
            <div className="row-between gap-3 wrap">
              <span className="fs-sm">
                已选择 <span className="mono bold">{selected.size}</span> 项
              </span>
              <div className="row gap-2 wrap">
                <Button size="sm" icon={<IconCheck size={13} />} loading={bulkBusy} onClick={() => void bulkToggle(true)}>
                  批量启用
                </Button>
                <Button size="sm" loading={bulkBusy} onClick={() => void bulkToggle(false)}>
                  批量禁用
                </Button>
                <Button size="sm" variant="danger" icon={<IconTrash size={13} />} onClick={() => setDeleteOpen(true)}>
                  批量删除
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  取消选择
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {issues !== null ? (
          <IssuesPanel
            issues={issues}
            instance={instance}
            onRecheck={() => void runCheck()}
            onClose={() => setIssues(null)}
            onFixWithAi={() => {
              const problems = issues
                .filter((issue) => issue.severity !== 'info')
                .map((issue) => `- [${issue.severity}] ${issue.message}（涉及：${(issue.files ?? []).slice(0, 3).join('、') || '无具体文件'}）`)
                .join('\n')
              navigate('agent', {
                prompt: `请帮我修复实例「${instance?.name}」（${instance?.versionId}，${loaderLabel(
                  instance?.loaderType
                )}，目录 ${instance?.gameDir}）的内容一致性问题：\n${problems || '（未发现严重问题，请帮我做一次完整体检并给出优化建议）'}\n请给出具体修复步骤，能自动处理的直接处理。`
              })
            }}
          />
        ) : null}

        <div style={{ marginTop: 16 }}>
          {scanning && files === null ? (
            <SkeletonRows />
          ) : visible.length === 0 ? (
            <Card padding={8}>
              <Empty
                icon={<IconBox />}
                title={kindFiles.length === 0 ? `还没有${currentTab.label}` : '没有匹配的内容'}
                description={
                  kindFiles.length === 0 ? (
                    <>
                      {currentTab.hint}
                      <br />
                      可以点击「浏览并安装」从 Modrinth 搜索，或把文件拖进这个页面。
                    </>
                  ) : (
                    '换个关键词，或清除「仅已禁用 / 仅异常」筛选试试。'
                  )
                }
                action={
                  kindFiles.length === 0 ? (
                    <div className="row gap-3 wrap" style={{ marginTop: 8 }}>
                      <Button variant="primary" icon={<IconSearch size={14} />} onClick={() => setBrowserOpen(true)}>
                        浏览并安装{currentTab.label}
                      </Button>
                      <Button icon={<IconFolder size={14} />} loading={importing} onClick={() => void importFiles()}>
                        从本地导入
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setQuery('')
                        setOnlyDisabled(false)
                        setOnlyIssues(false)
                      }}
                    >
                      清除筛选
                    </Button>
                  )
                }
              />
            </Card>
          ) : (
            <div className="mcal-list stagger">
              {visible.map((file) => (
                <ContentRow
                  key={file.path}
                  file={file}
                  instance={instance}
                  checked={selected.has(file.path)}
                  busy={busyPath === file.path}
                  onCheck={(checked) => {
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (checked) next.add(file.path)
                      else next.delete(file.path)
                      return next
                    })
                  }}
                  onToggle={(enabled) => void toggleFile(file, enabled)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 拖拽提示层 */}
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
            <IconFolder size={36} className="accent" />
            <div className="fs-lg bold">松手即可导入</div>
            <div className="fs-sm muted">文件会按当前标签页「{currentTab.label}」的类型导入到 {currentTab.dir}</div>
          </div>
        </div>
      ) : null}

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="删除选中的文件"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="danger" icon={<IconTrash size={14} />} loading={bulkBusy} onClick={() => void bulkDelete()}>
              确认删除 {selected.size} 个文件
            </Button>
          </>
        }
      >
        <div className="col gap-3">
          <div className="row-start gap-3">
            <IconAlert size={18} className="err" style={{ flexShrink: 0, marginTop: 2 }} />
            <div className="col gap-1">
              <div className="fs-md bold">文件会从磁盘上直接删除，无法撤销</div>
              <div className="fs-sm muted">删除前请退出游戏，避免文件被占用导致删除失败。</div>
            </div>
          </div>
          <div className="mcal-panel col gap-1" style={{ padding: 12, maxHeight: 240, overflowY: 'auto' }}>
            {(files ?? [])
              .filter((file) => selected.has(file.path))
              .slice(0, 60)
              .map((file) => (
                <div key={file.path} className="row-between gap-2 fs-xs">
                  <span className="mono truncate" title={file.path}>
                    {file.fileName}
                  </span>
                  <span className="muted" style={{ flexShrink: 0 }}>
                    {formatBytes(file.size)}
                  </span>
                </div>
              ))}
            {selected.size > 60 ? <div className="fs-xs muted">…另有 {selected.size - 60} 个文件</div> : null}
          </div>
        </div>
      </Modal>

      <BrowserModal
        open={browserOpen}
        instance={instance}
        kind={kind}
        tasks={tasks}
        onClose={() => setBrowserOpen(false)}
        onInstalled={() => instance && void scan(instance, true)}
      />
    </div>
  )
}

/* ------------------------------ 列表行 ------------------------------ */

function ContentRow({
  file,
  instance,
  checked,
  busy,
  onCheck,
  onToggle
}: {
  file: ContentFile
  instance?: Instance
  checked: boolean
  busy: boolean
  onCheck: (checked: boolean) => void
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  const labels = fileIssueLabels(file, instance)
  const meta = file.meta

  return (
    <div className="mcal-list__row" style={{ alignItems: 'flex-start' }}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={`选择 ${file.fileName}`}
        onClick={() => onCheck(!checked)}
        style={{
          width: 16,
          height: 16,
          marginTop: 2,
          borderRadius: 'var(--r-xs)',
          border: `1px solid ${checked ? 'var(--c-verdant)' : 'var(--c-hairline-strong)'}`,
          background: checked ? 'var(--c-verdant-glow)' : 'transparent',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0
        }}
      >
        {checked ? <IconCheck size={11} className="accent" /> : null}
      </button>

      <div className="col gap-1 grow" style={{ minWidth: 0 }}>
        <div className="row gap-2 wrap">
          <span className="fs-base bold truncate" title={file.fileName} style={{ maxWidth: 420 }}>
            {file.fileName}
          </span>
          {meta?.source?.platform === 'modrinth' ? <Badge tone="violet">Modrinth</Badge> : null}
          {meta?.source?.platform === 'curseforge' ? <Badge tone="gold">CurseForge</Badge> : null}
          {!file.enabled ? <Badge tone="warn">已禁用</Badge> : null}
          {labels.map((label) => (
            <Badge key={label} tone={label === '版本不匹配' || label === '加载器不匹配' || label === '读取失败' ? 'err' : 'warn'}>
              {label}
            </Badge>
          ))}
        </div>

        <div className="row gap-3 wrap fs-xs muted">
          {meta?.id ? <span className="mono">{meta.id}</span> : null}
          {meta?.version ? <span>v{meta.version}</span> : null}
          {meta?.loaders?.length ? <span>{meta.loaders.join(' / ')}</span> : null}
          {environmentLabel(meta?.environment) ? <span>{environmentLabel(meta?.environment)}</span> : null}
          <span className="mono">{formatBytes(file.size)}</span>
          <span>{formatRelativeTime(file.mtimeMs)}</span>
        </div>

        {meta?.gameVersions?.length ? (
          <div className="fs-xs faint truncate" title={meta.gameVersions.join(', ')}>
            支持版本：{meta.gameVersions.slice(0, 10).join(', ')}
            {meta.gameVersions.length > 10 ? ' …' : ''}
          </div>
        ) : null}
        {meta?.description ? <div className="fs-xs muted clamp-2">{meta.description}</div> : null}
        {file.error ? <div className="fs-xs err">{file.error}</div> : null}
      </div>

      <div className="row gap-2" style={{ flexShrink: 0 }}>
        {file.kind === 'world' ? (
          <span className="fs-xs muted">存档不可禁用</span>
        ) : (
          <Tooltip content={file.enabled ? '点击禁用（会改名为 .disabled，游戏不会加载）' : '点击启用'}>
            <Switch checked={file.enabled} disabled={busy} onChange={onToggle} label={file.enabled ? '禁用' : '启用'} />
          </Tooltip>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<IconFolder size={13} />}
          title="在资源管理器中显示"
          onClick={() => void mcal.revealPath(file.path).catch((error) => reportError(error, '打开目录失败'))}
        />
      </div>
    </div>
  )
}

function SkeletonRows(): React.JSX.Element {
  return (
    <div className="col gap-2">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="skeleton" style={{ height: 68 }} />
      ))}
      <div className="fs-xs muted center" style={{ paddingTop: 4 }}>
        正在解析元数据（模组较多时需要几秒钟）…
      </div>
    </div>
  )
}

/* ------------------------------ 一致性检查面板 ------------------------------ */

function IssuesPanel({
  issues,
  instance,
  onRecheck,
  onClose,
  onFixWithAi
}: {
  issues: ContentIssue[]
  instance?: Instance
  onRecheck: () => void
  onClose: () => void
  onFixWithAi: () => void
}): React.JSX.Element {
  const groups: { key: ContentIssue['severity']; title: string; items: ContentIssue[] }[] = [
    { key: 'error', title: '严重问题', items: issues.filter((issue) => issue.severity === 'error') },
    { key: 'warning', title: '警告', items: issues.filter((issue) => issue.severity === 'warning') },
    { key: 'info', title: '提示', items: issues.filter((issue) => issue.severity === 'info') }
  ]
  const problemCount = issues.filter((issue) => issue.severity !== 'info').length

  return (
    <Card padding={18} className="anim-rise">
      <div className="row-between gap-3 wrap" style={{ marginBottom: 14 }}>
        <div className="row gap-2">
          <IconWrench size={16} className={problemCount > 0 ? 'warn' : 'accent'} />
          <span className="fs-md bold">一致性检查</span>
          {problemCount > 0 ? (
            <Badge tone="warn">{problemCount} 个问题</Badge>
          ) : (
            <Badge tone="ok">全部通过</Badge>
          )}
          <span className="fs-xs muted">
            基于 {instance?.versionId ?? ''} · {loaderLabel(instance?.loaderType)} 的目录扫描
          </span>
        </div>
        <div className="row gap-2">
          <Button size="sm" icon={<IconRefresh size={13} />} onClick={onRecheck}>
            重新检查
          </Button>
          <Button size="sm" variant="primary" icon={<IconSparkles size={13} />} onClick={onFixWithAi}>
            让 AI 修复
          </Button>
          <Button size="sm" variant="ghost" icon={<IconClose size={13} />} onClick={onClose} title="关闭面板" />
        </div>
      </div>

      <div className="col gap-4">
        {groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <div key={group.key} className="col gap-2">
              <div className="row gap-2">
                <Badge tone={severityTone(group.key)}>{group.title}</Badge>
                <span className="fs-xs muted">{group.items.length} 条</span>
              </div>
              <div className="col gap-2">
                {group.items.map((issue, index) => (
                  <div key={`${issue.code}-${index}`} className="mcal-panel col gap-2" style={{ padding: 12 }}>
                    <div className="row gap-2">
                      <Badge tone={severityTone(issue.severity)}>{issue.code}</Badge>
                      <span className="fs-sm grow">{issue.message}</span>
                    </div>
                    {(issue.files ?? []).length > 0 ? (
                      <div className="col gap-1">
                        {(issue.files ?? []).slice(0, 5).map((path) => (
                          <button
                            key={path}
                            type="button"
                            className="row gap-2 fs-xs"
                            style={{ textAlign: 'left', color: 'var(--c-diamond)' }}
                            title="在资源管理器中显示"
                            onClick={() => void mcal.revealPath(path).catch((error) => reportError(error, '打开目录失败'))}
                          >
                            <IconFolder size={11} />
                            <span className="truncate">{path.split(/[\\/]/).pop()}</span>
                          </button>
                        ))}
                        {(issue.files ?? []).length > 5 ? (
                          <span className="fs-xs muted">…另有 {(issue.files ?? []).length - 5} 个文件</span>
                        ) : null}
                      </div>
                    ) : null}
                    {issue.suggestion ? (
                      <div className="row-start gap-2 fs-xs muted">
                        <IconCheck size={12} className="accent" style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>{issue.suggestion}</span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
      </div>
    </Card>
  )
}

/* ------------------------------ Modrinth 浏览器 ------------------------------ */

function ProjectIcon({ url, size = 40 }: { url?: string; size?: number }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!url || failed) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 'var(--r-sm)',
          background: 'var(--c-verdant-glow)',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0
        }}
      >
        <IconImage size={size * 0.5} className="accent" />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
      style={{ borderRadius: 'var(--r-sm)', objectFit: 'cover', flexShrink: 0 }}
    />
  )
}

function BrowserModal({
  open,
  instance,
  kind,
  tasks,
  onClose,
  onInstalled
}: {
  open: boolean
  instance?: Instance
  kind: ContentKind
  tasks: TaskState[]
  onClose: () => void
  onInstalled: () => void
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [projectType, setProjectType] = useState<ProjectType>(projectTypeForKind(kind))
  const [gameVersion, setGameVersion] = useState(instance ? guessBaseGameVersion(instance.versionId) : '')
  const [loader, setLoader] = useState<LoaderType | ''>(
    instance && instance.loaderType !== 'vanilla' ? instance.loaderType : ''
  )
  const [results, setResults] = useState<ProjectSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [project, setProject] = useState<ProjectSearchResult | null>(null)
  const [versions, setVersions] = useState<ProjectVersion[] | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [installingVersionId, setInstallingVersionId] = useState<string | null>(null)

  // 每次打开时把筛选条件重置为当前实例的上下文
  useEffect(() => {
    if (!open) return
    setProjectType(projectTypeForKind(kind))
    setGameVersion(instance ? guessBaseGameVersion(instance.versionId) : '')
    setLoader(instance && instance.loaderType !== 'vanilla' ? instance.loaderType : '')
    setProject(null)
    setVersions(null)
    setResults(null)
  }, [open, kind, instance?.id, instance?.versionId, instance?.loaderType])

  const installTask = useMemo(() => {
    if (!installingVersionId || !project) return undefined
    return tasks
      .filter((task) => task.kind === 'install-project' && task.label === `安装 ${project.projectId}`)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
  }, [tasks, installingVersionId, project])

  const search = async (): Promise<void> => {
    const keyword = query.trim()
    if (!keyword) {
      toast.warn('请输入搜索关键词', '例如 sodium、iris、JEI')
      return
    }
    setSearching(true)
    setProject(null)
    setVersions(null)
    try {
      const list = await mcal.searchProjects({
        query: keyword,
        platform: 'modrinth',
        projectType,
        gameVersion: gameVersion.trim() || undefined,
        loader: loader || undefined,
        limit: 24
      })
      setResults(list)
      if (list.length === 0) {
        toast.info('没有找到匹配的项目', '换个关键词，或放宽版本 / 加载器筛选')
      }
    } catch (error) {
      reportError(error, '搜索失败')
      toast.info('搜索失败通常是网络问题', '稍后重试，或检查系统代理设置')
    } finally {
      setSearching(false)
    }
  }

  const openProject = async (item: ProjectSearchResult): Promise<void> => {
    setProject(item)
    setVersions(null)
    setLoadingVersions(true)
    try {
      const list = await mcal.projectVersions({
        platform: 'modrinth',
        projectId: item.projectId,
        gameVersion: gameVersion.trim() || undefined,
        loader: loader || undefined
      })
      setVersions(list)
    } catch (error) {
      reportError(error, '读取版本列表失败')
      setVersions([])
    } finally {
      setLoadingVersions(false)
    }
  }

  const install = async (version: ProjectVersion): Promise<void> => {
    if (!instance || !project) return
    setInstallingVersionId(version.versionId)
    try {
      const result = await mcal.installProject({
        platform: 'modrinth',
        projectId: project.projectId,
        versionId: version.versionId,
        gameDir: instance.gameDir,
        kind: projectType,
        gameVersion: gameVersion.trim() || undefined,
        loader: loader || undefined
      })
      const files = result && Array.isArray(result.files) ? result.files : []
      toast.ok(
        `${project.title} ${version.versionNumber} 安装完成`,
        `${files.length > 0 ? `共 ${files.length} 个文件 · ` : ''}重启游戏生效`
      )
      onInstalled()
    } catch (error) {
      reportError(error, '安装失败')
    } finally {
      setInstallingVersionId(null)
    }
  }

  return (
    <Modal open={open} onClose={onClose} wide title="浏览并安装（Modrinth）">
      <div className="col gap-4">
        <div className="row-start gap-3 wrap">
          <div className="grow" style={{ minWidth: 220 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="搜索项目，例如 sodium / iris" onEnter={() => void search()} />
          </div>
          <div style={{ width: 150 }}>
            <Select
              value={projectType}
              onChange={(value) => setProjectType(value as ProjectType)}
              options={[
                { value: 'mod', label: '模组' },
                { value: 'resourcepack', label: '资源包' },
                { value: 'shader', label: '光影' },
                { value: 'datapack', label: '数据包' },
                { value: 'modpack', label: '整合包' },
                { value: 'world', label: '存档' }
              ]}
            />
          </div>
          <div style={{ width: 120 }}>
            <Input value={gameVersion} onChange={setGameVersion} monospace placeholder="1.20.1" />
          </div>
          <div style={{ width: 140 }}>
            <Select
              value={loader}
              onChange={(value) => setLoader(value as LoaderType | '')}
              options={[
                { value: '', label: '任意加载器' },
                { value: 'fabric', label: 'Fabric' },
                { value: 'quilt', label: 'Quilt' },
                { value: 'forge', label: 'Forge' },
                { value: 'neoforge', label: 'NeoForge' }
              ]}
            />
          </div>
          <Button variant="primary" icon={<IconSearch size={14} />} loading={searching} onClick={() => void search()}>
            搜索
          </Button>
        </div>

        {project ? (
          <div className="col gap-3">
            <div className="row-between gap-3 wrap">
              <div className="row gap-3" style={{ minWidth: 0 }}>
                <ProjectIcon url={project.iconUrl} />
                <div className="col gap-1" style={{ minWidth: 0 }}>
                  <span className="fs-md bold truncate" title={project.title}>
                    {project.title}
                  </span>
                  <span className="fs-xs muted clamp-2">{project.description}</span>
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setProject(null)}>
                返回搜索结果
              </Button>
            </div>

            {loadingVersions ? (
              <div className="col gap-2">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="skeleton" style={{ height: 56 }} />
                ))}
              </div>
            ) : (versions ?? []).length === 0 ? (
              <Empty
                icon={<IconAlert />}
                title="没有匹配当前版本 / 加载器的文件"
                description="这个项目可能还不支持你填写的游戏版本或加载器。改一下上方筛选条件再试。"
              />
            ) : (
              <div className="col gap-2" style={{ maxHeight: 320, overflowY: 'auto' }}>
                {(versions ?? []).map((version) => {
                  const primary = version.files.find((file) => file.primary) ?? version.files[0]
                  const busy = installingVersionId === version.versionId
                  return (
                    <div key={version.versionId} className="mcal-list__row">
                      <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                        <div className="row gap-2 wrap">
                          <span className="fs-sm bold truncate">{version.name || version.versionNumber}</span>
                          <Badge
                            tone={
                              version.versionType === 'release' ? 'ok' : version.versionType === 'beta' ? 'warn' : 'err'
                            }
                          >
                            {version.versionType === 'release' ? '正式版' : version.versionType === 'beta' ? 'Beta' : 'Alpha'}
                          </Badge>
                          {version.dependencies.length > 0 ? (
                            <Badge tone="info">{version.dependencies.length} 个依赖</Badge>
                          ) : null}
                        </div>
                        <div className="row gap-3 wrap fs-xs muted">
                          {primary ? (
                            <>
                              <span className="mono truncate" style={{ maxWidth: 260 }} title={primary.filename}>
                                {primary.filename}
                              </span>
                              <span>{formatBytes(primary.size)}</span>
                            </>
                          ) : null}
                          {version.gameVersions?.length ? <span>{version.gameVersions.slice(0, 4).join(', ')}</span> : null}
                          {version.loaders?.length ? <span>{version.loaders.join(' / ')}</span> : null}
                          {version.publishedAt ? <span>{formatRelativeTime(version.publishedAt)}</span> : null}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<IconDownload size={13} />}
                        loading={busy}
                        disabled={installingVersionId !== null && !busy}
                        onClick={() => void install(version)}
                      >
                        {busy ? '安装中…' : '安装'}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}

            {installingVersionId && installTask ? (
              <div className="col gap-2">
                <div className="row-between gap-3">
                  <span className="fs-sm">正在下载安装（含前置依赖）…</span>
                  <Button size="sm" variant="ghost" onClick={() => void mcal.cancelTask(installTask.taskId)}>
                    取消
                  </Button>
                </div>
                <Progress
                  value={
                    installTask.progress && installTask.progress.bytesTotal > 0
                      ? installTask.progress.bytesDone / installTask.progress.bytesTotal
                      : installTask.progress && installTask.progress.total > 0
                        ? installTask.progress.completed / installTask.progress.total
                        : 0
                  }
                  indeterminate={
                    !installTask.progress ||
                    (installTask.progress.bytesTotal === 0 && installTask.progress.total === 0)
                  }
                  tone="info"
                />
                {installTask.progress ? (
                  <div className="row gap-4 wrap fs-xs muted">
                    <span>
                      <span className="mono">{formatBytes(installTask.progress.bytesDone)}</span> /{' '}
                      <span className="mono">{formatBytes(installTask.progress.bytesTotal)}</span>
                    </span>
                    {installTask.progress.speed > 0 ? (
                      <span className="mono">{formatBytes(installTask.progress.speed)}/s</span>
                    ) : null}
                    {installTask.progress.etaSeconds !== null ? (
                      <span>剩余约 {formatDuration(installTask.progress.etaSeconds)}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : results === null ? (
          <Empty
            icon={<IconSearch />}
            title="从 Modrinth 搜索并安装"
            description="输入关键词搜索。安装会自动带上必需的前置依赖，完成后重启游戏生效。图片、动画与描述来自 Modrinth 公开接口。"
            action={
              <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
                {['sodium', 'iris', 'JEI', 'modmenu'].map((suggestion) => (
                  <Chip
                    key={suggestion}
                    onClick={() => {
                      setQuery(suggestion)
                    }}
                  >
                    {suggestion}
                  </Chip>
                ))}
              </div>
            }
          />
        ) : results.length === 0 ? (
          <Empty
            icon={<IconAlert />}
            title="没有找到匹配的项目"
            description="换个关键词，或把版本 / 加载器筛选放宽一些。"
          />
        ) : (
          <div className="col gap-2" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {results.map((item) => (
              <div
                key={item.projectId}
                className="mcal-list__row"
                style={{ cursor: 'pointer' }}
                onClick={() => void openProject(item)}
              >
                <ProjectIcon url={item.iconUrl} />
                <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                  <div className="row gap-2 wrap">
                    <span className="fs-md bold truncate">{item.title}</span>
                    {item.author ? <span className="fs-xs muted">by {item.author}</span> : null}
                  </div>
                  <div className="fs-xs muted clamp-2">{item.description}</div>
                  <div className="row gap-3 wrap fs-xs faint">
                    <span className="row gap-1">
                      <IconDownload size={11} />
                      {formatNumber(item.downloads)}
                    </span>
                    {item.gameVersions?.length ? <span>{item.gameVersions.slice(-4).reverse().join(', ')}</span> : null}
                    {item.loaders?.length ? <span>{item.loaders.join(' / ')}</span> : null}
                  </div>
                </div>
                <IconExternal size={14} className="muted" style={{ flexShrink: 0 }} />
              </div>
            ))}
          </div>
        )}

        <div className="fs-xs muted">
          安装目标：{instance ? `${instance.gameDir}/${kindTab(kind).dir}` : '（未选择实例）'}。安装完成后需要重启游戏才会加载新内容。
        </div>
      </div>
    </Modal>
  )
}

