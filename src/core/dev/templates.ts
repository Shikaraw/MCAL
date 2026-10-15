/**
 * 项目模板注册表
 *
 * 模板以「目录形态的真实文件」存放在 `resources/templates/<templateId>/` 下，
 * 目录里的文本文件使用 `{{variableName}}` 作为变量占位符（渲染由 Scaffolder 完成）。
 *
 * 每个模板目录必须包含 `template.json`，描述 id / 名称 / 类型 / 加载器 / 变量等元数据；
 * 缺失时按目录名推断（便于用户直接丢一个目录进去也能用）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LoaderType } from '@shared/types'
import { isDirectory, readJsonSafe, walkFiles } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('dev:templates')

/** 模板元数据文件名（不会被复制到目标目录） */
export const TEMPLATE_META_FILE = 'template.json'

/** 相对项目根目录的默认模板根 */
export const DEFAULT_TEMPLATES_RELATIVE = 'resources/templates'

export type TemplateKind = 'mod' | 'plugin' | 'shaderpack' | 'resourcepack' | 'datapack' | 'modpack'

export interface TemplateVariable {
  key: string
  label: string
  default?: string
  required?: boolean
  note?: string
}

export interface TemplateManifest {
  id: string
  name: string
  kind: TemplateKind
  loader?: LoaderType
  description: string
  variables: TemplateVariable[]
  /** 模板根目录（相对 resources/templates 为 dir，绝对路径见 absDir） */
  dir: string
  /** 需要跳过的文件/目录 */
  ignore?: string[]
  /** 生成后提示 */
  postInstallNote?: string
  /** 模板目录的绝对路径（扫描时补齐，便于 Scaffolder 读取） */
  absDir?: string
  /** 构建所需 JDK 主版本（模板可选声明，用于生成后续指引） */
  javaVersion?: number
  /** 构建工具（目前仅 gradle） */
  buildTool?: string
  /** 构建产物目录（相对工程根） */
  artifactDir?: string
  /** 产物应安装到的游戏子目录（mods / plugins / shaderpacks / resourcepacks …） */
  installDir?: string
  /** 模板针对的游戏版本（用于提示） */
  gameVersion?: string
}

const KINDS: TemplateKind[] = ['mod', 'plugin', 'shaderpack', 'resourcepack', 'datapack', 'modpack']

/** 二进制/非文本文件判定：含 NUL 字节即视为二进制 */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 把任意对象规范化为 TemplateVariable */
function normalizeVariable(raw: unknown): TemplateVariable | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const key = asString(record.key).trim()
  if (!key) return null
  const variable: TemplateVariable = {
    key,
    label: asString(record.label, key)
  }
  if (typeof record.default === 'string') variable.default = record.default
  if (record.required === true) variable.required = true
  if (typeof record.note === 'string') variable.note = record.note
  return variable
}

/** 按目录名推断模板类型（用户手写模板目录没带 template.json 时兜底） */
export function inferKindFromDirName(dirName: string): TemplateKind {
  const lower = dirName.toLowerCase()
  if (lower.startsWith('plugin') || lower.includes('plugin')) return 'plugin'
  if (lower.startsWith('shader') || lower.includes('iris') || lower.includes('optifine')) return 'shaderpack'
  if (lower.startsWith('resourcepack') || lower.includes('resourcepack')) return 'resourcepack'
  if (lower.startsWith('datapack') || lower.includes('datapack')) return 'datapack'
  if (lower.startsWith('modpack') || lower.includes('modpack')) return 'modpack'
  return 'mod'
}

/** 按目录名推断加载器（注意先判断 neoforge，避免被 forge 抢先匹配） */
export function inferLoaderFromDirName(dirName: string): LoaderType | undefined {
  const lower = dirName.toLowerCase()
  if (lower.includes('neoforge')) return 'neoforge'
  if (lower.includes('forge')) return 'forge'
  if (lower.includes('fabric')) return 'fabric'
  if (lower.includes('quilt')) return 'quilt'
  if (lower.includes('optifine') || lower.includes('iris')) return 'optifine'
  return undefined
}

/** 把 ignore 规则（支持 `*` 通配、目录前缀）转成正则 */
function ignorePatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  // 无斜杠的规则匹配任意层级的同名文件；有斜杠的规则按前缀匹配
  if (!pattern.includes('/')) return new RegExp(`(^|/)${escaped}$`)
  return new RegExp(`^${escaped}`)
}

export class TemplateRegistry {
  private readonly templatesRoot: string
  private cache: TemplateManifest[] | null = null

  constructor(opts: { templatesRoot: string }) {
    this.templatesRoot = resolve(opts.templatesRoot)
  }

  get root(): string {
    return this.templatesRoot
  }

  /** 扫描模板根目录下所有模板（读 template.json；缺失则按目录名推断） */
  async list(opts: { refresh?: boolean } = {}): Promise<TemplateManifest[]> {
    if (this.cache && !opts.refresh) return this.cache

    let entries: string[] = []
    try {
      const dirents = await readdir(this.templatesRoot, { withFileTypes: true })
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    } catch (err) {
      log.warn(`模板根目录不存在或不可读：${this.templatesRoot}（${(err as Error).message}）`)
      this.cache = []
      return this.cache
    }

    const manifests: TemplateManifest[] = []
    for (const dirName of entries) {
      const absDir = join(this.templatesRoot, dirName)
      const manifest = await this.readManifest(dirName, absDir)
      if (manifest) manifests.push(manifest)
    }
    manifests.sort((a, b) => a.id.localeCompare(b.id))
    this.cache = manifests
    return manifests
  }

  async get(id: string): Promise<TemplateManifest | null> {
    const all = await this.list()
    return all.find((m) => m.id === id) ?? null
  }

  /**
   * 读取模板的全部文件内容（惰性，不落盘）。
   * 跳过 template.json、ignore 规则命中的文件以及二进制文件（模板不携带二进制）。
   */
  async readFiles(id: string): Promise<{ path: string; content: string }[]> {
    const manifest = await this.get(id)
    if (!manifest) throw new Error(`模板不存在：${id}`)
    return this.readFilesOf(manifest)
  }

  /** 直接按清单读文件（Scaffolder 内部用，避免二次查表） */
  async readFilesOf(manifest: TemplateManifest): Promise<{ path: string; content: string }[]> {
    const absDir = manifest.absDir ?? join(this.templatesRoot, manifest.dir)
    const ignoreRegexes = (manifest.ignore ?? []).map(ignorePatternToRegExp)
    const relPaths = await walkFiles(absDir)
    const out: { path: string; content: string }[] = []

    for (const rel of relPaths) {
      if (rel === TEMPLATE_META_FILE) continue
      if (ignoreRegexes.some((re) => re.test(rel))) continue
      const buffer = await readFile(join(absDir, rel))
      if (looksBinary(buffer)) {
        log.warn(`模板 ${manifest.id} 中的二进制文件被跳过（脚手架不携带二进制）：${rel}`)
        continue
      }
      out.push({ path: rel, content: buffer.toString('utf8') })
    }
    out.sort((a, b) => a.path.localeCompare(b.path))
    return out
  }

  private async readManifest(dirName: string, absDir: string): Promise<TemplateManifest | null> {
    if (!(await isDirectory(absDir))) return null
    const metaPath = join(absDir, TEMPLATE_META_FILE)
    const raw = await readJsonSafe<Record<string, unknown> | null>(metaPath, null)

    if (!raw) {
      // 没有 template.json：按目录名推断，至少保证可用（变量为空，由调用方补充 name）
      const kind = inferKindFromDirName(dirName)
      log.warn(`模板目录缺少 ${TEMPLATE_META_FILE}，按目录名推断：${dirName} -> ${kind}`)
      return {
        id: dirName,
        name: dirName,
        kind,
        loader: inferLoaderFromDirName(dirName),
        description: `由目录名推断的模板（${dirName}），建议补充 ${TEMPLATE_META_FILE}`,
        variables: [],
        dir: dirName,
        absDir
      }
    }

    const id = asString(raw.id, dirName).trim() || dirName
    const rawKind = asString(raw.kind).trim() as TemplateKind
    const kind = KINDS.includes(rawKind) ? rawKind : inferKindFromDirName(dirName)
    const variables = Array.isArray(raw.variables)
      ? raw.variables.map(normalizeVariable).filter((v): v is TemplateVariable => v !== null)
      : []

    const manifest: TemplateManifest = {
      id,
      name: asString(raw.name, id),
      kind,
      description: asString(raw.description),
      variables,
      dir: dirName,
      absDir
    }
    const loader = asString(raw.loader).trim() as LoaderType
    if (loader) manifest.loader = loader
    if (Array.isArray(raw.ignore)) {
      manifest.ignore = raw.ignore.filter((x): x is string => typeof x === 'string')
    }
    if (typeof raw.postInstallNote === 'string') manifest.postInstallNote = raw.postInstallNote
    if (typeof raw.javaVersion === 'number') manifest.javaVersion = raw.javaVersion
    if (typeof raw.buildTool === 'string') manifest.buildTool = raw.buildTool
    if (typeof raw.artifactDir === 'string') manifest.artifactDir = raw.artifactDir
    if (typeof raw.installDir === 'string') manifest.installDir = raw.installDir
    if (typeof raw.gameVersion === 'string') manifest.gameVersion = raw.gameVersion
    return manifest
  }
}

/** 解析默认模板根：优先 resources/templates（打包后 cwd 可能不同，调用方可传 appRoot） */
export function resolveDefaultTemplatesRoot(appRoot = process.cwd()): string {
  return resolve(appRoot, DEFAULT_TEMPLATES_RELATIVE)
}
