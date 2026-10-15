/**
 * 元工具：任务清单、技能读取、知识库检索、记忆读写。
 * 这些工具让 Agent 具备「自我管理」与「查资料」的能力。
 */

import type { ToolInvocationContext } from '@shared/types'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  requireStringArray,
  type ToolDefinitionWithHandler
} from './registry'
import type { SkillRegistry } from '@agent/skills/registry'

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  note?: string
}

/** 会话级待办（每个会话一份，由 harness 注入读写函数） */
export interface TodoStore {
  read(): TodoItem[]
  write(items: TodoItem[]): void
}

export function createTodoTools(store: TodoStore): ToolDefinitionWithHandler[] {
  const todoWrite: ToolDefinitionWithHandler = {
    name: 'todo_write',
    description:
      '维护当前任务的待办清单（覆盖式写入）。当任务需要 3 步以上、或用户给了多个要求时，用它把计划列出来并持续更新状态。' +
      '状态只能是 pending / in_progress / completed，且同一时刻最多一个 in_progress。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的待办列表（会整体替换旧列表）',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '待办内容' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              note: { type: 'string', description: '备注（可选）' }
            },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    },
    category: 'meta',
    readOnly: false,
    handler: async (args, ctx) => {
      const raw = args.todos
      if (!Array.isArray(raw)) return { ok: false, output: '参数 todos 必须是数组' }
      const items: TodoItem[] = raw.map((item, index) => {
        const obj = (item ?? {}) as Record<string, unknown>
        const status = String(obj.status ?? 'pending')
        return {
          id: `todo_${index + 1}`,
          content: String(obj.content ?? ''),
          status: status === 'in_progress' || status === 'completed' ? status : 'pending',
          note: typeof obj.note === 'string' ? obj.note : undefined
        }
      })
      store.write(items)
      ctx.emit({ type: 'ui_event', channel: 'todo', payload: items })
      const render = items
        .map((item) => `${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'} ${item.content}`)
        .join('\n')
      return { ok: true, output: `待办已更新（${items.length} 项）：\n${render}`, meta: { todos: items } }
    }
  }
  return [todoWrite]
}

export function createSkillTools(registry: SkillRegistry): ToolDefinitionWithHandler[] {
  const listSkills: ToolDefinitionWithHandler = {
    name: 'skill_list',
    description: '列出当前可用的技能（工作手册）。技能里包含特定任务的详细步骤与最佳实践，遇到对应场景时应先读技能再动手。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'meta',
    readOnly: true,
    handler: async () => {
      const skills = await registry.list()
      if (skills.length === 0) return { ok: true, output: '当前没有安装任何技能。' }
      const lines = skills.map(
        (skill) => `- ${skill.name}：${skill.description}${skill.whenToUse ? `\n  何时使用：${skill.whenToUse}` : ''}`
      )
      return { ok: true, output: `可用技能（${skills.length} 个）：\n${lines.join('\n')}`, meta: { count: skills.length } }
    }
  }

  const readSkill: ToolDefinitionWithHandler = {
    name: 'skill_read',
    description: '读取指定技能的完整内容（工作手册正文 + 附带资源清单）。读完请按技能里的步骤执行。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名称（来自 skill_list）' } },
      required: ['name']
    },
    category: 'meta',
    readOnly: true,
    handler: async (args) => {
      const name = requireString(args, 'name')
      const skill = await registry.read(name)
      if (!skill) {
        const available = (await registry.list()).map((s) => s.name).join('、')
        return { ok: false, output: `技能不存在：${name}。可用技能：${available || '（无）'}` }
      }
      const resources =
        skill.resources && skill.resources.length > 0
          ? `\n\n## 附带资源\n${skill.resources.map((r) => `- ${r}`).join('\n')}`
          : ''
      return {
        ok: true,
        output: `# 技能：${skill.name}\n\n${skill.body}${resources}`,
        meta: { skill: skill.name }
      }
    }
  }

  return [listSkills, readSkill]
}

export function createKnowledgeTools(knowledge: ToolInvocationContext['services']['knowledge']): ToolDefinitionWithHandler[] {
  const search: ToolDefinitionWithHandler = {
    name: 'search_knowledge',
    description:
      '检索 Minecraft 知识库（内置 50+ 篇中文文档，覆盖崩溃、Java、模组、加载器、光影、资源包、服务端、开发等）。' +
      '遇到报错、需要解释机制、或要给用户操作步骤时，先检索知识库再回答，避免凭记忆给出过时或错误的结论。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询文本。可以直接粘贴报错原文（检索效果最好），也可以是问题描述' },
        limit: { type: 'number', description: '返回条数，默认 5' },
        category: { type: 'string', description: '限定分类，可选 crash/java/mod/loader/graphics/resourcepack/launcher/server/dev/pack/misc' }
      },
      required: ['query']
    },
    category: 'knowledge',
    readOnly: true,
    handler: async (args) => {
      const query = requireString(args, 'query')
      const hits = await knowledge.search(query, {
        limit: optionalNumber(args, 'limit', 5) ?? 5,
        category: optionalString(args, 'category')
      })
      if (hits.length === 0) {
        return { ok: true, output: `知识库中没有与「${query}」相关的条目。可以换个说法，或直接用 read_knowledge 读取你已知的文章 id。` }
      }
      const blocks = hits.map(
        (hit, index) =>
          `${index + 1}. [${hit.article.id}] ${hit.article.title}（分类：${hit.article.category}，相关度 ${hit.score.toFixed(2)}）\n   摘要：${hit.article.summary}\n   片段：${hit.excerpt.replace(/\n/g, ' ').slice(0, 400)}`
      )
      return {
        ok: true,
        output: `知识库检索结果（${hits.length} 条）：\n\n${blocks.join('\n\n')}\n\n如需完整内容请用 read_knowledge 读取对应 id。`,
        meta: { hits: hits.map((h) => h.article.id) }
      }
    }
  }

  const read: ToolDefinitionWithHandler = {
    name: 'read_knowledge',
    description: '读取知识库某篇文章的完整内容（需要先通过 search_knowledge 拿到 id，或已知 id）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '文章 id，例如 crash-out-of-memory' } },
      required: ['id']
    },
    category: 'knowledge',
    readOnly: true,
    handler: async (args) => {
      const id = requireString(args, 'id')
      const article = await knowledge.read(id)
      if (!article) return { ok: false, output: `知识库中没有 id 为 ${id} 的文章。` }
      return {
        ok: true,
        output: `# ${article.title}\n\n分类：${article.category}｜标签：${article.tags.join(', ')}\n\n${article.body}`,
        meta: { id }
      }
    }
  }

  const list: ToolDefinitionWithHandler = {
    name: 'list_knowledge',
    description: '列出知识库的目录（按分类），用于了解知识库覆盖范围。',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', description: '限定分类（可选）' } },
      required: []
    },
    category: 'knowledge',
    readOnly: true,
    handler: async (args) => {
      const items = await knowledge.list(optionalString(args, 'category'))
      const grouped = new Map<string, string[]>()
      for (const item of items) {
        const list = grouped.get(item.category) ?? []
        list.push(`  - [${item.id}] ${item.title}`)
        grouped.set(item.category, list)
      }
      const text = [...grouped.entries()].map(([category, lines]) => `${category}（${lines.length} 篇）：\n${lines.join('\n')}`).join('\n\n')
      return { ok: true, output: `知识库目录（共 ${items.length} 篇）：\n\n${text}`, meta: { count: items.length } }
    }
  }

  return [search, read, list]
}

export function createMemoryTools(memory: ToolInvocationContext['services']['memory']): ToolDefinitionWithHandler[] {
  const search: ToolDefinitionWithHandler = {
    name: 'memory_search',
    description:
      '检索历史记忆：这台机器上以前遇到过的问题及其解决方案。修复问题前先查一下，避免重复踩坑；也可以用来了解用户的使用习惯。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询文本（问题描述或报错）' },
        limit: { type: 'number', description: '返回条数，默认 5' }
      },
      required: ['query']
    },
    category: 'memory',
    readOnly: true,
    handler: async (args) => {
      const query = requireString(args, 'query')
      const results = await memory.search(query, { limit: optionalNumber(args, 'limit', 5) ?? 5 })
      if (results.length === 0) return { ok: true, output: '没有找到相关的历史记忆。' }
      const blocks = results.map(
        (item, index) =>
          `${index + 1}. [${item.record.id}] ${item.record.problem}（相关度 ${item.score.toFixed(2)}${item.record.verified ? '，已验证' : ''}）\n   原因：${item.record.cause ?? '未记录'}\n   方案：${item.record.solution.replace(/\n/g, ' ').slice(0, 500)}`
      )
      return { ok: true, output: `历史记忆（${results.length} 条）：\n\n${blocks.join('\n\n')}`, meta: { ids: results.map((r) => r.record.id) } }
    }
  }

  const write: ToolDefinitionWithHandler = {
    name: 'memory_write',
    description:
      '把「问题 → 解决方案」写入长期记忆，供以后复用。' +
      '在下列时机必须写入：(1) 成功定位并修复了一个报错；(2) 用户说明了某个配置/操作的原因，值得记住；(3) 发现某模组组合有坑。' +
      'problem 用一句话描述现象，solution 写清具体操作与参数。',
    parameters: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: '问题的一句话描述（现象）' },
        solution: { type: 'string', description: '解决方案（具体步骤与参数）' },
        cause: { type: 'string', description: '根本原因（如果能确定）' },
        symptoms: { type: 'array', items: { type: 'string' }, description: '症状关键词（报错类名、错误码等），便于以后召回' },
        verified: { type: 'boolean', description: '是否已验证有效（用户确认修复成功才为 true）' },
        gameVersion: { type: 'string', description: '涉及的 MC 版本' },
        loaderType: { type: 'string', description: '涉及的加载器：vanilla/forge/neoforge/fabric/quilt/optifine' },
        instanceId: { type: 'string', description: '涉及的实例 id' },
        tags: { type: 'array', items: { type: 'string' }, description: '附加标签' }
      },
      required: ['problem', 'solution']
    },
    category: 'memory',
    handler: async (args, ctx) => {
      const record = await memory.write({
        problem: requireString(args, 'problem'),
        solution: requireString(args, 'solution'),
        cause: optionalString(args, 'cause'),
        symptoms: Array.isArray(args.symptoms) ? requireStringArray(args, 'symptoms') : undefined,
        verified: optionalBoolean(args, 'verified'),
        origin: 'agent',
        tags: Array.isArray(args.tags) ? requireStringArray(args, 'tags') : undefined,
        context: {
          gameVersion: optionalString(args, 'gameVersion'),
          loaderType: optionalString(args, 'loaderType') as never,
          instanceId: optionalString(args, 'instanceId')
        }
      })
      ctx.emit({ type: 'ui_event', channel: 'memory_written', payload: record })
      return { ok: true, output: `已写入记忆 [${record.id}]：${record.problem}`, meta: { id: record.id } }
    }
  }

  return [search, write]
}
