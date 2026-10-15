/**
 * Mojang 元数据与安装引擎的纯函数测试。
 *
 * 只覆盖无副作用的逻辑：规则求值、继承合并、旧参数转换、库路径/地址解析、去重。
 * 不发起任何网络请求，也不触碰真实游戏目录。
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Library, VersionDetail } from '@shared/types'
import { createRuleContext, defaultFeatures, evaluateRules, type RuleContext } from '@core/mojang/rules'
import { convertLegacyArguments, mergeVersionDetail, tokenizeLegacyArguments } from '@core/mojang/version'
import {
  dedupeLibraries,
  libraryDownloadItems,
  nativeLibraries,
  resolveLibraries,
  resolveLibrary
} from '@core/mojang/library'
import { isVersionSupportedByLoader } from '@core/mojang/manifest'
import { MirrorResolver } from '@core/net/mirror'

const OFFICIAL_MIRROR = new MirrorResolver({
  mojang: 'official',
  forge: 'official',
  fabric: 'official',
  modrinth: 'official'
})

const BMCLAPI_MIRROR = new MirrorResolver({
  mojang: 'bmclapi',
  forge: 'bmclapi',
  fabric: 'bmclapi',
  modrinth: 'official'
})

function windowsX64(overrides: Partial<RuleContext> = {}): RuleContext {
  return createRuleContext({
    osName: 'windows',
    osVersion: '10.0.19045',
    arch: 'x64',
    ...overrides
  })
}

/* ------------------------------------------------------------------ *
 *  rules
 * ------------------------------------------------------------------ */

describe('rules：Mojang 启动规则求值', () => {
  it('rules 为空 / undefined 时一律允许（不能被默认值否掉）', () => {
    expect(evaluateRules(undefined, windowsX64())).toBe(true)
    expect(evaluateRules([], windowsX64())).toBe(true)
    expect(evaluateRules(undefined, windowsX64(), false)).toBe(true)
  })

  it('最后一条匹配的规则决定结果（而不是命中 allow 就允许）', () => {
    const allow = { action: 'allow' as const }
    const disallow = { action: 'disallow' as const }
    expect(evaluateRules([allow, disallow], windowsX64())).toBe(false)
    expect(evaluateRules([disallow, allow], windowsX64())).toBe(true)
  })

  it('没有任何规则匹配时使用 defaultValue（默认 false）', () => {
    const linuxOnly = [{ action: 'allow' as const, os: { name: 'linux' } }]
    expect(evaluateRules(linuxOnly, windowsX64())).toBe(false)
    expect(evaluateRules(linuxOnly, windowsX64(), true)).toBe(true)
  })

  it('os.name 精确匹配当前平台', () => {
    const windowsOnly = [{ action: 'allow' as const, os: { name: 'windows' } }]
    expect(evaluateRules(windowsOnly, windowsX64())).toBe(true)
    expect(evaluateRules(windowsOnly, windowsX64({ osName: 'osx' }))).toBe(false)
  })

  it('os.arch 归一化后比较（x86_64 等价 x64）', () => {
    const x64Only = [{ action: 'allow' as const, os: { arch: 'x86_64' } }]
    expect(evaluateRules(x64Only, windowsX64())).toBe(true)
    expect(evaluateRules(x64Only, windowsX64({ arch: 'x86' }))).toBe(false)

    const x86Only = [{ action: 'allow' as const, os: { arch: 'x86' } }]
    expect(evaluateRules(x86Only, windowsX64({ arch: 'x86' }))).toBe(true)
    expect(evaluateRules(x86Only, windowsX64())).toBe(false)
  })

  it('os.version 是正则而不是精确版本号', () => {
    const win10 = [{ action: 'allow' as const, os: { version: '^10\\.' } }]
    expect(evaluateRules(win10, windowsX64())).toBe(true)
    expect(evaluateRules(win10, windowsX64({ osVersion: '6.1.7601' }))).toBe(false)
    // 非法正则不应抛出，按不匹配处理
    expect(evaluateRules([{ action: 'allow' as const, os: { version: '[' } }], windowsX64())).toBe(false)
  })

  it('features 必须全部满足（规则里写 false 的开关要确实为 false）', () => {
    const customResolution = [{ action: 'allow' as const, features: { has_custom_resolution: true } }]
    expect(evaluateRules(customResolution, windowsX64())).toBe(false)
    expect(evaluateRules(customResolution, windowsX64({ hasCustomResolution: true }))).toBe(true)

    const notDemo = [{ action: 'allow' as const, features: { is_demo_user: false } }]
    expect(evaluateRules(notDemo, windowsX64())).toBe(true)
    expect(evaluateRules(notDemo, windowsX64({ isDemoUser: true }))).toBe(false)
  })

  it('createRuleContext 合并默认值并保持 features 与便捷字段一致', () => {
    const ctx = createRuleContext({ features: { has_custom_resolution: true } })
    expect(ctx.features.is_demo_user).toBe(false)
    expect(ctx.hasCustomResolution).toBe(true)
    expect(ctx.features.has_custom_resolution).toBe(true)

    const demo = createRuleContext({ isDemoUser: true })
    expect(demo.features.is_demo_user).toBe(true)
    expect(demo.isDemoUser).toBe(true)
  })

  it('defaultFeatures 覆盖全部已知开关且默认关闭', () => {
    const features = defaultFeatures()
    expect(Object.keys(features).sort()).toEqual(
      [
        'has_custom_resolution',
        'has_quick_plays_support',
        'is_demo_user',
        'is_quick_play_multiplayer',
        'is_quick_play_realms',
        'is_quick_play_singleplayer'
      ].sort()
    )
    expect(Object.values(features).every((v) => v === false)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  mergeVersionDetail
 * ------------------------------------------------------------------ */

describe('mergeVersionDetail：继承合并语义', () => {
  it('libraries 按 group:artifact 去重，子版本覆盖同 artifact 的父库', () => {
    const parent: VersionDetail = {
      id: '1.20.1',
      libraries: [
        { name: 'com.example:demo:1.0', downloads: { artifact: { url: 'https://l/demo-1.0.jar' } } },
        { name: 'com.example:other:1.0' }
      ]
    }
    const child: VersionDetail = {
      id: '1.20.1-forge-47.2.0',
      inheritsFrom: '1.20.1',
      libraries: [
        { name: 'com.example:demo:2.0', downloads: { artifact: { url: 'https://l/demo-2.0.jar' } } },
        { name: 'net.minecraftforge:forge:47.2.0' }
      ]
    }
    const merged = mergeVersionDetail(parent, child)
    expect(merged.libraries).toHaveLength(3)
    expect(merged.libraries?.[0].name).toBe('com.example:demo:2.0') // 覆盖发生但位置保持
    expect(merged.libraries?.[1].name).toBe('com.example:other:1.0')
    expect(merged.libraries?.[2].name).toBe('net.minecraftforge:forge:47.2.0')
  })

  it('同坐标的 native 变体不会被去重吃掉（1.19+ vanilla 的 lwjgl 形态）', () => {
    const nativeLib = (classifier: string): Library => ({
      name: 'org.lwjgl:lwjgl:3.3.1',
      downloads: { classifiers: { [classifier]: { url: `https://l/${classifier}.jar` } } },
      natives: { windows: classifier }
    })
    const parent: VersionDetail = {
      id: '1.20.1',
      libraries: [
        { name: 'org.lwjgl:lwjgl:3.3.1', downloads: { artifact: { url: 'https://l/lwjgl-3.3.1.jar' } } },
        nativeLib('natives-windows'),
        nativeLib('natives-windows-arm64')
      ]
    }
    const child: VersionDetail = { id: 'x', inheritsFrom: '1.20.1', libraries: [{ name: 'a:b:1' }] }
    const merged = mergeVersionDetail(parent, child)
    expect(merged.libraries).toHaveLength(4)
  })

  it('arguments.game / arguments.jvm 分别拼接（父在前）', () => {
    const parent: VersionDetail = {
      id: 'p',
      arguments: { game: ['--parent'], jvm: ['-Xmx2G'] }
    }
    const child: VersionDetail = {
      id: 'c',
      inheritsFrom: 'p',
      arguments: { game: ['--child'], jvm: ['-Dfoo=1'] }
    }
    const merged = mergeVersionDetail(parent, child)
    expect(merged.arguments?.game).toEqual(['--parent', '--child'])
    expect(merged.arguments?.jvm).toEqual(['-Xmx2G', '-Dfoo=1'])
  })

  it('mainClass / assets / assetIndex / javaVersion / type 子在则有则覆盖', () => {
    const parent: VersionDetail = {
      id: 'p',
      mainClass: 'net.minecraft.client.main.Main',
      assets: '1.12',
      assetIndex: { id: '1.12', sha1: 'a', size: 1, totalSize: 2, url: 'https://i' },
      javaVersion: { majorVersion: 8 },
      type: 'release'
    }
    const child: VersionDetail = {
      id: 'c',
      inheritsFrom: 'p',
      mainClass: 'net.minecraft.launchwrapper.Launch',
      assets: 'legacy',
      javaVersion: { majorVersion: 17 }
    }
    const merged = mergeVersionDetail(parent, child)
    expect(merged.mainClass).toBe('net.minecraft.launchwrapper.Launch')
    expect(merged.assets).toBe('legacy')
    expect(merged.assetIndex?.id).toBe('1.12') // 子没有则不覆盖
    expect(merged.javaVersion?.majorVersion).toBe(17)
    expect(merged.type).toBe('release')
  })

  it('downloads 按字段合并，子不写 client 时父的 client 仍然可见', () => {
    const parent: VersionDetail = {
      id: 'p',
      downloads: { client: { url: 'https://c/client.jar', sha1: 'ff', size: 100 } }
    }
    const child: VersionDetail = {
      id: 'c',
      inheritsFrom: 'p',
      downloads: { server: { url: 'https://c/server.jar' } }
    }
    const merged = mergeVersionDetail(parent, child)
    expect(merged.downloads?.client?.url).toBe('https://c/client.jar')
    expect(merged.downloads?.server?.url).toBe('https://c/server.jar')
  })

  it('合并结果移除 inheritsFrom；输入不被就地修改', () => {
    const parent: VersionDetail = { id: 'p', mainClass: 'p.Main' }
    const child: VersionDetail = { id: 'c', inheritsFrom: 'p' }
    const parentSnapshot = JSON.stringify(parent)
    const merged = mergeVersionDetail(parent, child)
    expect(merged.inheritsFrom).toBeUndefined()
    expect(JSON.stringify(parent)).toBe(parentSnapshot)
    expect(parent.inheritsFrom).toBeUndefined()
  })

  it('旧格式 minecraftArguments：子有则覆盖父，并转换为 arguments.game', () => {
    const parent: VersionDetail = {
      id: '1.12.2',
      minecraftArguments: '--username ${auth_player_name} --version ${version_name}'
    }
    const child: VersionDetail = {
      id: '1.12.2-forge',
      inheritsFrom: '1.12.2',
      mainClass: 'net.minecraft.launchwrapper.Launch',
      minecraftArguments:
        '--username ${auth_player_name} --version ${version_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker'
    }
    const merged = mergeVersionDetail(parent, child)
    expect(merged.minecraftArguments).toContain('--tweakClass')
    expect(merged.arguments?.game).toEqual([
      '--username',
      '${auth_player_name}',
      '--version',
      '${version_name}',
      '--tweakClass',
      'net.minecraftforge.fml.common.launcher.FMLTweaker'
    ])
  })

  it('父旧格式 + 子有 arguments.game 时保持新格式参数（不重复注入旧命令）', () => {
    const parent: VersionDetail = { id: 'p', minecraftArguments: '--username ${auth_player_name}' }
    const child: VersionDetail = { id: 'c', inheritsFrom: 'p', arguments: { game: ['--launchTarget', 'fmlclient'] } }
    const merged = mergeVersionDetail(parent, child)
    expect(merged.arguments?.game).toEqual(['--launchTarget', 'fmlclient'])
    expect(merged.minecraftArguments).toBe('--username ${auth_player_name}')
  })
})

/* ------------------------------------------------------------------ *
 *  convertLegacyArguments / tokenizeLegacyArguments
 * ------------------------------------------------------------------ */

describe('convertLegacyArguments / tokenizeLegacyArguments', () => {
  it('没有 minecraftArguments 时原样返回', () => {
    const detail: VersionDetail = { id: 'x', arguments: { game: ['--a'] } }
    expect(convertLegacyArguments(detail)).toBe(detail)
  })

  it('只有 minecraftArguments 时转换成等价的 arguments.game', () => {
    const detail: VersionDetail = {
      id: '1.12.2',
      minecraftArguments: '--username ${auth_player_name} --gameDir ${game_directory}'
    }
    const converted = convertLegacyArguments(detail)
    expect(converted.arguments?.game).toEqual(['--username', '${auth_player_name}', '--gameDir', '${game_directory}'])
    expect(converted.minecraftArguments).toBe(detail.minecraftArguments)
  })

  it('已有 arguments.game 时不覆盖', () => {
    const detail: VersionDetail = {
      id: '1.12.2-forge',
      minecraftArguments: '--username ${auth_player_name}',
      arguments: { game: ['--tweakClass', 'x.Tweaker'] }
    }
    const converted = convertLegacyArguments(detail)
    expect(converted).toBe(detail)
    expect(converted.arguments?.game).toEqual(['--tweakClass', 'x.Tweaker'])
  })

  it('按空格切分，${...} 占位符原样保留', () => {
    expect(tokenizeLegacyArguments('--username ${auth_player_name} --uuid ${auth_uuid}')).toEqual([
      '--username',
      '${auth_player_name}',
      '--uuid',
      '${auth_uuid}'
    ])
    // 多余空白不产生空 token
    expect(tokenizeLegacyArguments('  --a   --b  ')).toEqual(['--a', '--b'])
  })

  it('引号内的空格不切分，引号本身被去掉', () => {
    expect(tokenizeLegacyArguments('--version "1.20 (test)" --x')).toEqual(['--version', '1.20 (test)', '--x'])
    expect(tokenizeLegacyArguments("--title 'My World'")).toEqual(['--title', 'My World'])
    // 占位符即使被引号包住也保持完整
    expect(tokenizeLegacyArguments('--assetsDir "${assets_root}"')).toEqual(['--assetsDir', '${assets_root}'])
  })
})

/* ------------------------------------------------------------------ *
 *  library 解析
 * ------------------------------------------------------------------ */

describe('library：坐标、地址与 natives 解析', () => {
  const librariesDir = join('C:', 'mc', 'libraries')

  it('现代格式优先使用 downloads.artifact', () => {
    const lib: Library = {
      name: 'com.example:demo:1.0',
      downloads: {
        artifact: {
          path: 'com/example/demo/1.0/demo-1.0.jar',
          url: 'https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar',
          sha1: 'aa'.repeat(20),
          size: 1234
        }
      }
    }
    const resolved = resolveLibrary(lib, { librariesDir, rules: windowsX64(), mirror: OFFICIAL_MIRROR })
    expect(resolved).not.toBeNull()
    expect(resolved?.path).toBe('com/example/demo/1.0/demo-1.0.jar')
    expect(resolved?.url).toBe('https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar')
    expect(resolved?.absolutePath).toBe(join(librariesDir, 'com', 'example', 'demo', '1.0', 'demo-1.0.jar'))
    expect(resolved?.sha1).toBe('aa'.repeat(20))
    expect(resolved?.isNative).toBe(false)
  })

  it('老格式（只有 name）按 Maven 布局拼默认仓库地址', () => {
    const lib: Library = { name: 'net.minecraft:launchwrapper:1.12' }
    const resolved = resolveLibrary(lib, { librariesDir, rules: windowsX64() })
    expect(resolved?.path).toBe('net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar')
    expect(resolved?.url).toBe('https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar')
  })

  it('老格式带自定义 maven 根地址时拼到该地址下', () => {
    const lib: Library = { name: 'custom:lib:1.0', url: 'https://maven.example.com/repo/' }
    const resolved = resolveLibrary(lib, { librariesDir, rules: windowsX64() })
    expect(resolved?.url).toBe('https://maven.example.com/repo/custom/lib/1.0/lib-1.0.jar')
  })

  it('rules 不通过时整个库被跳过', () => {
    const lib: Library = {
      name: 'com.example:linux-only:1.0',
      rules: [{ action: 'allow', os: { name: 'linux' } }]
    }
    expect(resolveLibrary(lib, { librariesDir, rules: windowsX64() })).toBeNull()
    expect(resolveLibraries([lib], { librariesDir, rules: windowsX64() })).toEqual([])
  })

  it('native 选择：natives 模板替换 ${arch}，同时产出 classpath 条目', () => {
    const lib: Library = {
      name: 'org.lwjgl:lwjgl:3.3.1',
      downloads: {
        artifact: {
          path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar',
          url: 'https://libraries.minecraft.net/lwjgl-3.3.1.jar'
        },
        classifiers: {
          'natives-windows-64': {
            path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows-64.jar',
            url: 'https://libraries.minecraft.net/lwjgl-3.3.1-natives-windows-64.jar'
          }
        }
      },
      natives: { windows: 'natives-windows-${arch}' },
      extract: { exclude: ['META-INF/'] }
    }
    const entries = resolveLibraries([lib], { librariesDir, rules: windowsX64(), mirror: OFFICIAL_MIRROR })
    expect(entries).toHaveLength(2)

    const native = entries.find((entry) => entry.isNative)
    expect(native?.nativeClassifier).toBe('natives-windows-64')
    expect(native?.path).toBe('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows-64.jar')
    expect(native?.url).toBe('https://libraries.minecraft.net/lwjgl-3.3.1-natives-windows-64.jar')
    expect(native?.extractExclude).toEqual(['META-INF/'])

    const classpath = entries.find((entry) => !entry.isNative)
    expect(classpath?.path).toBe('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar')

    expect(nativeLibraries(entries)).toHaveLength(1)
  })

  it('classifiers 里没有当前平台的条目时不猜测地址', () => {
    const lib: Library = {
      name: 'org.lwjgl:lwjgl:3.3.1',
      downloads: {
        classifiers: { 'natives-windows-64': { url: 'https://l/n64.jar' } }
      },
      natives: { windows: 'natives-windows-${arch}' }
    }
    // x86：classifiers 里没有 natives-windows-32，也不应该自己拼 URL，整个库跳过
    const entries = resolveLibraries([lib], { librariesDir, rules: windowsX64({ arch: 'x86' }) })
    expect(entries).toEqual([])
  })

  it('只有 classifiers 没有 artifact 的纯 native 条目不进 classpath', () => {
    const lib: Library = {
      name: 'org.lwjgl:lwjgl:3.3.1',
      downloads: { classifiers: { 'natives-windows-64': { url: 'https://l/n64.jar' } } },
      natives: { windows: 'natives-windows-64' }
    }
    const entries = resolveLibraries([lib], { librariesDir, rules: windowsX64() })
    expect(entries).toHaveLength(1)
    expect(entries[0].isNative).toBe(true)
  })

  it('老格式 native（无 downloads）按 classifier 拼路径并同时产出 classpath 条目', () => {
    const lib: Library = {
      name: 'org.lwjgl.lwjgl:lwjgl:2.9.0',
      natives: { windows: 'natives-windows' }
    }
    const entries = resolveLibraries([lib], { librariesDir, rules: windowsX64() })
    expect(entries).toHaveLength(2)
    const native = entries.find((entry) => entry.isNative)
    expect(native?.path).toBe('org/lwjgl/lwjgl/lwjgl/2.9.0/lwjgl-2.9.0-natives-windows.jar')
    expect(native?.url).toBe(
      'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl/2.9.0/lwjgl-2.9.0-natives-windows.jar'
    )
    const classpath = entries.find((entry) => !entry.isNative)
    expect(classpath?.path).toBe('org/lwjgl/lwjgl/lwjgl/2.9.0/lwjgl-2.9.0.jar')
  })

  it('没有 natives 映射、只有 classifiers 的老库按命名约定挑当前平台条目', () => {
    const lib: Library = {
      name: 'tv.twitch:twitch-external-platform:4.5',
      downloads: { classifiers: { 'natives-windows-64': { url: 'https://l/twitch-n64.jar' } } },
      rules: [{ action: 'allow', os: { name: 'windows' } }]
    }
    const entries = resolveLibraries([lib], { librariesDir, rules: windowsX64() })
    expect(entries).toHaveLength(1)
    expect(entries[0].isNative).toBe(true)
    expect(entries[0].nativeClassifier).toBe('natives-windows-64')
  })

  it('BMCLAPI 源：库地址被镜像解析并保留官方地址作为回退', () => {
    const lib: Library = {
      name: 'com.example:demo:1.0',
      downloads: {
        artifact: {
          path: 'com/example/demo/1.0/demo-1.0.jar',
          url: 'https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar'
        }
      }
    }
    const resolved = resolveLibrary(lib, { librariesDir, rules: windowsX64(), mirror: BMCLAPI_MIRROR })
    expect(resolved?.url).toBe('https://bmclapi2.bangbang93.com/maven/com/example/demo/1.0/demo-1.0.jar')
    expect(resolved?.fallbackUrls).toContain('https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar')
  })

  it('libraryDownloadItems：key=相对路径、dest=绝对路径、带 fallback', () => {
    const lib: Library = {
      name: 'com.example:demo:1.0',
      downloads: {
        artifact: {
          path: 'com/example/demo/1.0/demo-1.0.jar',
          url: 'https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar',
          sha1: 'cc'.repeat(20),
          size: 9
        }
      }
    }
    const [entry] = resolveLibraries([lib], { librariesDir, rules: windowsX64(), mirror: BMCLAPI_MIRROR })
    const [item] = libraryDownloadItems([entry])
    expect(item.key).toBe(entry.path)
    expect(item.dest).toBe(entry.absolutePath)
    expect(item.sha1).toBe('cc'.repeat(20))
    expect(item.size).toBe(9)
    expect(item.fallbackUrls).toContain('https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar')
  })

  it('dedupeLibraries：后出现的条目覆盖先出现的值且位置不变', () => {
    const result = dedupeLibraries([
      { name: 'g.a:a:1.0' },
      { name: 'g.b:b:1.0' },
      { name: 'g.a:a:2.0' },
      { name: 'g.a:a:3.0' }
    ])
    expect(result.map((lib) => lib.name)).toEqual(['g.a:a:3.0', 'g.b:b:1.0'])
  })
})

/* ------------------------------------------------------------------ *
 *  isVersionSupportedByLoader
 * ------------------------------------------------------------------ */

describe('isVersionSupportedByLoader', () => {
  it('正式版 1.x / 1.x.y 返回 true（1.0 除外，没有任何加载器支持它）', () => {
    expect(isVersionSupportedByLoader('1.0')).toBe(false)
    expect(isVersionSupportedByLoader('1.1')).toBe(true)
    expect(isVersionSupportedByLoader('1.7.10')).toBe(true)
    expect(isVersionSupportedByLoader(' 1.20.1 ')).toBe(true)
  })

  it('快照 / 预发布 / 远古版本返回 false', () => {
    expect(isVersionSupportedByLoader('24w14a')).toBe(false)
    expect(isVersionSupportedByLoader('1.20.1-pre1')).toBe(false)
    expect(isVersionSupportedByLoader('1.20.1-rc1')).toBe(false)
    expect(isVersionSupportedByLoader('a1.2.6')).toBe(false)
    expect(isVersionSupportedByLoader('b1.7.3')).toBe(false)
    expect(isVersionSupportedByLoader('')).toBe(false)
  })
})
