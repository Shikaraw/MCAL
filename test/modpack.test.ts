/**
 * 整合包导入/导出测试：只覆盖纯函数与本地文件操作（不发出任何网络请求）。
 * 下载与平台解析用 stub 代替，验证的是「路径落盘、清单映射、安全防护」。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import type { DownloadItem, DownloadProgress, ProjectVersion } from '@shared/types'
import { HttpClient } from '@core/net/http'
import type { DownloadManager } from '@core/net/downloader'
import { DiagnosticEngine } from '@core/diagnose/engine'
import {
  ModpackInspector,
  assertSafeZipEntry,
  normalizeArchivePath,
  parseCurseForgeManifest,
  parseHmclManifest,
  parseIni,
  parseLoaderSpec,
  parseMmcPack,
  parseModrinthIndex,
  readIniValue,
  safeResolveInside
} from '@core/modpack/inspect'
import { ModpackInstaller, type PlatformServiceLike } from '@core/modpack/install'
import {
  ModpackExporter,
  classifyExportPath,
  manifestEntryNameOf,
  normalizeRelPath
} from '@core/modpack/export'

/* ------------------------------------------------------------------ *
 *  工具
 * ------------------------------------------------------------------ */

const tmpRoots: string[] = []

async function makeTmpDir(prefix = 'mcal-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

async function writeFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

function buildZip(file: string, files: Record<string, string | Buffer>): void {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'))
  }
  zip.writeZip(file)
}

/**
 * 把 zip 里某个条目名改写成恶意路径（adm-zip 写入时会归一化 `..`，
 * 所以这里构造后再逐字节替换 —— 名字长度必须一致，才能保持偏移合法）。
 */
function patchZipEntryName(file: string, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('patchZipEntryName 需要等长替换')
  const buffer = Buffer.from(readFileSync(file))
  const needle = Buffer.from(from, 'ascii')
  const replacement = Buffer.from(to, 'ascii')
  let index = 0
  let count = 0
  while (true) {
    index = buffer.indexOf(needle, index)
    if (index < 0) break
    replacement.copy(buffer, index)
    index += replacement.length
    count++
  }
  if (count === 0) throw new Error('patchZipEntryName 没有找到目标条目名')
  return buffer
}

function makeFakeDownloadManager(): { manager: DownloadManager; downloaded: string[] } {
  const downloaded: string[] = []
  const manager = {
    async runTask(
      taskId: string,
      options: {
        label: string
        items: DownloadItem[]
        continueOnError?: boolean
        signal?: AbortSignal
        onProgress?: (progress: DownloadProgress) => void
      }
    ) {
      const failures: { key: string; url: string; error: string }[] = []
      let completed = 0
      for (const item of options.items) {
        try {
          await mkdir(dirname(item.dest), { recursive: true })
          await writeFile(item.dest, Buffer.from(`downloaded:${item.url}`))
          downloaded.push(item.key)
        } catch (err) {
          failures.push({ key: item.key, url: item.url, error: (err as Error).message })
        }
        completed++
        options.onProgress?.({
          taskId,
          label: options.label,
          completed,
          total: options.items.length,
          bytesDone: completed,
          bytesTotal: options.items.length,
          speed: 0,
          etaSeconds: null,
          failures: [],
          state: 'running'
        })
      }
      return { ok: failures.length === 0, completed, total: options.items.length, bytes: completed, failures, skipped: 0 }
    }
  }
  return { manager: manager as unknown as DownloadManager, downloaded }
}

afterAll(async () => {
  for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/* ------------------------------------------------------------------ *
 *  Modrinth manifest
 * ------------------------------------------------------------------ */

const MODRINTH_INDEX = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.0.0',
  name: 'Test Pack',
  summary: '一个测试整合包',
  files: [
    {
      path: 'mods/sodium.jar',
      hashes: { sha1: 'aabbcc', sha512: 'ddeeff' },
      env: { client: 'required', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/AANobbMI/versions/abc/sodium.jar'],
      fileSize: 1234
    },
    {
      path: 'mods/server-only.jar',
      env: { client: 'unsupported' },
      downloads: ['https://cdn.modrinth.com/data/xxx/server.jar']
    },
    {
      path: 'resourcepacks/pack.zip',
      env: { client: 'optional', server: 'unsupported' },
      downloads: ['https://cdn.modrinth.com/data/yyy/pack.zip'],
      fileSize: 2048
    }
  ],
  dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' }
}

describe('Modrinth manifest 解析', () => {
  it('解析 files / dependencies / env / hashes，并跳过 server 专用文件', () => {
    const warnings: string[] = []
    const manifest = parseModrinthIndex(MODRINTH_INDEX, warnings)
    expect(manifest.format).toBe('modrinth')
    expect(manifest.name).toBe('Test Pack')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.gameVersion).toBe('1.20.1')
    expect(manifest.loaderType).toBe('fabric')
    expect(manifest.loaderVersion).toBe('0.15.11')
    expect(manifest.files.length).toBe(2)
    expect(manifest.files[0].path).toBe('mods/sodium.jar')
    expect(manifest.files[0].hashes?.sha1).toBe('aabbcc')
    expect(manifest.files[0].downloads?.[0]).toContain('sodium.jar')
    expect(manifest.files[0].fileSize).toBe(1234)
    expect(manifest.files[0].targetDir).toBe('mods')
    expect(manifest.files[0].optional).toBeUndefined()
    expect(manifest.files[1].optional).toBe(true)
    expect(manifest.files[1].targetDir).toBe('resourcepacks')
    expect(warnings.join(' ')).toContain('unsupported')
    expect(manifest.extra?.overridesDirs).toEqual(['overrides', 'client-overrides'])
  })

  it('支持 game.loaders 变体（{version, loaders:[{id,version}]}）', () => {
    const manifest = parseModrinthIndex({
      formatVersion: 1,
      game: { version: '1.19.2', loaders: [{ id: 'quilt', version: '0.20.0' }] },
      name: 'Variant',
      files: []
    })
    expect(manifest.gameVersion).toBe('1.19.2')
    expect(manifest.loaderType).toBe('quilt')
    expect(manifest.loaderVersion).toBe('0.20.0')
  })

  it('拒绝清单里的路径穿越', () => {
    expect(() =>
      parseModrinthIndex({ formatVersion: 1, name: 'evil', files: [{ path: '../evil.jar', downloads: ['https://x/y.jar'] }] })
    ).toThrow(/穿越/)
  })
})

/* ------------------------------------------------------------------ *
 *  CurseForge manifest
 * ------------------------------------------------------------------ */

describe('CurseForge manifest 解析', () => {
  const CF = {
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'CF Pack',
    version: '2.0',
    author: 'someone',
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
    files: [
      { projectID: 238222, fileID: 4567, required: true, displayName: 'jei-1.20.1-forge-15.2.0.53.jar' },
      { projectID: 111, fileID: 222, required: false }
    ],
    overrides: 'overrides'
  }

  it('解析 minecraft.version / modLoaders / files，并写入 platform 定位信息（downloads 留空）', () => {
    const warnings: string[] = []
    const manifest = parseCurseForgeManifest(CF, warnings)
    expect(manifest.format).toBe('curseforge')
    expect(manifest.gameVersion).toBe('1.20.1')
    expect(manifest.loaderType).toBe('forge')
    expect(manifest.loaderVersion).toBe('47.2.0')
    expect(manifest.overridesDir).toBe('overrides')
    expect(manifest.files.length).toBe(2)
    expect(manifest.files[0].downloads).toBeUndefined()
    expect(manifest.files[0].platform).toEqual({ type: 'curseforge', projectId: '238222', versionId: '4567' })
    expect(manifest.files[0].path).toBe('mods/jei-1.20.1-forge-15.2.0.53.jar')
    expect(manifest.files[1].optional).toBe(true)
    // 必须明确告知 CurseForge 的下载限制
    expect(warnings.join(' ')).toContain('CurseForge API Key')
    expect(warnings.join(' ')).toContain('2 个文件')
  })
})

/* ------------------------------------------------------------------ *
 *  MMC（INI + mmc-pack.json）
 * ------------------------------------------------------------------ */

describe('MMC 实例解析', () => {
  const INSTANCE_CFG = [
    '[General]',
    'name=My MMC Pack',
    'InstanceType=OneSix',
    'OverrideMemory=true',
    'MaxMemAlloc=8192',
    'MinMemAlloc=2048',
    '; comment should be ignored',
    '# another comment',
    '',
    '[Controls]',
    'key=value'
  ].join('\n')

  it('自写 INI 解析器能处理 section / 注释 / 值里的等号', () => {
    const ini = parseIni(`${INSTANCE_CFG}\nweird=a=b=c`)
    expect(ini['General'].name).toBe('My MMC Pack')
    expect(ini['General'].MaxMemAlloc).toBe('8192')
    expect(ini['Controls'].key).toBe('value')
    // 值里可以包含 '='（只按第一个 = 切分）；section 之后的键归属该 section
    expect(ini['Controls'].weird).toBe('a=b=c')
    expect(readIniValue(ini, 'name')).toBe('My MMC Pack')
    expect(readIniValue(ini, 'missing')).toBeUndefined()
  })

  it('解析 mmc-pack.json 的 uid/version 并映射加载器', () => {
    const manifest = parseMmcPack({
      packJson: {
        formatVersion: 1,
        components: [
          { uid: 'net.minecraft', version: '1.20.1' },
          { uid: 'net.fabricmc.fabric-loader', version: '0.15.11' }
        ]
      },
      instanceCfg: INSTANCE_CFG,
      hasMinecraftDir: true,
      fallbackName: 'instance-dir'
    })
    expect(manifest.format).toBe('mmc')
    expect(manifest.name).toBe('My MMC Pack')
    expect(manifest.gameVersion).toBe('1.20.1')
    expect(manifest.loaderType).toBe('fabric')
    expect(manifest.loaderVersion).toBe('0.15.11')
    expect(manifest.overridesDir).toBe('minecraft')
    expect(manifest.files).toEqual([])
    expect(manifest.extra?.maxMemAlloc).toBe(8192)
    expect((manifest.extra?.components as unknown[])?.length).toBe(2)
  })

  it('能识别 Forge / NeoForge / Quilt 的 uid', () => {
    const forge = parseMmcPack({
      packJson: { components: [{ uid: 'net.minecraft', version: '1.18.2' }, { uid: 'net.minecraftforge', version: '40.2.0' }] },
      hasMinecraftDir: true
    })
    expect(forge.loaderType).toBe('forge')
    expect(forge.loaderVersion).toBe('40.2.0')

    const neo = parseMmcPack({
      packJson: { components: [{ uid: 'net.neoforged', version: '20.4.80' }] },
      hasMinecraftDir: false,
      warnings: []
    })
    expect(neo.loaderType).toBe('neoforge')
    expect(neo.gameVersion).toBeUndefined()

    const quilt = parseMmcPack({ packJson: { components: [{ uid: 'org.quiltmc.quilt-loader', version: '0.20.0' }] } })
    expect(quilt.loaderType).toBe('quilt')
  })

  it('parseLoaderSpec 解析 forge-47.2.0 / neoforge-21.1.0 / fabric-0.15.11', () => {
    expect(parseLoaderSpec('forge-47.2.0')).toEqual({ loaderType: 'forge', loaderVersion: '47.2.0' })
    expect(parseLoaderSpec('neoforge-21.1.0')).toEqual({ loaderType: 'neoforge', loaderVersion: '21.1.0' })
    expect(parseLoaderSpec('fabric-0.15.11')).toEqual({ loaderType: 'fabric', loaderVersion: '0.15.11' })
    expect(parseLoaderSpec('')).toEqual({})
  })
})

/* ------------------------------------------------------------------ *
 *  HMCL / MCBBS
 * ------------------------------------------------------------------ */

describe('HMCL / MCBBS manifest 解析', () => {
  const MCBBS = {
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'HMCL Pack',
    version: '1.2',
    author: 'tester',
    description: 'desc',
    addons: [
      { id: 'game', version: '1.20.1' },
      { id: 'forge', version: '47.2.0' }
    ],
    files: [
      { type: 'addon', path: 'mods/example.jar', hash: 'ABCDEF', force: true },
      { type: 'curse', projectID: 238222, fileID: 4567, fileName: 'jei.jar', url: '' }
    ],
    settings: { install_mods: true, install_resourcepack: false }
  }

  it('解析 addons（game/forge）与 files（addon/curse）', () => {
    const warnings: string[] = []
    const manifest = parseHmclManifest(MCBBS, warnings)
    expect(manifest.format).toBe('mcal')
    expect(manifest.name).toBe('HMCL Pack')
    expect(manifest.gameVersion).toBe('1.20.1')
    expect(manifest.loaderType).toBe('forge')
    expect(manifest.loaderVersion).toBe('47.2.0')
    expect(manifest.files.length).toBe(2)
    expect(manifest.files[0].path).toBe('mods/example.jar')
    expect(manifest.files[0].hashes?.sha1).toBe('abcdef')
    expect(manifest.files[0].optional).toBeUndefined()
    expect(manifest.files[1].platform).toEqual({ type: 'curseforge', projectId: '238222', versionId: '4567' })
    expect(manifest.extra?.hmcl).toBe(true)
    expect(warnings.join(' ')).toContain('CurseForge')
  })
})

/* ------------------------------------------------------------------ *
 *  路径安全
 * ------------------------------------------------------------------ */

describe('zip / 路径穿越防护', () => {
  it('assertSafeZipEntry 拒绝绝对路径、盘符与 .. 穿越', () => {
    expect(() => assertSafeZipEntry('../evil.txt')).toThrow(/穿越/)
    expect(() => assertSafeZipEntry('a/../../evil.txt')).toThrow(/穿越/)
    expect(() => assertSafeZipEntry('/etc/passwd')).toThrow(/绝对路径/)
    expect(() => assertSafeZipEntry('C:\\Windows\\evil.dll')).toThrow(/绝对路径/)
    expect(() => assertSafeZipEntry('a\u0000b')).toThrow(/非法字符/)
    expect(() => assertSafeZipEntry('mods/ok.jar')).not.toThrow()
    expect(normalizeArchivePath('./mods/x.jar')).toBe('mods/x.jar')
  })

  it('safeResolveInside 保证落盘路径在根目录内', () => {
    const root = resolve('C:/game/instance')
    expect(safeResolveInside(root, 'mods/a.jar')).toBe(resolve(root, 'mods/a.jar'))
    expect(() => safeResolveInside(root, '../outside.jar')).toThrow(/穿越|越界/)
    expect(() => safeResolveInside(root, 'mods/../../outside.jar')).toThrow(/穿越|越界/)
  })
})

/* ------------------------------------------------------------------ *
 *  Inspector（zip / 目录）
 * ------------------------------------------------------------------ */

describe('ModpackInspector 格式识别', () => {
  let tmp: string
  const inspector = new ModpackInspector({ client: new HttpClient() })

  beforeAll(async () => {
    tmp = await makeTmpDir('mcal-inspect-')
  })

  afterAll(async () => {
  })

  it('识别 .mrpack（含 overrides/client-overrides）', async () => {
    const file = join(tmp, 'pack.mrpack')
    buildZip(file, {
      'modrinth.index.json': JSON.stringify(MODRINTH_INDEX),
      'overrides/config/mypack.json': '{"a":1}',
      'overrides/mods/extra-mod.jar': 'bytes',
      'client-overrides/config/client-only.json': '{"b":2}'
    })
    const result = await inspector.inspect({ file })
    expect(await inspector.detectFormat({ file })).toBe('modrinth')
    expect(result.manifest.format).toBe('modrinth')
    expect(result.root).toBe(file)
    expect(result.manifest.files.length).toBe(2)
    const extra = result.manifest.extra ?? {}
    expect(extra.sourceKind).toBe('zip')
    expect(extra.rootPrefix).toBe('')
    expect(extra.overrideCounts).toEqual({ overrides: 2, 'client-overrides': 1 })
  })

  it('zip 多套一层目录时自动定位根前缀', async () => {
    const file = join(tmp, 'wrapped.zip')
    buildZip(file, {
      'MyPack/modrinth.index.json': JSON.stringify(MODRINTH_INDEX),
      'MyPack/overrides/config/x.json': '{}',
      'MyPack/README.txt': 'hi'
    })
    const result = await inspector.inspect({ file })
    expect(result.manifest.format).toBe('modrinth')
    expect(result.manifest.extra?.rootPrefix).toBe('MyPack/')
    expect(result.warnings.join(' ')).toContain('顶层目录')
  })

  it('识别 CurseForge zip 并给出 API Key 提示', async () => {
    const file = join(tmp, 'cf.zip')
    buildZip(file, {
      'manifest.json': JSON.stringify({
        manifestType: 'minecraftModpack',
        name: 'CF Pack',
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
        files: [{ projectID: 1, fileID: 2, required: true }],
        overrides: 'overrides'
      }),
      'overrides/config/a.json': '{}'
    })
    const result = await inspector.inspect({ file })
    expect(result.manifest.format).toBe('curseforge')
    expect(result.manifest.loaderType).toBe('forge')
    expect(result.warnings.join(' ')).toContain('CurseForge API Key')
  })

  it('识别 MCBBS/HMCL 的 mcbbs.packmeta', async () => {
    const file = join(tmp, 'hmcl.zip')
    buildZip(file, {
      'mcbbs.packmeta': JSON.stringify({
        manifestType: 'minecraftModpack',
        name: 'HMCL Pack',
        addons: [{ id: 'game', version: '1.20.1' }, { id: 'forge', version: '47.2.0' }],
        files: []
      }),
      'overrides/config/hmcl.json': '{}'
    })
    const result = await inspector.inspect({ file })
    expect(result.manifest.format).toBe('mcal')
    expect(result.manifest.extra?.hmcl).toBe(true)
    expect(result.manifest.loaderType).toBe('forge')
  })

  it('识别 MMC 目录（instance.cfg + mmc-pack.json + minecraft/）', async () => {
    const dir = join(tmp, 'mmc-instance')
    await writeFiles(dir, {
      'instance.cfg': '[General]\nname=MMC Pack\nMaxMemAlloc=4096\n',
      'mmc-pack.json': JSON.stringify({
        formatVersion: 1,
        components: [
          { uid: 'net.minecraft', version: '1.20.1' },
          { uid: 'net.minecraftforge', version: '47.2.0' }
        ]
      }),
      'minecraft/mods/example.jar': 'bytes',
      'minecraft/config/a.json': '{}',
      '.minecraft/ignored.txt': 'should not be used'
    })
    const result = await inspector.inspect({ dir })
    expect(result.manifest.format).toBe('mmc')
    expect(result.manifest.name).toBe('MMC Pack')
    expect(result.manifest.overridesDir).toBe('minecraft')
    expect(result.manifest.gameVersion).toBe('1.20.1')
    expect(result.manifest.loaderType).toBe('forge')
    expect(result.warnings.join(' ')).toContain('LoaderManager')
  })

  it('普通游戏目录 → 目录型整合包（overrides = 根目录）', async () => {
    const dir = join(tmp, 'plain-dir')
    await writeFiles(dir, { 'mods/a.jar': 'bytes', 'config/b.json': '{}', 'options.txt': 'renderDistance:8\n' })
    const result = await inspector.inspect({ dir })
    expect(result.manifest.format).toBe('mcal')
    expect(result.manifest.overridesDir).toBe('.')
    expect(result.manifest.extra?.genericDirPack).toBe(true)
    expect(result.warnings.join(' ')).toContain('目录型整合包')
  })

  it('含 .minecraft 子目录时以它为根', async () => {
    const dir = join(tmp, 'nested-dotminecraft')
    await writeFiles(dir, {
      '.minecraft/modrinth.index.json': JSON.stringify(MODRINTH_INDEX),
      '.minecraft/overrides/config/x.json': '{}'
    })
    const result = await inspector.inspect({ dir })
    expect(result.manifest.format).toBe('modrinth')
    expect(result.root).toBe(join(dir, '.minecraft'))
  })

  it('无法识别时返回 unknown 而不是抛错', async () => {
    const file = join(tmp, 'random.zip')
    buildZip(file, { 'readme.txt': 'hello' })
    const result = await inspector.inspect({ file })
    expect(result.manifest.format).toBe('unknown')
    expect(result.warnings.join(' ')).toContain('无法识别')
  })

  it('拒绝含路径穿越条目的 zip（zip slip）', async () => {
    const file = join(tmp, 'evil.zip')
    buildZip(file, {
      'zz/evil.txt': 'pwned',
      'modrinth.index.json': JSON.stringify(MODRINTH_INDEX)
    })
    const patched = patchZipEntryName(file, 'zz/evil.txt', '../evil.txt')
    await writeFile(file, patched)
    await expect(inspector.inspect({ file })).rejects.toThrow(/穿越/)
  })
})

/* ------------------------------------------------------------------ *
 *  导出排除规则（纯函数）
 * ------------------------------------------------------------------ */

describe('export 排除规则', () => {
  it('永远排除敏感文件', () => {
    expect(classifyExportPath('servers.dat')).toMatchObject({ keep: false, sensitive: true })
    expect(classifyExportPath('usercache.json')).toMatchObject({ keep: false, sensitive: true })
    expect(classifyExportPath('launcher_profiles.json')).toMatchObject({ keep: false, sensitive: true })
    expect(classifyExportPath('config/secret.token')).toMatchObject({ keep: false, sensitive: true })
    expect(classifyExportPath('.mcal/accounts.json')).toMatchObject({ keep: false, sensitive: true })
    expect(classifyExportPath('session.lock')).toMatchObject({ keep: false })
  })

  it('默认排除日志/崩溃报告/截图/存档/启动器本体，保留 mods/config/资源包/光影', () => {
    expect(classifyExportPath('logs/latest.log').keep).toBe(false)
    expect(classifyExportPath('crash-reports/crash-2024-client.txt').keep).toBe(false)
    expect(classifyExportPath('screenshots/2024.png').keep).toBe(false)
    expect(classifyExportPath('saves/World/level.dat').keep).toBe(false)
    expect(classifyExportPath('saves/World/level.dat', { includeSaves: true }).keep).toBe(true)
    expect(classifyExportPath('versions/1.20.1/1.20.1.jar').keep).toBe(false)
    expect(classifyExportPath('libraries/org/lwjgl/x.jar').keep).toBe(false)
    expect(classifyExportPath('hs_err_pid123.log').keep).toBe(false)
    expect(classifyExportPath('bootstrap-2024.log').keep).toBe(false)
    expect(classifyExportPath('replay_patches/x.bin').keep).toBe(false)

    expect(classifyExportPath('mods/sodium.jar').keep).toBe(true)
    expect(classifyExportPath('config/mymod.json').keep).toBe(true)
    expect(classifyExportPath('resourcepacks/hd.zip').keep).toBe(true)
    expect(classifyExportPath('resourcepacks/hd.zip', { includeResourcePacks: false }).keep).toBe(false)
    expect(classifyExportPath('shaderpacks/bsl.zip').keep).toBe(true)
    expect(classifyExportPath('shaderpacks/bsl.zip', { includeShaderPacks: false }).keep).toBe(false)
    expect(classifyExportPath('shaderpacks/readme.txt').keep).toBe(false)
    expect(classifyExportPath('config/x.json', { includeConfig: false }).keep).toBe(false)
    expect(classifyExportPath('options.txt', { includeConfig: false }).keep).toBe(false)
  })

  it('options.txt 需要剔除 lastServer；*.disabled 不导出', () => {
    expect(classifyExportPath('options.txt')).toMatchObject({ keep: true, redactOptions: true })
    expect(classifyExportPath('mods/x.jar.disabled')).toMatchObject({ keep: false, disabled: true })
  })

  it('支持用户自定义排除前缀', () => {
    expect(classifyExportPath('mods/big.jar', { exclude: ['mods/big.jar'] }).keep).toBe(false)
    expect(classifyExportPath('mods/big.jar', { exclude: ['mods'] }).keep).toBe(false)
    expect(classifyExportPath('mods/keep.jar', { exclude: ['config'] }).keep).toBe(true)
  })

  it('normalizeRelPath / manifestEntryNameOf 稳定', () => {
    expect(normalizeRelPath('.\\mods\\a.jar')).toBe('mods/a.jar')
    expect(normalizeRelPath('./config/x.json')).toBe('config/x.json')
    expect(manifestEntryNameOf('modrinth')).toBe('modrinth.index.json')
    expect(manifestEntryNameOf('curseforge')).toBe('manifest.json')
    expect(manifestEntryNameOf('mcal')).toBe('mcal-pack.json')
  })
})

/* ------------------------------------------------------------------ *
 *  导出（真实文件 + zip 校验）
 * ------------------------------------------------------------------ */

describe('ModpackExporter 导出', () => {
  let tmp: string
  let gameDir: string
  const exporter = new ModpackExporter()

  beforeAll(async () => {
    tmp = await makeTmpDir('mcal-export-')
    gameDir = join(tmp, 'instance')
    await writeFiles(gameDir, {
      'mods/sodium.jar': 'sodium-bytes',
      'mods/disabled-mod.jar.disabled': 'disabled-bytes',
      'config/mymod.json': '{"k":1}',
      'resourcepacks/hd.zip': 'hd-bytes',
      'shaderpacks/bsl.zip': 'bsl-bytes',
      'shaderpacks/readme.txt': 'shader notes',
      'saves/World/level.dat': 'level-bytes',
      'logs/latest.log': 'log-bytes',
      'crash-reports/crash-2024-05-01_12.00.00-client.txt': 'crash-bytes',
      'screenshots/2024.png': 'png-bytes',
      'servers.dat': 'servers-bytes',
      'usercache.json': '[]',
      'launcher_profiles.json': '{}',
      'session.lock': 'lock',
      'hs_err_pid123.log': 'hs-err',
      'options.txt': 'version:3465\nrenderDistance:12\nlastServer:play.example.com:25565\nlang:zh_CN\n',
      'versions/1.20.1/1.20.1.jar': 'client-jar',
      'libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar': 'lib'
    })
  })

  afterAll(async () => {
  })

  it('buildManifest 只保留 mods/config/资源包/光影/options.txt', async () => {
    const { manifest, packed, warnings } = await exporter.buildManifest({
      gameDir,
      outFile: join(tmp, 'unused.zip'),
      name: 'My Pack',
      format: 'mcal',
      gameVersion: '1.20.1',
      loaderType: 'fabric',
      loaderVersion: '0.15.11'
    })
    const paths = packed.map((item) => item.path).sort()
    expect(paths).toEqual(['config/mymod.json', 'mods/sodium.jar', 'options.txt', 'resourcepacks/hd.zip', 'shaderpacks/bsl.zip'])
    expect(manifest.format).toBe('mcal')
    expect(manifest.gameVersion).toBe('1.20.1')
    expect(manifest.loaderType).toBe('fabric')
    expect(warnings.join(' ')).toContain('敏感文件')
    expect(warnings.join(' ')).toContain('lastServer')
    expect(warnings.join(' ')).toContain('*.disabled')
  })

  it('export(mcal) 写出的 zip 含清单与 overrides，且不含敏感文件', async () => {
    const outFile = join(tmp, 'out-mcal.zip')
    const result = await exporter.export({
      gameDir,
      outFile,
      name: 'My Pack',
      version: '1.0.0',
      format: 'mcal',
      gameVersion: '1.20.1',
      loaderType: 'forge',
      loaderVersion: '47.2.0',
      includeSaves: false
    })
    expect(result.file).toBe(outFile)
    expect(result.fileCount).toBeGreaterThan(4)
    expect(result.packedBytes).toBeGreaterThan(0)

    const zip = new AdmZip(outFile)
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).toContain('mcal-pack.json')
    expect(names).toContain('overrides/mods/sodium.jar')
    expect(names).toContain('overrides/config/mymod.json')
    expect(names.some((name) => name.includes('servers.dat'))).toBe(false)
    expect(names.some((name) => name.includes('usercache.json'))).toBe(false)
    expect(names.some((name) => name.includes('session.lock'))).toBe(false)
    expect(names.some((name) => name.includes('logs/'))).toBe(false)
    expect(names.some((name) => name.includes('saves/'))).toBe(false)
    expect(names.some((name) => name.includes('versions/'))).toBe(false)
    expect(names.some((name) => name.includes('.disabled'))).toBe(false)
    expect(names.some((name) => name.includes('shaderpacks/readme.txt'))).toBe(false)

    const options = zip.readAsText(zip.getEntry('overrides/options.txt')!)
    expect(options).toContain('renderDistance:12')
    expect(options).not.toContain('lastServer')

    const manifestJson = JSON.parse(zip.readAsText(zip.getEntry('mcal-pack.json')!))
    expect(manifestJson.name).toBe('My Pack')
    expect(manifestJson.format).toBe('mcal')
    expect(manifestJson.loaderType).toBe('forge')
  })

  it('export(modrinth) 把 recognized 文件写成清单项而不是打包内容', async () => {
    const outFile = join(tmp, 'out-modrinth.mrpack')
    const result = await exporter.export({
      gameDir,
      outFile,
      name: 'MR Pack',
      version: '2.0.0',
      format: 'modrinth',
      gameVersion: '1.20.1',
      loaderType: 'fabric',
      loaderVersion: '0.15.11',
      recognized: {
        'mods/sodium.jar': {
          platform: 'modrinth',
          projectId: 'AANobbMI',
          versionId: 'abc123',
          url: 'https://cdn.modrinth.com/data/AANobbMI/versions/abc123/sodium.jar',
          sha1: 'aabbccdd',
          size: 12
        }
      }
    })
    expect(result.fileCount).toBeGreaterThan(1)

    const zip = new AdmZip(outFile)
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).toContain('modrinth.index.json')
    expect(names).toContain('overrides/config/mymod.json')
    // 已识别的 mod 不再打包
    expect(names.some((name) => name.includes('sodium.jar'))).toBe(false)

    const index = JSON.parse(zip.readAsText(zip.getEntry('modrinth.index.json')!))
    expect(index.formatVersion).toBe(1)
    expect(index.dependencies.minecraft).toBe('1.20.1')
    expect(index.dependencies['fabric-loader']).toBe('0.15.11')
    expect(index.files.length).toBe(1)
    expect(index.files[0].path).toBe('mods/sodium.jar')
    expect(index.files[0].hashes.sha1).toBe('aabbccdd')
    expect(index.files[0].downloads[0]).toContain('sodium.jar')
    expect(index.files[0].env.client).toBe('required')
  })

  it('export(curseforge) 写 manifest.json 并提示无法反查 projectID', async () => {
    const outFile = join(tmp, 'out-cf.zip')
    const result = await exporter.export({
      gameDir,
      outFile,
      name: 'CF Export',
      format: 'curseforge',
      gameVersion: '1.20.1',
      loaderType: 'neoforge',
      loaderVersion: '20.4.80'
    })
    expect(result.warnings.join(' ')).toContain('CurseForge 格式导出未做平台反查')
    const zip = new AdmZip(outFile)
    const manifestJson = JSON.parse(zip.readAsText(zip.getEntry('manifest.json')!))
    expect(manifestJson.manifestType).toBe('minecraftModpack')
    expect(manifestJson.minecraft.version).toBe('1.20.1')
    expect(manifestJson.minecraft.modLoaders[0]).toEqual({ id: 'neoforge-20.4.80', primary: true })
    expect(manifestJson.files).toEqual([])
    expect(zip.getEntries().map((entry) => entry.entryName)).toContain('overrides/mods/sodium.jar')
  })

  it('导出的包能再被 inspector 识别（往返一致）', async () => {
    const outFile = join(tmp, 'roundtrip.zip')
    await exporter.export({
      gameDir,
      outFile,
      name: 'Round Trip',
      version: '3.1.4',
      format: 'mcal',
      gameVersion: '1.20.1',
      loaderType: 'forge',
      loaderVersion: '47.2.0'
    })
    const inspector = new ModpackInspector({ client: new HttpClient() })
    const result = await inspector.inspect({ file: outFile })
    expect(result.manifest.format).toBe('mcal')
    expect(result.manifest.name).toBe('Round Trip')
    expect(result.manifest.version).toBe('3.1.4')
    expect(result.manifest.gameVersion).toBe('1.20.1')
    expect(result.manifest.loaderVersion).toBe('47.2.0')
  })
})

/* ------------------------------------------------------------------ *
 *  安装
 * ------------------------------------------------------------------ */

describe('ModpackInstaller 安装', () => {
  let tmp: string
  const inspector = new ModpackInspector({ client: new HttpClient() })

  beforeAll(async () => {
    tmp = await makeTmpDir('mcal-install-')
  })

  afterAll(async () => {
  })

  it('Modrinth 包：下载有直链的文件、复制 overrides、记录手动文件与加载器提示', async () => {
    const file = join(tmp, 'install.mrpack')
    buildZip(file, {
      'modrinth.index.json': JSON.stringify({
        formatVersion: 1,
        name: 'Install Test',
        versionId: '1.0.0',
        files: [
          {
            path: 'mods/sodium.jar',
            hashes: { sha1: 'aa' },
            downloads: ['https://cdn.modrinth.com/data/AANobbMI/versions/abc/sodium.jar'],
            fileSize: 10,
            env: { client: 'required' }
          },
          { path: 'mods/nolink.jar', hashes: { sha1: 'bb' }, fileSize: 10, env: { client: 'required' } }
        ],
        dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' }
      }),
      'overrides/config/mypack.json': '{"a":1}',
      'overrides/mods/extra-mod.jar': 'extra-bytes',
      'client-overrides/config/client-only.json': '{"client":true}'
    })

    const { manager, downloaded } = makeFakeDownloadManager()
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    const targetGameDir = join(tmp, 'target-modrinth')
    const phases: string[] = []
    const result = await installer.install({
      file,
      targetGameDir,
      onProgress: (progress) => phases.push(progress.phase)
    })

    expect(result.instanceDir).toBe(resolve(targetGameDir))
    expect(result.name).toBe('Install Test')
    expect(result.gameVersion).toBe('1.20.1')
    expect(result.loaderType).toBe('fabric')
    expect(result.loaderVersion).toBe('0.15.11')
    expect(downloaded).toEqual(['mods/sodium.jar'])
    expect(result.installedFiles).toEqual(
      expect.arrayContaining(['mods/sodium.jar', 'config/mypack.json', 'mods/extra-mod.jar', 'config/client-only.json'])
    )
    expect(result.manualDownloads.length).toBe(1)
    expect(result.manualDownloads[0].fileName).toBe('nolink.jar')
    expect(result.skippedFiles.some((item) => item.path === 'mods/nolink.jar')).toBe(true)
    expect(result.failedFiles.length).toBe(0)
    expect(result.warnings.join(' ')).toContain('需调用 LoaderManager 安装加载器：fabric 0.15.11')
    expect(phases).toContain('download')
    expect(phases).toContain('overrides')
    expect(phases).toContain('done')

    // 落盘内容
    expect(await readFile(join(targetGameDir, 'mods/sodium.jar'), 'utf8')).toContain('cdn.modrinth.com')
    expect(await readFile(join(targetGameDir, 'config/mypack.json'), 'utf8')).toBe('{"a":1}')
    expect(await readFile(join(targetGameDir, 'config/client-only.json'), 'utf8')).toBe('{"client":true}')
    expect(await stat(join(targetGameDir, 'mods/nolink.jar')).catch(() => null)).toBeNull()
  })

  it('CurseForge 包：通过注入的 PlatformService 解析真实地址与文件名', async () => {
    const file = join(tmp, 'install-cf.zip')
    buildZip(file, {
      'manifest.json': JSON.stringify({
        manifestType: 'minecraftModpack',
        name: 'CF Install',
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
        files: [
          { projectID: 238222, fileID: 4567, required: true },
          { projectID: 999999, fileID: 1, required: true }
        ],
        overrides: 'overrides'
      }),
      'overrides/config/cf.json': '{}'
    })

    const platform: PlatformServiceLike = {
      async resolveFile({ projectId }) {
        if (projectId !== '238222') return null
        return {
          url: 'https://edge.forgecdn.net/files/4567/jei-1.20.1-forge-15.2.0.53.jar',
          fileName: 'jei-1.20.1-forge-15.2.0.53.jar',
          size: 32
        }
      }
    }

    const { manager, downloaded } = makeFakeDownloadManager()
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    const targetGameDir = join(tmp, 'target-cf')
    const result = await installer.install({ file, targetGameDir, platform })

    expect(downloaded).toEqual(['mods/jei-1.20.1-forge-15.2.0.53.jar'])
    expect(result.installedFiles).toContain('mods/jei-1.20.1-forge-15.2.0.53.jar')
    expect(result.installedFiles).toContain('config/cf.json')
    // 解析不了的文件进入 manualDownloads
    expect(result.manualDownloads.length).toBe(1)
    expect(result.manualDownloads[0].projectId).toBe('999999')
    // CurseForge 的限制必须出现在结果里
    expect(result.warnings.join(' ')).toContain('CurseForge API Key')
    expect(result.loaderType).toBe('forge')
    expect(result.warnings.join(' ')).toContain('LoaderManager')
  })

  it('无平台服务时 CurseForge 文件全部进入 manualDownloads', async () => {
    const file = join(tmp, 'install-cf-nokey.zip')
    buildZip(file, {
      'manifest.json': JSON.stringify({
        manifestType: 'minecraftModpack',
        name: 'No Key',
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
        files: [{ projectID: 1, fileID: 2, required: true }],
        overrides: 'overrides'
      }),
      'overrides/options.txt': 'renderDistance:8\n'
    })
    const { manager } = makeFakeDownloadManager()
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    const result = await installer.install({ file, targetGameDir: join(tmp, 'target-nokey') })
    expect(result.manualDownloads.length).toBe(1)
    expect(result.installedFiles).toContain('options.txt')
    expect(result.warnings.join(' ')).toContain('需要手动处理')
  })

  it('skipOptional 跳过可选文件并记录原因', async () => {
    const file = join(tmp, 'install-optional.mrpack')
    buildZip(file, {
      'modrinth.index.json': JSON.stringify({
        formatVersion: 1,
        name: 'Optional Pack',
        files: [
          { path: 'mods/required.jar', downloads: ['https://cdn.modrinth.com/data/a/b/required.jar'], env: { client: 'required' } },
          { path: 'mods/optional.jar', downloads: ['https://cdn.modrinth.com/data/a/b/optional.jar'], env: { client: 'optional' } }
        ],
        dependencies: { minecraft: '1.20.1' }
      }),
      'overrides/config/x.json': '{}'
    })
    const { manager, downloaded } = makeFakeDownloadManager()
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    const result = await installer.install({ file, targetGameDir: join(tmp, 'target-optional'), skipOptional: true })
    expect(downloaded).toEqual(['mods/required.jar'])
    expect(result.skippedFiles.some((item) => item.path === 'mods/optional.jar' && item.reason.includes('可选文件'))).toBe(true)
  })

  it('目录型整合包：整体复制（跳过日志与清单文件）', async () => {
    const packDir = join(tmp, 'dir-pack')
    await writeFiles(packDir, {
      'mods/a.jar': 'a-bytes',
      'config/b.json': '{}',
      'logs/latest.log': 'noise',
      'options.txt': 'renderDistance:8\n'
    })
    const { manager } = makeFakeDownloadManager()
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    const targetGameDir = join(tmp, 'target-dir-pack')
    const result = await installer.install({ dir: packDir, targetGameDir })
    expect(result.installedFiles.sort()).toEqual(['config/b.json', 'mods/a.jar', 'options.txt'])
    expect(result.skippedFiles.some((item) => item.path.startsWith('logs/'))).toBe(true)
    expect(await readFile(join(targetGameDir, 'mods/a.jar'), 'utf8')).toBe('a-bytes')
  })

  it('无法识别格式时抛错', async () => {
    const file = join(tmp, 'random2.zip')
    buildZip(file, { 'readme.txt': 'hello' })
    const { manager } = makeFakeDownloadManager()
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    await expect(installer.install({ file, targetGameDir: join(tmp, 'target-unknown') })).rejects.toThrow(/无法识别整合包格式/)
  })

  it('下载失败率 > 20% 时给出强提示', async () => {
    const manager = {
      async runTask(taskId: string, options: { items: DownloadItem[]; onProgress?: (p: DownloadProgress) => void }) {
        return {
          ok: false,
          completed: options.items.length,
          total: options.items.length,
          bytes: 0,
          skipped: 0,
          failures: options.items.map((item) => ({ key: item.key, url: item.url, error: 'HTTP 403' }))
        }
      }
    } as unknown as DownloadManager
    const file = join(tmp, 'install-fail.mrpack')
    buildZip(file, {
      'modrinth.index.json': JSON.stringify({
        formatVersion: 1,
        name: 'Fail Pack',
        files: [
          { path: 'mods/a.jar', downloads: ['https://cdn.modrinth.com/data/a/b/a.jar'] },
          { path: 'mods/b.jar', downloads: ['https://cdn.modrinth.com/data/a/b/b.jar'] },
          { path: 'mods/c.jar', downloads: ['https://cdn.modrinth.com/data/a/b/c.jar'] }
        ],
        dependencies: { minecraft: '1.20.1' }
      }),
      'overrides/config/x.json': '{}'
    })
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    const result = await installer.install({ file, targetGameDir: join(tmp, 'target-fail') })
    expect(result.failedFiles.length).toBe(3)
    expect(result.warnings.join(' ')).toContain('失败率过高')
  })
})

/* ------------------------------------------------------------------ *
 *  与诊断引擎的联动（整合包导入后能直接诊断）
 * ------------------------------------------------------------------ */

describe('整合包与诊断引擎联动', () => {
  it('导入后的实例目录结构可被 DiagnosticEngine.collectFactsFromInstance 读取', async () => {
    const dir = await makeTmpDir('mcal-facts-')
    await writeFiles(dir, {
      'logs/latest.log': [
        '[12:00:00] [main/INFO] [net.minecraftforge.fml.loading.FMLPaths/]: Forge Mod Loader version 47.2.0 for Minecraft 1.20.1',
        '[12:00:03] [Render thread/ERROR]: java.lang.OutOfMemoryError: Java heap space'
      ].join('\n'),
      'crash-reports/crash-2024-05-01_12.00.00-client.txt': [
        '---- Minecraft Crash Report ----',
        'Description: Rendering overlay',
        'Suspected Mods: Sodium (sodium)',
        'Stacktrace:',
        '\tat net.minecraft.client.Minecraft.<init>(Minecraft.java:1)',
        'Details:',
        '\tMinecraft Version: 1.20.1',
        '\tJava Version: 17.0.8, Eclipse Adoptium'
      ].join('\n'),
      'mods/sodium-fabric-0.5.8+mc1.20.1.jar': 'bytes',
      'mods/lithium-fabric-mc1.20.1-0.11.2.jar': 'bytes',
      'versions/1.20.1-forge-47.2.0/1.20.1-forge-47.2.0.json': JSON.stringify({
        id: '1.20.1-forge-47.2.0',
        inheritsFrom: '1.20.1',
        javaVersion: { majorVersion: 17 }
      }),
      'logs/hs_err_pid999.log': [
        '# A fatal error has been detected by the Java Runtime Environment:',
        '#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x1, pid=1, tid=1',
        '# Problematic frame:',
        '# C  [nvoglv64.dll+0x1]'
      ].join('\n')
    })
    const engine = new DiagnosticEngine()
    const facts = await engine.collectFactsFromInstance({ gameDir: dir, versionId: '1.20.1-forge-47.2.0', javaMajor: 17 })
    expect(facts.gameVersion).toBe('1.20.1')
    expect(facts.loaderType).toBe('forge')
    expect(facts.loaderVersion).toBe('47.2.0')
    expect(facts.javaMajor).toBe(17)
    expect(facts.physicalMemoryMB).toBeGreaterThan(0)
    expect(facts.modCount).toBe(2)
    expect(facts.mods?.map((mod) => mod.id)).toEqual(expect.arrayContaining(['sodium', 'lithium']))
    expect(facts.crashReport?.description).toBe('Rendering overlay')
    expect(facts.crashReport?.problematicFrame).toContain('nvoglv64.dll')
    expect(facts.graphicsDriver?.file).toContain('nvoglv64.dll')

    const report = await engine.diagnose({ text: await readFile(join(dir, 'logs/latest.log'), 'utf8'), facts })
    expect(report.findings.some((finding) => finding.id === 'oom-heap')).toBe(true)
    expect(report.findings).not.toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 *  ProjectVersion 兼容（PlatformService.versions 形态）
 * ------------------------------------------------------------------ */

describe('PlatformService.versions 兜底解析', () => {
  it('能用 versions() 返回的 ProjectVersion 文件信息', async () => {
    const inspector = new ModpackInspector({ client: new HttpClient() })
    const tmp = await makeTmpDir('mcal-platform-')
    const file = join(tmp, 'pack.zip')
    buildZip(file, {
      'manifest.json': JSON.stringify({
        manifestType: 'minecraftModpack',
        name: 'Versions Fallback',
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
        files: [{ projectID: 238222, fileID: 4567, required: true }],
        overrides: 'overrides'
      }),
      'overrides/config/x.json': '{}'
    })
    const versions: ProjectVersion[] = [
      {
        platform: 'modrinth',
        versionId: '4567',
        projectId: '238222',
        name: 'JEI 15.2.0.53',
        versionNumber: '15.2.0.53',
        versionType: 'release',
        gameVersions: ['1.20.1'],
        loaders: ['forge'],
        dependencies: [],
        files: [
          {
            url: 'https://cdn.modrinth.com/data/238222/versions/4567/jei-1.20.1-forge-15.2.0.53.jar',
            filename: 'jei-1.20.1-forge-15.2.0.53.jar',
            size: 64,
            primary: true,
            hashes: { sha1: 'ff' }
          }
        ]
      }
    ]
    const platform: PlatformServiceLike = { versions: async () => versions }
    const { manager, downloaded } = makeFakeDownloadManager()
    const installer = new ModpackInstaller({ downloadManager: manager, inspector })
    const result = await installer.install({ file, targetGameDir: join(tmp, 'target'), platform })
    expect(downloaded).toEqual(['mods/jei-1.20.1-forge-15.2.0.53.jar'])
    expect(result.manualDownloads.length).toBe(0)
  })
})
