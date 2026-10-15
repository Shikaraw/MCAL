/**
 * 主进程侧的更新服务：把 core/update 的纯逻辑接到 Electron 网络上。
 *
 * 两个关键点来自实战经验（同类项目在国内网络下的踩坑记录）：
 *  1. 直连 api.github.com 经常超时/被限流，所以默认走镜像前缀代理，逐个回退；
 *  2. 更新请求走**独立 session**，默认绕过系统代理（direct）。
 *     系统里挂着一个本地代理（Clash 之类）而上游节点已经挂掉时，走系统代理
 *     会让所有请求 ERR_CONNECTION_CLOSED，而镜像本身其实是通的。
 *     确实只能靠代理上网的用户，可以在设置里打开 useSystemProxy。
 */

import { app, session, shell } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BrowserWindow } from 'electron'
import type { UpdateAsset, UpdateCheckResult, UpdateDownloadResult } from '@shared/types'
import {
  DEFAULT_TIMEOUT_MS,
  checkForUpdate,
  resolveMirrors,
  type FetchLike,
  type UpdateCheckSettings
} from '@core/update'
import { ensureDir, sanitizeFileName } from '@core/util/fsx'
import { formatBytes } from '@core/util/misc'
import { logger } from '@core/util/logger'

const log = logger.scoped('update')

const UPDATE_PARTITION = 'persistent:mcal-update'
const USER_AGENT = 'MCAL-Updater'

let sessionProxyMode: boolean | null = null

/**
 * 更新专用 session：默认 direct（绕过系统代理），按设置切换。
 * 这里 await setProxy 之后再发请求：先发请求再切代理会有一段时间用着旧配置。
 * 设置失败不清缓存，下次调用会重试，而不是一直按错误的代理模式跑。
 */
async function updateSession(useSystemProxy: boolean): Promise<Electron.Session> {
  const ses = session.fromPartition(UPDATE_PARTITION)
  if (sessionProxyMode !== useSystemProxy) {
    await ses.setProxy(useSystemProxy ? { mode: 'system' } : { mode: 'direct' })
    sessionProxyMode = useSystemProxy
  }
  return ses
}

/**
 * 基于 Electron net 的抓取实现。
 * 用 net 而不是 Node 的 fetch，是因为只有前者能精确控制「走不走系统代理」。
 */
function createFetcher(useSystemProxy: boolean): FetchLike {
  return async (url, opts) => {
    const ses = await updateSession(useSystemProxy)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await ses.fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT
        }
      })
      const text = await response.text()
      return { status: response.status, text }
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export interface UpdateServiceOptions {
  getVersion: () => string
  getSettings: () => { update: UpdateCheckSettings }
  /** 把进度事件推给渲染进程 */
  emit: (event: UpdateEvent) => void
  getWindow: () => BrowserWindow | null
}

export type UpdateEvent =
  | { type: 'progress'; received: number; total: number; label: string }
  | { type: 'done'; file: string }
  /** 所有候选地址都失败：UI 需要靠它把「下载中」状态复位 */
  | { type: 'failed'; error: string }
  /** 启动时的静默检查结果：有新版本时 UI 弹提示条，没有时只用来同步「上次检查」时间 */
  | { type: 'available'; result: UpdateCheckResult }

/** 连接（含首字节）超时：镜像连上但不给数据时不能无限等 */
const CONNECT_TIMEOUT_MS = 30_000
/** 传输停滞超时：超过这么久没有新数据就换下一个地址 */
const STALL_TIMEOUT_MS = 30_000

/**
 * 下载地址白名单：只接受 https（或本机回环，方便调试）。
 * 这些地址来自经第三方镜像转发的 JSON，不能被直接信任到落盘。
 */
function isAcceptableDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  } catch {
    return false
  }
}

export class UpdateService {
  private readonly options: UpdateServiceOptions
  private lastCheck: UpdateCheckResult | null = null

  constructor(options: UpdateServiceOptions) {
    this.options = options
  }

  get lastResult(): UpdateCheckResult | null {
    return this.lastCheck
  }

  /** 检查更新（manual=false 时遵守 autoCheck 开关与「跳过此版本」） */
  async check(opts: { manual?: boolean } = {}): Promise<UpdateCheckResult> {
    const settings = this.options.getSettings()
    const result = await checkForUpdate({
      fetch: createFetcher(settings.update.useSystemProxy === true),
      settings,
      currentVersion: this.options.getVersion(),
      manual: opts.manual === true,
      timeoutMs: DEFAULT_TIMEOUT_MS
    })
    this.lastCheck = result
    log.info(
      result.ok
        ? `更新检查：当前 ${result.currentVersion}，最新 ${result.latestVersion ?? '未知'}（来源 ${result.source}，${result.hasUpdate ? '有更新' : '已是最新'}）`
        : `更新检查失败（${result.reason}）：${result.message}`
    )
    return result
  }

  /**
   * 下载更新资源。
   * 依次尝试镜像地址与原始地址；先写 .part 再改名，避免半成品被当成安装包。
   */
  async download(asset: UpdateAsset): Promise<UpdateDownloadResult> {
    const settings = this.options.getSettings()
    const useSystemProxy = settings.update.useSystemProxy === true
    const ses = await updateSession(useSystemProxy)

    const dir = join(app.getPath('downloads'), 'MCAL')
    await ensureDir(dir)
    const safeName = sanitizeFileName(asset.name)
    // 资源名极端情况下会被清空（例如 ".", ".."），退化到目录本身就会写错地方
    const target = join(dir, safeName && safeName !== '.' && safeName !== '..' ? safeName : 'MCAL-update.bin')
    const partPath = `${target}.part`

    const candidates = [...new Set([asset.mirrorUrl, asset.url].filter((url): url is string => !!url))].filter(
      (url) => isAcceptableDownloadUrl(url)
    )
    if (candidates.length === 0) {
      const error = '没有可用的下载地址（只允许 https，或本机回环地址）'
      this.options.emit({ type: 'failed', error })
      return { ok: false, error }
    }
    let lastError = ''

    for (const url of candidates) {
      lastError = ''
      const controller = new AbortController()
      let stallTimer: NodeJS.Timeout | null = null
      const armStallTimer = (): void => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          lastError = `传输停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒`
          controller.abort()
        }, STALL_TIMEOUT_MS)
        stallTimer.unref?.()
      }
      const connectTimer = setTimeout(() => {
        lastError = `连接超过 ${Math.round(CONNECT_TIMEOUT_MS / 1000)} 秒没有响应`
        controller.abort()
      }, CONNECT_TIMEOUT_MS)
      connectTimer.unref?.()

      try {
        this.options.emit({ type: 'progress', received: 0, total: asset.size, label: asset.name })
        const response = await ses.fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal
        })
        clearTimeout(connectTimer)
        if (!response.ok || !response.body) {
          lastError = `HTTP ${response.status}`
          log.warn(`更新包下载失败（${lastError}）：${url}`)
          continue
        }

        const total = Number(response.headers.get('content-length') ?? asset.size ?? 0)
        let received = 0
        let lastReport = 0
        const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
        // 计数放进管线中间，统计的就是真正落盘的字节；
        // 直接给 source 挂 'data' 监听会让它进入 flowing 模式，统计与实际写入容易错位
        const meter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            received += chunk.length
            const now = Date.now()
            armStallTimer()
            if (now - lastReport > 120) {
              lastReport = now
              this.options.emit({ type: 'progress', received, total, label: asset.name })
            }
            callback(null, chunk)
          }
        })
        armStallTimer()

        await pipeline(source, meter, createWriteStream(partPath, { flags: 'w' }))

        const info = await stat(partPath)
        if (asset.size > 0 && info.size !== asset.size) {
          lastError = `大小不符（期望 ${formatBytes(asset.size)}，实际 ${formatBytes(info.size)}）`
          log.warn(`更新包下载不完整：${url} —— ${lastError}`)
          continue
        }

        // 同名文件已存在时先删掉再改名，Windows 上 rename 覆盖已存在文件会失败
        await rm(target, { force: true }).catch(() => undefined)
        await rename(partPath, target)

        this.options.emit({ type: 'progress', received: info.size, total: info.size || asset.size, label: asset.name })
        this.options.emit({ type: 'done', file: target })
        log.info(`更新包已下载：${target}（${formatBytes(info.size)}）`)
        return { ok: true, file: target, bytes: info.size, url }
      } catch (err) {
        lastError = lastError || (err instanceof Error ? err.message : String(err))
        log.warn(`更新包下载异常：${url} —— ${lastError}`)
      } finally {
        clearTimeout(connectTimer)
        if (stallTimer) clearTimeout(stallTimer)
      }
    }

    await rm(partPath, { force: true }).catch(() => undefined)
    const error = lastError || '所有下载地址均失败'
    // 通知 UI 复位「下载中」状态，否则按钮会一直是禁用态
    this.options.emit({ type: 'failed', error })
    return { ok: false, error }
  }

  /** 在浏览器打开 Release 页面（只接受 GitHub 的 https 链接，链接来自镜像返回的 JSON） */
  async openRelease(url: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(String(url))
    } catch {
      throw new Error('无效的链接')
    }
    const host = parsed.hostname.toLowerCase()
    const trusted = host === 'github.com' || host === 'www.github.com' || host.endsWith('.githubusercontent.com')
    if (parsed.protocol !== 'https:' || !trusted) {
      throw new Error(`只允许打开 GitHub 上的 https 链接，已拒绝：${parsed.hostname}`)
    }
    await shell.openExternal(parsed.toString())
  }

  /** 供设置页展示：当前会依次尝试哪些更新源 */
  describeSources(): { id: string; name: string; note?: string }[] {
    const settings = this.options.getSettings()
    return resolveMirrors(settings.update).map((mirror) => ({
      id: mirror.id,
      name: mirror.name,
      note: mirror.note
    }))
  }

  /** 让「打开下载目录」可用 */
  async revealDownloaded(file: string): Promise<void> {
    await mkdir(join(app.getPath('downloads'), 'MCAL'), { recursive: true })
    shell.showItemInFolder(file)
  }
}
