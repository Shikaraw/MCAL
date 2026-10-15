/**
 * 内容管理 + 平台集成的测试。
 *
 * 约束：
 *  - 不发起任何真实网络请求；Modrinth 只测纯函数（facets 构造、映射、选版本、下载项生成）。
 *  - zip fixture 由 adm-zip 在系统临时目录里现场构造，测试结束统一清理。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import AdmZip from 'adm-zip'
import type { ContentFile, ProjectVersion } from '@shared/types'
import { HttpClient } from '@core/net/http'
import { MirrorResolver } from '@core/net/mirror'
import { DownloadManager } from '@core/net/downloader'
import {
  KNOWN_GAME_VERSIONS,
  describePackFormat,
  detectKindFromEntries,
  expandVersionRange,
  guessContentKind,
  packFormatVersions,
  packFormatsForVersion,
  parseContentFile,
  parseFabricModJson,
  parseModsTomlText,
  parsePackMcmeta,
  parseToml,
  parseVersionConstraint,
  readLevelDatBuffer
} from '@core/content/metadata'
import {
  ContentManager,
  disabledName,
  enabledName,
  gameVersionsMatch,
  isDisabledPath,
  loaderCompatibility
} from '@core/content/manager'
import {
  ModrinthClient,
  buildFacets,
  mapLoader,
  mapProjectType,
  mapSearchHit,
  mapVersion,
  mirrorCacheKey,
  pickBestVersion
} from '@core/platform/modrinth'
import { DEFAULT_TARGET_SUBDIRS, PlatformService, assertPlatformSupported } from '@core/platform/index'
import { pathExists } from '@core/util/fsx'

/* ------------------------------------------------------------------ *
 *  临时目录与 fixture 工具
 * ------------------------------------------------------------------ */

const tempDirs: string[] = []

async function makeTempDir(prefix = 'mcal-content-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeZip(target: string, files: Record<string, string | Buffer>): void {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'))
  }
  zip.writeZip(target)
}

/* -------- 最小 NBT 编码器（仅测试用，用于构造 level.dat） -------- */

interface NbtEntry {
  name: string
  type: number
  payload: Buffer
}

function nbtByte(v: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeInt8(v)
  return b
}

function nbtShort(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeInt16BE(v)
  return b
}

function nbtInt(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32BE(v)
  return b
}

function nbtLong(v: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64BE(v)
  return b
}

function nbtString(v: string): Buffer {
  const body = Buffer.from(v, 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(body.length)
  return Buffer.concat([len, body])
}

function nbtCompound(entries: NbtEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) parts.push(Buffer.from([entry.type]), nbtString(entry.name), entry.payload)
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function makeLevelDat(levelName: string, dataVersion: number): Buffer {
  const data = nbtCompound([
    { name: 'LevelName', type: 8, payload: nbtString(levelName) },
    { name: 'DataVersion', type: 3, payload: nbtInt(dataVersion) },
    { name: 'LastPlayed', type: 4, payload: nbtLong(1700000000000n) },
    { name: 'hardcore', type: 1, payload: nbtByte(0) },
    { name: 'RainTime', type: 2, payload: nbtShort(12000) }
  ])
  const root = Buffer.concat([Buffer.from([10]), nbtString(''), nbtCompound([{ name: 'Data', type: 10, payload: data }])])
  return gzipSync(root)
}

/* -------- 常用 fixture 内容 -------- */

const FABRIC_MOD_JSON = JSON.stringify(
  {
    schemaVersion: 1,
    id: 'coolmod',
    version: '2.1.0',
    name: 'Cool Mod',
    description: '一个测试用 mod',
    authors: [{ name: 'Alice', contact: { homepage: 'https://example.com' } }, 'Bob'],
    license: 'MIT',
    contact: { homepage: 'https://example.com/coolmod', sources: 'https://github.com/a/coolmod' },
    environment: 'client',
    entrypoints: { main: ['com.example.CoolMod'] },
    depends: {
      minecraft: '>=1.20.1 <1.20.6',
      fabricloader: '>=0.14',
      java: '>=17',
      'fabric-api': '*',
      missinglib: '>=1.0.0'
    },
    breaks: { 'bad-mod': '<1.0' }
  },
  null,
  2
)

const FORGE_MODS_TOML = `
# 测试用 mods.toml（含多行字符串与注释）
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
issueTrackerURL="https://github.com/example/forgeissues"

[[mods]]
modId="forgemod"
version="1.2.3"
displayName="Forge Mod"
description='''
多行描述第一段
第二段
'''
authors="Alice, Bob"
displayTest="IGNORE_SERVER_VERSION"

[[dependencies.forgemod]]
modId="minecraft"
mandatory=true
versionRange="[1.20,1.21)"
ordering="NONE"
side="BOTH"

[[dependencies.forgemod]]
modId="forge"
mandatory=true
versionRange="[47,)"
ordering="NONE"
side="BOTH"
`

function packMcmeta(packFormat: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      pack: {
        pack_format: packFormat,
        description: { translate: 'pack.cool.name' },
        ...extra
      }
    },
    null,
    2
  )
}

/* ------------------------------------------------------------------ *
 *  TOML 子集解析
 * ------------------------------------------------------------------ */

describe('parseToml / parseModsTomlText', () => {
  it('解析 [[mods]]、点分表、多行字符串、数字与布尔', () => {
    const table = parseToml(FORGE_MODS_TOML)
    const mods = table.mods as unknown[]
    expect(Array.isArray(mods)).toBe(true)
    expect(mods).toHaveLength(1)
    const mod = mods[0] as Record<string, unknown>
    expect(mod.modId).toBe('forgemod')
    expect(mod.version).toBe('1.2.3')
    expect(mod.displayTest).toBe('IGNORE_SERVER_VERSION')
    expect(String(mod.description)).toContain('多行描述第一段')
    expect(String(mod.description)).toContain('第二段')
    expect(table.loaderVersion).toBe('[47,)')
  })

  it('解析内联数组、注释、负数与浮点', () => {
    const table = parseToml(`
# 注释
name = "demo" # 行尾注释
list = [1, 2, 3]
strs = ["a", "b"]
flag = false
neg = -12
ratio = 1.5
hex = 0x1F
`)
    expect(table.name).toBe('demo')
    expect(table.list).toEqual([1, 2, 3])
    expect(table.strs).toEqual(['a', 'b'])
    expect(table.flag).toBe(false)
    expect(table.neg).toBe(-12)
    expect(table.ratio).toBe(1.5)
    expect(table.hex).toBe(31)
  })

  it('把 mods.toml 映射为结构化依赖清单', () => {
    const parsed = parseModsTomlText(FORGE_MODS_TOML)
    expect(parsed.mods).toHaveLength(1)
    expect(parsed.mods[0].modId).toBe('forgemod')
    expect(parsed.mods[0].displayName).toBe('Forge Mod')
    // authors="Alice, Bob" 按逗号拆分
    expect(parsed.mods[0].authors).toEqual(['Alice', 'Bob'])
    const deps = parsed.dependencies.forgemod
    expect(deps.map((d) => d.modId)).toEqual(['minecraft', 'forge'])
    expect(deps[0].mandatory).toBe(true)
    expect(deps[0].versionRange).toBe('[1.20,1.21)')
  })

  it('NeoForge 的 type 字段（required/optional）映射为 mandatory', () => {
    const parsed = parseModsTomlText(`
[[mods]]
modId="neomod"
version="1.0.0"

[[dependencies.neomod]]
modId="minecraft"
type="required"
versionRange="[1.21,1.22)"
`)
    expect(parsed.dependencies.neomod[0].mandatory).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  fabric.mod.json
 * ------------------------------------------------------------------ */

describe('parseFabricModJson', () => {
  const parsed = parseFabricModJson(FABRIC_MOD_JSON)

  it('解析基础字段、作者与许可证', () => {
    expect(parsed.meta.id).toBe('coolmod')
    expect(parsed.meta.name).toBe('Cool Mod')
    expect(parsed.meta.version).toBe('2.1.0')
    expect(parsed.meta.authors).toEqual(['Alice', 'Bob'])
    expect(parsed.meta.license).toBe('MIT')
    expect(parsed.meta.homepage).toBe('https://example.com/coolmod')
    expect(parsed.meta.environment).toBe('client')
    expect(parsed.meta.loaders).toEqual(['fabric', 'quilt'])
  })

  it('minecraft 版本范围保守展开，不越过上界', () => {
    const versions = parsed.meta.gameVersions ?? []
    expect(versions).toContain('1.20.1')
    expect(versions).toContain('1.20.5')
    expect(versions).not.toContain('1.20.6')
    expect(versions).not.toContain('1.21')
  })

  it('depends 保留所有依赖（含 java / fabricloader）并标注必需性', () => {
    const ids = (parsed.meta.depends ?? []).map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining(['minecraft', 'fabricloader', 'java', 'fabric-api', 'missinglib']))
    expect(parsed.meta.depends?.every((d) => d.required)).toBe(true)
    expect(parsed.meta.depends?.find((d) => d.id === 'fabric-api')?.versionRange).toBeUndefined()
  })

  it('breaks 写入 meta.breaks', () => {
    expect(parsed.meta.breaks).toEqual([{ id: 'bad-mod', versionRange: '<1.0' }])
  })
})

/* ------------------------------------------------------------------ *
 *  pack_format 映射与版本约束
 * ------------------------------------------------------------------ */

describe('pack_format 对照表', () => {
  it('资源包格式与 MC 版本双向映射', () => {
    expect(packFormatVersions(15, 'resourcepack')).toEqual(['1.20', '1.20.1'])
    expect(packFormatVersions(55, 'resourcepack')).toEqual(['1.21.5'])
    expect(packFormatVersions(34, 'resourcepack')).toEqual(['1.21', '1.21.1'])
    expect(packFormatsForVersion('1.20.1', 'resourcepack')).toEqual([15])
    expect(packFormatsForVersion('1.16', 'resourcepack')).toEqual([5])
    expect(packFormatsForVersion('1.14.4', 'resourcepack')).toEqual([4])
  })

  it('数据包格式在 1.19.3 之后与资源包分叉', () => {
    expect(packFormatsForVersion('1.20.4', 'resourcepack')).toEqual([22])
    expect(packFormatsForVersion('1.20.4', 'datapack')).toEqual([26])
    expect(packFormatsForVersion('1.21.5', 'datapack')).toEqual([71])
    expect(packFormatsForVersion('1.21.5', 'resourcepack')).toEqual([55])
  })

  it('未收录或不存在的格式返回 null / 空数组（不编造）', () => {
    expect(packFormatVersions(999, 'resourcepack')).toBeNull()
    expect(packFormatVersions(11, 'datapack')).toBeNull()
    expect(packFormatsForVersion('1.25', 'resourcepack')).toEqual([])
    expect(describePackFormat(999, 'resourcepack')).toContain('未知')
    expect(describePackFormat(34, 'resourcepack')).toContain('1.21')
  })
})

describe('版本约束解析', () => {
  it('识别 >=a <b、~、通配、Maven 区间与精确版本', () => {
    expect(expandVersionRange('>=1.20 <1.21')).toEqual([
      '1.20',
      '1.20.1',
      '1.20.2',
      '1.20.3',
      '1.20.4',
      '1.20.5',
      '1.20.6'
    ])
    expect(expandVersionRange('~1.20.1')?.[0]).toBe('1.20.1')
    expect(expandVersionRange('1.20.x')).toEqual(expandVersionRange('>=1.20 <1.21') as string[])
    expect(expandVersionRange('[1.19,1.20)')).toEqual(['1.19', '1.19.1', '1.19.2', '1.19.3', '1.19.4'])
    expect(expandVersionRange('1.20.1')).toEqual(['1.20.1'])
  })

  it('无法保守展开时返回 null（* / 未知形态 / 超出已知列表）', () => {
    expect(expandVersionRange('*')).toBeNull()
    expect(expandVersionRange('随便写的')).toBeNull()
    expect(expandVersionRange('>=1.21.6')).toBeNull()
    expect(expandVersionRange('>=1.6.1')).toBeNull() // 覆盖整个已知列表，展开无信息量
    expect(parseVersionConstraint('*')?.kind).toBe('any')
    expect(parseVersionConstraint('~1.20.1')?.test('1.20.4')).toBe(true)
    expect(parseVersionConstraint('~1.20.1')?.test('1.21')).toBe(false)
  })

  it('已知版本列表不含未确认的版本', () => {
    expect(KNOWN_GAME_VERSIONS).toContain('1.21.5')
    expect(KNOWN_GAME_VERSIONS).not.toContain('1.21.6')
  })
})

/* ------------------------------------------------------------------ *
 *  NBT / level.dat
 * ------------------------------------------------------------------ */

describe('NBT 与 level.dat', () => {
  it('读取 LevelName 与 DataVersion', () => {
    const info = readLevelDatBuffer(makeLevelDat('测试世界', 3465))
    expect(info.levelName).toBe('测试世界')
    expect(info.dataVersion).toBe(3465)
  })

  it('未压缩的 level.dat 也能读取', () => {
    const info = readLevelDatBuffer(gunzipSync(makeLevelDat('Raw', 3953)))
    expect(info.levelName).toBe('Raw')
    expect(info.dataVersion).toBe(3953)
  })
})

/* ------------------------------------------------------------------ *
 *  类型猜测 / 内容嗅探
 * ------------------------------------------------------------------ */

describe('guessContentKind 与 detectKindFromEntries', () => {
  it('按文件名/扩展名猜测', () => {
    expect(guessContentKind('sodium-fabric-0.5.8.jar')).toBe('mod')
    expect(guessContentKind('OptiFine_1.20.1_HD_U_I6.jar.disabled')).toBe('mod')
    expect(guessContentKind('Faithful 32x - 1.20.zip')).toBe('resourcepack')
    expect(guessContentKind('ComplementaryShaders_v4.zip')).toBe('shaderpack')
    expect(guessContentKind('MyDataPack-1.20.zip')).toBe('datapack')
    expect(guessContentKind('SomeModpack-1.20.1.zip')).toBe('modpack')
    expect(guessContentKind('MyWorld.zip')).toBe('world')
    expect(guessContentKind('something.mrpack')).toBe('modpack')
    // 无关键词的 zip 兜底为资源包，真实类型由内容嗅探纠正
    expect(guessContentKind('unknown-bundle.zip')).toBe('resourcepack')
  })

  it('按内容条目嗅探', () => {
    expect(detectKindFromEntries(['assets/minecraft/textures/x.png', 'pack.mcmeta'])).toBe('resourcepack')
    expect(detectKindFromEntries(['data/minecraft/tags/x.json', 'pack.mcmeta'])).toBe('datapack')
    expect(detectKindFromEntries(['shaders/shadow.fsh', 'shaders/shaders.properties'])).toBe('shaderpack')
    expect(detectKindFromEntries(['level.dat', 'region/r.0.0.mca'])).toBe('world')
    expect(detectKindFromEntries(['modrinth.index.json', 'overrides/config/a.txt'])).toBe('modpack')
    expect(detectKindFromEntries(['fabric.mod.json', 'com/example/A.class'])).toBe('mod')
    // 单层包装目录
    expect(detectKindFromEntries(['MyPack/pack.mcmeta', 'MyPack/assets/a.png'])).toBe('resourcepack')
    expect(detectKindFromEntries(['random.txt'])).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 *  zip fixture：真实解析路径
 * ------------------------------------------------------------------ */

describe('parseContentFile（zip fixture）', () => {
  let dir: string

  beforeAll(async () => {
    dir = await makeTempDir()
    writeZip(join(dir, 'fabric-mod.jar'), {
      'fabric.mod.json': FABRIC_MOD_JSON,
      'com/example/CoolMod.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    })
    writeZip(join(dir, 'forge-mod.jar'), {
      'META-INF/mods.toml': FORGE_MODS_TOML,
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n'
    })
    writeZip(join(dir, 'pack.zip'), {
      'pack.mcmeta': packMcmeta(15, { supported_formats: [15, 18] }),
      'assets/minecraft/textures/gui/x.png': 'png'
    })
    writeZip(join(dir, 'datapack.zip'), {
      'pack.mcmeta': packMcmeta(48),
      'data/cool/advancements/a.json': '{}'
    })
    writeZip(join(dir, 'optifine-shader.zip'), {
      'shaders/shaders.properties': 'shadowMapResolution=2048',
      'shaders/shadow.fsh': '/* DRAWBUFFERS:0 */\n#version 120\nvoid main() {}\n',
      'shaders/composite.vsh': '#version 120\nvoid main() {}\n'
    })
    writeZip(join(dir, 'iris-shader.zip'), {
      'iris.properties': 'enableShadows=true',
      'shaders/shadow.fsh': '/* RENDERTARGETS: 0 */\n#version 330 core\n#include "/lib/util.glsl"\nvoid main() {}\n'
    })
    writeZip(join(dir, 'world.zip'), {
      'level.dat': makeLevelDat('ZipWorld', 3465),
      'region/r.0.0.mca': 'region'
    })
    writeZip(join(dir, 'empty.jar'), {
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n'
    })
  })

  it('fabric mod：元数据、环境、依赖、版本范围', async () => {
    const parsed = await parseContentFile(join(dir, 'fabric-mod.jar'), 'mod')
    expect(parsed.meta.id).toBe('coolmod')
    expect(parsed.meta.environment).toBe('client')
    expect(parsed.meta.depends?.map((d) => d.id)).toContain('missinglib')
    expect(parsed.warnings).toHaveLength(0)
  })

  it('forge mod：mods.toml + displayTest → 仅客户端 + minecraft 范围', async () => {
    const parsed = await parseContentFile(join(dir, 'forge-mod.jar'), 'mod')
    expect(parsed.meta.id).toBe('forgemod')
    expect(parsed.meta.loaders).toEqual(['forge'])
    expect(parsed.meta.environment).toBe('client')
    expect(parsed.meta.gameVersions).toContain('1.20.1')
    expect(parsed.meta.gameVersions).not.toContain('1.21')
  })

  it('资源包：pack_format、supported_formats、translate 描述', async () => {
    const parsed = await parseContentFile(join(dir, 'pack.zip'), 'resourcepack')
    expect(parsed.meta.packFormat).toBe(15)
    expect(parsed.meta.gameVersions).toContain('1.20.1')
    expect(parsed.meta.description).toBe('pack.cool.name')
    expect(parsed.warnings).toHaveLength(0)
  })

  it('数据包：pack_format 走数据包对照表', async () => {
    const parsed = await parseContentFile(join(dir, 'datapack.zip'), 'datapack')
    expect(parsed.meta.packFormat).toBe(48)
    expect(parsed.meta.gameVersions).toEqual(['1.21', '1.21.1'])
  })

  it('光影：OptiFine 风格与 Iris 风格可区分', async () => {
    const optifine = await parseContentFile(join(dir, 'optifine-shader.zip'), 'shaderpack')
    expect(optifine.meta.shaderLanguage).toBe('OptiFine')
    const iris = await parseContentFile(join(dir, 'iris-shader.zip'), 'shaderpack')
    expect(iris.meta.shaderLanguage).toContain('Iris')
  })

  it('存档 zip：读到 level.dat 的 LevelName / DataVersion', async () => {
    const parsed = await parseContentFile(join(dir, 'world.zip'), 'world')
    expect(parsed.meta.name).toBe('ZipWorld')
    const asDatapack = await parseContentFile(join(dir, 'world.zip'), 'datapack')
    expect(asDatapack.warnings.join('')).toContain('更像是一个存档')
  })

  it('没有元数据的 jar：给出告警而不是抛错', async () => {
    const parsed = await parseContentFile(join(dir, 'empty.jar'), 'mod')
    expect(parsed.meta.id).toBeUndefined()
    expect(parsed.warnings.length).toBeGreaterThan(0)
  })
})

describe('parsePackMcmeta', () => {
  it('解析 supported_formats 的三种写法', () => {
    expect(parsePackMcmeta(JSON.stringify({ pack: { pack_format: 15, supported_formats: [15, 18] } })).supportedFormats).toEqual([
      15, 16, 17, 18
    ])
    expect(
      parsePackMcmeta(
        JSON.stringify({ pack: { pack_format: 34, supported_formats: { min_inclusive: 34, max_inclusive: 42 } } })
      ).supportedFormats
    ).toEqual([34, 35, 36, 37, 38, 39, 40, 41, 42])
    expect(
      parsePackMcmeta(JSON.stringify({ pack: { pack_format: 34, supported_formats: [{ min_inclusive: 34, max_inclusive: 34 }, 42] } }))
        .supportedFormats
    ).toEqual([34, 42])
  })

  it('description 支持字符串与 translate 键', () => {
    expect(parsePackMcmeta(JSON.stringify({ pack: { pack_format: 15, description: '普通描述' } })).description).toBe('普通描述')
    const translated = parsePackMcmeta(JSON.stringify({ pack: { pack_format: 15, description: { translate: 'pack.x' } } }))
    expect(translated.description).toBe('pack.x')
    expect(translated.descriptionIsTranslateKey).toBe(true)
  })

  it('畸形 JSON 返回空结果而不抛错', () => {
    expect(parsePackMcmeta('{ not json').packFormat).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 *  ContentManager
 * ------------------------------------------------------------------ */

describe('ContentManager', () => {
  let gameDir: string
  let srcDir: string
  let manager: ContentManager

  beforeAll(async () => {
    gameDir = await makeTempDir('mcal-game-')
    srcDir = await makeTempDir('mcal-src-')
    manager = new ContentManager({ downloadManager: new DownloadManager({ client: new HttpClient(), mirror: new MirrorResolver(MirrorResolver.default()) }) })

    await mkdir(join(gameDir, 'mods'), { recursive: true })
    await mkdir(join(gameDir, 'resourcepacks'), { recursive: true })
    await mkdir(join(gameDir, 'shaderpacks'), { recursive: true })
    await mkdir(join(gameDir, 'datapacks'), { recursive: true })
    await mkdir(join(gameDir, 'saves', '世界一号'), { recursive: true })
    await writeFile(join(gameDir, 'saves', '世界一号', 'level.dat'), makeLevelDat('世界一号', 3465))

    writeZip(join(gameDir, 'mods', 'coolmod-2.1.0.jar'), { 'fabric.mod.json': FABRIC_MOD_JSON })
    writeZip(
      join(gameDir, 'mods', 'sodium-fabric.jar'),
      { 'fabric.mod.json': JSON.stringify({ id: 'sodium', name: 'Sodium', version: '0.5.8', environment: '*', depends: { minecraft: '1.20.1' } }) }
    )
    writeZip(
      join(gameDir, 'mods', 'embeddium.jar'),
      { 'fabric.mod.json': JSON.stringify({ id: 'embeddium', name: 'Embeddium', version: '0.3.31', depends: {} }) }
    )
    writeZip(join(gameDir, 'mods', 'OptiFine_1.20.1_HD_U_I6.jar'), {
      'net/optifine/Config.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    })
    writeZip(join(gameDir, 'mods', 'oldmod-1.20.1.jar.disabled'), {
      'fabric.mod.json': JSON.stringify({ id: 'oldmod', name: 'Old Mod', version: '1.0.0', depends: { minecraft: '>=1.20 <1.21' } })
    })
    writeZip(join(gameDir, 'resourcepacks', 'faithful.zip'), { 'pack.mcmeta': packMcmeta(15), 'assets/a.png': 'x' })
    writeZip(join(gameDir, 'shaderpacks', 'iris-pack.zip'), {
      'iris.properties': 'a=b',
      'shaders/final.fsh': '#version 330 core\n/* RENDERTARGETS: 0 */\nvoid main() {}'
    })
    writeZip(join(gameDir, 'datapacks', 'qol.zip'), { 'pack.mcmeta': packMcmeta(48), 'data/qol/functions/a.mcfunction': 'say hi' })

    // 导入源文件
    writeZip(join(srcDir, 'NewPack.zip'), { 'pack.mcmeta': packMcmeta(34), 'assets/x.png': 'x' })
    writeZip(join(srcDir, 'NewWorld.zip'), { 'level.dat': makeLevelDat('导入世界', 3953), 'region/r.mca': 'r' })
    await mkdir(join(srcDir, 'MyShader', 'shaders'), { recursive: true })
    await writeFile(join(srcDir, 'MyShader', 'shaders', 'shaders.properties'), 'a=b')
    await writeFile(join(srcDir, 'MyShader', 'shaders', 'gbuffers.fsh'), '#version 120\nvoid main() {}')
    await writeZip(join(srcDir, 'NewMod.jar'), { 'fabric.mod.json': JSON.stringify({ id: 'newmod', version: '1.0.0', depends: {} }) })
  })

  it('扫描实例目录：类型、启用状态与元数据', async () => {
    const files = await manager.scan({ gameDir, withMeta: true })
    const byName = new Map(files.map((f) => [f.fileName, f]))
    expect(byName.get('coolmod-2.1.0.jar')?.kind).toBe('mod')
    expect(byName.get('coolmod-2.1.0.jar')?.enabled).toBe(true)
    expect(byName.get('coolmod-2.1.0.jar')?.meta?.id).toBe('coolmod')
    const disabled = byName.get('oldmod-1.20.1.jar.disabled')
    expect(disabled?.enabled).toBe(false)
    expect(disabled?.kind).toBe('mod')
    expect(byName.get('faithful.zip')?.kind).toBe('resourcepack')
    expect(byName.get('iris-pack.zip')?.kind).toBe('shaderpack')
    expect(byName.get('qol.zip')?.kind).toBe('datapack')
    expect(byName.get('世界一号')?.kind).toBe('world')
    expect(byName.get('世界一号')?.meta?.name).toBe('世界一号')
  })

  it('扫描进度回调与 kinds 过滤', async () => {
    const seen: number[] = []
    const files = await manager.scan({
      gameDir,
      kinds: ['mod'],
      withMeta: true,
      onProgress: (done, total) => {
        if (done === total) seen.push(total)
      }
    })
    expect(files.every((f) => f.kind === 'mod')).toBe(true)
    expect(files.length).toBe(5)
    expect(seen).toContain(5)
  })

  it('启用/禁用通过 .disabled 重命名实现', async () => {
    expect(isDisabledPath('a.jar.disabled')).toBe(true)
    expect(disabledName('a.jar')).toBe('a.jar.disabled')
    expect(enabledName('a.jar.disabled')).toBe('a.jar')

    const target = join(gameDir, 'mods', 'coolmod-2.1.0.jar')
    const renamed = await manager.setEnabled(target, false)
    expect(renamed).toBe(`${target}.disabled`)
    const files = await manager.scan({ gameDir, kinds: ['mod'], withMeta: false })
    expect(files.find((f) => f.fileName === 'coolmod-2.1.0.jar.disabled')?.enabled).toBe(false)
    const restored = await manager.setEnabled(renamed, true)
    expect(restored).toBe(target)
  })

  it('导入文件：按内容嗅探路由到正确目录，重名自动加序号', async () => {
    const result = await manager.importFiles(gameDir, [
      join(srcDir, 'NewPack.zip'),
      join(srcDir, 'NewMod.jar'),
      join(srcDir, 'NewWorld.zip'),
      join(srcDir, 'MyShader')
    ])
    expect(result.skipped).toHaveLength(0)
    expect(result.imported).toHaveLength(4)
    expect(result.imported.some((p) => p.includes('resourcepacks') && p.endsWith('NewPack.zip'))).toBe(true)
    expect(result.imported.some((p) => p.includes('mods') && p.endsWith('NewMod.jar'))).toBe(true)
    expect(result.imported.some((p) => p.includes('shaderpacks') && p.endsWith('MyShader'))).toBe(true)
    // 世界 zip 解压成 saves/<名字>/（不再是 zip 文件）
    const world = result.imported.find((p) => p.includes('saves') && p.includes('NewWorld'))
    expect(world).toBeTruthy()
    expect(await pathExists(join(world!, 'level.dat'))).toBe(true)

    const again = await manager.importFiles(gameDir, [join(srcDir, 'NewPack.zip')])
    expect(again.imported[0]).toContain('NewPack (1).zip')
  })

  it('hashFiles 返回 sha1 索引', async () => {
    const hashes = await manager.hashFiles([join(gameDir, 'mods', 'coolmod-2.1.0.jar')])
    const hash = Object.values(hashes)[0]
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('summarize 输出 token 友好的清单', async () => {
    const files = await manager.scan({ gameDir, withMeta: true })
    const summary = manager.summarize(files)
    expect(summary).toContain('内容概览')
    expect(summary).toContain('sodium')
    expect(summary).toContain('已禁用')
    expect(summary.split('\n').length).toBeLessThanOrEqual(51)
  })

  it('findMissingDependencies 忽略 minecraft/fabricloader/java/fabric-api', async () => {
    const files = await manager.scan({ gameDir, kinds: ['mod'], withMeta: true })
    const missing = manager.findMissingDependencies(files)
    expect(missing.map((m) => m.modId)).toEqual(['missinglib'])
    expect(missing[0].requiredBy).toContain('coolmod@2.1.0')
    expect(missing[0].versionRange).toBe('>=1.0.0')
  })

  it('findMissingDependencies 不把已禁用 mod 视为已安装', async () => {
    const files: ContentFile[] = [
      {
        path: 'C:/g/mods/a.jar',
        fileName: 'a.jar',
        kind: 'mod',
        size: 1,
        mtimeMs: 0,
        enabled: true,
        meta: { id: 'a', depends: [{ id: 'oldmod', required: true }] }
      },
      {
        path: 'C:/g/mods/b.jar.disabled',
        fileName: 'b.jar.disabled',
        kind: 'mod',
        size: 1,
        mtimeMs: 0,
        enabled: false,
        meta: { id: 'oldmod', depends: [] }
      }
    ]
    expect(manager.findMissingDependencies(files).map((m) => m.modId)).toEqual(['oldmod'])
  })

  it('checkPackFormat 识别不兼容的 pack_format', async () => {
    const files = await manager.scan({ gameDir, kinds: ['resourcepack', 'datapack'], withMeta: true })
    const pack = files.find((f) => f.fileName === 'faithful.zip')!
    // 1.20.1 需要 format 15 → 兼容
    expect(manager.checkPackFormat(pack, '1.20.1')).toBeNull()
    // 1.21.1 需要 format 34 → 不兼容
    const issue = manager.checkPackFormat(pack, '1.21.1')
    expect(issue?.code).toBe('pack.format-mismatch')
    expect(issue?.severity).toBe('warning')
  })

  it('checkPackFormat 尊重 supported_formats', async () => {
    const file: ContentFile = {
      path: 'C:/g/resourcepacks/p.zip',
      fileName: 'p.zip',
      kind: 'resourcepack',
      size: 1,
      mtimeMs: 0,
      enabled: true,
      meta: { name: 'p', packFormat: 15 }
    }
    const { setMetaExtra } = await import('@core/content/metadata')
    setMetaExtra(file.meta!, { supportedFormats: [34] })
    expect(manager.checkPackFormat(file, '1.21.1')).toBeNull()
  })

  it('validate 覆盖版本/加载器/环境/依赖/重复/性能冲突/光影', async () => {
    const issues = await manager.validate({ gameDir, gameVersion: '1.21.1', loaderType: 'fabric', side: 'server' })
    const codes = issues.map((i) => i.code)
    expect(codes).toContain('mod.game-version-mismatch')
    expect(codes).toContain('mod.missing-dependency')
    expect(codes).toContain('mod.client-only-on-server')
    expect(codes).toContain('mod.performance-conflict')
    expect(codes).toContain('pack.format-mismatch')
    expect(codes).toContain('shader.iris-required')
    const missing = issues.find((i) => i.code === 'mod.missing-dependency')
    expect(missing?.message).toContain('missinglib')
    expect(missing?.suggestion).toContain('missinglib')
  })

  it('loaderCompatibility：Fabric mod 不能装在 Forge；NeoForge 兼容旧 Forge 只告警', () => {
    expect(loaderCompatibility('forge', ['fabric'])).toBe('mismatch')
    expect(loaderCompatibility('fabric', ['fabric', 'quilt'])).toBe('ok')
    expect(loaderCompatibility('quilt', ['fabric'])).toBe('ok')
    expect(loaderCompatibility('neoforge', ['forge'])).toBe('warn')
    expect(loaderCompatibility('vanilla', ['fabric'])).toBe('mismatch')
    expect(loaderCompatibility('fabric', undefined)).toBe('ok')
    expect(gameVersionsMatch(['1.20'], '1.20.1')).toBe(true)
    expect(gameVersionsMatch(['1.20.1'], '1.21')).toBe(false)
    expect(gameVersionsMatch(undefined, '1.21')).toBe(true)
  })

  it('remove 删除文件并报告失败项', async () => {
    const garbage = join(gameDir, 'mods', 'garbage.jar')
    await writeFile(garbage, 'x')
    const result = await manager.remove([garbage, join(gameDir, 'mods', '不存在的文件.jar')])
    expect(result.removed).toEqual([garbage])
    expect(result.failed).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 *  Modrinth 纯函数
 * ------------------------------------------------------------------ */

describe('Modrinth 纯函数', () => {
  it('buildFacets 生成嵌套数组 JSON 并正确编码', () => {
    const facets = buildFacets({ projectType: 'mod', gameVersion: '1.20.1', loader: 'fabric' })
    expect(facets).toBe('[["project_type:mod"],["categories:fabric"],["versions:1.20.1"]]')
    const encoded = new URLSearchParams({ facets: facets! }).toString()
    expect(encoded).toContain('facets=%5B%5B%22project_type%3Amod%22%5D')
    expect(buildFacets({})).toBeNull()
    expect(buildFacets({ projectType: 'shader', loader: 'custom' })).toBe('[["project_type:shader"]]')
    expect(buildFacets({ loader: 'vanilla' })).toBeNull()
    expect(buildFacets({ projectType: 'datapack', categories: ['adventure'] })).toBe(
      '[["project_type:datapack"],["categories:adventure"]]'
    )
  })

  it('mapLoader / mapProjectType 映射到 Modrinth 取值', () => {
    expect(mapLoader('fabric')).toBe('fabric')
    expect(mapLoader('neoforge')).toBe('neoforge')
    expect(mapLoader('quilt')).toBe('quilt')
    expect(mapLoader('vanilla')).toBeNull()
    expect(mapLoader('optifine')).toBeNull()
    expect(mapProjectType('shader')).toBe('shader')
    expect(mapProjectType('resourcepack')).toBe('resourcepack')
  })

  it('mirrorCacheKey 把动态 id 折叠为 *', () => {
    expect(mirrorCacheKey('/v2/project/sodium/version')).toBe('v2/project/*/version')
    expect(mirrorCacheKey('/v2/search')).toBe('v2/search')
    expect(mirrorCacheKey('/v2/version/abc123')).toBe('v2/version/*')
    expect(mirrorCacheKey('/v2/version_files')).toBe('v2/version_files')
  })

  it('mapSearchHit 在缺失 author 时留空而不报错', () => {
    const hit = mapSearchHit({
      project_id: 'AABB',
      project_type: 'mod',
      slug: 'sodium',
      title: 'Sodium',
      description: 'rendering',
      categories: ['optimization', 'fabric'],
      display_categories: ['optimization'],
      downloads: 1234,
      follows: 10,
      icon_url: 'https://x/icon.png',
      versions: ['1.20.1', '1.21'],
      license: 'LGPL-3.0',
      date_modified: '2024-01-01T00:00:00Z'
    })
    expect(hit.projectId).toBe('AABB')
    expect(hit.author).toBeUndefined()
    expect(hit.loaders).toEqual(['fabric'])
    expect(hit.categories).toContain('optimization')
    expect(hit.follows).toBe(10)
  })

  it('mapVersion 解析依赖与文件', () => {
    const version = mapVersion({
      id: 'ver1',
      project_id: 'proj1',
      name: 'v1.0',
      version_number: '1.0.0',
      version_type: 'release',
      game_versions: ['1.20.1'],
      loaders: ['fabric'],
      dependencies: [{ project_id: 'dep1', dependency_type: 'required' }],
      files: [{ url: 'https://cdn/x.jar', filename: 'x.jar', primary: true, size: 10, hashes: { sha1: 'ABC' } }],
      date_published: '2024-05-01T00:00:00Z',
      downloads: 5
    })
    expect(version.versionId).toBe('ver1')
    expect(version.dependencies[0].projectId).toBe('dep1')
    expect(version.files[0].primary).toBe(true)
    expect(version.files[0].hashes?.sha1).toBe('ABC')
  })

  it('pickBestVersion 优先 release，其次下载量与发布时间', () => {
    const base: ProjectVersion = {
      platform: 'modrinth',
      versionId: 'v',
      projectId: 'p',
      name: 'n',
      versionNumber: '1',
      versionType: 'release',
      gameVersions: ['1.20.1'],
      loaders: ['fabric'],
      dependencies: [],
      files: []
    }
    const versions: ProjectVersion[] = [
      { ...base, versionId: 'beta1', versionType: 'beta', downloads: 999, publishedAt: '2024-09-01' },
      { ...base, versionId: 'rel-old', versionType: 'release', downloads: 100, publishedAt: '2024-01-01' },
      { ...base, versionId: 'rel-new', versionType: 'release', downloads: 500, publishedAt: '2024-08-01' },
      { ...base, versionId: 'rel-future', versionType: 'alpha', downloads: 10000, publishedAt: '2024-10-01' },
      { ...base, versionId: 'wrong-mc', versionType: 'release', gameVersions: ['1.19'], downloads: 99999 }
    ]
    expect(pickBestVersion(versions, { gameVersion: '1.20.1', loader: 'fabric' })?.versionId).toBe('rel-new')
    // 过滤过严时回退全集，不返回 null
    expect(pickBestVersion(versions, { gameVersion: '1.21.4', loader: 'fabric' })).not.toBeNull()
    expect(pickBestVersion([], {})).toBeNull()
  })

  it('buildDownloadItems 只取主文件并带 sha1/大小', () => {
    const client = new ModrinthClient({
      client: new HttpClient(),
      mirror: new MirrorResolver(MirrorResolver.default()),
      userAgent: 'MCAL-test'
    })
    const version = mapVersion({
      id: 'ver1',
      project_id: 'proj1',
      name: 'v1',
      version_number: '1.0',
      version_type: 'release',
      game_versions: ['1.20.1'],
      loaders: ['fabric'],
      files: [
        { url: 'https://cdn/sources.jar', filename: 'sources.jar', primary: false, size: 1 },
        { url: 'https://cdn/x.jar', filename: 'x.jar', primary: true, size: 10, hashes: { sha1: 'DEADBEEF' } }
      ]
    })
    const items = client.buildDownloadItems([version], 'C:/g/mods')
    expect(items).toHaveLength(1)
    expect(items[0].dest.replace(/\\/g, '/')).toBe('C:/g/mods/x.jar')
    expect(items[0].sha1).toBe('deadbeef')
    expect(items[0].key).toContain('ver1')
  })

  it('PlatformService.resolveTargetDir 按类型给出目录，CurseForge 给出可读错误', () => {
    const service = new PlatformService({
      client: new HttpClient(),
      mirror: new MirrorResolver(MirrorResolver.default()),
      downloadManager: new DownloadManager({ client: new HttpClient(), mirror: new MirrorResolver(MirrorResolver.default()) }),
      modrinth: new ModrinthClient({
        client: new HttpClient(),
        mirror: new MirrorResolver(MirrorResolver.default()),
        userAgent: 'MCAL-test'
      })
    })
    expect(service.resolveTargetDir('C:/g', 'mod')).toBe(join('C:/g', 'mods'))
    expect(service.resolveTargetDir('C:/g', 'shader')).toBe(join('C:/g', 'shaderpacks'))
    expect(service.resolveTargetDir('C:/g', 'mod', 'custom/mods')).toBe(join('C:/g', 'custom/mods'))
    expect(DEFAULT_TARGET_SUBDIRS.resourcepack).toBe('resourcepacks')
    expect(DEFAULT_TARGET_SUBDIRS.plugin).toBe('plugins')
    expect(() => assertPlatformSupported('curseforge')).toThrowError(/API Key/)
    expect(() => assertPlatformSupported('modrinth')).not.toThrow()
  })
})

/* ------------------------------------------------------------------ *
 *  清理
 * ------------------------------------------------------------------ */

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})
