/**
 * 服务端引擎测试（全部离线）。
 *
 * 覆盖范围（按任务约定，只测纯函数与本地 fixture）：
 *  - Aikar flags / 默认 JVM 参数生成
 *  - 启动命令构建（-jar 分支与 Forge/NeoForge 的 @args.txt 分支）
 *  - detectServerReady / applyPlayersLine
 *  - server.properties 读写（保留注释、空行、未知键与行序）
 *  - detectExisting（目录识别）与 detectLaunchTarget（临时目录 fixture）
 *  - ServerManager 的 EULA 写入与属性读写（假 store，不产生网络请求）
 *  - 各核心只能离线验证的部分：Spigot 的 manualSteps、custom 的存在性校验、recommend 顺序
 *
 * 不发起任何网络请求，也不触碰真实游戏目录；临时目录在 afterAll 中删除。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ServerInstance } from '@shared/types'
import { HttpClient } from '@core/net/http'
import { MirrorResolver } from '@core/net/mirror'
import { DownloadManager } from '@core/net/downloader'
import {
  ARGS_FILE_ROOTS,
  fabricServerLauncherFileName,
  findServerArgsFile,
  parseContentDispositionFilename,
  pickPaperDownload,
  ServerCoreRegistry
} from '@core/server/cores'
import {
  AIKAR_FLAGS,
  SERVER_PROPERTY_DOCS,
  ServerManager,
  applyPlayersLine,
  applyPropertiesPatch,
  buildDefaultJvmArgs,
  buildServerCommand,
  detectLaunchTarget,
  detectServerCoreType,
  detectServerReady,
  parsePropertiesText,
  type ServerStore
} from '@core/server/manager'
import type { JavaScanner } from '@core/java/detect'

/* ------------------------------------------------------------------ *
 *  临时目录 fixture
 * ------------------------------------------------------------------ */

const root = mkdtempSync(join(tmpdir(), 'mcal-server-test-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let fixtureSeq = 0
function fixtureDir(): string {
  const dir = join(root, `case-${fixtureSeq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeFixture(dir: string, relative: string, content = ''): string {
  const full = join(dir, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

/* ------------------------------------------------------------------ *
 *  测试辅助
 * ------------------------------------------------------------------ */

function fakeJavaScanner(): JavaScanner {
  return { scan: async () => [], probe: async () => null } as unknown as JavaScanner
}

function serverInstance(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 'srv-test-1',
    name: '测试服务端',
    dir: join(root, 'instance'),
    coreType: 'paper',
    coreVersion: '232',
    gameVersion: '1.20.1',
    jarFile: 'server.jar',
    memory: { minMB: 1024, maxMB: 2048, auto: false },
    eulaAccepted: false,
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function createHarness(initial: ServerInstance[] = []) {
  const client = new HttpClient()
  const mirror = new MirrorResolver(MirrorResolver.default())
  const downloadManager = new DownloadManager({ client, mirror })
  const cores = new ServerCoreRegistry({ client, mirror, downloadManager })
  let saved: ServerInstance[] = initial.map((s) => ({ ...s }))
  const store: ServerStore = {
    load: async () => saved.map((s) => ({ ...s })),
    save: async (servers) => {
      saved = servers.map((s) => ({ ...s }))
    }
  }
  const manager = new ServerManager({
    client,
    mirror,
    downloadManager,
    cores,
    javaScanner: fakeJavaScanner(),
    store
  })
  return { manager, cores, getSaved: () => saved }
}

/* ------------------------------------------------------------------ *
 *  JVM 参数（Aikar flags）
 * ------------------------------------------------------------------ */

describe('buildDefaultJvmArgs：Aikar flags 与内存参数', () => {
  it('完整输出 Aikar 的 new flags 并在末尾补 -Xms/-Xmx（服务端两者相等）', () => {
    const args = buildDefaultJvmArgs({ minMB: 4096, maxMB: 4096 })
    expect(args.slice(0, AIKAR_FLAGS.length)).toEqual([...AIKAR_FLAGS])
    expect(args.slice(AIKAR_FLAGS.length)).toEqual(['-Xms4096M', '-Xmx4096M'])
    expect(args).toContain('-XX:+UseG1GC')
    expect(args).toContain('-XX:MaxGCPauseMillis=200')
    expect(args).toContain('-XX:SurvivorRatio=32')
    expect(args).toContain('-XX:MaxTenuringThreshold=1')
    expect(args).toContain('-XX:+PerfDisableSharedMem')
    expect(args).toContain('-Dusing.aikars.flags=https://mcflags.emc.gs')
    expect(args).toContain('-Daikars.new.flags=true')
    // Xms 只出现一次且与 Xmx 相同（服务端推荐）
    expect(args.filter((a) => a.startsWith('-Xms'))).toEqual(['-Xms4096M'])
    expect(args.filter((a) => a.startsWith('-Xmx'))).toEqual(['-Xmx4096M'])
  })

  it('maxMB <= 0 时退回 1024M；extra 追加在最后（可覆盖默认值）', () => {
    const fallback = buildDefaultJvmArgs({ minMB: 512, maxMB: 0 })
    expect(fallback).toContain('-Xmx1024M')
    const extra = buildDefaultJvmArgs({ minMB: 1024, maxMB: 2048 }, ['-Xmx3G', '-Dfoo=bar'])
    expect(extra.slice(-2)).toEqual(['-Xmx3G', '-Dfoo=bar'])
  })

  it('AIKAR_FLAGS 与 Aikar 公布的一致（20 条，含来源标记）', () => {
    expect(AIKAR_FLAGS).toHaveLength(20)
    expect(AIKAR_FLAGS[0]).toBe('-XX:+UseG1GC')
    expect(AIKAR_FLAGS[AIKAR_FLAGS.length - 1]).toBe('-Daikars.new.flags=true')
  })
})

/* ------------------------------------------------------------------ *
 *  启动命令构建
 * ------------------------------------------------------------------ */

describe('buildServerCommand：jar 与 @args.txt 两种分支', () => {
  it('普通核心：java <jvmArgs> -jar <jar> nogui', () => {
    const plan = buildServerCommand({
      javaPath: 'C:/java/bin/java.exe',
      jvmArgs: ['-Xmx4G'],
      jarFile: 'paper-1.20.1-1963.jar'
    })
    expect(plan.kind).toBe('jar')
    expect(plan.command).toBe('C:/java/bin/java.exe')
    expect(plan.args).toEqual(['-Xmx4G', '-jar', 'paper-1.20.1-1963.jar', 'nogui'])
  })

  it('新 Forge/NeoForge：@args.txt 语法，绝不出现 -jar', () => {
    const argsFile = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt'
    const plan = buildServerCommand({
      javaPath: 'java',
      jvmArgs: ['-Xms6G', '-Xmx6G'],
      argsFile
    })
    expect(plan.kind).toBe('args-file')
    expect(plan.args).toEqual(['-Xms6G', '-Xmx6G', `@${argsFile}`, 'nogui'])
    expect(plan.args).not.toContain('-jar')
    expect(plan.display).toContain(`@${argsFile}`)
  })

  it('argsFile 优先于 jarFile；nogui=false 时不追加 nogui', () => {
    const plan = buildServerCommand({
      javaPath: 'java',
      jarFile: 'server.jar',
      argsFile: 'libraries/net/neoforged/neoforge/21.1.209/unix_args.txt',
      nogui: false
    })
    expect(plan.kind).toBe('args-file')
    expect(plan.args).toEqual(['@libraries/net/neoforged/neoforge/21.1.209/unix_args.txt'])
  })

  it('没有 jar / args 文件时抛错', () => {
    expect(() => buildServerCommand({ javaPath: 'java' })).toThrow(/无法构建服务端启动命令/)
  })
})

/* ------------------------------------------------------------------ *
 *  就绪判定与玩家数
 * ------------------------------------------------------------------ */

describe('detectServerReady', () => {
  it('识别真实就绪日志（1.7 ~ 1.21 一致）', () => {
    expect(detectServerReady('[12:00:00] [Server thread/INFO]: Done (7.281s)! For help, type "help"')).toBe(true)
    expect(detectServerReady('[Server thread/INFO]: Done (0.5s)! For help, type "help" or "/help"')).toBe(true)
    expect(detectServerReady('Done (')).toBe(true)
  })

  it('不把加载中的进度行当成就绪', () => {
    expect(detectServerReady('[Server thread/INFO]: Preparing spawn area: 100%')).toBe(false)
    expect(detectServerReady('[Server thread/INFO]: Preparing level "world"')).toBe(false)
    expect(detectServerReady('[Server thread/INFO]: Done in 3s, loading mods')).toBe(false)
    expect(detectServerReady('Loading libraries, please wait...')).toBe(false)
  })
})

describe('applyPlayersLine', () => {
  it('以 "There are N of a max of M players online" 为准', () => {
    const state = { online: 0, max: 0 }
    expect(applyPlayersLine(state, '[12:00:00] [Server thread/INFO]: There are 3 of a max of 20 players online')).toBe(true)
    expect(state).toEqual({ online: 3, max: 20 })
  })

  it('joined/left the game 做增量（含插件风格的 Player 前缀）', () => {
    const state = { online: 2, max: 20 }
    expect(applyPlayersLine(state, '[12:00:01] [Server thread/INFO]: Steve joined the game')).toBe(true)
    expect(state.online).toBe(3)
    expect(applyPlayersLine(state, 'Player Alex joined the game')).toBe(true)
    expect(state.online).toBe(4)
    expect(applyPlayersLine(state, 'Steve left the game')).toBe(true)
    expect(state.online).toBe(3)
    expect(applyPlayersLine(state, 'Player Alex left the game')).toBe(true)
    expect(state.online).toBe(2)
    expect(applyPlayersLine(state, '[Server thread/INFO]: Preparing spawn area: 100%')).toBe(false)
  })

  it('不会把在线数压到负数或超过上限', () => {
    const state = { online: 0, max: 5 }
    expect(applyPlayersLine(state, 'Steve left the game')).toBe(true)
    expect(state.online).toBe(0)
    state.online = 5
    expect(applyPlayersLine(state, 'Alex joined the game')).toBe(true)
    expect(state.online).toBe(5)
  })
})

/* ------------------------------------------------------------------ *
 *  server.properties 读写
 * ------------------------------------------------------------------ */

describe('server.properties 读写（保留注释与行序）', () => {
  const sample = [
    '#Minecraft server properties',
    '#Tue Oct 14 12:00:00 CST 2025',
    'motd=A Minecraft Server',
    'max-players=20',
    '',
    '# 自定义注释：不要被清掉',
    'view-distance=10',
    'online-mode=true'
  ].join('\n')

  it('parsePropertiesText 忽略注释与空行，保留空值', () => {
    const parsed = parsePropertiesText(`${sample}\nrcon.password=\n`)
    expect(parsed.motd).toBe('A Minecraft Server')
    expect(parsed['max-players']).toBe('20')
    expect(parsed['view-distance']).toBe('10')
    expect(parsed['rcon.password']).toBe('')
    expect(Object.keys(parsed)).not.toContain('#Minecraft server properties')
  })

  it('applyPropertiesPatch 就地替换已有键、追加新键、保留其他行', () => {
    const output = applyPropertiesPatch(`${sample}\n`, {
      motd: 'MCAL 服务器',
      'max-players': '50',
      'server-port': '25565'
    })
    const lines = output.split('\n')
    expect(lines[0]).toBe('#Minecraft server properties')
    expect(lines[1]).toBe('#Tue Oct 14 12:00:00 CST 2025')
    // 第 3 行原位置替换（没有把键重排到末尾）
    expect(lines[2]).toBe('motd=MCAL 服务器')
    expect(lines[3]).toBe('max-players=50')
    expect(lines[4]).toBe('')
    expect(lines[5]).toBe('# 自定义注释：不要被清掉')
    expect(lines[6]).toBe('view-distance=10')
    expect(lines[7]).toBe('online-mode=true')
    // 新键追加到末尾
    expect(lines[8]).toBe('server-port=25565')
    expect(output.endsWith('\n')).toBe(true)
  })

  it('空值合法、CRLF 行尾保留、未知键原样保留', () => {
    expect(applyPropertiesPatch('a=1\n', { b: '' })).toBe('a=1\nb=\n')
    expect(applyPropertiesPatch('a=1\r\nunknown-key=x\r\n', { a: '2' })).toBe('a=2\r\nunknown-key=x\r\n')
    expect(applyPropertiesPatch('', { 'server-port': '25565' })).toBe('server-port=25565\n')
    // 原文件末尾没有换行时（且没有追加新键）保持原样
    expect(applyPropertiesPatch('a=1', { a: '2' })).toBe('a=2')
  })

  it('propertyDocs 覆盖常用键且有中文释义', () => {
    const docs = SERVER_PROPERTY_DOCS
    const keys = docs.map((d) => d.key)
    for (const required of ['motd', 'server-port', 'max-players', 'online-mode', 'view-distance', 'level-name']) {
      expect(keys).toContain(required)
    }
    for (const doc of docs) {
      expect(doc.note.length).toBeGreaterThan(0)
      expect(doc.label.length).toBeGreaterThan(0)
      if (doc.type === 'enum') expect((doc.options ?? []).length).toBeGreaterThan(1)
    }
  })
})

/* ------------------------------------------------------------------ *
 *  目录识别与启动目标
 * ------------------------------------------------------------------ */

describe('detectExisting / detectLaunchTarget（临时目录 fixture）', () => {
  it('识别 paper / vanilla / fabric / custom / forge / neoforge / 空目录', async () => {
    const paperDir = fixtureDir()
    writeFixture(paperDir, 'paper-1.21.4-232.jar')
    writeFixture(paperDir, 'eula.txt', 'eula=true\n')
    expect(await detectServerCoreType(paperDir)).toBe('paper')

    const vanillaDir = fixtureDir()
    writeFixture(vanillaDir, 'server.jar')
    expect(await detectServerCoreType(vanillaDir)).toBe('vanilla')

    const fabricDir = fixtureDir()
    writeFixture(fabricDir, 'server.jar')
    writeFixture(fabricDir, 'fabric-server-launch.jar')
    writeFixture(fabricDir, 'fabric-server-launcher.properties', 'serverJar=server.jar\n')
    expect(await detectServerCoreType(fabricDir)).toBe('fabric')

    const quiltDir = fixtureDir()
    writeFixture(quiltDir, 'quilt-server-launch.jar')
    expect(await detectServerCoreType(quiltDir)).toBe('quilt')

    const forgeDir = fixtureDir()
    writeFixture(forgeDir, 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt', '-p foo\n')
    expect(await detectServerCoreType(forgeDir)).toBe('forge')

    const neoDir = fixtureDir()
    writeFixture(neoDir, 'libraries/net/neoforged/neoforge/21.1.209/unix_args.txt', '-p foo\n')
    expect(await detectServerCoreType(neoDir)).toBe('neoforge')

    const customDir = fixtureDir()
    writeFixture(customDir, 'eula.txt', 'eula=true\n')
    writeFixture(customDir, 'server.properties', 'motd=x\n')
    writeFixture(customDir, 'myserver.jar')
    expect(await detectServerCoreType(customDir)).toBe('custom')

    const emptyDir = fixtureDir()
    expect(await detectServerCoreType(emptyDir)).toBeNull()
  })

  it('findServerArgsFile / detectLaunchTarget 命中 @args.txt 分支', async () => {
    const dir = fixtureDir()
    const relative = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt'
    writeFixture(dir, relative, '-p foo\n')
    expect(await findServerArgsFile(dir, 'win32')).toEqual({ path: relative, coreType: 'forge' })
    const target = await detectLaunchTarget(dir, { platform: 'win32' })
    expect(target).toEqual({ kind: 'args-file', path: relative })

    // 显式传入的 args 文件也走 @ 分支
    const explicit = await detectLaunchTarget(dir, { jarFile: relative, platform: 'win32' })
    expect(explicit).toEqual({ kind: 'args-file', path: relative })
  })

  it('detectLaunchTarget 选择 jar：显式 jarFile 优先，其次常见命名', async () => {
    const dir = fixtureDir()
    writeFixture(dir, 'paper-1.20.1-1963.jar')
    expect(await detectLaunchTarget(dir)).toEqual({ kind: 'jar', path: 'paper-1.20.1-1963.jar' })

    const dir2 = fixtureDir()
    writeFixture(dir2, 'server.jar')
    writeFixture(dir2, 'custom-core.jar')
    expect(await detectLaunchTarget(dir2, { jarFile: 'custom-core.jar' })).toEqual({ kind: 'jar', path: 'custom-core.jar' })
    expect(await detectLaunchTarget(dir2)).toEqual({ kind: 'jar', path: 'server.jar' })
  })

  it('ARGS_FILE_ROOTS 覆盖 Forge / NeoForge（现代与 legacy）三处产物目录', () => {
    expect(ARGS_FILE_ROOTS.map((r) => r.root)).toEqual([
      'libraries/net/minecraftforge/forge',
      'libraries/net/neoforged/neoforge',
      'libraries/net/neoforged/forge'
    ])
  })
})

/* ------------------------------------------------------------------ *
 *  核心注册表（离线可达的部分）
 * ------------------------------------------------------------------ */

describe('ServerCoreRegistry', () => {
  it('注册全部 9 种核心，vanilla 排在最前', () => {
    const { cores } = createHarness()
    const list = cores.list()
    expect(list.map((c) => c.type)).toEqual([
      'vanilla',
      'paper',
      'purpur',
      'fabric',
      'quilt',
      'forge',
      'neoforge',
      'spigot',
      'custom'
    ])
  })

  it('Spigot：不伪造下载，返回 BuildTools 手动步骤', async () => {
    const { cores } = createHarness()
    expect(cores.list().find((c) => c.type === 'spigot')?.note).toMatch(/BuildTools/)
    await expect(cores.listBuilds('spigot', '1.20.1')).resolves.toEqual([])
    const result = await cores.install('spigot', { dir: fixtureDir(), gameVersion: '1.20.1' })
    expect(result.manualSteps && result.manualSteps.length).toBeGreaterThan(0)
    expect(result.manualSteps?.join('\n')).toMatch(/BuildTools/)
    expect(result.warnings.join('\n')).toMatch(/不会伪造下载地址/)
    expect(result.jarFile).toBe('')
  })

  it('custom：只校验 jar 是否存在，不做下载', async () => {
    const { cores } = createHarness()
    const dir = fixtureDir()
    writeFixture(dir, 'server.jar')
    const ok = await cores.install('custom', { dir, gameVersion: '1.20.1', fileName: 'server.jar' })
    expect(ok.jarFile).toBe('server.jar')
    expect(ok.coreType).toBe('custom')

    // 未指定 fileName 时自动挑选 server.jar
    const auto = await cores.install('custom', { dir, gameVersion: '1.20.1' })
    expect(auto.fileName).toBe('server.jar')

    const emptyDir = fixtureDir()
    await expect(cores.install('custom', { dir: emptyDir, gameVersion: '1.20.1' })).rejects.toThrow(/未在.+找到任何 \.jar/)
    await expect(cores.install('custom', { dir, gameVersion: '1.20.1', fileName: 'missing.jar' })).rejects.toThrow(
      /不存在 missing\.jar/
    )
  })

  it('recommend 按 MC 版本给出偏好顺序', () => {
    const { cores } = createHarness()
    const for1201 = cores.recommend('1.20.1').map((r) => r.coreType)
    expect(for1201[0]).toBe('paper')
    expect(for1201).toContain('fabric')
    expect(for1201).toContain('neoforge')
    expect(for1201).toContain('forge')
    expect(for1201).toContain('vanilla')

    const for1710 = cores.recommend('1.7.10').map((r) => r.coreType)
    expect(for1710).toContain('forge')
    expect(for1710).toContain('vanilla')
    expect(for1710).not.toContain('paper')

    const snapshot = cores.recommend('24w14a').map((r) => r.coreType)
    expect(snapshot[0]).toBe('vanilla')

    for (const item of cores.recommend('1.20.1')) expect(item.reason.length).toBeGreaterThan(4)
  })
})

/* ------------------------------------------------------------------ *
 *  核心地址相关的纯函数
 * ------------------------------------------------------------------ */

describe('核心下载道具解析（Paper / Fabric）', () => {
  it('Paper 兼容 application / server / server:default 三种下载键', () => {
    expect(pickPaperDownload({ application: { name: 'paper-1.20.1-1963.jar', sha256: 'aa' } })).toEqual({
      name: 'paper-1.20.1-1963.jar',
      sha256: 'aa',
      size: undefined
    })
    expect(pickPaperDownload({ server: { name: 'paper-1.21.4-232.jar' } })?.name).toBe('paper-1.21.4-232.jar')
    expect(pickPaperDownload({ 'server:default': { name: 'paper-1.21.4-232.jar' } })?.name).toBe('paper-1.21.4-232.jar')
    // mojang-mappings 不是服务端 jar，必须跳过
    expect(pickPaperDownload({ 'mojang-mappings': { name: 'paper-1.21.4-232-mappings.txt' } })).toBeNull()
    expect(pickPaperDownload(undefined)).toBeNull()
  })

  it('Fabric 启动器固定命名与 content-disposition 解析', () => {
    expect(fabricServerLauncherFileName()).toBe('fabric-server-launch.jar')
    expect(
      parseContentDispositionFilename(
        'attachment; filename="fabric-server-mc.1.20.1-loader.0.16.9-launcher.1.0.1.jar"'
      )
    ).toBe('fabric-server-mc.1.20.1-loader.0.16.9-launcher.1.0.1.jar')
    expect(parseContentDispositionFilename("filename*=UTF-8''fabric-server-launch.jar")).toBe('fabric-server-launch.jar')
    expect(parseContentDispositionFilename(null)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 *  ServerManager：属性 / EULA（临时目录 + 假 store）
 * ------------------------------------------------------------------ */

describe('ServerManager：server.properties 与 EULA', () => {
  it('readProperties / writeProperties 走真实文件且保留注释', async () => {
    const dir = fixtureDir()
    const original = '#Minecraft server properties\nmotd=Old\n# 自定义注释\nview-distance=8\n'
    writeFixture(dir, 'server.properties', original)
    const { manager, getSaved } = createHarness([serverInstance({ id: 'srv-props', dir })])

    expect(await manager.readProperties('srv-props')).toEqual({ motd: 'Old', 'view-distance': '8' })

    await manager.writeProperties('srv-props', { motd: 'New', 'server-port': '25566' })
    const text = readFileSync(join(dir, 'server.properties'), 'utf8')
    expect(text.split('\n')[0]).toBe('#Minecraft server properties')
    expect(text.split('\n')[1]).toBe('motd=New')
    expect(text.split('\n')[2]).toBe('# 自定义注释')
    expect(text.split('\n')[3]).toBe('view-distance=8')
    expect(text.split('\n')[4]).toBe('server-port=25566')

    const instance = getSaved().find((s) => s.id === 'srv-props')
    expect(instance?.port).toBe(25566)
    expect(instance?.properties?.motd).toBe('New')
  })

  it('acceptEula 显式写入 eula=true（绝不默认接受）', async () => {
    const dir = fixtureDir()
    const { manager, getSaved } = createHarness([serverInstance({ id: 'srv-eula', dir })])
    expect(existsSync(join(dir, 'eula.txt'))).toBe(false)

    await manager.acceptEula('srv-eula', true)
    const text = readFileSync(join(dir, 'eula.txt'), 'utf8')
    expect(text).toContain('aka.ms/MinecraftEULA')
    expect(text.trim().endsWith('eula=true')).toBe(true)
    expect(getSaved().find((s) => s.id === 'srv-eula')?.eulaAccepted).toBe(true)

    await manager.acceptEula('srv-eula', false)
    expect(readFileSync(join(dir, 'eula.txt'), 'utf8').trim().endsWith('eula=false')).toBe(true)
    expect(getSaved().find((s) => s.id === 'srv-eula')?.eulaAccepted).toBe(false)
  })

  it('create（acceptEula=false 默认）不写 eula.txt；acceptEula=true 才写', async () => {
    const dir1 = fixtureDir()
    const dir2 = fixtureDir()
    const { manager, getSaved } = createHarness()

    const a = await manager.create({
      name: '无 EULA',
      dir: dir1,
      coreType: 'custom',
      gameVersion: '1.20.1',
      autoInstall: false
    })
    expect(a.eulaAccepted).toBe(false)
    expect(existsSync(join(dir1, 'eula.txt'))).toBe(false)

    const b = await manager.create({
      name: '已接受',
      dir: dir2,
      coreType: 'custom',
      gameVersion: '1.20.1',
      acceptEula: true,
      autoInstall: false,
      port: 25577
    })
    expect(b.eulaAccepted).toBe(true)
    expect(readFileSync(join(dir2, 'eula.txt'), 'utf8')).toContain('eula=true')
    // port 会写入 server.properties
    expect(readFileSync(join(dir2, 'server.properties'), 'utf8')).toContain('server-port=25577')
    expect(getSaved().map((s) => s.id)).toContain(b.id)
  })
})
