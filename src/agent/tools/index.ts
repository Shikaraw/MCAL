/** 工具集装配：把所有工具注册进一个 Registry。 */

import type { AgentServices } from '@shared/types'
import { ToolRegistry, type ToolDefinitionWithHandler } from './registry'
import { filesystemTools } from './fs'
import { shellTools } from './shell'
import { createKnowledgeTools, createMemoryTools, createSkillTools, createTodoTools, type TodoStore } from './meta'
import { createLauncherTools } from './mc'
import { createDevTools, createMediaTools } from './dev'
import type { SkillRegistry } from '@agent/skills/registry'

export interface BuildRegistryOptions {
  services: AgentServices
  skills: SkillRegistry
  todos: TodoStore
  /** 是否注册命令执行工具 */
  enableShell: boolean
}

export function buildToolRegistry(options: BuildRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry()
  const tools: ToolDefinitionWithHandler[] = [
    ...createLauncherTools(),
    ...createKnowledgeTools(options.services.knowledge),
    ...createMemoryTools(options.services.memory),
    ...createSkillTools(options.skills),
    ...createTodoTools(options.todos),
    ...filesystemTools,
    ...createDevTools(),
    ...createMediaTools()
  ]
  if (options.enableShell) tools.push(...shellTools)
  registry.registerAll(tools)
  return registry
}

export { ToolRegistry, filesystemTools, shellTools }
export type { ToolDefinitionWithHandler }
export * from './registry'
