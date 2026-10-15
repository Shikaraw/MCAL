/**
 * 诊断规则库（MCAL 的核心资产之一）
 *
 * 设计目标：
 *  1. 所有 pattern 都来自「真实报错文本」，不是猜测出来的关键词；
 *  2. 命中规则 → 给可执行的解决步骤（中文、具体到点哪个按钮 / 改哪一行参数）+ 知识库文章 id；
 *  3. refine() 负责需要上下文的动态判定（解析 class file 版本、提取缺失前置、识别驱动 dll 等），
 *     返回 null 表示该规则在当前上下文不适用（例如「卡死」规则在有堆栈时必须让位给崩溃规则）。
 *
 * 约定：
 *  - 规则中的正则一律不加 `g` 标志（避免 lastIndex 状态污染），需要全局扫描时在 refine 里现写现用；
 *  - `patterns` 里 `required: true` 的项必须全部命中；其余命中任意一个即可；
 *  - `weight` 越高的模式越"决定性"，参与置信度计算（命中权重 / 总权重）；
 *  - `excludes` 命中则直接否决该规则（用于把「Exit Code: 1 且无堆栈」之类宽泛场景限定住）。
 */

import type { DiagnosticFinding, GameLogLine, LoaderType } from '@shared/types'
import { detectStartupState } from '@core/launch/logparse'
import { parseJavaMajor } from '@core/util/misc'

/* ------------------------------------------------------------------ *
 *  公共类型
 * ------------------------------------------------------------------ */

export interface DiagnosePattern {
  re: RegExp
  /** 该模式是否必需（默认任一匹配即命中） */
  required?: boolean
  /** 权重，默认 1；参与置信度计算 */
  weight?: number
}

export interface DiagnoseRule {
  id: string
  /** 规则名（中文） */
  title: string
  category: DiagnosticFinding['category']
  severity: DiagnosticFinding['severity']
  /** 匹配模式：正则（对整段日志/崩溃报告文本及各行） */
  patterns: DiagnosePattern[]
  /** 排除模式（命中则否决） */
  excludes?: RegExp[]
  /** 置信度基础分 */
  confidence: number
  /** 需要额外上下文时的动态判定（返回 null 表示不适用） */
  refine?: (ctx: DiagnoseContext) => Partial<DiagnosticFinding> | null
  /** 相关知识库文章 id */
  knowledgeIds: string[]
  /** 兜底解决步骤（refine 未提供时使用） */
  steps: string[]
  detail: string
  /**
   * 去重分组键。默认使用 category（同类只保留最相关的一条，避免刷屏）。
   * 只对「同一 category 下彼此独立、且可能同时出现的问题」显式指定不同的键：
   *  - memory：堆 / 元空间 / GC / 直接内存 / 线程 五种 OOM，修法各不相同；
   *  - server：tick 崩溃 / 插件加载失败 / EULA 未同意，常常同时出现在一份服务端日志里。
   */
  dedupeKey?: string
}

export interface DiagnoseContext {
  text: string
  lines: GameLogLine[]
  /** 从环境中收集的事实 */
  facts: DiagnoseFacts
}

export interface DiagnoseFacts {
  gameVersion?: string
  loaderType?: LoaderType
  loaderVersion?: string
  javaMajor?: number
  javaVendor?: string
  javaPath?: string
  maxHeapMB?: number
  physicalMemoryMB?: number
  osArch?: string
  osName?: string
  gpuVendors?: string[]
  /** 从游戏目录读到的信息 */
  modCount?: number
  mods?: {
    fileName: string
    id?: string
    version?: string
    gameVersions?: string[]
    loaders?: string[]
    environment?: string
    depends?: { id: string; required: boolean; versionRange?: string }[]
  }[]
  resourcePackCount?: number
  shaderPackCount?: number
  /** 崩溃报告解析出的字段 */
  crashReport?: {
    description?: string
    suspectedMods?: string[]
    stackTop?: string
    exitCode?: number
    problematicFrame?: string
    hsErrReason?: string
  }
  exitCode?: number | null
  /** 是否检测到图形/驱动相关的 dll */
  graphicsDriver?: { name: string; file?: string; vendor?: string }
  /** 以下为可选扩展（调用方不提供不影响运行） */
  /** 文本里出现的 JVM 参数（-Xmx4G 等），便于诊断内存问题 */
  jvmFlags?: string[]
  /** 崩溃报告 Memory: 行解析出的已用堆（MB） */
  heapUsedMB?: number
}

/* ------------------------------------------------------------------ *
 *  常量表
 * ------------------------------------------------------------------ */

/** class file major version → 对应的 Java 大版本 */
export const CLASS_FILE_JAVA: Record<number, number> = {
  45: 1,
  46: 2,
  47: 3,
  48: 4,
  49: 5,
  50: 6,
  51: 7,
  52: 8,
  53: 9,
  54: 10,
  55: 11,
  56: 12,
  57: 13,
  58: 14,
  59: 15,
  60: 16,
  61: 17,
  62: 18,
  63: 19,
  64: 20,
  65: 21,
  66: 22,
  67: 23,
  68: 24,
  69: 25
}

export function javaVersionForClassFileMajor(major: number): number | null {
  return CLASS_FILE_JAVA[major] ?? null
}

/** 32 位 JVM 的堆上限（约 1.5G，实际可用更少） */
export const MAX_HEAP_32BIT_MB = 1536

/**
 * 推荐的最大堆：物理内存的 50%~70%（这里取 60% 并对齐到 512MB）。
 * 32 位 Java 上限 1.5G；超过 12G 收益递减（GC 停顿变长）。
 */
export function recommendedMaxHeapMB(physicalMemoryMB: number, opts?: { is32Bit?: boolean; javaMajor?: number }): number {
  if (!physicalMemoryMB || physicalMemoryMB <= 0) return 4096
  let mb = Math.floor((physicalMemoryMB * 0.6) / 512) * 512
  mb = Math.max(1024, Math.min(mb, 12288))
  if (opts?.is32Bit) mb = Math.min(mb, MAX_HEAP_32BIT_MB)
  else if (opts?.javaMajor !== undefined && opts.javaMajor <= 8) mb = Math.max(1024, Math.min(mb, 4096))
  return mb
}

export interface GraphicsDriverInfo {
  name: string
  vendor: string
  file: string
}

/** 崩溃栈里出现这些 dll 说明死在显卡/系统原生库里（0xC0000005 的第一嫌疑） */
const DRIVER_PATTERNS: { re: RegExp; vendor: string; name: string }[] = [
  {
    re: /atio6axx\.dll|atig6txx\.dll|amdxx64\.dll|amdxx32\.dll|amdvlk(?:64|32)?\.dll|amdxc64\.dll|amdadlx64\.dll/i,
    vendor: 'AMD',
    name: 'AMD 显卡驱动'
  },
  {
    re: /nvoglv64\.dll|nvoglv32\.dll|nvldumdx\.dll|nvwgf2umx\.dll|nvcuda\.dll|nvinitx\.dll/i,
    vendor: 'NVIDIA',
    name: 'NVIDIA 显卡驱动'
  },
  {
    re: /igdumdim(?:64|32)\.dll|ig(?:9|10|11)?icd64\.dll|ig(?:d|n)10iumd(?:64|32)\.dll|igddxvacrt\.dll/i,
    vendor: 'Intel',
    name: 'Intel 核显驱动'
  },
  { re: /opengl32\.dll/i, vendor: 'system', name: '系统 OpenGL（最终由显卡驱动实现）' },
  { re: /lwjgl(?:_opengl)?\.dll/i, vendor: 'lwjgl', name: 'LWJGL 原生库' },
  { re: /openal(?:32|64)?\.dll|libopenal\.so/i, vendor: 'openal', name: 'OpenAL 音频库' },
  { re: /glfw(?:32|64)?\.dll/i, vendor: 'system', name: 'GLFW 窗口/输入库' }
]

/** 从任意文本（通常是崩溃栈或 hs_err）中识别涉及的图形/原生驱动 */
export function detectGraphicsDriver(text: string): GraphicsDriverInfo | null {
  if (!text) return null
  for (const item of DRIVER_PATTERNS) {
    const match = item.re.exec(text)
    if (match) return { name: item.name, vendor: item.vendor, file: match[0] }
  }
  return null
}

/** Windows 常见退出码 → 含义（-1073741819 = 0xC0000005 访问冲突） */
export const EXIT_CODE_MEANING: Record<string, string> = {
  '0': '正常退出',
  '1': '游戏/启动器自身报错退出（常见于参数错误、安全软件拦截、JVM 启动失败）',
  '-1': '进程被强制结束（启动器 kill / JVM 无法启动 / 启动脚本失败）',
  '-1073741819': '0xC0000005 STATUS_ACCESS_VIOLATION：访问冲突，多数由显卡驱动或原生库崩溃引起',
  '-1073740791': '0xC0000409 STATUS_STACK_BUFFER_OVERRUN：栈溢出/安全检查失败（常见于原生库或杀软注入）',
  '-805306369': '0xCFFFFFFF：Windows 判定进程异常终止',
  '134': 'SIGABRT（Linux）：JVM 主动 abort，通常是致命错误或断言失败',
  '137': 'SIGKILL / OOM Killer（Linux）：进程被系统杀掉，检查系统内存与容器限制',
  '139': 'SIGSEGV（Linux）：段错误，等价于 EXCEPTION_ACCESS_VIOLATION'
}

/* ------------------------------------------------------------------ *
 *  解析辅助（崩溃报告 / hs_err / 内存与版本事实）
 * ------------------------------------------------------------------ */

export interface HsErrSummary {
  reason?: string
  problematicFrame?: string
  jreVersion?: string
  outOfMemory?: boolean
  commandLine?: string
}

function isBlank(line: string | undefined): boolean {
  return !line || line.trim().length === 0
}

/** 解析 hs_err_pid*.log 的关键字段（# JRE version / # Problematic frame / 致命原因 / 命令行） */
export function parseHsErrFields(text: string): HsErrSummary {
  const lines = text.split(/\r?\n/)
  const out: HsErrSummary = {}
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!out.jreVersion) {
      const m = /^#\s*(?:JRE version|Java VM):\s*(.+)$/i.exec(line)
      if (m) {
        out.jreVersion = m[1].trim()
        continue
      }
    }
    if (!out.problematicFrame) {
      const m = /^#?\s*Problematic frame:\s*(.*)$/i.exec(line)
      if (m) {
        let frame = m[1].trim()
        if (!frame) {
          for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
            const next = lines[j] ?? ''
            if (next.trim().length > 0) {
              frame = next.trim().replace(/^#\s*/, '').trim()
              break
            }
          }
        }
        if (frame) out.problematicFrame = frame
        continue
      }
    }
    if (!out.reason) {
      // 例：`#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=..., pid=1` / `#  Out of Memory Error (os_windows.cpp:3495)`
      const m = /^#\s{1,4}(EXCEPTION_[A-Z_]+[^\n]*|SIG[A-Z]+[^\n]*|Internal Error[^\n]*|There is insufficient memory[^\n]*|Out of Memory Error[^\n]*|Unable to allocate[^\n]*)/i.exec(
        line
      )
      if (m) {
        out.reason = m[1].trim()
        continue
      }
    }
    if (!out.commandLine) {
      const m = /^#?\s*Command Line:\s*(.+)$/i.exec(line)
      if (m && m[1].trim() !== '<original command line>') {
        out.commandLine = m[1].trim()
        continue
      }
    }
  }
  out.outOfMemory =
    /OutOfMemoryError|Out of Memory Error|insufficient memory|unable to allocate|native memory allocation/i.test(text)
  return out
}

/** 解析 crash-reports/crash-xxxx-client.txt 的固定字段（Description / Suspected Mods / Stacktrace 栈顶） */
export function parseCrashReportFields(text: string): NonNullable<DiagnoseFacts['crashReport']> {
  const lines = text.split(/\r?\n/)
  const out: NonNullable<DiagnoseFacts['crashReport']> = {}
  let scanningStack = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!out.description) {
      const m = /^Description:\s*(.+)$/i.exec(trimmed)
      if (m) {
        out.description = m[1].trim()
        continue
      }
    }
    if (!out.suspectedMods) {
      const m = /^Suspected Mods?:\s*(.+)$/i.exec(trimmed)
      if (m) {
        const names = m[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !/^none$/i.test(s))
        if (names.length > 0) out.suspectedMods = names
        continue
      }
    }
    if (out.exitCode === undefined) {
      const m = /^Exit Code:\s*(-?\d+)/i.exec(trimmed)
      if (m) {
        out.exitCode = Number.parseInt(m[1], 10)
        continue
      }
    }
    if (!out.problematicFrame) {
      const m = /^#?\s*Problematic frame:\s*(.*)$/i.exec(trimmed)
      if (m) {
        let frame = m[1].trim()
        if (!frame) {
          for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
            const next = (lines[j] ?? '').trim()
            if (next.length > 0) {
              frame = next.replace(/^#\s*/, '').trim()
              break
            }
          }
        }
        if (frame) out.problematicFrame = frame
        continue
      }
    }
    if (!out.hsErrReason) {
      const m = /^#\s{1,4}(EXCEPTION_[A-Z_]+[^\n]*|SIG[A-Z]+[^\n]*|Internal Error[^\n]*|There is insufficient memory[^\n]*|Out of Memory Error[^\n]*)/i.exec(
        trimmed
      )
      if (m) {
        out.hsErrReason = m[1].trim()
        continue
      }
    }
    if (/^Stacktrace:\s*$/i.test(trimmed)) {
      scanningStack = true
      continue
    }
    if (scanningStack && !out.stackTop) {
      const m = /^\s*at\s+(.+)$/.exec(raw)
      if (m) out.stackTop = m[1].trim()
      else if (!isBlank(trimmed) && !/^--/.test(trimmed) && !/^Caused by:/i.test(trimmed)) scanningStack = false
    }
  }
  return out
}

/** 解析 `-Xmx4G` / `-Xmx4096m` → MB；解析失败返回 undefined */
export function parseHeapFlag(value: string): number | undefined {
  const m = /^(-?\d+(?:\.\d+)?)\s*([kKmMgGtT]?)$/.exec(value.trim())
  if (!m) return undefined
  const num = Number.parseFloat(m[1])
  if (!Number.isFinite(num) || num <= 0) return undefined
  const unit = m[2].toLowerCase()
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : unit === 'g' ? 1024 * 1024 * 1024 : unit === 't' ? 1024 ** 4 : 1
  return Math.round((num * factor) / (1024 * 1024))
}

function firstNumber(text: string, re: RegExp): number | undefined {
  const m = re.exec(text)
  if (!m) return undefined
  const n = Number.parseFloat(m[1].replace(/[,_]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/** 从原始文本里抽取上下文事实（Java 版本、内存、退出码、崩溃报告字段、mod 列表等） */
export function extractFacts(opts: { text: string; facts?: Partial<DiagnoseFacts> }): DiagnoseFacts {
  const text = opts.text ?? ''
  const facts: DiagnoseFacts = {}

  /* ---- 游戏版本 ---- */
  const versionPatterns: RegExp[] = [
    /^\s*Minecraft Version(?: ID)?:\s*([\w.\-+]+)/im,
    /(?:Loading|Starting) Minecraft (?:server )?version\s+([\w.\-+]+)/i,
    /--version\s+([\w.\-+]+)/i,
    /Launched Version:\s*([\w.\-+]+)/i,
    /\(Minecraft\/([\w.\-+]+)\)/i,
    /Starting minecraft server version\s+([\w.\-+]+)/i
  ]
  for (const re of versionPatterns) {
    const value = firstString(text, re)
    if (value) {
      // Forge/Fabric 的 "Launched Version" 形如 1.20.1-forge-47.2.0，剥掉加载器后缀
      facts.gameVersion = value.replace(/-(?:forge|neoforge|fabric|quilt|optifine)-?[\d.]*$/i, '')
      break
    }
  }

  /* ---- 加载器 ---- */
  const forge =
    /Forge Mod Loader version\s*([\d.]+)\s*for Minecraft/i.exec(text) ??
    /(?:^|[\s_-])forge[-_]v?([\d]+\.[\d.]+)/i.exec(text)
  const neoforge = /NeoForge version\s*([\d.]+)/i.exec(text) ?? /neoforge-([\d.]+)/i.exec(text)
  const fabric = /Fabric Loader[^\d\n]{0,8}([\d.]+)/i.exec(text) ?? /fabric-loader-([\d.]+)/i.exec(text)
  const quilt = /Quilt Loader[^\d\n]{0,8}([\d.]+)/i.exec(text)
  if (/net\.neoforged|neoforge/i.test(text) && neoforge) {
    facts.loaderType = 'neoforge'
    facts.loaderVersion = neoforge[1]
  } else if (forge) {
    facts.loaderType = 'forge'
    facts.loaderVersion = forge[1]
  } else if (fabric) {
    facts.loaderType = 'fabric'
    facts.loaderVersion = fabric[1]
  } else if (quilt) {
    facts.loaderType = 'quilt'
    facts.loaderVersion = quilt[1]
  } else if (/net\.fabricmc\.loader/i.test(text)) {
    facts.loaderType = 'fabric'
  } else if (/net\.minecraftforge|fml\.loading/i.test(text)) {
    facts.loaderType = 'forge'
  }

  /* ---- Java 版本 / 发行版 / 路径 ---- */
  const javaCandidates: (string | undefined)[] = [
    firstString(text, /^\s*Java Version:\s*([^,\n]+)/im),
    firstString(text, /^\s*Java VM Version:\s*([^,\n]+)/im),
    firstString(text, /java version "([^"]+)"/i),
    firstString(text, /openjdk version "([^"]+)"/i),
    firstString(text, /^\s*JVM Version:\s*([\w.\-+_]+)/im),
    firstString(text, /^\s*#\s*JRE version:\s*([^\s,]+)/im)
  ]
  for (const candidate of javaCandidates) {
    if (!candidate) continue
    const major = parseJavaMajor(candidate)
    if (major > 0) {
      facts.javaMajor = major
      break
    }
  }
  facts.javaVendor =
    firstString(text, /^\s*Java (?:VM )?Vendor:\s*([^,\n]+)/im) ??
    firstString(text, /(OpenJDK|Temurin|Adoptium|Zulu|GraalVM|Corretto|Oracle|Microsoft|Azul|JetBrains)/i)
  const javaPathMatch = /([A-Za-z]:\\[^\s"']*?javaw?\.exe)|((?:\/[\w.\-]+)+\/bin\/java(?:w)?)/i.exec(text)
  if (javaPathMatch) facts.javaPath = javaPathMatch[1] ?? javaPathMatch[2]

  /* ---- 内存参数与内存统计 ---- */
  const memoryLine = /Memory:\s*([\d,]+)\s*bytes[^\n]*?\/\s*([\d,]+)\s*bytes/i.exec(text)
  if (memoryLine) {
    const used = Number.parseFloat(memoryLine[1].replace(/[,_]/g, ''))
    const max = Number.parseFloat(memoryLine[2].replace(/[,_]/g, ''))
    if (Number.isFinite(max) && max > 0) facts.maxHeapMB = Math.round(max / (1024 * 1024))
    if (Number.isFinite(used) && used > 0) facts.heapUsedMB = Math.round(used / (1024 * 1024))
  }
  const jvmFlags: string[] = []
  for (const m of text.matchAll(/(?:^|\s)(-X[a-zA-Z]+[\w.=:+\-/%]*|-D[\w.]+(?:=[^\s"']*)?)/g)) {
    if (!jvmFlags.includes(m[1])) jvmFlags.push(m[1])
  }
  if (jvmFlags.length > 0) facts.jvmFlags = jvmFlags.slice(0, 40)
  if (facts.maxHeapMB === undefined) {
    const m = /-Xmx([\w.]+)/.exec(text)
    if (m) {
      const mb = parseHeapFlag(m[1])
      if (mb) facts.maxHeapMB = mb
    }
  }
  if (facts.maxHeapMB === undefined) {
    const m = /^\s*Maximum Heap Size:\s*([\d,]+)\s*(?:bytes|MB)/im.exec(text)
    if (m) {
      const raw = Number.parseFloat(m[1].replace(/[,_]/g, ''))
      if (Number.isFinite(raw) && raw > 0) facts.maxHeapMB = raw > 1_000_000 ? Math.round(raw / (1024 * 1024)) : Math.round(raw)
    }
  }
  const phys =
    firstNumber(text, /Physical Memory:\s*Total:\s*([\d,]+)\s*MB/i) ??
    firstNumber(text, /physical\s+([\d,]+)k\(/i) ??
    firstNumber(text, /^\s*Memory:\s*([\d,]+)\s*MB\s*total/im)
  if (phys !== undefined) {
    const isKilobytes = /physical\s+[\d,]+k\(/i.test(text)
    facts.physicalMemoryMB = isKilobytes ? Math.round(phys / 1024) : Math.round(phys)
  }

  /* ---- 操作系统 / 架构 ---- */
  const osLine = /Operating System:\s*(.+?)\s*(?:\(([\w]+)\))?\s*version\s*([\d.]+)/i.exec(text)
  if (osLine) {
    facts.osName = osLine[1].trim()
    if (osLine[2]) facts.osArch = osLine[2].trim()
  } else {
    const osShort = /^\s*OS:\s*([^\n]+)$/im.exec(text)
    if (osShort) {
      const raw = osShort[1].trim()
      facts.osName = raw.split(/[,，]/)[0].trim()
      const archMatch = /\b(amd64|x86_64|x86|aarch64|arm64|i386|32 bit|64 bit)\b/i.exec(raw)
      if (archMatch) facts.osArch = archMatch[1]
    }
  }
  if (!facts.osArch) {
    const m = /os\.arch\s*[:=]\s*([\w]+)/i.exec(text)
    if (m) facts.osArch = m[1]
  }

  /* ---- 图形驱动 ---- */
  const driver = detectGraphicsDriver(text)
  if (driver) {
    facts.graphicsDriver = { name: driver.name, vendor: driver.vendor, file: driver.file }
    facts.gpuVendors = [driver.vendor]
  } else {
    const vendor = firstString(text, /(?:GL_VENDOR|OpenGL Vendor)\s*[:=]\s*([^\n]+)/i)
    if (vendor) facts.gpuVendors = [vendor.trim()]
  }

  /* ---- mod 数量与列表 ---- */
  const modCount =
    firstNumber(text, /Loading\s+(\d+)\s+mods/i) ??
    firstNumber(text, /(?:successfully )?loaded\s+(\d+)\s+mods/i) ??
    firstNumber(text, /Found\s+(\d+)\s+mods/i)
  if (modCount !== undefined) facts.modCount = modCount
  const modList = parseModListSection(text)
  if (modList.length > 0) {
    facts.mods = modList
    if (facts.modCount === undefined) facts.modCount = modList.length
  }

  /* ---- 退出码 ---- */
  const exitCode =
    firstNumber(text, /Exit Code:\s*(-?\d+)/i) ??
    firstNumber(text, /(?:游戏进程退出，?退出码[:：]?\s*)(-?\d+)/) ??
    firstNumber(text, /process exited with code\s*(-?\d+)/i) ??
    firstNumber(text, /exit code[:\s]+(-?\d+)/i)
  if (exitCode !== undefined) facts.exitCode = exitCode

  /* ---- 崩溃报告字段 ---- */
  const looksLikeCrashReport = /-- System Details --|^Description:\s/m.test(text)
  if (looksLikeCrashReport) {
    const parsed = parseCrashReportFields(text)
    if (Object.keys(parsed).length > 0) facts.crashReport = parsed
    if (facts.exitCode === undefined && parsed.exitCode !== undefined) facts.exitCode = parsed.exitCode
  } else {
    // 只有 Exit Code / Problematic frame 之类单行信息时也保留
    const partial = parseCrashReportFields(text)
    if (Object.keys(partial).length > 0) facts.crashReport = { ...facts.crashReport, ...partial }
  }

  /* ---- 调用方提供的事实优先（它们是运行环境里读出来的，比文本抽取更可信） ---- */
  if (opts.facts) {
    for (const [key, value] of Object.entries(opts.facts)) {
      if (value === undefined) continue
      ;(facts as Record<string, unknown>)[key] = value
    }
  }
  return facts
}

function firstString(text: string, re: RegExp): string | undefined {
  const m = re.exec(text)
  const value = m?.[1]?.trim()
  return value && value.length > 0 ? value : undefined
}

/**
 * 解析 Forge / NeoForge 崩溃报告里的 `Mod List:` 段（制表符分隔的管道表格）。
 * 行形如：`sodium-fabric-0.5.8.jar |Sodium |sodium |0.5.8 |NONE |COMMON_SET|Manifest: NOSIGNATURE`
 * 也从 Fabric 的启动日志（`Loading 100 mods:`）里提取名称。
 */
export function parseModListSection(text: string): NonNullable<DiagnoseFacts['mods']> {
  const lines = text.split(/\r?\n/)
  const out: NonNullable<DiagnoseFacts['mods']> = []
  let inList = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^(?:--\s*MOD LIST\s*--|Mod List:)\s*$/i.test(trimmed)) {
      inList = true
      continue
    }
    if (!inList) continue
    if (trimmed.length === 0) continue
    if (/^--/.test(trimmed) || /^(?:Stacktrace|Description|Details):/i.test(trimmed)) {
      inList = false
      continue
    }
    const parts = trimmed.replace(/^\t+/, '').split('|').map((s) => s.trim())
    if (parts.length >= 3 && /\.jar$/i.test(parts[0])) {
      out.push({ fileName: parts[0], id: parts[2] || undefined, version: parts[3] || undefined })
      if (out.length >= 2000) break
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 *  规则内部使用的提取器
 * ------------------------------------------------------------------ */

const MISSING_DEP_STOP_IDS = /^(minecraft|forge|neoforge|fabricloader|fabric-loader|quilt_loader|java|fabric|quilt|mcp|modlauncher|mixinextras)$/i

/** 从「缺失前置」报错里提取缺失的 modid 列表（Forge / Fabric 两种格式） */
export function extractMissingDependencyIds(text: string): string[] {
  const ids = new Set<string>()
  // Forge: Mod ID: 'patchouli', Requested by: 'xxx', Expected range: '[1.20.1-1.0,)', Actual version: '[MISSING]'
  for (const m of text.matchAll(/Mod ID:\s*'([^']+)'/gi)) ids.add(m[1].trim())
  // Fabric: Mod 'X' (xxx) 1.0.0 requires version 1.2.0 or later of mod 'yyy' (yyy), which is missing!
  for (const m of text.matchAll(
    /mod '([^']+)' \(([^)]+)\)[^\n]{0,120}?(?:which is missing|is missing|not (?:found|loaded|present))/gi
  )) {
    ids.add((m[2] ?? m[1]).trim())
  }
  // Fabric: requires any version of mod 'yyy' (yyy)
  for (const m of text.matchAll(/requires (?:any version of|version [^\s,]+ (?:or later|or above))[^\n]{0,20}?mod '([^']+)' \(([^)]+)\)/gi)) {
    ids.add((m[2] ?? m[1]).trim())
  }
  // Forge 老格式：Mod xxx requires yyy 1.0 or above
  for (const m of text.matchAll(/Mod ([A-Za-z0-9_.\-]+) requires ([A-Za-z0-9_.\-]+)/g)) ids.add(m[2].trim())
  return [...ids].filter((id) => id.length > 0 && !MISSING_DEP_STOP_IDS.test(id))
}

/** 跳过 jdk / 原版 / 常见第三方库的包名，用于判断异常是不是模组引起的 */
function isVanillaOrLibraryPackage(name: string): boolean {
  return /^(?:net\.minecraft|com\.mojang|java|javax|jdk|sun|org\.lwjgl|org\.apache|com\.google|io\.netty|it\.unimi|org\.slf4j|org\.objectweb|org\.joml|org\.spongepowered\.asm|org\.spongepowered\.mixin|org\.jetbrains|kotlin|org\.joml)/i.test(
    name
  )
}

/** 提取第一个「模组包名」（用于 NoSuchMethodError / ClassCastException 归因） */
export function extractSuspectPackage(text: string): string | undefined {
  const candidates: string[] = []
  for (const m of text.matchAll(/[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}(?:[.\w$]+)?/g)) {
    candidates.push(m[0])
    if (candidates.length > 400) break
  }
  for (const candidate of candidates) {
    if (!isVanillaOrLibraryPackage(candidate)) return candidate
  }
  return undefined
}

/** 提取实体/方块坐标（服务端 Ticking entity 崩溃的黄金线索） */
export function extractTickingLocation(text: string): string | undefined {
  const m =
    /Ticking (?:entity|block entity):\s*(.+)$/im.exec(text) ??
    /Ticking (?:entity|block entity) at ([^\n]+)/i.exec(text) ??
    /block_entity at ([^\n]+)/i.exec(text)
  if (!m) return undefined
  return m[1].trim().slice(0, 240)
}

const JAVA_PRIMITIVES = new Set([
  'void',
  'int',
  'long',
  'double',
  'float',
  'short',
  'byte',
  'char',
  'boolean',
  'var'
])

/**
 * 从 NoSuchMethodError / NoClassDefFoundError 等消息里提取「出问题的类」。
 * 反直觉点：Forge 生产环境的报错是 `'void net.minecraft.class_310.method_1551()'`，
 * 里第一个标识符链其实是返回类型 + 类 + 方法，必须去掉方法名。
 */
export function extractMissingClassRef(text: string): string | undefined {
  const payloadRe =
    /(?:NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|AbstractMethodError|VerifyError|IncompatibleClassChangeError):\s*([^\n]{0,240})/i
  const payload = payloadRe.exec(text)?.[1]
  if (payload) {
    // 形如 a.b.C.method 的标识符链：第一个不是 primitive 的就是 FQN，去掉最后一段（方法/字段）
    for (const m of payload.matchAll(/\b([a-z][\w$]*(?:\.[\w$]+){2,})/gi)) {
      const chain = m[1]
      if (JAVA_PRIMITIVES.has(chain.split('.')[0].toLowerCase())) continue
      const dot = chain.lastIndexOf('.')
      return dot > 0 ? chain.slice(0, dot) : chain
    }
    // 形如 org/lwjgl/opengl/GL11 的斜杠形式
    const slashed = /\b([a-z][\w$]*(?:\/[\w$]+){2,})\b/i.exec(payload)
    if (slashed) return slashed[1].replace(/\//g, '.')
    // 兜底：'<init>' / 'method_1551()' 之类没有包名，返回原始消息片段
    return payload.trim().slice(0, 120)
  }
  return /Could not initialize class\s+([\w.$]+)/i.exec(text)?.[1]
}

/* ------------------------------------------------------------------ *
 *  规则库（37 条，覆盖 28 类必测场景）
 * ------------------------------------------------------------------ */

/** 这些步骤会被 refine 复用（refine 内不能再引用 DIAGNOSE_RULES，避免初始化顺序问题） */
const STEPS_OOM_HEAP = [
  '在实例设置 → JVM 参数里提高 -Xmx：按物理内存的 50%~70% 取值（8G 内存 → 4G，16G → 8G，32G → 8G~12G 足够），不要超过物理内存的 70%。',
  '确认 Java 位数：日志出现 `32-Bit Server VM` 说明是 32 位 Java，堆上限只有约 1.5G，必须换成 64 位 Java（推荐 Temurin 17/21）。',
  '同时设置 `-XX:+UseG1GC` 缓解大堆的 GC 停顿；`-Xms` 不要大于物理内存。',
  '临时移出高清资源包（64x 以上）与光影，或调低渲染距离，再启动验证内存是否够用。',
  '加 `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=崩溃转储目录` 抓堆转储，用 VisualVM/MAT 找出占用内存最大的模组。'
]

const STEPS_UNSUPPORTED_CLASS = [
  '按日志里的 major version 换 Java：52=Java 8、55=11、61=17、65=21、66=22、67=23。',
  '在 MCAL 设置 → Java 里安装并选中对应大版本的 64 位 JDK（Temurin/Zulu 均可），或手动指定 java.exe 路径。',
  'MC 与 Java 对照：1.20.5+/1.21+ 必须 Java 21；1.18~1.20.4 用 Java 17；1.16.5 用 Java 8 或 11。',
  '若只有某个模组报此错，说明它用高版本编译：换成与该 MC 版本匹配的模组构建，而不是升级整个 Java。',
  '检查 PATH/JAVA_HOME 是否被其他 Java 抢占（`java -version` 与 MCAL 里选中的可能不是同一个）。'
]

const STEPS_ACCESS_VIOLATION = [
  '更新显卡驱动到最新正式版（NVIDIA/AMD/Intel 官网）；若刚更新过驱动，回退到上一个 WHQL/稳定版本（新驱动常引入回退 bug）。',
  '笔记本双显卡：在 NVIDIA 控制面板 → 管理 3D 设置 → 程序设置里，为 javaw.exe/java.exe 指定「高性能 NVIDIA 处理器」，避免跑在核显上。',
  '打开 hs_err_pid 文件，看 `# Problematic frame` 与 `# C [xxx.dll+offset]`：dll 名就是嫌疑库（显卡 dll → 驱动问题；lwjgl → 换 LWJGL 相关设置）。',
  '移出光影/高清材质包并调低画质再试一次：显存不足也会以 0xC0000005 表现。',
  '检查冲突组合：OptiFine 与 Iris/Oculus 不能共存；Sodium 与 OptiFine 也不兼容（Forge 上应改用 Embeddium/Rubidium）。',
  '以上都无效时用二分法禁用一半 mods，逐步缩小到具体模组（把 hs_err 与崩溃栈一起反馈给作者）。'
]

const STEPS_MISSING_DEPENDENCY = [
  '按日志列出的 modid 逐个补装前置：在 MCAL「整合包/模组搜索」里搜索该 id，选择与当前 MC 版本、加载器一致的版本安装到 `mods/`。',
  '注意日志里的版本范围（`Expected range: [1.20.1-1.0,)`），装错版本的模组一样会被判为不满足依赖。',
  '最常见的前置：Fabric 系 → Fabric API / Cloth Config / Architectury / Fabric Language Kotlin；Forge 系 → Curse Maven 依赖 / GeckoLib / Patchouli / JEI。',
  '补装后重启；如果仍报别的 mod 缺失，重复步骤 1（依赖经常是链式的）。',
  '找不到对应模组时，检查是否加载器装错了（Fabric 模组装进 Forge 实例）或 MC 版本不匹配。',
  '用 `mods/` 里的文件逐一比对日志中 `Requested by:` 的模组，确认需求方与提供方版本对应。'
]

const STEPS_INVALID_MOD_FILE = [
  '从报错里找到具体文件名，把它从 `mods/` 移出（先移到桌面备份），再启动验证。',
  '确认该 jar 是为当前加载器构建的：Forge 需要 `META-INF/mods.toml`，Fabric 需要 `fabric.mod.json`（Fabric 模组放进 Forge 实例就是本错误）。',
  '确认 jar 下载完整：文件大小是否与下载页一致；用压缩软件能否正常打开（打不开就是坏包，重新下载）。',
  '清理 mods 目录里的非 jar 文件（.zip/.txt/.part/.htm 等，浏览器下载失败会留下 htm 页面）。',
  '用 MCAL 内容页的校验/重装功能重新下载报错文件，或按整合包清单重新导入。'
]

const STEPS_SERVER_TICKING = [
  "读崩溃栈：`Ticking entity: xxx['名称'/坐标]` 或 `Ticking block entity: xxx @ (x, y, z)` 给出的类名就是元凶模组注册的类型。",
  '按坐标处理实体：先备份世界，再用 `/kill @e[type=<实体id>]` 或删除对应区块的实体（NBTExplorer / Amulet 编辑 `region` 文件）。',
  '把该模组升级到最新版；若是整合包自带内容，向包作者反馈（附完整栈与实体 NBT）。',
  '临时规避：卸载该模组会丢失相关方块/实体数据，操作前务必完整备份 `world/` 目录。',
  '如果是 Watchdog 超时（tick 超过 60 秒）而非异常：检查是否有性能模组/机器自动化死循环，或用 Spark 采样定位。',
  '确认服务端加载器与 mods 版本一致（客户端能跑不代表服务端 mods 完整）。'
]

export const DIAGNOSE_RULES: DiagnoseRule[] = [
  /* ---------------- 1. 内存 ---------------- */
  {
    id: 'oom-heap',
    title: 'Java 堆内存不足（OutOfMemoryError: Java heap space）',
    category: 'memory',
    severity: 'error',
    patterns: [
      { re: /java\.lang\.OutOfMemoryError:\s*Java heap space/i, required: true, weight: 3 },
      { re: /OutOfMemoryError[^\n]{0,60}heap/i, weight: 2 },
      { re: /-Xmx/i, weight: 1 }
    ],
    confidence: 0.85,
    dedupeKey: 'memory:heap',
    knowledgeIds: ['crash-out-of-memory', 'java-memory-flags', 'misc-common-myths'],
    detail: 'JVM 的堆内存被耗尽，通常是 -Xmx 设置过小，或存在内存膨胀/泄漏的模组与高清资源包。',
    steps: STEPS_OOM_HEAP,
    refine: (ctx) => {
      const phys = ctx.facts.physicalMemoryMB
      const is32 = /32-Bit Server VM|32 位|32-bit/i.test(ctx.text)
      const current = ctx.facts.maxHeapMB
      const recommended = recommendedMaxHeapMB(phys ?? 0, { is32Bit: is32, javaMajor: ctx.facts.javaMajor })
      const pieces: string[] = ['堆内存耗尽（Java heap space），不是物理内存不足。']
      if (current) pieces.push(`当前 -Xmx 约 ${current} MB。`)
      if (phys) pieces.push(`检测到物理内存约 ${phys} MB，按 50%~70% 计算建议 -Xmx 设为 ${recommended} MB（约 ${Math.round((recommended / 1024) * 10) / 10} G）。`)
      else pieces.push(`不知道物理内存时，先按「物理内存的 50%~70%」设置 -Xmx（16G 机器取 8G~11G），且不超过 12288 MB。`)
      if (is32) pieces.push('当前 Java 是 32 位，堆上限约 1.5G，仅调参无法解决，必须换 64 位 Java。')
      const steps = [...STEPS_OOM_HEAP]
      if (current && phys && current >= Math.floor(phys * 0.9)) {
        steps.unshift(
          `当前 -Xmx=${current} MB 已接近物理内存上限，JVM 可能因交换（swap）而更慢；先把 -Xmx 降到 ${recommended} MB 再测。`
        )
      }
      return { detail: pieces.join(' '), steps, confidence: phys ? 0.9 : 0.8 }
    }
  },
  {
    id: 'oom-metaspace',
    title: '元空间不足（OutOfMemoryError: Metaspace）',
    category: 'memory',
    severity: 'error',
    patterns: [
      { re: /OutOfMemoryError:\s*Metaspace/i, required: true, weight: 3 },
      { re: /MaxMetaspaceSize|MaxPermSize/i, weight: 1 }
    ],
    confidence: 0.85,
    dedupeKey: 'memory:metaspace',
    knowledgeIds: ['crash-out-of-memory', 'java-memory-flags'],
    detail: 'Java 8+ 的类元数据区（Metaspace）被耗尽，通常意味着加载了过多模组，或有模组在运行期反复动态生成类。',
    steps: [
      '在 JVM 参数里显式加 `-XX:MaxMetaspaceSize=512m`（模组很多时可给 1g），默认虽然不限，但容器/旧版本可能被限制。',
      'Java 8 上等价问题是永久代：改用 `-XX:MaxMetaspaceSize` 而不是已废弃的 `-XX:MaxPermSize`。',
      '减少模组数量：Metaspace 爆炸常见于装了几百个模组的整合包，或用脚本/动态编译（如 KubeJS、脚本引擎）的模组反复生成类。',
      '确认没有把 `classes/` 目录热加载类文件当资产（有些启动器会），并检查是否有模组在循环中 new ClassLoader。',
      '把堆（-Xmx）也一起提高一点：Metaspace 与堆同时吃紧时，先保证堆不 OOM。'
    ]
  },
  {
    id: 'oom-gc-overhead',
    title: 'GC 开销超限（GC overhead limit exceeded）',
    category: 'memory',
    severity: 'error',
    patterns: [
      { re: /OutOfMemoryError:\s*GC overhead limit exceeded/i, required: true, weight: 3 },
      { re: /GC overhead limit exceeded/i, weight: 2 }
    ],
    confidence: 0.85,
    dedupeKey: 'memory:gc',
    knowledgeIds: ['crash-out-of-memory', 'java-memory-flags', 'misc-common-myths'],
    detail: 'JVM 把 98% 以上的时间花在 GC 却只回收出很少内存，说明堆几乎被长期存活对象占满（典型的泄漏特征）。',
    steps: [
      '先提高 -Xmx 到物理内存的 50%~70% 争取可运行空间，然后立刻查泄漏：单纯加内存通常只能拖延崩溃时间。',
      '切换/确认 GC：Java 9+ 默认 G1，Java 8 建议加 `-XX:+UseG1GC`；不要用 `-XX:+DisableExplicitGC` 之外的怪参数。',
      '抓堆转储（`-XX:+HeapDumpOnOutOfMemoryError`）后用 VisualVM / Eclipse MAT 看支配树，找出持续增长的 mod 对象。',
      '逐一禁用「最近新增」的模组（尤其是缓存区块/实体、记录日志、生成图片的模组），用二分法定位。',
      '检查是否把内存参数写得比物理内存还大：`-Xmx16G` 装在 8G 机器上会导致系统级交换，表现更糟。'
    ]
  },
  {
    id: 'oom-direct-buffer',
    title: '直接内存/显存相关内存不足（Direct buffer memory）',
    category: 'memory',
    severity: 'error',
    patterns: [{ re: /OutOfMemoryError:\s*Direct buffer memory/i, required: true, weight: 3 }],
    confidence: 0.8,
    dedupeKey: 'memory:direct',
    knowledgeIds: ['crash-out-of-memory', 'graphics-shader-basics', 'resourcepack-hd-vram'],
    detail: 'NIO 直接内存耗尽（LWJGL/OpenGL 缓冲走的就是直接内存），常见的诱因是高清材质与光影把显存/直接内存吃满。',
    steps: [
      '移出 128x/256x 高清材质与光影包后重试，确认是不是显存/直接内存被压满。',
      '显式提高上限：加 `-XX:MaxDirectMemorySize=2g`（与 -Xmx 分开计算，总量别超过物理内存）。',
      '调低渲染距离、模拟距离与粒子效果；关闭「性能优化」类模组里激进的内存缓存选项。',
      '更新显卡驱动：驱动泄漏显存也会表现为 Direct buffer OOM。',
      '如果只在长时间运行后出现，按内存泄漏排查（堆转储 + VisualVM）。'
    ]
  },
  {
    id: 'oom-native-thread',
    title: '无法创建线程（unable to create native thread）',
    category: 'memory',
    severity: 'error',
    patterns: [{ re: /OutOfMemoryError:\s*(?:unable to create (?:native|new) thread|native memory)/i, required: true, weight: 3 }],
    confidence: 0.8,
    dedupeKey: 'memory:thread',
    knowledgeIds: ['crash-out-of-memory', 'java-memory-flags'],
    detail: '线程数或原生内存达到上限：常见于模组泄漏线程（每个区块/每个玩家一个线程），或系统句柄被安全软件占满。',
    steps: [
      '确认模组列表里没有「异步/多线程优化」类模组反复创建线程（尤其是自定义线程池没有复用的）。',
      'Windows 上每个线程约占 1MB 栈：给 JVM 加 `-Xss1m` 并减少并发参数（部分模组的配置里有线程数上限）。',
      '用 `jstack <pid>` 或任务管理器看线程数（超过 2000~3000 就异常），定位是谁创建的。',
      '临时关闭安全软件的进程注入/自保护（某些杀软会为每个线程保留句柄），重启后再试。',
      '32 位 JVM 的地址空间有限，换 64 位 Java 往往直接解决。'
    ]
  },

  /* ---------------- 2. Java / class 版本 ---------------- */
  {
    id: 'unsupported-class-version',
    title: 'Java 版本过低（UnsupportedClassVersionError）',
    category: 'java',
    severity: 'error',
    patterns: [
      { re: /UnsupportedClassVersionError/i, required: true, weight: 3 },
      { re: /class file (?:major )?version\s*(\d+)/i, weight: 2 },
      { re: /has been compiled by a more recent version of the Java Runtime/i, weight: 1 },
      { re: /only recognizes class file versions up to\s*(\d+(?:\.\d+)?)/i, weight: 2 }
    ],
    confidence: 0.9,
    knowledgeIds: ['java-unsupported-class-version', 'java-version-matrix', 'java-multiple-installs'],
    detail: '有 class 文件是用更高版本的 Java 编译的，当前 JVM 读不了。需要把实例 Java 换成足够新的版本。',
    steps: STEPS_UNSUPPORTED_CLASS,
    refine: (ctx) => {
      const versionMatch = /class file (?:major )?version\s*(\d+)/i.exec(ctx.text)
      const upTo = /only recognizes class file versions up to\s*(\d+)(?:\.\d+)?/i.exec(ctx.text)
      const requiredMajor = versionMatch ? Number.parseInt(versionMatch[1], 10) : undefined
      const neededJava = requiredMajor ? javaVersionForClassFileMajor(requiredMajor) : undefined
      const currentJava = upTo ? javaVersionForClassFileMajor(Number.parseInt(upTo[1], 10)) : ctx.facts.javaMajor
      const pieces = [
        requiredMajor ? `报错的 class 文件版本为 ${requiredMajor}（对应 Java ${neededJava ?? '?'}）。` : '检测到 UnsupportedClassVersionError。',
        currentJava ? `当前实例运行的 Java 大版本是 ${currentJava}。` : ''
      ].filter(Boolean)
      const title = neededJava ? `需要 Java ${neededJava}（class file major version ${requiredMajor}）` : undefined
      const steps = [...STEPS_UNSUPPORTED_CLASS]
      if (neededJava && neededJava > 8) {
        steps[1] = `在 MCAL 设置 → Java 里安装并选中 Java ${neededJava}（64 位），然后重启实例；当前 Java ${currentJava ?? '?'} 无法加载该 class。`
      }
      return { title, detail: pieces.join(' '), steps, confidence: requiredMajor ? 0.95 : 0.85 }
    }
  },
  {
    id: 'inaccessible-object',
    title: '模块系统反射受限（InaccessibleObjectException）',
    category: 'java',
    severity: 'error',
    patterns: [
      { re: /InaccessibleObjectException/i, required: true, weight: 3 },
      { re: /unable to make .* accessible|module java\.base does not ["“]opens/i, weight: 2 }
    ],
    confidence: 0.75,
    knowledgeIds: ['java-version-matrix', 'java-multiple-installs', 'launcher-args'],
    detail: '老模组用反射访问 JDK 内部类，在 Java 9+ 的模块系统下被拒绝（典型是 Java 16 开始强封装）。',
    steps: [
      '优先换回该 MC 版本推荐的 Java（1.16.5 及以下用 Java 8，1.17/1.18 用 Java 17 的模组已适配）。',
      '必须用新 Java 时，在实例 JVM 参数里加：`--add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang.reflect=ALL-UNNAMED`。',
      '看一下报错里 `unable to make X accessible` 的类，若属于某个 mod，优先升级该 mod。',
      '确认不是同时装了同一 mod 的 Java 8 与 Java 17 版本（文件重复会出现各种诡异反射错误）。'
    ]
  },

  /* ---------------- 3. 原生崩溃 / 显卡驱动 ---------------- */
  {
    id: 'native-access-violation',
    title: '原生层访问冲突（EXCEPTION_ACCESS_VIOLATION）',
    category: 'graphics',
    severity: 'fatal',
    patterns: [
      { re: /EXCEPTION_ACCESS_VIOLATION/i, required: true, weight: 3 },
      { re: /#\s*Problematic frame/i, weight: 2 },
      {
        re: /(atio6axx|atig6txx|amdxx64|amdxx32|amdvlk|nvoglv64|nvoglv32|nvldumdx|nvcuda|igd\w+\.dll|ig9icd64|opengl32\.dll|lwjgl\w*\.dll)/i,
        weight: 2
      },
      { re: /hs_err_pid/i, weight: 1 }
    ],
    confidence: 0.75,
    knowledgeIds: ['crash-access-violation-driver', 'graphics-gpu-selection', 'crash-fatal-error-hs-err'],
    detail: 'JVM 在原生代码里访问了非法内存。最常见的原因是显卡驱动崩溃，但也可能是显存不足、OptiFine 与 Iris 共存、粒子/实体过多或某个模组的原生库。',
    steps: STEPS_ACCESS_VIOLATION,
    refine: (ctx) => {
      const driver = detectGraphicsDriver(ctx.text)
      const frame = ctx.facts.crashReport?.problematicFrame ?? /Problematic frame:\s*(?:#\s*)?C?\s*\[?([^\n]+?)\]?\s*$/im.exec(ctx.text)?.[1]
      const pieces = ['检测到原生访问冲突（EXCEPTION_ACCESS_VIOLATION），通常是显卡驱动或原生库崩溃。']
      if (driver) pieces.push(`命中原生库：${driver.file}（${driver.name}，厂商 ${driver.vendor}）。`)
      if (frame) pieces.push(`Problematic frame: ${frame.trim()}。`)
      pieces.push('注意：它只是「崩在原生层」，不代表唯一原因是驱动 —— OptiFine/Iris 冲突、显存不足、更多粒子/实体也会触发。')
      const steps = [...STEPS_ACCESS_VIOLATION]
      if (driver && (driver.vendor === 'NVIDIA' || driver.vendor === 'AMD' || driver.vendor === 'Intel')) {
        steps.unshift(`优先处理 ${driver.name}：清理旧驱动后安装最新版（或回退到上一个稳定版），并确认游戏跑在独显上。`)
      }
      return { detail: pieces.join(' '), steps, files: [], confidence: driver ? 0.85 : 0.75 }
    }
  },
  {
    id: 'jvm-fatal-error',
    title: 'JVM 发生致命错误（A fatal error has been detected）',
    category: 'java',
    severity: 'fatal',
    patterns: [
      { re: /A fatal error has been detected by the Java Runtime Environment/i, required: true, weight: 3 },
      { re: /hs_err_pid/i, weight: 1 },
      { re: /#\s*Problematic frame/i, weight: 1 }
    ],
    confidence: 0.85,
    knowledgeIds: ['crash-fatal-error-hs-err', 'crash-exit-codes', 'crash-access-violation-driver'],
    detail: 'JVM 自身崩溃并生成了 hs_err_pid*.log，里面记录了完整原因（比游戏日志有用得多）。',
    steps: [
      '在游戏目录、游戏目录/logs/、%TEMP% 找 `hs_err_pid<pid>.log`（按修改时间取最新），用记事本打开。',
      '看 `/^#/` 开头的前 10 行：`EXCEPTION_ACCESS_VIOLATION` → 显卡驱动/原生库；`insufficient memory` → 内存参数超物理内存；`SIGSEGV/SIGABRT` → 原生崩溃。',
      '看 `# Problematic frame`：`C  [xxx.dll+0x...]` 里的 dll 名就是问题库；出现 nvoglv64/atio6axx/amdxx64/igd*.dll → 更新或回退显卡驱动。',
      '看 `# JRE version` 与 `# Command Line`：确认实际用的是哪个 Java、堆参数是否写错（-Xmx 超过物理内存会直接崩）。',
      '看 `Out of Memory Error` 段与 `# Memory:` 行，判断是否内存问题；是则按内存不足规则处理。',
      '把 hs_err 文件传给 MCAL 诊断（`logAnalyze` 支持直接分析该文件），或连同崩溃栈发给 mod 作者/驱动厂商。'
    ],
    refine: (ctx) => {
      const hs = parseHsErrFields(ctx.text)
      const pieces = ['JVM 原生层崩溃（hs_err_pid 日志已生成）。']
      if (hs.reason) pieces.push(`原因：${hs.reason}。`)
      if (hs.problematicFrame) pieces.push(`Problematic frame: ${hs.problematicFrame}。`)
      if (hs.jreVersion) pieces.push(`JRE version: ${hs.jreVersion}。`)
      if (hs.outOfMemory) pieces.push('日志里同时出现内存分配失败，优先按内存参数过大排查。')
      return { detail: pieces.join(' '), confidence: hs.reason ? 0.9 : 0.85 }
    }
  },
  {
    id: 'exit-code-1073741819',
    title: '退出码 -1073741819（0xC0000005 访问冲突）',
    category: 'graphics',
    severity: 'error',
    patterns: [
      { re: /Exit Code:\s*-1073741819/i, required: true, weight: 3 },
      { re: /0xC0000005|STATUS_ACCESS_VIOLATION/i, weight: 2 },
      { re: /hs_err_pid/i, weight: 1 }
    ],
    confidence: 0.6,
    knowledgeIds: ['crash-exit-codes', 'crash-access-violation-driver', 'crash-read-crash-report'],
    detail: '0xC0000005 只说明「进程因访问冲突而死」，最常由显卡驱动引起，但绝不是唯一原因：也可能是 mod 的原生库、内存参数过大、驱动回退等。',
    steps: [
      '先找证据：游戏目录与 logs/ 的 `hs_err_pid*.log`、`crash-reports/` 最新报告。没有报告的退出码意义有限。',
      '有 hs_err_pid：看 `# Problematic frame`（显卡 dll → 驱动问题：更新/回退驱动、双显卡指定独显）。',
      '有 crash-report：按 `Description` 与 `Suspected Mods` 走对应排查（模组冲突 / 资源包 / 世界数据）。',
      '两份都没有：检查 -Xmx 是否超过物理内存（常见于抄了别人 16G 的参数），以及是否有 OptiFine+Iris、Sodium+OptiFine 等冲突组合。',
      '问题可复现时用二分法禁用 mods 定位，并保留最后 200 行日志用于分析。',
      '如果是笔记本双显卡，先在 NVIDIA/AMD 控制面板把 java.exe 指定为独显再试。'
    ],
    refine: (ctx) => {
      const driver = detectGraphicsDriver(ctx.text)
      const pieces = ['退出码 -1073741819 等价于 0xC0000005（STATUS_ACCESS_VIOLATION）。它只说明进程在原生层崩溃，不能据此断定是显卡驱动。']
      if (driver) pieces.push(`日志里出现 ${driver.file}（${driver.name}），驱动是第一嫌疑。`)
      if (ctx.facts.crashReport?.problematicFrame) pieces.push(`Problematic frame: ${ctx.facts.crashReport.problematicFrame}。`)
      return { detail: pieces.join(' '), confidence: driver ? 0.75 : 0.55 }
    }
  },
  {
    id: 'exit-code-1-no-stack',
    title: '退出码 1（无堆栈，需要更多信息）',
    category: 'unknown',
    severity: 'warning',
    patterns: [
      { re: /Exit Code:\s*1(?:\s|$)/im, required: true, weight: 3 },
      { re: /exit code[:\s]+1\b/i, weight: 1 }
    ],
    excludes: [
      /A fatal error has been detected/i,
      /hs_err_pid/i,
      /Exception in thread/i,
      /Caused by:/i,
      /The game crashed whilst/i,
      /UnsupportedClassVersionError|NoClassDefFoundError|ClassNotFoundException/i,
      // 有堆栈就不是「无堆栈退出码 1」场景，交给对应规则处理
      /^\s*at\s+[\w$./<>[\]]+\s*\(/m
    ],
    confidence: 0.5,
    knowledgeIds: ['crash-exit-codes', 'launcher-launch-pipeline'],
    detail: '退出码 1 是「普通错误退出」，日志里没有堆栈就无法直接定位，需要先拿到更多输出。',
    steps: [
      '打开启动器的运行日志/控制台输出（MCAL 的实例日志页），重跑一次并保留最后 200 行：真正的报错通常在 `Exit Code: 1` 之前。',
      '检查 JVM 参数是否拼错（例如 `-Xmx` 写成 `-Xmx8192` 少了单位、复制了多余引号），参数错误会让 JVM 静默退出。',
      '确认 -Xmx 不超过物理内存：JVM 无法保留地址空间时会直接退出并返回 1。',
      '暂时关闭安全软件（360/火绒/Defender 的勒索防护）后重试，杀软拦截 javaw.exe 会得到同样的退出码。',
      '手动验证 Java：在终端执行 `java -version`，确认 MCAL 选中的 Java 可执行文件存在且可运行。',
      '以上都正常时，检查是否有自定义启动前脚本/自定义 mainClass（如 Forge 未安装完成却直接启动）。'
    ]
  },
  {
    id: 'exit-code-minus-one',
    title: '退出码 -1（进程被结束 / JVM 未启动）',
    category: 'java',
    severity: 'warning',
    patterns: [
      { re: /Exit Code:\s*-1(?:\s|$)/im, required: true, weight: 3 },
      { re: /exit code[:\s]+-1\b/i, weight: 1 }
    ],
    excludes: [/A fatal error has been detected/i, /hs_err_pid/i, /The game crashed whilst/i],
    confidence: 0.55,
    knowledgeIds: ['crash-exit-codes', 'java-install-verify', 'launcher-launch-pipeline'],
    detail: '退出码 -1 通常表示进程被外部结束（启动器 kill、系统关机），或 JVM 根本没起来（Java 路径错误、参数非法、主类不存在）。',
    steps: [
      '确认不是启动器/用户自己点了「结束进程」：MCAL 的运行中实例页可以看到是谁结束的。',
      '检查 Java 可执行文件路径：实例的 Java 设置指向的 java.exe/javaw.exe 是否还存在（Java 被卸载/移动会产生 -1）。',
      '检查自定义 JVM 参数与游戏参数是否有多余的引号、空格、未闭合的 `"`。',
      '确认版本安装完整：`versions/<id>/<id>.json` 与对应 jar 存在，Forge/Fabric 安装未半途中断（重装加载器）。',
      '查看启动器日志中 java 进程的完整命令行（进程列表里的 CommandLine），确认 mainClass 与 classpath 正常。'
    ]
  },

  /* ---------------- 4. Mixin / 模组冲突 ---------------- */
  {
    id: 'mixin-apply-failed',
    title: 'Mixin 注入失败',
    category: 'mod-conflict',
    severity: 'error',
    patterns: [
      {
        re: /Mixin apply failed|InvalidMixinException|MixinTransformerError|Cannot load mixin class|MixinApplyError|MixinConfigException|InjectionError|MixinTargetAlreadyLoaded/i,
        required: true,
        weight: 3
      },
      { re: /org\.spongepowered\.asm\.mixin/i, weight: 1 },
      { re: /\.mixins?\.json/i, weight: 1 }
    ],
    confidence: 0.8,
    knowledgeIds: ['crash-mixin-failed', 'mod-load-order', 'crash-mod-conflict'],
    detail: 'Mixin 在把代码注入目标类时失败：通常是两个模组改同一个类/方法、目标类被别的模组替换，或 Mixin 库版本被覆盖。',
    steps: [
      '阅读报错里的 `Mixin apply failed <模组>:<文件>.mixins.json:<Mixin类> -> <目标类>`，第一段就是注入方模组，第二段是被注入的原版/模组类。',
      '检查目标类是否被另一个模组修改：常见组合是 OptiFine+Sodium/Iris、两个"性能优化"模组同时改渲染管线。',
      '用二分法：先禁用最近新增的模组的一半，逐步缩小到冲突双方，再二选一或换版本。',
      '确认没有同时装 Fabric 与 Forge 的版本（把 Fabric 模组丢进 Forge 的 mods 目录）。',
      '升级所有相关模组到同一 MC 版本的最新版：Mixin 目标偏移在版本间经常变化。',
      '若是 `Cannot load mixin class`：检查该模组的 mixins.json 是否与实际类名一致（盗版/损坏 jar 会缺类，重新下载）。'
    ],
    refine: (ctx) => {
      const detailMatch =
        /Mixin apply failed\s+([^\s:]+)(?::([^\s]+))?[^\n]*?(?:->\s*([\w.$/]+))?/i.exec(ctx.text) ??
        /\[([\w.\-]+\.mixins\.json)[^\]]*\][^\n]*?->\s*([\w.$/]+)/i.exec(ctx.text)
      const pieces = ['Mixin 注入失败，属于模组之间的代码修改冲突（不是 Java/内存问题）。']
      if (detailMatch) pieces.push(`报错定位：${detailMatch[0].slice(0, 200)}。`)
      const suspect = extractSuspectPackage(ctx.text)
      if (suspect) pieces.push(`疑似模组包名：${suspect}。`)
      return { detail: pieces.join(' '), confidence: detailMatch ? 0.88 : 0.8 }
    }
  },
  {
    id: 'duplicate-mods',
    title: '检测到重复模组（Duplicate mods）',
    category: 'mod-conflict',
    severity: 'error',
    patterns: [
      { re: /Found duplicate mods?|Duplicate mods?(?: detected| found)|duplicate mod file/i, required: true, weight: 3 },
      { re: /A mod with the id\s*'?[\w.\-]+'?\s*is already loaded/i, weight: 2 }
    ],
    confidence: 0.85,
    knowledgeIds: ['crash-mod-conflict', 'mod-load-order'],
    detail: '同一个 modid 在 mods 目录里出现了多份（同一模组的两个版本，或不同文件名但内容/ID 相同），加载器无法决定用哪个。',
    steps: [
      '打开 `mods/` 目录，按修改时间排序，搜索报错里给出的 modid（例如 sodium 会有 sodium-fabric-0.5.8 与 sodium-fabric-0.5.11 两个文件）。',
      '只保留一个版本：优先保留与当前 MC 版本/加载器匹配的最新稳定版，其余移到桌面备份（不要直接删除）。',
      '注意 `.disabled` 后缀只是被启动器隐藏，某些加载器仍会读取；重复项要移出目录而不是改名。',
      'Modrinth/CurseForge 导入的整合包出现重复时，检查是否同时存在「官方下载文件」与「overrides 里打包的同一文件」。',
      '清空 `mods/` 后按清单重新安装一遍是最干净的修复方式（先用二分法确认不再报重复）。'
    ]
  },
  {
    id: 'linkage-classcast',
    title: '类转换/链接错误（模组冲突）',
    category: 'mod-conflict',
    severity: 'error',
    patterns: [
      { re: /java\.lang\.ClassCastException/i, weight: 3 },
      { re: /cannot be cast to class/i, weight: 2 },
      { re: /IllegalAccessError|LinkageError|IncompatibleClassChangeError|AbstractMethodError/i, weight: 2 }
    ],
    confidence: 0.6,
    knowledgeIds: ['crash-mod-conflict', 'crash-noclass-nosuchmethod', 'mod-load-order'],
    detail: '链接期错误（ClassCastException / IllegalAccessError / LinkageError）：两个模组对同一个类做了不兼容的修改，或 API 版本对不上。',
    steps: [
      '读栈里的类名：`class A cannot be cast to class B` 说明有模组假设了旧类型层次，通常是它依赖的另一个模组 API 变了。',
      '检查「性能优化/渲染重写」类模组是否混用：OptiFine + Sodium/Embeddium、Iris + OptiFine 等组合最容易报链接错误。',
      '把所有 Modrinth API 相关模组（Architectury API、Fabric API、所依赖的库）升级到同一日期发布的版本。',
      '用二分法禁用一半模组定位冲突方，然后把另一个换成兼容版本。',
      '确认没有模组被加载了两次（整合包 overrides 与官方下载文件重复）。'
    ],
    refine: (ctx) => {
      const cast = /cannot be cast to class\s+([\w.$]+)/i.exec(ctx.text)
      const first = /(?:java\.lang\.ClassCastException:\s*(?:class\s+)?([\w.$]+))/i.exec(ctx.text)
      const pieces = ['链接/类型错误通常由模组之间对同一类的不同修改引起。']
      if (first) pieces.push(`来源类：${first[1]}。`)
      if (cast) pieces.push(`目标类：${cast[1]}。`)
      const suspect = extractSuspectPackage(ctx.text)
      if (suspect) pieces.push(`疑似模组包名：${suspect}。`)
      return { detail: pieces.join(' '), confidence: cast || first ? 0.75 : 0.6 }
    }
  },

  /* ---------------- 5. 缺失依赖 / 版本不匹配 ---------------- */
  {
    id: 'missing-mandatory-dependency',
    title: '缺少必需的前置模组',
    category: 'mod-missing-dependency',
    severity: 'error',
    patterns: [
      { re: /Missing or unsupported mandatory dependencies/i, weight: 3 },
      { re: /requires any version of (?:mod\s*)?'?[\w.\-]+'?/i, weight: 2 },
      { re: /Mod\s+[\w.\-]+\s+requires\s+[\w.\-]+/i, weight: 2 },
      { re: /(?:mod|dependency|前置)[^\n]{0,80}?(?:which is missing|is not (?:installed|present|loaded))/i, weight: 2 },
      { re: /net\.fabricmc\.loader\.impl\.discovery\.ModResolutionException/i, weight: 3 },
      { re: /ModResolutionException|DependencyResolutionException/i, weight: 2 }
    ],
    confidence: 0.8,
    knowledgeIds: ['crash-missing-dependency', 'mod-common-dependencies', 'mod-fabric-mod-json'],
    detail: '某个模组声明了必需前置，但前置没有安装或版本不在允许范围内；加载器因此拒绝启动。',
    steps: STEPS_MISSING_DEPENDENCY,
    refine: (ctx) => {
      const ids = extractMissingDependencyIds(ctx.text)
      const installed = new Set((ctx.facts.mods ?? []).map((m) => (m.id ?? '').toLowerCase()).filter(Boolean))
      const trulyMissing = ids.filter((id) => !installed.has(id.toLowerCase()))
      const pieces = ['加载器检测到必需前置缺失或版本不满足。']
      if (ids.length > 0) pieces.push(`日志中提取到的依赖 ID：${ids.join('、')}。`)
      if (trulyMissing.length > 0 && installed.size > 0) {
        pieces.push(`与本地 mods 列表交叉比对后，确认缺失：${trulyMissing.join('、')}。`)
      }
      const steps = [...STEPS_MISSING_DEPENDENCY]
      if (ids.length > 0) {
        steps.unshift(
          `安装缺失前置：${ids
            .map((id) => `「${id}」`)
            .join('')}（在 Modrinth/CurseForge 搜索该 id，注意选 MC 版本与加载器都匹配的文件）。`
        )
      }
      return { detail: pieces.join(' '), steps, confidence: trulyMissing.length > 0 ? 0.9 : 0.8 }
    }
  },
  {
    id: 'incompatible-mod-set',
    title: '模组与游戏版本/加载器不匹配（Incompatible mod set）',
    category: 'mod-version-mismatch',
    severity: 'error',
    patterns: [
      { re: /Incompatible mod set!/i, weight: 3 },
      { re: /Detected an incompatible mod/i, weight: 3 },
      { re: /net\.fabricmc\.loader\.impl\.FormattedException/i, weight: 2 },
      { re: /mod resolution encountered an error/i, weight: 3 },
      { re: /Mod resolution failed|FormattedException/i, weight: 2 },
      { re: /requires (?:version )?[\w.\-+]+ of (?:mod )?'?minecraft'?/i, weight: 2 }
    ],
    confidence: 0.8,
    knowledgeIds: ['crash-mod-version-mismatch', 'loader-version-matrix', 'crash-missing-dependency'],
    detail: '加载器在解析模组集时发现版本约束无法满足（模组要求的 MC 版本或加载器版本与当前实例不符）。',
    steps: [
      '按日志里每一条 `- Mod ... requires ...` 处理：模组要求的版本 vs 当前实例版本，差在哪就改哪。',
      '确认三件事完全一致：MC 版本（1.20.1 ≠ 1.20.4）、加载器大版本（Forge 47.x 对应 1.20.1）、模组构建（fabric/forge 不能混用）。',
      '换用匹配的模组构建：在同一下载页选择对应 MC 版本的 file，而不是最新版。',
      '如果是整合包自带的模组集报错，通常是整合包与实例版本填错，按包作者说明的版本创建实例。',
      '升级了 MC 版本后出现此错：要么把全部模组一起升级，要么回退 MC 版本（见 loader-upgrade-downgrade）。',
      '定位到具体模组后，也可以临时把它移出 mods 启动，确认其余模组能否正常加载。'
    ],
    refine: (ctx) => {
      const mods: string[] = []
      for (const m of ctx.text.matchAll(/-\s*Mod '([^']+)' \(([^)]+)\)\s*([\w.\-+]+)?/g)) {
        mods.push(`${m[2]}${m[3] ? `@${m[3]}` : ''}`)
        if (mods.length >= 8) break
      }
      const pieces = ['加载器判定模组集合不兼容（版本约束不满足）。']
      if (mods.length > 0) pieces.push(`报错涉及的模组：${mods.join('、')}。`)
      if (ctx.facts.gameVersion) pieces.push(`当前实例游戏版本：${ctx.facts.gameVersion}${ctx.facts.loaderType ? `（${ctx.facts.loaderType}）` : ''}。`)
      return { detail: pieces.join(' '), confidence: mods.length > 0 ? 0.88 : 0.8 }
    }
  },
  {
    id: 'noclass-nosuchmethod',
    title: 'API 不匹配（NoSuchMethodError / NoClassDefFoundError）',
    category: 'mod-version-mismatch',
    severity: 'error',
    patterns: [
      { re: /NoSuchMethodError|NoSuchFieldError|AbstractMethodError|NoClassDefFoundError|IncompatibleClassChangeError|VerifyError/i, required: true, weight: 3 },
      { re: /java\.lang\.(?:NoSuchMethodError|NoClassDefFoundError|AbstractMethodError|NoSuchFieldError)/i, weight: 2 },
      { re: /(?:Could not initialize class|Error loading class)/i, weight: 1 }
    ],
    confidence: 0.7,
    knowledgeIds: ['crash-noclass-nosuchmethod', 'crash-mod-version-mismatch', 'mod-load-order'],
    detail: '某段代码在编译期存在的类/方法在运行期不存在：要么是模组与 MC/加载器版本不匹配，要么是缺少提供该 API 的前置。',
    steps: [
      '从栈里取出类名，判断它属于谁：`net.minecraft.*` → 模组与 MC 版本不匹配；`net.fabricmc.*` → 装 Fabric API；明显是某个模组的包名 → 该模组与依赖它的模组版本不一致。',
      '两个模组打包了同一个第三方库的不同版本（Gson/Guava/Jackson/ASM 最常见）时，移除或升级其中一个。',
      '确认全部模组都是同一 MC 版本与加载器：混装会出现大量 NoSuchMethodError。',
      '补齐常见前置（Fabric API / Architectury API / Cloth Config / GeckoLib），再重启。',
      '用二分法禁用一半模组，找出「报错消失」的那一半，再逐步收敛。',
      '如果报错方法属于 `org.lwjgl`/`net.minecraft.client` 的渲染类，往往是 OptiFine 或渲染模组混用导致，先排查渲染栈。'
    ],
    refine: (ctx) => {
      const cls = extractMissingClassRef(ctx.text)
      const installed = new Set((ctx.facts.mods ?? []).map((m) => (m.id ?? '').toLowerCase()).filter(Boolean))
      const pieces: string[] = []
      if (cls) {
        // 取前两段作为包前缀（net.minecraft.class_310 → net.minecraft），用于判断归属
        const packageName = cls.split('.').slice(0, 2).join('.') || cls
        const isVanilla = /^(net\.minecraft|com\.mojang|org\.lwjgl)/i.test(packageName)
        pieces.push(`缺少的类/方法：${cls}。`)
        if (/^(net\.fabricmc|net\.minecraftforge|net\.neoforged|org\.quiltmc)/i.test(packageName)) {
          pieces.push('该类属于加载器/API 包，通常是缺少对应前置（如 Fabric API）或加载器版本过旧。')
        } else if (isVanilla) {
          pieces.push('该类属于原版/渲染库，说明某个模组与当前 MC 版本不匹配（它按别的版本编译）。')
        } else {
          pieces.push(`该类来自第三方包 ${packageName}：可能是某个模组缺少前置，或两个模组内置了不同版本的同一库。`)
        }
        if (installed.size > 0) pieces.push(`本地已安装 ${installed.size} 个模组，可用 id 前缀在 mods 列表里反查 ${packageName}。`)
      } else {
        pieces.push('检测到链接期缺少类/方法，通常由模组与 MC 版本不匹配或缺少前置引起。')
      }
      return { detail: pieces.join(' '), confidence: cls ? 0.85 : 0.7 }
    }
  },
  {
    id: 'class-not-found',
    title: '类找不到（ClassNotFoundException，缺少前置/外部依赖）',
    category: 'mod-missing-dependency',
    severity: 'error',
    patterns: [
      { re: /java\.lang\.ClassNotFoundException/i, required: true, weight: 3 },
      { re: /(?:ClassNotFoundException|NoClassDefFoundError)[^\n]{0,80}?([a-z][\w$]*(?:\.[\w$]+){2,})/i, weight: 1 }
    ],
    confidence: 0.7,
    knowledgeIds: ['crash-missing-dependency', 'crash-noclass-nosuchmethod', 'mod-common-dependencies'],
    detail: '运行期找不到类：最常见是缺少前置模组或前置被禁用，其次是类被 mixin/混淆映射改动或 jar 损坏。',
    steps: [
      '取出日志中的完整类名，判断它属于哪个模组/库（包名前缀就是模组 id 的常见形式）。',
      '若属于已知前置（fabric-api、architectury、cloth-config、kotlin、geckolib…）→ 安装对应前置。',
      '若属于某个模组 → 检查该模组是否被禁用（.disabled）、版本是否与需求方匹配、jar 是否下载完整（大小是否异常）。',
      '重新下载报错模组的 jar（网络中断会得到 0 字节或半截文件，重新下载即可）。',
      '只有个别模组报 ClassNotFound 且它与前置版本都正确时，升级该模组到最新构建。'
    ],
    refine: (ctx) => {
      const cls = /ClassNotFoundException:\s*([\w.$]+)/i.exec(ctx.text)?.[1]
      if (!cls) return null
      const packageName = cls.split('.').slice(0, 2).join('.')
      return { detail: `找不到类：${cls}（包前缀 ${packageName}）。通常是对应模组/库没有安装或 jar 损坏。`, confidence: 0.8 }
    }
  },

  /* ---------------- 6. 加载器 / 整合包安装 ---------------- */
  {
    id: 'invalid-mod-file',
    title: 'mods 目录里有无效的模组文件',
    category: 'loader',
    severity: 'error',
    patterns: [
      { re: /is missing a mods\.toml|missing a mods\.toml/i, weight: 3 },
      { re: /Invalid mod file|not a valid mod (?:file|archive)/i, weight: 3 },
      { re: /Unable to read mod|Failed to read (?:mod|metadata)/i, weight: 2 },
      { re: /Mod file .* is missing|InvalidForgeVersionException/i, weight: 1 }
    ],
    confidence: 0.8,
    knowledgeIds: ['mod-forge-mods-toml', 'mod-fabric-mod-json', 'loader-forge-install-fail'],
    detail: '加载器在 mods 目录里发现了不符合当前加载器规范的 jar（缺元数据、下载不完整、或放错了加载器的模组）。',
    steps: STEPS_INVALID_MOD_FILE,
    refine: (ctx) => {
      const file = /(?:mod file|file)\s+['"`]?([^'"`\s]+\.jar)['"`]?/i.exec(ctx.text)?.[1] ?? /([\w.\-+]+\.jar)/.exec(ctx.text)?.[1]
      if (!file) return null
      const steps = [...STEPS_INVALID_MOD_FILE]
      steps.unshift(`先把 ${file} 移出 mods 目录验证：它是报错点名的文件。`)
      return { detail: `加载器无法读取模组文件 ${file} 的元数据。请检查它的加载器类型与完整性。`, steps, confidence: 0.88 }
    }
  },
  {
    id: 'forge-install-failed',
    title: 'Forge / NeoForge 安装或加载失败',
    category: 'loader',
    severity: 'error',
    patterns: [
      { re: /The forge installer failed|There was an error during the installation of Forge/i, weight: 3 },
      { re: /InvalidForgeVersionException|Invalid forge version|Forge version .* is invalid/i, weight: 3 },
      { re: /Failed to install (?:forge|neoforge)|InstallerException|installer\.jar.*(?:failed|error)/i, weight: 2 }
    ],
    confidence: 0.75,
    knowledgeIds: ['loader-forge-install-fail', 'loader-version-matrix', 'loader-neoforge-vs-forge'],
    detail: 'Forge/NeoForge 的 installer 没有成功完成（下载、校验或写出启动配置失败），实例缺少加载器文件。',
    steps: [
      '确认 Forge 版本与 MC 版本对应（1.20.1 → Forge 47.x；1.19.2 → 43.x），不要拿错版本的 installer。',
      '换下载源重试：MCAL 设置里把 Forge 镜像切到 BMCLAPI 后重新安装（官方 maven 在部分网络下会超时）。',
      '看 installer 日志：`installer.jar.log`（安装目录下）或启动器日志里的 `installer` 输出，里面会给出是哪个库下载失败。',
      '手动验证：双击/命令行运行 `java -jar forge-installer.jar --installClient`，观察报错；安装成功后启动器里应出现 `1.20.1-forge-47.x` 版本。',
      '清理旧的半成品版本目录 `versions/<id>` 后重装（残留 json 会导致后续安装直接失败）。',
      '检查磁盘空间与杀软：安装过程需要写入大量小文件，被拦截时 installer 会失败。'
    ]
  },
  {
    id: 'corrupt-mod-jar',
    title: '模组 jar 损坏或读取失败',
    category: 'loader',
    severity: 'error',
    patterns: [
      { re: /zip END header not found|invalid CEN header|zip file is empty|Unexpected end of ZLIB/i, weight: 3 },
      { re: /(?:Error while|Failed) reading (?:zip|jar|archive)/i, weight: 2 },
      { re: /(?:java\.util\.zip|java\.io)\.(?:ZipException|EOFException)/i, weight: 2 }
    ],
    confidence: 0.75,
    knowledgeIds: ['mod-download-safety', 'mod-forge-mods-toml', 'misc-save-backup'],
    detail: 'zip/jar 结构损坏（通常是下载中断或磁盘写入失败），加载器无法解析模组。',
    steps: [
      '从栈或报错里取出文件名，删除该 jar 后重新下载（用 MCAL 的模组安装/整合包导入，避免浏览器残留半截文件）。',
      '校验文件大小与出处是否一致（0 字节、几 KB 的 "jar" 基本是错误页面）。',
      '检查磁盘是否写满或有坏道（`chkdsk`），大量文件同时损坏时要考虑硬盘问题。',
      '重新下载后若问题依旧，换个来源（官方平台 vs 镜像站）再下载一次。',
      '整合包导入时出现多个坏文件：删除实例的 mods 目录，按清单重新导入。'
    ]
  },

  /* ---------------- 7. 图形 / OpenGL ---------------- */
  {
    id: 'graphics-opengl-unsupported',
    title: 'OpenGL 初始化失败 / 版本过低',
    category: 'graphics',
    severity: 'error',
    patterns: [
      { re: /Pixel format not accelerated/i, weight: 3 },
      { re: /GLFW error|The GLFW library failed to initialize|Failed to create display window/i, weight: 3 },
      { re: /requires OpenGL|OpenGL 3\.2|OpenGL 2\.0|Failed to (?:initialize|create) (?:the )?graphics/i, weight: 2 },
      { re: /Incompatible graphics driver|Microsoft Basic Render Driver|vb\.atmos|swrast|llvmpipe/i, weight: 2 },
      { re: /NoClassDefFoundError: org\/lwjgl|class file version.*lwjgl/i, weight: 1 }
    ],
    confidence: 0.8,
    knowledgeIds: ['graphics-opengl-version', 'graphics-gpu-selection', 'graphics-fps-tuning'],
    detail: '游戏无法创建符合要求的 OpenGL 上下文：驱动未安装/被替换成微软基本显示驱动，或硬件/远程环境不支持 OpenGL 3.2（1.17+ 需要 3.2）。',
    steps: [
      '安装/更新官方显卡驱动：设备管理器里若显示「Microsoft 基本显示适配器」说明驱动没装，先装 NVIDIA/AMD/Intel 官方驱动。',
      '双显卡笔记本：在显卡控制面板把 javaw.exe 指定为独显；同时确认显示器线接在独显输出口上（台式机）。',
      '远程桌面、虚拟机、无显示器（虚拟屏）环境通常拿不到 OpenGL 3.2：请在物理机上直接运行，或给虚拟机开启 3D 加速。',
      '老 Intel 核显（HD 3000 及以前）只支持 OpenGL 3.1，无法运行 1.17+：降级到 1.16.5，或换机器。',
      '检查是否被显卡驱动的「性能模式/兼容模式」或第三方插件（如 Windows 的 OpenGL 兼容层）覆盖，重置为默认。',
      'Java 版本与驱动位数要一致：64 位系统请用 64 位 Java 配 64 位驱动。'
    ]
  },
  {
    id: 'render-array-index',
    title: '渲染线程数组越界（ArrayIndexOutOfBoundsException）',
    category: 'graphics',
    severity: 'error',
    patterns: [
      { re: /java\.lang\.ArrayIndexOutOfBoundsException/i, required: true, weight: 3 },
      {
        re: /Render thread|rendering thread|net\.minecraft\.client\.renderer|LevelRenderer|ChunkRender|EntityRender|ParticleEngine|VertexConsumer|BakedModel|ModelBakery|Tessellator|BufferBuilder/i,
        required: true,
        weight: 3
      }
    ],
    confidence: 0.7,
    knowledgeIds: ['graphics-shader-issues', 'crash-mod-conflict', 'resourcepack-not-working'],
    detail: '渲染管线里某个数组越界：常见于自定义模型/粒子/实体渲染的模组遇到异常数据（材质分辨率、模型 JSON、材质索引不匹配）。',
    steps: [
      '看栈顶的包名找到具体模组（例如某个实体/粒子/连接材质模组），把它升级到最新版。',
      '移除最近新增的资源包与光影：高清材质里的方块模型数量与代码假设不一致时就会越界。',
      '如果是加了某个新实体/新方块后必崩，说明是内容模组与渲染模组不兼容，二选一。',
      '重置 `options.txt` 里的画质相关项（异常的分辨率/多级纹理设置也会触发）。',
      '把完整栈反馈给模组作者时附上资源包列表与 GPU 信息（这是渲染 bug 常见的定位信息）。'
    ]
  },

  /* ---------------- 8. 资源 / 资产 ---------------- */
  {
    id: 'asset-missing',
    title: '游戏资源/资产下载或加载失败',
    category: 'asset',
    severity: 'error',
    patterns: [
      { re: /Failed to download file|Failed to download .*assets?/i, weight: 3 },
      { re: /Could not find asset|Unable to load asset(?: index)?|Failed to load asset(?: index)?/i, weight: 3 },
      { re: /assets[\\/]minecraft[^\n]{0,80}(?:404|not found)/i, weight: 2 },
      { re: /(?:FileNotFound|NoSuchFile)Exception[^\n]{0,80}assets/i, weight: 2 },
      { re: /Missing required assets|object .* is not present/i, weight: 1 }
    ],
    confidence: 0.75,
    knowledgeIds: ['launcher-game-dirs', 'misc-version-system', 'loader-upgrade-downgrade'],
    detail: 'assets 目录缺文件或索引损坏：安装/下载中断、磁盘清理工具误删，或旧版本资源被下载源移除。',
    steps: [
      '在 MCAL 版本页对该版本执行「校验并修复/重新下载」，让启动器补齐 `assets/indexes/<版本>.json` 与 `assets/objects/`。',
      '换下载源（设置 → 下载源切到 BMCLAPI）后重试：部分网络下 resources.download.minecraft.net 会被重置。',
      '检查磁盘空间与安全软件：写入被拦截会留下 0 字节对象文件。',
      '如果只有老版本（1.6 及以前）报错：确认 `assets` 参数与资源索引版本对应，必要时手动下载对应 asset index。',
      '确认没有把 VSync/磁盘清理工具的输出目录指到 `.minecraft`（清理“临时文件”会删掉 assets）。'
    ]
  },
  {
    id: 'lwjgl-natives-missing',
    title: '缺少 LWJGL 原生库',
    category: 'asset',
    severity: 'error',
    patterns: [
      { re: /Failed to (?:load|locate) (?:a )?library:?\s*lwjgl|no lwjgl in java\.library\.path/i, weight: 3 },
      { re: /java\.lang\.UnsatisfiedLinkError[^\n]{0,120}(?:lwjgl|glfw|openal)/i, weight: 3 },
      { re: /Could not load library.*(?:lwjgl|natives)/i, weight: 2 }
    ],
    confidence: 0.8,
    knowledgeIds: ['launcher-game-dirs', 'graphics-opengl-version', 'java-install-verify'],
    detail: 'LWJGL 的原生库（.dll/.so/.dylib）没有解压到 natives 目录或版本不匹配，JVM 无法加载本地库。',
    steps: [
      '在 MCAL 里对实例执行「校验并修复」：natives 目录需要重新解压（默认在 `versions/<id>/natives` 或实例的 `natives/` 下）。',
      '确认使用的 Java 位数与系统一致（64 位系统 + 64 位 Java），32 位 Java 会加载不上 64 位 dll。',
      '检查是否被安全软件隔离了 dll（打开杀软的隔离区恢复 `lwjgl.dll`/`glfw.dll` 并把游戏目录加入白名单）。',
      '手动核对 `libraries/org/lwjgl/lwjgl/*` 下的 natives jar 是否存在；缺失就重新安装该版本。',
      '不要混用不同 MC 版本的 Java 参数（老版本带 `-Djava.library.path`，新版本由启动器自动管理，手动覆盖会指错目录）。'
    ]
  },

  /* ---------------- 9. 登录 ---------------- */
  {
    id: 'auth-failed',
    title: '账号/会话验证失败',
    category: 'auth',
    severity: 'warning',
    patterns: [
      { re: /Invalid session|Session (?:has )?expired|Invalid credentials/i, weight: 3 },
      { re: /Failed to verify username|Authentication servers are down|sessionserver\.mojang\.com/i, weight: 3 },
      { re: /Multiplayer is not enabled for this account/i, weight: 3 },
      { re: /Couldn't connect to server: https?:\/\/sessionserver/i, weight: 2 },
      { re: /invalid token|401 Unauthorized|Failed to (?:login|refresh)/i, weight: 1 }
    ],
    confidence: 0.8,
    knowledgeIds: ['launcher-login-modes'],
    detail: '微软账号 token 失效、会话服务器不可达，或账号类型与服务器要求不匹配（离线账号进正版服）。',
    steps: [
      '在 MCAL 账号页退出并重新登录微软账号（token 过期/被刷新掉是最常见原因）。',
      '校准系统时间：时间偏差超过几分钟会导致会话签名校验失败（Windows 设置 → 时间和语言 → 自动同步）。',
      '确认网络能访问 `sessionserver.mojang.com`：代理/加速器/防火墙可能拦截；换网络或关闭代理再试。',
      '「Multiplayer is not enabled」说明当前是离线/未验证账号：离线模式无法进正版服务器，请登录正版账号或使用该服务器允许的外置登录。',
      '同账号不要在多个启动器/客户端同时登录（后登录的会让先登录的会话失效）。',
      '外置登录（authlib-injector）用户检查认证服务器地址是否可访问、是否配置了正确的 UUID。'
    ]
  },

  /* ---------------- 10. 网络连接 ---------------- */
  {
    id: 'network-connect-failed',
    title: '连接服务器失败',
    category: 'network',
    severity: 'error',
    patterns: [
      { re: /Connection refused|ConnectException/i, weight: 3 },
      { re: /Connection timed out|Read timed out|SocketTimeoutException|readTimeout/i, weight: 3 },
      { re: /UnknownHostException|no such host/i, weight: 3 },
      { re: /io\.netty[^\n]*(?:exception|error)|Internal Exception: java\.io\.IOException/i, weight: 2 },
      { re: /Failed to (?:connect to|log in to) (?:the )?server|disconnect\.(?:generic|timeout)/i, weight: 2 }
    ],
    confidence: 0.75,
    knowledgeIds: ['server-connection-troubleshooting', 'server-setup'],
    detail: '客户端连不上目标服务器：地址/端口错误、服务器未开、被防火墙拦截、DNS 解析失败或代理干扰。',
    steps: [
      '核对地址与端口（格式 `host:port`；Java 版默认 25565，插件服常有自定义端口），确认没有把 Bedrock/基岩版服务器地址填进来。',
      '用在线状态查询或直接 ping 服务器 IP，确认服务器在线且在维护窗口之外。',
      'UnknownHostException = DNS 问题：换用 IP 直连、更换 DNS（114.114.114.114 / 8.8.8.8），或关闭 VPN/加速器。',
      'Connection refused = 能到主机但端口没人监听：服务器没开或端口写错；Connection timed out = 被防火墙/运营商 QoS 拦截。',
      '关闭代理、加速器、系统防火墙对 javaw.exe 的拦截后重试（三者是最常见的本地原因）。',
      '自建服务器：检查 `server-port`、端口映射（路由器）、以及服务器是否允许该账号（白名单/正版验证）。'
    ],
    refine: (ctx) => {
      const target = /(?:to|host[= ])\s*([\w.\-]+:\d{1,5})/i.exec(ctx.text)?.[1]
      const pieces = ['客户端无法与目标服务器建立连接。']
      if (target) pieces.push(`目标地址：${target}。`)
      if (/UnknownHostException/i.test(ctx.text)) pieces.push('DNS 解析失败（域名找不到），优先换 DNS 或用 IP 直连。')
      if (/Connection refused|ConnectException/i.test(ctx.text)) pieces.push('端口拒绝连接：服务器未启动或端口错误。')
      if (/timed out|TimeoutException/i.test(ctx.text)) pieces.push('超时：网络/防火墙/服务器过载。')
      return { detail: pieces.join(' '), confidence: 0.8 }
    }
  },

  /* ---------------- 11. 服务端 ---------------- */
  {
    id: 'server-ticking-crash',
    title: '服务端 tick 崩溃（Ticking entity / block entity）',
    category: 'server',
    severity: 'error',
    patterns: [
      { re: /Exception in thread "Server thread"/i, weight: 3 },
      { re: /Ticking (?:entity|block entity|world|screen)/i, weight: 3 },
      { re: /A single server tick took|Watchdog|Server thread dump|The server has (?:stopped|crashed)/i, weight: 2 }
    ],
    confidence: 0.8,
    dedupeKey: 'server:ticking',
    knowledgeIds: ['server-performance-tuning', 'crash-mod-conflict', 'misc-save-backup'],
    detail: '服务端在 tick 某个实体或方块实体时崩溃。日志里的实体/方块类型与坐标是定位模组的黄金线索。',
    steps: STEPS_SERVER_TICKING,
    refine: (ctx) => {
      const location = extractTickingLocation(ctx.text)
      const entityClass = /Ticking (?:entity|block entity):\s*([\w.$]+)/i.exec(ctx.text)?.[1]
      const suspect = entityClass ? entityClass.split('.').slice(0, 3).join('.') : extractSuspectPackage(ctx.text)
      const pieces = ['服务端在处理 tick 时崩溃。']
      if (location) pieces.push(`崩溃对象：${location}。`)
      if (entityClass) pieces.push(`类型：${entityClass}。`)
      if (suspect) pieces.push(`疑似模组包名：${suspect}。`)
      const extraSteps = [...STEPS_SERVER_TICKING]
      if (location) extraSteps.unshift(`先备份世界，再按坐标 ${location} 清理该实体/方块实体（\`/kill @e[type=...]\` 或编辑区块 NBT），随后再进服验证。`)
      return { detail: pieces.join(' '), steps: extraSteps, confidence: entityClass ? 0.9 : 0.8 }
    }
  },
  {
    id: 'server-plugin-load-failed',
    title: '服务端插件加载失败（Bukkit/Spigot/Paper）',
    category: 'server',
    severity: 'error',
    patterns: [
      { re: /Failed to load plugin|Could not load '?plugins[\\/][^'\n]+'?/i, required: true, weight: 3 },
      { re: /InvalidPluginException|UnknownDependencyException|PluginLoadException|Cannot load plugin/i, weight: 3 },
      { re: /(?:plugins[\\/][\w.\-]+\.jar)/i, weight: 1 }
    ],
    confidence: 0.8,
    dedupeKey: 'server:plugin',
    knowledgeIds: ['server-core-selection', 'server-setup'],
    detail: '插件无法被服务端核心加载：缺少前置插件、插件与核心/API 版本不兼容、jar 损坏，或插件要求更高的 Java。',
    steps: [
      '从报错里找到插件文件名与原因（`Unknown dependency` = 缺前置；`Unsupported class file` = 插件要更高 Java；`InvalidPluginException` = jar 损坏/不是插件）。',
      '缺前置就去装 `plugins/` 目录的依赖插件（如 Vault、ProtocolLib、PlaceholderAPI）。',
      '确认插件支持当前核心与 MC 版本（Paper 上跑 Spigot 插件通常可以，Bukkit 老插件在新版本上常失败）。',
      '升级服务端的 Java 版本（插件用 Java 21 编译而服务端跑在 Java 17 上会直接报错）。',
      '重新下载插件 jar 并核对大小；损坏文件用压缩软件打不开。',
      '排除法：把 plugins/ 里的插件逐个移出，确认服务端能正常启动后再逐个加回（先加前置）。'
    ]
  },
  {
    id: 'server-eula-not-accepted',
    title: '服务端未同意 EULA',
    category: 'server',
    severity: 'warning',
    patterns: [
      { re: /You need to agree to the EULA/i, weight: 3 },
      { re: /eula=(?:false|true)/i, weight: 2 },
      { re: /By changing the setting below to TRUE/i, weight: 1 }
    ],
    confidence: 0.9,
    dedupeKey: 'server:eula',
    knowledgeIds: ['server-setup'],
    detail: 'Mojang EULA 未接受：服务端会直接停止（`You need to agree to the EULA in order to run the server`）。',
    steps: [
      '打开服务端目录的 `eula.txt`，把 `eula=false` 改成 `eula=true` 保存（或在 MCAL 服务端页面点「同意 EULA」）。',
      '了解内容：同意的是 Mojang 最终用户许可协议（https://aka.ms/MinecraftEULA），商用需注意条款。',
      '改完重启服务端；如果文件又被写回 false，说明启动目录不对（改的是别的实例的 eula.txt）。'
    ]
  },

  /* ---------------- 12. 世界 / 存档 ---------------- */
  {
    id: 'world-corrupt',
    title: '世界/存档加载失败或损坏',
    category: 'world',
    severity: 'error',
    patterns: [
      { re: /Chunk file at [^\n]* is corrupt/i, weight: 3 },
      { re: /Failed to load world|Unable to load world|Could not load level/i, weight: 3 },
      { re: /level\.dat(?:\.old)?[^\n]{0,60}(?:corrupt|invalid|missing)/i, weight: 3 },
      { re: /(?:Region|Anvil) file[^\n]{0,60}(?:corrupt|damaged)/i, weight: 2 },
      { re: /is not a valid (?:save|world)|Unsupported data version|Data version .* is (?:newer|unsupported)/i, weight: 2 }
    ],
    confidence: 0.8,
    knowledgeIds: ['crash-corrupt-save', 'misc-save-backup', 'crash-world-load'],
    detail: '存档文件损坏或与当前版本不兼容：断电/崩溃时写入中断、跨版本降级打开、磁盘坏道都会造成。',
    steps: [
      '立刻备份整个 `saves/<世界名>/` 目录（复制一份到别处），后续所有修复都在副本上做。',
      '定位损坏区块：日志里的 `Chunk file at (x, z) is corrupt` 对应 `region/r.<x>>5>.<z>>5>.mca`，删除该 region 文件会丢那一块地形但能进游戏。',
      '`level.dat` 损坏：把 `level.dat_old` 复制一份改名为 `level.dat` 试试（游戏每次保存都会留上一版）。',
      '跨版本问题：高版本玩过的世界用低版本打开必然失败，恢复对应高版本客户端或从备份还原。',
      '用 Amulet / MCEdit 打开世界删除报错区块后另存；仍不行则从最近备份恢复。',
      '启用自动备份（MCAL 的存档备份功能）：把 `saves` 复制到其他磁盘，并保留多个时间点。'
    ]
  },

  /* ---------------- 13. 卡死 / 性能 ---------------- */
  {
    id: 'freeze-no-progress',
    title: '启动/运行卡死且日志没有新输出',
    category: 'performance',
    severity: 'warning',
    patterns: [
      {
        re: /Loading \d+ mods|Constructing mods|Injecting mods|ModLauncher running|Mod discovery|Preparing launch|Dispatching .* \(preinit\)|modloading/i,
        required: true,
        weight: 3
      },
      { re: /Stopping|Shutting down|Sound engine started|Created: .*textures-atlas/i, weight: 1 }
    ],
    excludes: [
      /A fatal error has been detected/i,
      /hs_err_pid/i,
      /Exception in thread/i,
      /The game crashed whilst/i,
      /Exit Code:/i,
      /Missing or unsupported mandatory dependencies/i
    ],
    confidence: 0.5,
    knowledgeIds: ['crash-freeze-black-screen', 'mod-load-order', 'graphics-fps-tuning'],
    detail: '日志停在加载阶段没有堆栈、没有崩溃报告：典型是模组死锁/无限循环，也可能是首次启动的数据包/光影编译很慢。',
    steps: [
      '先排除「只是慢」：大整合包首次启动（加载 200+ mods + 数据包）可能需要 3~10 分钟，硬盘灯还在闪就继续等。',
      '看日志最后一行：卡在哪个模组输出之后，那个模组就是第一嫌疑人（尤其是新增的）。',
      '生成线程转储确认死锁：任务管理器找到 javaw.exe 的 PID，用 `jstack <pid> > dump.txt`（JDK 自带），搜 `deadlock` 或看主线程卡在哪。',
      'JVM 层面：内存不足导致疯狂 GC 会表现为假死 —— 确认 -Xmx 足够（物理内存 50%~70%），必要时看任务管理器内存占用是否顶满。',
      '用二分法禁用模组定位：先禁用一半，能进就说明凶手在另一半。',
      '如果是启动到「黑屏/白屏」后卡住：移出光影/高清材质包后重试（显存不足会卡在纹理上传）。'
    ],
    refine: (ctx) => {
      const state = detectStartupState(ctx.lines)
      if (state.stage === 'crashed' || state.stage === 'ready' || state.stage === 'postinit') return null
      if (state.stage !== 'launching' && state.stage !== 'preinit') return null
      const tail = ctx.lines.slice(-60).map((line) => line.raw)
      const hasStack = tail.some((line) => /^\s*at\s+\S|Caused by:|Exception in thread/i.test(line))
      if (hasStack) return null
      const lastLines = tail.filter((line) => line.trim().length > 0).slice(-3)
      const pieces = [`日志停在启动阶段（${state.stage}）且末尾没有异常堆栈，符合"卡死/无输出"的特征。`]
      if (lastLines.length > 0) pieces.push(`日志最后几行：${lastLines.join(' | ').slice(0, 300)}。`)
      return { detail: pieces.join(' '), confidence: 0.65 }
    }
  },

  /* ---------------- 14. 编码 ---------------- */
  {
    id: 'encoding-garbled',
    title: '日志中文乱码（编码问题）',
    category: 'java',
    severity: 'warning',
    patterns: [
      { re: /锟斤拷|烫烫烫|屯屯屯|锘匡|鏈嶅姟|鏃犳硶/i, weight: 3 },
      { re: /\?{5,}/, weight: 2 },
      { re: /(\ufffd){3,}/, weight: 2 },
      { re: /[ÃÂ][\u0080-\u00bf]/, weight: 1 }
    ],
    confidence: 0.6,
    knowledgeIds: ['launcher-args', 'java-memory-flags'],
    detail: '中文出现乱码（`锟斤拷`/`????`）说明编码不一致：Java 8~17 默认用系统编码（中文 Windows = GBK），而日志/配置按 UTF-8 读写。',
    steps: [
      '在实例 JVM 参数里加 `-Dfile.encoding=UTF-8`（Java 18+ 已默认 UTF-8，老版本必须显式指定）。',
      '把启动器控制台切到 UTF-8：Windows 执行 `chcp 65001` 后再启动，或在 MCAL 设置里启用 UTF-8 输出。',
      '确认 mods/config 文件名与内容都用 UTF-8：个别老模组按 GBK 读文件，遇到 UTF-8 中文会崩，需要改回本地编码。',
      '游戏内中文显示为方块/问号是字体问题（要中文字体资源包），与日志乱码无关。',
      '如果只有日志乱码、游戏正常，可以忽略；但排查问题时中文行会失去意义，建议先加参数再复现。'
    ]
  },

  /* ---------------- 15. 崩溃阶段细分（The game crashed whilst ...） ---------------- */
  {
    id: 'crash-stage-initializing',
    title: '游戏初始化阶段崩溃（initializing game）',
    category: 'mod-conflict',
    severity: 'error',
    patterns: [
      { re: /The game crashed whilst initializing game/i, weight: 3 },
      { re: /Description:\s*(?:Initializing game|There was a severe problem during mod loading)/i, weight: 2 },
      { re: /Failed to initialize game|Error during pre(?:Init|-init) of mod/i, weight: 1 }
    ],
    confidence: 0.75,
    knowledgeIds: ['crash-read-crash-report', 'crash-mod-conflict', 'graphics-opengl-version'],
    detail: '崩溃发生在客户端初始化阶段（模组构造、资源加载、图形上下文创建都可能在这时失败）。',
    steps: [
      '打开 `crash-reports/` 最新报告：先看 `Description`（确认阶段）与 `Suspected Mods`（作者已标注的嫌疑人）。',
      '看 `Stacktrace:` 第一帧的包名，那就是崩溃模组；升级它或移除它验证。',
      '同时出现 `Pixel format not accelerated`/GLFW 报错时，按显卡驱动问题处理（初始化阶段的图形失败很常见）。',
      '怀疑资源包/光影时把 `resourcepacks`、`shaderpacks` 目录临时改名后启动。',
      '用二分法禁用 mods 定位（先禁用一半）；定位后优先升级该模组或找替代品。',
      '把完整的 `crash-report` 内容交给 MCAL 诊断（它会把 Description/Suspected Mods 转成可执行步骤）。'
    ]
  },
  {
    id: 'crash-stage-rendering-overlay',
    title: '渲染叠加层/资源加载阶段崩溃（rendering overlay）',
    category: 'graphics',
    severity: 'error',
    patterns: [
      { re: /The game crashed whilst rendering overlay/i, weight: 3 },
      { re: /Description:\s*Rendering overlay/i, weight: 3 },
      { re: /Failed to (?:load|parse) (?:resource pack|font|shader|texture)[^\n]{0,80}/i, weight: 1 }
    ],
    confidence: 0.75,
    knowledgeIds: ['resourcepack-not-working', 'graphics-shader-issues', 'crash-read-crash-report'],
    detail: '崩溃在渲染加载动画/加载界面时发生，绝大多数由资源包、字体或光影引起（渲染阶段读到坏资源）。',
    steps: [
      '临时把 `resourcepacks` 与 `shaderpacks` 目录整体改名（或移出），启动成功即确认是资源问题。',
      '打开最新 crash-report，指认具体资源文件名时直接删除/重下该资源包；`pack_format` 不匹配的资源包在高版本会直接崩。',
      '检查最近安装的光影：光影与 Iris 版本不匹配、或用了过新的 GLSL 特性会在此阶段崩。',
      '清空 `options.txt` 里的资源包列表（`resourcePacks:[...]`）或整个删除 `options.txt`（会重置画质设置）。',
      '更新显卡驱动：部分驱动在加载大量纹理时崩溃，表现同样是 rendering overlay。',
      '排出嫌疑资源后逐个加回，确认哪一个触发崩溃。'
    ]
  },
  {
    id: 'crash-stage-ticking-screen',
    title: '界面/屏幕 tick 阶段崩溃（ticking screen）',
    category: 'mod-conflict',
    severity: 'error',
    patterns: [
      { re: /The game crashed whilst ticking screen/i, weight: 3 },
      { re: /Description:\s*Ticking screen/i, weight: 3 },
      { re: /(?:Mouse (?:Wheel|Clicked)|KeyBinding|renderWidget)[^\n]{0,60}(?:crash|exception|null)/i, weight: 1 }
    ],
    confidence: 0.75,
    knowledgeIds: ['crash-read-crash-report', 'crash-mod-conflict'],
    detail: '崩溃发生在某个 GUI 界面的 tick 逻辑里（点击按钮、滚动列表、悬停提示都是常见触发点），通常是某个 UI 模组的 bug。',
    steps: [
      '回忆崩溃前的操作：点了哪个界面/按钮（模组列表、配置界面、资源包界面…），那通常是触发场景。',
      '看 crash-report 的 `Stacktrace:` 首帧包名 → 对应的 UI/配置模组，升级到最新版。',
      '临时移除该模组验证；若是整合包的配置界面（如 Mod Menu / 配置模组）本身，先升级前置库版本。',
      '某些情况下是鼠标滚轮/按键绑定冲突：重置 `options.txt` 的按键设置或删除配置目录里的 `.minecraft/config/<mod>-client.toml`。',
      '复现步骤能稳定触发时，把步骤与 crash-report 一起提交给模组作者。'
    ]
  }
]

/* ------------------------------------------------------------------ *
 *  便捷索引
 * ------------------------------------------------------------------ */

export const RULE_BY_ID: Map<string, DiagnoseRule> = new Map(DIAGNOSE_RULES.map((rule) => [rule.id, rule]))

/** 规则覆盖的报错类型清单（供 Agent / 文档展示） */
export function listRuleCatalog(): { id: string; title: string; category: DiagnosticFinding['category']; severity: DiagnosticFinding['severity'] }[] {
  return DIAGNOSE_RULES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity
  }))
}
