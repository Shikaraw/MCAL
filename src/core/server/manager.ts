/**
 * 服务端实例管理：创建 / 安装 / 启动 / 停止 / 属性与 EULA 管理 / 运行状态跟踪。
 *
 * 设计要点与踩坑记录：
 *  - 启动命令：
 *      · 单 jar 核心（vanilla / paper / purpur / custom / fabric / quilt 启动器）：
 *        `java <jvmArgs> -jar <jar> nogui`
 *      · 新 Forge / NeoForge：安装产物是 `libraries/<group>/<artifact>/<ver>/{win,unix}_args.txt`，
 *        正确启动方式是 `java <jvmArgs> @<args.txt> nogui`（@ 语法读参数文件，
 *        Forge 官方 run.bat/run.sh 也是这么做的）。绝不能 `-jar` 一个不存在的 forge jar。
 *      · 目录里只有 run.bat/run.sh（旧版 Forge）时不给外包脚本：明确报错并提示手动启动。
 *  - JVM 参数：服务端默认使用 Aikar flags（https://mcflags.emc.gs 的 "new flags" 全套）+
 *    `-Xms{max}M -Xmx{max}M`（服务端固定把 Xms 设成 Xmx）。这对服务端的 GC 停顿影响很大。
 *  - 日志：GameProcess 把 stdout/stderr 合并写入主日志；同时把同样的行 tee 到
 *    `<dir>/logs/mcal-latest.log`，与 MC 自身写的 `logs/latest.log` 并存，便于诊断对比。
 *  - 就绪判定：`Done (x.xxxs)! For help, type "help"`（1.7 ~ 1.21 全版本一致）。
 *  - 停止：先向 stdin 发 `stop` 并等待进程退出（默认 30 秒），超时再结束进程树。
 *    Windows 下 Console 程序的 taskkill 不一定能触发 JVM 关闭钩子，stdin 是首选路径。
 *  - server.properties 读写用「行级替换」，保留注释、空行与未知键的行顺序。
 */

import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GameLogLine, MemoryPolicy, ServerCoreType, ServerInstance } from '@shared/types'
import type { HttpClient } from '@core/net/http'
import type { MirrorResolver } from '@core/net/mirror'
import type { DownloadManager } from '@core/net/downloader'
import type { JavaScanner } from '@core/java/detect'
import { pickBestJava, requiredJavaMajor } from '@core/java/requirement'
import { GameProcess } from '@core/launch/process'
import { resolveMemoryPolicy } from '@core/launch/launcher'
import { killProcessTree } from '@core/loaders/installer-jar'
import { ensureDir, pathExists, readdir, sanitizeFileName, shortId, toPosix, writeFileAtomic } from '@core/util/fsx'
import { cleanGameVersion, sleep } from '@core/util/misc'
import { logger } from '@core/util/logger'
import { findServerArgsFile, ServerCoreRegistry } from './cores'

const log = logger.scoped('server:manager')

/* ------------------------------------------------------------------ *
 *  类型契约
 * ------------------------------------------------------------------ */

export interface ServerCreateOptions {
  name: string
  dir: string
  coreType: ServerCoreType
  gameVersion: string
  build?: string
  memory?: MemoryPolicy
  port?: number
  javaPath?: string
  acceptEula?: boolean
  autoInstall?: boolean
}

export interface ServerRuntimeInfo {
  id: string
  pid: number
  state: 'starting' | 'running' | 'exited' | 'crashed'
  startedAt: number
  uptimeMs: number
  exitCode?: number | null
  players?: { online: number; max: number }
  lastError?: string
}

export interface ServerStore {
  load(): Promise<ServerInstance[]>
  save(servers: ServerInstance[]): Promise<void>
}

/* ------------------------------------------------------------------ *
 *  JVM 参数（Aikar flags）
 * ------------------------------------------------------------------ */

/**
 * Aikar 的「new flags」全套（依据 https://mcflags.emc.gs，逐条与 Aikar 原文一致）。
 * 对 G1GC 做了针对性调参：新生代比例、停顿目标、引用处理并行化等；
 * `-Dusing.aikars.flags` 是作者要求的来源标记，方便后续排查时确认参数来源。
 */
export const AIKAR_FLAGS: readonly string[] = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs',
  '-Daikars.new.flags=true'
]

/**
 * 服务端默认 JVM 参数：Aikar flags + `-Xms{max}M -Xmx{max}M`（服务端 Xms=Xmx）。
 * 传入的 memory 应已通过 resolveMemoryPolicy 解析（auto 已在其中展开）。
 * extra 追加在最后：JVM 对重复参数取最后一次，因此上层可以用 extra 覆盖默认内存值。
 */
export function buildDefaultJvmArgs(memory: Pick<MemoryPolicy, 'minMB' | 'maxMB'>, extra: string[] = []): string[] {
  const maxMB = Math.max(256, Math.floor(memory.maxMB > 0 ? memory.maxMB : 1024))
  return [...AIKAR_FLAGS, `-Xms${maxMB}M`, `-Xmx${maxMB}M`, ...extra]
}

/* ------------------------------------------------------------------ *
 *  启动命令构建（纯函数）
 * ------------------------------------------------------------------ */

export interface ServerCommandPlan {
  kind: 'jar' | 'args-file'
  command: string
  args: string[]
  /** 用于日志/UI 展示的完整命令（简单加引号） */
  display: string
}

function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/**
 * 构建服务端启动命令（不触碰文件系统）。
 * - `argsFile` 非空时优先走 @ 语法（新 Forge/NeoForge 的正确方式）；
 * - 否则走 `-jar`；
 * - 两者都没有时抛错（调用方应先完成安装或修正 jarFile）。
 */
export function buildServerCommand(opts: {
  javaPath: string
  jvmArgs?: string[]
  jarFile?: string
  argsFile?: string | null
  /** 是否附加 nogui（默认 true；服务端不带 nogui 的语义由各核心自行处理） */
  nogui?: boolean
}): ServerCommandPlan {
  const jvmArgs = opts.jvmArgs ?? []
  const nogui = opts.nogui ?? true
  const argsFile = opts.argsFile?.trim()
  if (argsFile) {
    const args = [...jvmArgs, `@${toPosix(argsFile)}`, ...(nogui ? ['nogui'] : [])]
    return { kind: 'args-file', command: opts.javaPath, args, display: [opts.javaPath, ...args].map(quoteArg).join(' ') }
  }
  const jarFile = opts.jarFile?.trim()
  if (jarFile) {
    const args = [...jvmArgs, '-jar', jarFile, ...(nogui ? ['nogui'] : [])]
    return { kind: 'jar', command: opts.javaPath, args, display: [opts.javaPath, ...args].map(quoteArg).join(' ') }
  }
  throw new Error('既没有 jarFile 也没有 argsFile，无法构建服务端启动命令（请先安装核心或指定 jarFile）')
}

export interface ServerLaunchTarget {
  kind: 'jar' | 'args-file'
  /** 相对服务端目录的路径（posix 风格） */
  path: string
}

/**
 * 在服务端目录中挑选启动目标：
 *  1. jarFile 显式以 `_args.txt` 结尾且存在 → 按 @args.txt 启动；
 *  2. 自动扫描 libraries/.../{win,unix}_args.txt（新版 Forge/NeoForge）；
 *  3. jarFile 指向存在的 jar；
 *  4. 常见固定名（server.jar / fabric-server-launch.jar / quilt-server-launch.jar）；
 *  5. 目录内任意非 installer 的 jar（自定义核心兜底）。
 */
export async function detectLaunchTarget(
  dir: string,
  opts: { jarFile?: string; platform?: NodeJS.Platform } = {}
): Promise<ServerLaunchTarget | null> {
  const platform = opts.platform ?? process.platform
  const jarFile = opts.jarFile?.trim()

  if (jarFile && /_args\.txt$/i.test(jarFile) && (await pathExists(join(dir, jarFile)))) {
    return { kind: 'args-file', path: toPosix(jarFile) }
  }
  const args = await findServerArgsFile(dir, platform)
  if (args) return { kind: 'args-file', path: args.path }
  if (jarFile && (await pathExists(join(dir, jarFile)))) return { kind: 'jar', path: jarFile }

  for (const name of ['server.jar', 'fabric-server-launch.jar', 'quilt-server-launch.jar']) {
    if (await pathExists(join(dir, name))) return { kind: 'jar', path: name }
  }
  const entries = await readdir(dir).catch(() => [] as string[])
  const jars = entries.filter((name) => /\.jar$/i.test(name) && !/installer/i.test(name))
  if (jars.length > 0) {
    const priority = (name: string): number => {
      const lower = name.toLowerCase()
      if (lower === 'server.jar') return 0
      if (/^(paper|purpur|spigot|craftbukkit|fabric|quilt)/.test(lower)) return 1
      return 2
    }
    jars.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    return { kind: 'jar', path: jars[0] }
  }
  return null
}

/* ------------------------------------------------------------------ *
 *  目录识别 / 就绪判定 / 玩家数（纯逻辑 + 轻量 I/O）
 * ------------------------------------------------------------------ */

/**
 * 识别目录属于哪种服务端核心。
 * 顺序很重要：先看 Forge/NeoForge 的 @args.txt，再看 fabric/quilt 的启动器文件
 * （它们的目录里同时存在原版 server.jar，先判 vanilla 会误判），最后才是各类 jar 命名。
 * 只有 eula.txt/server.properties 这类服务器特征但没有可识别核心时返回 custom。
 */
export async function detectServerCoreType(dir: string): Promise<ServerCoreType | null> {
  const entries = await readdir(dir).catch(() => null)
  if (!entries) return null
  const lower = new Set(entries.map((name) => name.toLowerCase()))
  const has = (name: string): boolean => lower.has(name)
  const anyJar = (re: RegExp): boolean => entries.some((name) => re.test(name))

  const args = await findServerArgsFile(dir)
  if (args) return args.coreType
  if (has('fabric-server-launch.jar') || has('fabric-server-launcher.properties')) return 'fabric'
  if (has('quilt-server-launch.jar') || has('quilt-server-launcher.properties')) return 'quilt'
  if (anyJar(/^paper.*\.jar$/i)) return 'paper'
  if (anyJar(/^purpur.*\.jar$/i)) return 'purpur'
  if (anyJar(/^(spigot|craftbukkit).*\.jar$/i)) return 'spigot'
  if (has('server.jar') || anyJar(/^minecraft_server.*\.jar$/i)) return 'vanilla'
  const isServerDir = has('eula.txt') && has('server.properties')
  if (isServerDir && anyJar(/\.jar$/i)) return 'custom'
  return null
}

/**
 * 从服务端输出判断是否就绪。
 * 真实日志（1.7 ~ 1.21 一致）：`[Server thread/INFO]: Done (7.281s)! For help, type "help"`；
 * 部分核心在 Done 之后追加 or "/help"。这里以 `Done (` 为主标志，`For help, type "help"` 兜底。
 */
export function detectServerReady(text: string): boolean {
  return /\bDone \(/i.test(text) || /For help, type "help"/i.test(text)
}

/**
 * 维护在线玩家数：
 *  - `There are N of a max of M players online` 最权威（玩家列表命令/定期播报都会打印）；
 *  - `Player <name> joined/left the game`（部分插件/核心）与 `<name> joined/left the game` 做增量。
 * 返回 true 表示状态有变化。
 */
export function applyPlayersLine(state: { online: number; max: number }, raw: string): boolean {
  const counts = /There are (\d+) of a max of (\d+) players online/i.exec(raw)
  if (counts) {
    state.online = Number.parseInt(counts[1], 10)
    state.max = Number.parseInt(counts[2], 10)
    return true
  }
  if (/(?:^|\s)(?:Player\s+)?[A-Za-z0-9_]{1,16}\s+joined the game\s*$/i.test(raw)) {
    state.online += 1
    if (state.max > 0 && state.online > state.max) state.online = state.max
    return true
  }
  if (/(?:^|\s)(?:Player\s+)?[A-Za-z0-9_]{1,16}\s+left the game\s*$/i.test(raw)) {
    state.online = Math.max(0, state.online - 1)
    return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 *  server.properties
 * ------------------------------------------------------------------ */

/** 解析 `key=value` 文本（忽略注释与空行；值保留原文，仅去掉分隔符后的前导空白，与 Java Properties 一致） */
export function parsePropertiesText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!key) continue
    out[key] = line.slice(index + 1).replace(/^[ \t]+/, '')
  }
  return out
}

/**
 * 行级应用属性补丁：保留注释、空行、未知键与原有行顺序；已有键就地替换，新键追加到末尾。
 * 返回文本与原文使用相同的行尾（CRLF/LF）。
 */
export function applyPropertiesPatch(original: string, patch: Record<string, string>): string {
  const eol = original.includes('\r\n') ? '\r\n' : original.includes('\n') ? '\n' : original.includes('\r') ? '\r' : '\n'
  const hadTrailingNewline = /(?:\r\n|\n|\r)$/.test(original)
  const lines = original.length > 0 ? original.split(/\r\n|\n|\r/) : []
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop()

  const remaining = new Map(Object.entries(patch))
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      out.push(line)
      continue
    }
    const index = line.indexOf('=')
    const key = (index >= 0 ? line.slice(0, index) : line).trim()
    if (key && remaining.has(key)) {
      out.push(`${key}=${remaining.get(key) ?? ''}`)
      remaining.delete(key)
    } else {
      out.push(line)
    }
  }
  const appended = remaining.size
  for (const [key, value] of remaining) out.push(`${key}=${value}`)
  if (out.length === 0) return ''
  const body = out.join(eol)
  return body + (hadTrailingNewline || appended > 0 || original.length === 0 ? eol : '')
}

export type ServerPropertyDoc = {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  options?: string[]
  default?: string
  note: string
}

/** 常用 server.properties 释义（键名与默认值对齐 1.20/1.21 原版行为） */
export const SERVER_PROPERTY_DOCS: ServerPropertyDoc[] = [
  { key: 'motd', label: '服务器标语', type: 'string', default: 'A Minecraft Server', note: '多人游戏列表里显示的描述；支持 & 颜色代码（需插件/核心支持）' },
  { key: 'server-port', label: '监听端口', type: 'number', default: '25565', note: 'TCP 端口；公网开服需在防火墙/路由器放行' },
  { key: 'server-ip', label: '监听地址', type: 'string', default: '', note: '留空表示监听所有网卡；多网卡机器可指定具体 IP' },
  { key: 'max-players', label: '最大玩家数', type: 'number', default: '20', note: '同时在线上限；过大并不会自动提升性能' },
  { key: 'gamemode', label: '默认游戏模式', type: 'enum', options: ['survival', 'creative', 'adventure', 'spectator'], default: 'survival', note: '新玩家首次进入的默认模式' },
  { key: 'difficulty', label: '难度', type: 'enum', options: ['peaceful', 'easy', 'normal', 'hard'], default: 'easy', note: '影响怪物强度与饥饿消耗' },
  { key: 'force-gamemode', label: '强制游戏模式', type: 'boolean', default: 'false', note: 'true 时每次登录都重置为 gamemode' },
  { key: 'hardcore', label: '极限模式', type: 'boolean', default: 'false', note: '死亡后自动切换旁观者；慎用' },
  { key: 'pvp', label: '允许 PVP', type: 'boolean', default: 'true', note: '玩家间直接伤害开关' },
  { key: 'online-mode', label: '正版验证', type: 'boolean', default: 'true', note: 'true 只允许正版账号；离线服设 false（配合白名单/权限插件使用）' },
  { key: 'white-list', label: '启用白名单', type: 'boolean', default: 'false', note: '只允许 white-list.json 中的玩家进入' },
  { key: 'enforce-whitelist', label: '强制白名单', type: 'boolean', default: 'false', note: 'true 时移除不在白名单中的在线玩家' },
  { key: 'level-name', label: '世界文件夹', type: 'string', default: 'world', note: '主世界目录名（相对服务端目录）' },
  { key: 'level-seed', label: '世界种子', type: 'string', default: '', note: '留空随机；仅在首次生成世界时生效' },
  { key: 'level-type', label: '世界类型', type: 'enum', options: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'], default: 'minecraft:normal', note: '1.16+ 用带命名空间的值；旧版为 default/flat 等简写' },
  { key: 'allow-nether', label: '允许下界', type: 'boolean', default: 'true', note: 'false 时下界传送门失效' },
  { key: 'allow-flight', label: '允许飞行', type: 'boolean', default: 'false', note: '生存模式飞行会被判定为作弊踢出，安装飞行类模组时需设 true' },
  { key: 'spawn-protection', label: '出生点保护半径', type: 'number', default: '16', note: '0 关闭；仅限制非 OP 的方块修改' },
  { key: 'enable-command-block', label: '启用命令方块', type: 'boolean', default: 'false', note: '地图/小游戏服通常需要开启' },
  { key: 'generate-structures', label: '生成结构', type: 'boolean', default: 'true', note: '村庄、要塞等结构是否生成' },
  { key: 'view-distance', label: '视距（区块）', type: 'number', default: '10', note: '服务端下发的最远视距；对带宽与 CPU 影响最大' },
  { key: 'simulation-distance', label: '模拟距离（区块）', type: 'number', default: '10', note: '实体与红石在该距离内才会运算（1.18+）' },
  { key: 'max-tick-time', label: '看门狗超时（ms）', type: 'number', default: '60000', note: '单个 tick 超过该值会判定卡死并退出；-1 关闭看门狗' },
  { key: 'player-idle-timeout', label: '挂机踢出（分钟）', type: 'number', default: '0', note: '0 表示不踢；AFK 服可设置' },
  { key: 'network-compression-threshold', label: '压缩阈值（字节）', type: 'number', default: '256', note: '-1 关闭压缩；过高/过低都会增加带宽或 CPU 开销' },
  { key: 'entity-broadcast-range-percentage', label: '实体广播范围（%）', type: 'number', default: '100', note: '降低可显著减少带宽占用' },
  { key: 'max-world-size', label: '世界边界上限', type: 'number', default: '29999984', note: '世界边界的最大半径（方块）' },
  { key: 'sync-chunk-writes', label: '同步区块写入', type: 'boolean', default: 'true', note: 'SSD 上可设 false 提升性能；异常断电有丢档风险' },
  { key: 'prevent-proxy-connections', label: '阻止代理连接', type: 'boolean', default: 'false', note: 'true 时会拒绝代理/VPN 连接（容易误伤）' },
  { key: 'hide-online-players', label: '隐藏在线玩家列表', type: 'boolean', default: 'false', note: '服务端列表接口不返回玩家名单' },
  { key: 'enforce-secure-profile', label: '强制安全聊天签名', type: 'boolean', default: 'true', note: '1.19+ 聊天签名校验；离线服/部分 mod 环境需设 false' },
  { key: 'op-permission-level', label: 'OP 权限等级', type: 'enum', options: ['1', '2', '3', '4'], default: '4', note: '4 可执行所有命令（含服务器管理类）' },
  { key: 'function-permission-level', label: '函数权限等级', type: 'enum', options: ['1', '2', '3', '4'], default: '2', note: '数据包函数默认权限等级' },
  { key: 'enable-rcon', label: '启用 RCON', type: 'boolean', default: 'false', note: '远程控制台协议；开启后务必设置强密码' },
  { key: 'rcon.port', label: 'RCON 端口', type: 'number', default: '25575', note: '仅 enable-rcon=true 时生效' },
  { key: 'rcon.password', label: 'RCON 密码', type: 'string', default: '', note: '留空且开启 RCON 时行为未定义，务必设置密码' }
]

/* ------------------------------------------------------------------ *
 *  ServerManager
 * ------------------------------------------------------------------ */

interface ServerRuntimeInternal {
  id: string
  instance: ServerInstance
  process: GameProcess
  state: ServerRuntimeInfo['state']
  startedAt: number
  exitCode: number | null
  ready: boolean
  stopping: boolean
  players: { online: number; max: number }
  lastError?: string
  logFilePath: string
  secondaryLog: string | null
  secondaryQueue: Promise<void>
}

export interface ServerManagerOptions {
  client: HttpClient
  mirror: MirrorResolver
  downloadManager: DownloadManager
  cores: ServerCoreRegistry
  javaScanner: JavaScanner
  store: ServerStore
  /** 启动器侧日志目录（可选）；提供时主日志写到这里，同时 tee 到 <dir>/logs/mcal-latest.log */
  logRoot?: string
}

type StartOptions = {
  signal?: AbortSignal
  onLog?: (line: GameLogLine) => void
  onState?: (info: ServerRuntimeInfo) => void
}

export class ServerManager {
  private readonly cores: ServerCoreRegistry
  private readonly javaScanner: JavaScanner
  private readonly store: ServerStore
  private readonly logRoot?: string
  private servers: ServerInstance[] | null = null
  private readonly runtimes = new Map<string, ServerRuntimeInternal>()

  constructor(opts: ServerManagerOptions) {
    this.cores = opts.cores
    this.javaScanner = opts.javaScanner
    this.store = opts.store
    this.logRoot = opts.logRoot?.trim() || undefined
  }

  /* ---------------- 实例 CRUD ---------------- */

  async list(): Promise<ServerInstance[]> {
    return [...(await this.ensureLoaded())]
  }

  async create(opts: ServerCreateOptions): Promise<ServerInstance> {
    const servers = await this.ensureLoaded()
    const dir = opts.dir
    await ensureDir(dir)
    const gameVersion = cleanGameVersion(opts.gameVersion)
    const instance: ServerInstance = {
      id: shortId('srv-'),
      name: opts.name,
      dir,
      coreType: opts.coreType,
      coreVersion: opts.build ?? '',
      gameVersion,
      jarFile: '',
      memory: opts.memory ? { ...opts.memory } : { minMB: 1024, maxMB: 0, auto: true },
      javaPath: opts.javaPath,
      port: opts.port,
      eulaAccepted: false,
      createdAt: new Date().toISOString()
    }
    if (servers.some((s) => s.dir === dir)) {
      log.warn(`目录已被其他服务端实例使用：${dir}（允许多实例共享目录，但请自行避免并发启动）`)
    }

    // 先安装再入库：安装失败时不留下半成品实例
    const shouldInstall = opts.autoInstall ?? (opts.coreType !== 'custom' && opts.coreType !== 'spigot')
    if (shouldInstall) {
      const result = await this.cores.install(opts.coreType, {
        dir,
        gameVersion,
        build: opts.build,
        java: this.javaScanner,
        javaPath: opts.javaPath
      })
      if (result.jarFile) instance.jarFile = result.jarFile
      if (result.build) instance.coreVersion = result.build
      if (['fabric', 'quilt', 'forge', 'neoforge'].includes(opts.coreType) && result.build) {
        instance.loaderVersion = result.build
      }
      if (result.manualSteps && result.manualSteps.length > 0) {
        instance.notes = result.manualSteps.join('\n')
      }
      for (const warning of result.warnings) log.warn(`安装 ${opts.coreType}（${gameVersion}）：${warning}`)
    }

    servers.push(instance)
    if (opts.port !== undefined) {
      await this.writeProperties(instance.id, { 'server-port': String(opts.port) })
    }
    if (opts.acceptEula === true) {
      // 必须由调用方显式传入 true；默认绝不替用户接受 EULA
      await this.acceptEula(instance.id, true)
    }
    await this.persist()
    return instance
  }

  async update(id: string, patch: Partial<ServerInstance>): Promise<ServerInstance> {
    const instance = await this.requireInstance(id)
    const runtime = this.runtimes.get(id)
    if (patch.dir && patch.dir !== instance.dir && runtime?.process.isRunning()) {
      throw new Error(`服务端「${instance.name}」正在运行，无法修改目录`)
    }
    Object.assign(instance, patch, { id: instance.id })
    await this.persist()
    return instance
  }

  /** 移除实例记录并停止进程；**不删除磁盘文件**（避免误删存档），目录由上层决定是否清理 */
  async remove(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.process.isRunning()) await this.stop(id)
    this.runtimes.delete(id)
    const servers = await this.ensureLoaded()
    const index = servers.findIndex((s) => s.id === id)
    if (index >= 0) servers.splice(index, 1)
    await this.persist()
  }

  /* ---------------- 目录识别 ---------------- */

  detectExisting(dir: string): Promise<ServerCoreType | null> {
    return detectServerCoreType(dir)
  }

  /* ---------------- server.properties ---------------- */

  async readProperties(id: string): Promise<Record<string, string>> {
    const instance = await this.requireInstance(id)
    const text = await this.readFileIfExists(join(instance.dir, 'server.properties'))
    return text ? parsePropertiesText(text) : {}
  }

  async writeProperties(id: string, patch: Record<string, string>): Promise<void> {
    const instance = await this.requireInstance(id)
    const path = join(instance.dir, 'server.properties')
    const original = (await this.readFileIfExists(path)) ?? ''
    const next = applyPropertiesPatch(original, patch)
    await ensureDir(instance.dir)
    await writeFileAtomic(path, next)
    instance.properties = parsePropertiesText(next)
    const port = instance.properties['server-port']
    if (port !== undefined && Number.isFinite(Number(port))) instance.port = Number(port)
    await this.persist()
  }

  propertyDocs(): ServerPropertyDoc[] {
    return SERVER_PROPERTY_DOCS.map((doc) => ({ ...doc }))
  }

  /** 写入 eula.txt；accept=true 表示用户已明确同意 Minecraft EULA */
  async acceptEula(id: string, accept: boolean): Promise<void> {
    const instance = await this.requireInstance(id)
    await ensureDir(instance.dir)
    // 与官方服务端生成的格式保持一致（# 开头的说明行 + eula 键）
    const content =
      '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n' +
      `eula=${accept ? 'true' : 'false'}\n`
    await writeFileAtomic(join(instance.dir, 'eula.txt'), content)
    instance.eulaAccepted = accept
    await this.persist()
  }

  /* ---------------- 启动 / 停止 ---------------- */

  async start(id: string, opts: StartOptions = {}): Promise<{ pid: number }> {
    const instance = await this.requireInstance(id)
    const existing = this.runtimes.get(id)
    if (existing?.process.isRunning()) {
      throw new Error(`服务端「${instance.name}」已在运行（pid=${existing.process.pid}）`)
    }
    await ensureDir(instance.dir)
    await this.ensureEulaAccepted(instance)

    const memory = resolveMemoryPolicy(instance.memory ?? { minMB: 1024, maxMB: 0, auto: true })
    const jvmArgs = buildDefaultJvmArgs(memory, instance.jvmArgs ?? [])
    const target = await detectLaunchTarget(instance.dir, { jarFile: instance.jarFile, platform: process.platform })
    if (!target) {
      const script = (await pathExists(join(instance.dir, 'run.bat'))) ? 'run.bat' : (await pathExists(join(instance.dir, 'run.sh'))) ? 'run.sh' : null
      throw new Error(
        `未在 ${instance.dir} 找到可启动的 jar 或 Forge/NeoForge 的 @args.txt；` +
          (script
            ? `检测到 ${script}（旧版 Forge 由脚本启动），请手动运行该脚本，或重新安装核心后再由启动器托管`
            : '请先安装核心 jar，或在实例设置中指定 jarFile')
      )
    }
    const javaPath = await this.resolveJava(instance)
    const command = buildServerCommand({
      javaPath,
      jvmArgs,
      jarFile: target.kind === 'jar' ? target.path : undefined,
      argsFile: target.kind === 'args-file' ? target.path : null
    })

    const logDir = join(instance.dir, 'logs')
    const mcalLogPath = join(logDir, 'mcal-latest.log')
    const primaryLog = this.logRoot
      ? join(this.logRoot, `${sanitizeFileName(instance.name)}-${instance.id}.log`)
      : mcalLogPath
    await ensureDir(logDir)
    await ensureDir(dirname(primaryLog))

    const runtime: ServerRuntimeInternal = {
      id,
      instance,
      process: undefined as unknown as GameProcess,
      state: 'starting',
      startedAt: Date.now(),
      exitCode: null,
      ready: false,
      stopping: false,
      players: { online: 0, max: 0 },
      logFilePath: primaryLog,
      secondaryLog: primaryLog === mcalLogPath ? null : mcalLogPath,
      secondaryQueue: Promise.resolve()
    }

    const gameProcess = new GameProcess({
      command: command.command,
      args: command.args,
      cwd: instance.dir,
      windowsHide: true,
      logFile: primaryLog,
      events: {
        onLog: (line) => this.handleLog(runtime, line, opts),
        onError: (err) => {
          runtime.lastError = err.message
          log.warn(`服务端进程错误（${instance.name}）：${err.message}`)
        },
        onExit: (code) => this.handleExit(runtime, code, opts)
      }
    })
    runtime.process = gameProcess
    this.runtimes.set(id, runtime)

    log.info(`启动服务端「${instance.name}」：${command.display}`)
    try {
      gameProcess.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      runtime.lastError = message
      runtime.state = 'crashed'
      throw new Error(`启动服务端进程失败：${message}`)
    }

    opts.signal?.addEventListener('abort', () => {
      void this.stop(id, { force: true }).catch((err: unknown) => log.warn(`取消启动时停止失败：${String(err)}`))
    }, { once: true })

    // 给 spawn 错误与「启动即退出」（例如缺少 Java、EULA 未接受）留出反馈时间
    await sleep(250)
    if (!gameProcess.isRunning()) {
      const message =
        runtime.lastError ??
        `服务端进程启动后立即退出（退出码 ${gameProcess.exitCode ?? 'null'}），请检查日志 ${primaryLog}`
      throw new Error(message)
    }

    instance.lastStartedAt = new Date().toISOString()
    await this.persist()
    opts.onState?.(this.snapshot(runtime))
    return { pid: gameProcess.pid }
  }

  /**
   * 停止服务端：优先 `stop` 命令（stdin）+ 等待退出（默认 30 秒）；
   * 超时或 force=true 时结束进程树（Windows taskkill /T /F，POSIX 进程组 SIGKILL）。
   */
  async stop(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime || !runtime.process.isRunning()) return
    runtime.stopping = true
    const pid = runtime.process.pid

    if (!opts.force) {
      log.info(`向服务端「${runtime.instance.name}」发送 stop 命令（pid=${pid}）`)
      this.writeCommand(runtime, 'stop')
      const deadline = Date.now() + 30_000
      while (runtime.process.isRunning() && Date.now() < deadline) {
        await sleep(250)
      }
      if (!runtime.process.isRunning()) return
      log.warn(`服务端「${runtime.instance.name}」30 秒内未退出，将结束进程树`)
    }

    killProcessTree(pid)
    const deadline = Date.now() + 5000
    while (runtime.process.isRunning() && Date.now() < deadline) {
      await sleep(200)
    }
    if (runtime.process.isRunning()) {
      await runtime.process.stop({ force: true, timeoutMs: 5000 })
    }
  }

  /** 向服务端 stdin 发送命令（stop / say / op ...） */
  async sendCommand(id: string, command: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime || !runtime.process.isRunning()) {
      throw new Error(`服务端未在运行：${id}`)
    }
    this.writeCommand(runtime, command.trim())
  }

  getRuntime(id: string): ServerRuntimeInfo | null {
    const runtime = this.runtimes.get(id)
    return runtime ? this.snapshot(runtime) : null
  }

  listRunning(): ServerRuntimeInfo[] {
    return [...this.runtimes.values()].filter((r) => r.process.isRunning()).map((r) => this.snapshot(r))
  }

  async stopAll(): Promise<void> {
    const ids = [...this.runtimes.values()].filter((r) => r.process.isRunning()).map((r) => r.id)
    for (const id of ids) {
      await this.stop(id).catch((err: unknown) => log.warn(`停止 ${id} 失败：${String(err)}`))
    }
  }

  /* ---------------- 内部 ---------------- */

  private handleLog(runtime: ServerRuntimeInternal, line: GameLogLine, opts: StartOptions): void {
    try {
      opts.onLog?.(line)
    } catch (err) {
      log.warn(`日志回调异常：${err instanceof Error ? err.message : String(err)}`)
    }

    const raw = line.raw
    if (!runtime.ready && detectServerReady(raw)) {
      runtime.ready = true
      runtime.state = 'running'
      log.info(`服务端「${runtime.instance.name}」已就绪（pid=${runtime.process.pid}）`)
      this.emitState(runtime, opts)
    }
    if (applyPlayersLine(runtime.players, raw)) {
      this.emitState(runtime, opts)
    }
    if (line.level === 'error' || line.level === 'fatal') {
      runtime.lastError = raw
    }
    if (/agree to the eula/i.test(raw)) {
      // 服务端因未接受 EULA 退出时，日志里只有这行提示，记下来供上层与诊断使用
      runtime.lastError = raw
    }
    this.teeSecondary(runtime, raw)
  }

  private handleExit(runtime: ServerRuntimeInternal, code: number | null, opts: StartOptions): void {
    runtime.exitCode = code
    const requested = runtime.stopping || runtime.process.wasStopRequested
    runtime.state = requested ? 'exited' : code === 0 || code === null ? 'exited' : 'crashed'
    if (runtime.state === 'crashed' && !runtime.lastError) {
      runtime.lastError = `进程异常退出（退出码 ${code ?? 'null'}），请查看日志 ${runtime.logFilePath}`
    }
    log.info(`服务端「${runtime.instance.name}」退出：code=${code ?? '-'} state=${runtime.state}`)
    this.emitState(runtime, opts)
  }

  private emitState(runtime: ServerRuntimeInternal, opts: StartOptions): void {
    try {
      opts.onState?.(this.snapshot(runtime))
    } catch (err) {
      log.warn(`状态回调异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private snapshot(runtime: ServerRuntimeInternal): ServerRuntimeInfo {
    const info: ServerRuntimeInfo = {
      id: runtime.id,
      pid: runtime.process.pid,
      state: runtime.state,
      startedAt: runtime.startedAt,
      uptimeMs: Math.max(0, Date.now() - runtime.startedAt),
      exitCode: runtime.exitCode,
      players: { ...runtime.players }
    }
    if (runtime.lastError) info.lastError = runtime.lastError
    return info
  }

  private writeCommand(runtime: ServerRuntimeInternal, command: string): void {
    runtime.process.writeStdin(`${command.replace(/[\r\n]+$/, '')}\n`)
  }

  /** stdout 同时落到 <dir>/logs/mcal-latest.log（MC 自身的 logs/latest.log 之外的另一份） */
  private teeSecondary(runtime: ServerRuntimeInternal, raw: string): void {
    const path = runtime.secondaryLog
    if (!path) return
    runtime.secondaryQueue = runtime.secondaryQueue
      .then(() => appendFile(path, `${raw}\n`, 'utf8'))
      .catch(() => undefined)
  }

  private async ensureEulaAccepted(instance: ServerInstance): Promise<void> {
    // 自定义核心可能是代理端（Velocity 等）或自带 EULA 处理，不做阻断
    if (instance.coreType === 'custom') return
    const text = await this.readFileIfExists(join(instance.dir, 'eula.txt'))
    const accepted = text ? parsePropertiesText(text).eula?.trim().toLowerCase() === 'true' : false
    if (accepted) return
    throw new Error(
      `尚未接受 Minecraft EULA：请先调用 acceptEula("${instance.id}", true)` +
        `（将在 ${join(instance.dir, 'eula.txt')} 写入 eula=true）。EULA 必须由用户明确同意，启动器不会默认接受。`
    )
  }

  private async resolveJava(instance: ServerInstance): Promise<string> {
    if (instance.javaPath && (await pathExists(instance.javaPath))) return instance.javaPath
    const required = requiredJavaMajor(instance.gameVersion)
    const candidates = await this.javaScanner.scan()
    const picked = pickBestJava(candidates, required)
    if (!picked?.path) {
      throw new Error(
        `未找到可运行 Minecraft ${instance.gameVersion} 服务端的 Java（需要 Java ${required}）：` +
          '请在「Java 管理」中安装/扫描运行时，或在实例设置里手动指定 javaPath'
      )
    }
    return picked.path
  }

  private async requireInstance(id: string): Promise<ServerInstance> {
    const servers = await this.ensureLoaded()
    const instance = servers.find((s) => s.id === id)
    if (!instance) throw new Error(`服务端实例不存在：${id}`)
    return instance
  }

  private async ensureLoaded(): Promise<ServerInstance[]> {
    if (!this.servers) this.servers = await this.store.load()
    return this.servers
  }

  private async persist(): Promise<void> {
    if (!this.servers) return
    await this.store.save(this.servers)
  }

  private async readFileIfExists(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  }
}
