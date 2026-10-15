/** 默认值与常量：主进程侧的集中定义。 */

import { PROVIDER_PRESETS, presetToSettings } from '@agent/provider'
import type { ImageProviderSettings, ProviderSettings } from '@shared/types'

/** 首次运行时在设置里预置的 provider（不填 key，等用户补） */
export function defaultProviders(): ProviderSettings[] {
  return PROVIDER_PRESETS.filter((preset) => ['deepseek', 'moonshot', 'zhipu', 'ollama'].includes(preset.id)).map((preset) =>
    presetToSettings(preset)
  )
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
