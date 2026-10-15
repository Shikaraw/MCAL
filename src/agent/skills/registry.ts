/**
 * 技能系统：把「某类任务的完整做法」写成 Markdown 手册，按需加载。
 *
 * 与知识库的区别：知识库回答「这是什么/为什么」，技能回答「怎么做」。
 * 技能采用渐进式披露——系统提示里只放名称与描述，模型需要时才读全文，
 * 这样既能覆盖大量场景，又不会撑爆上下文。
 *
 * 技能文件格式（resources/skills/<name>/SKILL.md）：
 * ---
 * name: diagnose-crash
 * description: 分析崩溃报告并给出修复方案
 * whenToUse: 用户提供了崩溃报告或日志，或说"游戏崩溃了"
 * allowedTools: [read_file, grep, mc_diagnose]
 * ---
 * 正文（Markdown）
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { SkillContent, SkillMeta } from '@shared/types'
import { logger } from '@core/util/logger'
import { pathExists, readTextSmart, walkFiles, isDirectory } from '@core/util/fsx'

const log = logger.scoped('skills')

interface Frontmatter {
  name?: string
  description?: string
  whenToUse?: string
  allowedTools?: string[]
  knowledgeIds?: string[]
  version?: string
  author?: string
}

export class SkillRegistry {
  private roots: string[]
  private cache = new Map<string, SkillContent>()
  private loaded = false

  constructor(opts: { roots: string[] }) {
    this.roots = opts.roots.filter(Boolean)
  }

  setRoots(roots: string[]): void {
    this.roots = roots.filter(Boolean)
    this.cache.clear()
    this.loaded = false
  }

  /** 扫描所有技能目录；同名技能后出现的覆盖先出现的（用户目录优先） */
  async load(opts: { force?: boolean } = {}): Promise<SkillMeta[]> {
    if (this.loaded && !opts.force) return this.listSync()
    this.cache.clear()
    for (const root of this.roots) {
      if (!(await pathExists(root))) continue
      // 支持两种布局：<root>/<name>/SKILL.md 与 <root>/<name>.md
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
        const full = join(root, entry.name)
        if (entry.isDirectory()) {
          const skillFile = await this.findSkillFile(full)
          if (!skillFile) continue
          await this.loadSkillFile(skillFile, full)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          await this.loadSkillFile(full, root)
        }
      }
    }
    this.loaded = true
    log.info(`已加载 ${this.cache.size} 个技能`)
    return this.listSync()
  }

  private async findSkillFile(dir: string): Promise<string | null> {
    for (const candidate of ['SKILL.md', 'skill.md', 'README.md']) {
      const full = join(dir, candidate)
      if (await pathExists(full)) return full
    }
    return null
  }

  private async loadSkillFile(file: string, root: string): Promise<void> {
    try {
      const { text } = await readTextSmart(file, 512 * 1024)
      const { frontmatter, body } = parseSkillFile(text)
      const name = frontmatter.name ?? basename(dirname(file)) ?? basename(file, '.md')
      const skill: SkillContent = {
        name,
        description: frontmatter.description ?? firstLine(body) ?? '（无描述）',
        whenToUse: frontmatter.whenToUse,
        allowedTools: frontmatter.allowedTools,
        knowledgeIds: frontmatter.knowledgeIds,
        version: frontmatter.version,
        author: frontmatter.author,
        root,
        file,
        resources: await this.listResources(dirname(file)),
        body
      }
      this.cache.set(name, skill)
    } catch (err) {
      log.warn(`技能加载失败 ${file}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async listResources(skillDir: string): Promise<string[]> {
    if (!(await isDirectory(skillDir))) return []
    const files = await walkFiles(skillDir, { maxDepth: 3, limit: 200 })
    return files.filter((file) => !/(^|\/)(SKILL|skill|README)\.md$/i.test(file)).map((file) => join(skillDir, file))
  }

  private listSync(): SkillMeta[] {
    return [...this.cache.values()].map((skill) => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      root: skill.root,
      allowedTools: skill.allowedTools,
      knowledgeIds: skill.knowledgeIds,
      version: skill.version,
      author: skill.author,
      file: skill.file,
      resources: skill.resources
    }))
  }

  async list(): Promise<SkillMeta[]> {
    if (!this.loaded) await this.load()
    return this.listSync()
  }

  async read(name: string): Promise<SkillContent | null> {
    if (!this.loaded) await this.load()
    return this.cache.get(name) ?? null
  }

  /** 生成给系统提示的技能索引（token 友好） */
  renderIndex(maxChars = 1800): string {
    const skills = this.listSync()
    if (skills.length === 0) return ''
    const lines = ['## 可用技能（需要时用 skill_read 读取完整手册再动手）']
    let used = lines[0].length
    for (const skill of skills) {
      const line = `- ${skill.name}：${skill.description}${skill.whenToUse ? `（适用：${skill.whenToUse}）` : ''}`
      if (used + line.length > maxChars) break
      lines.push(line)
      used += line.length
    }
    return lines.join('\n')
  }
}

/** 解析带 frontmatter 的 Markdown */
export function parseSkillFile(text: string): { frontmatter: Frontmatter; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized.trim() }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, body: normalized.trim() }
  const rawFront = normalized.slice(3, end).trim()
  const body = normalized.slice(end + 4).replace(/^\n+/, '')
  return { frontmatter: parseSimpleYaml(rawFront), body: body.trim() }
}

function parseSimpleYaml(text: string): Frontmatter {
  const out: Frontmatter = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    // 多行块
    if (value === '|' || value === '>') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        block.push(lines[i + 1].replace(/^\s{2}/, ''))
        i++
      }
      value = block.join('\n')
    }
    const normalizedKey = key.charAt(0).toLowerCase() + key.slice(1)
    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      ;(out as Record<string, unknown>)[normalizedKey] = items
      continue
    }
    ;(out as Record<string, unknown>)[normalizedKey] = value.replace(/^["']|["']$/g, '')
  }
  return out
}

function firstLine(body: string): string | undefined {
  const line = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))
  return line?.trim().slice(0, 200)
}

/** 生成一个技能文件的模板（供 UI「新建技能」使用） */
export function skillTemplate(name: string): string {
  return `---
name: ${name}
description: 一句话说明这个技能做什么
whenToUse: 什么情况下应该使用这个技能
---

# ${name}

## 步骤

1. 第一步……
2. 第二步……

## 注意事项

- ……
`
}

export { stat, relative }
