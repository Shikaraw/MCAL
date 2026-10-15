/**
 * Java 版本需求判定：把「Minecraft 版本号 / 版本 json 的 javaVersion 字段」翻译成
 * 需要的 Java 主版本号，并在已探测到的 Java 列表中挑选最合适的一个。
 *
 * 判定优先级（为什么这样排）：
 *  1. 版本 json 的 `javaVersion.majorVersion` 最权威 —— Mojang 与加载器安装器都会写入，
 *     快照、Forge 特殊版本都靠它覆盖兜底规则。
 *  2. 没有该字段时才按 MC 版本区间兜底，依据是各版本的实际编译目标（class 文件版本）：
 *       <= 1.16.5      → 8
 *       1.17.x         → 17（Mojang 官方声明 16，java-runtime-alpha=16，
 *                          但 16 已 EOL，发版后迅速切到 17；因此「16 也可」）
 *       1.18 ~ 1.19.x  → 17
 *       1.20 ~ 1.20.4  → 17
 *       >= 1.20.5      → 21（快照 24w14a 起编译目标升到 21）
 *       快照按时间兜底：2021 年后的快照一律按 17 处理（1.17 开发快照需要 16/17），
 *       2024 年 4 月（24w14a）后的快照按 21。
 *
 * 兼容性模型（反直觉点的说明）：
 *  - Java 主版本不是线性的：玩家世界里真正的台阶是 8 → 11 → 12~16 → 17~20 → 21~24 → 25+。
 *    Java 12~16 之间任何版本行为接近（都能运行 1.17 的 class），Java 18~20 都能运行 1.18~1.20.4。
 *    所以「高一档 / 低一档」= 跨越一个台阶，而不是字面上的 ±1。
 *  - 「8 的需求不可用 17+」：1.16.5 及更早的 Forge / OptiFine / LaunchWrapper 与
 *    Java 17 不兼容（URLClassLoader 假设、模块系统、反射限制），会直接崩溃。
 *  - 「低一档仅在候选 major >= 16 时接受」：1.17.x 官方要求 16，主版本 16 的 Java
 *    可以满足声明为 17 的需求（1.17 这一代）；而 Java 8/11 绝不能拿来跑 1.17+（class 61/65）。
 */

import type { JavaRuntimeInfo, JavaVersionRequirement } from '@shared/types'
import { cleanGameVersion } from '@core/util/misc'

/** 单个 Java 主版本相对需求版本的判定结果 */
export type JavaMajorVerdict = 'exact' | 'higher' | 'lower'

/**
 * 兼容台阶（tier）：跨越一个台阶才算「高一档 / 低一档」。
 * 台阶划分依据是 JVM 的世代兼容性而不是字面版本号：
 *   0: <= 8        最后一代无模块系统的 LTS（Forge 老版本的唯一选择）
 *   1: 9 ~ 11      模块系统引入期（1.12.2 勉强可跑 vanilla，Forge 不行）
 *   2: 12 ~ 16     1.17 所在代（Mojang 官方 16）
 *   3: 17 ~ 20     1.18 ~ 1.20.4 所在代
 *   4: 21 ~ 24     1.20.5+ 所在代
 *   5: 25+         未来版本
 */
export function javaTier(major: number): number {
  if (major <= 8) return 0
  if (major <= 11) return 1
  if (major <= 16) return 2
  if (major <= 20) return 3
  if (major <= 24) return 4
  return 5
}

/**
 * 某 MC 版本所需的 Java 主版本号。
 * @param gameVersion 基础游戏版本（例如 `1.20.1`、`24w14a`）；加载器 id 应先在调用方上溯到基础版本
 * @param detailJavaVersion 版本 json 的 `javaVersion` 字段（存在则优先）
 */
export function requiredJavaMajor(gameVersion: string, detailJavaVersion?: JavaVersionRequirement): number {
  const declared = detailJavaVersion?.majorVersion
  // 版本 json 的声明最可靠：Forge/Fabric/快照都可能改写它
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return Math.floor(declared)
  return fallbackJavaMajor(gameVersion)
}

/** 无 `javaVersion` 字段时的兜底规则（正式版与快照分开处理） */
export function fallbackJavaMajor(gameVersion: string): number {
  const v = cleanGameVersion(gameVersion || '')

  // 快照：<年>w<周><字母>。无法拿到精确日期，用「年 + 周」近似判断。
  const snapshot = /^(\d{2})w(\d{2})[a-z]?$/i.exec(v)
  if (snapshot) {
    const year = Number.parseInt(snapshot[1], 10)
    const week = Number.parseInt(snapshot[2], 10)
    // 24w14a（2024-04，1.20.5 开发版）起编译目标升到 Java 21
    if (year > 24 || (year === 24 && week >= 14)) return 21
    // 2021 年全年都是 1.17 开发快照（含 21w20a），需要 16/17；
    // 更早但已进入 1.17 开发期的 20w45a+ 也一样（避免退化成 Java 8）。
    if (year >= 21) return 17
    if (year === 20 && week >= 45) return 17
    // 1.16 及更早的快照：Java 8
    return 8
  }

  // 正式版 / 预发布 / rc：1.20.5-pre1、1.21.4-rc2 等
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(v)
  if (!m) return 8 // a1.x / b1.x / 无法识别时按最保守的 Java 8
  const minor = Number.parseInt(m[1], 10)
  const patch = m[2] ? Number.parseInt(m[2], 10) : 0

  if (minor >= 21) return 21
  if (minor === 20) return patch >= 5 ? 21 : 17
  if (minor >= 17) return 17
  return 8
}

/**
 * 判断候选 Java 主版本相对需求版本是否可用。
 * 返回 null 表示明确不可用（过低 / 过高 / 探测失败）。
 */
export function javaMajorVerdict(candidateMajor: number, requiredMajor: number): JavaMajorVerdict | null {
  if (!Number.isFinite(candidateMajor) || candidateMajor < 8) return null
  const required = requiredMajor > 0 ? requiredMajor : 8
  if (candidateMajor === required) return 'exact'

  const delta = javaTier(candidateMajor) - javaTier(required)
  // 同一台阶内的高版本（例如需求 18 拿到 20）也算「高一档」
  if (delta === 0) return candidateMajor > required ? 'higher' : null
  // 高一档：需求 8 时档位 +1 只是 9~11，天然不会放进 17+（Forge 老版本不兼容）
  if (delta === 1) return 'higher'
  // 低一档：仅当候选本身是 16+（1.17 需要 16 的场景）才被接受，
  // Java 8/11 低于 1.17+ 的需求一定抛 UnsupportedClassVersionError
  if (delta === -1 && candidateMajor >= 16) return 'lower'
  return null
}

/** 该 Java 是否满足需求（lower 仍算可用，但 pickBestJava 会排在最后） */
export function javaIsCompatible(info: JavaRuntimeInfo | null | undefined, requiredMajor: number): boolean {
  if (!info) return false
  // 探测失败（路径失效、非 Java 可执行文件）一律不可用
  if (info.error && !info.majorVersion) return false
  return javaMajorVerdict(info.majorVersion, requiredMajor) !== null
}

/**
 * 从候选列表中挑选最合适的 Java。
 * 排序原则：精确匹配 → 高一档 → 低一档（1.17 的 16）；
 * 同档内差距越小越好，其次 vendor 偏好、64 位、MCAL 自装运行时。
 * 返回 null 表示没有可用 Java。
 */
export function pickBestJava(
  candidates: JavaRuntimeInfo[],
  requiredMajor: number,
  opts: { preferVendor?: string } = {}
): JavaRuntimeInfo | null {
  const required = requiredMajor > 0 ? requiredMajor : 8
  const preferVendor = opts.preferVendor?.trim().toLowerCase()
  let best: { info: JavaRuntimeInfo; score: number } | null = null

  for (const info of candidates) {
    if (info.error && !info.majorVersion) continue
    const verdict = javaMajorVerdict(info.majorVersion, required)
    if (!verdict) continue

    let score: number
    if (verdict === 'exact') score = 3000 - Math.min(20, Math.abs(info.majorVersion - required))
    else if (verdict === 'higher') score = 2000 - Math.min(20, Math.abs(info.majorVersion - required))
    else score = 1000 - Math.min(20, Math.abs(info.majorVersion - required))

    if (preferVendor) {
      const vendor = (info.vendor ?? '').toLowerCase()
      if (vendor.includes(preferVendor)) score += 100
    }
    // 64 位优先：32 位 Java 无法分配大内存，很多 mod 直接失败
    if (info.is64Bit === undefined || info.is64Bit) score += 2
    if (info.managed) score += 1 // 自装运行时版本/路径可控

    if (!best || score > best.score) best = { info, score }
  }
  return best ? best.info : null
}

/** 说明为什么需要这个 Java，用于 UI 与 Agent 解释（中文） */
export function explainJavaRequirement(gameVersion: string, requiredMajor: number): string {
  const version = cleanGameVersion(gameVersion || '未知版本')
  const head = `Minecraft ${version} 需要 Java ${requiredMajor}`

  let reason: string
  if (requiredMajor <= 8) {
    reason =
      '该版本（1.16.5 及更早）以 Java 8 为编译目标。请使用 Java 8（Java 9~11 通常也能启动原版）；' +
      '不要使用 Java 17 及以上：老版 Forge / OptiFine / LaunchWrapper 与模块系统不兼容，' +
      '启动时会崩溃（常见报错 NoSuchMethodError、ClassCastException: AppClassLoader 无法转换为 URLClassLoader）。'
  } else if (requiredMajor === 16) {
    reason =
      '该版本（1.17 开发期）以 Java 16 为编译目标，必须使用 Java 16 或更高；' +
      '使用 Java 8/11 会直接报 UnsupportedClassVersionError（class file version 60 无法加载）。'
  } else if (requiredMajor <= 20) {
    reason =
      '该版本（1.17 ~ 1.20.4）以 Java 17 为编译目标，必须使用 Java 17 及以上' +
      '（1.17.x 用 Java 16 也可以）。使用 Java 8/11 会报 UnsupportedClassVersionError ' +
      '（"has been compiled by a more recent version of the Java Runtime, class file version 61.0"）；' +
      '使用 Java 21/22 通常可运行，但个别老模组可能不兼容。'
  } else if (requiredMajor === 21) {
    reason =
      'Mojang 自 1.20.5（快照 24w14a）起把编译目标升级到 Java 21，必须使用 Java 21 及以上；' +
      '使用 Java 17 会直接报 UnsupportedClassVersionError（class file version 65.0）。' +
      '在仅有 Java 17 时启动器会作为最后的兜底尝试，但游戏几乎必然启动失败。'
  } else {
    reason = `该版本声明需要 Java ${requiredMajor} 及以上，低于该版本会因类文件版本过低而启动失败。`
  }

  const hint =
    '若本机没有合适的 Java，可在「Java 管理」中自动安装对应版本（Mojang 官方运行时或 Temurin），' +
    '或手动安装后重新扫描。'
  return `${head}。${reason} ${hint}`
}

/** 供启动器判断是否需要 log4shell 缓解（1.12 ~ 1.17.x，1.18 起 log4j 已升级到安全版本） */
export function needsLog4jMitigation(gameVersion: string): boolean {
  const v = cleanGameVersion(gameVersion || '')
  // 快照（1.18 开发期 = 21w37a 起）不再需要；这里只对正式版区间判断，快照交给 json 声明
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(v)
  if (!m) return false
  const minor = Number.parseInt(m[1], 10)
  return minor >= 12 && minor <= 17
}
