/**
 * 安装向导的纯逻辑：计划归一化 + 跨阶段进度聚合。
 *
 * 之所以单独放一个文件：原版安装与加载器安装各自会报进度，
 * 但用户只看到一个任务，需要把两段字节数累加成一条进度。
 * 这里不碰 electron / 网络，方便直接跑单元测试。
 */

import type {
  LoaderType,
  VersionInstallPhase,
  VersionInstallPlan,
  VersionInstallProgress
} from '@shared/types'

export interface NormalizedInstallPlan {
  gameVersion: string
  /** 未指定时由调用方补默认游戏目录 */
  gameDir?: string
  /** 'vanilla' 表示不装加载器 */
  loaderType: LoaderType
  loaderVersion?: string
  optifineType?: string
  optifinePatch?: string
  createInstance: boolean
  instanceName: string
}

export interface PlanNormalizeDefaults {
  /** settings.defaultGameDir */
  gameDir?: string
  /** 实例名兜底：加载器安装结果里的版本 id（fabric-loader-0.16.5-1.21.1） */
  fallbackInstanceName?: string
}

const LOADER_LABELS: Record<LoaderType, string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  optifine: 'OptiFine',
  liteloader: 'LiteLoader',
  custom: '自定义加载器'
}

export function loaderLabel(type: LoaderType): string {
  return LOADER_LABELS[type] ?? type
}

/** 校验并补齐安装计划；只做纯校验，不访问任何外部资源 */
export function normalizeInstallPlan(
  plan: VersionInstallPlan,
  defaults: PlanNormalizeDefaults = {}
): NormalizedInstallPlan {
  const gameVersion = (plan.gameVersion ?? '').trim()
  if (!gameVersion) throw new Error('安装计划缺少游戏版本')

  const rawLoader = plan.loader && plan.loader.type !== 'vanilla' ? plan.loader : null
  const loaderType: LoaderType = rawLoader?.type ?? 'vanilla'
  const loaderVersion = rawLoader?.version?.trim() || undefined

  // OptiFine 的「版本」是 type + patch 两段，别的加载器是单一版本号
  let optifineType = rawLoader?.optifineType?.trim() || undefined
  let optifinePatch = rawLoader?.optifinePatch?.trim() || undefined
  if (loaderType === 'optifine' && loaderVersion && !optifinePatch) {
    const parsed = splitOptiFineVersion(loaderVersion)
    if (parsed) {
      optifineType = optifineType ?? parsed.type
      optifinePatch = parsed.patch
    }
  }

  const createInstance = plan.createInstance !== false
  const instanceName =
    plan.instanceName?.trim() ||
    defaults.fallbackInstanceName?.trim() ||
    defaultInstanceName(gameVersion, loaderType, loaderVersion)

  return {
    gameVersion,
    gameDir: plan.gameDir?.trim() || defaults.gameDir?.trim() || undefined,
    loaderType,
    loaderVersion: loaderType === 'optifine' ? optifinePatch ?? loaderVersion : loaderVersion,
    optifineType,
    optifinePatch,
    createInstance,
    instanceName
  }
}

/** `1.21.1_HD_U_I6` / `HD_U_I6` → { type: 'HD_U', patch: 'I6' }；`1.21_pre1` → { type: 'PRE', patch: '1' } */
export function splitOptiFineVersion(input: string): { type: string; patch: string } | null {
  const text = input.trim()
  // 正式版：类型与补丁号各自成段，类型本身可能含下划线（HD_U）
  const staged = /(?:^|[_\s])(HD_U|HD|S|D|F|PRE)[_\s]([A-Za-z0-9]+)$/i.exec(text)
  if (staged) return { type: staged[1].toUpperCase(), patch: staged[2].toUpperCase() }
  // 预览版：类型与补丁号连写，如 1.21_pre1
  const inline = /(?:^|[_\s])pre(\d+)$/i.exec(text)
  if (inline) return { type: 'PRE', patch: inline[1] }
  return null
}

export function defaultInstanceName(gameVersion: string, loaderType: LoaderType, loaderVersion?: string): string {
  if (loaderType === 'vanilla') return `Minecraft ${gameVersion}`
  const suffix = loaderVersion ? ` ${loaderVersion}` : ''
  return `${loaderLabel(loaderType)}${suffix} · ${gameVersion}`
}

/** 任务标题：安装 Minecraft 1.21.1 + Fabric 0.16.5 */
export function describeInstallPlan(plan: NormalizedInstallPlan): string {
  const base = `安装 Minecraft ${plan.gameVersion}`
  if (plan.loaderType === 'vanilla') return base
  const version = plan.loaderVersion ? ` ${plan.loaderVersion}` : ''
  return `${base} + ${loaderLabel(plan.loaderType)}${version}`
}

export interface PhaseProgressInput {
  completed?: number
  total?: number
  bytesDone?: number
  bytesTotal?: number
  speed?: number
  etaSeconds?: number | null
}

/**
 * 跨阶段进度累加器。
 * enterPhase 把上一阶段已经产生的字节数冻结进 base，后续阶段在此基础上叠加，
 * 于是 UI 上看到的是「整次安装」的进度，而不是每个阶段重新从 0 开始。
 */
export class InstallProgressAggregator {
  private phase: VersionInstallPhase = 'preparing'
  private message = '正在准备…'
  private baseBytesDone = 0
  private baseBytesTotal = 0
  private last: PhaseProgressInput = {}

  enterPhase(phase: VersionInstallPhase, message: string): void {
    // 冻结上一阶段：已完成字节与总字节一起累加，UI 上才是「整次安装」的进度
    this.baseBytesDone += Math.max(this.last.bytesDone ?? 0, 0)
    this.baseBytesTotal += Math.max(this.last.bytesTotal ?? 0, 0)
    this.phase = phase
    this.message = message
    this.last = {}
  }

  update(input: PhaseProgressInput): VersionInstallProgress {
    this.last = { ...this.last, ...input }
    return this.snapshot()
  }

  /**
   * 只改阶段文案，不冻结字节。
   * 同一阶段内的进度提示（「下载依赖库」「解析安装器」）必须用这个：
   * 用 enterPhase 会把上一次的字节数再累加一遍，进度会越走越离谱。
   */
  setStatus(phase: VersionInstallPhase, message: string): void {
    this.phase = phase
    this.message = message
  }

  snapshot(): VersionInstallProgress {
    const completed = this.last.completed ?? 0
    const total = this.last.total ?? 0
    const bytesDone = this.baseBytesDone + (this.last.bytesDone ?? 0)
    const bytesTotal = this.baseBytesTotal + (this.last.bytesTotal ?? 0)
    return {
      phase: this.phase,
      message: this.message,
      completed,
      total,
      bytesDone,
      bytesTotal,
      speed: this.last.speed ?? 0,
      etaSeconds: this.last.etaSeconds ?? null
    }
  }

  /** 完成整个安装时的收尾进度 */
  finish(): VersionInstallProgress {
    return {
      phase: 'done',
      message: '安装完成',
      completed: this.last.total ?? 0,
      total: this.last.total ?? 0,
      bytesDone: this.baseBytesDone + (this.last.bytesDone ?? 0),
      bytesTotal: this.baseBytesTotal + (this.last.bytesTotal ?? 0),
      speed: 0,
      etaSeconds: 0
    }
  }
}
