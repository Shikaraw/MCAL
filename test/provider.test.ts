/**
 * 内置模型预设测试：Provider 预设表与默认 provider 播种。
 *
 * 全部为纯逻辑断言，不发任何网络请求：
 *  - 只读取 PROVIDER_PRESETS / presetToSettings / defaultProviders() 的静态数据；
 *  - 重点防止「预设里的模型清单落后于默认模型」这类问题再次出现。
 */

import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, presetToSettings, type ProviderPreset } from '@agent/provider'
import { defaultProviders } from '../src/main/store/defaults'

/** 约定的 9 个预设 id（最后一个 custom 是留给用户自己填的空模板） */
const ALL_IDS = ['deepseek', 'moonshot', 'zhipu', 'dashscope', 'siliconflow', 'openrouter', 'ollama', 'lmstudio', 'custom']

/** 本地部署的预设：没有 API Key 也能用，baseUrl 必须指向本机 */
const LOCAL_IDS = ['ollama', 'lmstudio']

/** 需要用户自己填地址与模型名的空模板，不参与「预设必须填满」的检查 */
const TEMPLATE_IDS = ['custom']

/** 表格里完全点名的模型清单（顺序即优先级，第一个是默认模型） */
const EXACT_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-v4.1-flash', 'deepseek-v4-pro'],
  moonshot: ['k2.8-preview', 'k3'],
  zhipu: ['glm-5.3', 'glm-5.3-flash'],
  dashscope: ['qwen3.8-max', 'qwen3.8-flash']
}

/** 表格里点名的默认模型（其余备选允许实现自行补充） */
const REQUIRED_DEFAULTS: Record<string, string> = {
  deepseek: 'deepseek-v4.1-flash',
  moonshot: 'k2.8-preview',
  zhipu: 'glm-5.3',
  dashscope: 'qwen3.8-max',
  ollama: 'qwen3.8-27b'
}

/** 按 id 取预设，缺失直接抛错（比可选链更好定位问题） */
function presetOf(id: string): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((item) => item.id === id)
  if (!preset) throw new Error(`缺少预设：${id}`)
  return preset
}

/* ------------------------------------------------------------------ *
 *  预设清单
 * ------------------------------------------------------------------ */

describe('PROVIDER_PRESETS：预设清单', () => {
  it('9 个预设齐全，id 集合与约定一致且不重复', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(PROVIDER_PRESETS).toHaveLength(9)
    expect([...ids].sort()).toEqual([...ALL_IDS].sort())
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.name.length, `${preset.id} 缺少显示名`).toBeGreaterThan(0)
    }
  })

  it('每个预设的 models 非空、首个即默认 model、且无重复项', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (TEMPLATE_IDS.includes(preset.id)) continue
      expect(preset.models.length, `${preset.id} 的 models 为空`).toBeGreaterThan(0)
      expect(preset.models[0], `${preset.id} 的默认 model 与 models[0] 不一致`).toBe(preset.model)
      expect(new Set(preset.models).size, `${preset.id} 的 models 存在重复项`).toBe(preset.models.length)
      for (const model of preset.models) {
        expect(model.trim().length, `${preset.id} 含空模型名`).toBeGreaterThan(0)
      }
    }
  })

  it('表格点名的模型清单与顺序完全一致', () => {
    for (const [id, models] of Object.entries(EXACT_MODELS)) {
      const preset = presetOf(id)
      expect(preset.models, `${id} 的模型清单不符`).toEqual(models)
      expect(preset.model, `${id} 的默认模型应为 ${models[0]}`).toBe(models[0])
    }
  })

  it('表格点名的默认模型逐个存在', () => {
    for (const [id, model] of Object.entries(REQUIRED_DEFAULTS)) {
      const preset = presetOf(id)
      expect(preset.models, `${id} 缺少 ${model}`).toContain(model)
      expect(preset.models[0], `${id} 的默认模型应为 ${model}`).toBe(model)
      expect(preset.model, `${id} 的 model 字段应为 ${model}`).toBe(model)
    }
  })

  it('每个预设的 baseUrl 非空且为 http(s) 地址', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (TEMPLATE_IDS.includes(preset.id)) continue
      expect(preset.baseUrl.length, `${preset.id} 缺少 baseUrl`).toBeGreaterThan(0)
      expect(preset.baseUrl, `${preset.id} 的 baseUrl 不是 http(s) 地址`).toMatch(/^https?:\/\/\S+$/)
    }
  })

  it('自定义预设是空模板：地址与模型留空，排在最后，不会被自动播种', () => {
    const custom = presetOf('custom')
    expect(custom.baseUrl).toBe('')
    expect(custom.model).toBe('')
    expect(custom.models).toEqual([])
    // 排在最后：用户想找「自定义」时在列表末尾
    expect(PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1].id).toBe('custom')
    // 空模板不该进默认播种（否则用户一打开就看到一个填不出来的服务商）
    const seeded = defaultProviders().map((provider) => provider.id)
    expect(seeded).not.toContain('custom')
  })

  it('Ollama / LM Studio 为本地预设：无需 API Key，地址指向本机', () => {
    // ProviderPreset 类型没有 requiresApiKey 之类的标记，因此用 baseUrl 是否归属本机来判定
    for (const id of LOCAL_IDS) {
      const preset = presetOf(id)
      expect(preset.baseUrl, `${id} 的 baseUrl 应指向本机`).toMatch(
        /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/
      )
      // 本地服务不填 key 也能用：presetToSettings 默认给空串
      expect(presetToSettings(preset).apiKey, `${id} 不应要求填写 API Key`).toBe('')
    }
    // 云端预设走 https，与本地预设区分开
    for (const preset of PROVIDER_PRESETS) {
      if (LOCAL_IDS.includes(preset.id) || TEMPLATE_IDS.includes(preset.id)) continue
      expect(preset.baseUrl.startsWith('https://'), `${preset.id} 云端预设应使用 https`).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ *
 *  默认播种
 * ------------------------------------------------------------------ */

describe('defaultProviders：默认播种', () => {
  it('预置 deepseek / moonshot / zhipu / ollama，模型字段等于对应预设的首个模型', () => {
    const providers = defaultProviders()
    expect(providers.map((provider) => provider.id)).toEqual(['deepseek', 'moonshot', 'zhipu', 'ollama'])
    for (const provider of providers) {
      const preset = presetOf(provider.id)
      expect(provider.model, `${provider.id} 的 model 与预设不一致`).toBe(preset.model)
      expect(provider.model).toBe(preset.models[0])
      expect(provider.baseUrl).toBe(preset.baseUrl)
      expect(provider.apiKey).toBe('')
    }
  })

  it('返回自包含副本：修改条目不会污染预设表，用户可自由增删/自定义 provider', () => {
    const providers = defaultProviders()
    const first = providers[0]
    first.model = 'my-custom-model'
    first.name = '自定义服务商'

    expect(presetOf('deepseek').model).not.toBe('my-custom-model')
    expect(presetOf('deepseek').name).not.toBe('自定义服务商')
    // 每次调用都返回全新对象，互不影响
    expect(defaultProviders()[0].model).toBe(presetOf('deepseek').model)
  })
})
