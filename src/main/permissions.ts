/**
 * 授权请求的等待表。
 *
 * Agent 在需要用户确认时（写文件、执行命令、启动游戏……）会挂起并等待；
 * UI 的响应通过 IPC 回来后在这里被投递。
 * 单独抽成模块是为了避免 main/index.ts 与 ipc.ts 之间的循环依赖。
 */

import type { PermissionResponse } from '@shared/types'
import { logger } from '@core/util/logger'

type Resolver = (response: PermissionResponse) => void

const pending = new Map<string, Resolver>()

/** 注册一个等待中的授权请求，返回取消等待的函数 */
export function registerPendingPermission(id: string, resolver: Resolver, timeoutMs = 10 * 60 * 1000): () => void {
  pending.set(id, resolver)
  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id)
      logger.warn('perm', `授权请求超时自动拒绝：${id}`)
      resolver({ id, decision: 'deny', scope: 'once' })
    }
  }, timeoutMs)
  timer.unref?.()
  return () => {
    clearTimeout(timer)
    pending.delete(id)
  }
}

/** UI 回传授权结果；返回是否命中了等待中的请求 */
export function resolvePendingPermission(response: PermissionResponse): boolean {
  const resolver = pending.get(response.id)
  if (!resolver) return false
  pending.delete(response.id)
  resolver(response)
  return true
}

export function hasPendingPermission(id: string): boolean {
  return pending.has(id)
}

/** 拒绝所有等待中的请求（应用退出/窗口关闭时） */
export function rejectAllPending(reason = '窗口已关闭'): void {
  for (const [id, resolver] of pending) {
    resolver({ id, decision: 'deny', scope: 'once' })
    logger.debug('perm', `拒绝待处理授权 ${id}：${reason}`)
  }
  pending.clear()
}

export function pendingCount(): number {
  return pending.size
}
