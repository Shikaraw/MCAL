/**
 * 游戏目录自动检测测试（全部离线、全部在临时目录里造 fixture）。
 *
 * 约定：
 *  - 所有用例都通过 options.env 注入伪装的 home / appData / userProfile，
 *    不依赖（也不会触碰）运行测试的机器上真实的 .minecraft；
 *  - 注入模式下检测不会枚举真实盘符，因此结果只包含 fixture 目录；
 *  - 临时目录在 afterAll 里删除。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { GameDirCandidate } from '@shared/types'
import { detectGameDirs, isLikelyGameDir, probeGameDir } from '@core/gamedir/detect'
import { normalizePathForCompare } from '@core/util/misc'

const root = mkdtempSync(join(tmpdir(), 'mcal-gamedir-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0

/* ------------------------------------------------------------------ *
 *  fixture 工具
 * ------------------------------------------------------------------ */

/** 新建一个临时目录 */
function tmpDir(name?: string): string {
  const dir = join(root, name ?? `case-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 写入文件（自动创建父目录） */
function writeFile(dir: string, relative: string, content = ''): string {
  const full = join(dir, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

/** 造一个「安装完成」的版本：versions/<id>/<id>.json */
function addVersion(gameDir: string, id: string): void {
  writeFile(gameDir, join('versions', id, `${id}.json`), JSON.stringify({ id, type: 'release' }))
}

/** 造一个假环境：home / appData / userProfile 全部指向临时目录 */
function fakeEnv(): { base: string; home: string; appData: string; env: Record<string, string>; officialDir: string } {
  const base = tmpDir(`env-${seq++}`)
  const home = join(base, 'home')
  const appData = join(home, 'AppData', 'Roaming')
  const localAppData = join(home, 'AppData', 'Local')
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  return {
    base,
    home,
    appData,
    env: { home, appData, localAppData, userProfile: home },
    officialDir: join(appData, '.minecraft')
  }
}

/** 按路径（归一化）查找候选 */
function findDir(candidates: GameDirCandidate[], dir: string): GameDirCandidate | undefined {
  const key = normalizePathForCompare(dir)
  return candidates.find((candidate) => normalizePathForCompare(candidate.path) === key)
}

/* ------------------------------------------------------------------ *
 *  基本识别
 * ------------------------------------------------------------------ */

describe('detectGameDirs 基本识别', () => {
  it('识别官方目录并解析版本与加载器（vanilla + fabric）', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    addVersion(e.officialDir, 'fabric-loader-0.15.11-1.20.1')

    const candidates = await detectGameDirs({ env: e.env })
    const official = findDir(candidates, e.officialDir)

    expect(official).toBeDefined()
    expect(official?.valid).toBe(true)
    expect(official?.source).toBe('official')
    expect(official?.label).toContain('官方启动器')
    expect(official?.versions).toEqual(['1.20.1', 'fabric-loader-0.15.11-1.20.1'])
    expect(official?.versionCount).toBe(2)
    expect(official?.loaders).toContain('vanilla')
    expect(official?.loaders).toContain('fabric')
    expect(official?.added).toBe(false)
  })

  it('空目录不是有效的游戏目录', async () => {
    const empty = tmpDir()

    const candidate = await probeGameDir(empty)

    expect(candidate.valid).toBe(false)
    expect(candidate.source).toBe('manual')
    expect(candidate.versionCount).toBe(0)
    expect(candidate.versions).toEqual([])
    expect(candidate.loaders).toEqual([])
    await expect(isLikelyGameDir(empty)).resolves.toBe(false)
  })

  it('从 version id 识别多种加载器（大小写不敏感、neoforge 不重复计 forge）', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    addVersion(e.officialDir, '1.20.1-Forge-47.2.0')
    addVersion(e.officialDir, 'neoforge-21.1.66')
    addVersion(e.officialDir, 'quilt-loader-0.20.0-beta.9-1.20.1')
    addVersion(e.officialDir, 'OptiFine_1.20.1_HD_U_I6')
    addVersion(e.officialDir, '1.20.1-OF')

    const official = findDir(await detectGameDirs({ env: e.env }), e.officialDir)

    expect(new Set(official?.loaders)).toEqual(new Set(['vanilla', 'forge', 'neoforge', 'quilt', 'optifine']))
  })

  it('isLikelyGameDir 认可 versions / launcher_profiles.json / assets 三种标记', async () => {
    const withVersions = tmpDir()
    mkdirSync(join(withVersions, 'versions'))
    const withProfiles = tmpDir()
    writeFile(withProfiles, 'launcher_profiles.json', '{}')
    const withAssets = tmpDir()
    mkdirSync(join(withAssets, 'assets'))
    const plain = tmpDir()

    await expect(isLikelyGameDir(withVersions)).resolves.toBe(true)
    await expect(isLikelyGameDir(withProfiles)).resolves.toBe(true)
    await expect(isLikelyGameDir(withAssets)).resolves.toBe(true)
    await expect(isLikelyGameDir(plain)).resolves.toBe(false)
    await expect(isLikelyGameDir(join(root, '不存在的目录'))).resolves.toBe(false)
  })

  it('probeGameDir 对不存在的目录返回无效候选而不是抛错', async () => {
    const missing = join(root, 'definitely-missing', 'nope')

    const candidate = await probeGameDir(missing)

    expect(candidate.valid).toBe(false)
    expect(candidate.path).toBe(resolve(missing))
    expect(candidate.sizeBytes).toBe(0)
    expect(candidate.lastModified).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 *  版本统计
 * ------------------------------------------------------------------ */

describe('版本统计', () => {
  it('versionCount 只统计有 json 的版本，versions 按目录名排序', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    addVersion(e.officialDir, '1.21')
    // 只有目录没有 json：安装未完成，不算已安装
    mkdirSync(join(e.officialDir, 'versions', '1.20.4'), { recursive: true })

    const official = findDir(await detectGameDirs({ env: e.env }), e.officialDir)

    expect(official?.versions).toEqual(['1.20.1', '1.21'])
    expect(official?.versionCount).toBe(2)
  })

  it('versions 最多列出 20 个，versionCount 保留完整数量', async () => {
    const e = fakeEnv()
    for (let i = 1; i <= 22; i++) addVersion(e.officialDir, `1.20.${i}`)

    const official = findDir(await detectGameDirs({ env: e.env }), e.officialDir)

    expect(official?.versionCount).toBe(22)
    expect(official?.versions.length).toBe(20)
    expect(official?.versions[0]).toBe('1.20.1')
  })

  it('deep: false 时不做体积与 mtime 统计', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')

    const shallow = findDir(await detectGameDirs({ env: e.env, deep: false }), e.officialDir)
    expect(shallow?.sizeBytes).toBe(0)
    expect(shallow?.lastModified).toBeUndefined()

    const deep = findDir(await detectGameDirs({ env: e.env }), e.officialDir)
    expect(deep?.sizeBytes).toBeGreaterThan(0)
    expect(deep?.lastModified).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ *
 *  known / extraRoots / 官方启动器配置
 * ------------------------------------------------------------------ */

describe('已知目录与手动搜索根', () => {
  it('known 命中的候选标记 added（路径比较大小写不敏感、忽略末尾分隔符）', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    const other = join(e.base, 'other-mc')
    addVersion(other, '1.19.4')

    const candidates = await detectGameDirs({
      env: e.env,
      extraRoots: [other],
      known: [{ path: e.officialDir.toUpperCase() }, { path: other + sep }]
    })

    expect(findDir(candidates, e.officialDir)?.added).toBe(true)
    expect(findDir(candidates, other)?.added).toBe(true)
    expect(findDir(candidates, e.officialDir)?.source).toBe('official')
  })

  it('extraRoots 里的路径直接作为 manual 候选', async () => {
    const e = fakeEnv()
    const custom = join(e.base, '手动目录')
    addVersion(custom, '1.12.2-forge-14.23.5.2859')

    const candidates = await detectGameDirs({ env: e.env, extraRoots: [custom] })
    const found = findDir(candidates, custom)

    expect(candidates.length).toBe(1)
    expect(found?.source).toBe('manual')
    expect(found?.label).toBe(custom)
    expect(found?.valid).toBe(true)
    expect(found?.loaders).toEqual(['forge'])
  })

  it('无效的额外搜索根（文件 / 空字符串）不影响其他结果', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    const file = writeFile(e.base, 'not-a-dir.txt', 'x')

    const candidates = await detectGameDirs({ env: e.env, extraRoots: [file, '', '   '] })

    expect(candidates.length).toBe(1)
    expect(findDir(candidates, e.officialDir)).toBeDefined()
  })

  it('读取 launcher_profiles.json 里 profiles[].gameDir 的自定义目录', async () => {
    const e = fakeEnv()
    const customDir = join(e.base, 'games', 'custom-mc')
    addVersion(customDir, '1.20.4')
    writeFile(
      e.officialDir,
      'launcher_profiles.json',
      JSON.stringify({
        profiles: {
          abc: { name: '自定义配置', gameDir: customDir },
          def: { name: 'Latest release' }
        }
      })
    )

    const candidates = await detectGameDirs({ env: e.env })
    const custom = findDir(candidates, customDir)

    expect(custom).toBeDefined()
    expect(custom?.source).toBe('official')
    expect(custom?.valid).toBe(true)
    expect(custom?.label).toContain('自定义配置')
    expect(custom?.versions).toEqual(['1.20.4'])
    // 没有 gameDir 的 profile 不产生候选；默认 .minecraft 仍单独出现
    expect(candidates.length).toBe(2)
    expect(findDir(candidates, e.officialDir)).toBeDefined()
  })

  it('launcher_profiles.json 损坏时不影响默认目录', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    writeFile(e.officialDir, 'launcher_profiles.json', '{ 这不是合法 JSON')

    const candidates = await detectGameDirs({ env: e.env })

    expect(candidates.length).toBe(1)
    expect(findDir(candidates, e.officialDir)?.valid).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  第三方启动器与实例目录
 * ------------------------------------------------------------------ */

describe('第三方启动器位置', () => {
  it('识别 HMCL / PCL2 / BakaXL / PrismLauncher / CurseForge / Modrinth App', async () => {
    const e = fakeEnv()
    const hmcl = join(e.appData, 'HMCL', '.minecraft')
    const pcl = join(e.home, 'PCL', '.minecraft')
    const bakaxl = join(e.appData, 'BakaXL', '.minecraft')
    const prism = join(e.appData, 'PrismLauncher', 'instances', '1.20.1', '.minecraft')
    const curseforge = join(e.home, 'curseforge', 'minecraft', 'Instances', '整合包A')
    const modrinth = join(e.appData, 'com.modrinth.theseus', 'profiles', '默认')
    for (const dir of [hmcl, pcl, bakaxl, prism, curseforge, modrinth]) addVersion(dir, '1.20.1')

    const candidates = await detectGameDirs({ env: e.env })

    expect(findDir(candidates, hmcl)?.label).toBe('HMCL')
    expect(findDir(candidates, pcl)?.label).toBe('PCL2')
    expect(findDir(candidates, bakaxl)?.label).toBe('BakaXL')
    expect(findDir(candidates, prism)?.label).toBe('PrismLauncher · 1.20.1 实例')
    expect(findDir(candidates, curseforge)?.label).toBe('CurseForge · 整合包A 实例')
    expect(findDir(candidates, modrinth)?.label).toBe('Modrinth App · 默认 实例')
    for (const dir of [hmcl, pcl, bakaxl, prism, curseforge, modrinth]) {
      const candidate = findDir(candidates, dir)
      expect(candidate?.source).toBe('thirdparty')
      expect(candidate?.valid).toBe(true)
    }
  })

  it('PrismLauncher 实例用 .minecraft 子目录作为游戏目录', async () => {
    const e = fakeEnv()
    const instanceRoot = join(e.appData, 'PrismLauncher', 'instances', '1.20.1')
    const instanceMc = join(instanceRoot, '.minecraft')
    addVersion(instanceMc, '1.20.1')
    writeFile(instanceRoot, 'instance.cfg', 'name=1.20.1')

    const candidates = await detectGameDirs({ env: e.env })

    expect(findDir(candidates, instanceMc)?.valid).toBe(true)
    // 实例根目录本身不作为候选
    expect(findDir(candidates, instanceRoot)).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 *  去重与排序
 * ------------------------------------------------------------------ */

describe('去重与排序', () => {
  it('同一路径被多个来源命中时只出现一次，来源取优先级更高者、label 取更具体者', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    const prismMc = join(e.appData, 'PrismLauncher', 'instances', '1.20.1', '.minecraft')
    addVersion(prismMc, '1.20.1')

    const candidates = await detectGameDirs({ env: e.env, extraRoots: [e.officialDir, prismMc] })

    const officialMatches = candidates.filter((c) => normalizePathForCompare(c.path) === normalizePathForCompare(e.officialDir))
    expect(officialMatches.length).toBe(1)
    expect(officialMatches[0].source).toBe('manual')
    expect(officialMatches[0].label).toBe('官方启动器 · .minecraft')

    const prismMatches = candidates.filter((c) => normalizePathForCompare(c.path) === normalizePathForCompare(prismMc))
    expect(prismMatches.length).toBe(1)
    expect(prismMatches[0].source).toBe('manual')
    expect(prismMatches[0].label).toBe('PrismLauncher · 1.20.1 实例')
  })

  it('结果按来源优先级、版本数、路径排序', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    const manual = join(e.base, 'manual-mc')
    for (const id of ['1.20.1', '1.20.2', '1.20.3']) addVersion(manual, id)
    const hmcl = join(e.appData, 'HMCL', '.minecraft')
    mkdirSync(hmcl, { recursive: true })

    const candidates = await detectGameDirs({ env: e.env, extraRoots: [manual] })

    expect(candidates.map((c) => normalizePathForCompare(c.path))).toEqual([
      normalizePathForCompare(manual),
      normalizePathForCompare(e.officialDir),
      normalizePathForCompare(hmcl)
    ])
    // 存在的空目录也会作为候选出现，只是 valid=false
    expect(findDir(candidates, hmcl)?.valid).toBe(false)
  })

  it('signal 已中止时不启动探测，也不抛错', async () => {
    const e = fakeEnv()
    addVersion(e.officialDir, '1.20.1')
    const controller = new AbortController()
    controller.abort()

    await expect(detectGameDirs({ env: e.env, signal: controller.signal })).resolves.toEqual([])
  })
})
