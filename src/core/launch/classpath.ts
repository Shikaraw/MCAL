/**
 * Classpath 组装。
 *
 * 要点：
 *  - 只放普通库（isNative 的 classifier 包不能进 classpath，它们只用于解压）；
 *  - 必须包含客户端 jar，且客户端 jar 在继承链里可能属于父版本（见 ResolvedVersion.jarVersionId）；
 *  - 加载器（Forge/OptiFine 等）安装出的版本 jar 作为 extraJars 追加在最后；
 *  - 去重按「平台大小写规则」：Windows 文件系统不区分大小写，同一库被多次写进 classpath
 *    时若不按小写去重会出现同一个 jar 出现两次（无害但会拉长命令行，且部分加载器会重复扫描）。
 */

import type { ResolvedLibrary } from '@core/mojang/library'
import { normalizePathForCompare, parseMavenName } from '@core/util/misc'

export function buildClasspath(opts: {
  libraries: ResolvedLibrary[]
  clientJar: string
  extraJars?: string[]
  separator?: string
}): string[] {
  // `;` 是 Windows 的 path 分隔符；未显式给出时按当前平台判断
  const caseInsensitive = opts.separator === ';' || (opts.separator === undefined && process.platform === 'win32')
  const seen = new Set<string>()
  const out: string[] = []

  const push = (path: string | undefined): void => {
    if (!path) return
    const key = caseInsensitive ? normalizePathForCompare(path) : path.replace(/\\/g, '/')
    if (seen.has(key)) return
    seen.add(key)
    out.push(path)
  }

  for (const lib of opts.libraries) {
    if (lib.isNative) continue
    push(lib.absolutePath)
  }
  push(opts.clientJar)
  for (const jar of opts.extraJars ?? []) push(jar)
  return out
}

/**
 * 检测同一 artifact（group:artifact）出现多个版本的情况。
 * 继承合并理论上已去重，但整合包/手动改过的版本 json 仍可能出现；
 * 同名不同版本的库是「神秘崩溃」的常见来源，交给上层在启动前警告。
 */
export function detectDuplicateLibraries(libraries: ResolvedLibrary[]): { artifact: string; versions: string[] }[] {
  const byArtifact = new Map<string, Set<string>>()
  for (const lib of libraries) {
    // native classifier 是同一 artifact 的变体，不算版本冲突
    if (lib.isNative) continue
    const coord = parseMavenName(lib.name)
    if (!coord) continue
    const key = `${coord.group}:${coord.artifact}`
    const versions = byArtifact.get(key) ?? new Set<string>()
    versions.add(coord.version)
    byArtifact.set(key, versions)
  }

  const out: { artifact: string; versions: string[] }[] = []
  for (const [artifact, versions] of byArtifact) {
    if (versions.size > 1) out.push({ artifact, versions: [...versions] })
  }
  return out.sort((a, b) => a.artifact.localeCompare(b.artifact))
}
