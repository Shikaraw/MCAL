/**
 * Mojang 启动规则（rules）求值。
 *
 * 规则语义容易被误解：并不是「命中 allow 就允许」，而是按顺序扫描，
 * 每条「匹配」的规则用它的 action 覆盖之前的结果 —— 最后一条匹配的规则说了算。
 * 若一条都没有匹配，则使用调用方给定的默认值（Mojang 自身的默认是「不允许」）。
 * 另外，很多库 / 参数根本没有 rules 字段，此时一律视为允许，不能当成默认拒绝。
 */

import { release as osRelease } from 'node:os'
import type { Rule } from '@shared/types'
import { currentArch, currentOs } from '@core/util/misc'

export interface RuleContext {
  osName: 'windows' | 'osx' | 'linux'
  osVersion?: string
  arch: string
  features: Record<string, boolean>
  isDemoUser?: boolean
  hasCustomResolution?: boolean
}

/** Mojang 规则里可能出现的全部 feature 开关，默认关闭 */
export function defaultFeatures(): Record<string, boolean> {
  return {
    is_demo_user: false,
    has_custom_resolution: false,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  }
}

export function createRuleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  const features: Record<string, boolean> = { ...defaultFeatures(), ...(overrides.features ?? {}) }
  // isDemoUser / hasCustomResolution 是 features 的便捷投影，两个入口必须保持一致，
  // 否则用旧字段构造的 context 会让只读 features 的规则得到错误结果。
  const isDemoUser = overrides.isDemoUser ?? features.is_demo_user ?? false
  const hasCustomResolution = overrides.hasCustomResolution ?? features.has_custom_resolution ?? false
  features.is_demo_user = isDemoUser
  features.has_custom_resolution = hasCustomResolution
  return {
    osName: overrides.osName ?? currentOs(),
    // 供 os.version 正则匹配（例如 Windows 10 的 "^10\."）
    osVersion: overrides.osVersion ?? osRelease(),
    arch: overrides.arch ?? currentArch(),
    features,
    isDemoUser,
    hasCustomResolution
  }
}

/** 架构名归一化：Mojang 规则写 x86/x86_64，Node 给 x64/ia32/arm64…，需要对齐后再比较 */
function normalizeArch(arch: string | undefined): string {
  const value = (arch ?? '').toLowerCase()
  if (value === 'x86_64' || value === 'amd64' || value === 'x64') return 'x64'
  if (value === 'ia32' || value === 'i386' || value === 'i686' || value === 'x86') return 'x86'
  if (value === 'aarch64' || value === 'arm64') return 'arm64'
  if (value === 'arm' || value === 'arm32') return 'arm32'
  return value
}

function featureValue(name: string, ctx: RuleContext): boolean {
  if (Object.prototype.hasOwnProperty.call(ctx.features, name)) return ctx.features[name] === true
  if (name === 'is_demo_user') return ctx.isDemoUser === true
  if (name === 'has_custom_resolution') return ctx.hasCustomResolution === true
  return false
}

function ruleMatches(rule: Rule, ctx: RuleContext): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== ctx.osName) return false
    if (rule.os.arch && normalizeArch(rule.os.arch) !== normalizeArch(ctx.arch)) return false
    if (rule.os.version) {
      if (!ctx.osVersion) return false
      try {
        // os.version 是正则而非精确版本号
        if (!new RegExp(rule.os.version).test(ctx.osVersion)) return false
      } catch {
        return false
      }
    }
  }
  if (rule.features) {
    // features 是「全部满足」语义：规则里写 false 的开关必须确实为 false
    for (const [name, expected] of Object.entries(rule.features)) {
      if (featureValue(name, ctx) !== expected) return false
    }
  }
  return true
}

export function evaluateRules(rules: Rule[] | undefined, ctx: RuleContext, defaultValue = false): boolean {
  // 没有任何 rules 的条目（绝大多数库 / 参数）视为允许
  if (!rules || rules.length === 0) return true
  let result = defaultValue
  for (const rule of rules) {
    if (ruleMatches(rule, ctx)) result = rule.action === 'allow'
  }
  return result
}
