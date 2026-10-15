/**
 * 下载器回归测试：全部走本地 HTTP 服务器，不访问外网。
 *
 * 这些用例对应的是真机上暴露过的问题：
 *  - 下载写入时 fd 有两个主人 → FileHandle 在 GC 时重复 close，报 EBADF 并写坏文件
 *  - 哈希不匹配后只报错不清理，坏 .part 被反复续传，永远校验不过
 *  - 服务端 416 时把残缺 .part 直接 rename 成成品
 *  - 失败任务在 KeyedLock 里变成无人处理的 Promise 拒绝
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AddressInfo } from 'node:net'
import { HttpClient, downloadWithFallback } from '@core/net/http'
import { DownloadManager } from '@core/net/downloader'
import { MirrorResolver } from '@core/net/mirror'
import { KeyedLock } from '@core/util/misc'
import type { DownloadItem } from '@shared/types'

const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex')

/** 全部走官方源：这些用例命中本地服务器，镜像映射用不上 */
const OFFICIAL_MIRROR = {
  mojang: 'official',
  forge: 'official',
  fabric: 'official',
  modrinth: 'official'
} as const

/** 可复现的伪随机内容；seed 不同则内容不同（用来构造“坏文件”） */
function randomBuffer(size: number, seed = 1): Buffer {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + seed * 131 + 13) % 251
  return buf
}

interface Route {
  /** 正常情况下返回的内容 */
  body: Buffer
  /** 是否支持 Range 请求 */
  supportRange?: boolean
  /** 无视 Range 一律返回 200 全量 */
  ignoreRange?: boolean
  /** 只发送这么多字节就断开（模拟提前断流） */
  truncateAt?: number
  /** 响应体的 content-length 与实际不同（模拟脏响应） */
  lieContentLength?: number
}

let server: Server
let baseUrl = ''
const routes = new Map<string, Route>()
let requestLog: { path: string; range?: string }[] = []

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]
    const range = req.headers.range as string | undefined
    requestLog.push({ path, range })
    const route = routes.get(path)
    if (!route) {
      res.statusCode = 404
      res.end('not found')
      return
    }

    const { body } = route
    let start = 0
    const match = /^bytes=(\d+)-$/.exec(range ?? '')
    if (match) {
      start = Number(match[1])
      if (!route.supportRange || route.ignoreRange) {
        // 不支持/忽略 Range：回退成 200 全量
        res.statusCode = 200
        res.setHeader('content-length', String(body.length))
        res.end(body)
        return
      }
      if (start >= body.length) {
        // 起点越界：真实服务器返回 416
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${body.length}`)
        res.end()
        return
      }
      const slice = body.subarray(start)
      res.statusCode = 206
      res.setHeader('content-length', String(slice.length))
      res.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`)
      res.end(slice)
      return
    }

    res.statusCode = 200
    const declared = route.lieContentLength ?? (route.truncateAt ? body.length : body.length)
    res.setHeader('content-length', String(declared))
    if (route.truncateAt !== undefined) {
      res.write(body.subarray(0, route.truncateAt))
      res.destroy()
      return
    }
    res.end(body)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  routes.clear()
  requestLog = []
})

let workDir = ''
function tmpDir(): string {
  if (!workDir) workDir = mkdtempSync(join(tmpdir(), 'mcal-dl-'))
  return workDir
}

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

function makeClient(): HttpClient {
  return new HttpClient({ retries: 2, timeoutMs: 10_000 })
}

/* ------------------------------------------------------------------ *
 *  基础下载
 * ------------------------------------------------------------------ */

describe('HttpClient.downloadToFile', () => {
  it('下载完整文件并落盘（不残留 .part）', async () => {
    const body = randomBuffer(256 * 1024)
    routes.set('/file.bin', { body })
    const dest = join(tmpDir(), 'basic/file.bin')

    const result = await makeClient().downloadToFile(`${baseUrl}/file.bin`, dest)
    expect(result.bytes).toBe(body.length)
    expect(readFileSync(dest).equals(body)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('断点续传：已有部分 .part 且服务端支持 Range', async () => {
    const body = randomBuffer(200 * 1024)
    routes.set('/resume.bin', { body, supportRange: true })
    const dest = join(tmpDir(), 'resume/file.bin')
    mkdirSync(dirname(dest), { recursive: true })
    // 预置前 80KB
    writeFileSync(`${dest}.part`, body.subarray(0, 80 * 1024))

    const result = await makeClient().downloadToFile(`${baseUrl}/resume.bin`, dest)
    expect(result.resumed).toBe(true)
    expect(readFileSync(dest).equals(body)).toBe(true)
    expect(requestLog.some((r) => r.range === `bytes=${80 * 1024}-`)).toBe(true)
  })

  it('服务端不支持 Range 时自动从零重下', async () => {
    const body = randomBuffer(120 * 1024)
    routes.set('/norange.bin', { body, supportRange: true, ignoreRange: true })
    const dest = join(tmpDir(), 'norange/file.bin')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(`${dest}.part`, body.subarray(0, 40 * 1024))

    await makeClient().downloadToFile(`${baseUrl}/norange.bin`, dest)
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  it('.part 比真文件还大时（416）不能把残缺文件当成成品', async () => {
    const body = randomBuffer(64 * 1024)
    routes.set('/bigger.bin', { body, supportRange: true })
    const dest = join(tmpDir(), 'bigger/file.bin')
    mkdirSync(dirname(dest), { recursive: true })
    // .part 比目标大：上一次写入被打断留下的垃圾
    writeFileSync(`${dest}.part`, Buffer.concat([body, randomBuffer(20 * 1024)]))

    await makeClient().downloadToFile(`${baseUrl}/bigger.bin`, dest, { expectedSize: body.length })
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  it('.part 与目标等大且服务端 416 时视为已完成（省一次全量下载）', async () => {
    const body = randomBuffer(48 * 1024)
    routes.set('/done.bin', { body, supportRange: true })
    const dest = join(tmpDir(), 'done/file.bin')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(`${dest}.part`, body)

    const result = await makeClient().downloadToFile(`${baseUrl}/done.bin`, dest, {
      expectedSize: body.length
    })
    expect(result.resumed).toBe(true)
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  it('响应被提前截断时抛错，不留下半成品', async () => {
    const body = randomBuffer(100 * 1024)
    routes.set('/truncated.bin', { body, truncateAt: 30 * 1024 })
    const dest = join(tmpDir(), 'truncated/file.bin')

    await expect(makeClient().downloadToFile(`${baseUrl}/truncated.bin`, dest)).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
  })

  it('verify 回调不通过时清掉 .part 并抛错', async () => {
    const body = randomBuffer(32 * 1024)
    routes.set('/badverify.bin', { body })
    const dest = join(tmpDir(), 'badverify/file.bin')

    await expect(
      makeClient().downloadToFile(`${baseUrl}/badverify.bin`, dest, { verify: async () => false })
    ).rejects.toThrow(/校验/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 *  并发写入：fd 不能再被两个主人共享
 * ------------------------------------------------------------------ */

describe('并发下载不会互相写坏文件', () => {
  it('16 个文件并发下载，内容与哈希全部正确', async () => {
    const manager = new DownloadManager({ client: makeClient(), mirror: new MirrorResolver(OFFICIAL_MIRROR) })
    const items: DownloadItem[] = []
    const expected = new Map<string, Buffer>()
    for (let i = 0; i < 16; i++) {
      const body = randomBuffer(64 * 1024 + i * 1024)
      routes.set(`/c${i}.bin`, { body })
      const dest = join(tmpDir(), `concurrent/f${i}.bin`)
      expected.set(dest, body)
      items.push({ key: `f${i}`, url: `${baseUrl}/c${i}.bin`, dest, sha1: sha1(body), size: body.length })
    }

    const result = await manager.runTask('concurrent', { label: '并发', items, concurrency: 8 })
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
    for (const [dest, body] of expected) {
      expect(readFileSync(dest).equals(body), `${dest} 内容被写坏`).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ *
 *  校验失败的自愈
 * ------------------------------------------------------------------ */

describe('DownloadManager：坏镜像与坏文件', () => {
  it('首个地址给出坏文件时自动换到下一个地址', async () => {
    const good = randomBuffer(80 * 1024, 7)
    routes.set('/bad.bin', { body: randomBuffer(80 * 1024, 99) }) // 同尺寸但内容不同 → 哈希必然不符
    routes.set('/good.bin', { body: good })

    const manager = new DownloadManager({ client: makeClient(), mirror: new MirrorResolver(OFFICIAL_MIRROR) })
    const dest = join(tmpDir(), 'fallback/file.bin')
    const item: DownloadItem = {
      key: 'fallback',
      url: `${baseUrl}/bad.bin`,
      fallbackUrls: [`${baseUrl}/good.bin`],
      dest,
      sha1: sha1(good),
      size: good.length
    }

    const result = await manager.downloadOne(item)
    expect(result.skipped).toBe(false)
    expect(readFileSync(dest).equals(good)).toBe(true)
  })

  it('已有坏文件时会清掉重下，而不是继续在坏数据上续传', async () => {
    const good = randomBuffer(96 * 1024)
    routes.set('/repair.bin', { body: good, supportRange: true })
    const dest = join(tmpDir(), 'repair/file.bin')
    mkdirSync(dirname(dest), { recursive: true })
    // 现存文件是坏的，且还有一个更大的垃圾 .part（旧实现会据此续传，永远修不好）
    writeFileSync(dest, randomBuffer(96 * 1024, 42))
    writeFileSync(`${dest}.part`, randomBuffer(120 * 1024, 43))

    const manager = new DownloadManager({ client: makeClient(), mirror: new MirrorResolver(OFFICIAL_MIRROR) })
    await manager.downloadOne({ key: 'repair', url: `${baseUrl}/repair.bin`, dest, sha1: sha1(good), size: good.length })
    expect(readFileSync(dest).equals(good)).toBe(true)
  })

  it('所有地址都给坏文件时报错，且不把坏文件留在磁盘上', async () => {
    const good = randomBuffer(16 * 1024, 5)
    routes.set('/always-bad.bin', { body: randomBuffer(16 * 1024, 77) })
    const dest = join(tmpDir(), 'alwaysbad/file.bin')

    const manager = new DownloadManager({ client: makeClient(), mirror: new MirrorResolver(OFFICIAL_MIRROR) })
    await expect(
      manager.downloadOne({ key: 'x', url: `${baseUrl}/always-bad.bin`, dest, sha1: sha1(good), size: good.length })
    ).rejects.toThrow(/校验失败/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 *  KeyedLock：失败任务不能产生无人处理的拒绝，队列表要能被回收
 * ------------------------------------------------------------------ */

describe('KeyedLock', () => {
  it('任务失败时不产生未处理的 Promise 拒绝', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const lock = new KeyedLock()
      await expect(lock.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
      // 交给事件循环一轮，让 unhandledRejection 有机会触发
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('前一个任务失败后，同一 key 的后续任务照常执行且串行', async () => {
    const lock = new KeyedLock()
    const order: string[] = []
    const first = lock.run('k', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('first')
      throw new Error('fail')
    })
    const second = lock.run('k', async () => {
      order.push('second')
      return 'ok'
    })
    await expect(first).rejects.toThrow('fail')
    await expect(second).resolves.toBe('ok')
    expect(order).toEqual(['first', 'second'])
  })
})

/* ------------------------------------------------------------------ *
 *  多地址回退
 * ------------------------------------------------------------------ */

describe('downloadWithFallback', () => {
  it('地址全部失败时抛出最后一个错误', async () => {
    routes.set('/ok.bin', { body: randomBuffer(1024) })
    await expect(
      downloadWithFallback(makeClient(), [`${baseUrl}/missing1`, `${baseUrl}/missing2`], join(tmpDir(), 'fb/x.bin'))
    ).rejects.toThrow()
  })
})
