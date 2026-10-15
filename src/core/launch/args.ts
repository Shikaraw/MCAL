/**
 * 启动参数构造：占位符替换、rules 过滤、JVM/游戏参数拼装。
 *
 * 三个反直觉点（都踩过坑，务必保留）：
 *  1. 未定义的占位符不是「替换为空串」，而是「连同它前面的 flag 一起丢弃」。
 *     例如没有自定义分辨率时，版本 json 给出 `--width ${resolution_width} --height ${resolution_height}`，
 *     直接替换成空串会变成 `--width  --height `，游戏会报参数错误；
 *     正确做法是整组丢弃（PCL/HMCL 都做过这个处理）。
 *  2. `arguments.jvm` / `arguments.game` 里的对象项带 rules，必须在「当前平台 + features」
 *     求值通过后才能展开；字符串项没有 rules，一律保留。
 *  3. 实例自定义 JVM 参数放最末尾，让 `-Xmx` 等设置能覆盖启动器默认值。
 */

import { delimiter } from 'node:path'
import type { ArgumentNode, MemoryPolicy, VersionDetail } from '@shared/types'
import { createRuleContext, evaluateRules, type RuleContext } from '@core/mojang/rules'
import { needsLog4jMitigation } from '@core/java/requirement'

/** 启动器品牌与版本：写入 -Dminecraft.launcher.brand / version 与 ${launcher_name/version} */
export const MCAL_LAUNCHER_NAME = 'MCAL'
export const MCAL_LAUNCHER_VERSION = '0.1.0'

/** 版本 json 占位符表：值为 undefined 表示「本次启动该占位符不可用」，其参数会被丢弃 */
export interface PlaceholderValues {
  [key: string]: string | undefined
}

const PLACEHOLDER_RE = /\$\{([^}]*)\}/g

/**
 * 替换 `${var}`；未定义的占位符原样保留（交给 filterUndefinedPlaceholders 处理），
 * 这样能区分「值就是空字符串」和「变量不存在」两种情况。
 */
export function substitutePlaceholders(template: string, values: PlaceholderValues): string {
  if (!template.includes('${')) return template
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : value
  })
}

/**
 * 处理「替换后仍残留 `${...}`」的参数：
 *  - 丢弃该参数；
 *  - 若它前面紧邻的参数是 flag（以 `-` 开头且不含 `${`），也一并丢弃，避免出现悬空 flag。
 * 注意：按规格，`-Dfoo=bar` 这种也符合「以 - 开头」的 flag 判定，
 * 因此「未定义占位符紧跟系统属性」时两者都会被丢弃 —— 但正常版本 json 不会这么写。
 */
export function filterUndefinedPlaceholders(args: string[]): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (arg === undefined || arg === null) continue
    if (/\$\{[^}]*\}/.test(arg)) {
      const prev = out[out.length - 1]
      if (prev !== undefined && prev.startsWith('-') && !prev.includes('${')) out.pop()
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * 按空格切分老格式 minecraftArguments，尊重双引号：
 * `"a b"` 作为一个参数（引号去掉）；引号内的 `\"` 与 `\\` 为转义。
 */
export function splitMinecraftArguments(str: string): string[] {
  const out: string[] = []
  let current = ''
  let started = false
  let inQuotes = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '\\' && i + 1 < str.length && (str[i + 1] === '"' || str[i + 1] === '\\')) {
      current += str[i + 1]
      started = true
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      started = true
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/* ------------------------------------------------------------------ *
 *  内部工具
 * ------------------------------------------------------------------ */

function normalizeOsName(osName: string): RuleContext['osName'] {
  const value = (osName ?? '').toLowerCase()
  if (value === 'osx' || value === 'mac' || value === 'macos' || value === 'darwin') return 'osx'
  if (value === 'windows' || value === 'win32' || value === 'win') return 'windows'
  return 'linux'
}

/** 从 values 反推 features（buildJvmArgs 没有 RuleContext 参数） */
function featuresFromValues(values: PlaceholderValues): Record<string, boolean> {
  const quickPlayMultiplayer = values.quickPlayMultiplayer !== undefined
  const quickPlaySingleplayer = values.quickPlaySingleplayer !== undefined
  const quickPlayRealms = values.quickPlayRealms !== undefined
  return {
    has_custom_resolution: values.resolution_width !== undefined && values.resolution_height !== undefined,
    is_quick_play_singleplayer: quickPlaySingleplayer,
    is_quick_play_multiplayer: quickPlayMultiplayer,
    is_quick_play_realms: quickPlayRealms,
    has_quick_plays_support: quickPlayMultiplayer || quickPlaySingleplayer || quickPlayRealms,
    is_demo_user: false
  }
}

/** 展开 `(string | ArgumentNode)[]`：rules 过滤 → 占位符替换 → 丢弃残留占位符 */
function collectArguments(
  nodes: (string | ArgumentNode)[] | undefined,
  values: PlaceholderValues,
  rules: RuleContext
): string[] {
  const raw: string[] = []
  for (const node of nodes ?? []) {
    if (typeof node === 'string') {
      raw.push(node)
      continue
    }
    if (!node || typeof node !== 'object') continue
    // 无 rules 的节点 evaluateRules 直接返回 true
    if (!evaluateRules(node.rules, rules)) continue
    const value = node.value
    if (typeof value === 'string') raw.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') raw.push(item)
    }
  }
  return filterUndefinedPlaceholders(raw.map((arg) => substitutePlaceholders(arg, values)))
}

function isForgeLike(loaderType: string | undefined): boolean {
  return loaderType === 'forge' || loaderType === 'neoforge'
}

/* ------------------------------------------------------------------ *
 *  JVM 参数
 * ------------------------------------------------------------------ */

export function buildJvmArgs(opts: {
  version: VersionDetail
  values: PlaceholderValues
  memory: MemoryPolicy
  extraJvmArgs?: string[]
  nativesDir: string
  classpath: string[]
  osName: string
  loaderType?: string
  isDemo?: boolean
}): string[] {
  const { version, values, nativesDir, classpath, memory } = opts
  const osName = normalizeOsName(opts.osName)
  const rules = createRuleContext({
    osName,
    features: featuresFromValues(values),
    isDemoUser: opts.isDemo === true
  })

  // 1) 版本 json 自带的 jvm 参数（已 rules 过滤 + 占位符替换）
  const args = collectArguments(version.arguments?.jvm, values, rules)

  // 2) native / library 相关 -D：老版本 json 完全没有这些参数，必须补；
  //    高版本 json 里已有同名参数（值为 ${natives_directory} 已替换），重复一次由 JVM 取后者，无害。
  args.push(`-Djava.library.path=${nativesDir}`)
  args.push(`-Dminecraft.launcher.brand=${MCAL_LAUNCHER_NAME}`)
  args.push(`-Dminecraft.launcher.version=${MCAL_LAUNCHER_VERSION}`)

  // 3) 加载器 / 安全缓解 / 平台特殊参数
  if (isForgeLike(opts.loaderType ?? version.mcalMeta?.loaderType)) {
    // Forge 校验 jar 签名与补丁，开发/整合环境经常失败，官方启动器同样会加这两个开关
    args.push('-Dfml.ignoreInvalidMinecraftCertificates=true')
    args.push('-Dfml.ignorePatchDiscrepancies=true')
  }
  if (needsLog4jMitigation(version.id)) {
    // log4shell（CVE-2021-44228）：1.12~1.17 的 log4j2 存在 JNDI 注入，加此开关关闭 lookup
    args.push('-Dlog4j2.formatMsgNoLookups=true')
  }
  if (osName === 'osx') {
    // macOS 上 LWJGL/GLFW 必须在主线程启动，否则窗口黑屏
    args.push('-XstartOnFirstThread')
  }

  // 4) 内存
  if (memory.maxMB > 0) args.push(`-Xmx${Math.floor(memory.maxMB)}M`)
  if (memory.minMB > 0) args.push(`-Xms${Math.floor(memory.minMB)}M`)

  // 5) classpath（-cp 与值成对出现；1.12 及以前的版本 json 没有 -cp，必须在这里补）
  if (classpath.length > 0) args.push('-cp', classpath.join(delimiter))

  // 6) 实例自定义参数放最后：用户显式设置的 -Xmx / -D 能覆盖上面所有默认值
  if (opts.extraJvmArgs?.length) args.push(...opts.extraJvmArgs)

  return args
}

/* ------------------------------------------------------------------ *
 *  游戏参数
 * ------------------------------------------------------------------ */

export function buildGameArgs(opts: {
  version: VersionDetail
  values: PlaceholderValues
  extraGameArgs?: string[]
  rules: RuleContext
}): string[] {
  const { version, values, rules } = opts
  const out: string[] = []

  const fromJson = version.arguments?.game
  if (fromJson && fromJson.length > 0) {
    out.push(...collectArguments(fromJson, values, rules))
  } else if (typeof version.minecraftArguments === 'string' && version.minecraftArguments.trim().length > 0) {
    // 老版本（1.6 ~ 1.12）：整套参数在 minecraftArguments 字符串里
    const tokens = splitMinecraftArguments(version.minecraftArguments)
    out.push(...filterUndefinedPlaceholders(tokens.map((token) => substitutePlaceholders(token, values))))
  }

  // 不减 mainClass：mainClass 由 launcher 单独插在 jvm 与 game 参数之间
  if (opts.extraGameArgs?.length) out.push(...opts.extraGameArgs)
  return out
}
