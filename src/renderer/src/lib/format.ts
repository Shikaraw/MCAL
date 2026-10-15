/** 展示层格式化工具：时间、体积、速度等。 */

export function formatBytes(bytes: number | undefined | null, digits = 1): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, index)
  return `${value.toFixed(index === 0 ? 0 : digits)} ${units[index]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const restSeconds = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes} 分 ${restSeconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

export function formatRelativeTime(input: string | number | undefined | null): string {
  if (!input) return '从未'
  const time = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(time)) return '未知'
  const delta = Date.now() - time
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < 45_000) return '刚刚'
  if (delta < hour) return `${Math.round(delta / minute)} 分钟前`
  if (delta < day) return `${Math.round(delta / hour)} 小时前`
  if (delta < 30 * day) return `${Math.round(delta / day)} 天前`
  return new Date(time).toLocaleDateString('zh-CN')
}

export function formatDateTime(input: string | number | undefined | null): string {
  if (!input) return '—'
  const time = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(time)) return '—'
  const date = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatNumber(value: number | undefined): string {
  if (!value) return '0'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`
  return value.toLocaleString('zh-CN')
}

/** 内存自动推荐值：物理内存的 60%，限制在 2G~16G 并向下取整到 512MB */
export function recommendMaxHeapMB(totalMemoryMB: number): number {
  const raw = totalMemoryMB * 0.6
  const clamped = Math.max(2048, Math.min(16384, raw))
  return Math.floor(clamped / 512) * 512
}

export const LOADER_LABELS: Record<string, string> = {
  vanilla: '原版',
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
  optifine: 'OptiFine',
  liteloader: 'LiteLoader',
  custom: '自定义'
}

export function loaderLabel(loader: string | undefined): string {
  return LOADER_LABELS[loader ?? 'vanilla'] ?? loader ?? '未知'
}

export const CONTENT_KIND_LABELS: Record<string, string> = {
  mod: '模组',
  resourcepack: '资源包',
  shaderpack: '光影',
  datapack: '数据包',
  world: '存档',
  modpack: '整合包'
}

export function contentKindLabel(kind: string): string {
  return CONTENT_KIND_LABELS[kind] ?? kind
}

export const SEVERITY_LABELS: Record<string, string> = {
  info: '提示',
  warning: '警告',
  error: '错误',
  fatal: '致命'
}

export function severityTone(severity: string): 'info' | 'warn' | 'err' {
  if (severity === 'fatal' || severity === 'error') return 'err'
  if (severity === 'warning') return 'warn'
  return 'info'
}
