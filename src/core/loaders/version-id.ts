/**
 * 加载器版本 id 的命名与反解。
 *
 * 命名规则来自各加载器官方与 HMCL 的实践（reference/HMCL/.../download/*）：
 *  - Fabric：`fabric-loader-<loaderVersion>-<gameVersion>`（Fabric 官方 profile json 的 id）
 *  - Quilt ：`quilt-loader-<loaderVersion>-<gameVersion>`
 *  - Forge ：`<gameVersion>-forge-<forgeVersion>`（Forge 官方 installer 生成的版本目录）
 *  - NeoForge：`neoforge-<neoforgeVersion>`（NeoForge installer 生成的版本目录）
 *  - OptiFine：`OptiFine_<gameVersion>_<type>_<patch>`（本项目采用；同时兼容 PCL2 的
 *    `<gameVersion>-OptiFine_<type>_<patch>`，见 ModDownloadLib.McDownloadOptiFineLoader）
 *
 * 反解的难点是「版本号里也可能出现 '-'」：
 *  - Quilt loader 的预发布版形如 `0.20.0-beta.9`；
 *  - MC 的预发布版形如 `1.21.1-pre1` / `1.20.5-rc1`；
 *  因此不能简单按 '-' 切分，必须让 MC 版本段用「版本号正则」从尾部锚定（见 MC_VERSION_RE）。
 */

import type { LoaderType } from '@shared/types'

/** MC 版本号（正式版 / 预发布 / 快照）；用于把 id 尾部的 gameVersion 锚定出来 */
const MC_VERSION_RE = /^(?:\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z]?)$/i

export interface ParsedLoaderVersionId {
  loaderType: LoaderType
  loaderVersion?: string
  gameVersion?: string
}

/**
 * NeoForge 版本号 → MC 版本号。
 *
 * 依据 reference/HMCL/.../download/neoforge/NeoForgeRemoteVersion.java#fetchAsync：
 *   - `20.4.237` → 1.20.4，`21.0.167` → 1.21（minor=0 时省略补丁位），`21.1.209` → 1.21.1
 *   - 主版本 >= 26（Minecraft 26.x 起的新命名）：`26.1.0` → 26.1，`26.1.2` → 26.1.2（不再有 "1." 前缀）
 *   - 主版本 == 0：快照式命名，取第一、二点之间的片段
 *   - 1.20.1 时代的 NeoForge 在 maven `net/neoforged/forge` 下，版本形如 `1.20.1-47.1.106`
 *     或归一化后的 `47.1.106`，都属于 MC 1.20.1（HMCL#normalize 与 PCL2 DlForgelikeEntry 注释）
 *
 * 无法映射时返回 null（调用方应跳过该版本而不是猜错）。
 */
export function neoforgeGameVersionFor(neoforgeVersion: string): string | null {
  const raw = neoforgeVersion.trim().replace(/^neoforge-/, '')
  if (!raw) return null

  // 1.20.1 legacy：maven 目录名 1.20.1-47.1.106 / 1.20.1-forge-47.1.99
  if (/^1\.20\.1(?:-forge)?-\d/.test(raw)) return '1.20.1'
  // 归一化后的 legacy 版本号（47.1.x 全部对应 1.20.1）
  if (/^47\.\d+\.\d+/.test(raw)) return '1.20.1'

  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!match) return null
  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)

  if (major === 0) {
    // 快照 / 实验命名：把第一、二点之间的片段当 MC 版本（HMCL 同款兜底）
    const first = raw.indexOf('.')
    const second = raw.indexOf('.', first + 1)
    if (first < 0 || second < 0) return null
    const between = raw.slice(first + 1, second)
    return MC_VERSION_RE.test(between) ? between : null
  }
  if (major >= 26) {
    // Minecraft 26.x 起版本号本身就是 MC 版本（26.1.0 → 26.1）
    return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`
  }
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`
}

/**
 * 从版本 id 反解加载器信息。
 * 无法识别的 id：形如原版版本号（1.20.1 / 24w14a / 1.21.1-pre1）→ vanilla，其余 → custom。
 */
export function parseLoaderVersionId(versionId: string): ParsedLoaderVersionId {
  const id = (versionId ?? '').trim()
  if (!id) return { loaderType: 'custom' }

  // Fabric / Quilt：loader 段可能含 '-'（Quilt 预发布），MC 段从尾部锚定
  const fabricLike = /^(fabric|quilt)-loader-(.+?)-(\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z]?)$/i.exec(id)
  if (fabricLike) {
    const loaderType: LoaderType = fabricLike[1].toLowerCase() === 'quilt' ? 'quilt' : 'fabric'
    return { loaderType, loaderVersion: fabricLike[2], gameVersion: fabricLike[3] }
  }

  // OptiFine：本项目命名 OptiFine_<mc>_<type>_<patch>；兼容 PCL2 的 <mc>-OptiFine_<type>_<patch>
  const pclStyle = /^(\d+\.\d+(?:\.\d+)?|\d{2}w\d{2}[a-z]?)-OptiFine_(.+)$/i.exec(id)
  const optifineBody = pclStyle ? pclStyle[2] : /^OptiFine_(.+)$/i.exec(id)?.[1]
  if (optifineBody) {
    const withMc = /^(\d+\.\d+(?:\.\d+)?|\d{2}w\d{2}[a-z]?)_(.+)$/i.exec(optifineBody)
    const gameVersion = pclStyle ? pclStyle[1] : withMc?.[1]
    const tail = withMc ? withMc[2] : optifineBody
    const underscore = tail.lastIndexOf('_')
    const type = underscore > 0 ? tail.slice(0, underscore) : tail
    const patch = underscore > 0 ? tail.slice(underscore + 1) : undefined
    const loaderVersion = patch ? `${type}_${patch}` : type
    return { loaderType: 'optifine', loaderVersion, gameVersion }
  }

  // Forge：<mc>-forge-<forge>（合法 MC 版本号限制在 mc 段，允许 mc 带 -preN）
  const forge = /^(\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z]?)-forge-(.+)$/i.exec(id)
  if (forge) {
    return { loaderType: 'forge', loaderVersion: forge[2], gameVersion: forge[1] }
  }

  // NeoForge：neoforge-<version>
  const neo = /^neoforge-(.+)$/i.exec(id)
  if (neo) {
    return { loaderType: 'neoforge', loaderVersion: neo[1], gameVersion: neoforgeGameVersionFor(neo[1]) ?? undefined }
  }

  // LiteLoader（尚未实现安装，只做识别）：liteloader-<mc>
  const lite = /^liteloader-(.+)$/i.exec(id)
  if (lite) return { loaderType: 'liteloader', gameVersion: lite[1] }

  if (MC_VERSION_RE.test(id)) return { loaderType: 'vanilla', gameVersion: id }
  return { loaderType: 'custom' }
}

/** 取版本 id 背后的原版 gameVersion：loader 版本返回其父版本号，否则原样返回 */
export function baseGameVersionOf(versionId: string): string {
  return parseLoaderVersionId(versionId).gameVersion ?? versionId
}

/** `<mc>-forge-<forge>` */
export function forgeVersionId(gameVersion: string, forgeVersion: string): string {
  return `${gameVersion}-forge-${forgeVersion}`
}

/** `fabric-loader-<loader>-<mc>` / `quilt-loader-<loader>-<mc>` */
export function fabricLikeVersionId(loaderType: 'fabric' | 'quilt', loaderVersion: string, gameVersion: string): string {
  return `${loaderType}-loader-${loaderVersion}-${gameVersion}`
}

/** `neoforge-<version>` */
export function neoForgeVersionId(neoforgeVersion: string): string {
  return `neoforge-${neoforgeVersion}`
}

/** `OptiFine_<mc>_<type>_<patch>`；patch 缺省时退化为 `OptiFine_<mc>_<type>` */
export function optifineVersionId(gameVersion: string, type: string, patch?: string): string {
  return patch ? `OptiFine_${gameVersion}_${type}_${patch}` : `OptiFine_${gameVersion}_${type}`
}
