/**
 * 设置存储测试：老配置文件（缺新字段）与手改坏的文件都不能让启动器崩。
 * 注意用户的 settings.json 是上一版程序写下的，缺 accessMode / gameDirs / update 这些新字段是常态。
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
// vitest 没有 @main 别名（main 一般依赖 electron，不进单测）；
// config-store 只依赖 node 与 @core，这里按相对路径引入以便覆盖配置迁移逻辑
import { mergeSettings, defaultSettings, SettingsStore } from '../src/main/store/config-store'

const ROOT = join('D:', 'mcal-data')

describe('mergeSettings', () => {
  it('老配置缺少的新字段会用默认值补齐', () => {
    const old = {
      rootDir: ROOT,
      defaultGameDir: join(ROOT, 'minecraft'),
      mirror: { mojang: 'official' },
      agent: { permissionMode: 'ask' },
      providers: []
    } as never
    const merged = mergeSettings(defaultSettings(ROOT), old)
    // 用户显式设置过的保留
    expect(merged.mirror.mojang).toBe('official')
    expect(merged.agent.permissionMode).toBe('ask')
    // 新字段走默认值
    expect(merged.mirror.forge).toBe('bmclapi')
    expect(merged.agent.accessMode).toBe('workspace')
    expect(merged.agent.confirmSensitive).toBe(true)
    expect(merged.gameDirs).toEqual([])
    expect(merged.update.autoCheck).toBe(true)
    expect(merged.update.repo).toBe('Shikaraw/MinecraftAgentLauncher')
  })

  it('字段被写成 null 时保持默认值，而不是让整个配置变成 null', () => {
    const merged = mergeSettings(defaultSettings(ROOT), { agent: null, update: null } as never)
    expect(merged.agent.accessMode).toBe('workspace')
    expect(merged.update.autoCheck).toBe(true)
  })

  it('数组整体替换而不是合并', () => {
    const base = defaultSettings(ROOT)
    base.gameDirs = [{ path: 'D:/a', label: 'a', source: 'manual', addedAt: '2026-01-01' }]
    const merged = mergeSettings(base, { gameDirs: [] } as never)
    expect(merged.gameDirs).toEqual([])
  })
})

describe('SettingsStore 读写', () => {
  it('读到残缺文件也能拿到完整配置，并落盘补全后的结果', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcal-settings-'))
    try {
      const file = join(dir, 'settings.json')
      await writeFile(file, JSON.stringify({ agent: { permissionMode: 'readonly' } }), 'utf8')
      const store = new SettingsStore({ rootDir: dir, file })
      const settings = await store.load()
      expect(settings.agent.permissionMode).toBe('readonly')
      expect(settings.agent.accessMode).toBe('workspace')
      expect(settings.update.mirrorId).toBe('ghproxy')
      await store.flush()
      const written = JSON.parse(await readFile(file, 'utf8')) as { agent: { accessMode: string } }
      expect(written.agent.accessMode).toBe('workspace')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
