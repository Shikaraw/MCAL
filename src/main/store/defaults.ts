/** 默认值与常量：主进程侧的集中定义。 */

import { PROVIDER_PRESETS, presetToSettings } from '@agent/provider'
import type { ImageProviderSettings, ProviderSettings } from '@shared/types'

/**
 * 首次运行时在设置里预置的 provider（不填 key，等用户补）。
 *
 * 这里只在「设置里还没有任何 provider」时做一次性播种：生成的条目是
 * ProviderSettings 的普通字段副本（id/name/baseUrl/apiKey/model 全部自包含），
 * 运行期不再依赖 PROVIDER_PRESETS。用户完全可以自由增删/修改 provider 条目，
 * 也可以按同样的结构自行添加「自定义服务商」，不会与内置预设表产生耦合。
 */
export function defaultProviders(): ProviderSettings[] {
  return PROVIDER_PRESETS.filter((preset) => ['deepseek', 'moonshot', 'zhipu', 'ollama'].includes(preset.id)).map((preset) =>
    presetToSettings(preset)
  )
}

/**
 * 早期版本内置的默认模型。
 *
 * 这些模型名在各家的接口上已经下线（deepseek-chat、glm-4.6、qwen-plus…），
 * 留着只会让用户一升级就吃到 404 / 模型不存在，所以只要某条 provider 的 model
 * 还停在旧默认值上，就把它升级成当前预设的默认模型。
 * 用户自己改过的模型名不在这个表里，因此不会被覆盖。
 */
const LEGACY_DEFAULT_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  moonshot: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
  zhipu: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
  dashscope: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  siliconflow: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  openrouter: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
  ollama: ['qwen2.5:14b', 'llama3.1:8b', 'mistral-nemo'],
  lmstudio: ['local-model']
}

/** 预设 id：provider 可能是从预设复制的（id 形如 deepseek-2），取前缀匹配 */
function presetIdOf(providerId: string): string | null {
  for (const preset of PROVIDER_PRESETS) {
    if (providerId === preset.id || providerId.startsWith(`${preset.id}-`)) return preset.id
  }
  return null
}

/**
 * 把停在旧默认模型上的 provider 升级到当前预设的默认模型。
 * 返回升级后的列表（没有需要改的就原样返回，方便调用方判断要不要落盘）。
 */
export function migrateProviderModels(providers: ProviderSettings[]): {
  providers: ProviderSettings[]
  changed: { id: string; from: string; to: string }[]
} {
  const changed: { id: string; from: string; to: string }[] = []
  const next = providers.map((provider) => {
    const presetId = presetIdOf(provider.id)
    if (!presetId) return provider
    const legacy = LEGACY_DEFAULT_MODELS[presetId]
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId)
    if (!legacy || !preset || !preset.model) return provider
    if (!legacy.includes(provider.model)) return provider
    changed.push({ id: provider.id, from: provider.model, to: preset.model })
    return { ...provider, model: preset.model }
  })
  return { providers: next, changed }
}

/** 首次运行时预置的生图 provider */
export function defaultImageProviders(): ImageProviderSettings[] {
  return [
    {
      id: 'openai-image',
      name: 'OpenAI 兼容生图',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-image-1'
    },
    {
      id: 'zhipu-image',
      name: '智谱 CogView',
      kind: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '',
      model: 'cogview-3-flash'
    },
    {
      id: 'siliconflow-image',
      name: '硅基流动（Kolors）',
      kind: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: '',
      model: 'Kwai-Kolors/Kolors'
    },
    {
      id: 'sd-webui-image',
      name: '本地 Stable Diffusion WebUI',
      kind: 'sd-webui',
      baseUrl: 'http://127.0.0.1:7860',
      apiKey: '',
      model: 'anything-v5'
    }
  ]
}

export const APP_NAME = 'MCAL'
export const WINDOW_MIN_WIDTH = 1000
export const WINDOW_MIN_HEIGHT = 680
