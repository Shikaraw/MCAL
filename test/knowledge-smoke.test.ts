import { describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { KnowledgeBase } from '@knowledge/index'

const ROOT = resolve('resources/knowledge')
const kb = new KnowledgeBase({ roots: [ROOT] })

const MIN_PER_CATEGORY: Record<string, number> = {
  crash: 12,
  java: 5,
  mod: 6,
  loader: 6,
  graphics: 5,
  resourcepack: 3,
  launcher: 4,
  server: 4,
  dev: 5,
  pack: 2,
  misc: 3
}

describe('KnowledgeBase', () => {
  it('loads the built-in knowledge base and covers every required category', async () => {
    const { count, docs } = await kb.load()
    expect(count).toBeGreaterThanOrEqual(45)
    expect(docs.every((doc) => doc.id && doc.title && doc.category && doc.summary)).toBe(true)

    const stats = kb.stats()
    expect(stats.count).toBe(count)
    for (const [category, minimum] of Object.entries(MIN_PER_CATEGORY)) {
      expect(stats.categories[category] ?? 0, `category ${category}`).toBeGreaterThanOrEqual(minimum)
    }
    expect(await kb.categories()).toContain('graphics')
  })

  it('ranks the correct article first for error-text and synonym queries', async () => {
    const cases: [string, string][] = [
      ['java.lang.OutOfMemoryError: Java heap space', 'crash-out-of-memory'],
      ['Exit Code: -1073741819', 'crash-exit-codes'],
      ['Unsupported class file major version 65', 'java-unsupported-class-version'],
      ['光影黑屏闪烁', 'graphics-shader-issues'],
      ['资源包不兼容 pack_format', 'resourcepack-not-working'],
      ['连不上服务器 Connection refused', 'server-connection-troubleshooting'],
      ['Mixin apply failed 注入失败', 'crash-mixin-failed'],
      ['帧数低 卡顿 优化', 'graphics-fps-tuning']
    ]
    for (const [query, expected] of cases) {
      const hits = await kb.search(query)
      expect(hits.length, query).toBeGreaterThan(0)
      expect(hits[0]?.article.id, query).toBe(expected)
      expect(hits[0]?.excerpt.length, query).toBeGreaterThan(20)
    }
  })

  it('expands Chinese synonyms and rewards exact phrase/code matches', async () => {
    const oom = await kb.search('内存不足 报错')
    expect(oom.some((hit) => hit.article.id === 'crash-out-of-memory')).toBe(true)

    const shader = await kb.search('光影不生效')
    expect(shader.some((hit) => hit.article.id === 'graphics-shader-basics')).toBe(true)

    // 错误码精确命中应远超普通词元命中
    const code = await kb.search('-1073741819')
    expect(code[0]?.article.id).toBe('crash-exit-codes')
    expect(code[0]?.score).toBeGreaterThan(100)
  })

  it('supports category filtering, list, catalog and limits', async () => {
    const javaHits = await kb.search('java', { category: 'java', limit: 3 })
    expect(javaHits.length).toBeLessThanOrEqual(3)
    expect(javaHits.every((hit) => hit.article.category === 'java')).toBe(true)

    expect((await kb.list('java')).length).toBeGreaterThanOrEqual(5)
    expect(await kb.search('   ')).toEqual([])
    expect(await kb.search('java', { category: 'no-such-category' })).toEqual([])

    const one = await kb.search('崩溃', { limit: 1 })
    expect(one.length).toBe(1)

    const catalog = kb.catalog({ category: 'java', limit: 10 })
    expect(catalog).toContain('java-version-matrix')
    expect(catalog).toContain('共')
  })

  it('reads articles with [[id]] relations and rejects unknown ids', async () => {
    const article = await kb.read('crash-out-of-memory')
    expect(article?.id).toBe('crash-out-of-memory')
    expect(article?.body).toContain('OutOfMemoryError')
    expect(article?.body.startsWith('---')).toBe(false)

    const related = (article as { related?: string[] }).related ?? []
    expect(related).toContain('java-memory-flags')
    expect(related.every((id) => typeof id === 'string')).toBe(true)

    expect(await kb.read('does-not-exist')).toBeNull()
    expect(await kb.read('')).toBeNull()
  })

  it('lets userRoots override built-in articles with the same id', async () => {
    const root = join(tmpdir(), `mcal-kb-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'override.md'),
      ['---', 'id: crash-out-of-memory', 'title: 用户自定义 OOM', 'category: crash', 'tags: [自定义]', 'summary: 用户覆盖版', '---', '', '## 症状', '这是用户覆盖的内容。', ''].join('\n'),
      'utf8'
    )
    try {
      const custom = new KnowledgeBase({ roots: [ROOT], userRoots: [root] })
      const { count } = await custom.load()
      expect(count).toBe(57)
      const article = await custom.read('crash-out-of-memory')
      expect(article?.title).toBe('用户自定义 OOM')
      expect(article?.body).toContain('用户覆盖的内容')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
