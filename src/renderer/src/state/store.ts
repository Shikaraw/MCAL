/** 全局状态（zustand）：设置、实例、运行中的游戏、任务、通知。 */

import { create } from 'zustand'
import type {
  Account,
  Instance,
  JavaRuntimeInfo,
  McalSettings,
  RunningGameInfo,
  ServerInstance,
  SystemInfo,
  TaskState
} from '@shared/types'
import { mcal } from '../lib/api'

/* ------------------------------- 通知 ------------------------------- */

export interface Toast {
  id: string
  level: 'ok' | 'warn' | 'err' | 'info'
  title: string
  description?: string
  /** 毫秒，0 表示不自动关闭 */
  duration?: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'>) => string
  dismiss: (id: string) => void
}

let toastSeq = 0

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = `toast_${++toastSeq}`
    const duration = toast.duration ?? (toast.level === 'err' ? 8000 : 3600)
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration)
    }
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
}))

/** 便捷函数：任何模块都能弹通知 */
export const toast = {
  ok: (title: string, description?: string) => useToasts.getState().push({ level: 'ok', title, description }),
  warn: (title: string, description?: string) => useToasts.getState().push({ level: 'warn', title, description }),
  err: (title: string, description?: string) => useToasts.getState().push({ level: 'err', title, description }),
  info: (title: string, description?: string) => useToasts.getState().push({ level: 'info', title, description })
}

/** 统一的错误提示：把异常变成可读通知 */
export function reportError(error: unknown, context?: string): void {
  const message = error instanceof Error ? error.message : String(error)
  toast.err(context ?? '操作失败', message)
}

/* ------------------------------- 设置 ------------------------------- */

interface SettingsState {
  settings: McalSettings | null
  loading: boolean
  error?: string
  load: () => Promise<McalSettings | null>
  update: (patch: Partial<McalSettings>) => Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,
  load: async () => {
    set({ loading: true, error: undefined })
    try {
      const settings = await mcal.getSettings()
      set({ settings, loading: false })
      applyTheme(settings)
      return settings
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  },
  update: async (patch) => {
    const previous = get().settings
    // 乐观更新：设置面板的开关必须立刻响应，否则手感很差
    if (previous) {
      const merged = { ...previous, ...patch } as McalSettings
      set({ settings: merged })
      applyTheme(merged)
    }
    try {
      const settings = await mcal.updateSettings(patch as never)
      set({ settings })
      applyTheme(settings)
    } catch (error) {
      if (previous) set({ settings: previous })
      reportError(error, '保存设置失败')
    }
  }
}))

/** 把设置里的主题项应用到 <html> */
export function applyTheme(settings: McalSettings | null): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const accent = settings?.launcher.accent
  if (accent) {
    root.style.setProperty('--c-verdant', accent)
    root.style.setProperty('--c-verdant-glow', hexToRgba(accent, 0.28))
  } else {
    root.style.removeProperty('--c-verdant')
    root.style.removeProperty('--c-verdant-glow')
  }
  root.dataset.motion = settings?.launcher.motion ?? 'full'
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return `rgba(61, 220, 132, ${alpha})`
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/* ------------------------------- 实例与运行状态 ------------------------------- */

interface InstanceState {
  instances: Instance[]
  running: RunningGameInfo[]
  servers: ServerInstance[]
  accounts: Account[]
  java: JavaRuntimeInfo[]
  activeInstanceId?: string
  loading: boolean
  refresh: () => Promise<void>
  setActive: (id: string) => void
  getActive: () => Instance | undefined
}

export const useInstances = create<InstanceState>((set, get) => ({
  instances: [],
  running: [],
  servers: [],
  accounts: [],
  java: [],
  loading: false,
  refresh: async () => {
    set({ loading: true })
    try {
      const [instances, running, servers, accounts, java] = await Promise.all([
        mcal.listInstances().catch(() => []),
        mcal.runningGames().catch(() => []),
        mcal.listServers().catch(() => []),
        mcal.listAccounts().catch(() => []),
        mcal.listJava().catch(() => [])
      ])
      const current = get().activeInstanceId
      const activeInstanceId = current && instances.some((i) => i.id === current) ? current : instances[0]?.id
      set({ instances, running, servers, accounts, java, activeInstanceId, loading: false })
    } catch {
      set({ loading: false })
    }
  },
  setActive: (id) => set({ activeInstanceId: id }),
  getActive: () => {
    const state = get()
    return state.instances.find((instance) => instance.id === state.activeInstanceId) ?? state.instances[0]
  }
}))

/* ------------------------------- 任务 ------------------------------- */

interface TaskState_ {
  tasks: TaskState[]
  init: () => void
  refresh: () => Promise<void>
}

export const useTasks = create<TaskState_>((set) => ({
  tasks: [],
  init: () => {
    // 长任务进度通过事件推送，避免轮询
    mcal.onTaskEvent((task) => {
      set((state) => {
        const others = state.tasks.filter((t) => t.taskId !== task.taskId)
        const next = [task, ...others]
        // 只保留最近 20 条以免列表无限增长
        return { tasks: next.slice(0, 20) }
      })
      if (task.state === 'completed') {
        toast.ok(`${task.label} 已完成`)
      } else if (task.state === 'failed') {
        toast.err(`${task.label} 失败`, task.error)
      }
    })
    void mcal.listTasks().then((tasks) => set({ tasks }))
  },
  refresh: async () => set({ tasks: await mcal.listTasks() })
}))

/* ------------------------------- 系统信息 ------------------------------- */

interface SystemState {
  info: SystemInfo | null
  version: { app: string; electron: string; node: string; chrome: string } | null
  load: () => Promise<void>
}

export const useSystem = create<SystemState>((set) => ({
  info: null,
  version: null,
  load: async () => {
    const [info, version] = await Promise.all([
      mcal.systemInfo().catch(() => null),
      mcal.versions().catch(() => null)
    ])
    set({ info, version })
  }
}))

/* ------------------------------- 视图路由 ------------------------------- */

export type ViewId =
  | 'home'
  | 'instances'
  | 'versions'
  | 'content'
  | 'modpack'
  | 'server'
  | 'java'
  | 'agent'
  | 'memory'
  | 'knowledge'
  | 'dev'
  | 'settings'

interface ViewState {
  view: ViewId
  /** 页面间跳转时携带的参数（例如从主页跳到内容页并选中某实例） */
  params: Record<string, unknown>
  navigate: (view: ViewId, params?: Record<string, unknown>) => void
}

export const useView = create<ViewState>((set) => ({
  view: 'home',
  params: {},
  navigate: (view, params) => set({ view, params: params ?? {} })
}))
