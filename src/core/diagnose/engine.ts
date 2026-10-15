/**
 * 崩溃/日志诊断引擎
 *
 * 流程：
 *  1. 取输入（崩溃报告 > 日志文件 > 直接传入的文本；崩溃报告与日志同时提供时会拼接）；
 *  2. parseLogChunk 做行级结构化（复用 launch/logparse，保证与启动器判定一致）；
 *  3. extractFacts 抽取事实（Java 版本、内存、退出码、崩溃报告字段、mod 列表）；
 *  4. 逐条匹配 DIAGNOSE_RULES（required 全中、excludes 否决、refine 动态判定）；
 *  5. 严重度降序 → 置信度降序排序，同类只保留最相关的一条；
 *  6. 有知识库时补全 knowledgeIds 并做二次检索；
 *  7. 一条都没命中时返回 unknown 级别的通用排查路径，而不是空报告。
 *
 * 硬约束：evidence 一律是原文片段（原文行，不改写），最多 6 行、每行截断 300 字。
 */

import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { arch, release, totalmem, type } from 'node:os'
import { join } from 'node:path'
import type { ContentFile, DiagnosticFinding, DiagnosticReport, GameLogLine, LoaderType } from '@shared/types'
import type { KnowledgeBase } from '@knowledge/index'
import { detectStartupState, parseLogChunk } from '@core/launch/logparse'
import { logger } from '@core/util/logger'
import { isDirectory, isFile, readJsonSafe, readTailLines, readTextSmart, shortId } from '@core/util/fsx'
import { extractGameVersions, parseJavaMajor } from '@core/util/misc'
import {
  DIAGNOSE_RULES,
  EXIT_CODE_MEANING,
  extractFacts,
  parseCrashReportFields,
  parseHsErrFields,
  type DiagnoseContext,
  type DiagnoseFacts,
  type DiagnosePattern,
  type DiagnoseRule
} from '@core/diagnose/rules'

const log = logger.scoped('diagnose')

export type { DiagnoseFacts, DiagnoseRule } from '@core/diagnose/rules'
export { DIAGNOSE_RULES, extractFacts } from '@core/diagnose/rules'

/* ------------------------------------------------------------------ *
 *  选项 / 常量
 * ------------------------------------------------------------------ */

export interface DiagnoseOptions {
  /** 日志文本（推荐） */
  text?: string
  /** 或从日志文件读取 */
  logPath?: string
  /** 崩溃报告文件（优先于日志） */
  crashReportPath?: string
  /** 环境事实（调用方尽力提供，缺失不影响） */
  facts?: Partial<DiagnoseFacts>
  /** 知识库（可选；提供时会把 knowledgeIds 补全并做二次检索） */
  knowledge?: KnowledgeBase
  /** 最多返回多少条 finding */
  limit?: number
  /** 只看 error 以上 */
  minSeverity?: DiagnosticFinding['severity']
}

const SEVERITY_RANK: Record<DiagnosticFinding['severity'], number> = { info: 1, warning: 2, error: 3, fatal: 4 }

const MAX_EVIDENCE_LINES = 6
const MAX_EVIDENCE_CHARS = 300
const MAX_EXCERPT_CHARS = 8000
const DEFAULT_LIMIT = 12
/** 从日志文件读取的最大尾部行数（足够覆盖启动阶段与末尾崩溃） */
const LOG_TAIL_LINES = 5000

/** 崩溃/异常标志（用于定位 rawExcerpt 的起点） */
const CRASH_MARK_RE =
  /a fatal error has been detected|problematic frame|exception in thread|the game crashed whilst|caused by:|failed to load mods|mod resolution|exit code|loading failed/i

/* ------------------------------------------------------------------ *
 *  引擎
 * ------------------------------------------------------------------ */

export class DiagnosticEngine {
  private readonly rules: DiagnoseRule[]
  private readonly ruleIndex: Map<string, DiagnoseRule>

  constructor(opts: { rules?: DiagnoseRule[] } = {}) {
    this.rules = opts.rules && opts.rules.length > 0 ? opts.rules : DIAGNOSE_RULES
    this.ruleIndex = new Map(this.rules.map((rule) => [rule.id, rule]))
  }

  /* ------------------------------ 主入口 ------------------------------ */

  /** 分析文本，返回报告 */
  async diagnose(opts: DiagnoseOptions): Promise<DiagnosticReport> {
    const sources: string[] = []
    let text = opts.text ?? ''

    // 崩溃报告优先：与日志同时提供时拼接（崩溃报告在前，日志尾部在后）
    if (opts.crashReportPath) {
      try {
        const read = await readTextSmart(opts.crashReportPath)
        text = read.text + (text ? `\n\n${text}` : '')
        sources.push(opts.crashReportPath)
      } catch (err) {
        log.warn(`读取崩溃报告失败：${opts.crashReportPath}，${(err as Error).message}`)
      }
    }
    if (opts.logPath) {
      try {
        const tail = await readTailLines(opts.logPath, LOG_TAIL_LINES)
        text = text ? `${text}\n\n${tail}` : tail
        sources.push(opts.logPath)
      } catch (err) {
        log.warn(`读取日志失败：${opts.logPath}，${(err as Error).message}`)
      }
    }

    const source = sources.length > 0 ? sources.join(' + ') : 'inline'
    const lines = parseLogChunk(text)
    const facts = extractFacts({ text, facts: opts.facts })

    if (lines.length === 0) {
      return this.emptyReport(source, facts)
    }

    const ctx: DiagnoseContext = { text, lines, facts }
    const matched: DiagnosticFinding[] = []
    for (const rule of this.rules) {
      const finding = this.matchRule(rule, ctx)
      if (finding) matched.push(finding)
    }

    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
    const minRank = SEVERITY_RANK[opts.minSeverity ?? 'info']
    const filtered = matched.filter((finding) => SEVERITY_RANK[finding.severity] >= minRank)
    let findings = this.dedupeAndSort(filtered).slice(0, limit)

    if (findings.length === 0) {
      // 没有规则命中（或都被 minSeverity 过滤）：给通用排查路径，绝不返回空报告
      findings = [this.buildFallbackFinding(ctx, matched)]
    }

    if (opts.knowledge) {
      try {
        await this.enrichWithKnowledge(findings, opts.knowledge, ctx)
      } catch (err) {
        log.debug(`知识库补充失败：${(err as Error).message}`)
      }
    }

    return {
      id: shortId('diag-'),
      createdAt: new Date().toISOString(),
      source,
      scannedLines: lines.length,
      gameVersion: facts.gameVersion,
      loaderType: facts.loaderType,
      findings,
      crashSummary: this.buildCrashSummary(ctx),
      rawExcerpt: this.buildExcerpt(lines)
    }
  }

  /* ------------------------------ 规则匹配 ------------------------------ */

  private matchRule(rule: DiagnoseRule, ctx: DiagnoseContext): DiagnosticFinding | null {
    // 排除模式：命中即否决
    if (rule.excludes && rule.excludes.some((re) => re.test(ctx.text))) return null

    const hits: DiagnosePattern[] = []
    for (const pattern of rule.patterns) {
      if (this.patternHit(pattern.re, ctx)) hits.push(pattern)
    }
    // required 必须全部命中
    if (rule.patterns.some((pattern) => pattern.required && !hits.includes(pattern))) return null
    if (hits.length === 0) return null

    const totalWeight = rule.patterns.reduce((acc, pattern) => acc + (pattern.weight ?? 1), 0)
    const hitWeight = hits.reduce((acc, pattern) => acc + (pattern.weight ?? 1), 0)
    const factor = 0.65 + 0.35 * (hitWeight / (totalWeight || 1))
    const confidence = clamp01(rule.confidence * factor)

    const evidence = this.collectEvidence(rule, ctx)
    const base: DiagnosticFinding = {
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      detail: rule.detail,
      evidence,
      steps: [...rule.steps],
      knowledgeIds: [...rule.knowledgeIds],
      confidence: Number(confidence.toFixed(3)),
      category: rule.category
    }

    if (!rule.refine) return base
    const refined = rule.refine(ctx)
    if (!refined) return null
    const merged: DiagnosticFinding = { ...base, ...refined, id: rule.id }
    const refinedEvidence = (refined.evidence ?? evidence).filter((line) => typeof line === 'string')
    merged.evidence = toEvidence(refinedEvidence)
    if (!merged.steps || merged.steps.length === 0) merged.steps = [...rule.steps]
    if (!merged.knowledgeIds || merged.knowledgeIds.length === 0) merged.knowledgeIds = [...rule.knowledgeIds]
    if (!merged.category) merged.category = rule.category
    if (!merged.severity) merged.severity = rule.severity
    // refine 给出的 confidence 视为新的基础分，仍要乘覆盖率因子（避免动态判定把置信度抬高到不合理）
    const refinedBase = refined.confidence ?? rule.confidence
    merged.confidence = Number(clamp01(refinedBase * factor).toFixed(3))
    return merged
  }

  /** 逐行匹配；不做整段匹配，保证 evidence 能落到原文行上 */
  private patternHit(re: RegExp, ctx: DiagnoseContext): boolean {
    for (const line of ctx.lines) {
      if (re.test(line.raw)) return true
    }
    return false
  }

  /** 命中模式的原文行（最多 6 行、每行 300 字） */
  private collectEvidence(rule: DiagnoseRule, ctx: DiagnoseContext): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const line of ctx.lines) {
      if (out.length >= MAX_EVIDENCE_LINES) break
      if (!rule.patterns.some((pattern) => pattern.re.test(line.raw))) continue
      const text = truncate(line.raw.trim(), MAX_EVIDENCE_CHARS)
      if (text.length === 0 || seen.has(text)) continue
      seen.add(text)
      out.push(text)
    }
    return out
  }

  /* ------------------------------ 排序 / 去重 ------------------------------ */

  private dedupeKey(finding: DiagnosticFinding): string {
    return this.ruleIndex.get(finding.id)?.dedupeKey ?? finding.category
  }

  /**
   * severity 降序 → confidence 降序；同一去重键只保留最相关的一条（避免刷屏）。
   * 去重键默认是 category，同一 category 下彼此独立的问题（如 heap/metaspace 两种 OOM）在规则里显式区分。
   */
  private dedupeAndSort(findings: DiagnosticFinding[]): DiagnosticFinding[] {
    const sorted = [...findings].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence
    )
    const kept: DiagnosticFinding[] = []
    const seen = new Set<string>()
    for (const finding of sorted) {
      const key = this.dedupeKey(finding)
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(finding)
    }
    return kept
  }

  /* ------------------------------ 兜底与摘要 ------------------------------ */

  private buildFallbackFinding(ctx: DiagnoseContext, matched: DiagnosticFinding[]): DiagnosticFinding {
    const exitCode = ctx.facts.exitCode
    const state = detectStartupState(ctx.lines)
    const normalExit = exitCode === 0 || (exitCode === undefined || exitCode === null ? state.stage === 'ready' : false)
    if (normalExit) {
      return {
        id: 'no-known-issue',
        severity: 'info',
        title: '未发现已知问题（进程正常退出）',
        detail: '日志里没有命中任何已知故障模式，也没有崩溃标志；如果确实出现问题，请描述现象（黑屏/卡顿/掉线）后重新分析。',
        evidence: [],
        steps: [
          '确认是否真的异常：能进主菜单且能进世界就属于正常；偶发卡顿可看性能相关规则与知识库 graphics-fps-tuning。',
          '把现象说清楚（何时发生、能否复现、有无报错弹窗），再运行诊断可以缩小范围。',
          '开启详细日志：启动时勾选「调试模式/保留控制台」，问题复现后立刻诊断（日志会被新一轮启动覆盖）。'
        ],
        knowledgeIds: ['launcher-launch-pipeline', 'misc-common-myths'],
        confidence: 0.5,
        category: 'unknown'
      }
    }

    const pieces: string[] = ['没有命中任何已知故障模式。']
    if (matched.length > 0) pieces.push(`有 ${matched.length} 条低相关度线索（严重度低于筛选阈值）。`)
    if (state.stage !== 'unknown') pieces.push(`日志判定的启动阶段：${state.stage}。`)
    if (exitCode !== undefined && exitCode !== null) {
      pieces.push(`退出码 ${exitCode}${EXIT_CODE_MEANING[String(exitCode)] ? `（${EXIT_CODE_MEANING[String(exitCode)]}）` : '（未知含义）'}。`)
    }

    return {
      id: 'unknown-issue',
      severity: 'warning',
      title: '未匹配到已知问题，需要更多信息',
      detail: pieces.join(' '),
      evidence: this.buildFallbackEvidence(ctx),
      steps: [
        '打开实例的「运行日志/控制台」并重跑一次，保留从启动到退出的完整输出（MCAL 的日志页会保存 latest.log 与 mcal-latest.log）。',
        '找崩溃报告：`crash-reports/` 目录下最新的 `crash-xxx-client.txt`，把整个文件交给诊断（比日志尾部信息量大）。',
        '找 JVM 崩溃日志：游戏目录与 `logs/` 下的 `hs_err_pid*.log`（若能找到，直接对该文件运行诊断）。',
        '确认 Java 与内存参数：实例 Java 是否 64 位、-Xmx 是否超过物理内存（启动器日志会打印完整命令行）。',
        '二分法排查模组：把 `mods/` 里的文件先移出一半启动，能进再把另一半加回，直到定位到引发问题的模组。',
        '在知识库中按现象关键词检索（如「黑屏」「卡死」「联机失败」），或把完整日志交给 Agent 让它结合规则与知识库继续分析。'
      ],
      knowledgeIds: ['crash-read-crash-report', 'crash-freeze-black-screen', 'launcher-game-dirs'],
      confidence: 0.35,
      category: 'unknown'
    }
  }

  private buildFallbackEvidence(ctx: DiagnoseContext): string[] {
    const out: string[] = []
    for (let i = ctx.lines.length - 1; i >= 0 && out.length < MAX_EVIDENCE_LINES; i--) {
      const line = ctx.lines[i]
      const trimmed = line.raw.trim()
      if (trimmed.length === 0) continue
      if (line.level === 'error' || line.level === 'fatal' || /error|exception|warn/i.test(trimmed)) {
        out.unshift(truncate(trimmed, MAX_EVIDENCE_CHARS))
      }
    }
    if (out.length === 0) {
      for (const line of ctx.lines.slice(-3)) {
        const trimmed = line.raw.trim()
        if (trimmed.length > 0) out.push(truncate(trimmed, MAX_EVIDENCE_CHARS))
      }
    }
    return out.slice(-MAX_EVIDENCE_LINES)
  }

  private buildCrashSummary(ctx: DiagnoseContext): string | undefined {
    const { facts, lines } = ctx
    const crash = facts.crashReport
    const parts: string[] = []
    if (crash?.description) parts.push(`崩溃阶段：${crash.description}`)
    if (crash?.suspectedMods && crash.suspectedMods.length > 0) parts.push(`疑似模组：${crash.suspectedMods.join('、')}`)
    if (crash?.problematicFrame) parts.push(`Problematic frame：${crash.problematicFrame}`)
    if (crash?.hsErrReason) parts.push(`致命原因：${crash.hsErrReason}`)
    if (crash?.stackTop) parts.push(`栈顶：${crash.stackTop}`)
    if (facts.exitCode !== undefined && facts.exitCode !== null) {
      const meaning = EXIT_CODE_MEANING[String(facts.exitCode)]
      parts.push(`退出码 ${facts.exitCode}${meaning ? `（${meaning}）` : ''}`)
    }
    if (parts.length === 0) {
      const state = detectStartupState(lines)
      if (state.stage === 'crashed') parts.push(`检测到崩溃标志：${truncate(state.evidence ?? '', 160)}`)
      else return undefined
    }
    return parts.join('；')
  }

  private buildExcerpt(lines: GameLogLine[], maxChars = MAX_EXCERPT_CHARS): string {
    if (lines.length === 0) return ''
    let start = 0
    const markerIndex = lines.findIndex((line) => CRASH_MARK_RE.test(line.raw))
    if (markerIndex > 8) start = markerIndex - 8
    const picked: string[] = []
    let length = 0
    for (let i = start; i < lines.length; i++) {
      const raw = lines[i].raw
      if (length + raw.length + 1 > maxChars) break
      picked.push(raw)
      length += raw.length + 1
    }
    if (start > 0) picked.unshift(`…（前面省略 ${start} 行）`)
    const dropped = lines.length - start - picked.length + (start > 0 ? 1 : 0)
    if (dropped > 0 && picked.length > 0) picked.push(`…（后面省略 ${dropped} 行）`)
    return picked.join('\n')
  }

  private emptyReport(source: string, facts: DiagnoseFacts): DiagnosticReport {
    return {
      id: shortId('diag-'),
      createdAt: new Date().toISOString(),
      source,
      scannedLines: 0,
      gameVersion: facts.gameVersion,
      loaderType: facts.loaderType,
      findings: [
        {
          id: 'input-empty',
          severity: 'info',
          title: '没有可分析的内容',
          detail: '传入的文本/文件是空的，无法诊断。请提供 latest.log 的尾部、crash-reports 的崩溃报告，或启动失败时的控制台输出。',
          evidence: [],
          steps: [
            '在 MCAL 实例页打开日志目录，读取 `logs/latest.log` 或 `logs/mcal-latest.log` 的最后几百行。',
            '若发生了崩溃，优先读取 `crash-reports/crash-*-client.txt`（信息量最大）。',
            '把文本粘贴进诊断或指定文件路径后重试。'
          ],
          knowledgeIds: ['crash-read-crash-report'],
          confidence: 0.9,
          category: 'unknown'
        }
      ],
      rawExcerpt: ''
    }
  }

  /* ------------------------------ 知识库增强 ------------------------------ */

  /** 校验知识库 id 是否真实存在，并用检索结果补充（最多保留 5 条） */
  private async enrichWithKnowledge(findings: DiagnosticFinding[], knowledge: KnowledgeBase, ctx: DiagnoseContext): Promise<void> {
    await knowledge.load()
    for (const finding of findings.slice(0, 6)) {
      const ids = new Set<string>()
      for (const id of finding.knowledgeIds ?? []) {
        if (await knowledge.read(id)) ids.add(id)
      }
      const query = [finding.title, ctx.facts.gameVersion ?? '', finding.evidence[0] ?? '']
        .filter(Boolean)
        .join(' ')
        .slice(0, 400)
      if (query.trim().length > 0) {
        const hits = await knowledge.search(query, { limit: 3 })
        for (const hit of hits) {
          if (ids.size >= 5) break
          ids.add(hit.article.id)
        }
      }
      const limited = [...ids].slice(0, 5)
      if (limited.length > 0) finding.knowledgeIds = limited
    }
  }

  /* ------------------------------ 崩溃报告 / hs_err ------------------------------ */

  /** 解析崩溃报告（crash-report 的固定格式） */
  parseCrashReport(text: string): DiagnoseFacts['crashReport'] {
    const parsed = parseCrashReportFields(text)
    return Object.keys(parsed).length > 0 ? parsed : undefined
  }

  /** 解析 hs_err_pid 文件 */
  parseHsErr(text: string): { reason?: string; problematicFrame?: string; jreVersion?: string; outOfMemory?: boolean; commandLine?: string } {
    return parseHsErrFields(text)
  }

  /* ------------------------------ 实例事实收集 ------------------------------ */

  /**
   * 从日志目录收集事实（读 latest.log、crash-reports 最新、versions json、mods 列表、java 版本）。
   * 注意：这里只读文件名与大小，不解压 jar；需要 mod 元数据时调用方通过 ContentManager.scan
   * 的结果（ContentFile[]）传入。
   */
  async collectFactsFromInstance(opts: {
    gameDir: string
    versionId?: string
    javaMajor?: number
    javaPath?: string
    maxHeapMB?: number
    /** 由 ContentManager.scan 得到的 mods/资源包元数据（可选，优先级高于文件名推断） */
    content?: ContentFile[]
  }): Promise<DiagnoseFacts> {
    const gameDir = opts.gameDir
    const provided: Partial<DiagnoseFacts> = {
      javaMajor: opts.javaMajor,
      javaPath: opts.javaPath,
      maxHeapMB: opts.maxHeapMB,
      physicalMemoryMB: Math.round(totalmem() / (1024 * 1024)),
      osName: `${type()} ${release()}`,
      osArch: arch()
    }

    let facts: DiagnoseFacts = {}

    /* ---- 1. 版本 json（游戏版本 / 加载器 / Java 要求） ---- */
    const versionInfo = await this.readVersionJson(gameDir, opts.versionId)
    if (versionInfo) {
      if (versionInfo.gameVersion) facts.gameVersion = versionInfo.gameVersion
      if (versionInfo.loaderType) facts.loaderType = versionInfo.loaderType
      if (versionInfo.loaderVersion) facts.loaderVersion = versionInfo.loaderVersion
      if (versionInfo.javaMajor) facts.javaMajor = versionInfo.javaMajor
    }

    /* ---- 2. 最新日志 ---- */
    const logPath = await this.findLatestLog(gameDir)
    if (logPath) {
      try {
        const text = await readTailLines(logPath, LOG_TAIL_LINES)
        const fromLog = extractFacts({ text })
        facts = mergeFacts(facts, fromLog)
      } catch (err) {
        log.debug(`读取日志失败：${logPath}，${(err as Error).message}`)
      }
    }

    /* ---- 3. hs_err_pid（原生崩溃） ---- */
    const hsErrPath = await this.findLatestHsErr(gameDir)
    if (hsErrPath) {
      try {
        const text = await readTextSmart(hsErrPath, 4 * 1024 * 1024)
        const hs = parseHsErrFields(text.text)
        const fromHs = extractFacts({ text: text.text })
        facts = mergeFacts(facts, fromHs)
        if (!facts.crashReport?.hsErrReason && hs.reason) {
          facts.crashReport = { ...(facts.crashReport ?? {}), hsErrReason: hs.reason }
        }
        if (!facts.crashReport?.problematicFrame && hs.problematicFrame) {
          facts.crashReport = { ...(facts.crashReport ?? {}), problematicFrame: hs.problematicFrame }
        }
        if (!facts.javaMajor && hs.jreVersion) {
          const major = parseJavaMajor(hs.jreVersion)
          if (major > 0 &&
            major < 100) facts.javaMajor = major
        }
      } catch (err) {
        log.debug(`读取 hs_err 失败：${hsErrPath}，${(err as Error).message}`)
      }
    }

    /* ---- 4. 最新崩溃报告 ---- */
    const crashPath = await this.findLatestCrashReport(gameDir)
    if (crashPath) {
      try {
        const read = await readTextSmart(crashPath)
        const parsed = parseCrashReportFields(read.text)
        const fromCrash = extractFacts({ text: read.text })
        facts = mergeFacts(facts, { ...fromCrash, crashReport: mergeCrashReport(facts.crashReport, parsed) })
        if ((facts.exitCode === undefined || facts.exitCode === null) && parsed.exitCode !== undefined) {
          facts.exitCode = parsed.exitCode
        }
      } catch (err) {
        log.debug(`读取崩溃报告失败：${crashPath}，${(err as Error).message}`)
      }
    }

    /* ---- 5. mods / resourcepacks / shaderpacks ---- */
    const content = opts.content ?? []
    const modContents = content.filter((file) => file.kind === 'mod')
    if (modContents.length > 0) {
      facts.mods = modContents.map((file) => ({
        fileName: file.fileName,
        id: file.meta?.id,
        version: file.meta?.version,
        gameVersions: file.meta?.gameVersions,
        loaders: file.meta?.loaders,
        environment: file.meta?.environment,
        depends: file.meta?.depends
      }))
      facts.modCount = modContents.filter((file) => file.enabled).length
    } else {
      const mods = await this.scanModsByFileName(gameDir)
      if (mods.length > 0) {
        facts.mods = mods
        facts.modCount = mods.length
      }
    }
    if (content.length > 0) {
      const packs = content.filter((file) => file.kind === 'resourcepack').length
      const shaders = content.filter((file) => file.kind === 'shaderpack').length
      if (packs > 0) facts.resourcePackCount = packs
      if (shaders > 0) facts.shaderPackCount = shaders
    } else {
      const packCount = await countFiles(join(gameDir, 'resourcepacks'), (name) => /\.zip$/i.test(name))
      const shaderCount = await countFiles(join(gameDir, 'shaderpacks'), (name) => /\.zip$/i.test(name) || true)
      if (packCount > 0) facts.resourcePackCount = packCount
      if (shaderCount > 0) facts.shaderPackCount = shaderCount
    }

    /* ---- 6. 调用方提供的事实优先 ---- */
    return mergeFacts(facts, provided)
  }

  /** 读取 versions/<id>/<id>.json（或扫描 versions 目录取第一个可用版本） */
  private async readVersionJson(
    gameDir: string,
    versionId?: string
  ): Promise<{ gameVersion?: string; loaderType?: LoaderType; loaderVersion?: string; javaMajor?: number } | null> {
    const versionsDir = join(gameDir, 'versions')
    const candidates: string[] = []
    if (versionId) candidates.push(join(versionsDir, versionId, `${versionId}.json`))
    if (await isDirectory(versionsDir)) {
      try {
        const entries = await readdir(versionsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const json = join(versionsDir, entry.name, `${entry.name}.json`)
          if (!candidates.includes(json)) candidates.push(json)
        }
      } catch {
        /* ignore */
      }
    }
    for (const jsonPath of candidates) {
      if (!(await isFile(jsonPath))) continue
      const parsed = await readJsonSafe<Record<string, unknown> | null>(jsonPath, null)
      if (!parsed || typeof parsed !== 'object') continue
      const id = typeof parsed.id === 'string' ? parsed.id : undefined
      const inheritsFrom = typeof parsed.inheritsFrom === 'string' ? parsed.inheritsFrom : undefined
      const mcalMeta = (parsed.mcalMeta ?? {}) as { loaderType?: LoaderType; loaderVersion?: string }
      const javaVersion = parsed.javaVersion as { majorVersion?: number } | undefined
      const gameVersion = inheritsFrom ?? id
      let loaderType = mcalMeta.loaderType
      let loaderVersion = mcalMeta.loaderVersion
      if (!loaderType && id) {
        const guess = guessLoaderFromId(id)
        loaderType = guess.loaderType
        loaderVersion = loaderVersion ?? guess.loaderVersion
      }
      return {
        gameVersion,
        loaderType,
        loaderVersion,
        javaMajor: javaVersion?.majorVersion
      }
    }
    return null
  }

  /** 优先 mcal-latest.log，其次 logs/latest.log，最后游戏目录下的 latest.log */
  private async findLatestLog(gameDir: string): Promise<string | null> {
    const candidates = [
      join(gameDir, 'logs', 'mcal-latest.log'),
      join(gameDir, 'mcal-latest.log'),
      join(gameDir, 'logs', 'latest.log'),
      join(gameDir, 'latest.log')
    ]
    let best: { path: string; mtime: number } | null = null
    for (const path of candidates) {
      if (!(await isFile(path))) continue
      const info = await stat(path).catch(() => null)
      if (!info) continue
      const mtime = info.mtimeMs
      // 顺序即优先级：只取第一个存在且非空的文件，但 mcal-latest.log 优先级最高
      if (!best || mtime > best.mtime) best = { path, mtime }
      if (path.endsWith('mcal-latest.log')) break
    }
    return best?.path ?? null
  }

  /** logs/ 与游戏目录下的最新 hs_err_pid*.log */
  private async findLatestHsErr(gameDir: string): Promise<string | null> {
    const dirs = [join(gameDir, 'logs'), gameDir]
    let best: { path: string; mtime: number } | null = null
    for (const dir of dirs) {
      if (!(await isDirectory(dir))) continue
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        if (!/^hs_err_pid.*\.log$/i.test(name)) continue
        const path = join(dir, name)
        const info = await stat(path).catch(() => null)
        if (!info) continue
        if (!best || info.mtimeMs > best.mtime) best = { path, mtime: info.mtimeMs }
      }
    }
    return best?.path ?? null
  }

  /** crash-reports 目录下最新的 crash-*.txt */
  private async findLatestCrashReport(gameDir: string): Promise<string | null> {
    const dir = join(gameDir, 'crash-reports')
    if (!(await isDirectory(dir))) return null
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return null
    }
    let best: { path: string; mtime: number } | null = null
    for (const name of entries) {
      if (!/^crash-.*\.txt$/i.test(name)) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (!info) continue
      if (!best || info.mtimeMs > best.mtime) best = { path, mtime: info.mtimeMs }
    }
    return best?.path ?? null
  }

  /**
   * 只读文件名与大小，从命名推断 modid / 版本 / 支持的游戏版本（**不解压 jar**）。
   * 需要真实元数据时由调用方通过 ContentManager.scan 提供 ContentFile[]。
   */
  private async scanModsByFileName(gameDir: string): Promise<NonNullable<DiagnoseFacts['mods']>> {
    const modsDir = join(gameDir, 'mods')
    if (!(await isDirectory(modsDir))) return []
    let entries: Dirent[] = []
    try {
      entries = await readdir(modsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: NonNullable<DiagnoseFacts['mods']> = []
    for (const entry of entries) {
      const enabled = entry.isFile() && /\.jar$/i.test(entry.name)
      const disabled = entry.isFile() && /\.jar\.disabled$/i.test(entry.name)
      if (!enabled && !disabled) continue
      const name = entry.name
      // 只确认文件存在（大小信息由 stat 提供，不写入 facts —— 接口里没有 size 字段）
      const info = await stat(join(modsDir, name)).catch(() => null)
      if (!info) continue
      const fileName = disabled ? name.replace(/\.disabled$/i, '') : name
      const guessed = guessModFromFileName(fileName)
      out.push({
        fileName,
        id: guessed.id,
        version: guessed.version,
        gameVersions: extractGameVersions(fileName),
        loaders: guessed.loaders
      })
      if (out.length >= 4000) break
    }
    return out
  }

  /* ------------------------------ Agent 摘要 ------------------------------ */

  /** 给 Agent 用的文本摘要（简洁、信息密度高） */
  summarize(report: DiagnosticReport): string {
    const lines: string[] = []
    const head: string[] = [`【诊断报告】${report.id}`, `来源：${report.source}｜扫描 ${report.scannedLines} 行`]
    const env: string[] = []
    if (report.gameVersion) env.push(`MC ${report.gameVersion}`)
    if (report.loaderType) env.push(`加载器 ${report.loaderType}`)
    if (env.length > 0) head.push(env.join(' · '))
    lines.push(head.join('\n'))
    if (report.crashSummary) lines.push(`崩溃摘要：${report.crashSummary}`)

    if (report.findings.length === 0) {
      lines.push('结论：没有命中任何规则。')
      return lines.join('\n')
    }

    report.findings.forEach((finding, index) => {
      lines.push(
        '',
        `${index + 1}. [${finding.severity}] ${finding.title}（${finding.category}，置信度 ${(finding.confidence * 100).toFixed(0)}%）`
      )
      lines.push(`   说明：${finding.detail}`)
      if (finding.evidence.length > 0) {
        lines.push(`   证据：${finding.evidence.slice(0, 2).join(' ｜ ')}`)
      }
      if (finding.steps.length > 0) {
        lines.push(`   下一步：${finding.steps[0]}`)
        if (finding.steps[1]) lines.push(`             ${finding.steps[1]}`)
      }
      if (finding.knowledgeIds && finding.knowledgeIds.length > 0) {
        lines.push(`   知识库：${finding.knowledgeIds.join(', ')}`)
      }
    })
    return lines.join('\n')
  }

  /** 生成"下一步该做什么"的建议（给 Agent 的工具用） */
  nextSteps(report: DiagnosticReport): string[] {
    const out: string[] = []
    const push = (text: string): void => {
      if (text && !out.includes(text)) out.push(text)
    }

    const top = report.findings[0]
    if (top) {
      push(`先处理最相关的问题「${top.title}」：${top.steps[0] ?? '按详情逐条排查'}`)
      if (top.steps[1]) push(`接着：${top.steps[1]}`)
      const knowledgeId = top.knowledgeIds?.[0]
      if (knowledgeId) push(`阅读知识库文章 ${knowledgeId}（knowledge.read('${knowledgeId}')）获取完整背景与验证方法。`)
    }

    // 通用工具路径（按当前报告缺什么给什么）
    if (!report.crashSummary) {
      push('没有崩溃摘要：读取 crash-reports 目录最新文件（launcher.listLogs / readGameLog）后重新诊断，崩溃报告比日志尾部信息量大。')
    }
    if (report.scannedLines > 0 && report.scannedLines < 50) {
      push('日志很短：用 launcher.readGameLog 读取完整 latest.log（或调试模式重启保留控制台输出）后再诊断。')
    }
    const hasModFinding = report.findings.some((finding) =>
      ['mod-conflict', 'mod-missing-dependency', 'mod-version-mismatch'].includes(finding.category)
    )
    if (hasModFinding) {
      push('涉及模组：用 content.scan(instance.gameDir) 列出 mods/，按 finding 里的嫌疑模组用 content.toggle(path, false) 二分禁用后重启验证。')
    }
    if (report.findings.some((finding) => finding.category === 'memory')) {
      push('涉及内存：调用 launcher.listJava() 确认 64 位 Java，并检查实例 memory 设置（-Xmx 按物理内存 50%~70%）。')
    }
    if (report.findings.some((finding) => finding.category === 'graphics')) {
      push('涉及图形：让用户更新/回退显卡驱动并在双显卡控制面板为 javaw.exe 指定独显，同时确认 hs_err_pid 里的 Problematic frame。')
    }
    push('修复后重新启动并再跑一次诊断，对比 findings 是否减少，即可验证修复是否生效。')
    return out.slice(0, 10)
  }
}

export default DiagnosticEngine

/* ------------------------------------------------------------------ *
 *  辅助函数
 * ------------------------------------------------------------------ */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** evidence 规范化：原文片段、最多 6 行、每行 300 字 */
function toEvidence(lines: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (out.length >= MAX_EVIDENCE_LINES) break
    if (typeof line !== 'string') continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const text = truncate(trimmed, MAX_EVIDENCE_CHARS)
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 只覆盖 extra 中「已定义」的字段，用于按优先级合并事实 */
function mergeFacts(base: DiagnoseFacts, extra: Partial<DiagnoseFacts>): DiagnoseFacts {
  const merged: DiagnoseFacts = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue
    if (key === 'crashReport') {
      // 崩溃报告字段是分来源拼出来的（日志 / hs_err / crash-report），必须逐字段合并而不是整体替换
      merged.crashReport = mergeCrashReport(merged.crashReport, value as DiagnoseFacts['crashReport'])
      continue
    }
    ;(merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/** 崩溃报告字段合并：extra 中已定义的字段覆盖 base，未定义字段保留 */
export function mergeCrashReport(
  base: DiagnoseFacts['crashReport'] | undefined,
  extra: DiagnoseFacts['crashReport'] | undefined
): DiagnoseFacts['crashReport'] {
  const out: NonNullable<DiagnoseFacts['crashReport']> = { ...(base ?? {}) }
  if (!extra) return Object.keys(out).length > 0 ? out : undefined
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 从版本 id 猜测加载器（1.20.1-forge-47.2.0 / fabric-loader-0.15.11-1.20.1 等） */
function guessLoaderFromId(id: string): { loaderType?: LoaderType; loaderVersion?: string } {
  const forge = /-forge-([\d.]+)/i.exec(id)
  if (forge) return { loaderType: 'forge', loaderVersion: forge[1] }
  const neo = /-neoforge-([\d.]+)/i.exec(id)
  if (neo) return { loaderType: 'neoforge', loaderVersion: neo[1] }
  const fabric = /fabric-loader-([\d.]+)/i.exec(id)
  if (fabric) return { loaderType: 'fabric', loaderVersion: fabric[1] }
  const quilt = /quilt-loader-([\d.]+)/i.exec(id)
  if (quilt) return { loaderType: 'quilt', loaderVersion: quilt[1] }
  const optifine = /-optifine[_-]?([\w.]+)/i.exec(id)
  if (optifine) return { loaderType: 'optifine', loaderVersion: optifine[1] }
  return { loaderType: 'vanilla' }
}

/** 从 jar 文件名猜测 modid / 版本 / 加载器（仅文件名启发式，不解压） */
export function guessModFromFileName(fileName: string): { id?: string; version?: string; loaders?: string[] } {
  const stem = fileName.replace(/\.jar$/i, '')
  const loaders: string[] = []
  for (const token of ['fabric', 'forge', 'neoforge', 'quilt']) {
    if (new RegExp(`(?:^|[-_+])${token}(?:[-_+]|$)`, 'i').test(stem)) loaders.push(token)
  }
  // 取最后一个版本号出现位置：name-1.20.1-forge-15.2.0.53 → 在 15.2.0.53 处切分
  const versionRe = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/g
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = versionRe.exec(stem)) !== null) {
    last = match
    if (versionRe.lastIndex >= stem.length) break
  }
  const version = last?.[1]
  let id = last ? stem.slice(0, last.index) : stem
  id = id.replace(/[-_+]+$/, '')
  // 去掉结尾的加载器标记与 MC 版本段（jei-1.20.1-forge → jei）
  for (let i = 0; i < 3; i++) {
    const before = id
    id = id.replace(/[-_+](?:fabric|forge|neoforge|quilt|mc|minecraft)$/i, '')
    id = id.replace(/[-_+]?\d+\.\d+(?:\.\d+)?$/i, '')
    id = id.replace(/[-_+]+$/, '')
    if (id === before) break
  }
  return { id: id.length > 0 ? id.toLowerCase() : undefined, version, loaders: loaders.length > 0 ? loaders : undefined }
}

/** 统计目录里满足条件的文件个数（目录不存在返回 0） */
async function countFiles(dir: string, filter: (name: string) => boolean): Promise<number> {
  if (!(await isDirectory(dir))) return 0
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count++
        continue
      }
      if (entry.isFile() && filter(entry.name)) count++
    }
    return count
  } catch {
    return 0
  }
}
