/**
 * AI 对话页 —— 整个产品的核心。
 *
 * 设计要点：
 *  1) 流式渲染：text_delta 高频到达，绝不在每个字符上 setState。
 *     做法是「useRef 累积权威缓冲 + 50ms 定时合并刷新」：
 *       - 事件回调只写 ref（memo.text / memo.reasoning / memo.toolArgs），O(1)；
 *       - 定时器到点后把缓冲整体替换进消息对象并 setState（每个消息组件用 memo 包裹，
 *         因此一次 flush 只让"正在流式的那个气泡"重渲染）。
 *     因为写入的是完整缓冲而不是增量拼接 state，所以不会丢字、不会出现重复追加。
 *  2) 滚动：贴底自动滚动；用户向上滚动（scrollTop + clientHeight < scrollHeight - 40）时
 *     暂停自动滚动并露出「回到最新」按钮。
 *  3) 授权：permission_request 进队列，一次只显示一个；拒绝即拒绝，不自动重试。
 *  4) 会话切换：每个访问过的会话在内存里有一份 memo（时间线 + 流式缓冲），
 *     后台会话的事件依然会被写入 memo，切回来不丢内容。
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import type {
  ChatAttachment,
  ChatMessage,
  PermissionRequest,
  SkillContent,
  SkillMeta
} from '@shared/types'
import { mcal } from '../lib/api'
import { formatNumber, formatRelativeTime, loaderLabel } from '../lib/format'
import { reportError, toast, useInstances, useSettings, useView } from '../state/store'
import { Badge, Button, Modal, Progress, Tooltip } from '../components/ui/primitives'
import { Markdown } from '../components/ui/Markdown'
import {
  IconAlert,
  IconBook,
  IconBrain,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCode,
  IconCube,
  IconFile,
  IconFolder,
  IconImage,
  IconInfo,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
  IconServer,
  IconSparkles,
  IconStop,
  IconTerminal,
  IconTrash,
  IconWrench
} from '../components/ui/icons'

/* ------------------------------------------------------------------ *
 *  类型与常量
 * ------------------------------------------------------------------ */

interface TodoItem {
  id: string
  content: string
  status: string
  note?: string
}

interface UsageInfo {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

type ToolStatus = 'running' | 'ok' | 'fail' | 'done'

interface UserItem {
  kind: 'user'
  id: string
  text: string
  attachments?: ChatAttachment[]
}

interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  reasoning: string
  streaming: boolean
}

interface ToolItem {
  kind: 'tool'
  id: string
  callId: string
  name: string
  args: string
  status: ToolStatus
  output?: string
  durationMs?: number
}

interface NoticeItem {
  kind: 'notice'
  id: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

interface CompactionItem {
  kind: 'compaction'
  id: string
  removed: number
  summary: string
}

interface ErrorItem {
  kind: 'error'
  id: string
  message: string
  detail?: string
}

type TimelineItem = UserItem | AssistantItem | ToolItem | NoticeItem | CompactionItem | ErrorItem

/** 每个会话在内存中的运行状态（时间线 + 流式权威缓冲） */
interface SessionMemo {
  timeline: TimelineItem[]
  loaded: boolean
  /** 正在接收 text_delta / reasoning_delta 的助手消息 id */
  assistantId: string | null
  text: string
  reasoning: string
  /** toolItemId → 已累积的参数 JSON */
  toolArgs: Map<string, string>
  /** callId → toolItemId，用于把 tool_result 关联回卡片 */
  callIndex: Map<string, string>
  dirty: boolean
  model: string
  todos: TodoItem[]
  usage: UsageInfo | null
}

interface PermEntry {
  sessionId: string
  sessionTitle: string
  request: PermissionRequest
}

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`
}

/* ------------------------------ 工具名中文映射 ------------------------------ */

const TOOL_LABELS: Record<string, string> = {
  // 游戏 / 启动器
  mc_list_instances: '列出实例',
  mc_instance_info: '查看实例详情',
  mc_create_instance: '创建实例',
  mc_update_instance: '修改实例配置',
  mc_list_versions: '列出游戏版本',
  mc_install_version: '安装游戏版本',
  mc_install_loader: '安装加载器',
  mc_verify_version: '校验版本完整性',
  mc_launch: '启动游戏',
  mc_game_status: '查询游戏状态',
  mc_stop_game: '关闭游戏',
  mc_read_log: '读取游戏日志',
  mc_diagnose: '诊断崩溃',
  mc_check_content: '检查模组兼容性',
  mc_scan_content: '扫描游戏资源',
  mc_search_projects: '搜索模组 / 整合包',
  mc_install_project: '安装模组 / 整合包',
  mc_toggle_content: '启用 / 禁用资源',
  mc_list_java: '检测 Java 环境',
  mc_server_list: '列出服务端',
  mc_server_create: '创建服务端',
  mc_server_control: '启停服务端',
  mc_server_properties: '修改服务端配置',
  mc_inspect_modpack: '解析整合包',
  mc_export_modpack: '导出整合包',
  // 文件系统
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_dir: '浏览目录',
  glob: '按模式查找文件',
  grep: '搜索文件内容',
  delete_path: '删除文件 / 目录',
  make_dir: '新建目录',
  // Shell
  run_command: '执行命令',
  // 元能力
  todo_write: '更新待办清单',
  skill_list: '列出可用技能',
  skill_read: '阅读技能说明',
  search_knowledge: '检索知识库',
  read_knowledge: '阅读知识文章',
  list_knowledge: '列出知识文章',
  memory_search: '检索记忆库',
  memory_write: '记录经验',
  // 开发 / 媒体
  dev_list_templates: '列出项目模板',
  dev_scaffold_project: '生成项目脚手架',
  dev_build_project: '构建项目',
  dev_write_source: '写入源码文件',
  media_list_providers: '查询生图服务',
  media_generate_texture: '生成贴图'
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

function toolIcon(name: string, size = 13): ReactNode {
  if (name.startsWith('mc_')) return <IconCube size={size} />
  if (name === 'run_command') return <IconTerminal size={size} />
  if (name.startsWith('media_')) return <IconImage size={size} />
  if (name.startsWith('dev_')) return <IconCode size={size} />
  if (name.startsWith('memory_')) return <IconBrain size={size} />
  if (name.includes('knowledge')) return <IconBook size={size} />
  if (name === 'grep' || name === 'glob' || name.includes('search')) return <IconSearch size={size} />
  if (name.includes('server')) return <IconServer size={size} />
  if (name.includes('dir') || name.includes('folder')) return <IconFolder size={size} />
  if (name.startsWith('todo')) return <IconWrench size={size} />
  return <IconFile size={size} />
}

function parseArgsJson(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

/** 从（可能仍在流式拼接的）参数 JSON 里提取关键字段做摘要 */
function summarizeArgs(raw: string): string {
  const parsed = parseArgsJson(raw)
  if (!parsed) {
    const flat = raw.trim().replace(/\s+/g, ' ')
    if (!flat) return ''
    return flat.length > 84 ? `${flat.slice(0, 84)}…` : flat
  }
  if (Array.isArray(parsed.todos)) return `待办 ${parsed.todos.length} 项`
  const keys = [
    'path',
    'file_path',
    'filePath',
    'file',
    'dir',
    'projectDir',
    'targetDir',
    'instance',
    'instanceName',
    'instanceId',
    'command',
    'query',
    'name',
    'url',
    'templateId',
    'task',
    'preset',
    'prompt',
    'pattern'
  ]
  for (const key of keys) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim().replace(/\s+/g, ' ')
      return `${text.length > 96 ? `${text.slice(0, 96)}…` : text}`
    }
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return `${key}: ${String(value).slice(0, 80)}`
    }
  }
  return ''
}

const RISK_META: Record<PermissionRequest['risk'], { label: string; tone: 'ok' | 'warn' | 'err' }> = {
  low: { label: '低风险', tone: 'ok' },
  medium: { label: '中风险', tone: 'warn' },
  high: { label: '高风险', tone: 'err' }
}

const MAX_TOOL_OUTPUT = 3000

/* ------------------------------------------------------------------ *
 *  主组件
 * ------------------------------------------------------------------ */

export function AgentView(): React.JSX.Element {
  const params = useView((state) => state.params)
  const navigate = useView((state) => state.navigate)
  const settings = useSettings((state) => state.settings)
  const instances = useInstances((state) => state.instances)
  const activeInstanceId = useInstances((state) => state.activeInstanceId)

  const instance = useMemo(
    () => instances.find((item) => item.id === activeInstanceId) ?? instances[0],
    [instances, activeInstanceId]
  )

  /* ----------------------------- 本地状态 ----------------------------- */

  const [sessions, setSessions] = useState<{ id: string; title: string; updatedAt: string; messageCount: number }[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [loadingSession, setLoadingSession] = useState(false)
  const [runningIds, setRunningIds] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [stick, setStick] = useState(true)
  const [permQueue, setPermQueue] = useState<PermEntry[]>([])
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [skillDetail, setSkillDetail] = useState<SkillContent | null>(null)
  const [skillLoading, setSkillLoading] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [ctxUsage, setCtxUsage] = useState<{ tokens: number; window: number } | null>(null)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [model, setModel] = useState<string>('')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  /* ------------------------------- refs ------------------------------- */

  const cacheRef = useRef<Map<string, SessionMemo>>(new Map())
  const activeIdRef = useRef<string | null>(null)
  const flushTimerRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastUserRef = useRef<{ text: string; attachments?: ChatAttachment[] } | null>(null)
  const sendRef = useRef<(text: string, atts?: ChatAttachment[], overrideSession?: string) => void>(() => undefined)
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  /* --------------------------- 会话 memo 工具 --------------------------- */

  const getMemo = useCallback((sessionId: string): SessionMemo => {
    let memo = cacheRef.current.get(sessionId)
    if (!memo) {
      memo = {
        timeline: [],
        loaded: false,
        assistantId: null,
        text: '',
        reasoning: '',
        toolArgs: new Map(),
        callIndex: new Map(),
        dirty: false,
        model: '',
        todos: [],
        usage: null
      }
      cacheRef.current.set(sessionId, memo)
    }
    return memo
  }, [])

  /** 把缓冲整体写回时间线（不丢字：写的是完整缓冲，不是增量） */
  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const active = activeIdRef.current
    let activeDirty = false
    for (const [id, memo] of cacheRef.current) {
      if (!memo.dirty) continue
      memo.dirty = false
      if (memo.assistantId) {
        const index = memo.timeline.findIndex((item) => item.kind === 'assistant' && item.id === memo.assistantId)
        if (index >= 0) {
          const item = memo.timeline[index] as AssistantItem
          memo.timeline[index] = { ...item, text: memo.text, reasoning: memo.reasoning }
        }
      }
      if (memo.toolArgs.size > 0) {
        for (const [toolId, args] of memo.toolArgs) {
          const index = memo.timeline.findIndex((item) => item.kind === 'tool' && item.id === toolId)
          if (index >= 0) memo.timeline[index] = { ...(memo.timeline[index] as ToolItem), args }
        }
        memo.toolArgs.clear()
      }
      if (id === active) activeDirty = true
    }
    if (activeDirty && active) {
      const memo = cacheRef.current.get(active)
      if (memo) setTimeline(memo.timeline.slice())
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return
    // 约 20fps 的合并刷新：足够顺滑，CPU 成本可控
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      flush()
    }, 50)
  }, [flush])

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current)
    }
  }, [])

  const syncActiveFromMemo = useCallback((sessionId: string, syncTimeline = true) => {
    const memo = cacheRef.current.get(sessionId)
    if (syncTimeline) setTimeline(memo ? memo.timeline.slice() : [])
    setTodos(memo?.todos ?? [])
    setUsage(memo?.usage ?? null)
    setModel(memo?.model ?? '')
  }, [])

  const finalizeAssistant = useCallback((memo: SessionMemo, dropEmpty: boolean) => {
    const id = memo.assistantId
    if (!id) return
    const index = memo.timeline.findIndex((item) => item.kind === 'assistant' && item.id === id)
    if (index >= 0) {
      const item = memo.timeline[index] as AssistantItem
      const empty = item.text.trim() === '' && item.reasoning.trim() === ''
      if (empty) {
        if (dropEmpty) {
          memo.timeline.splice(index, 1)
          memo.assistantId = null
          memo.text = ''
          memo.reasoning = ''
        }
        // 空且不要求删除：保留「正在思考…」气泡，让下一段内容继续填进同一个气泡
        return
      }
      memo.timeline[index] = { ...item, text: memo.text, reasoning: memo.reasoning, streaming: false }
    }
    memo.assistantId = null
    memo.text = ''
    memo.reasoning = ''
  }, [])

  const pushAssistant = useCallback((memo: SessionMemo): string => {
    const item: AssistantItem = { kind: 'assistant', id: nextId('a'), text: '', reasoning: '', streaming: true }
    memo.timeline.push(item)
    memo.assistantId = item.id
    memo.text = ''
    memo.reasoning = ''
    return item.id
  }, [])

  const refreshSessions = useCallback(async (): Promise<{ id: string; title: string; updatedAt: string; messageCount: number }[]> => {
    try {
      const list = await mcal.agentSessions()
      setSessions(list)
      return list
    } catch (error) {
      reportError(error, '读取会话列表失败')
      return []
    }
  }, [])

  const refreshCtxUsage = useCallback(async (sessionId: string) => {
    try {
      const result = await mcal.agentContextUsage(sessionId)
      if (activeIdRef.current === sessionId) setCtxUsage(result)
    } catch {
      /* 统计失败不影响主流程 */
    }
  }, [])

  const selectSession = useCallback(
    async (sessionId: string) => {
      if (activeIdRef.current === sessionId) return
      flush()
      activeIdRef.current = sessionId
      setActiveSessionId(sessionId)
      const memo = cacheRef.current.get(sessionId)
      if (memo && memo.loaded) {
        syncActiveFromMemo(sessionId)
      } else {
        setLoadingSession(true)
        setTimeline([])
        try {
          const { messages } = await mcal.loadAgentSession(sessionId)
          const target = getMemo(sessionId)
          const fromDisk = timelineFromMessages(messages)
          if (target.timeline.length > 0) {
            // 期间已有实时事件写入（可能在流式中）：以磁盘历史为基底，拼接实时新增项
            const ids = new Set(fromDisk.map((item) => item.id))
            const live = target.timeline.filter((item) => item.kind !== 'user' && !ids.has(item.id))
            target.timeline = [...fromDisk, ...live]
          } else {
            target.timeline = fromDisk
          }
          target.loaded = true
          if (activeIdRef.current === sessionId) syncActiveFromMemo(sessionId)
        } catch (error) {
          reportError(error, '加载会话失败')
        } finally {
          setLoadingSession(false)
        }
      }
      void refreshCtxUsage(sessionId)
    },
    [flush, getMemo, refreshCtxUsage, syncActiveFromMemo]
  )

  /* ------------------------------ 事件订阅 ------------------------------ */

  useEffect(() => {
    const dispose = mcal.onAgentEvent(({ sessionId, event }) => {
      const memo = getMemo(sessionId)
      const isActive = activeIdRef.current === sessionId
      switch (event.type) {
        case 'session_start': {
          memo.model = event.model
          if (isActive) setModel(event.model)
          break
        }
        case 'turn_start': {
          flush()
          finalizeAssistant(memo, false)
          setRunningIds((ids) => (ids.includes(sessionId) ? ids : [...ids, sessionId]))
          if (isActive) {
            setTimeline(memo.timeline.slice())
            setTodos(memo.todos)
          }
          break
        }
        case 'text_delta': {
          if (!memo.assistantId) {
            pushAssistant(memo)
            if (isActive) setTimeline(memo.timeline.slice())
          }
          memo.text += event.delta
          memo.dirty = true
          scheduleFlush()
          break
        }
        case 'reasoning_delta': {
          if (!memo.assistantId) {
            pushAssistant(memo)
            if (isActive) setTimeline(memo.timeline.slice())
          }
          memo.reasoning += event.delta
          memo.dirty = true
          scheduleFlush()
          break
        }
        case 'tool_call_start': {
          flush()
          const item: ToolItem = {
            kind: 'tool',
            id: nextId('t'),
            callId: event.call.id,
            name: event.call.name,
            args: event.call.arguments ?? '',
            status: 'running'
          }
          memo.timeline.push(item)
          memo.callIndex.set(event.call.id, item.id)
          if (event.call.arguments) memo.toolArgs.set(item.id, event.call.arguments)
          if (isActive) setTimeline(memo.timeline.slice())
          break
        }
        case 'tool_call_delta': {
          const toolId = memo.callIndex.get(event.id)
          if (toolId) {
            memo.toolArgs.set(toolId, (memo.toolArgs.get(toolId) ?? '') + event.delta)
            memo.dirty = true
            scheduleFlush()
          }
          break
        }
        case 'tool_result': {
          flush()
          const toolId = memo.callIndex.get(event.callId)
          const index = toolId ? memo.timeline.findIndex((item) => item.kind === 'tool' && item.id === toolId) : -1
          if (index >= 0) {
            const item = memo.timeline[index] as ToolItem
            const durationMs = typeof event.meta?.durationMs === 'number' ? event.meta.durationMs : undefined
            memo.timeline[index] = {
              ...item,
              args: memo.toolArgs.get(item.id) ?? item.args,
              status: event.ok ? 'ok' : 'fail',
              output: event.output,
              durationMs
            }
            memo.toolArgs.delete(item.id)
          }
          if (isActive) setTimeline(memo.timeline.slice())
          void refreshCtxUsage(sessionId)
          break
        }
        case 'permission_request': {
          setPermQueue((queue) => {
            if (queue.some((entry) => entry.request.id === event.request.id)) return queue
            const title = sessionsRef.current.find((item) => item.id === sessionId)?.title ?? '当前会话'
            return [...queue, { sessionId, sessionTitle: title, request: event.request }]
          })
          break
        }
        case 'usage': {
          memo.usage = {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            cachedTokens: event.cachedTokens
          }
          if (isActive) setUsage(memo.usage)
          break
        }
        case 'turn_end': {
          flush()
          finalizeAssistant(memo, false)
          if (isActive) setTimeline(memo.timeline.slice())
          void refreshCtxUsage(sessionId)
          break
        }
        case 'notice': {
          flush()
          memo.timeline.push({ kind: 'notice', id: nextId('n'), level: event.level, message: event.message })
          if (isActive) setTimeline(memo.timeline.slice())
          break
        }
        case 'compaction': {
          flush()
          memo.timeline.push({ kind: 'compaction', id: nextId('c'), removed: event.removed, summary: event.summary })
          if (isActive) setTimeline(memo.timeline.slice())
          void refreshCtxUsage(sessionId)
          break
        }
        case 'error': {
          flush()
          finalizeAssistant(memo, true)
          memo.timeline.push({ kind: 'error', id: nextId('e'), message: event.message, detail: event.detail })
          if (isActive) setTimeline(memo.timeline.slice())
          break
        }
        case 'session_end': {
          flush()
          finalizeAssistant(memo, event.reason === 'aborted' ? false : true)
          if (isActive) setTimeline(memo.timeline.slice())
          setRunningIds((ids) => ids.filter((id) => id !== sessionId))
          if (event.reason === 'aborted') {
            // 中止后挂起的授权请求已被主进程按拒绝处理，从队列里清掉
            setPermQueue((queue) => queue.filter((entry) => entry.sessionId !== sessionId))
          }
          void refreshCtxUsage(sessionId)
          break
        }
        case 'ui_event': {
          if (event.channel === 'todo' && Array.isArray(event.payload)) {
            const list = (event.payload as unknown[])
              .map((raw, index) => {
                const obj = (raw ?? {}) as Record<string, unknown>
                return {
                  id: typeof obj.id === 'string' ? obj.id : `todo_${index + 1}`,
                  content: String(obj.content ?? ''),
                  status: String(obj.status ?? 'pending'),
                  note: typeof obj.note === 'string' ? obj.note : undefined
                }
              })
              .filter((item) => item.content)
            memo.todos = list
            if (isActive) setTodos(list)
          }
          break
        }
        default:
          break
      }
    })
    return dispose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush, finalizeAssistant, getMemo, pushAssistant, refreshCtxUsage, scheduleFlush])

  /* ------------------------------ 初始加载 ------------------------------ */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await refreshSessions()
      if (cancelled) return
      const latest = list[0]
      if (latest) void selectSession(latest.id)
    })()
    void mcal
      .agentSkills()
      .then((list) => {
        if (!cancelled) setSkills(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [refreshSessions, selectSession])

  /* --------------------------- 导航参数：预填 prompt --------------------------- */

  useEffect(() => {
    const prompt = params.prompt
    if (typeof prompt === 'string' && prompt.trim()) {
      setInput(prompt)
      // 消费后立即清理，避免用户切走再回来时重复预填
      navigate('agent', {})
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        const el = textareaRef.current
        if (el) el.setSelectionRange(el.value.length, el.value.length)
      })
    }
  }, [params, navigate])

  /* ------------------------------ 发送 / 中止 ------------------------------ */

  const send = useCallback(
    async (text: string, atts?: ChatAttachment[], overrideSession?: string) => {
      const trimmed = text.trim()
      if (!trimmed && (!atts || atts.length === 0)) return
      let sessionId = overrideSession ?? activeIdRef.current
      try {
        if (!sessionId) {
          sessionId = await mcal.newAgentSession({})
          activeIdRef.current = sessionId
          setActiveSessionId(sessionId)
          getMemo(sessionId).loaded = true
        }
      } catch (error) {
        reportError(error, '创建会话失败')
        return
      }
      const memo = getMemo(sessionId)
      if (activeIdRef.current === sessionId) {
        finalizeAssistant(memo, true)
        const userItem: UserItem = { kind: 'user', id: nextId('u'), text: trimmed, attachments: atts }
        memo.timeline.push(userItem)
        pushAssistant(memo)
        setTimeline(memo.timeline.slice())
        setStick(true)
        stickRef.current = true
      } else {
        memo.timeline.push({ kind: 'user', id: nextId('u'), text: trimmed, attachments: atts })
      }
      lastUserRef.current = { text: trimmed, attachments: atts }
      setRunningIds((ids) => (sessionId && ids.includes(sessionId) ? ids : sessionId ? [...ids, sessionId] : ids))
      try {
        const contextHint = buildContextHint(instance)
        await mcal.sendAgentMessage({ sessionId, text: trimmed, attachments: atts, contextHint })
        void refreshSessions()
      } catch (error) {
        reportError(error, '发送失败')
        const memo2 = getMemo(sessionId)
        flush()
        finalizeAssistant(memo2, true)
        memo2.timeline.push({
          kind: 'error',
          id: nextId('e'),
          message: error instanceof Error ? error.message : String(error)
        })
        if (activeIdRef.current === sessionId) setTimeline(memo2.timeline.slice())
        setRunningIds((ids) => ids.filter((id) => id !== sessionId))
      }
    },
    [finalizeAssistant, flush, getMemo, instance, pushAssistant, refreshSessions]
  )
  useEffect(() => {
    sendRef.current = (text, atts, overrideSession) => {
      void send(text, atts, overrideSession)
    }
  }, [send])

  const handleSubmit = useCallback(() => {
    const payload = input
    const atts = attachments
    if (!payload.trim() && atts.length === 0) return
    setInput('')
    setAttachments([])
    void send(payload, atts.length > 0 ? atts : undefined)
  }, [attachments, input, send])

  const handleAbort = useCallback(async () => {
    const sessionId = activeIdRef.current
    if (!sessionId) return
    try {
      await mcal.abortAgent(sessionId)
      toast.info('已请求中止', '正在停止本轮生成与工具执行')
    } catch (error) {
      reportError(error, '中止失败')
    }
  }, [])

  const handleRetry = useCallback(() => {
    const last = lastUserRef.current
    if (!last) {
      toast.warn('没有可重试的消息', '先发送一条消息吧')
      return
    }
    sendRef.current(last.text, last.attachments)
  }, [])

  /* ------------------------------ 会话操作 ------------------------------ */

  const handleNewSession = useCallback(async () => {
    try {
      const id = await mcal.newAgentSession({})
      const memo = getMemo(id)
      memo.loaded = true
      activeIdRef.current = id
      setActiveSessionId(id)
      syncActiveFromMemo(id)
      setCtxUsage(null)
      void refreshSessions()
      requestAnimationFrame(() => textareaRef.current?.focus())
    } catch (error) {
      reportError(error, '新建会话失败')
    }
  }, [getMemo, refreshSessions, syncActiveFromMemo])

  const handleDeleteSession = useCallback(async () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    try {
      await mcal.deleteAgentSession(target.id)
      cacheRef.current.delete(target.id)
      if (activeIdRef.current === target.id) {
        activeIdRef.current = null
        setActiveSessionId(null)
        setTimeline([])
        setTodos([])
        setUsage(null)
        setCtxUsage(null)
      }
      const list = await refreshSessions()
      if (!activeIdRef.current && list[0]) void selectSession(list[0].id)
      toast.ok('会话已删除')
    } catch (error) {
      reportError(error, '删除会话失败')
    }
  }, [deleteTarget, refreshSessions, selectSession])

  /* ------------------------------ 授权响应 ------------------------------ */

  const respondPermission = useCallback(
    async (request: PermissionRequest, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => {
      setPermQueue((queue) => queue.filter((entry) => entry.request.id !== request.id))
      try {
        await mcal.respondPermission({ id: request.id, decision, scope })
        if (decision === 'deny') toast.info('已拒绝该操作', '助手不会自动重试，它会换一种方式')
      } catch (error) {
        reportError(error, '回应授权失败')
      }
    },
    []
  )

  /* ------------------------------ 附件处理 ------------------------------ */

  const addFiles = useCallback(async (files: { path?: string; file?: File }[]) => {
    const next: ChatAttachment[] = []
    for (const entry of files) {
      if (entry.path) {
        next.push(attachmentFromPath(entry.path))
      } else if (entry.file && entry.file.type.startsWith('image/')) {
        const dataUrl = await readAsDataUrl(entry.file)
        if (dataUrl) {
          next.push({
            id: nextId('att'),
            kind: 'image',
            name: entry.file.name,
            mimeType: entry.file.type,
            dataUrl,
            size: entry.file.size
          })
        }
      } else if (entry.file) {
        toast.warn('无法读取该文件的路径', `${entry.file.name}：请改用「添加附件」按钮选择文件`)
      }
    }
    if (next.length > 0) setAttachments((list) => [...list, ...next])
  }, [])

  const handlePickFiles = useCallback(async () => {
    const paths = await mcal
      .pickFile({
        title: '选择要引用给 AI 的文件（图片 / 日志 / 配置文件）',
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
          { name: '日志与配置', extensions: ['log', 'txt', 'json', 'toml', 'yml', 'yaml', 'properties', 'java', 'kt', 'js', 'ts'] },
          { name: '全部文件', extensions: ['*'] }
        ],
        multi: true
      })
      .catch((error: unknown) => {
        reportError(error, '选择文件失败')
        return null
      })
    if (!paths || paths.length === 0) return
    await addFiles(paths.map((path) => ({ path })))
  }, [addFiles])

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const entries: { path?: string; file?: File }[] = files.map((file) => {
        const withPath = file as File & { path?: string }
        return { path: withPath.path, file }
      })
      // 目录拖拽没有文件条目：dataTransfer.items 才能拿到目录，这里给出提示
      if (entries.length === 0) {
        toast.warn('没有识别到文件', '目录暂不支持拖拽，请把文件拖进来，或用「添加附件」按钮')
        return
      }
      void addFiles(entries)
    },
    [addFiles]
  )

  /* ------------------------------ 滚动策略 ------------------------------ */

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
    stickRef.current = atBottom
    setStick((previous) => (previous === atBottom ? previous : atBottom))
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [timeline])

  const jumpToLatest = useCallback(() => {
    stickRef.current = true
    setStick(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /* ------------------------------ 技能弹窗 ------------------------------ */

  const openSkill = useCallback(async (name: string) => {
    setSkillLoading(name)
    try {
      const content = await mcal.agentSkillRead(name)
      if (!content) {
        toast.warn('读取技能失败', `未找到技能 ${name}`)
        return
      }
      setSkillDetail(content)
    } catch (error) {
      reportError(error, '读取技能失败')
    } finally {
      setSkillLoading(null)
    }
  }, [])

  /* ------------------------------- 派生值 ------------------------------- */

  const busy = activeSessionId !== null && runningIds.includes(activeSessionId)
  const activeTitle = sessions.find((item) => item.id === activeSessionId)?.title ?? '新对话'
  const providers = settings?.providers ?? []
  const activeProvider = providers.find((item) => item.id === settings?.agent.activeProviderId) ?? providers[0]
  const providerReady =
    !!activeProvider &&
    (Boolean(activeProvider.apiKey) || /localhost|127\.0\.0\.1/i.test(activeProvider.baseUrl))

  const toolItems = useMemo(() => timeline.filter((item): item is ToolItem => item.kind === 'tool'), [timeline])

  const contextLine = instance
    ? `当前实例：${instance.name}（${instance.versionId || '未设置版本'} · ${loaderLabel(instance.loaderType)}）`
    : '当前没有游戏实例：可以先在「实例」页创建一个'

  /* -------------------------------- 渲染 -------------------------------- */

  return (
    <div className="page" style={{ animationName: 'none' }}>
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          height: '100%'
        }}
      >
        {/* ------------------------- 左栏：会话列表 ------------------------- */}
        {!leftCollapsed ? (
          <aside
            className="col"
            style={{
              width: 240,
              flexShrink: 0,
              borderRight: '1px solid var(--c-hairline)',
              background: 'rgba(10, 13, 20, 0.42)',
              minHeight: 0
            }}
          >
            <div className="col gap-3" style={{ padding: '14px 14px 10px' }}>
              <div className="row-between">
                <span className="fs-sm bold">对话</span>
                <div className="row gap-1">
                  <Tooltip content="收起会话列表">
                    <Button size="icon" variant="ghost" title="收起" icon={<IconChevronDown size={15} style={{ transform: 'rotate(90deg)' }} />} onClick={() => setLeftCollapsed(true)} />
                  </Tooltip>
                </div>
              </div>
              <Button block size="sm" variant="primary" icon={<IconPlus size={14} />} onClick={() => void handleNewSession()}>
                新建对话
              </Button>
            </div>
            <div className="grow scroll-y" style={{ padding: '0 10px 12px' }}>
              {sessions.length === 0 ? (
                <div className="fs-xs muted" style={{ padding: '10px 6px', lineHeight: 1.7 }}>
                  还没有历史对话。点击「新建对话」，或直接在右侧提问。
                </div>
              ) : (
                <div className="col gap-1 stagger">
                  {sessions.map((item) => (
                    <SessionRow
                      key={item.id}
                      title={item.title}
                      messageCount={item.messageCount}
                      updatedAt={item.updatedAt}
                      active={item.id === activeSessionId}
                      running={runningIds.includes(item.id)}
                      onSelect={() => void selectSession(item.id)}
                      onDelete={() => setDeleteTarget({ id: item.id, title: item.title })}
                    />
                  ))}
                </div>
              )}
            </div>
          </aside>
        ) : null}

        {/* ------------------------- 中栏：消息流 + 输入 ------------------------- */}
        <section className="col grow" style={{ minWidth: 0, minHeight: 0, position: 'relative' }}>
          <div
            className="row-between gap-3"
            style={{ padding: '12px 18px', borderBottom: '1px solid var(--c-hairline)', flexShrink: 0 }}
          >
            <div className="row gap-3" style={{ minWidth: 0 }}>
              {leftCollapsed ? (
                <Tooltip content="展开会话列表">
                  <Button size="icon" variant="ghost" title="展开会话列表" icon={<IconChevronRight size={15} />} onClick={() => setLeftCollapsed(false)} />
                </Tooltip>
              ) : null}
              <div className="col" style={{ minWidth: 0 }}>
                <div className="row gap-2">
                  <IconSparkles size={15} className="accent" />
                  <span className="fs-md bold truncate">{activeTitle}</span>
                  {busy ? <span className="mcal-spinner" style={{ width: 12, height: 12, borderWidth: 1.6 }} /> : null}
                </div>
                <div className="fs-xs muted truncate">
                  {model ? `模型：${model}` : '模型：未开始'}
                  {activeProvider && !providerReady ? ' · 未配置 API Key' : ''}
                </div>
              </div>
            </div>
            <div className="row gap-1">
              <Button
                size="icon"
                variant="ghost"
                title="新建对话"
                icon={<IconPlus size={15} />}
                onClick={() => void handleNewSession()}
              />
              {rightCollapsed ? (
                <Tooltip content="展开运行状态面板">
                  <Button size="icon" variant="ghost" title="展开运行面板" icon={<IconInfo size={15} />} onClick={() => setRightCollapsed(false)} />
                </Tooltip>
              ) : (
                <Tooltip content="收起运行状态面板">
                  <Button size="icon" variant="ghost" title="收起运行面板" icon={<IconInfo size={15} />} onClick={() => setRightCollapsed(true)} />
                </Tooltip>
              )}
            </div>
          </div>

          {!providerReady ? (
            <div
              className="row-between gap-3 anim-fade"
              style={{
                margin: '10px 18px 0',
                padding: '10px 12px',
                borderRadius: 'var(--r-md)',
                background: 'rgba(255, 157, 77, 0.1)',
                border: '1px solid rgba(255, 157, 77, 0.28)'
              }}
            >
              <div className="row gap-2">
                <IconAlert size={15} className="warn" />
                <span className="fs-sm">还没有可用的模型。填入任意服务商的 API Key 后即可开始对话（推荐 DeepSeek）。</span>
              </div>
              <Button size="sm" onClick={() => navigate('settings', { tab: 'ai' })}>
                去配置模型
              </Button>
            </div>
          ) : null}

          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="grow scroll-y"
            style={{ padding: '18px 18px 8px', minHeight: 0 }}
          >
            {timeline.length === 0 && !loadingSession ? (
              <WelcomePanel
                instanceName={instance?.name}
                onFill={(text) => {
                  setInput(text)
                  requestAnimationFrame(() => textareaRef.current?.focus())
                }}
              />
            ) : (
              <div className="col gap-4" style={{ maxWidth: 860, margin: '0 auto' }}>
                {timeline.map((item) => (
                  <TimelineRow key={item.id} item={item} onRetry={handleRetry} />
                ))}
                {loadingSession ? <div className="skeleton" style={{ height: 80 }} /> : null}
              </div>
            )}
          </div>

          {!stick ? (
            <button
              type="button"
              className="anim-pop"
              onClick={jumpToLatest}
              style={{
                position: 'absolute',
                right: 26,
                bottom: busy ? 168 : 148,
                zIndex: 5,
                padding: '6px 12px',
                borderRadius: 999,
                border: '1px solid var(--c-hairline-strong)',
                background: 'rgba(15,19,28,0.94)',
                boxShadow: 'var(--sh-lg)',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}
            >
              <IconChevronDown size={13} />
              回到最新
            </button>
          ) : null}

          {/* ------------------------- 输入区 ------------------------- */}
          <div style={{ flexShrink: 0, padding: '8px 18px 16px' }}>
            <div
              className="col gap-2"
              style={{ maxWidth: 860, margin: '0 auto' }}
              onDragOver={(event) => {
                event.preventDefault()
                if (!dragging) setDragging(true)
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                setDragging(false)
              }}
              onDrop={handleDrop}
            >
              {attachments.length > 0 ? (
                <div className="row gap-2 wrap">
                  {attachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={() => setAttachments((list) => list.filter((item) => item.id !== attachment.id))}
                    />
                  ))}
                </div>
              ) : null}

              <div
                className="mcal-card"
                style={{
                  padding: 10,
                  borderColor: dragging ? 'rgba(61,220,132,0.55)' : undefined,
                  boxShadow: dragging ? '0 0 0 3px rgba(61,220,132,0.14)' : undefined
                }}
              >
                <textarea
                  ref={textareaRef}
                  className="mcal-textarea"
                  value={input}
                  placeholder="描述你遇到的问题，或直接下达指令（Enter 发送 / Shift+Enter 换行）"
                  rows={1}
                  spellCheck={false}
                  style={{ minHeight: 44, maxHeight: 200, resize: 'none', border: 'none', background: 'transparent', padding: '6px 8px' }}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                      event.preventDefault()
                      handleSubmit()
                    }
                  }}
                  onInput={(event) => {
                    const el = event.currentTarget
                    el.style.height = 'auto'
                    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
                  }}
                />
                <div className="row-between gap-2" style={{ marginTop: 4, paddingLeft: 6 }}>
                  <div className="row gap-2" style={{ minWidth: 0 }}>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="添加附件（图片 / 日志 / 文件）"
                      icon={<IconFile size={15} />}
                      onClick={() => void handlePickFiles()}
                    />
                    <span className="fs-xs muted truncate" title={contextLine}>
                      {contextLine}
                    </span>
                  </div>
                  <div className="row gap-2">
                    {dragging ? <span className="fs-xs accent">松手即可引用文件</span> : null}
                    {busy ? (
                      <Button size="sm" variant="danger" icon={<IconStop size={13} />} onClick={() => void handleAbort()}>
                        停止
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<IconSend size={14} />}
                        disabled={!input.trim() && attachments.length === 0}
                        onClick={handleSubmit}
                      >
                        发送
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              <div className="fs-xs faint" style={{ paddingLeft: 4 }}>
                提示：图片可以直接拖进来做截图分析；危险操作（执行命令、删文件、装加载器）会先弹出授权确认。
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------- 右栏：运行状态 ------------------------- */}
        {!rightCollapsed ? (
          <aside
            className="col shrink-0"
            style={{
              width: 280,
              borderLeft: '1px solid var(--c-hairline)',
              background: 'rgba(10, 13, 20, 0.42)',
              minHeight: 0
            }}
          >
            <RuntimePanel
              model={model}
              ctxUsage={ctxUsage}
              usage={usage}
              tools={toolItems}
              todos={todos}
              skills={skills}
              skillLoading={skillLoading}
              onOpenSkill={(name) => void openSkill(name)}
              onRefreshUsage={() => {
                const id = activeIdRef.current
                if (id) void refreshCtxUsage(id)
              }}
            />
          </aside>
        ) : null}
      </div>

      {/* ------------------------- 授权弹窗（阻塞式） ------------------------- */}
      {permQueue.length > 0 ? (
        <PermissionDialog entry={permQueue[0]} pending={permQueue.length - 1} onRespond={respondPermission} />
      ) : null}

      {/* ------------------------- 技能详情弹窗 ------------------------- */}
      <Modal
        open={skillDetail !== null}
        onClose={() => setSkillDetail(null)}
        title={skillDetail ? `技能：${skillDetail.name}` : '技能'}
        wide
        footer={
          <Button onClick={() => setSkillDetail(null)}>关闭</Button>
        }
      >
        {skillDetail ? (
          <div className="col gap-3">
            <div className="fs-sm dim">{skillDetail.description}</div>
            <div className="row gap-2 wrap">
              {skillDetail.version ? <Badge tone="info">v{skillDetail.version}</Badge> : null}
              {skillDetail.author ? <Badge>{skillDetail.author}</Badge> : null}
              {skillDetail.allowedTools && skillDetail.allowedTools.length > 0 ? (
                <Badge tone="violet">仅限 {skillDetail.allowedTools.length} 个工具</Badge>
              ) : null}
            </div>
            {skillDetail.whenToUse ? (
              <div className="mcal-panel" style={{ padding: 12 }}>
                <div className="fs-xs muted" style={{ marginBottom: 4 }}>
                  何时使用
                </div>
                <div className="fs-sm">{skillDetail.whenToUse}</div>
              </div>
            ) : null}
            <Markdown content={skillDetail.body} />
            <div className="fs-xs faint break-all">{skillDetail.file}</div>
          </div>
        ) : null}
      </Modal>

      {/* ------------------------- 删除会话确认 ------------------------- */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="删除这个对话？"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => void handleDeleteSession()}>
              删除
            </Button>
          </>
        }
      >
        <div className="col gap-2">
          <div className="fs-md">「{deleteTarget?.title ?? ''}」的所有消息记录都会被删除，无法恢复。</div>
          <div className="fs-sm muted">如果只是想换个话题，建议直接新建对话，保留历史记录以备后续排查问题。</div>
        </div>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  会话行
 * ------------------------------------------------------------------ */

const SessionRow = memo(function SessionRow({
  title,
  messageCount,
  updatedAt,
  active,
  running,
  onSelect,
  onDelete
}: {
  title: string
  messageCount: number
  updatedAt: string
  active: boolean
  running: boolean
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 9px',
        borderRadius: 9,
        cursor: 'pointer',
        background: active ? 'rgba(61,220,132,0.13)' : hover ? 'rgba(255,255,255,0.045)' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px rgba(61,220,132,0.22)' : 'none',
        transition: 'background var(--t-fast) var(--ease-out)'
      }}
    >
      {running ? (
        <span className="mcal-spinner" style={{ width: 10, height: 10, borderWidth: 1.5, color: 'var(--c-verdant)' }} />
      ) : (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: active ? 'var(--c-verdant)' : 'var(--c-text-faint)'
          }}
        />
      )}
      <div className="col grow" style={{ minWidth: 0 }}>
        <span className="fs-sm truncate" title={title}>
          {title}
        </span>
        <span className="fs-xs muted">
          {messageCount} 条 · {formatRelativeTime(updatedAt)}
        </span>
      </div>
      {hover ? (
        <button
          type="button"
          title="删除对话"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
          style={{ color: 'var(--c-text-muted)', display: 'flex', padding: 3 }}
        >
          <IconTrash size={13} />
        </button>
      ) : null}
    </div>
  )
})

/* ------------------------------------------------------------------ *
 *  消息时间线渲染
 * ------------------------------------------------------------------ */

const TimelineRow = memo(function TimelineRow({
  item,
  onRetry
}: {
  item: TimelineItem
  onRetry: () => void
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />
    case 'assistant':
      return <AssistantBlock item={item} />
    case 'tool':
      return <ToolCard item={item} />
    case 'notice':
      return <NoticeBar item={item} />
    case 'compaction':
      return (
        <div className="row gap-2 fs-xs muted" style={{ justifyContent: 'center' }} title={item.summary}>
          <span style={{ height: 1, width: 40, background: 'var(--c-hairline)' }} />
          已压缩上下文：省略 {item.removed} 条历史消息
          <span style={{ height: 1, width: 40, background: 'var(--c-hairline)' }} />
        </div>
      )
    case 'error':
      return <ErrorCard item={item} onRetry={onRetry} />
    default:
      return null
  }
})

const UserBubble = memo(function UserBubble({ item }: { item: UserItem }): React.JSX.Element {
  return (
    <div className="col gap-2" style={{ alignItems: 'flex-end' }}>
      {item.attachments && item.attachments.length > 0 ? (
        <div className="row gap-2 wrap" style={{ justifyContent: 'flex-end' }}>
          {item.attachments.map((attachment) => (
            <AttachmentChip key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}
      <div
        className="selectable"
        style={{
          maxWidth: '82%',
          padding: '10px 14px',
          borderRadius: 'var(--r-lg)',
          borderTopRightRadius: 4,
          background: 'rgba(61, 220, 132, 0.1)',
          border: '1px solid rgba(61, 220, 132, 0.2)',
          borderLeft: '3px solid var(--c-verdant-deep)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 'var(--lh-relaxed)'
        }}
      >
        {item.text}
      </div>
    </div>
  )
})

const AssistantBlock = memo(function AssistantBlock({ item }: { item: AssistantItem }): React.JSX.Element | null {
  const [reasoningOpen, setReasoningOpen] = useState(item.streaming)
  useEffect(() => {
    setReasoningOpen(item.streaming)
  }, [item.streaming])

  const hasReasoning = item.reasoning.trim().length > 0
  const hasText = item.text.trim().length > 0

  if (!hasReasoning && !hasText && !item.streaming) return null
  if (!hasReasoning && !hasText && item.streaming) {
    return (
      <div className="row gap-2 fs-sm muted anim-fade">
        <span className="mcal-spinner" style={{ width: 12, height: 12, borderWidth: 1.6 }} />
        正在思考…
      </div>
    )
  }

  return (
    <div className="col gap-2">
      {hasReasoning ? (
        <div
          className="mcal-panel"
          style={{ background: 'rgba(177, 140, 255, 0.06)', borderColor: 'rgba(177, 140, 255, 0.18)' }}
        >
          <button
            type="button"
            className="row-between"
            style={{ width: '100%', padding: '8px 12px', textAlign: 'left' }}
            onClick={() => setReasoningOpen((open) => !open)}
          >
            <span className="row gap-2 fs-sm" style={{ color: 'var(--c-amethyst)' }}>
              <IconBrain size={14} />
              思考过程
              {item.streaming ? <span className="fs-xs muted">（进行中）</span> : null}
            </span>
            <IconChevronDown
              size={14}
              className="muted"
              style={{ transform: reasoningOpen ? 'none' : 'rotate(-90deg)', transition: 'transform var(--t-fast)' }}
            />
          </button>
          {reasoningOpen ? (
            <div
              className="selectable fs-sm dim"
              style={{
                padding: '0 12px 10px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 260,
                overflowY: 'auto',
                lineHeight: 'var(--lh-relaxed)'
              }}
            >
              {item.reasoning}
              {item.streaming ? <BlinkCursor /> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {hasText ? (
        <div>
          <Markdown content={item.text} />
          {item.streaming ? <BlinkCursor /> : null}
        </div>
      ) : null}
    </div>
  )
})

function BlinkCursor(): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 7,
        height: 14,
        marginLeft: 3,
        borderRadius: 2,
        background: 'var(--c-verdant)',
        animation: 'mcal-blink 1.1s steps(1, end) infinite',
        verticalAlign: '-2px'
      }}
    />
  )
}

const ToolCard = memo(function ToolCard({ item }: { item: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    // 失败的调用自动展开，让用户第一眼看到原因
    if (item.status === 'fail') setOpen(true)
  }, [item.status])

  const summary = summarizeArgs(item.args)
  const statusMeta =
    item.status === 'running'
      ? { tone: 'info' as const, text: '运行中' }
      : item.status === 'ok'
        ? { tone: 'ok' as const, text: '成功' }
        : item.status === 'fail'
          ? { tone: 'err' as const, text: '失败' }
          : { tone: 'default' as const, text: '已完成' }

  const output = item.output ?? ''
  const truncated = output.length > MAX_TOOL_OUTPUT
  const shown = truncated && !showAll ? output.slice(0, MAX_TOOL_OUTPUT) : output

  return (
    <div
      className="mcal-panel anim-fade"
      style={{
        padding: '8px 10px',
        borderColor: item.status === 'fail' ? 'rgba(255,95,109,0.32)' : undefined,
        background: item.status === 'fail' ? 'rgba(255,95,109,0.055)' : undefined
      }}
    >
      <button
        type="button"
        className="row gap-3"
        style={{ width: '100%', textAlign: 'left' }}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="center"
          style={{
            width: 24,
            height: 24,
            flexShrink: 0,
            borderRadius: 7,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--c-hairline)',
            color: item.status === 'fail' ? 'var(--c-redstone)' : 'var(--c-text-soft)'
          }}
        >
          {toolIcon(item.name, 13)}
        </span>
        <span className="grow col" style={{ minWidth: 0 }}>
          <span className="row gap-2">
            <span className="fs-sm bold">{toolLabel(item.name)}</span>
            <span className="fs-xs faint mono">{item.name}</span>
          </span>
          {summary ? <span className="fs-xs muted mono truncate" title={summary}>{summary}</span> : null}
        </span>
        <span className="row gap-2" style={{ flexShrink: 0 }}>
          {item.durationMs !== undefined ? <span className="fs-xs faint mono">{formatDurationMs(item.durationMs)}</span> : null}
          {item.status === 'running' ? (
            <span className="mcal-spinner" style={{ width: 12, height: 12, borderWidth: 1.6, color: 'var(--c-diamond)' }} />
          ) : (
            <Badge tone={statusMeta.tone}>{statusMeta.text}</Badge>
          )}
          <IconChevronDown
            size={14}
            className="muted"
            style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform var(--t-fast)' }}
          />
        </span>
      </button>

      {open ? (
        <div className="col gap-2" style={{ marginTop: 8 }}>
          <div>
            <div className="fs-xs muted" style={{ marginBottom: 4 }}>
              参数
            </div>
            <pre className="log-view selectable" style={{ margin: 0, maxHeight: 160 }}>
              {prettyJson(item.args) || '（无参数）'}
            </pre>
          </div>
          {output ? (
            <div>
              <div className="row-between" style={{ marginBottom: 4 }}>
                <span className="fs-xs muted">结果</span>
                {truncated ? (
                  <button type="button" className="fs-xs accent" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? '收起' : `展开全部（${formatNumber(output.length)} 字）`}
                  </button>
                ) : null}
              </div>
              <pre className="log-view selectable" style={{ margin: 0, maxHeight: 280 }}>
                {shown}
                {truncated && !showAll ? '\n…（已折叠，点击右上角展开全部）' : ''}
              </pre>
            </div>
          ) : item.status === 'running' ? (
            <div className="fs-xs muted">执行中…</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

const NoticeBar = memo(function NoticeBar({ item }: { item: NoticeItem }): React.JSX.Element {
  const meta: Record<NoticeItem['level'], { color: string; bg: string }> = {
    info: { color: 'var(--c-diamond)', bg: 'rgba(79,214,232,0.1)' },
    warn: { color: 'var(--c-ember)', bg: 'rgba(255,157,77,0.1)' },
    error: { color: 'var(--c-redstone)', bg: 'rgba(255,95,109,0.1)' },
    success: { color: 'var(--c-verdant)', bg: 'rgba(61,220,132,0.1)' }
  }
  const tone = meta[item.level]
  return (
    <div
      className="row-start gap-2 anim-fade"
      style={{ padding: '7px 12px', borderRadius: 'var(--r-md)', background: tone.bg, border: `1px solid ${tone.color}33` }}
    >
      <IconInfo size={13} style={{ color: tone.color, marginTop: 2, flexShrink: 0 }} />
      <span className="fs-sm selectable" style={{ lineHeight: 'var(--lh-normal)' }}>
        {item.message}
      </span>
    </div>
  )
})

const ErrorCard = memo(function ErrorCard({ item, onRetry }: { item: ErrorItem; onRetry: () => void }): React.JSX.Element {
  return (
    <div
      className="anim-rise"
      style={{
        padding: '12px 14px',
        borderRadius: 'var(--r-md)',
        background: 'rgba(255, 95, 109, 0.09)',
        border: '1px solid rgba(255, 95, 109, 0.3)',
        borderLeft: '3px solid var(--c-redstone)'
      }}
    >
      <div className="row-between gap-3">
        <div className="row gap-2">
          <IconAlert size={15} className="err" />
          <span className="fs-sm bold">出错了</span>
        </div>
        <Button size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
      <div className="fs-sm selectable" style={{ marginTop: 6, lineHeight: 'var(--lh-relaxed)' }}>
        {item.message}
      </div>
      {item.detail ? (
        <pre className="log-view selectable" style={{ marginTop: 8, maxHeight: 140 }}>
          {item.detail}
        </pre>
      ) : null}
    </div>
  )
})

/* ------------------------------------------------------------------ *
 *  欢迎区
 * ------------------------------------------------------------------ */

const CAPABILITIES = [
  { icon: <IconAlert size={16} />, title: '诊断崩溃', note: '读日志找根因' },
  { icon: <IconCube size={16} />, title: '装模组 / 整合包', note: '自动挑版本' },
  { icon: <IconImage size={16} />, title: '装光影', note: '含前置与设置' },
  { icon: <IconCode size={16} />, title: '开发 mod', note: '脚手架到构建' },
  { icon: <IconSparkles size={16} />, title: '生成贴图', note: '像素风美术' }
]

function WelcomePanel({
  instanceName,
  onFill
}: {
  instanceName?: string
  onFill: (text: string) => void
}): React.JSX.Element {
  const who = instanceName ? `实例「${instanceName}」` : '我的游戏'

  const quickPrompts: { title: string; note: string; prompt: string }[] = [
    {
      title: '诊断上次崩溃',
      note: '读最近的崩溃日志，给出修复步骤',
      prompt: `帮我分析${who}最近的崩溃日志，找出根本原因，并给出可执行的修复步骤。`
    },
    {
      title: '检查模组兼容性',
      note: '版本不匹配 / 缺前置 / 冲突',
      prompt: `检查${who}当前安装的模组列表，看看有没有版本不匹配、缺失前置（前置库）或互相冲突的模组，并给出处理建议。`
    },
    {
      title: '装一个光影',
      note: '按我的配置推荐并安装',
      prompt: `帮我给${who}安装一个适合当前电脑配置的光影包，说明需要哪些前置、如何开启（OptiFine / Iris 的区别也讲一下）。`
    },
    {
      title: '优化帧数',
      note: '从内存、模组、JVM 参数入手',
      prompt: `${who}帧数偏低（尤其是加载区块时）。帮我分析原因，并给出优化方案：该装哪些优化模组、内存和 JVM 参数怎么调。`
    },
    {
      title: '开发一个 mod',
      note: 'Fabric / NeoForge 脚手架 + 构建',
      prompt: `我想为 Minecraft 1.20.1 开发一个 Fabric 模组（先做一个能进游戏的自定义物品）。帮我生成项目脚手架，并说明构建、安装到实例的完整流程。`
    },
    {
      title: '生成一套物品贴图',
      note: '16x16 像素风，可直接进资源包',
      prompt: `帮我生成一套 Minecraft 风格的物品贴图（16x16 像素风，例如：铜锭、星辉碎片、蓝图卷轴），并告诉我怎么打包进资源包使用。`
    }
  ]

  return (
    <div className="col gap-6 anim-rise" style={{ maxWidth: 780, margin: '0 auto', paddingTop: 12 }}>
      <div className="col gap-3" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div
          className="center"
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: 'var(--g-aurora)',
            color: '#04140b',
            boxShadow: '0 6px 28px var(--c-verdant-glow)'
          }}
        >
          <IconSparkles size={26} />
        </div>
        <div className="fs-xl bold">我能帮你把 Minecraft 玩明白</div>
        <div className="fs-sm dim" style={{ maxWidth: 520, lineHeight: 'var(--lh-relaxed)' }}>
          我不只是聊天：可以读你的崩溃日志、扫描模组、安装版本与加载器、改配置、生成项目与贴图。
          危险操作会先请你确认。
        </div>
      </div>

      <div className="row gap-2 wrap" style={{ justifyContent: 'center' }}>
        {CAPABILITIES.map((capability) => (
          <div
            key={capability.title}
            className="row gap-2"
            style={{
              padding: '6px 12px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--c-hairline)'
            }}
          >
            <span className="accent" style={{ display: 'flex' }}>
              {capability.icon}
            </span>
            <span className="fs-sm">{capability.title}</span>
            <span className="fs-xs faint">{capability.note}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
        {quickPrompts.map((quick) => (
          <button
            key={quick.title}
            type="button"
            className="mcal-card mcal-card--interactive"
            style={{ padding: '12px 14px', textAlign: 'left' }}
            onClick={() => onFill(quick.prompt)}
          >
            <div className="row-between gap-2">
              <span className="fs-sm bold">{quick.title}</span>
              <IconChevronRight size={14} className="muted" />
            </div>
            <div className="fs-xs muted" style={{ marginTop: 4 }}>
              {quick.note}
            </div>
          </button>
        ))}
      </div>

      <div className="fs-xs faint" style={{ textAlign: 'center' }}>
        点击卡片会把问题填进输入框，确认后按 Enter 发送
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  右侧运行面板
 * ------------------------------------------------------------------ */

function RuntimePanel({
  model,
  ctxUsage,
  usage,
  tools,
  todos,
  skills,
  skillLoading,
  onOpenSkill,
  onRefreshUsage
}: {
  model: string
  ctxUsage: { tokens: number; window: number } | null
  usage: UsageInfo | null
  tools: ToolItem[]
  todos: TodoItem[]
  skills: SkillMeta[]
  skillLoading: string | null
  onOpenSkill: (name: string) => void
  onRefreshUsage: () => void
}): React.JSX.Element {
  const ratio = ctxUsage && ctxUsage.window > 0 ? ctxUsage.tokens / ctxUsage.window : 0
  const recentTools = tools.slice(-12).reverse()

  return (
    <div className="col gap-4 scroll-y" style={{ padding: '14px 14px 18px', minHeight: 0 }}>
      <div className="col gap-2">
        <div className="row-between">
          <span className="fs-sm bold">运行状态</span>
          <Button size="icon" variant="ghost" title="刷新统计" icon={<IconRefresh size={13} />} onClick={onRefreshUsage} />
        </div>
        <div className="row gap-2 wrap">
          <Badge tone={model ? 'info' : 'default'}>{model ? model : '未开始'}</Badge>
          {usage?.cachedTokens ? <Badge tone="violet">缓存命中 {formatNumber(usage.cachedTokens)}</Badge> : null}
        </div>
      </div>

      <div className="col gap-2">
        <div className="row-between fs-xs muted">
          <span>上下文占用</span>
          <span className="mono">
            {ctxUsage ? `${formatNumber(ctxUsage.tokens)} / ${formatNumber(ctxUsage.window)}` : '—'}
          </span>
        </div>
        <Progress value={ratio} tone={ratio > 0.85 ? 'warn' : 'ok'} />
        <div className="fs-xs faint">
          {ctxUsage
            ? `已用 ${(ratio * 100).toFixed(1)}%${ratio > 0.85 ? '，接近阈值时会自动压缩历史' : ''}`
            : '开始对话后显示估算占用'}
        </div>
        {usage ? (
          <div className="fs-xs muted">
            上次调用：输入 {formatNumber(usage.promptTokens ?? 0)} · 输出 {formatNumber(usage.completionTokens ?? 0)}
          </div>
        ) : null}
      </div>

      <div className="col gap-2">
        <div className="fs-sm bold">本轮工具调用</div>
        {recentTools.length === 0 ? (
          <div className="fs-xs muted">助手还没有调用工具</div>
        ) : (
          <div className="col gap-1">
            {recentTools.map((tool) => (
              <div key={tool.id} className="row gap-2 fs-xs" style={{ minWidth: 0 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background:
                      tool.status === 'running'
                        ? 'var(--c-diamond)'
                        : tool.status === 'fail'
                          ? 'var(--c-redstone)'
                          : 'var(--c-verdant)'
                  }}
                />
                <span className="grow truncate" title={tool.name}>
                  {toolLabel(tool.name)}
                </span>
                <span className="faint mono">{tool.durationMs !== undefined ? formatDurationMs(tool.durationMs) : '…'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="col gap-2">
        <div className="fs-sm bold">待办</div>
        {todos.length === 0 ? (
          <div className="fs-xs muted">复杂任务时，助手会在这里列出计划</div>
        ) : (
          <div className="col gap-1">
            {todos.map((todo) => (
              <div key={todo.id} className="row-start gap-2 fs-xs">
                <span
                  style={{
                    color:
                      todo.status === 'completed'
                        ? 'var(--c-verdant)'
                        : todo.status === 'in_progress'
                          ? 'var(--c-diamond)'
                          : 'var(--c-text-faint)'
                  }}
                >
                  {todo.status === 'completed' ? '☑' : todo.status === 'in_progress' ? '◐' : '☐'}
                </span>
                <span className={todo.status === 'completed' ? 'muted' : ''} style={{ lineHeight: 1.5 }}>
                  {todo.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="col gap-2">
        <div className="fs-sm bold">可用技能</div>
        {skills.length === 0 ? (
          <div className="fs-xs muted">未发现技能（可在设置中配置技能目录）</div>
        ) : (
          <div className="col gap-1">
            {skills.map((skill) => (
              <button
                key={skill.name}
                type="button"
                className="row-between gap-2"
                style={{
                  padding: '6px 8px',
                  borderRadius: 8,
                  textAlign: 'left',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--c-hairline)'
                }}
                onClick={() => onOpenSkill(skill.name)}
                title={skill.description}
              >
                <span className="col" style={{ minWidth: 0 }}>
                  <span className="fs-xs truncate">{skill.name}</span>
                  <span className="fs-xs faint truncate">{skill.description}</span>
                </span>
                {skillLoading === skill.name ? (
                  <span className="mcal-spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
                ) : (
                  <IconChevronRight size={13} className="muted" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  授权确认弹窗
 * ------------------------------------------------------------------ */

function PermissionDialog({
  entry,
  pending,
  onRespond
}: {
  entry: PermEntry
  pending: number
  onRespond: (request: PermissionRequest, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => void
}): React.JSX.Element {
  const { request } = entry
  const risk = RISK_META[request.risk]
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    setArmed(false)
  }, [request.id])

  const canSession = (request.scopes?.length ?? 0) === 0 || request.scopes.includes('session')
  const canAlways = request.scopes?.includes('always') ?? false

  const allowOnce = (): void => {
    if (request.risk === 'high' && !armed) {
      setArmed(true)
      return
    }
    onRespond(request, 'allow', 'once')
  }

  return (
    <Modal
      open
      wide
      closeOnOverlay={false}
      onClose={() => onRespond(request, 'deny', 'once')}
      title={
        <span className="row gap-2">
          <IconAlert size={16} className="warn" />
          需要你的授权
          {pending > 0 ? <Badge tone="warn">还有 {pending} 项待确认</Badge> : null}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onRespond(request, 'deny', 'once')}>
            拒绝
          </Button>
          {canAlways ? (
            <Button size="sm" variant="ghost" onClick={() => onRespond(request, 'allow', 'always')}>
              始终允许（不再询问）
            </Button>
          ) : null}
          {canSession ? (
            <Button onClick={() => onRespond(request, 'allow', 'session')}>本次会话允许</Button>
          ) : null}
          <Button variant={request.risk === 'high' ? 'danger' : 'primary'} onClick={allowOnce}>
            {request.risk === 'high' && !armed ? '仅本次允许（高风险）' : armed ? '再次点击确认执行' : '仅本次允许'}
          </Button>
        </>
      }
    >
      <div className="col gap-3">
        <div className="row-between gap-3 wrap">
          <div className="row gap-2">
            <span
              className="center"
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid var(--c-hairline)'
              }}
            >
              {toolIcon(request.toolName, 15)}
            </span>
            <div className="col">
              <span className="fs-md bold">{toolLabel(request.toolName)}</span>
              <span className="fs-xs faint mono">{request.toolName}</span>
            </div>
          </div>
          <div className="row gap-2">
            <Badge tone={risk.tone}>{risk.label}</Badge>
            <Badge>{entry.sessionTitle}</Badge>
          </div>
        </div>

        <div className="fs-md selectable" style={{ lineHeight: 'var(--lh-relaxed)' }}>
          {request.summary}
        </div>

        {request.detail ? (
          <div>
            <div className="fs-xs muted" style={{ marginBottom: 4 }}>
              详细信息
            </div>
            <pre className="log-view selectable" style={{ margin: 0, maxHeight: 220 }}>
              {request.detail}
            </pre>
          </div>
        ) : null}

        {request.risk === 'high' && armed ? (
          <div
            className="anim-fade"
            style={{
              padding: '9px 12px',
              borderRadius: 'var(--r-md)',
              background: 'rgba(255,95,109,0.12)',
              border: '1px solid rgba(255,95,109,0.35)'
            }}
          >
            <span className="fs-sm">
              这是高风险操作（可能修改或删除文件、执行命令）。确认后需要 <span className="bold">再次点击</span> 才会执行。
            </span>
          </div>
        ) : null}

        <div className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
          「本次会话允许」之后，同一个工具在本对话中不再询问；「始终允许」会记住该工具。拒绝后助手不会自动重试，
          它会向你说明原因并换一种方式。
          {request.denyMessage ? `（拒绝提示：${request.denyMessage}）` : ''}
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 *  附件
 * ------------------------------------------------------------------ */

const AttachmentChip = memo(function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: ChatAttachment
  onRemove?: () => void
}): React.JSX.Element {
  return (
    <span
      className="row gap-2 anim-fade"
      style={{
        padding: '4px 8px',
        borderRadius: 'var(--r-md)',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--c-hairline)',
        maxWidth: 240
      }}
      title={attachment.path ?? attachment.name}
    >
      {attachment.dataUrl && attachment.kind === 'image' ? (
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover' }}
        />
      ) : (
        <span className="muted" style={{ display: 'flex' }}>
          {attachment.kind === 'image' ? <IconImage size={13} /> : <IconFile size={13} />}
        </span>
      )}
      <span className="fs-xs truncate">{attachment.name}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} title="移除" style={{ display: 'flex', color: 'var(--c-text-muted)' }}>
          <IconClose size={12} />
        </button>
      ) : null}
    </span>
  )
})

/* ------------------------------------------------------------------ *
 *  历史消息 → 时间线
 * ------------------------------------------------------------------ */

function timelineFromMessages(messages: ChatMessage[]): TimelineItem[] {
  const out: TimelineItem[] = []
  const toolIndex = new Map<string, ToolItem>()
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({
        kind: 'user',
        id: message.id ?? nextId('u'),
        text: message.content ?? '',
        attachments: message.attachments
      })
      continue
    }
    if (message.role === 'assistant') {
      out.push({
        kind: 'assistant',
        id: message.id ?? nextId('a'),
        text: message.content ?? '',
        reasoning: '',
        streaming: false
      })
      for (const call of message.toolCalls ?? []) {
        const item: ToolItem = {
          kind: 'tool',
          id: `${message.id ?? 'm'}#${call.id}`,
          callId: call.id,
          name: call.name,
          args: call.arguments,
          status: 'done'
        }
        out.push(item)
        toolIndex.set(call.id, item)
      }
      continue
    }
    if (message.role === 'tool' && message.toolCallId) {
      const target = toolIndex.get(message.toolCallId)
      if (target) {
        const index = out.indexOf(target)
        if (index >= 0) {
          out[index] = { ...target, output: message.content ?? '' }
        }
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 *  小工具
 * ------------------------------------------------------------------ */

function buildContextHint(instance: { name: string; versionId: string; loaderType: string; gameDir: string; id: string } | undefined): string | undefined {
  if (!instance) {
    return '当前用户还没有创建游戏实例（instances 列表为空）。如果需要操作实例，先帮用户创建或询问他想要什么。'
  }
  return `当前用户正在查看实例「${instance.name}」（版本 ${instance.versionId || '未设置'}，加载器 ${loaderLabel(instance.loaderType)}，目录 ${instance.gameDir}，实例 id ${instance.id}）。涉及“我的实例/当前实例”时默认指它。`
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

function prettyJson(raw: string): string {
  const parsed = parseArgsJson(raw)
  if (!parsed) return raw.trim()
  try {
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

function attachmentFromPath(path: string): ChatAttachment {
  const name = path.split(/[\\/]/).pop() ?? path
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const mime = IMAGE_EXT_MIME[extension]
  return {
    id: nextId('att'),
    kind: mime ? 'image' : 'file',
    name,
    path,
    mimeType: mime
  }
}

function readAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(file)
  })
}
