/**
 * 内置种子文章（可选）
 *
 * 内置知识库的主体内容以 Markdown 形式存放在 `resources/knowledge/`，
 * 由 `KnowledgeBase` 在运行时扫描加载；这里保留一个空的种子数组，
 * 供打包场景或测试将文章直接内联进代码时使用，避免额外维护两份内容。
 */

import type { KnowledgeArticle } from '@shared/types'

export const SEED_ARTICLES: KnowledgeArticle[] = []
