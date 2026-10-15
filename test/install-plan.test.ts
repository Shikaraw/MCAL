/**
 * 安装向导纯逻辑测试：计划归一化、任务标题、跨阶段进度聚合。
 * 不联网、不下载、不写磁盘。
 */

import { describe, expect, it } from 'vitest'
import {
  InstallProgressAggregator,
  defaultInstanceName,
  describeInstallPlan,
  loaderLabel,
  normalizeInstallPlan,
  splitOptiFineVersion
} from '@core/mojang/install-plan'

describe('normalizeInstallPlan', () => {
  it('只给版本号时按「仅原版 + 建实例」处理', () => {
    const plan = normalizeInstallPlan({ gameVersion: '1.21.1' }, { gameDir: 'D:/mc' })
    expect(plan.loaderType).toBe('vanilla')
    expect(plan.gameDir).toBe('D:/mc')
    expect(plan.createInstance).toBe(true)
    expect(plan.instanceName).toBe('Minecraft 1.21.1')
  })

  it('loader.type 为 vanilla 时不当作加载器', () => {
    const plan = normalizeInstallPlan({ gameVersion: '1.20.1', loader: { type: 'vanilla' } })
    expect(plan.loaderType).toBe('vanilla')
  })

  it('保留加载器版本，并可显式关闭建实例', () => {
    const plan = normalizeInstallPlan({
      gameVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.16.5' },
      createInstance: false,
      instanceName: '  我的整合包  '
    })
    expect(plan.loaderType).toBe('fabric')
    expect(plan.loaderVersion).toBe('0.16.5')
    expect(plan.createInstance).toBe(false)
    expect(plan.instanceName).toBe('我的整合包')
  })

  it('没给加载器版本时不编造（由上层查最新稳定版）', () => {
    const plan = normalizeInstallPlan({ gameVersion: '1.20.1', loader: { type: 'forge' } })
    expect(plan.loaderVersion).toBeUndefined()
  })

  it('OptiFine 的版本可以是 1.21.1_HD_U_I6 形式，拆成 type + patch', () => {
    const plan = normalizeInstallPlan({ gameVersion: '1.21.1', loader: { type: 'optifine', version: '1.21.1_HD_U_I6' } })
    expect(plan.optifineType).toBe('HD_U')
    expect(plan.optifinePatch).toBe('I6')
    expect(plan.loaderVersion).toBe('I6')
  })

  it('缺少游戏版本时报错', () => {
    expect(() => normalizeInstallPlan({ gameVersion: '  ' })).toThrow(/缺少游戏版本/)
  })

  it('默认实例名带加载器与版本', () => {
    expect(defaultInstanceName('1.20.1', 'fabric', '0.16.5')).toBe('Fabric 0.16.5 · 1.20.1')
    expect(defaultInstanceName('1.20.1', 'vanilla')).toBe('Minecraft 1.20.1')
  })

  it('加载器中文名齐全（UI 直接复用）', () => {
    expect(loaderLabel('neoforge')).toBe('NeoForge')
    expect(loaderLabel('optifine')).toBe('OptiFine')
  })
})

describe('splitOptiFineVersion', () => {
  it('支持 1.21.1_HD_U_I6 与 HD_U_I6', () => {
    expect(splitOptiFineVersion('1.21.1_HD_U_I6')).toEqual({ type: 'HD_U', patch: 'I6' })
    expect(splitOptiFineVersion('HD_U_I6')).toEqual({ type: 'HD_U', patch: 'I6' })
  })

  it('pre 版按类型识别', () => {
    expect(splitOptiFineVersion('1.21_pre1')).toEqual({ type: 'PRE', patch: '1' })
  })

  it('无法识别时返回 null，而不是瞎猜', () => {
    expect(splitOptiFineVersion('1.21.1')).toBeNull()
  })
})

describe('describeInstallPlan', () => {
  it('原版与加载器的标题', () => {
    expect(describeInstallPlan(normalizeInstallPlan({ gameVersion: '1.21.1' }))).toBe('安装 Minecraft 1.21.1')
    expect(
      describeInstallPlan(normalizeInstallPlan({ gameVersion: '1.21.1', loader: { type: 'fabric', version: '0.16.5' } }))
    ).toBe('安装 Minecraft 1.21.1 + Fabric 0.16.5')
    expect(describeInstallPlan(normalizeInstallPlan({ gameVersion: '1.21.1', loader: { type: 'forge' } }))).toBe(
      '安装 Minecraft 1.21.1 + Forge'
    )
  })
})

describe('InstallProgressAggregator', () => {
  it('加载器阶段的进度建立在原版阶段之上（不会重新从 0 开始）', () => {
    const agg = new InstallProgressAggregator()
    agg.enterPhase('vanilla', '下载原版')
    const vanilla = agg.update({ completed: 10, total: 20, bytesDone: 300, bytesTotal: 600 })
    expect(vanilla.bytesDone).toBe(300)

    agg.enterPhase('loader', '安装 Fabric')
    const early = agg.snapshot()
    expect(early.bytesDone).toBe(300)
    expect(early.bytesTotal).toBe(600)

    const loader = agg.update({ completed: 1, total: 4, bytesDone: 50, bytesTotal: 100 })
    expect(loader.bytesDone).toBe(350)
    expect(loader.bytesTotal).toBe(700)
    expect(loader.phase).toBe('loader')
  })

  it('收尾进度带上总字节', () => {
    const agg = new InstallProgressAggregator()
    agg.enterPhase('vanilla', '下载原版')
    agg.update({ completed: 2, total: 2, bytesDone: 100, bytesTotal: 100 })
    agg.enterPhase('instance', '创建实例')
    const done = agg.finish()
    expect(done.phase).toBe('done')
    expect(done.bytesDone).toBe(100)
  })

  it('同阶段内的文案变化不重复累加字节（setStatus）', () => {
    const agg = new InstallProgressAggregator()
    agg.enterPhase('loader', '安装 Fabric')
    agg.update({ bytesDone: 100, bytesTotal: 200 })
    // 加载器安装过程中会夹杂「解析安装器」这类纯文案回调
    agg.setStatus('loader', '解析安装器')
    agg.setStatus('loader', '写入版本 JSON')
    const after = agg.update({ bytesDone: 150, bytesTotal: 200 })
    expect(after.bytesDone).toBe(150)
    expect(after.message).toBe('写入版本 JSON')
  })

  it('没有字节信息时不会出现 NaN', () => {
    const agg = new InstallProgressAggregator()
    agg.enterPhase('loader', '安装 Forge')
    const snapshot = agg.update({})
    expect(snapshot.bytesDone).toBe(0)
    expect(snapshot.speed).toBe(0)
    expect(snapshot.etaSeconds).toBeNull()
  })
})
