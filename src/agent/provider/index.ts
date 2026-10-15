/** Provider 工厂：根据设置创建具体实现。 */

import type { ProviderSettings } from '@shared/types'
import { OpenAiCompatibleProvider } from './openai'
import type { ChatProvider } from './types'

/** 内置服务商预设，方便用户一键配置 */
export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  model: string
  models: string[]
  capabilities: NonNullable<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]>['capabilities']
  note: string
  docsUrl?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    capabilities: { tools: true, vision: false, reasoning: true, promptCache: true },
    note: '官方 API，支持工具调用与上下文缓存计费；deepseek-reasoner 支持深度思考但工具调用能力较弱',
    docsUrl: 'https://platform.deepseek.com'
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    capabilities: { tools: true, vision: false, reasoning: false, promptCache: true },
    note: '长上下文友好，适合阅读大型日志与整合包清单',
    docsUrl: 'https://platform.moonshot.cn'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    capabilities: { tools: true, vision: true, reasoning: true, promptCache: false },
    note: 'glm-4v 系列支持看图，可直接分析游戏截图',
    docsUrl: 'https://open.bigmodel.cn'
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    capabilities: { tools: true, vision: true, reasoning: true, promptCache: false },
    note: 'OpenAI 兼容模式；qwen-vl 系列可看截图',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    capabilities: { tools: true, vision: false, reasoning: false, promptCache: false },
    note: '聚合多家开源模型，价格便宜',
    docsUrl: 'https://siliconflow.cn'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    models: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
    capabilities: { tools: true, vision: true, reasoning: false, promptCache: false },
    note: '聚合网关，可访问多种模型；部分模型不支持工具调用',
    docsUrl: 'https://openrouter.ai'
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
    models: ['qwen2.5:14b', 'llama3.1:8b', 'mistral-nemo'],
    capabilities: { tools: false, vision: false, reasoning: false, promptCache: false },
    note: '本地模型，隐私最好但工具调用能力有限；建议使用 14B 以上模型',
    docsUrl: 'https://ollama.com'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    models: ['local-model'],
    capabilities: { tools: false, vision: false, reasoning: false, promptCache: false },
    note: '本地 OpenAI 兼容服务，需在 LM Studio 中开启 Server',
    docsUrl: 'https://lmstudio.ai'
  }
]

export function createProvider(settings: ProviderSettings): ChatProvider {
  const provider = new OpenAiCompatibleProvider({
    id: settings.id,
    name: settings.name,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    timeoutMs: settings.timeoutMs ?? 120_000,
    capabilities: {
      tools: settings.supportsTools,
      vision: settings.supportsVision ?? false,
      reasoning: settings.supportsReasoning ?? false,
      promptCache: settings.supportsPromptCache ?? false
    }
  })
  provider.setPingModel(settings.model)
  return provider
}

export function presetToSettings(preset: ProviderPreset, apiKey = ''): ProviderSettings {
  return {
    id: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKey,
    model: preset.model,
    supportsTools: preset.capabilities?.tools ?? true,
    supportsVision: preset.capabilities?.vision ?? false,
    supportsReasoning: preset.capabilities?.reasoning ?? false,
    supportsPromptCache: preset.capabilities?.promptCache ?? false,
    timeoutMs: 120_000,
    contextWindow: 128_000
  }
}

export * from './types'
export { OpenAiCompatibleProvider }
