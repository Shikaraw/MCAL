/**
 * 下载任务队列：并发控制、哈希校验、断点续传、进度汇总。
 * 这是所有安装流程（版本 / 库 / 资源 / 加载器 / 整合包）的统一入口。
 */

import { stat } from 'node:fs/promises'
import type { DownloadItem, DownloadProgress } from '@shared/types'
import { HttpClient, downloadWithFallback } from '@core/net/http'
import { MirrorResolver } from '@core/net/mirror'
import { formatBytes, formatSpeed, sha1OfFile, sha256OfFile, sleep } from '@core/util/misc'
import { KeyedLock, mapConcurrent } from '@core/util/misc'
import { ensureDir, fileSize, pathExists } from '@core/util/fsx'
import { dirname } from 'node:path'
import { logger } from '@core/util/logger'

const log = logger.scoped('download')

export interface DownloadTaskOptions {
  label: string
  items: DownloadItem[]
  concurrency?: number
  /** 完成后校验哈希 */
  verify?: boolean
  /** 遇到单个文件失败时是否继续 */
  continueOnError?: boolean
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadTaskResult {
  ok: boolean
  completed: number
  total: number
  bytes: number
  failures: { key: string; url: string; error: string }[]
  skipped: number
}

interface SpeedTracker {
  push(bytes: number): void
  speed(): number
}

function createSpeedTracker(windowMs = 3000): SpeedTracker {
  const samples: { t: number; bytes: number }[] = []
  return {
    push(bytes: number): void {
      const now = Date.now()
      samples.push({ t: now, bytes })
      while (samples.length > 0 && now - samples[0].t > windowMs) samples.shift()
    },
    speed(): number {
      if (samples.length === 0) return 0
      const now = Date.now()
      const first = samples[0]
      const elapsed = (now - first.t) / 1000
      if (elapsed <= 0.2) {
        const total = samples.reduce((acc, s) => acc + s.bytes, 0)
        return total / Math.max(0.2, elapsed)
      }
      const total = samples.reduce((acc, s) => acc + s.bytes, 0)
      return total / elapsed
    }
  }
}

export class DownloadManager {
  private client: HttpClient
  private mirror: MirrorResolver
  private defaultConcurrency: number
  private verifyHash: boolean
  private locks = new KeyedLock()
  private activeTasks = new Map<string, AbortController>()

  constructor(opts: { client: HttpClient; mirror: MirrorResolver; concurrency?: number; verifyHash?: boolean }) {
    this.client = opts.client
    this.mirror = opts.mirror
    this.defaultConcurrency = opts.concurrency ?? 16
    this.verifyHash = opts.verifyHash ?? true
  }

  configure(opts: { concurrency?: number; verifyHash?: boolean; speedLimitKB?: number }): void {
    if (opts.concurrency !== undefined) this.defaultConcurrency = opts.concurrency
    if (opts.verifyHash !== undefined) this.verifyHash = opts.verifyHash
    if (opts.speedLimitKB !== undefined) this.client.limiter.setLimit(opts.speedLimitKB)
  }

  get mirrorResolver(): MirrorResolver {
    return this.mirror
  }

  cancel(taskId: string): void {
    this.activeTasks.get(taskId)?.abort(new Error('任务被取消'))
  }

  cancelAll(): void {
    for (const controller of this.activeTasks.values()) controller.abort(new Error('任务被取消'))
    this.activeTasks.clear()
  }

  /** 校验一个已存在文件是否满足期望哈希 */
  async verifyFile(item: DownloadItem): Promise<boolean> {
    if (!item.sha1 && !item.sha256) return false
    if (!(await pathExists(item.dest))) return false
    const size = await fileSize(item.dest)
    if (item.size && size !== item.size) return false
    try {
      if (item.sha1) return (await sha1OfFile(item.dest)) === item.sha1.toLowerCase()
      if (item.sha256) return (await sha256OfFile(item.dest)) === item.sha256.toLowerCase()
    } catch {
      return false
    }
    return false
  }

  /** 单文件下载（带镜像回退与所需目录创建） */
  async downloadOne(item: DownloadItem, signal?: AbortSignal): Promise<{ bytes: number; skipped: boolean }> {
    return this.locks.run(item.dest, async () => {
      if (await pathExists(item.dest)) {
        if (item.skipIfExists) return { bytes: 0, skipped: true }
        if (!item.sha1 && !item.sha256) return { bytes: 0, skipped: true }
        if (await this.verifyFile(item)) return { bytes: 0, skipped: true }
        log.debug(`哈希不匹配，重新下载：${item.dest}`)
      }
      await ensureDir(dirname(item.dest))
      const urls = [item.url, ...(item.fallbackUrls ?? [])]
      const result = await downloadWithFallback(this.client, urls, item.dest, { signal, resume: true })

      if (this.verifyHash && (item.sha1 || item.sha256)) {
        const ok = await this.verifyFile(item)
        if (!ok) {
          const actualSize = await fileSize(item.dest)
          throw new Error(
            `文件校验失败：${item.dest}（大小 ${formatBytes(actualSize)}，期望 sha1=${item.sha1 ?? '-'}）`
          )
        }
      }
      return { bytes: result.bytes, skipped: false }
    })
  }

  /** 批量下载，返回汇总结果并持续上报进度 */
  async runTask(taskId: string, options: DownloadTaskOptions): Promise<DownloadTaskResult> {
    const controller = new AbortController()
    const outerSignal = options.signal
    const onOuterAbort = (): void => controller.abort(outerSignal?.reason)
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
    this.activeTasks.set(taskId, controller)

    const items = options.items
    const total = items.length
    const speed = createSpeedTracker()
    let completed = 0
    let skipped = 0
    let bytesDone = 0
    const failures: DownloadTaskResult['failures'] = []
    const knownSizes = new Map<string, number>()
    let bytesTotal = items.reduce((acc, item) => acc + (item.size ?? 0), 0)
    let lastReport = 0

    const report = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastReport < 120) return
      lastReport = now
      const currentSpeed = speed.speed()
      const remaining = Math.max(0, bytesTotal - bytesDone)
      const progress: DownloadProgress = {
        taskId,
        label: options.label,
        completed,
        total,
        bytesDone,
        bytesTotal,
        speed: currentSpeed,
        etaSeconds: currentSpeed > 1024 && bytesTotal > 0 ? remaining / currentSpeed : null,
        failures: failures.map((f) => ({ url: f.url, error: f.error })),
        state: controller.signal.aborted ? 'cancelled' : 'running'
      }
      options.onProgress?.(progress)
    }

    report(true)

    // 预扫描已存在文件，避免重复计算总量
    for (const item of items) {
      if (item.size) knownSizes.set(item.dest, item.size)
    }

    try {
      await mapConcurrent(
        items,
        options.concurrency ?? this.defaultConcurrency,
        async (item) => {
          if (controller.signal.aborted) throw new Error('任务被取消')
          try {
            const size = knownSizes.get(item.dest) ?? 0
            const result = await this.downloadOne(item, controller.signal)
            if (result.skipped) {
              skipped++
              bytesDone += size
            } else {
              bytesDone += result.bytes
              if (result.bytes > 0) speed.push(result.bytes)
            }
            completed++
            if (bytesTotal === 0 && item.size) bytesTotal += item.size
            report()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            failures.push({ key: item.key, url: item.url, error: message })
            log.warn(`下载失败 ${item.url}：${message}`)
            completed++
            if (!options.continueOnError) throw err
            report()
          }
        },
        controller.signal
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (failures.length === 0) failures.push({ key: 'task', url: '', error: message })
    } finally {
      outerSignal?.removeEventListener('abort', onOuterAbort)
      this.activeTasks.delete(taskId)
    }

    report(true)
    const ok = failures.length === 0 && !controller.signal.aborted
    options.onProgress?.({
      taskId,
      label: options.label,
      completed,
      total,
      bytesDone,
      bytesTotal,
      speed: 0,
      etaSeconds: null,
      failures: failures.map((f) => ({ url: f.url, error: f.error })),
      state: controller.signal.aborted ? 'cancelled' : ok ? 'completed' : 'failed'
    })

    log.info(
      `任务「${options.label}」结束：${completed}/${total} 文件，${formatBytes(bytesDone)}，失败 ${failures.length}，跳过 ${skipped}`
    )

    return { ok, completed, total, bytes: bytesDone, failures, skipped }
  }

  /** 便捷方法：直接构造一批下载项并执行 */
  async fetchFiles(
    taskId: string,
    label: string,
    items: DownloadItem[],
    opts: Partial<DownloadTaskOptions> = {}
  ): Promise<DownloadTaskResult> {
    return this.runTask(taskId, { label, items, ...opts })
  }

  /** 解析某文件的真实大小（用于进度预估） */
  async sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size
    } catch {
      return 0
    }
  }

  /** 生成可读的进度摘要（Agent 工具会用到） */
  static describeProgress(p: DownloadProgress): string {
    const parts = [
      `${p.completed}/${p.total} 文件`,
      formatBytes(p.bytesDone) + (p.bytesTotal > 0 ? ` / ${formatBytes(p.bytesTotal)}` : ''),
      formatSpeed(p.speed)
    ]
    if (p.etaSeconds !== null) parts.push(`剩余约 ${Math.ceil(p.etaSeconds)} 秒`)
    if (p.failures.length > 0) parts.push(`失败 ${p.failures.length}`)
    return parts.join(' · ')
  }
}

/** 为空目录做占位（部分加载器要求目录存在） */
export async function touchDirs(dirs: string[]): Promise<void> {
  for (const dir of dirs) await ensureDir(dir)
}

export { sleep }
