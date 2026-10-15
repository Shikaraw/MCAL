/**
 * 自动更新核心逻辑测试：全部使用假 fetch，绝不发起真实网络请求。
 *
 * 这些用例对应真机上暴露过的问题：
 *  - 国内直连 api.github.com 整体超时，必须按更新源逐个回退、命中即返回；
 *  - 仓库还没发版时 GitHub 返回 404，这是正常状态而不是错误；
 *  - 用户勾选「跳过此版本」后自动检查不再提示，但手动检查要如实报告；
 *  - 安装包推荐必须能注入平台，否则结果取决于 CI 跑在什么系统上。
 */

import { describe, expect, it } from 'vitest'
import {
  MIRROR_PRESETS,
  applyMirrorToAssetUrl,
  buildApiUrl,
  checkForUpdate,
  compareVersions,
  isNewer,
  isSameVersion,
  listReleases,
  normalizePrefix,
  parseRepoSlug,
  parseVersion,
  resolveMirrors,
  type CheckOptions,
  type FetchLike,
  type UpdateCheckSettings,
  type UpdatePlatform
} from '@core/update'

/* ------------------------------------------------------------------ *
 *  测试替身
 * ------------------------------------------------------------------ */

interface FetchCall {
  url: string
  timeoutMs: number
}

type FakeReply = { status: number; body: unknown } | { reject: string }

/** 假 fetch：由 handler 决定每次调用返回什么，所有请求记录在 calls 里 */
function makeFetch(handler: (url: string, index: number) => FakeReply): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl: FetchLike = async (url, opts) => {
    const index = calls.length
    calls.push({ url, timeoutMs: opts.timeoutMs })
    const reply = handler(url, index)
    if ('reject' in reply) throw new Error(reply.reject)
    return { status: reply.status, text: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) }
  }
  return { fetchImpl, calls }
}

/** 恒定成功的假 fetch */
function alwaysRelease(release: Record<string, unknown> = sampleRelease()): { fetchImpl: FetchLike; calls: FetchCall[] } {
  return makeFetch(() => ({ status: 200, body: release }))
}

const REPO = 'Shikaraw/MinecraftAgentLauncher'
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download/v0.2.0`
const LATEST_PATH = `/repos/${REPO}/releases/latest`

const BASE_UPDATE = {
  autoCheck: true,
  source: 'mirror' as const,
  mirrorId: 'ghproxy',
  useSystemProxy: false,
  repo: REPO
}

const WINDOWS_X64: UpdatePlatform = { os: 'windows', arch: 'x64' }

/** 覆盖 Windows 三种候选 + 一个平台无关的更新元数据文件 */
const SAMPLE_ASSETS = [
  { name: 'MCAL Setup 0.1.0.exe', size: 82_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL%20Setup%200.1.0.exe` },
  { name: 'MCAL 0.1.0.exe', size: 78_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0.exe` },
  { name: 'latest.yml', size: 431, browser_download_url: `${DOWNLOAD_BASE}/latest.yml` },
  { name: 'MCAL-0.1.0.dmg', size: 95_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0.dmg` }
]

function sampleRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.2.0',
    name: 'MCAL 0.2.0',
    html_url: `https://github.com/${REPO}/releases/tag/v0.2.0`,
    body: '本次更新：修复若干问题。',
    published_at: '2026-10-01T03:00:00Z',
    prerelease: false,
    assets: SAMPLE_ASSETS,
    ...overrides
  }
}

function makeOptions(fetchImpl: FetchLike, overrides: Partial<UpdateCheckSettings> = {}): CheckOptions {
  return {
    fetch: fetchImpl,
    settings: { update: { ...BASE_UPDATE, ...overrides } },
    currentVersion: '0.1.0'
  }
}

/* ------------------------------------------------------------------ *
 *  前缀规范化
 * ------------------------------------------------------------------ */

describe('normalizePrefix：更新源前缀规范化', () => {
  it('三种写法统一为带协议且以斜杠结尾', () => {
    expect(normalizePrefix('gh-proxy.com')).toBe('https://gh-proxy.com/')
    expect(normalizePrefix('https://gh-proxy.com')).toBe('https://gh-proxy.com/')
    expect(normalizePrefix('https://gh-proxy.com/')).toBe('https://gh-proxy.com/')
  })

  it('空输入与纯空白返回空字符串', () => {
    expect(normalizePrefix('')).toBe('')
    expect(normalizePrefix('   ')).toBe('')
  })

  it('保留用户显式给出的协议，并清理多余斜杠与空白', () => {
    expect(normalizePrefix('  http://example.com/proxy  ')).toBe('http://example.com/proxy/')
    expect(normalizePrefix('https://gh-proxy.com//')).toBe('https://gh-proxy.com/')
  })
})

describe('MIRROR_PRESETS：预设顺序', () => {
  it('按可靠性排列，direct 用空前缀且固定最后兜底', () => {
    expect(MIRROR_PRESETS.map((m) => m.id)).toEqual(['ghproxy', 'ghfast', 'llkk', 'moeyy', 'direct'])
    expect(MIRROR_PRESETS.at(-1)!.prefix).toBe('')
    expect(MIRROR_PRESETS.every((m) => m.note)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  更新源解析
 * ------------------------------------------------------------------ */

describe('resolveMirrors：更新源解析', () => {
  it('direct 只返回官方直连（空前缀）', () => {
    const mirrors = resolveMirrors({ source: 'direct' })
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0].id).toBe('direct')
    expect(mirrors[0].prefix).toBe('')
  })

  it('custom 使用规范化后的自定义前缀，且只返回一个源', () => {
    const mirrors = resolveMirrors({ source: 'custom', customPrefix: 'gh-proxy.com' })
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0]).toMatchObject({ id: 'custom', prefix: 'https://gh-proxy.com/' })
  })

  it('custom 但没填前缀时回退到镜像列表（而不是空列表）', () => {
    const mirrors = resolveMirrors({ source: 'custom', customPrefix: '  ', mirrorId: 'ghfast' })
    expect(mirrors[0].id).toBe('ghfast')
    expect(mirrors.at(-1)!.id).toBe('direct')
  })

  it('mirror 模式下用户选的排第一，其余镜像回退，direct 最后', () => {
    const mirrors = resolveMirrors({ source: 'mirror', mirrorId: 'llkk' })
    const ids = mirrors.map((m) => m.id)
    expect(ids[0]).toBe('llkk')
    expect(ids.at(-1)).toBe('direct')
    expect(ids).toHaveLength(MIRROR_PRESETS.length)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(undefined)
    // 其余镜像都要在 direct 之前
    expect(ids.indexOf('direct')).toBe(ids.length - 1)
  })

  it('未指定 mirrorId 时默认用 ghproxy', () => {
    const mirrors = resolveMirrors({ source: 'mirror' })
    expect(mirrors[0].id).toBe('ghproxy')
  })
})

describe('buildApiUrl / applyMirrorToAssetUrl：地址改写', () => {
  it('buildApiUrl 把镜像前缀拼在官方 API 地址之前', () => {
    const mirror = MIRROR_PRESETS[0]
    expect(buildApiUrl(mirror, '/repos/o/r/releases/latest')).toBe(
      'https://gh-proxy.com/https://api.github.com/repos/o/r/releases/latest'
    )
  })

  it('buildApiUrl 在 direct 下就是官方地址本身', () => {
    const direct = MIRROR_PRESETS.find((m) => m.id === 'direct')!
    expect(buildApiUrl(direct, '/repos/o/r/releases/latest')).toBe('https://api.github.com/repos/o/r/releases/latest')
  })

  it('applyMirrorToAssetUrl 有前缀时改写，空前缀时原样返回', () => {
    const download = 'https://github.com/o/r/releases/download/v1/app.exe'
    expect(applyMirrorToAssetUrl(MIRROR_PRESETS[0], download)).toBe(`https://gh-proxy.com/${download}`)
    const direct = MIRROR_PRESETS.find((m) => m.id === 'direct')!
    expect(applyMirrorToAssetUrl(direct, download)).toBe(download)
  })
})

/* ------------------------------------------------------------------ *
 *  版本比较
 * ------------------------------------------------------------------ */

describe('parseVersion / compareVersions / isNewer', () => {
  it('parseVersion 容忍 v 前缀与不完整段数', () => {
    expect(parseVersion('v0.2.0')).toMatchObject({ major: 0, minor: 2, patch: 0 })
    expect(parseVersion('1.2')).toMatchObject({ major: 1, minor: 2, patch: 0 })
  })

  it('parseVersion 解析预发布后缀但不改变数字段', () => {
    expect(parseVersion('1.0.0-beta.1')).toMatchObject({ major: 1, minor: 0, patch: 0, extra: 'beta.1' })
  })

  it('parseVersion 无法解析时返回 null', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('v1.x.0')).toBeNull()
  })

  it('compareVersions 按数字逐段比较（1.0.10 > 1.0.9）', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
    expect(compareVersions('1.1.0', '1.0.99')).toBe(1)
  })

  it('v 前缀与 -beta 后缀不影响比较', () => {
    expect(compareVersions('v0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.9', 'v0.2.0')).toBe(-1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('无法解析时 compareVersions 返回 0，isNewer 判定为否', () => {
    expect(compareVersions('abc', '1.0.0')).toBe(0)
    expect(isNewer('abc', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', 'abc')).toBe(false)
  })

  it('isNewer 基本判定', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
  })

  it('isSameVersion 忽略 v 前缀与后缀差异', () => {
    expect(isSameVersion('v0.2.0', '0.2.0')).toBe(true)
    expect(isSameVersion('0.2.0', '0.2.1')).toBe(false)
    expect(isSameVersion('', '0.2.0')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 *  仓库解析
 * ------------------------------------------------------------------ */

describe('parseRepoSlug：仓库解析', () => {
  it('接受 owner/repo，并容忍完整地址与 .git 后缀', () => {
    expect(parseRepoSlug('a/b')?.slug).toBe('a/b')
    expect(parseRepoSlug('https://github.com/Shikaraw/MinecraftAgentLauncher')?.slug).toBe(REPO)
    expect(parseRepoSlug('a/b.git')?.slug).toBe('a/b')
  })

  it('不含斜杠或为空时返回 null', () => {
    expect(parseRepoSlug('abc')).toBeNull()
    expect(parseRepoSlug('')).toBeNull()
    expect(parseRepoSlug('a/b/c')).toBeNull()
  })

  it('拒绝只由点组成的段（会被 URL 规范化换成另一个地址）', () => {
    expect(parseRepoSlug('../x')).toBeNull()
    expect(parseRepoSlug('a/..')).toBeNull()
    expect(parseRepoSlug('../../x')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 *  检查更新：源回退
 * ------------------------------------------------------------------ */

describe('checkForUpdate：更新源回退', () => {
  it('首个源超时后自动使用下一个源，并记录失败原因', async () => {
    const { fetchImpl, calls } = makeFetch((url, index) =>
      index === 0 ? { reject: '请求超时' } : { status: 200, body: sampleRelease() }
    )
    const result = await checkForUpdate(makeOptions(fetchImpl))

    expect(result.ok).toBe(true)
    expect(result.sourceId).toBe('ghfast')
    expect(result.source).toBe('ghfast.top')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0].source).toBe('gh-proxy.com')
    expect(result.attempts[0].error).toContain('超时')
    expect(result.attempts[0].statusCode).toBeUndefined()
    expect(calls[0].url).toBe(`https://gh-proxy.com/https://api.github.com${LATEST_PATH}`)
    expect(calls[1].url.startsWith('https://ghfast.top/https://api.github.com')).toBe(true)
  })

  it('默认超时 12 秒，可用 timeoutMs 覆盖', async () => {
    const { fetchImpl, calls } = alwaysRelease()
    await checkForUpdate(makeOptions(fetchImpl))
    expect(calls[0].timeoutMs).toBe(12_000)

    const overriding = alwaysRelease()
    await checkForUpdate({ ...makeOptions(overriding.fetchImpl), timeoutMs: 800 })
    expect(overriding.calls[0].timeoutMs).toBe(800)
  })

  it('响应不是合法 JSON 时也继续尝试下一个源', async () => {
    const { fetchImpl } = makeFetch((url, index) =>
      index === 0 ? { status: 200, body: '<html>502 Bad Gateway</html>' } : { status: 200, body: sampleRelease() }
    )
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.ok).toBe(true)
    expect(result.attempts[0].error).toContain('JSON')
  })
})

/* ------------------------------------------------------------------ *
 *  检查更新：失败原因
 * ------------------------------------------------------------------ */

describe('checkForUpdate：失败原因', () => {
  it('所有源都 404 → no-release（正常状态，不是错误）', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 404, body: { message: 'Not Found' } }))
    const result = await checkForUpdate(makeOptions(fetchImpl))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no-release')
    expect(result.hasUpdate).toBeUndefined()
    expect(result.attempts).toHaveLength(MIRROR_PRESETS.length)
    expect(calls).toHaveLength(MIRROR_PRESETS.length)
    expect(result.attempts.every((a) => a.statusCode === 404)).toBe(true)
    expect(result.message).toContain('还没有发布')
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('全部源网络失败 → network', async () => {
    const { fetchImpl } = makeFetch(() => ({ reject: '无法解析域名' }))
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
    expect(result.attempts).toHaveLength(MIRROR_PRESETS.length)
    expect(result.message).toContain('设置')
  })

  it('只有一个源返回 404、其余网络失败 → network（镜像没代理到不等于仓库没发版）', async () => {
    const { fetchImpl } = makeFetch((_url, index) =>
      index === 0 ? { status: 404, body: { message: 'Not Found' } } : { reject: '连接被重置' }
    )
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
    expect(result.message).toContain('404')
    expect(result.message).not.toContain('还没有发布任何 Release，暂无可更新')
  })

  it('repo 不含斜杠 → bad-repo 且不发起任何请求', async () => {
    const { fetchImpl, calls } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl, { repo: 'abc' }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad-repo')
    expect(result.repo).toBe('abc')
    expect(result.attempts).toEqual([])
    expect(calls).toHaveLength(0)
    expect(result.message).toContain('owner/repo')
  })

  it('repo 为空 → bad-repo', async () => {
    const { fetchImpl, calls } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl, { repo: '  ' }))
    expect(result.reason).toBe('bad-repo')
    expect(calls).toHaveLength(0)
  })

  it('自动检查关闭且非手动 → disabled，不发起请求', async () => {
    const { fetchImpl, calls } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl, { autoCheck: false }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('disabled')
    expect(calls).toHaveLength(0)
  })

  it('自动检查关闭时手动检查照常执行', async () => {
    const { fetchImpl, calls } = alwaysRelease()
    const result = await checkForUpdate({ ...makeOptions(fetchImpl, { autoCheck: false }), manual: true })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 *  检查更新：版本判定
 * ------------------------------------------------------------------ */

describe('checkForUpdate：版本判定', () => {
  it('latest > current → hasUpdate，字段齐全', async () => {
    const { fetchImpl } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl))

    expect(result.ok).toBe(true)
    expect(result.repo).toBe(REPO)
    expect(result.currentVersion).toBe('0.1.0')
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.tagName).toBe('v0.2.0')
    expect(result.hasUpdate).toBe(true)
    expect(result.prerelease).toBe(false)
    expect(result.publishedAt).toBe('2026-10-01T03:00:00Z')
    expect(result.notes).toContain('本次更新')
    expect(result.releaseUrl).toContain('/releases/tag/v0.2.0')
    expect(result.assets).toHaveLength(SAMPLE_ASSETS.length)
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('latest == current → 不提示更新', async () => {
    const { fetchImpl } = alwaysRelease(sampleRelease({ tag_name: 'v0.1.0' }))
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(false)
    expect(result.skipped).toBe(false)
  })

  it('latest < current（本地领先）→ 不提示更新', async () => {
    const { fetchImpl } = alwaysRelease(sampleRelease({ tag_name: 'v0.0.9' }))
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.hasUpdate).toBe(false)
  })

  it('tag_name 缺失时用 name 兜底', async () => {
    const { fetchImpl } = alwaysRelease(sampleRelease({ tag_name: undefined, name: 'v0.2.0' }))
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.tagName).toBe('v0.2.0')
    expect(result.hasUpdate).toBe(true)
  })

  it('assets / published_at 等字段缺失时不崩溃', async () => {
    const { fetchImpl } = alwaysRelease({ tag_name: 'v0.2.0' })
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.ok).toBe(true)
    expect(result.assets).toEqual([])
    expect(result.notes).toBe('')
    expect(result.publishedAt).toBeNull()

    const nullAssets = alwaysRelease(sampleRelease({ assets: null }))
    const second = await checkForUpdate(makeOptions(nullAssets.fetchImpl))
    expect(second.assets).toEqual([])
  })

  it('完全没有版本号信息的响应视为坏响应，切下一个源', async () => {
    const { fetchImpl } = makeFetch((url, index) =>
      index === 0 ? { status: 200, body: { message: 'unknown' } } : { status: 200, body: sampleRelease() }
    )
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.sourceId).toBe('ghfast')
    expect(result.attempts[0].error).toContain('tag_name')
  })

  it('notes 超长时截断到 8000 字符', async () => {
    const { fetchImpl } = alwaysRelease(sampleRelease({ body: 'x'.repeat(12_000) }))
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.notes).toHaveLength(8000)
  })
})

/* ------------------------------------------------------------------ *
 *  检查更新：跳过版本
 * ------------------------------------------------------------------ */

describe('checkForUpdate：跳过此版本', () => {
  it('命中跳过版本（非手动）→ ok 仍为 true，但 hasUpdate 置 false 并说明原因', async () => {
    const { fetchImpl } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl, { skippedVersion: '0.2.0' }))
    expect(result.ok).toBe(true)
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.hasUpdate).toBe(false)
    expect(result.skipped).toBe(true)
    expect(result.message).toContain('0.2.0')
    expect(result.message).toContain('跳过')
  })

  it('跳过的是别的版本时不受影响', async () => {
    const { fetchImpl } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl, { skippedVersion: '0.1.5' }))
    expect(result.hasUpdate).toBe(true)
    expect(result.skipped).toBe(false)
  })

  it('手动检查时忽略跳过版本，仍然报告有更新', async () => {
    const { fetchImpl } = alwaysRelease()
    const result = await checkForUpdate({
      ...makeOptions(fetchImpl, { skippedVersion: '0.2.0' }),
      manual: true
    })
    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(true)
    expect(result.skipped).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 *  检查更新：资产推荐
 * ------------------------------------------------------------------ */

describe('checkForUpdate：安装包推荐', () => {
  it('Windows 下推荐 Setup 安装包，.yml / .dmg / 普通 exe 均不推荐', async () => {
    const { fetchImpl } = alwaysRelease()
    const result = await checkForUpdate({ ...makeOptions(fetchImpl), platform: WINDOWS_X64 })
    const assets = result.assets!

    expect(assets).toHaveLength(4)
    expect(assets.filter((a) => a.recommended)).toHaveLength(1)
    expect(assets.find((a) => a.name === 'MCAL Setup 0.1.0.exe')!.recommended).toBe(true)
    expect(assets.find((a) => a.name === 'MCAL 0.1.0.exe')!.recommended).toBe(false)
    expect(assets.find((a) => a.name === 'latest.yml')!.recommended).toBe(false)
    expect(assets.find((a) => a.name === 'MCAL-0.1.0.dmg')!.recommended).toBe(false)
  })

  it('没有 Setup 型 exe 时次选任意 .exe', async () => {
    const release = sampleRelease({
      assets: [
        { name: 'latest.yml', size: 431, browser_download_url: `${DOWNLOAD_BASE}/latest.yml` },
        { name: 'MCAL-0.1.0.exe', size: 78_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0.exe` },
        { name: 'MCAL-0.1.0.zip', size: 80_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0.zip` }
      ]
    })
    const { fetchImpl } = alwaysRelease(release)
    const result = await checkForUpdate({ ...makeOptions(fetchImpl), platform: WINDOWS_X64 })
    const assets = result.assets!
    expect(assets.find((a) => a.name === 'MCAL-0.1.0.exe')!.recommended).toBe(true)
    // zip 可下载但不推荐
    expect(assets.find((a) => a.name === 'MCAL-0.1.0.zip')!.recommended).toBe(false)
    expect(assets.find((a) => a.name === 'latest.yml')!.recommended).toBe(false)
  })

  it('macOS 优先 .dmg，Linux 优先 .AppImage', async () => {
    const release = sampleRelease({
      assets: [
        { name: 'MCAL-0.1.0.dmg', size: 95_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0.dmg` },
        { name: 'MCAL-0.1.0-mac.zip', size: 90_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0-mac.zip` },
        { name: 'MCAL-0.1.0.AppImage', size: 88_000_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0.AppImage` },
        { name: 'latest.yml', size: 431, browser_download_url: `${DOWNLOAD_BASE}/latest.yml` }
      ]
    })

    const mac = await checkForUpdate({
      ...makeOptions(alwaysRelease(release).fetchImpl),
      platform: { os: 'osx', arch: 'arm64' }
    })
    expect(mac.assets!.find((a) => a.name === 'MCAL-0.1.0.dmg')!.recommended).toBe(true)
    expect(mac.assets!.find((a) => a.name === 'MCAL-0.1.0-mac.zip')!.recommended).toBe(false)

    const linux = await checkForUpdate({
      ...makeOptions(alwaysRelease(release).fetchImpl),
      platform: { os: 'linux', arch: 'x64' }
    })
    expect(linux.assets!.find((a) => a.name === 'MCAL-0.1.0.AppImage')!.recommended).toBe(true)
    expect(linux.assets!.find((a) => a.name === 'MCAL-0.1.0.dmg')!.recommended).toBe(false)
  })

  it('没有本平台安装包时全部不推荐', async () => {
    const release = sampleRelease({
      assets: [
        { name: 'latest.yml', size: 431, browser_download_url: `${DOWNLOAD_BASE}/latest.yml` },
        { name: 'MCAL-0.1.0.blockmap', size: 1_000, browser_download_url: `${DOWNLOAD_BASE}/MCAL-0.1.0.blockmap` }
      ]
    })
    const { fetchImpl } = alwaysRelease(release)
    const result = await checkForUpdate({ ...makeOptions(fetchImpl), platform: WINDOWS_X64 })
    expect(result.assets!.every((a) => !a.recommended)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  检查更新：镜像改写
 * ------------------------------------------------------------------ */

describe('checkForUpdate：下载地址改写', () => {
  it('mirror 模式下 mirrorUrl 走命中源的镜像前缀', async () => {
    const { fetchImpl } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl))
    const expected = `https://gh-proxy.com/${DOWNLOAD_BASE}/MCAL-0.1.0.exe`
    expect(result.sourceId).toBe('ghproxy')
    expect(result.assets!.find((a) => a.name === 'MCAL 0.1.0.exe')!.mirrorUrl).toBe(expected)
    expect(result.assets!.every((a) => a.mirrorUrl.startsWith('https://gh-proxy.com/https://github.com/'))).toBe(true)
  })

  it('failover 后 mirrorUrl 使用最终命中的源', async () => {
    const { fetchImpl } = makeFetch((url, index) =>
      index === 0 ? { reject: 'socket hang up' } : { status: 200, body: sampleRelease() }
    )
    const result = await checkForUpdate(makeOptions(fetchImpl))
    expect(result.sourceId).toBe('ghfast')
    expect(result.assets![0].mirrorUrl.startsWith('https://ghfast.top/')).toBe(true)
  })

  it('direct 模式下 mirrorUrl 等于原始 url', async () => {
    const { fetchImpl, calls } = alwaysRelease()
    const result = await checkForUpdate(makeOptions(fetchImpl, { source: 'direct' }))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://api.github.com${LATEST_PATH}`)
    expect(result.assets!.every((a) => a.mirrorUrl === a.url)).toBe(true)
    expect(result.assets![0].url).toContain('https://github.com/')
  })
})

/* ------------------------------------------------------------------ *
 *  版本历史
 * ------------------------------------------------------------------ */

describe('listReleases：版本历史', () => {
  it('成功时返回列表与命中源', async () => {
    const releases = [sampleRelease(), sampleRelease({ tag_name: 'v0.1.0', name: 'MCAL 0.1.0' })]
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, body: releases }))
    const result = await listReleases({ ...makeOptions(fetchImpl), limit: 5 })

    expect(result.ok).toBe(true)
    expect(result.sourceId).toBe('ghproxy')
    expect(result.releases).toHaveLength(2)
    expect(result.releases[0].tag).toBe('v0.2.0')
    expect(result.releases[0].latestVersion).toBe('0.2.0')
    expect(result.releases[0].assets.length).toBe(SAMPLE_ASSETS.length)
    expect(calls[0].url).toContain('/releases?per_page=5')
  })

  it('全部失败时 ok=false 且列表为空，并保留 attempts', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 500, body: 'oops' }))
    const result = await listReleases(makeOptions(fetchImpl))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
    expect(result.releases).toEqual([])
    expect(result.attempts).toHaveLength(MIRROR_PRESETS.length)
  })

  it('全部 404 时归因为 no-release', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, body: { message: 'Not Found' } }))
    const result = await listReleases(makeOptions(fetchImpl))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no-release')
  })

  it('repo 不合法时直接返回 bad-repo，不发请求', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, body: [] }))
    const result = await listReleases(makeOptions(fetchImpl, { repo: 'nope' }))
    expect(result.reason).toBe('bad-repo')
    expect(calls).toHaveLength(0)
  })
})
