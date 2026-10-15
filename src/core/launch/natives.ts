/**
 * Native 库解压。
 *
 * 历史背景（决定了这里为什么这么写）：
 *  - 1.18 及更早：LWJGL 2/3 以 classifier jar（natives-windows 等）分发 dll/so，
 *    必须在启动前解压到 natives 目录，再交给 -Djava.library.path。
 *  - 1.19+：LWJGL 3.3 改为「从 classpath 里的 jar 中按需提取」，不再需要解压，
 *    但目录仍然要存在（部分启动器/模组会检查），所以只准备目录。
 *  - native jar 里的 `META-INF/` 下也可能有 dll（Windows 尤其常见），
 *    绝不能解压到 natives 目录 —— 既不会被加载，还会污染目录、拖慢扫描。
 *  - 部分 jar 同时携带 32/64 位文件（放在 x86/ x86_64/ 等子目录），
 *    因此一律保留 jar 内的相对目录结构，保证两个位数的文件互不覆盖。
 */

import AdmZip from 'adm-zip'
import { dirname, join, normalize, sep } from 'node:path'
import type { ResolvedLibrary } from '@core/mojang/library'
import { ensureDir, fileSize, pathExists, writeFile } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('launch:natives')

export interface ExtractNativesResult {
  /** 成功写出的文件绝对路径 */
  extracted: string[]
  /** 已存在且大小相同而跳过的文件绝对路径 */
  skipped: string[]
}

export async function extractNatives(opts: {
  natives: ResolvedLibrary[]
  nativeDir: string
  signal?: AbortSignal
}): Promise<ExtractNativesResult> {
  const { natives, nativeDir } = opts
  const result: ExtractNativesResult = { extracted: [], skipped: [] }
  await ensureDir(nativeDir)

  for (const lib of natives) {
    if (opts.signal?.aborted) throw new Error('aborted')
    if (!lib.isNative) continue
    if (!(await pathExists(lib.absolutePath))) {
      log.warn(`native 库不存在，跳过：${lib.absolutePath}`)
      continue
    }

    let zip: AdmZip
    try {
      zip = new AdmZip(lib.absolutePath)
    } catch (err) {
      log.warn(`native 库无法读取：${lib.absolutePath}（${err instanceof Error ? err.message : String(err)}）`)
      continue
    }

    const excludes = lib.extractExclude ?? []
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const entryName = entry.entryName.replace(/\\/g, '/')
      if (shouldSkipEntry(entryName, excludes)) continue
      const safe = safeEntryPath(entryName)
      if (!safe) continue

      const target = join(nativeDir, safe)
      const size = entry.header.size

      // 增量：已存在且大小一致就不再写盘（重复启动时显著加速）
      if ((await pathExists(target)) && (await fileSize(target)) === size) {
        result.skipped.push(target)
        continue
      }

      await ensureDir(dirname(target))
      try {
        await writeFile(target, entry.getData())
        result.extracted.push(target)
      } catch (err) {
        // 单个 dll 写失败（被杀软占用等）不应中断整个启动流程
        log.warn(`写出 native 文件失败：${target}（${err instanceof Error ? err.message : String(err)}）`)
      }
    }
  }

  log.debug(`native 解压完成：新增 ${result.extracted.length}，跳过 ${result.skipped.length}`)
  return result
}

/**
 * 准备 native 目录。
 * legacy=false（1.19+）时只保证目录存在；legacy=true 时同样只保证目录存在 ——
 * 解压由 extractNatives 负责，这里刻意不做「清空目录」：目录里可能同时有 32/64 位文件，
 * 清空后如果 extraction 中途失败会让游戏直接缺 dll。陈旧文件由增量覆盖处理。
 *
 * 另外还要建好几个子目录：1.21.9（LWJGL 3.4）起 natives 不再由启动器解压，
 * 而是把 natives jar 放上 classpath，由库自己在运行时解压，落点由 JVM 参数指定：
 *   -Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl
 *   -Dio.netty.native.workdir=${natives_directory}/netty
 *   -Djna.tmpdir=${natives_directory}/jna
 *   -Djava.library.path=${natives_directory}/java
 * 这几条参数在 26.3 的 version json 里是默认存在的，目录不存在时相关库的自解压会失败。
 */
export async function prepareNativeDir(dir: string, legacy: boolean): Promise<void> {
  await ensureDir(dir)
  if (!legacy) {
    for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
      await ensureDir(join(dir, sub))
    }
  }
  log.debug(`native 目录${legacy ? '（老版本，需解压）' : '（1.19+，无需解压）'}：${dir}`)
}

/* ------------------------------------------------------------------ *
 *  内部
 * ------------------------------------------------------------------ */

/** META-INF 一律跳过（可能含签名、dll、重复的 class）；extract.exclude 用简化规则匹配 */
function shouldSkipEntry(entryName: string, excludes: string[]): boolean {
  const upper = entryName.toUpperCase()
  if (upper === 'META-INF' || upper.startsWith('META-INF/')) return true
  for (const rule of excludes) {
    if (matchesExtractRule(rule, entryName)) return true
  }
  return false
}

/** 支持 `dir/` 前缀、精确文件名、以及 `*` / `**` 通配（不需要完整 glob 语义） */
function matchesExtractRule(pattern: string, entryName: string): boolean {
  const p = pattern.trim().replace(/\\/g, '/')
  if (!p) return false
  if (p.endsWith('/')) return entryName === p.slice(0, -1) || entryName.startsWith(p)
  if (!p.includes('*')) return entryName === p || entryName.startsWith(`${p}/`)
  const regex = new RegExp(
    '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*') +
      '$',
    'i'
  )
  return regex.test(entryName)
}

/** 归一化 jar 内路径；拒绝绝对路径与目录穿越 */
function safeEntryPath(entryName: string): string | null {
  const normalized = normalize(entryName).replace(/\\/g, '/')
  if (!normalized || normalized === '.') return null
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.')
  if (parts.length === 0 || parts.some((p) => p === '..')) return null
  // 避免 Windows 盘符（C:）之类出现在相对路径里
  if (parts[0].includes(':')) return null
  return parts.join(sep)
}
