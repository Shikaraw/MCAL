/**
 * 项目脚手架：把模板渲染成真实工程。
 *
 * 渲染规则（与模板目录里 `{{variableName}}` 占位符对应）：
 *  - 支持 `{{name}}` 与 `{{ name }}`（容错空格）；
 *  - 内置派生变量：modid / ModClassName / packagePath / modName / modVersion /
 *    author / description / license / year；
 *  - 路径中的占位符同样会被替换，替换后不会残留 `{{`、`}}`；
 *  - 未定义的变量不静默留空：收集成 warnings，并原样保留 `{{name}}` 便于发现；
 *  - 目标目录非空时必须显式 force；force 时只覆盖同名文件并记录 warning；
 *  - 不生成二进制（gradle wrapper jar 等），由 nextSteps 指引用户自行生成；
 *  - initGit 只写 .gitignore，不调用外部 git 命令。
 */

import { basename, join, resolve } from 'node:path'
import type { TemplateKind, TemplateManifest, TemplateRegistry } from '@core/dev/templates'
import { ensureDir, pathExists, toPosix, walkFiles, writeFileAtomic } from '@core/util/fsx'
import { logger } from '@core/util/logger'

const log = logger.scoped('dev:scaffold')

export interface ScaffoldOptions {
  templateId: string
  targetDir: string
  variables: Record<string, string>
  /** 允许目标目录非空时仍写入（只覆盖同名文件） */
  force?: boolean
  /** 是否初始化 git 仓库（实际只写 .gitignore） */
  initGit?: boolean
}

export interface ScaffoldResult {
  root: string
  files: string[]
  warnings: string[]
  nextSteps: string[]
}

/** `{{ name }}` / `{{name}}` 占位符 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g

/* ------------------------------------------------------------------ *
 *  变量派生
 * ------------------------------------------------------------------ */

/** 由名称生成合法 modid：小写、非字母数字转 `_`、去掉连续/首尾下划线 */
export function normalizeModId(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 由名称生成 PascalCase 类名（处理空格、连字符、camelCase、中文等边界） */
export function toPascalCase(name: string): string {
  const parts = String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
  let out = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  if (!out) out = ''
  if (/^[0-9]/.test(out)) out = `Mod${out}`
  return out
}

/** 由包名生成目录路径：com.example.mymod -> com/example/mymod */
export function packageToPath(packageName: string): string {
  return String(packageName ?? '')
    .split('.')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
    .join('/')
}

/**
 * 计算派生变量（即使调用方没传也要算出来）。
 * 这些值会被 resolveVariables 合并进最终变量表，调用方可显式覆盖。
 */
export function deriveVariables(input: Record<string, string>): Record<string, string> {
  const name = (input.name ?? input.modName ?? '').trim()
  const modid = (input.modid ?? '').trim() || normalizeModId(name)
  const modClassName = (input.ModClassName ?? '').trim() || toPascalCase(name) || 'ExampleMod'
  const pkg = (input.package ?? '').trim()
  const derived: Record<string, string> = {
    modid,
    ModClassName: modClassName,
    modName: name || modid,
    modVersion: (input.modVersion ?? '').trim() || '1.0.0',
    author: (input.author ?? '').trim() || 'YourName',
    description: (input.description ?? '').trim() || `由 MCAL 脚手架生成的项目：${name || modid}`,
    license: (input.license ?? '').trim() || 'MIT',
    year: String(new Date().getFullYear())
  }
  // packagePath 只在提供了包名时派生，避免在非 Java 模板里生成空路径
  const explicitPath = (input.packagePath ?? '').trim()
  if (explicitPath) derived.packagePath = explicitPath.replace(/\\/g, '/')
  else if (pkg) derived.packagePath = packageToPath(pkg)
  return derived
}

/* ------------------------------------------------------------------ *
 *  渲染
 * ------------------------------------------------------------------ */

/** 替换占位符；未定义的变量原样保留并记入 missing（不静默留空） */
export function renderText(text: string, values: Record<string, string>, missing?: Set<string>): string {
  return text.replace(PLACEHOLDER_RE, (match, rawKey: string) => {
    const key = rawKey.trim()
    const value = values[key]
    if (value === undefined || value === null) {
      missing?.add(key)
      return match
    }
    return value
  })
}

/** 渲染路径片段：替换占位符后不允许残留 `{{` / `}}` */
export function renderPath(path: string, values: Record<string, string>, missing?: Set<string>): string {
  return renderText(path, values, missing).replace(/\{\{|\}\}/g, '_')
}

function renderAll(
  rawFiles: { path: string; content: string }[],
  values: Record<string, string>
): { files: { path: string; content: string }[]; warnings: string[] } {
  const missing = new Set<string>()
  const files = rawFiles.map((file) => ({
    path: renderPath(file.path, values, missing),
    content: renderText(file.content, values, missing)
  }))

  const warnings: string[] = []
  for (const key of missing) {
    warnings.push(`模板引用了未定义的变量 {{${key}}}：已在输出中原样保留，请手工替换（或在 variables 里补充该键）。`)
  }
  return { files, warnings }
}

/* ------------------------------------------------------------------ *
 *  .gitignore（按模板类型选择忽略项）
 * ------------------------------------------------------------------ */

export function gitignoreFor(kind: TemplateKind): string {
  const header = [
    '# 由 MCAL 脚手架生成（initGit 只写文件，不执行 git 命令）',
    '# 需要版本管理时：git init && git add . && git commit -m "init"',
    ''
  ]
  const common = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '*.log', '']

  switch (kind) {
    case 'mod':
    case 'plugin':
      return [
        ...header,
        '# Gradle 构建产物',
        '.gradle/',
        'build/',
        'out/',
        'bin/',
        '*.class',
        '',
        '# IDE',
        '.idea/',
        '*.iml',
        '*.ipr',
        '*.iws',
        '.vscode/',
        '.settings/',
        '.project',
        '.classpath',
        '',
        '# 游戏运行目录（runClient/runServer 产生）',
        'run/',
        'run-data/',
        '.mixin.out/',
        'logs/',
        'crash-reports/',
        'saves/',
        '',
        '# 发布产物：源码包/开发包通常不入库',
        '*-sources.jar',
        '*-dev.jar',
        '',
        ...common
      ].join('\n')
    case 'modpack':
      return [
        ...header,
        '# 打包产物',
        '*.zip',
        '*.mrpack',
        '',
        '# 不要把玩家数据放进整合包工程',
        'logs/',
        'crash-reports/',
        'saves/',
        'screenshots/',
        'servers.dat',
        'usercache.json',
        'launcher_profiles*.json',
        '',
        ...common
      ].join('\n')
    case 'datapack':
    case 'resourcepack':
      return [
        ...header,
        '# 打包产物（发布用 zip 不入库，或按需保留）',
        '*.zip',
        '',
        '# 编辑器临时文件',
        '*.psd',
        '*.xcf',
        '*.kra',
        '',
        ...common
      ].join('\n')
    case 'shaderpack':
      return [
        ...header,
        '# 发布包',
        '*.zip',
        '',
        '# 编译缓存（Iris/OptiFine 不会输出到这里，防手滑）',
        '*.spv',
        '*.glsl.cache',
        '',
        ...common
      ].join('\n')
    default:
      return [...header, ...common].join('\n')
  }
}

/* ------------------------------------------------------------------ *
 *  后续指引
 * ------------------------------------------------------------------ */

/** 生成具体的中文后续指引（如何构建、产物在哪、怎么装、需要什么 JDK） */
export function buildNextSteps(
  manifest: TemplateManifest,
  values: Record<string, string>,
  files: string[]
): string[] {
  const steps: string[] = []
  const modid = values.modid ?? '<modid>'
  const version = values.modVersion ?? '1.0.0'
  const hasGradle = files.some((f) => basename(f) === 'build.gradle')
  const hasWrapper = files.some((f) => f === 'gradlew' || f === 'gradlew.bat')

  if (hasGradle) {
    if (!hasWrapper) {
      steps.push(
        '项目未包含 gradle wrapper（脚手架不提供二进制 gradle-wrapper.jar）：先在项目根目录执行 `gradle wrapper` 生成 wrapper，或直接使用系统安装的 gradle（`gradle build`）。'
      )
    }
    steps.push('构建（首次会下载依赖，耗时较长）：Windows 用 `gradlew.bat build`，macOS/Linux 用 `./gradlew build`。')
    steps.push(`构建产物：\`build/libs/${modid}-${version}.jar\`（注意排除 -sources / -dev / -slim 等分类器 jar，它们不能直接用）。`)
    if (manifest.javaVersion) {
      steps.push(
        `需要 JDK ${manifest.javaVersion}：用 \`java -version\` 确认；不一致时设置 JAVA_HOME 或改 IDE 的 Gradle JVM。`
      )
    }
    if (manifest.kind === 'mod') {
      steps.push('运行调试：`./gradlew runClient` 直接启动带模组的客户端，`runServer` 启动服务端。')
      steps.push(`安装到游戏：把构建好的 jar 复制到 .minecraft/${manifest.installDir ?? 'mods'}/（版本需为 ${manifest.gameVersion ?? '目标版本'}）。`)
    } else if (manifest.kind === 'plugin') {
      steps.push(`安装到服务端：把 jar 复制到服务端根目录的 ${manifest.installDir ?? 'plugins'}/ 后重启服务端。`)
      steps.push('不要依赖 /reload 加载新插件：Bukkit 系插件热重载容易泄漏类加载器，开发期也建议重启测试服。')
    }
  } else {
    switch (manifest.kind) {
      case 'shaderpack':
        steps.push('使用方式：把整个目录压缩为 zip（zip 根目录下直接是 `shaders/` 与 `README.md`），复制到 .minecraft/shaderpacks/，游戏内「选项 → 视频设置 → 光影」选择。')
        steps.push('调试：先在 lib/options.glsl 里取消注释 `#define DEBUG` 确认着色器已生效，出问题看 logs/latest.log 的 GLSL 编译日志。')
        break
      case 'resourcepack':
        steps.push('使用方式：把 `pack.mcmeta` 与 `assets/` 一起压缩为 zip（zip 根目录直接是它们），复制到 .minecraft/resourcepacks/，游戏内启用。')
        steps.push('改完贴图按 F3+T 重载资源包；pack_format 必须与游戏版本匹配（1.20.1 = 15）。')
        break
      case 'datapack':
        steps.push('使用方式：把整个目录复制到存档的 `saves/<世界名>/datapacks/`（服务端为 `world/datapacks/`），或在 MCAL 中直接安装。')
        steps.push(`进游戏执行 \`/reload\` 重载，再执行 \`/function ${modid}:hello\` 验证示例函数。`)
        break
      case 'modpack':
        steps.push('把 mcal-pack.json 里的 `files[]` 示例条目替换为真实下载信息（Modrinth 的 projectId/versionId，或直链 + sha1/sha512）。')
        steps.push('本机测试：用 MCAL 的「导入整合包」指向该目录；分发：把 mcal-pack.json 与 overrides/ 打包为 zip（根目录直接是它们）。')
        steps.push('发布到平台需要导出格式转换：Modrinth 用 modrinth.index.json（.mrpack），CurseForge 用 manifest.json。')
        break
      default:
        break
    }
  }

  if (manifest.postInstallNote) steps.push(manifest.postInstallNote)
  return steps
}

/* ------------------------------------------------------------------ *
 *  Scaffolder
 * ------------------------------------------------------------------ */

export class Scaffolder {
  private readonly registry: TemplateRegistry

  constructor(opts: { registry: TemplateRegistry }) {
    this.registry = opts.registry
  }

  /** 计算变量默认值 + 校验必填项 */
  resolveVariables(
    manifest: TemplateManifest,
    input: Record<string, string>
  ): { values: Record<string, string>; errors: string[]; derived: Record<string, string> } {
    const errors: string[] = []
    const pass1 = deriveVariables(input)

    // 1) 模板变量：默认值可引用派生变量（例如默认包名 com.example.{{modid}}）
    const values: Record<string, string> = {}
    for (const variable of manifest.variables) {
      const provided = (input[variable.key] ?? '').trim()
      const fallback = variable.default !== undefined ? renderText(variable.default, pass1).trim() : ''
      const value = provided || fallback
      if (value) values[variable.key] = value
      else if (variable.required) errors.push(`缺少必填变量：${variable.label}（${variable.key}）`)
    }

    // 2) 调用方额外传入的键（含对派生变量的显式覆盖）
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.trim() !== '') values[key] = value.trim()
    }

    // 3) 用最终值重算派生变量，并合并（显式值优先）
    const derived = deriveVariables(values)
    const finalValues: Record<string, string> = { ...derived }
    for (const [key, value] of Object.entries(values)) {
      if (value !== '') finalValues[key] = value
    }
    // 派生变量兜底回填（例如调用方只给了 package，没给 packagePath）
    for (const [key, value] of Object.entries(derived)) {
      if (!finalValues[key]) finalValues[key] = value
    }

    // 4) 校验关键派生值
    const modid = finalValues.modid ?? ''
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(modid)) {
      errors.push(
        `无法生成合法 modid（当前为 “${modid}”）：需要 2~64 位、以小写字母开头、只能是 a-z0-9_。请在变量里显式提供 modid，或把名称改得更简洁（英文/数字）。`
      )
    }
    const pkg = (finalValues.package ?? '').trim()
    if (pkg && !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(pkg)) {
      errors.push(`包名不合法：${pkg}（应为形如 com.example.mymod 的点分小写标识符，至少两段）`)
    }
    if (!finalValues.ModClassName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(finalValues.ModClassName)) {
      errors.push(`无法生成合法类名（当前为 “${finalValues.ModClassName}”）：请在变量里显式提供 ModClassName。`)
    }

    return { values: finalValues, errors, derived }
  }

  /** 只预览（返回渲染后的文件内容，不落盘） */
  async preview(opts: ScaffoldOptions): Promise<{ files: { path: string; content: string }[] }> {
    const manifest = await this.requireManifest(opts.templateId)
    const { values, errors } = this.resolveVariables(manifest, opts.variables)
    if (errors.length > 0) throw new Error(`模板变量校验失败：\n - ${errors.join('\n - ')}`)
    const rawFiles = await this.registry.readFilesOf(manifest)
    const { files } = renderAll(rawFiles, values)
    return { files }
  }

  /** 渲染并落盘 */
  async scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
    const manifest = await this.requireManifest(opts.templateId)
    const { values, errors } = this.resolveVariables(manifest, opts.variables)
    if (errors.length > 0) throw new Error(`模板变量校验失败：\n - ${errors.join('\n - ')}`)

    const root = resolve(opts.targetDir)
    const rawFiles = await this.registry.readFilesOf(manifest)
    const { files, warnings } = renderAll(rawFiles, values)
    const renderedPaths = this.sanitizePaths(files.map((f) => f.path), warnings)

    // 目标目录非空检查
    const existing = await walkFiles(root)
    const existingSet = new Set(existing)
    if (existing.length > 0 && !opts.force) {
      const sample = existing.slice(0, 3).join('、')
      throw new Error(
        `目标目录不为空，已中止以免覆盖你的文件：${root}\n` +
          `（现有 ${existing.length} 个文件，例如 ${sample}）\n` +
          `如确认要写入请设置 force=true（只会覆盖同名文件），或换一个空目录。`
      )
    }

    // 落盘
    for (let i = 0; i < files.length; i++) {
      const rel = renderedPaths[i]
      const target = join(root, rel)
      if (existingSet.has(rel)) {
        warnings.push(`已覆盖同名文件：${rel}（force=true）`)
      }
      await writeFileAtomic(target, files[i].content)
    }

    // .gitignore（不调用外部 git 命令）
    if (opts.initGit) {
      const gitignorePath = join(root, '.gitignore')
      if (await pathExists(gitignorePath)) {
        warnings.push('已覆盖已有的 .gitignore（initGit=true）。')
      }
      await ensureDir(root)
      await writeFileAtomic(gitignorePath, gitignoreFor(manifest.kind))
      renderedPaths.push('.gitignore')
    }

    // 模板声明要保留的空目录（如图片资源目录），显式建出来
    const declaredDirs = manifest.directories ?? []
    if (declaredDirs.length > 0) {
      const missingVars = new Set<string>()
      const rendered = declaredDirs.map((dir) => renderPath(dir, values, missingVars))
      const safeDirs = this.sanitizePaths(rendered, warnings)
      for (const dir of safeDirs) {
        if (!dir) continue
        await ensureDir(join(root, dir))
      }
      for (const key of missingVars) {
        warnings.push(`directories 引用了未定义的变量 {{${key}}}：已原样保留，请手工处理。`)
      }
    }

    const nextSteps: string[] = [`项目已生成到：${root}`, ...buildNextSteps(manifest, values, files.map((f) => f.path))]
    if (opts.initGit) {
      nextSteps.push(
        `已按 ${manifest.kind} 类型生成 .gitignore；需要版本管理时自行执行：cd "${root}" && git init && git add . && git commit -m "init"。`
      )
    }

    log.info(`脚手架生成完成：${manifest.id} -> ${root}（${renderedPaths.length} 个文件）`)
    return { root, files: renderedPaths, warnings, nextSteps }
  }

  private async requireManifest(templateId: string): Promise<TemplateManifest> {
    const manifest = await this.registry.get(templateId)
    if (!manifest) {
      const available = (await this.registry.list()).map((m) => m.id).join('、')
      throw new Error(`未找到模板：${templateId}。可用模板：${available || '（模板目录为空，请检查 resources/templates）'}`)
    }
    return manifest
  }

  /** 路径清洗：统一斜杠、去掉越界的 `..` 段、去掉绝对路径前缀 */
  private sanitizePaths(paths: string[], warnings: string[]): string[] {
    return paths.map((raw) => {
      const posix = toPosix(raw)
      const segments = posix
        .split('/')
        .filter((seg) => seg !== '' && seg !== '.')
        .filter((seg) => {
          if (seg === '..') {
            warnings.push(`模板路径包含越界片段已忽略：${raw}`)
            return false
          }
          return true
        })
      return segments.join('/')
    })
  }
}
