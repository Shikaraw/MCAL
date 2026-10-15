/**
 * 加载器安装引擎的纯函数与 jar 解析测试。
 *
 * 覆盖范围（按任务约定，全部离线）：
 *  - parseLoaderVersionId：各加载器版本 id 的命名/反解（含 Quilt 预发布、快照 MC 版本）
 *  - NeoForge 版本号 → MC 版本映射（20.4.x / 21.0.x / 21.1.x / 26.x / 1.20.1 legacy）
 *  - Forge maven 目录名解析（含 1.7.10 时代末尾重复 MC 版本的形态）
 *  - OptiFine 清单解析（BMCLAPI 字段容错、1.8.0 → 1.8、preview 过滤、去重）
 *  - readInstallProfile / extractEmbeddedVersionJson / detectInstallerKind：
 *    用代码临时构造 zip fixture，测完随临时目录一起删除
 * 不发起任何网络请求，也不触碰真实游戏目录。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import {
  detectInstallerKind,
  extractEmbeddedVersionJson,
  readInstallProfile
} from '@core/loaders/installer-jar'
import { parseForgeMavenVersion } from '@core/loaders/forge'
import { parseNeoForgeMavenVersion } from '@core/loaders/neoforge'
import {
  ensureTweakClass,
  isOptiFinePreview,
  optifineFromLookupVersion,
  optifineInstallerUrl,
  optifineLookupVersion,
  optifineToLoaderVersion,
  parseOptiFineList,
  splitOptiFineLoaderVersion,
  type OptiFineVersion
} from '@core/loaders/optifine'
import {
  baseGameVersionOf,
  fabricLikeVersionId,
  forgeVersionId,
  neoForgeVersionId,
  neoforgeGameVersionFor,
  optifineVersionId,
  parseLoaderVersionId
} from '@core/loaders/version-id'
import { LoaderManager, parseLoaderVersionId as parseViaIndex } from '@core/loaders/index'
import { MirrorResolver, OFFICIAL_ENDPOINTS } from '@core/net/mirror'

/* ------------------------------------------------------------------ *
 *  version id 反解
 * ------------------------------------------------------------------ */

describe('parseLoaderVersionId：加载器版本 id 反解', () => {
  it('识别 Fabric（loader 版本无短横线）', () => {
    expect(parseLoaderVersionId('fabric-loader-0.15.11-1.20.1')).toEqual({
      loaderType: 'fabric',
      loaderVersion: '0.15.11',
      gameVersion: '1.20.1'
    })
  })

  it('Fabric + MC 预发布版本（尾部 MC 版本含 -preN）', () => {
    expect(parseLoaderVersionId('fabric-loader-0.16.5-1.21.1-pre1')).toEqual({
      loaderType: 'fabric',
      loaderVersion: '0.16.5',
      gameVersion: '1.21.1-pre1'
    })
  })

  it('识别 Quilt，且 loader 版本里的 -beta.N 不会被误切', () => {
    expect(parseLoaderVersionId('quilt-loader-0.20.0-beta.9-1.20.1')).toEqual({
      loaderType: 'quilt',
      loaderVersion: '0.20.0-beta.9',
      gameVersion: '1.20.1'
    })
  })

  it('识别 Quilt 正式版', () => {
    expect(parseLoaderVersionId('quilt-loader-0.23.1-1.20.1')).toEqual({
      loaderType: 'quilt',
      loaderVersion: '0.23.1',
      gameVersion: '1.20.1'
    })
  })

  it('识别 Forge（<mc>-forge-<forge>）', () => {
    expect(parseLoaderVersionId('1.20.1-forge-47.2.0')).toEqual({
      loaderType: 'forge',
      loaderVersion: '47.2.0',
      gameVersion: '1.20.1'
    })
    expect(parseLoaderVersionId('1.7.10-forge-10.13.4.1614')).toEqual({
      loaderType: 'forge',
      loaderVersion: '10.13.4.1614',
      gameVersion: '1.7.10'
    })
  })

  it('识别 NeoForge（含 1.20.1 legacy 的版本号映射）', () => {
    expect(parseLoaderVersionId('neoforge-21.1.209')).toEqual({
      loaderType: 'neoforge',
      loaderVersion: '21.1.209',
      gameVersion: '1.21.1'
    })
    expect(parseLoaderVersionId('neoforge-47.1.106')).toEqual({
      loaderType: 'neoforge',
      loaderVersion: '47.1.106',
      gameVersion: '1.20.1'
    })
  })

  it('识别 OptiFine（本项目命名与 PCL2 命名）', () => {
    expect(parseLoaderVersionId('OptiFine_1.20.1_HD_U_I6')).toEqual({
      loaderType: 'optifine',
      loaderVersion: 'HD_U_I6',
      gameVersion: '1.20.1'
    })
    expect(parseLoaderVersionId('1.12.2-OptiFine_HD_U_G5')).toEqual({
      loaderType: 'optifine',
      loaderVersion: 'HD_U_G5',
      gameVersion: '1.12.2'
    })
  })

  it('原版版本号（正式/预发布/快照）→ vanilla', () => {
    expect(parseLoaderVersionId('1.20.1')).toEqual({ loaderType: 'vanilla', gameVersion: '1.20.1' })
    expect(parseLoaderVersionId('1.21.1-pre1')).toEqual({ loaderType: 'vanilla', gameVersion: '1.21.1-pre1' })
    expect(parseLoaderVersionId('24w14a')).toEqual({ loaderType: 'vanilla', gameVersion: '24w14a' })
  })

  it('未知 id → custom；liteloader 单独识别', () => {
    expect(parseLoaderVersionId('my-custom-pack')).toEqual({ loaderType: 'custom' })
    expect(parseLoaderVersionId('liteloader-1.12.2')).toEqual({
      loaderType: 'liteloader',
      gameVersion: '1.12.2'
    })
    expect(parseLoaderVersionId('')).toEqual({ loaderType: 'custom' })
  })

  it('baseGameVersionOf 返回父版本', () => {
    expect(baseGameVersionOf('1.20.1-forge-47.2.0')).toBe('1.20.1')
    expect(baseGameVersionOf('1.20.1')).toBe('1.20.1')
  })

  it('id 构造函数与官方命名一致', () => {
    expect(fabricLikeVersionId('fabric', '0.15.11', '1.20.1')).toBe('fabric-loader-0.15.11-1.20.1')
    expect(fabricLikeVersionId('quilt', '0.23.1', '1.20.1')).toBe('quilt-loader-0.23.1-1.20.1')
    expect(forgeVersionId('1.20.1', '47.2.0')).toBe('1.20.1-forge-47.2.0')
    expect(neoForgeVersionId('21.1.209')).toBe('neoforge-21.1.209')
    expect(optifineVersionId('1.20.1', 'HD_U', 'I6')).toBe('OptiFine_1.20.1_HD_U_I6')
  })
})

/* ------------------------------------------------------------------ *
 *  NeoForge 版本号 → MC 版本
 * ------------------------------------------------------------------ */

describe('neoforgeGameVersionFor：NeoForge 版本号映射', () => {
  it('现代命名：<mcMinor>.<mcPatch>.<build> → 1.<mcMinor>.<mcPatch>', () => {
    expect(neoforgeGameVersionFor('20.4.237')).toBe('1.20.4')
    expect(neoforgeGameVersionFor('20.2.88')).toBe('1.20.2')
    expect(neoforgeGameVersionFor('21.1.209')).toBe('1.21.1')
  })

  it('minor 为 0 时省略补丁位：21.0.x → 1.21', () => {
    expect(neoforgeGameVersionFor('21.0.167')).toBe('1.21')
    expect(neoforgeGameVersionFor('21.0.0-beta')).toBe('1.21')
  })

  it('带 beta/alpha 后缀不影响映射', () => {
    expect(neoforgeGameVersionFor('20.4.237-beta')).toBe('1.20.4')
    expect(neoforgeGameVersionFor('21.1.0-beta')).toBe('1.21.1')
  })

  it('Minecraft 26.x 新命名：26.1.0 → 26.1，26.1.2 → 26.1.2', () => {
    expect(neoforgeGameVersionFor('26.1.0')).toBe('26.1')
    expect(neoforgeGameVersionFor('26.1.2')).toBe('26.1.2')
  })

  it('1.20.1 legacy（net.neoforged:forge 与归一化版本号）', () => {
    expect(neoforgeGameVersionFor('1.20.1-47.1.106')).toBe('1.20.1')
    expect(neoforgeGameVersionFor('1.20.1-forge-47.1.99')).toBe('1.20.1')
    expect(neoforgeGameVersionFor('47.1.106')).toBe('1.20.1')
  })

  it('可容忍 neoforge- 前缀；无法映射时返回 null', () => {
    expect(neoforgeGameVersionFor('neoforge-21.1.209')).toBe('1.21.1')
    expect(neoforgeGameVersionFor('abc')).toBeNull()
    expect(neoforgeGameVersionFor('')).toBeNull()
  })
})

describe('parseNeoForgeMavenVersion：maven 目录名解析', () => {
  it('现代版本：selfVersion 即 maven 版本', () => {
    expect(parseNeoForgeMavenVersion('21.1.209')).toEqual({
      legacy: false,
      selfVersion: '21.1.209',
      mcVersion: '1.21.1',
      mavenVersion: '21.1.209'
    })
  })

  it('legacy 版本：1.20.1 前缀会被剥离', () => {
    expect(parseNeoForgeMavenVersion('1.20.1-47.1.106')).toEqual({
      legacy: true,
      selfVersion: '47.1.106',
      mcVersion: '1.20.1',
      mavenVersion: '1.20.1-47.1.106'
    })
    expect(parseNeoForgeMavenVersion('1.20.1-forge-47.1.99')?.selfVersion).toBe('47.1.99')
  })
})

/* ------------------------------------------------------------------ *
 *  Forge maven 解析
 * ------------------------------------------------------------------ */

describe('parseForgeMavenVersion：Forge maven 目录名', () => {
  it('现代形态 <mc>-<forge>', () => {
    expect(parseForgeMavenVersion('1.20.1-47.2.0')).toEqual({
      mcVersion: '1.20.1',
      forgeVersion: '47.2.0',
      mavenVersion: '1.20.1-47.2.0'
    })
    expect(parseForgeMavenVersion('1.12.2-14.23.5.2859')?.forgeVersion).toBe('14.23.5.2859')
  })

  it('旧版形态末尾重复 MC 版本（1.7.10 / 1.8.9）', () => {
    expect(parseForgeMavenVersion('1.7.10-10.13.4.1614-1.7.10')).toEqual({
      mcVersion: '1.7.10',
      forgeVersion: '10.13.4.1614',
      mavenVersion: '1.7.10-10.13.4.1614-1.7.10'
    })
    expect(parseForgeMavenVersion('1.8.9-11.15.1.2318-1.8.9')?.forgeVersion).toBe('11.15.1.2318')
  })

  it('1.7.10-pre4 的目录名（含下划线变体）', () => {
    expect(parseForgeMavenVersion('1.7.10-pre4-10.12.2.1121')?.mcVersion).toBe('1.7.10-pre4')
    expect(parseForgeMavenVersion('1.7.10_pre4-10.12.2.1121')?.mcVersion).toBe('1.7.10-pre4')
    expect(parseForgeMavenVersion('1.7.10_pre4-10.12.2.1121')?.forgeVersion).toBe('10.12.2.1121')
  })

  it('1.5.2 等三位以内版本号', () => {
    expect(parseForgeMavenVersion('1.5.2-7.8.1.738')).toEqual({
      mcVersion: '1.5.2',
      forgeVersion: '7.8.1.738',
      mavenVersion: '1.5.2-7.8.1.738'
    })
  })

  it('不符合 Forge 目录名的输入返回 null', () => {
    expect(parseForgeMavenVersion('7.8.1.738')).toBeNull()
    expect(parseForgeMavenVersion('garbage')).toBeNull()
    expect(parseForgeMavenVersion('')).toBeNull()
    expect(parseForgeMavenVersion('1.20.1-abc')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 *  OptiFine 清单
 * ------------------------------------------------------------------ */

describe('OptiFine 清单解析与地址', () => {
  it('lookup 版本转换（1.8 → 1.8.0、1.9 → 1.9.0）', () => {
    expect(optifineLookupVersion('1.8')).toBe('1.8.0')
    expect(optifineLookupVersion('1.9')).toBe('1.9.0')
    expect(optifineLookupVersion('1.20.1')).toBe('1.20.1')
    expect(optifineFromLookupVersion('1.8.0')).toBe('1.8')
    expect(optifineFromLookupVersion('1.9.0')).toBe('1.9')
    expect(optifineFromLookupVersion('1.20.1')).toBe('1.20.1')
  })

  it('解析 BMCLAPI 数组（mcversion/type/patch/filename）', () => {
    const list = parseOptiFineList([
      { type: 'HD_U', patch: 'I6', filename: 'OptiFine_1.20.1_HD_U_I6.jar', mcversion: '1.20.1', date: '2023-06-12' },
      { type: 'HD_U', patch: 'I5', filename: 'OptiFine_1.20.1_HD_U_I5.jar', mcversion: '1.20.1' }
    ])
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      type: 'HD_U',
      patch: 'I6',
      mcVersion: '1.20.1',
      fileName: 'OptiFine_1.20.1_HD_U_I6.jar',
      releaseTime: '2023-06-12'
    })
    expect(list[0].label).toBe('1.20.1 HD U I6')
  })

  it('字段容错：mcVersion 驼峰、缺 type/patch 时从 filename 解析', () => {
    const list = parseOptiFineList([{ fileName: 'OptiFine_1.12.2_HD_U_G5.jar', mcVersion: '1.12.2' }])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: 'HD_U', patch: 'G5', mcVersion: '1.12.2' })
  })

  it('1.8.0 归一化为 1.8（BMCLAPI 用 1.8.0 查询但游戏版本是 1.8）', () => {
    const list = parseOptiFineList([{ type: 'HD_U', patch: 'H9', mcversion: '1.8.0' }], '1.8')
    expect(list).toHaveLength(1)
    expect(list[0].mcVersion).toBe('1.8')
    expect(list[0].fileName).toBe('OptiFine_1.8_HD_U_H9.jar')
  })

  it('按 requestedMcVersion 过滤、按 mc/type/patch 去重、preview 识别', () => {
    const list = parseOptiFineList(
      [
        { type: 'HD_U', patch: 'I6', mcversion: '1.20.1' },
        { type: 'HD_U', patch: 'I6', mcversion: '1.20.1' }, // 重复
        { type: 'HD_U', patch: 'E1_pre1', mcversion: '1.20.1' },
        { type: 'HD_U', patch: 'I1', mcversion: '1.20.2' } // 其它版本
      ],
      '1.20.1'
    )
    expect(list).toHaveLength(2)
    const preview = list.find((v) => v.patch === 'E1_pre1')!
    expect(isOptiFinePreview(preview)).toBe(true)
    expect(isOptiFinePreview(list.find((v) => v.patch === 'I6')!)).toBe(false)
  })

  it('非数组输入返回空列表', () => {
    expect(parseOptiFineList(null)).toEqual([])
    expect(parseOptiFineList({})).toEqual([])
  })

  it('installer 地址：{base}/<mc>/<type>/<patch>（1.8 用 1.8.0）', () => {
    const v: OptiFineVersion = {
      type: 'HD_U',
      patch: 'I6',
      mcVersion: '1.20.1',
      fileName: 'OptiFine_1.20.1_HD_U_I6.jar',
      label: '1.20.1 HD U I6'
    }
    expect(optifineInstallerUrl('https://bmclapi2.bangbang93.com/optifine', v)).toBe(
      'https://bmclapi2.bangbang93.com/optifine/1.20.1/HD_U/I6'
    )
    expect(optifineInstallerUrl('https://bmclapi2.bangbang93.com/optifine/', { ...v, mcVersion: '1.8' })).toBe(
      'https://bmclapi2.bangbang93.com/optifine/1.8.0/HD_U/I6'
    )
  })

  it('loaderVersion → type/patch 拆分', () => {
    expect(splitOptiFineLoaderVersion('HD_U_I6')).toEqual({ type: 'HD_U', patch: 'I6' })
    expect(splitOptiFineLoaderVersion('preview_HD_U_E1')).toEqual({ type: 'preview_HD_U', patch: 'E1' })
    expect(splitOptiFineLoaderVersion('HD_U')).toEqual({ type: 'HD_U' })
    expect(splitOptiFineLoaderVersion(undefined)).toEqual({})
  })

  it('--tweakClass optifine.OptiFineTweaker 只追加一次', () => {
    expect(ensureTweakClass([])).toEqual(['--tweakClass', 'optifine.OptiFineTweaker'])
    expect(ensureTweakClass(['--demo'])).toEqual(['--demo', '--tweakClass', 'optifine.OptiFineTweaker'])
    const already = ['--tweakClass', 'optifine.OptiFineTweaker']
    expect(ensureTweakClass(already)).toBe(already)
  })

  it('清单 → LoaderVersion 映射', () => {
    const v: OptiFineVersion = {
      type: 'HD_U',
      patch: 'I6',
      mcVersion: '1.20.1',
      fileName: 'OptiFine_1.20.1_HD_U_I6.jar',
      label: '1.20.1 HD U I6'
    }
    expect(optifineToLoaderVersion(v)).toEqual({
      loaderType: 'optifine',
      version: 'HD_U_I6',
      gameVersion: '1.20.1',
      stable: true,
      label: '1.20.1 HD U I6'
    })
  })
})

/* ------------------------------------------------------------------ *
 *  installer jar 解析（zip fixture）
 * ------------------------------------------------------------------ */

describe('installer jar 解析', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcal-loader-test-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeJar(name: string, entries: Record<string, unknown>): string {
    const zip = new AdmZip()
    for (const [entryName, content] of Object.entries(entries)) {
      zip.addFile(
        entryName,
        Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
      )
    }
    const path = join(dir, name)
    zip.writeZip(path)
    return path
  }

  const modernVersionJson = {
    id: '1.20.1-forge-47.2.0',
    inheritsFrom: '1.20.1',
    mainClass: 'cpw.mods.modlauncher.Launcher',
    libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.2.0', url: 'https://maven.minecraftforge.net/' }]
  }

  it('现代 Forge installer：spec=1 + processors → forge-new，version.json 可取出', () => {
    const path = writeJar('forge-modern.jar', {
      'install_profile.json': {
        spec: 1,
        minecraft: '1.20.1',
        json: 'version.json',
        version: '1.20.1-forge-47.2.0',
        path: 'net.minecraftforge:forge:1.20.1-47.2.0',
        libraries: [{ name: 'net.minecraftforge:installertools:1.3.1' }],
        processors: [{ sides: ['client'], jar: 'net.minecraftforge:installertools:1.3.1', classpath: [], args: [], outputs: {} }],
        data: { SIDE: { client: '"client"' } }
      },
      'version.json': modernVersionJson,
      'maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar': 'fake'
    })
    const info = readInstallProfile(path)
    expect(info.profile).not.toBeNull()
    expect(info.spec).toBe(1)
    expect(info.hasProcessors).toBe(true)
    expect(info.versionJson?.id).toBe('1.20.1-forge-47.2.0')
    expect(info.versionJson?.inheritsFrom).toBe('1.20.1')
    expect(detectInstallerKind(path)).toBe('forge-new')
    const embedded = extractEmbeddedVersionJson(path)
    expect(embedded?.mainClass).toBe('cpw.mods.modlauncher.Launcher')
  })

  it('install_profile.json 的 json 字段指向非默认条目名时也能取出', () => {
    const path = writeJar('forge-custom-json-name.jar', {
      'install_profile.json': { spec: 1, minecraft: '1.16.5', json: 'forge-version.json', processors: [{}] },
      'forge-version.json': { id: '1.16.5-forge-36.2.34', mainClass: 'cpw.mods.modlauncher.Launcher' }
    })
    expect(extractEmbeddedVersionJson(path)?.id).toBe('1.16.5-forge-36.2.34')
    expect(readInstallProfile(path).versionJson?.id).toBe('1.16.5-forge-36.2.34')
  })

  it('旧版 Forge installer：install + versionInfo → forge-old，versionInfo 作为 versionJson', () => {
    const path = writeJar('forge-old.jar', {
      'install_profile.json': {
        install: {
          profileName: 'forge',
          minecraft: '1.12.2',
          path: 'net.minecraftforge:forge:1.12.2-14.23.5.2859',
          filePath: 'forge-1.12.2-14.23.5.2859-universal.jar',
          version: '1.12.2-forge-14.23.5.2859'
        },
        versionInfo: {
          id: '1.12.2-forge-14.23.5.2859',
          mainClass: 'net.minecraft.launchwrapper.Launch',
          libraries: [{ name: 'net.minecraftforge:forge:1.12.2-14.23.5.2859', url: 'http://files.minecraftforge.net/maven/' }]
        }
      },
      'forge-1.12.2-14.23.5.2859-universal.jar': 'fake-universal'
    })
    const info = readInstallProfile(path)
    expect(info.spec).toBe(0)
    expect(info.hasProcessors).toBe(false)
    expect(info.versionJson?.id).toBe('1.12.2-forge-14.23.5.2859')
    expect(detectInstallerKind(path)).toBe('forge-old')
    // 旧 installer 没有根 version.json 条目
    expect(extractEmbeddedVersionJson(path)).toBeNull()
  })

  it('NeoForge（profile=neoforge）→ neoforge', () => {
    const path = writeJar('neoforge-modern.jar', {
      'install_profile.json': {
        profile: 'neoforge',
        spec: 1,
        minecraft: '1.21.1',
        json: 'version.json',
        version: '1.21.1-neoforge-21.1.209',
        processors: [{}]
      },
      'version.json': { id: 'neoforge-21.1.209', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher' }
    })
    expect(detectInstallerKind(path)).toBe('neoforge')
    expect(readInstallProfile(path).versionJson?.id).toBe('neoforge-21.1.209')
  })

  it('NeoForge 1.20.1（profile=forge + NEOFORGE.RSA）→ neoforge', () => {
    const path = writeJar('neoforge-legacy.jar', {
      'install_profile.json': {
        profile: 'forge',
        spec: 1,
        minecraft: '1.20.1',
        json: 'version.json',
        version: '1.20.1-forge-47.1.106',
        processors: [{}]
      },
      'version.json': { id: 'neoforge-47.1.106', mainClass: 'cpw.mods.modlauncher.Launcher' },
      'META-INF/NEOFORGE.RSA': 'signature'
    })
    expect(detectInstallerKind(path)).toBe('neoforge')
  })

  it('spec>=1 但没有 processors 的第三方 installer 仍归为 forge-new', () => {
    const path = writeJar('forge-spec-only.jar', {
      'install_profile.json': { spec: 1, minecraft: '1.20.1', json: 'version.json' },
      'version.json': { id: '1.20.1-forge-x', mainClass: 'cpw.mods.modlauncher.Launcher' }
    })
    expect(detectInstallerKind(path)).toBe('forge-new')
  })

  it('缺少 install_profile.json → profile 为空 / unknown，但仍能取到根目录 version.json', () => {
    const path = writeJar('no-profile.jar', { 'version.json': modernVersionJson })
    const info = readInstallProfile(path)
    expect(info.profile).toBeNull()
    expect(info.spec).toBe(0)
    expect(info.hasProcessors).toBe(false)
    expect(detectInstallerKind(path)).toBe('unknown')
    expect(info.versionJson?.id).toBe('1.20.1-forge-47.2.0')
    expect(extractEmbeddedVersionJson(path)?.id).toBe('1.20.1-forge-47.2.0')
  })

  it('install_profile.json 非法 JSON → 空结果', () => {
    const path = writeJar('bad-profile.jar', { 'install_profile.json': '{not json', 'version.json': modernVersionJson })
    const info = readInstallProfile(path)
    expect(info.profile).toBeNull()
    expect(info.versionJson?.id).toBe('1.20.1-forge-47.2.0')
  })

  it('version.json 结构非法（缺 id / 无 libraries/mainClass）→ null', () => {
    const path = writeJar('bad-version-json.jar', {
      'install_profile.json': { spec: 1, minecraft: '1.20.1', json: 'version.json' },
      'version.json': { foo: 'bar' }
    })
    expect(extractEmbeddedVersionJson(path)).toBeNull()
    expect(readInstallProfile(path).versionJson).toBeNull()
  })

  it('文件不存在或不是 zip → 空结果 / unknown（不抛异常）', () => {
    const missing = join(dir, 'missing.jar')
    expect(readInstallProfile(missing).profile).toBeNull()
    expect(extractEmbeddedVersionJson(missing)).toBeNull()
    expect(detectInstallerKind(missing)).toBe('unknown')

    const bogus = join(dir, 'bogus.jar')
    writeFileSync(bogus, Buffer.from('this is not a zip file'))
    expect(readInstallProfile(bogus).profile).toBeNull()
    expect(detectInstallerKind(bogus)).toBe('unknown')
  })
})

/* ------------------------------------------------------------------ *
 *  镜像地址假设（fabric/quilt 用不同 meta 常量，不能传错）
 * ------------------------------------------------------------------ */

describe('镜像解析：fabric / quilt / forge maven', () => {
  it('BMCLAPI 下 fabricMeta 与 quiltMeta 分别映射（给 Quilt 传 fabricMeta 会 404）', () => {
    const bmclapi = new MirrorResolver({
      mojang: 'bmclapi',
      forge: 'bmclapi',
      fabric: 'bmclapi',
      modrinth: 'official'
    })
    expect(bmclapi.resolve(OFFICIAL_ENDPOINTS.fabricMeta, 'fabric')).toBe(
      'https://bmclapi2.bangbang93.com/fabric-meta'
    )
    expect(bmclapi.resolve(OFFICIAL_ENDPOINTS.quiltMeta, 'fabric')).toBe(
      'https://bmclapi2.bangbang93.com/quilt-meta'
    )
    // 官方镜像下不改写
    const official = new MirrorResolver({ mojang: 'official', forge: 'official', fabric: 'official', modrinth: 'official' })
    expect(official.resolve(OFFICIAL_ENDPOINTS.quiltMeta, 'fabric')).toBe('https://meta.quiltmc.org')
  })

  it('Forge / NeoForge maven 走 forge scope，可被 BMCLAPI 映射', () => {
    const bmclapi = new MirrorResolver({
      mojang: 'official',
      forge: 'bmclapi',
      fabric: 'official',
      modrinth: 'official'
    })
    expect(bmclapi.resolve(`${OFFICIAL_ENDPOINTS.forgeMaven}/net/minecraftforge/forge/1.20.1-47.2.0/x.jar`, 'forge')).toBe(
      'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.2.0/x.jar'
    )
    expect(
      bmclapi.resolve(`${OFFICIAL_ENDPOINTS.neoforgeMaven}/net/neoforged/neoforge/21.1.209/x.jar`, 'forge')
    ).toBe('https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.209/x.jar')
  })
})

/* ------------------------------------------------------------------ *
 *  LoaderManager 分派
 * ------------------------------------------------------------------ */

describe('LoaderManager：能力清单与反查', () => {
  const manager = new LoaderManager({
    client: null as never,
    mirror: null as never,
    downloadManager: null as never,
    repository: null as never,
    java: { scan: async () => [], probe: async () => null }
  })

  it('capabilities 覆盖全部加载器且标注是否需要 Java', () => {
    const caps = manager.capabilities()
    const types = caps.map((c) => c.type)
    expect(types).toContain('fabric')
    expect(types).toContain('quilt')
    expect(types).toContain('forge')
    expect(types).toContain('neoforge')
    expect(types).toContain('optifine')
    expect(caps.find((c) => c.type === 'fabric')?.needsJava).toBe(false)
    expect(caps.find((c) => c.type === 'forge')?.needsJava).toBe(true)
    expect(caps.find((c) => c.type === 'neoforge')?.needsJava).toBe(true)
    expect(caps.find((c) => c.type === 'optifine')?.needsJava).toBe(true)
  })

  it('detectFromVersionId 与 parseLoaderVersionId 一致', () => {
    expect(manager.detectFromVersionId('1.20.1-forge-47.2.0')).toEqual(parseViaIndex('1.20.1-forge-47.2.0'))
    expect(manager.detectFromVersionId('fabric-loader-0.15.11-1.20.1').loaderType).toBe('fabric')
  })

  it('vanilla/liteloader/custom 的 install 直接抛可读错误', async () => {
    await expect(
      manager.install({ gameDir: '.', versionId: '1.20.1', loaderType: 'vanilla', loaderVersion: '' })
    ).rejects.toThrow(/vanilla/)
    await expect(
      manager.install({ gameDir: '.', versionId: '1.12.2', loaderType: 'liteloader', loaderVersion: '1.12.2' })
    ).rejects.toThrow(/LiteLoader/)
    await expect(
      manager.install({ gameDir: '.', versionId: 'x', loaderType: 'custom', loaderVersion: '1' })
    ).rejects.toThrow(/不支持/)
  })

  it('listVersions：vanilla 返回空；缺少 gameVersion 的 fabric/optifine 抛错', async () => {
    await expect(manager.listVersions('vanilla')).resolves.toEqual([])
    await expect(manager.listVersions('fabric')).rejects.toThrow(/gameVersion/)
    await expect(manager.listVersions('optifine')).rejects.toThrow(/gameVersion/)
  })
})
