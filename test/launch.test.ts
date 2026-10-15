/**
 * 启动引擎纯函数测试：只覆盖不依赖网络与文件系统的逻辑
 * （requirement / args 占位符 / logparse / classpath）。
 */

import { describe, expect, it } from 'vitest'
import type { JavaRuntimeInfo, VersionDetail } from '@shared/types'
import {
  explainJavaRequirement,
  javaIsCompatible,
  javaMajorVerdict,
  needsLog4jMitigation,
  pickBestJava,
  requiredJavaMajor
} from '@core/java/requirement'
import {
  buildGameArgs,
  buildJvmArgs,
  filterUndefinedPlaceholders,
  splitMinecraftArguments,
  substitutePlaceholders
} from '@core/launch/args'
import { buildClasspath, detectDuplicateLibraries } from '@core/launch/classpath'
import { detectStartupState, parseLogChunk, parseLogLine } from '@core/launch/logparse'
import { autoMaxHeapMB, needsLegacyNatives, offlineUuid, quickPlaySupported } from '@core/launch/launcher'
import { createRuleContext } from '@core/mojang/rules'
import type { ResolvedLibrary } from '@core/mojang/library'

function javaInfo(majorVersion: number, overrides: Partial<JavaRuntimeInfo> = {}): JavaRuntimeInfo {
  return {
    path: `C:/java/${majorVersion}/bin/java.exe`,
    vendor: 'Temurin',
    version: `${majorVersion}.0.1`,
    majorVersion,
    arch: 'x64',
    os: 'windows',
    managed: false,
    is64Bit: true,
    ...overrides
  }
}

function library(overrides: Partial<ResolvedLibrary>): ResolvedLibrary {
  return {
    name: 'org.example:demo:1.0.0',
    path: 'org/example/demo/1.0.0/demo-1.0.0.jar',
    url: 'https://libraries.minecraft.net/org/example/demo/1.0.0/demo-1.0.0.jar',
    fallbackUrls: [],
    absolutePath: 'C:/game/libraries/org/example/demo/1.0.0/demo-1.0.0.jar',
    isNative: false,
    ...overrides
  }
}

/* ------------------------------------------------------------------ *
 *  requirement
 * ------------------------------------------------------------------ */

describe('requiredJavaMajor', () => {
  it('按版本区间推断主版本号', () => {
    expect(requiredJavaMajor('1.12.2')).toBe(8)
    expect(requiredJavaMajor('1.16.5')).toBe(8)
    expect(requiredJavaMajor('1.17')).toBe(17)
    expect(requiredJavaMajor('1.17.1')).toBe(17)
    expect(requiredJavaMajor('1.18.2')).toBe(17)
    expect(requiredJavaMajor('1.19.4')).toBe(17)
    expect(requiredJavaMajor('1.20.4')).toBe(17)
    expect(requiredJavaMajor('1.20.5')).toBe(21)
    expect(requiredJavaMajor('1.21')).toBe(21)
  })

  it('版本 json 声明的 javaVersion 优先', () => {
    expect(requiredJavaMajor('1.20.1', { majorVersion: 8 })).toBe(8)
    expect(requiredJavaMajor('1.16.5', { majorVersion: 16 })).toBe(16)
  })

  it('快照按时间兜底', () => {
    expect(requiredJavaMajor('24w14a')).toBe(21)
    expect(requiredJavaMajor('22w11a')).toBe(17)
    expect(requiredJavaMajor('21w20a')).toBe(17)
    expect(requiredJavaMajor('20w45a')).toBe(17)
    expect(requiredJavaMajor('16w32a')).toBe(8)
  })

  it('无法识别时按最保守的 Java 8', () => {
    expect(requiredJavaMajor('a1.2.6')).toBe(8)
  })
})

describe('javaMajorVerdict / javaIsCompatible', () => {
  it('精确匹配', () => {
    expect(javaMajorVerdict(8, 8)).toBe('exact')
    expect(javaMajorVerdict(17, 17)).toBe('exact')
    expect(javaMajorVerdict(21, 21)).toBe('exact')
  })

  it('高一档可接受', () => {
    expect(javaMajorVerdict(11, 8)).toBe('higher')
    expect(javaMajorVerdict(21, 17)).toBe('higher')
    expect(javaMajorVerdict(17, 16)).toBe('higher')
  })

  it('8 的需求不可用 17+（老 Forge 不兼容）', () => {
    expect(javaMajorVerdict(17, 8)).toBeNull()
    expect(javaMajorVerdict(21, 8)).toBeNull()
    expect(javaIsCompatible(javaInfo(17), 8)).toBe(false)
  })

  it('低一档仅在候选 >= 16 时接受（1.17 的 16）', () => {
    expect(javaMajorVerdict(16, 17)).toBe('lower')
    expect(javaMajorVerdict(17, 21)).toBe('lower')
    expect(javaMajorVerdict(11, 17)).toBeNull()
    expect(javaMajorVerdict(8, 17)).toBeNull()
  })

  it('探测失败的 Java 不可用', () => {
    expect(javaIsCompatible({ ...javaInfo(17), majorVersion: 0, error: 'broken' }, 17)).toBe(false)
    expect(javaIsCompatible(null, 17)).toBe(false)
  })
})

describe('pickBestJava', () => {
  it('优先精确匹配', () => {
    expect(pickBestJava([javaInfo(21), javaInfo(17), javaInfo(8)], 17)?.majorVersion).toBe(17)
  })

  it('没有精确匹配时高一档优先于低一档', () => {
    expect(pickBestJava([javaInfo(16), javaInfo(21)], 17)?.majorVersion).toBe(21)
  })

  it('8 的需求不选 17+', () => {
    expect(pickBestJava([javaInfo(17), javaInfo(21)], 8)).toBeNull()
    expect(pickBestJava([javaInfo(11)], 8)?.majorVersion).toBe(11)
  })

  it('vendor 偏好参与排序', () => {
    const zulu = javaInfo(17, { vendor: 'Zulu' })
    const temurin = javaInfo(17, { vendor: 'Temurin' })
    expect(pickBestJava([zulu, temurin], 17, { preferVendor: 'Temurin' })?.vendor).toBe('Temurin')
  })
})

describe('explainJavaRequirement', () => {
  it('返回包含版本与要求的中文说明', () => {
    const text = explainJavaRequirement('1.20.5', 21)
    expect(text).toContain('1.20.5')
    expect(text).toContain('Java 21')
    expect(text).toContain('UnsupportedClassVersionError')
  })

  it('老版本解释包含 Forge 不兼容提示', () => {
    expect(explainJavaRequirement('1.12.2', 8)).toContain('Java 8')
  })
})

describe('needsLog4jMitigation', () => {
  it('1.12 ~ 1.17 需要缓解参数', () => {
    expect(needsLog4jMitigation('1.12.2')).toBe(true)
    expect(needsLog4jMitigation('1.12.2-forge-14.23.5.2860')).toBe(true)
    expect(needsLog4jMitigation('1.17.1')).toBe(true)
    expect(needsLog4jMitigation('1.18')).toBe(false)
    expect(needsLog4jMitigation('1.20.1')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 *  args
 * ------------------------------------------------------------------ */

describe('substitutePlaceholders', () => {
  it('替换已定义变量，未定义的原样保留', () => {
    expect(substitutePlaceholders('${a}-${b}', { a: 'x' })).toBe('x-${b}')
    expect(substitutePlaceholders('--width ${resolution_width}', { resolution_width: '854' })).toBe('--width 854')
    expect(substitutePlaceholders('plain', {})).toBe('plain')
  })
})

describe('filterUndefinedPlaceholders', () => {
  it('丢弃残留占位符参数及前置 flag', () => {
    const args = ['--width', '${resolution_width}', '--height', '${resolution_height}', '--username', 'Steve']
    expect(filterUndefinedPlaceholders(args)).toEqual(['--username', 'Steve'])
  })

  it('值正常时不丢弃', () => {
    expect(filterUndefinedPlaceholders(['--width', '854'])).toEqual(['--width', '854'])
  })

  it('保留非 flag 前面的参数', () => {
    expect(filterUndefinedPlaceholders(['-cp', 'a.jar', '${x}'])).toEqual(['-cp', 'a.jar'])
  })

  it('按规格：flag 判定为「以 - 开头且不含 ${」', () => {
    expect(filterUndefinedPlaceholders(['-Dfoo=bar', '${x}'])).toEqual([])
  })
})

describe('splitMinecraftArguments', () => {
  it('按空格切分并去除引号', () => {
    expect(splitMinecraftArguments('--username "a b" --version 1.20.1')).toEqual([
      '--username',
      'a b',
      '--version',
      '1.20.1'
    ])
  })

  it('支持转义引号与空引号', () => {
    expect(splitMinecraftArguments('a\\"b c ""')).toEqual(['a"b', 'c', ''])
  })

  it('多个空格与换行不产生空参数', () => {
    expect(splitMinecraftArguments('  a   b  ')).toEqual(['a', 'b'])
  })
})

describe('buildGameArgs', () => {
  const version: VersionDetail = {
    id: '1.20.1',
    arguments: {
      game: [
        '--username',
        '${auth_player_name}',
        {
          rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}']
        },
        {
          rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }],
          value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}']
        }
      ]
    }
  }

  it('未定义占位符的整组参数被丢弃', () => {
    const rules = createRuleContext({ features: { has_custom_resolution: false } })
    const args = buildGameArgs({
      version,
      values: { auth_player_name: 'Steve' },
      rules
    })
    expect(args).toEqual(['--username', 'Steve'])
  })

  it('有自定义分辨率时保留窗口参数', () => {
    const rules = createRuleContext({ features: { has_custom_resolution: true } })
    const args = buildGameArgs({
      version,
      values: { auth_player_name: 'Steve', resolution_width: '854', resolution_height: '480' },
      rules
    })
    expect(args).toContain('--width')
    expect(args).toContain('854')
  })

  it('quickPlay 参数仅在 feature 打开且值存在时出现', () => {
    const rules = createRuleContext({ features: { is_quick_play_multiplayer: true } })
    const args = buildGameArgs({ version, values: { auth_player_name: 'S', quickPlayMultiplayer: 'mc.example.com' }, rules })
    expect(args).toContain('--quickPlayMultiplayer')
    expect(args).toContain('mc.example.com')

    const withoutValue = buildGameArgs({ version, values: { auth_player_name: 'S' }, rules })
    expect(withoutValue).not.toContain('--quickPlayMultiplayer')
  })

  it('extraGameArgs 追加在末尾', () => {
    const rules = createRuleContext({})
    const args = buildGameArgs({ version, values: { auth_player_name: 'S' }, rules, extraGameArgs: ['--fullscreen'] })
    expect(args[args.length - 1]).toBe('--fullscreen')
  })

  it('老格式 minecraftArguments 也能展开', () => {
    const legacy: VersionDetail = {
      id: '1.7.10',
      minecraftArguments: '--username ${auth_player_name} --width ${resolution_width}'
    }
    const rules = createRuleContext({})
    expect(buildGameArgs({ version: legacy, values: { auth_player_name: 'Steve' }, rules })).toEqual(['--username', 'Steve'])
  })
})

describe('buildJvmArgs', () => {
  const version: VersionDetail = {
    id: '1.12.2-forge-14.23.5.2860',
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}']
    }
  }

  it('包含内存、native、classpath 与加载器参数', () => {
    const args = buildJvmArgs({
      version,
      values: { natives_directory: 'C:/game/natives', classpath: 'C:/a.jar;C:/b.jar' },
      memory: { minMB: 1024, maxMB: 4096, auto: false },
      extraJvmArgs: ['-Xmx8G'],
      nativesDir: 'C:/game/natives',
      classpath: ['C:/a.jar', 'C:/b.jar'],
      osName: 'windows',
      loaderType: 'forge'
    })
    expect(args).toContain('-Xmx4096M')
    expect(args).toContain('-Xms1024M')
    expect(args).toContain('-Djava.library.path=C:/game/natives')
    expect(args).toContain('-Dfml.ignoreInvalidMinecraftCertificates=true')
    expect(args).toContain('-Dlog4j2.formatMsgNoLookups=true')
    expect(args).toContain('-cp')
    expect(args).toContain('C:/a.jar;C:/b.jar')
    // 自定义参数在最后，能覆盖启动器默认值
    expect(args[args.length - 1]).toBe('-Xmx8G')
  })

  it('macOS 加 -XstartOnFirstThread 且没有 log4j 缓解', () => {
    const mac: VersionDetail = { id: '1.20.1', arguments: { jvm: [] } }
    const args = buildJvmArgs({
      version: mac,
      values: {},
      memory: { minMB: 0, maxMB: 2048, auto: false },
      nativesDir: '/n',
      classpath: ['/a.jar'],
      osName: 'osx'
    })
    expect(args).toContain('-XstartOnFirstThread')
    expect(args).not.toContain('-Dlog4j2.formatMsgNoLookups=true')
    expect(args).not.toContain('-Xms0M')
  })
})

/* ------------------------------------------------------------------ *
 *  logparse
 * ------------------------------------------------------------------ */

describe('parseLogLine', () => {
  it('原版 log4j 格式', () => {
    const line = parseLogLine('[19:20:41] [Client thread/INFO]: Setting user: Steve')
    expect(line.level).toBe('info')
    expect(line.message).toBe('Setting user: Steve')
  })

  it('现代格式带上下文', () => {
    const line = parseLogLine('[19:20:41] [Render thread/INFO] (Minecraft/1.20.1) Backend library: LWJGL 3.3.1')
    expect(line.level).toBe('info')
    expect(line.message).toBe('Backend library: LWJGL 3.3.1')
  })

  it('Forge 格式带 logger', () => {
    const line = parseLogLine('[19:20:41] [main/INFO] [net.minecraftforge.fml.loading.ModSorter/]: hello')
    expect(line.level).toBe('info')
    expect(line.logger).toBe('net.minecraftforge.fml.loading.ModSorter')
    expect(line.message).toBe('hello')
  })

  it('级别不区分大小写', () => {
    expect(parseLogLine('[19:20:41] [Client thread/warn]: x').level).toBe('warn')
    expect(parseLogLine('[19:20:41] [main/FATAL]: x').level).toBe('fatal')
  })

  it('无时间戳 stdout', () => {
    const line = parseLogLine('[main/ERROR] [minecraft/Minecraft]: boom')
    expect(line.level).toBe('error')
    expect(line.logger).toBe('minecraft/Minecraft')
  })

  it('崩溃与栈输出', () => {
    expect(parseLogLine('Exception in thread "main" java.lang.NoClassDefFoundError: foo').level).toBe('error')
    expect(parseLogLine('Caused by: java.lang.RuntimeException: bad').level).toBe('error')
    expect(parseLogLine('# A fatal error has been detected by the Java Runtime Environment:').level).toBe('fatal')
    expect(parseLogLine('# Problematic frame').level).toBe('fatal')
    // 栈帧保持 unknown，避免把被捕获的异常判成崩溃
    expect(parseLogLine('\tat net.minecraft.client.Main.main(Main.java:1)').level).toBe('unknown')
  })

  it('裸文本保持 unknown 且保留 raw', () => {
    const line = parseLogLine('Hello world')
    expect(line.level).toBe('unknown')
    expect(line.raw).toBe('Hello world')
  })
})

describe('parseLogChunk', () => {
  it('处理 \\n \\r\\n 与 \\r', () => {
    const lines = parseLogChunk('a\nb\r\nc\rd')
    expect(lines.map((l) => l.raw)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('忽略空行', () => {
    expect(parseLogChunk('\n\n')).toHaveLength(0)
  })
})

describe('detectStartupState', () => {
  it('识别 ready', () => {
    const lines = parseLogChunk(
      [
        '[19:20:41] [Render thread/INFO] (Minecraft/1.20.1) Backend library: LWJGL 3.3.1',
        '[19:20:42] [Render thread/INFO] (Minecraft/1.20.1) Sound engine started',
        '[19:20:42] [Render thread/INFO] (Minecraft/1.20.1) Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas'
      ].join('\n')
    )
    expect(detectStartupState(lines).stage).toBe('ready')
  })

  it('识别 crashed', () => {
    const lines = parseLogChunk(
      [
        '[19:20:41] [main/INFO] [net.minecraftforge.fml.loading.ModSorter/]: loading 5 mods',
        '# A fatal error has been detected by the Java Runtime Environment:'
      ].join('\n')
    )
    const state = detectStartupState(lines)
    expect(state.stage).toBe('crashed')
    expect(state.evidence).toContain('fatal error')
  })

  it('ready 之前的早期异常不影响判定', () => {
    const lines = parseLogChunk(['Caused by: java.io.IOException: transient', '[19:20:42] [Render thread/INFO]: Sound engine started'].join('\n'))
    expect(detectStartupState(lines).stage).toBe('ready')
  })

  it('ready 之后的崩溃判为 crashed', () => {
    const lines = parseLogChunk(
      ['[19:20:42] [Render thread/INFO]: Sound engine started', 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space'].join('\n')
    )
    expect(detectStartupState(lines).stage).toBe('crashed')
  })

  it('无法识别时为 unknown', () => {
    expect(detectStartupState(parseLogChunk('hello\nworld')).stage).toBe('unknown')
  })
})

/* ------------------------------------------------------------------ *
 *  classpath
 * ------------------------------------------------------------------ */

describe('buildClasspath', () => {
  it('过滤 native、去重、追加客户端 jar 与额外 jar', () => {
    const libs = [
      library({}),
      library({
        name: 'org.lwjgl:lwjgl:3.3.1:natives-windows',
        path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
        absolutePath: 'C:/game/libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
        isNative: true,
        nativeClassifier: 'natives-windows'
      }),
      library({ absolutePath: 'C:/GAME/LIBRARIES/ORG/EXAMPLE/DEMO/1.0.0/DEMO-1.0.0.JAR' })
    ]
    const result = buildClasspath({
      libraries: libs,
      clientJar: 'C:/game/versions/1.20.1/1.20.1.jar',
      extraJars: ['C:/game/versions/1.20.1-forge/1.20.1-forge.jar'],
      separator: ';'
    })
    expect(result).toHaveLength(3)
    expect(result[0]).toContain('demo-1.0.0.jar')
    expect(result[1]).toContain('1.20.1.jar')
    expect(result[2]).toContain('1.20.1-forge.jar')
  })
})

describe('detectDuplicateLibraries', () => {
  it('检测同 artifact 多版本', () => {
    const libs = [
      library({ name: 'com.example:lib:1.0.0' }),
      library({ name: 'com.example:lib:2.0.0' }),
      library({ name: 'com.example:other:1.0.0' })
    ]
    const dupes = detectDuplicateLibraries(libs)
    expect(dupes).toHaveLength(1)
    expect(dupes[0].artifact).toBe('com.example:lib')
    expect(dupes[0].versions.sort()).toEqual(['1.0.0', '2.0.0'])
  })
})

/* ------------------------------------------------------------------ *
 *  launcher 辅助
 * ------------------------------------------------------------------ */

describe('launcher helpers', () => {
  it('离线 UUID：32 位小写 hex、版本位为 3、结果稳定', () => {
    const uuid = offlineUuid('Steve')
    expect(uuid).toMatch(/^[0-9a-f]{32}$/)
    expect(uuid[12]).toBe('3')
    expect(offlineUuid('Steve')).toBe(uuid)
    expect(offlineUuid('Alex')).not.toBe(uuid)
  })

  it('自动内存按物理内存取档', () => {
    expect(autoMaxHeapMB(32 * 1024)).toBe(8192)
    expect(autoMaxHeapMB(16 * 1024)).toBe(8192)
    expect(autoMaxHeapMB(8 * 1024)).toBe(4096)
    expect(autoMaxHeapMB(2048)).toBe(1024)
    expect(autoMaxHeapMB(1024)).toBe(614)
  })

  it('native 解压需求按 1.19 分界', () => {
    expect(needsLegacyNatives('1.18.2')).toBe(true)
    expect(needsLegacyNatives('1.12.2')).toBe(true)
    expect(needsLegacyNatives('1.19')).toBe(false)
    expect(needsLegacyNatives('1.20.1')).toBe(false)
  })

  it('quickPlay 需要 1.20+', () => {
    expect(quickPlaySupported('1.20.1')).toBe(true)
    expect(quickPlaySupported('1.19.4')).toBe(false)
    expect(quickPlaySupported('23w31a')).toBe(true)
  })
})
