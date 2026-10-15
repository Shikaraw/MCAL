/**
 * 知识库浏览页。
 *
 * 左：分类目录 + 全文检索（BM25 相关度 + 命中片段）
 * 右：文章正文（Markdown 渲染）
 *
 * 这份知识库是启动器内置的，AI 助手在回答时会检索这里的内容；
 * 用户也可以把自己的笔记丢进用户知识库目录，同名 id 会覆盖内置文章。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KnowledgeArticle, KnowledgeHit } from '@shared/types'
import { mcal } from '../lib/api'
import { formatRelativeTime } from '../lib/format'
import { reportError, toast, useSettings } from '../state/store'
import { Badge, Button, Empty, SearchInput } from '../components/ui/primitives'
import { Markdown } from '../components/ui/Markdown'
import { IconBook, IconChevronDown, IconFile, IconFolder, IconRefresh, IconSearch } from '../components/ui/icons'

interface CatalogItem {
  id: string
  title: string
  category: string
  tags: string[]
  summary: string
}

const CATEGORY_LABELS: Record<string, string> = {
  crash: '崩溃排查',
  dev: '模组 / 插件开发',
  graphics: '图形与光影',
  java: 'Java 环境',
  launcher: '启动器使用',
  loader: '加载器',
  misc: '其他',
  mod: '模组',
  pack: '整合包',
  resourcepack: '资源包',
  server: '服务端'
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

const USER_KNOWLEDGE_RELATIVE = 'user-resources/knowledge'

export function KnowledgeView(): React.JSX.Element {
  const settings = useSettings((state) => state.settings)

  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [article, setArticle] = useState<KnowledgeArticle | null>(null)
  const [articleLoading, setArticleLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[]>([])
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<string[]>([])

  const loadCatalog = useCallback(async () => {
    setLoading(true)
    try {
      const list = await mcal.listKnowledge()
      setCatalog(list)
      return list
    } catch (error) {
      reportError(error, '读取知识库目录失败')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const list = await loadCatalog()
      if (list.length > 0 && !selectedId) void openArticle(list[0].id)
    })()
    // 只在挂载时自动选中第一篇
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadCatalog])

  const openArticle = useCallback(async (id: string) => {
    setSelectedId(id)
    setArticleLoading(true)
    try {
      const detail = await mcal.readKnowledge(id)
      if (!detail) {
        toast.warn('文章不存在', `id：${id}`)
        setArticle(null)
        return
      }
      setArticle(detail)
    } catch (error) {
      reportError(error, '读取文章失败')
    } finally {
      setArticleLoading(false)
    }
  }, [])

  const runSearch = useCallback(async (text: string) => {
    setQuery(text)
    if (!text.trim()) {
      setHits([])
      return
    }
    setSearching(true)
    try {
      const result = await mcal.searchKnowledge(text, 30)
      setHits(result)
      if (result.length > 0) void openArticle(result[0].article.id)
    } catch (error) {
      reportError(error, '检索知识库失败')
    } finally {
      setSearching(false)
    }
  }, [openArticle])

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogItem[]>()
    for (const item of catalog) {
      const list = map.get(item.category) ?? []
      list.push(item)
      map.set(item.category, list)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [catalog])

  const openUserKnowledgeDir = useCallback(async () => {
    const root = settings?.rootDir
    if (!root) {
      toast.warn('还没读到数据目录', '稍等片刻再试，或到「设置 → 关于」里查看')
      return
    }
    const target = `${root.replace(/[\\/]+$/, '')}/${USER_KNOWLEDGE_RELATIVE}`
    try {
      await mcal.openPath(target)
    } catch {
      // 目录还不存在时退回到数据目录，并说明该在哪里创建
      try {
        await mcal.openPath(root)
        toast.info('用户知识库目录还不存在', `请在 ${USER_KNOWLEDGE_RELATIVE} 下放 Markdown 文章（同名 id 会覆盖内置内容）`)
      } catch (error) {
        reportError(error, '打开目录失败')
      }
    }
  }, [settings?.rootDir])

  const searchingMode = query.trim().length > 0

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>知识库</h2>
          <span className="fs-sm muted">
            这是启动器内置的 Minecraft 知识库，AI 助手在回答时会检索这里的内容。你也可以把自己的笔记放进用户知识库目录
          </span>
        </div>
        <div className="row gap-2">
          <Button icon={<IconFolder size={14} />} onClick={() => void openUserKnowledgeDir()}>
            打开用户知识库目录
          </Button>
          <Button icon={<IconRefresh size={14} />} loading={loading} onClick={() => void loadCatalog()}>
            刷新
          </Button>
        </div>
      </div>

      <div className="page__body" style={{ overflow: 'hidden' }}>
        <div className="split" style={{ height: '100%' }}>
          {/* ------------------------------ 左栏 ------------------------------ */}
          <aside className="split__aside col gap-3" style={{ paddingRight: 4 }}>
            <SearchInput
              value={query}
              onChange={(value) => setQuery(value)}
              onEnter={() => void runSearch(query)}
              placeholder="检索知识库，例如：模组冲突、内存不足"
            />
            <div className="row gap-2">
              <Button size="sm" variant="primary" icon={<IconSearch size={13} />} loading={searching} onClick={() => void runSearch(query)}>
                检索
              </Button>
              {searchingMode ? (
                <Button size="sm" variant="ghost" onClick={() => void runSearch('')}>
                  返回分类
                </Button>
              ) : null}
            </div>

            {searchingMode ? (
              <div className="col gap-2">
                <div className="fs-xs muted">
                  {hits.length > 0 ? `命中 ${hits.length} 篇（按相关度排序）` : '没有命中结果，试试更短的关键词'}
                </div>
                <div className="col gap-2 stagger">
                  {hits.map((hit) => (
                    <HitRow
                      key={`${hit.article.id}`}
                      hit={hit}
                      active={hit.article.id === selectedId}
                      onClick={() => void openArticle(hit.article.id)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="col gap-2">
                {grouped.map(([category, items]) => {
                  const isCollapsed = collapsed.includes(category)
                  return (
                    <div key={category} className="mcal-panel" style={{ overflow: 'hidden' }}>
                      <button
                        type="button"
                        className="row-between"
                        style={{ width: '100%', padding: '9px 12px', textAlign: 'left' }}
                        onClick={() =>
                          setCollapsed((list) =>
                            list.includes(category) ? list.filter((item) => item !== category) : [...list, category]
                          )
                        }
                      >
                        <span className="row gap-2 fs-sm bold">
                          <IconBook size={13} className="accent" />
                          {categoryLabel(category)}
                        </span>
                        <span className="row gap-2">
                          <span className="fs-xs muted">{items.length} 篇</span>
                          <IconChevronDown
                            size={13}
                            className="muted"
                            style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform var(--t-fast)' }}
                          />
                        </span>
                      </button>
                      {!isCollapsed ? (
                        <div className="col" style={{ padding: '0 6px 8px' }}>
                          {items.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              className="row gap-2"
                              onClick={() => void openArticle(item.id)}
                              style={{
                                padding: '6px 8px',
                                borderRadius: 8,
                                textAlign: 'left',
                                background: item.id === selectedId ? 'rgba(61,220,132,0.12)' : 'transparent',
                                color: item.id === selectedId ? 'var(--c-verdant)' : 'var(--c-text-soft)'
                              }}
                              title={item.summary}
                            >
                              <IconFile size={12} style={{ flexShrink: 0 }} />
                              <span className="fs-sm truncate">{item.title}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                {!loading && grouped.length === 0 ? (
                  <div className="fs-sm muted" style={{ padding: 8 }}>
                    知识库为空。可以把 Markdown 文章放进用户知识库目录后点「刷新」。
                  </div>
                ) : null}
                {loading ? <div className="skeleton" style={{ height: 60 }} /> : null}
              </div>
            )}
          </aside>

          {/* ------------------------------ 右栏 ------------------------------ */}
          <main className="split__main">
            {articleLoading ? (
              <div className="col gap-3">
                <div className="skeleton" style={{ height: 28, width: '45%' }} />
                <div className="skeleton" style={{ height: 14, width: '25%' }} />
                <div className="skeleton" style={{ height: 220 }} />
              </div>
            ) : article ? (
              <article className="col gap-4 anim-fade" style={{ maxWidth: 820 }}>
                <div className="col gap-2">
                  <h2>{article.title}</h2>
                  <div className="row gap-2 wrap">
                    <Badge tone="info">{categoryLabel(article.category)}</Badge>
                    {article.tags.map((tag) => (
                      <span key={tag} className="mcal-badge">
                        #{tag}
                      </span>
                    ))}
                    {article.updatedAt ? (
                      <span className="fs-xs muted">更新于 {formatRelativeTime(article.updatedAt)}</span>
                    ) : null}
                    {article.source ? <span className="fs-xs faint">{article.source}</span> : null}
                  </div>
                  {article.summary ? <div className="fs-sm dim">{article.summary}</div> : null}
                </div>
                <div className="mcal-divider" />
                <Markdown content={article.body} />
              </article>
            ) : (
              <div className="center" style={{ height: '100%' }}>
                <Empty
                  icon={<IconBook />}
                  title="选择左侧的文章开始阅读"
                  description="也可以在顶部检索：AI 助手回答问题时用的就是这套内容，特别适合查报错原因与修复步骤。"
                />
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  检索命中行
 * ------------------------------------------------------------------ */

function HitRow({ hit, active, onClick }: { hit: KnowledgeHit; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`mcal-card ${active ? 'mcal-card--selected' : 'mcal-card--interactive'}`}
      style={{ padding: '10px 12px', textAlign: 'left' }}
      onClick={onClick}
    >
      <div className="row-between gap-2">
        <span className="fs-sm bold truncate">{hit.article.title}</span>
        <Badge tone="gold">{hit.score.toFixed(1)}</Badge>
      </div>
      <div className="fs-xs muted" style={{ marginTop: 4 }}>
        {categoryLabel(hit.article.category)}
      </div>
      <div className="fs-xs dim clamp-3" style={{ marginTop: 4, lineHeight: 'var(--lh-relaxed)' }}>
        {hit.excerpt}
      </div>
    </button>
  )
}
