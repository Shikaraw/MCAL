/**
 * 游戏日志解析：把 Minecraft / 各类加载器的 stdout 行切成结构化 GameLogLine，
 * 并基于真实日志标志判断启动阶段。
 *
 * 支持的格式（都是实际存在的输出）：
 *  1. 原版 1.7~1.12：`[19:20:41] [Client thread/INFO]: Setting user: Steve`
 *  2. 原版 1.13+：  `[19:20:41] [Render thread/INFO] (Minecraft/1.20.1) Backend library: LWJGL ...`
 *  3. Forge/NeoForge：`[19:20:41] [main/INFO] [net.minecraftforge.fml.loading.ModSorter/]: ...`
 *  4. 无时间戳 stdout：`[main/WARN] [minecraft/...]: ...` 或裸文本
 *  5. JVM/崩溃输出：`Exception in thread "main" ...`、`Caused by: ...`、
 *     `# A fatal error has been detected by the Java Runtime Environment`、`# Problematic frame`
 *
 * 反直觉点：
 *  - 第二对方括号里的 `INFO` 属于「线程名/级别」而不是 logger 名，logger 在第三对方括号；
 *  - 级别大小写混用（`WARN` / `warn` / `Warn`），必须忽略大小写；
 *  - 裸 `at x.y.Z(Foo.java:1)` 是栈帧，没有级别信息，标为 unknown 而不是 error，
 *    否则一个被 catch 的堆栈会把整段日志判成崩溃。
 */

import type { GameLogLine } from '@shared/types'

export type StartupStage = 'unknown' | 'launching' | 'preinit' | 'postinit' | 'ready' | 'crashed'

const LEVEL_NAMES = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

/** 时间戳：`[19:20:41]` / `[19:20:41.123]` / `[19:20:41,123]` */
const TIMESTAMP_RE = /^\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)\]\s*/
/** `[线程名/级别]` 或 `[级别]`；线程名可能含空格与连字符 */
const THREAD_LEVEL_RE = /^\[([^\[\]]+)\]\s*/
/** Forge/NeoForge 的 logger：`[net.minecraftforge.fml.loading.ModSorter/]` */
const LOGGER_RE = /^\[([^\[\]]+)\]\s*/
/** 现代启动器的上下文：`(Minecraft/1.20.1)` —— 不是 logger，丢弃 */
const CONTEXT_RE = /^\(([^()]{0,120})\)\s*/

const STACK_FRAME_RE = /^\s*at\s+[\w$./<>[\]]+\(.*\)\s*$/

const CRASH_MARKERS: RegExp[] = [
  /a fatal error has been detected by the java runtime environment/i,
  /^#\s*problematic frame/i,
  /exception in thread "/i,
  /^caused by:/i,
  /the game crashed whilst/i,
  /game crashed with exit code/i,
  /failed to load mods|mod resolution encountered an error|mod loading has failed/i,
  /a mod crashed on startup/i,
  /java\.(lang\.)?(unsupportedclassversionerror|noclassdeffounderror|outofmemoryerror|classnotfoundexception)/i
]

const JVM_FATAL_RE = /a fatal error has been detected by the java runtime environment|^#\s*problematic frame|SIGSEGV|EXCEPTION_ACCESS_VIOLATION/i

/** 阶段标志：按真实日志逐条核对过（1.7 ~ 1.21 / Forge / NeoForge / Fabric / 服务端） */
const STAGE_MARKERS: { stage: Exclude<StartupStage, 'unknown' | 'crashed'>; re: RegExp }[] = [
  // 启动中：JVM 已起来、Minecraft 主类开始执行
  { stage: 'launching', re: /setting user:|backend library:\s*lwjgl|modlauncher running:|launching target '|loading minecraft \S+ (with|using)|minecraft version:\s*\S+|fabricloader \d|command line arguments:|\[minecraft\/minecraft\]:/i },
  // 预初始化：mod 发现/构造（Forge 的 preinit、Fabric 的 mod 加载）
  { stage: 'preinit', re: /forge mod loader (version|has been initialized)|loading \d+ mods|constructing mods|scanning for mods|mod discovery|preparing launch|injecting mods|modloading|dispatching .* \(preinit\)/i },
  // 后初始化：mod 加载完成、数据包加载
  { stage: 'postinit', re: /mod loading (is )?complete|modloading complete|freezing data|dispatching .* \(loading\)|setup complete|loading 100%|progress:\s*100%|finished mod loading|datapack .* (loaded|reloaded)/i },
  // 就绪：这些是客户端真正可玩的标志（服务端用 Done/Preparing spawn area）
  { stage: 'ready', re: /sound engine started|created:\s*\d+x\d+.*textures-atlas|loaded \d+ recipes|starting integrated minecraft server version|done \(\d+(\.\d+)?s\)! for help|preparing spawn area:\s*100%/i }
]

/**
 * 解析单行日志。任何无法识别的输入都会被原样放进 raw，级别为 unknown。
 */
export function parseLogLine(raw: string): GameLogLine {
  const line: GameLogLine = { ts: Date.now(), level: 'unknown', raw }
  let rest = raw

  const timestamp = TIMESTAMP_RE.exec(rest)
  if (timestamp) rest = rest.slice(timestamp[0].length)

  // 1) 第一对方括号：[线程/级别]（或某些实现只有 [级别]）
  const first = THREAD_LEVEL_RE.exec(rest)
  if (first) {
    const inner = first[1]
    const slash = inner.lastIndexOf('/')
    const maybeLevel = (slash >= 0 ? inner.slice(slash + 1) : inner).trim().toLowerCase()
    if (LEVEL_NAMES.has(maybeLevel)) {
      line.level = maybeLevel as GameLogLine['level']
      rest = rest.slice(first[0].length)
      rest = rest.replace(/^:\s*/, '')

      // 2) 第二对方括号：Forge logger；否则可能是 (Minecraft/xxx) 上下文
      const loggerMatch = LOGGER_RE.exec(rest)
      if (loggerMatch) {
        line.logger = loggerMatch[1].replace(/\/+$/, '')
        rest = rest.slice(loggerMatch[0].length)
        rest = rest.replace(/^:\s*/, '')
      } else {
        const context = CONTEXT_RE.exec(rest)
        if (context) rest = rest.slice(context[0].length)
      }
    }
  }

  line.message = rest.length > 0 ? rest : undefined

  // 3) 无显式级别时，识别崩溃 / JVM 致命输出 / 栈帧
  if (line.level === 'unknown') {
    if (JVM_FATAL_RE.test(raw)) line.level = 'fatal'
    else if (/^\s*(exception|error)( in thread)?/i.test(raw) && !STACK_FRAME_RE.test(raw)) line.level = 'error'
    else if (/^caused by:/i.test(raw)) line.level = 'error'
    else if (/\b(unsupportedclassversionerror|noclassdeffounderror|classnotfoundexception|outofmemoryerror|nosuchmethoderror|nosuchfielderror)\b/.test(raw)) {
      line.level = 'error'
    }
    // 栈帧保持 unknown：一个被捕获的异常不应污染级别统计
  }

  return line
}

/** 解析一整段文本（按 \r\n / \n / \r 切分；忽略空行） */
export function parseLogChunk(text: string): GameLogLine[] {
  if (!text) return []
  const out: GameLogLine[] = []
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (raw.length === 0) continue
    out.push(parseLogLine(raw))
  }
  return out
}

function stageRank(stage: StartupStage): number {
  switch (stage) {
    case 'launching':
      return 1
    case 'preinit':
      return 2
    case 'postinit':
      return 3
    case 'ready':
      return 4
    default:
      return 0
  }
}

function matchStage(raw: string): Exclude<StartupStage, 'unknown' | 'crashed'> | null {
  for (const marker of STAGE_MARKERS) {
    if (marker.re.test(raw)) return marker.stage
  }
  return null
}

/**
 * 从整段日志判断启动阶段。
 * - 崩溃优先：只要崩溃标志出现在「最后一个就绪标志」之后，就判为 crashed；
 *   崩溃出现在 ready 之前（例如启动早期被捕获的异常）不影响阶段判定。
 * - 阶段取出现过的最高档（日志可能被截断，但只要出现过 ready 标志就算就绪）。
 */
export function detectStartupState(lines: GameLogLine[]): { stage: StartupStage; evidence?: string } {
  let stage: StartupStage = 'unknown'
  let stageEvidence: string | undefined
  let readyIndex = -1
  let crashIndex = -1
  let crashEvidence: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.raw ?? ''
    if (CRASH_MARKERS.some((re) => re.test(raw)) || lines[i]?.level === 'fatal') {
      crashIndex = i
      crashEvidence = raw
    }
    const matched = matchStage(raw)
    if (matched) {
      if (matched === 'ready') readyIndex = i
      if (stageRank(matched) > stageRank(stage)) {
        stage = matched
        stageEvidence = raw
      }
    }
  }

  if (crashIndex >= 0 && crashIndex > readyIndex) {
    return { stage: 'crashed', evidence: crashEvidence }
  }
  if (stage !== 'unknown') return { stage, evidence: stageEvidence }
  if (crashIndex >= 0) return { stage: 'crashed', evidence: crashEvidence }
  return { stage: 'unknown' }
}
