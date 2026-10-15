/** 长时后台任务管理：下载、安装、导入导出等，统一上报进度供 UI 显示。 */

import { randomUUID } from 'node:crypto'
import type { DownloadProgress, TaskState } from '@shared/types'
import { logger } from '@core/util/logger'

const log = logger.scoped('tasks')

export class TaskManager {
  private tasks = new Map<string, TaskState>()
  private listeners = new Set<(task: TaskState) => void>()

  create(opts: { kind: string; label: string }): TaskState {
    const task: TaskState = {
      taskId: `task_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      kind: opts.kind,
      label: opts.label,
      state: 'running',
      startedAt: new Date().toISOString(),
      logs: []
    }
    this.tasks.set(task.taskId, task)
    this.emit(task)
    return task
  }

  update(taskId: string, patch: Partial<TaskState>): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    Object.assign(task, patch)
    this.emit(task)
  }

  progress(taskId: string, progress: DownloadProgress): void {
    this.update(taskId, { progress })
  }

  log(taskId: string, message: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.logs = [...(task.logs ?? []), `${new Date().toISOString().slice(11, 19)} ${message}`].slice(-200)
    this.emit(task)
  }

  complete(taskId: string, result?: unknown): void {
    this.update(taskId, { state: 'completed', result, endedAt: new Date().toISOString() })
    // 完成后保留一段时间，让 UI 有时间读取
    setTimeout(() => this.tasks.delete(taskId), 5 * 60 * 1000).unref?.()
  }

  fail(taskId: string, error: string): void {
    this.update(taskId, { state: 'failed', error, endedAt: new Date().toISOString() })
    log.warn(`任务失败 ${taskId}：${error}`)
    setTimeout(() => this.tasks.delete(taskId), 10 * 60 * 1000).unref?.()
  }

  cancel(taskId: string): void {
    this.update(taskId, { state: 'cancelled', endedAt: new Date().toISOString() })
  }

  list(): TaskState[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  onEvent(listener: (task: TaskState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(task: TaskState): void {
    for (const listener of this.listeners) {
      try {
        listener(task)
      } catch {
        /* 监听器异常不影响任务 */
      }
    }
  }

  /** 传递 Internals：cancellation hooks for long running operations */
  private cancels = new Map<string, () => void>()

  registerCancel(taskId: string, cancel: () => void): void {
    this.cancels.set(taskId, cancel)
  }

  invokeCancel(taskId: string): void {
    this.cancels.get(taskId)?.()
    this.cancels.delete(taskId)
    this.cancel(taskId)
  }
}
