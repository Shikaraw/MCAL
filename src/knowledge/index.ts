/**
 * MCAL 本地知识库检索引擎
 *
 * 纯本地、零依赖：
 *  - 自写 YAML 子集 frontmatter 解析（key: value / key: [a, b] / key: |）
 *  - 中文分词：CJK 单字 + bigram + trigram；英文/数字按 [a-zA-Z0-9_.\-]+ 切分并做简单词干化
 *  - 自建同义词表（90+ 组），查询与文档统一做同义词归一
 *  - BM25（k1=1.5, b=0.75），字段权重 title×5 / tags×3 / summary×2 / body×1（id 计入 title）
 *  - 整串精确匹配加分（正文 ×3、summary ×5）与报错文本/错误码精确命中（×20）
 *
 * 索引常驻内存，`load({ force: true })` 可强制重建；`userRoots` 中同名 id 覆盖内置文章。
 */

import { join } from 'node:path'
import type { KnowledgeArticle, KnowledgeHit } from '@shared/types'
import { readTextSmart, walkFiles } from '@core/util/fsx'

/* ------------------------------------------------------------------ *
 *  公共接口
 * ------------------------------------------------------------------ */

export interface KnowledgeIndexOptions {
  /** 内置知识库根目录（每个子目录为一个 category） */
  roots: string[]
  /** 用户自定义知识库根目录，同名 id 覆盖内置 */
  userRoots?: string[]
}

export interface KnowledgeDocMeta {
  id: string
  title: string
  category: string
  tags: string[]
  summary: string
}

/** `read()` 返回值：在 KnowledgeArticle 之上附加 [[id]] 关联 */
export interface KnowledgeArticleDetail extends KnowledgeArticle {
  /** 正文中 [[id]] 解析出的关联文章（仅保留已存在的 id） */
  related: string[]
}

/* ------------------------------------------------------------------ *
 *  常量
 * ------------------------------------------------------------------ */

const FIELD_WEIGHTS = { title: 5, tags: 3, summary: 2, body: 1 } as const
type FieldName = keyof typeof FIELD_WEIGHTS
const FIELDS: FieldName[] = ['title', 'tags', 'summary', 'body']

const BM25_K1 = 1.5
const BM25_B = 0.75
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 100
const EXCERPT_RADIUS = 120
const MAX_HIGHLIGHT_TERMS = 32

/** catalog 与 categories() 的稳定排序 */
const CATEGORY_ORDER = [
  'crash',
  'java',
  'mod',
  'loader',
  'graphics',
  'resourcepack',
  'launcher',
  'server',
  'dev',
  'pack',
  'misc'
]

/* ------------------------------------------------------------------ *
 *  同义词表（90 组）
 *
 *  每组第一个元素是归一化后的 canonical，其余为同义写法。
 *  查询与文档都先做同义词归一，因此双向扩展自动生效。
 *  先出现的组优先，避免「内存」之类关键词被后续组抢走。
 * ------------------------------------------------------------------ */

const SYNONYM_GROUPS: string[][] = [
  // 故障与状态
  ['crash', '崩溃', '闪退', 'crash', 'crashes', 'crashed', 'crashing', '崩', '崩坏', '秒退'],
  ['freeze', '卡死', '卡顿', '卡住', '卡', '卡了', 'lag', 'laggy', 'stutter', '冻结', '无响应', '未响应', '假死', 'freeze', 'frozen', 'hang', 'hangs'],
  ['oom', '内存', '内存不足', '堆内存', 'heap', 'oom', 'outofmemory', 'outofmemoryerror', 'memory', '耗尽'],
  ['cannotlaunch', '无法启动', '打不开', '进不去', '启动不了', '起不来', '开不了', '无法进入', '进不了', '打不了'],
  ['error', '报错', '错误', '异常', '出错', 'error', 'errors', 'exception', 'exceptions', 'failure', 'failed', '失败'],
  ['blackscreen', '黑屏', 'blackscreen'],
  ['whitescreen', '白屏', 'whitescreen', '花屏'],
  ['exitcode', '退出码', '错误码', '返回码', 'exitcode', 'exit'],
  ['crashreport', '崩溃报告', 'crashreport', 'crashreports', 'crash-reports'],
  ['log', '日志', 'log', 'logs', 'latest.log'],
  ['mixinapplyfailed', '注入失败', '注入', 'mixinapplyfailed'],

  // 运行环境与硬件
  ['java', 'java', 'jdk', 'jre', 'jvm'],
  ['memoryflags', '内存参数', '内存设置', '堆大小', 'xmx', 'xms', 'jvm参数', 'java参数'],
  ['gpu', '显卡', 'gpu', '独显', '核显', '显存', 'vram', '显卡驱动'],
  ['driver', '驱动', 'driver', 'drivers', '驱动程序'],
  ['shader', '光影', 'shader', 'shaders', 'shaderpack', 'shaderpacks', '光影包', '着色器', 'glsl'],
  ['fps', '帧数', '帧率', '帧', '掉帧', '卡帧', 'fps', 'frame', 'frames'],
  ['performance', '性能', '优化', 'performance', 'optimize', 'optimization', 'optimized', '提速', '流畅'],
  ['render', '渲染', 'render', 'rendering'],
  ['distance', '渲染距离', '视距', '视野距离', 'renderdistance'],
  ['simulation', '模拟距离', 'simulationdistance'],
  ['fullscreen', '全屏', '窗口化', '窗口模式', 'fullscreen'],
  ['vsync', '垂直同步', '限帧', '锁帧', 'vsync'],
  ['gpu_select', '双显卡', '切换显卡', '显卡切换', 'optimus', '高性能'],
  ['texture', '材质', '贴图', '纹理', 'texture', 'textures', '高清材质'],

  // 模组与加载器
  ['mod', '模组', 'mod', 'mods', 'modded'],
  ['modpack', '整合包', '整合', 'modpack', 'modpacks'],
  ['dependency', '前置', '依赖', 'dependency', 'dependencies', 'depends', '前置模组'],
  ['conflict', '冲突', '互斥', '不兼容', 'incompatible', 'conflict'],
  ['missing', '缺失', '缺少', '找不到', '丢失', 'missing'],
  ['loadorder', '加载顺序', '顺序', '排序', '优先级', '覆盖', 'loadorder'],
  ['loader', '加载器', 'loader', 'loaders', 'modloader'],
  ['forge', 'forge', 'minecraftforge'],
  ['neoforge', 'neoforge'],
  ['fabric', 'fabric', 'fabricmc', 'fabricapi'],
  ['quilt', 'quilt', 'liteloader'],
  ['optifine', 'optifine'],
  ['sodium', 'sodium', 'embeddium', 'rubidium'],
  ['iris', 'iris', 'oculus'],
  ['mixin', 'mixin', 'mixins'],
  ['mixinsjson', 'mixins.json', 'mixinsjson'],
  ['fabricmodjson', 'fabric.mod.json', 'fabricmodjson'],
  ['modstoml', 'mods.toml', 'neoforge.mods.toml', 'modstoml'],
  ['entrypoint', 'entrypoint', '入口点', '入口'],
  ['packformat', 'pack_format', 'pack.mcmeta', 'packformat', 'mcmeta'],

  // 客户端与服务端
  ['server', '服务器', '服务端', '联机', '多人', '开服', '私服', 'server'],
  ['client', '客户端', 'client'],
  ['connection', '连接', '连不上', '连接失败', 'refused', '拒绝连接', 'connection'],
  ['timeout', '超时', 'timeout', 'timed out'],
  ['network', '网络', '联网', 'network', 'networking'],
  ['port', '端口', 'port'],
  ['firewall', '防火墙', 'firewall'],
  ['eula', 'eula', '用户协议'],
  ['whitelist', '白名单', 'whitelist'],
  ['proxy', '代理', 'proxy', 'vpn', '加速器'],
  ['onlinemode', '正版验证', '在线模式', 'onlinemode'],
  ['authlib', '外置登录', 'authlib', 'authlibinjector'],
  ['tps', 'tps', 'mspt', '卡服', '服务器性能'],
  ['serverproperties', 'server.properties', '服务端配置', 'serverproperties'],
  ['chunk', '区块', 'chunk', 'chunks', '区块加载'],
  ['world', '世界', 'world', 'worlds'],
  ['save', '存档', 'save', 'saves', '世界存档'],
  ['backup', '备份', '恢复', '还原', '回滚', 'backup'],

  // 登录与启动器
  ['launch', '启动', 'launch', 'launching', '开始游戏'],
  ['launcher', '启动器', 'launcher', 'launchers'],
  ['login', '登录', '登陆', 'login', 'signin', '认证'],
  ['session', '会话', 'token', '令牌', 'session', '凭证'],
  ['offline', '离线', '离线模式', 'offline'],
  ['args', '参数', 'args', 'arguments', '命令行', '游戏参数'],
  ['gamedir', '游戏目录', '游戏文件夹', '.minecraft', 'gamedir'],
  ['assets', 'assets', '资源文件', '资源索引', 'objects'],
  ['libraries', 'libraries', '库文件', '依赖库'],
  ['installer', '安装', '安装器', '安装程序', 'install', 'installer', '卸载'],
  ['verify', '校验', '验证', 'verify', 'checksum'],
  ['download', '下载', 'download', 'downloads', '下载失败'],
  ['mirror', '镜像', '镜像源', '加速源', 'bmclapi', 'mirror'],

  // 资源包 / 数据包 / 整合包
  ['resourcepack', '资源包', '材质包', '纹理包', 'resourcepack', 'resourcepacks', 'texturepack'],
  ['datapack', '数据包', 'datapack', 'datapacks'],
  ['model', '模型', 'model', 'models'],
  ['blockstate', '方块状态', 'blockstate', 'blockstates'],
  ['command', '指令', '命令', 'command', 'commands'],
  ['function', '函数', 'function', 'functions', 'mcfunction'],
  ['recipe', '配方', '合成表', 'recipe', 'recipes'],
  ['loot', '战利品', '掉落物', 'loot', 'loottable'],
  ['advancement', '进度', '成就', 'advancement', 'advancements'],
  ['manifest', '清单', 'manifest', 'manifest.json', '清单文件'],
  ['overrides', '覆盖文件', 'overrides', 'override'],
  ['modrinth', 'modrinth', 'mrpack'],
  ['curseforge', 'curseforge'],
  ['multimc', 'multimc', 'prism', 'prismlauncher', 'mmc'],
  ['hmcl', 'hmcl', 'pcl', 'pcl2'],

  // 版本与开发
  ['version', '版本', 'version', 'versions'],
  ['snapshot', '快照', 'snapshot', '快照版'],
  ['update', '更新', '升级', 'update', 'upgrade'],
  ['downgrade', '降级', '回退', 'downgrade'],
  ['minecraft', 'minecraft', 'mc', '我的世界'],
  ['gradle', 'gradle', 'gradlew', '构建', '编译', '构建失败'],
  ['ide', '开发环境', 'ide', 'idea', 'intellij'],
  ['toolchain', '工具链', 'toolchain']
]

/** token（已小写）→ canonical */
const SYNONYM_CANON = new Map<string, string>()
for (const group of SYNONYM_GROUPS) {
  const canon = group[0]
  if (!SYNONYM_CANON.has(canon)) SYNONYM_CANON.set(canon, canon)
  for (const member of group) {
    const key = member.toLowerCase()
    if (!SYNONYM_CANON.has(key)) SYNONYM_CANON.set(key, canon)
  }
}

/* ------------------------------------------------------------------ *
 *  分词
 * ------------------------------------------------------------------ */

const ASCII_TOKEN_RE = /[A-Za-z0-9_.\-]+/g
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** 简单词干化：去 ies→y / ing / ed / es / s（长度≥4） */
export function stemEnglishToken(token: string): string {
  if (token.length < 4) return token
  if (token.length >= 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length >= 6 && token.endsWith('ing')) return token.slice(0, -3)
  if (token.length >= 5 && token.endsWith('ed')) return token.slice(0, -2)
  if (token.length >= 5 && token.endsWith('es')) return token.slice(0, -2)
  if (token.length >= 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function isMeaningfulToken(token: string): boolean {
  return token.length >= 2 && !/^[._-]+$/.test(token)
}

/**
 * 英文/数字 token 的变体收集：
 *  - 原形与词干形都做同义词归一
 *  - 词干形额外补一个 +e 的猜测（requires → requir → require）
 *  - 含 . _ - 的 token 拆分出子 token（java.lang.OutOfMemoryError → outofmemoryerror）
 *  - 字母+数字（java8）拆出字母部分
 */
function collectEnglishVariants(raw: string, out: string[]): void {
  const cleaned = raw.toLowerCase()
  if (/^[._-]+$/.test(cleaned)) return
  const seen = new Set<string>()
  const push = (token: string | undefined): void => {
    if (token && isMeaningfulToken(token) && !seen.has(token)) {
      seen.add(token)
      out.push(token)
    }
  }
  const pushNormalized = (token: string): void => {
    push(SYNONYM_CANON.get(token) ?? token)
  }

  pushNormalized(cleaned)
  const stem = stemEnglishToken(cleaned)
  if (stem !== cleaned) {
    pushNormalized(stem)
    if (!stem.endsWith('e')) pushNormalized(`${stem}e`)
  }
  if (cleaned.includes('.') || cleaned.includes('-') || cleaned.includes('_')) {
    for (const part of cleaned.split(/[._-]+/)) {
      pushNormalized(part)
      const partStem = stemEnglishToken(part)
      if (partStem !== part) pushNormalized(partStem)
    }
    const lastDot = cleaned.lastIndexOf('.')
    if (lastDot > 0 && lastDot < cleaned.length - 1) pushNormalized(cleaned.slice(lastDot + 1))
  }
  const alphaNumeric = /^([a-z]+)(\d[\w.]*)$/.exec(cleaned)
  if (alphaNumeric) {
    pushNormalized(alphaNumeric[1])
    push(alphaNumeric[2])
  }
}

function collectCjkToken(token: string, out: string[]): void {
  const canon = SYNONYM_CANON.get(token)
  out.push(canon ?? token)
}

/** 对外暴露的分词函数：英文变体 + CJK 单字/bigram/trigram，统一同义词归一 */
export function tokenizeForSearch(text: string): string[] {
  const out: string[] = []
  if (!text) return out
  for (const match of text.matchAll(ASCII_TOKEN_RE)) collectEnglishVariants(match[0], out)
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0]
    for (let i = 0; i < run.length; i++) collectCjkToken(run[i], out)
    for (let i = 0; i + 2 <= run.length; i++) collectCjkToken(run.slice(i, i + 2), out)
    for (let i = 0; i + 3 <= run.length; i++) collectCjkToken(run.slice(i, i + 3), out)
  }
  return out
}

/* ------------------------------------------------------------------ *
 *  frontmatter（YAML 子集）解析
 * ------------------------------------------------------------------ */

interface ParsedFrontmatter {
  meta: Record<string, string | string[]>
  body: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function parseInlineArray(value: string): string[] {
  const inner = value.trim().slice(1, value.trim().endsWith(']') ? -1 : undefined)
  if (!inner.trim()) return []
  return inner
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item.length > 0)
}

/** 解析 Markdown 文件：frontmatter 区块 + 正文（正文不含 frontmatter） */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const lines = text.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { meta: {}, body: text.trim() }
  }
  const meta: Record<string, string | string[]> = {}
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') break
    const match = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    const rawValue = match[2]
    if (rawValue === '|' || rawValue === '|-' || rawValue === '>' || rawValue === '>-') {
      const block: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const next = lines[j]
        if (next.trim() === '') {
          block.push('')
          continue
        }
        if (!/^[ \t]/.test(next)) break
        block.push(next.replace(/^[ \t]+/, ''))
      }
      i = j - 1
      const joined = rawValue.startsWith('>')
        ? block.join(' ').replace(/\s+/g, ' ').trim()
        : block.join('\n').trim()
      meta[key] = joined
      continue
    }
    if (rawValue.trim().startsWith('[')) {
      meta[key] = parseInlineArray(rawValue)
      continue
    }
    meta[key] = unquote(rawValue)
  }
  const body = lines
    .slice(i + 1)
    .join('\n')
    .trim()
  return { meta, body }
}

function metaString(meta: Record<string, string | string[]>, key: string): string {
  const value = meta[key]
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.join(' ').trim()
  return ''
}

function metaArray(meta: Record<string, string | string[]>, key: string): string[] {
  const value = meta[key]
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

/* ------------------------------------------------------------------ *
 *  文档索引
 * ------------------------------------------------------------------ */

interface IndexedDoc {
  id: string
  title: string
  category: string
  tags: string[]
  summary: string
  body: string
  source: string
  updatedAt?: string
  related: string[]
  /** 小写化的整串匹配域 */
  normSummary: string
  normBody: string
  /** 错误码等精确 key 的查找域（小写） */
  searchText: string
  termCounts: Record<FieldName, Map<string, number>>
  fieldLengths: Record<FieldName, number>
}

interface LoadedIndex {
  docs: IndexedDoc[]
  byId: Map<string, IndexedDoc>
  df: Map<string, number>
  avgLen: Record<FieldName, number>
}

function countTokens(text: string): { counts: Map<string, number>; length: number } {
  const counts = new Map<string, number>()
  let length = 0
  for (const token of tokenizeForSearch(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
    length++
  }
  return { counts, length }
}

const RELATED_RE = /\[\[([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\]\]/gi

function extractRelated(body: string): string[] {
  const out = new Set<string>()
  for (const match of body.matchAll(RELATED_RE)) out.add(match[1].toLowerCase())
  return [...out]
}

function buildDoc(parsed: ParsedFrontmatter, relPath: string, source: string): IndexedDoc {
  const { meta, body } = parsed
  const fileName = relPath.split('/').pop() ?? relPath
  const fileStem = fileName.replace(/\.md$/i, '')
  const dirName = relPath.includes('/') ? relPath.split('/')[0] : ''
  const id = (metaString(meta, 'id') || fileStem).toLowerCase()
  const title = metaString(meta, 'title') || id
  const category = (metaString(meta, 'category') || dirName || 'misc').toLowerCase()
  const tags = metaArray(meta, 'tags')
  const summary = metaString(meta, 'summary')
  const updatedAt = metaString(meta, 'updatedAt') || undefined
  const related = extractRelated(body)

  const titleField = `${title} ${id}`
  const tagsField = tags.join(' ')
  const titleCount = countTokens(titleField)
  const tagsCount = countTokens(tagsField)
  const summaryCount = countTokens(summary)
  const bodyCount = countTokens(body)

  return {
    id,
    title,
    category,
    tags,
    summary,
    body,
    source,
    updatedAt,
    related,
    normSummary: summary.toLowerCase(),
    normBody: body.toLowerCase(),
    searchText: `${titleField} ${tagsField} ${summary} ${body}`.toLowerCase(),
    termCounts: {
      title: titleCount.counts,
      tags: tagsCount.counts,
      summary: summaryCount.counts,
      body: bodyCount.counts
    },
    fieldLengths: {
      title: titleCount.length,
      tags: tagsCount.length,
      summary: summaryCount.length,
      body: bodyCount.length
    }
  }
}

function buildLoadedIndex(docs: IndexedDoc[]): LoadedIndex {
  const byId = new Map<string, IndexedDoc>()
  const df = new Map<string, number>()
  const totals: Record<FieldName, number> = { title: 0, tags: 0, summary: 0, body: 0 }

  for (const doc of docs) {
    byId.set(doc.id, doc)
    const seenTerms = new Set<string>()
    for (const field of FIELDS) {
      totals[field] += doc.fieldLengths[field]
      for (const term of doc.termCounts[field].keys()) seenTerms.add(term)
    }
    for (const term of seenTerms) df.set(term, (df.get(term) ?? 0) + 1)
  }

  const avgLen: Record<FieldName, number> = { title: 0, tags: 0, summary: 0, body: 0 }
  const count = docs.length || 1
  for (const field of FIELDS) avgLen[field] = totals[field] / count

  return { docs, byId, df, avgLen }
}

/* ------------------------------------------------------------------ *
 *  评分辅助
 * ------------------------------------------------------------------ */

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category)
  return index >= 0 ? index : CATEGORY_ORDER.length
}

function toMeta(doc: IndexedDoc): KnowledgeDocMeta {
  return { id: doc.id, title: doc.title, category: doc.category, tags: [...doc.tags], summary: doc.summary }
}

/** 抽取查询中的「报错文本 / 错误码」精确 key */
export function extractExactKeys(query: string): string[] {
  const keys = new Set<string>()
  for (const match of query.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+/g)) {
    keys.add(match[0])
  }
  for (const match of query.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception|Violation|Failure|Overflow)\b/g)) {
    keys.add(match[0])
  }
  for (const match of query.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) keys.add(match[0])
  for (const match of query.matchAll(/-?\d{4,}|0x[0-9a-fA-F]{4,}/g)) keys.add(match[0])
  return [...keys].filter((key) => key.length >= 3).slice(0, 8)
}

function normalizePhrase(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 高亮/定位用的原始查询片段（不做同义词归一） */
function rawPieces(query: string): string[] {
  const pieces = new Set<string>()
  for (const match of query.matchAll(/[A-Za-z0-9_.\-]{2,}/g)) {
    if (!/^[._-]+$/.test(match[0])) pieces.add(match[0])
  }
  for (const match of query.matchAll(CJK_RUN_RE)) {
    const run = match[0]
    pieces.add(run)
    if (run.length > 2) {
      for (let i = 0; i + 2 <= run.length; i++) pieces.add(run.slice(i, i + 2))
    }
  }
  return [...pieces].sort((a, b) => b.length - a.length).slice(0, MAX_HIGHLIGHT_TERMS)
}

function highlight(text: string, terms: string[]): string {
  if (!terms.length) return text
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  return text.replace(pattern, '**$1**')
}

function buildExcerpt(doc: IndexedDoc, query: string): string {
  const body = doc.body
  const terms = rawPieces(query)
  const lowerBody = doc.normBody
  let index = -1
  let matchLength = 0

  const phrase = query.trim().toLowerCase()
  if (phrase.length >= 2) {
    const found = lowerBody.indexOf(phrase)
    if (found >= 0) {
      index = found
      matchLength = phrase.length
    }
  }
  if (index < 0) {
    for (const term of terms) {
      const found = lowerBody.indexOf(term.toLowerCase())
      if (found >= 0 && (index < 0 || found < index)) {
        index = found
        matchLength = term.length
      }
    }
  }
  if (index < 0) {
    const head = body.slice(0, EXCERPT_RADIUS * 2).trim()
    return body.length > head.length ? `${head}…` : head
  }
  const start = Math.max(0, index - EXCERPT_RADIUS)
  const end = Math.min(body.length, index + matchLength + EXCERPT_RADIUS)
  const fragment = highlight(body.slice(start, end), terms)
  return `${start > 0 ? '…' : ''}${fragment}${end < body.length ? '…' : ''}`
}

function scoreDoc(doc: IndexedDoc, terms: string[], keys: string[], normQuery: string, index: LoadedIndex): number {
  const total = index.docs.length || 1
  let score = 0
  for (const field of FIELDS) {
    const counts = doc.termCounts[field]
    const length = doc.fieldLengths[field]
    const avg = index.avgLen[field] || 1
    const lengthNorm = 1 - BM25_B + BM25_B * (length / avg)
    const weight = FIELD_WEIGHTS[field]
    for (const term of terms) {
      const tf = counts.get(term)
      if (!tf) continue
      const df = index.df.get(term) ?? 1
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      score += (weight * idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * lengthNorm)
    }
  }

  const keyHit = keys.length > 0 && keys.some((key) => doc.searchText.includes(key.toLowerCase()))
  if (score <= 0) {
    // 词元无交集但错误码精确命中时，仍以最小分召回
    if (keyHit) score = 0.01
    else return 0
  }

  // 整串精确匹配：正文 ×3、summary ×5
  if (normQuery.length >= 2) {
    if (doc.normBody.includes(normQuery)) score *= 3
    if (doc.normSummary.includes(normQuery)) score *= 5
  }
  // 报错文本 / 错误码精确命中 ×20
  if (keyHit) score *= 20

  return score
}

/* ------------------------------------------------------------------ *
 *  KnowledgeBase
 * ------------------------------------------------------------------ */

export class KnowledgeBase {
  private readonly roots: string[]
  private readonly userRoots: string[]
  private loaded: LoadedIndex | null = null
  private loading: Promise<LoadedIndex> | null = null

  constructor(options: KnowledgeIndexOptions) {
    this.roots = (options.roots ?? []).filter((root) => typeof root === 'string' && root.trim().length > 0)
    this.userRoots = (options.userRoots ?? []).filter((root) => typeof root === 'string' && root.trim().length > 0)
  }

  /** 加载/重建索引；默认使用内存缓存 */
  async load(opts?: { force?: boolean }): Promise<{ count: number; docs: KnowledgeDocMeta[] }> {
    if (opts?.force) {
      this.loaded = null
      this.loading = null
    }
    const index = await this.ensureLoaded()
    return { count: index.docs.length, docs: index.docs.map(toMeta) }
  }

  private async ensureLoaded(): Promise<LoadedIndex> {
    if (this.loaded) return this.loaded
    if (!this.loading) this.loading = this.buildIndex()
    try {
      const index = await this.loading
      this.loaded = index
      return index
    } finally {
      this.loading = null
    }
  }

  private async buildIndex(): Promise<LoadedIndex> {
    const byId = new Map<string, IndexedDoc>()
    const sources = [
      ...this.roots.map((root) => ({ root, user: false })),
      ...this.userRoots.map((root) => ({ root, user: true }))
    ]
    for (const { root } of sources) {
      let relPaths: string[] = []
      try {
        relPaths = await walkFiles(root, {
          maxDepth: 10,
          filter: (name) => !name.startsWith('_') && !name.startsWith('.')
        })
      } catch {
        continue
      }
      relPaths.sort()
      for (const relPath of relPaths) {
        if (!relPath.toLowerCase().endsWith('.md')) continue
        const segments = relPath.split('/')
        if (segments.some((segment) => segment.startsWith('_') || segment.startsWith('.'))) continue
        const fullPath = join(root, relPath)
        let text = ''
        try {
          const read = await readTextSmart(fullPath)
          text = read.text
        } catch {
          continue
        }
        const parsed = parseFrontmatter(text)
        const doc = buildDoc(parsed, relPath, fullPath)
        if (!doc.id) continue
        byId.set(doc.id, doc)
      }
    }
    const docs = [...byId.values()].sort((a, b) => {
      const rankDiff = categoryRank(a.category) - categoryRank(b.category)
      if (rankDiff !== 0) return rankDiff
      const categoryDiff = a.category.localeCompare(b.category)
      if (categoryDiff !== 0) return categoryDiff
      return a.title.localeCompare(b.title, 'zh-Hans-CN')
    })
    return buildLoadedIndex(docs)
  }

  /** BM25 检索；`category` 过滤在打分前执行 */
  async search(query: string, opts?: { limit?: number; category?: string }): Promise<KnowledgeHit[]> {
    const index = await this.ensureLoaded()
    const raw = (query ?? '').trim()
    if (!raw) return []
    const terms = [...new Set(tokenizeForSearch(raw))]
    const keys = extractExactKeys(raw)
    if (!terms.length && !keys.length) return []

    const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const category = opts?.category?.trim().toLowerCase()
    const normQuery = normalizePhrase(raw)

    const scored: { doc: IndexedDoc; score: number }[] = []
    for (const doc of index.docs) {
      if (category && doc.category !== category) continue
      const score = scoreDoc(doc, terms, keys, normQuery, index)
      if (score > 0) scored.push({ doc, score })
    }
    scored.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))

    return scored.slice(0, limit).map(({ doc, score }) => ({
      article: toMeta(doc),
      score: Number(score.toFixed(4)),
      excerpt: buildExcerpt(doc, raw)
    }))
  }

  /** 按 id 读取全文（正文不含 frontmatter；含 related 扩展字段） */
  async read(id: string): Promise<KnowledgeArticle | null> {
    const index = await this.ensureLoaded()
    const key = (id ?? '').trim().toLowerCase()
    if (!key) return null
    const doc = index.byId.get(key)
    if (!doc) return null
    const article: KnowledgeArticleDetail = {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      tags: [...doc.tags],
      summary: doc.summary,
      body: doc.body,
      source: doc.source,
      updatedAt: doc.updatedAt,
      related: doc.related.filter((relatedId) => index.byId.has(relatedId))
    }
    return article
  }

  async list(category?: string): Promise<KnowledgeDocMeta[]> {
    const index = await this.ensureLoaded()
    const filter = category?.trim().toLowerCase()
    return index.docs.filter((doc) => !filter || doc.category === filter).map(toMeta)
  }

  async categories(): Promise<string[]> {
    const index = await this.ensureLoaded()
    const found = new Set(index.docs.map((doc) => doc.category))
    return [...found].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
  }

  stats(): { count: number; categories: Record<string, number> } {
    const index = this.loaded
    if (!index) return { count: 0, categories: {} }
    const categories: Record<string, number> = {}
    for (const doc of index.docs) categories[doc.category] = (categories[doc.category] ?? 0) + 1
    return { count: index.docs.length, categories }
  }

  /** 生成供 Agent 直接注入上下文的目录文本 */
  catalog(opts?: { limit?: number; category?: string }): string {
    const index = this.loaded
    if (!index) return '知识库尚未加载，请先调用 load()。'
    const filter = opts?.category?.trim().toLowerCase()
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 1000))
    const lines: string[] = []
    const counts = new Map<string, number>()
    for (const doc of index.docs) counts.set(doc.category, (counts.get(doc.category) ?? 0) + 1)

    lines.push(`# MCAL 知识库目录（共 ${index.docs.length} 篇）`)
    let written = 0
    let currentCategory = ''
    for (const doc of index.docs) {
      if (filter && doc.category !== filter) continue
      if (written >= limit) break
      if (doc.category !== currentCategory) {
        currentCategory = doc.category
        lines.push('', `## ${currentCategory}（${counts.get(currentCategory) ?? 0} 篇）`)
      }
      const summary = doc.summary.length > 80 ? `${doc.summary.slice(0, 80)}…` : doc.summary
      lines.push(`- \`${doc.id}\` **${doc.title}**${summary ? ` — ${summary}` : ''}`)
      written++
    }
    if (written === 0) lines.push('', '（没有匹配的文章）')
    return lines.join('\n')
  }
}

export default KnowledgeBase
