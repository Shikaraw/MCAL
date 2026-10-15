/**
 * Minecraft 专属工具集：让 Agent 能真正操作启动器（而不是只读文件）。
 *
 * 这些工具是 MCAL 与「通用编程 Agent」的核心差异所在：
 * 它们把实例、版本、加载器、日志、诊断、mod、服务端、整合包等概念
 * 直接暴露给模型，模型因此可以用「启动器语言」而不是「文件操作语言」
 * 来解决问题。
 */

import type { ContentKind, LoaderType, Platform, ProjectType, ServerCoreType, ToolInvocationContext } from '@shared/types'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  requireStringArray,
  type ToolDefinitionWithHandler
} from './registry'

/** 大输出统一截断，避免把上下文塞爆 */
function cut(text: string, max = 12_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字）` : text
}

/** 找到实例：允许用 id 或名称 */
async function resolveInstance(
  ctx: ToolInvocationContext,
  ref: string
): Promise<{ id: string; name: string; gameDir: string; versionId: string; loaderType: LoaderType }> {
  const instances = await ctx.services.launcher.listInstances()
  if (instances.length === 0) {
    throw new Error('当前没有任何实例。请先用 mc_create_instance 创建实例，或让用户在界面里新建。')
  }
  const exact = instances.find((i) => i.id === ref)
  const byName = instances.find((i) => i.name === ref)
  const byFuzzy = instances.find((i) => i.name.includes(ref) || i.id.includes(ref))
  const target = exact ?? byName ?? byFuzzy
  if (!target) {
    throw new Error(
      `找不到实例「${ref}」。现有实例：${instances.map((i) => `${i.name}(${i.id})`).join('、')}`
    )
  }
  return {
    id: target.id,
    name: target.name,
    gameDir: target.gameDir,
    versionId: target.versionId,
    loaderType: target.loaderType
  }
}

export function createLauncherTools(): ToolDefinitionWithHandler[] {
  return [
    /* ---------------------------- 实例 ---------------------------- */
    {
      name: 'mc_list_instances',
      description:
        '列出所有游戏实例（名称、版本、加载器、内存、最后游玩时间、标签）。开始任何操作前先调用它了解现状。',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'minecraft',
      readOnly: true,
      handler: async (_args, ctx) => {
        const instances = await ctx.services.launcher.listInstances()
        const running = await ctx.services.launcher.listRunningGames().catch(() => [])
        if (instances.length === 0) {
          return { ok: true, output: '当前没有实例。可以用 mc_create_instance 创建。', meta: { count: 0 } }
        }
        const lines = instances.map((instance) => {
          const isRunning = running.some((r) => r.instanceId === instance.id)
          return [
            `- ${instance.name}（id: ${instance.id}）${isRunning ? ' **[运行中]**' : ''}`,
            `  版本 ${instance.versionId}｜加载器 ${instance.loaderType}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}`,
            `  目录 ${instance.gameDir}`,
            `  内存 ${instance.memory.auto ? '自动' : `${instance.memory.maxMB}MB`}｜Java ${instance.java.javaPath ?? '自动选择'}`,
            instance.notes ? `  备注：${instance.notes}` : '',
            instance.lastPlayedAt ? `  最后游玩：${instance.lastPlayedAt.slice(0, 16).replace('T', ' ')}` : ''
          ]
            .filter(Boolean)
            .join('\n')
        })
        return { ok: true, output: `共 ${instances.length} 个实例：\n\n${lines.join('\n\n')}`, meta: { count: instances.length } }
      }
    },
    {
      name: 'mc_instance_info',
      description:
        '查看某个实例的详细信息：版本、加载器、Java、内存、目录结构、mod/资源包/光影数量、最近的日志文件列表。诊断问题时的第一站。',
      parameters: {
        type: 'object',
        properties: { instance: { type: 'string', description: '实例 id 或名称' } },
        required: ['instance']
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const ref = requireString(args, 'instance')
        const target = await resolveInstance(ctx, ref)
        const instance = await ctx.services.launcher.getInstance(target.id)
        if (!instance) return { ok: false, output: `实例不存在：${ref}` }
        const content = await ctx.services.launcher.scanContent(instance.gameDir).catch(() => [])
        const logs = await ctx.services.launcher.listLogs(instance).catch(() => [])
        const java = await ctx.services.launcher.listJava().catch(() => [])
        const byKind = new Map<ContentKind, number>()
        for (const file of content) byKind.set(file.kind, (byKind.get(file.kind) ?? 0) + 1)
        const problems = content.filter((c) => c.error)
        const detail = [
          `# 实例：${instance.name}`,
          `- id：${instance.id}`,
          `- 游戏目录：${instance.gameDir}`,
          `- 版本：${instance.versionId}｜加载器：${instance.loaderType}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}`,
          `- 内存：${instance.memory.auto ? `自动（上限 ${instance.memory.maxMB}MB）` : `${instance.memory.minMB}~${instance.memory.maxMB}MB`}`,
          `- Java：${instance.java.javaPath ?? '自动'}｜额外 JVM 参数：${(instance.java.extraJvmArgs ?? []).join(' ') || '无'}`,
          `- 窗口：${instance.window.width}x${instance.window.height}${instance.window.fullscreen ? ' 全屏' : ''}`,
          `- 内容统计：${[...byKind.entries()].map(([kind, count]) => `${kind} ${count}`).join('｜') || '无'}`,
          problems.length > 0
            ? `- ⚠️ 有 ${problems.length} 个内容文件元数据读取异常：${problems.slice(0, 5).map((p) => `${p.fileName}(${p.error})`).join('、')}`
            : '',
          `- 可用 Java：${java.map((j) => `${j.majorVersion}(Java ${j.vendor ?? '?'})`).join('、') || '未检测到'}`,
          logs.length > 0 ? `\n## 日志文件\n${logs.slice(0, 8).map((l) => `- ${l.name}（${(l.size / 1024).toFixed(0)}KB，${new Date(l.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}）`).join('\n')}` : '',
          content.length > 0
            ? `\n## 内容文件\n${content.slice(0, 40).map((c) => `- [${c.kind}${c.enabled ? '' : ' 已禁用'}] ${c.fileName}${c.meta?.version ? ` v${c.meta.version}` : ''}${c.meta?.id ? ` (${c.meta.id})` : ''}`).join('\n')}${content.length > 40 ? `\n…（共 ${content.length} 个文件）` : ''}`
            : ''
        ]
          .filter(Boolean)
          .join('\n')
        return { ok: true, output: cut(detail), meta: { instanceId: instance.id } }
      }
    },
    {
      name: 'mc_create_instance',
      description:
        '创建新实例。可以只指定名称（会自动创建一个与原版最新版本关联的实例），也可以指定游戏版本与内存。' +
        '注意：这不会下载游戏文件；若目标版本未安装，用户或 mc_install_version 需要先安装。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '实例名称' },
          gameVersion: { type: 'string', description: '游戏版本，例如 1.20.1；不填则用已安装版本或最新正式版' },
          loaderType: { type: 'string', description: '加载器：vanilla/forge/neoforge/fabric/quilt/optifine' },
          loaderVersion: { type: 'string', description: '加载器版本' },
          maxMemoryMB: { type: 'number', description: '最大内存（MB）' },
          gameDir: { type: 'string', description: '自定义游戏目录；不填则使用默认目录下的同名文件夹' }
        },
        required: ['name']
      },
      category: 'minecraft',
      handler: async (args, ctx) => {
        const name = requireString(args, 'name')
        const instance = await ctx.services.launcher.createInstance({
          name,
          versionId: optionalString(args, 'gameVersion'),
          loaderType: (optionalString(args, 'loaderType') as LoaderType | undefined) ?? 'vanilla',
          loaderVersion: optionalString(args, 'loaderVersion'),
          gameDir: optionalString(args, 'gameDir'),
          memory: optionalNumber(args, 'maxMemoryMB')
            ? { minMB: 0, maxMB: optionalNumber(args, 'maxMemoryMB')!, auto: false }
            : undefined
        } as never)
        return {
          ok: true,
          output: `已创建实例「${instance.name}」（id: ${instance.id}，目录 ${instance.gameDir}，版本 ${instance.versionId}）`,
          meta: { instanceId: instance.id }
        }
      }
    },
    {
      name: 'mc_update_instance',
      description:
        '修改实例设置：内存（maxMemoryMB）、Java 路径（javaPath）、额外 JVM 参数（extraJvmArgs）、窗口大小、备注、标签等。' +
        '用户抱怨内存不足时用这个调大内存，而不是让用户自己去点界面。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          maxMemoryMB: { type: 'number', description: '最大内存（MB）' },
          minMemoryMB: { type: 'number', description: '最小内存（MB）' },
          autoMemory: { type: 'boolean', description: '是否改为自动内存' },
          javaPath: { type: 'string', description: 'Java 可执行文件路径' },
          extraJvmArgs: { type: 'array', items: { type: 'string' }, description: '额外 JVM 参数' },
          extraGameArgs: { type: 'array', items: { type: 'string' }, description: '额外游戏参数' },
          windowWidth: { type: 'number', description: '窗口宽度' },
          windowHeight: { type: 'number', description: '窗口高度' },
          notes: { type: 'string', description: '备注' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' }
        },
        required: ['instance']
      },
      category: 'minecraft',
      handler: async (args, ctx) => {
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        const patch: Record<string, unknown> = {}
        if (args.maxMemoryMB !== undefined || args.minMemoryMB !== undefined || args.autoMemory !== undefined) {
          patch.memory = {
            minMB: optionalNumber(args, 'minMemoryMB', 0) ?? 0,
            maxMB: optionalNumber(args, 'maxMemoryMB', 0) ?? 0,
            auto: optionalBoolean(args, 'autoMemory', false)
          }
        }
        if (args.javaPath !== undefined) patch.java = { javaPath: optionalString(args, 'javaPath') }
        if (args.extraJvmArgs !== undefined) {
          patch.java = { ...(patch.java as object), extraJvmArgs: requireStringArray(args, 'extraJvmArgs') }
        }
        if (args.extraGameArgs !== undefined) patch.extraGameArgs = requireStringArray(args, 'extraGameArgs')
        if (args.windowWidth !== undefined || args.windowHeight !== undefined) {
          patch.window = {
            width: optionalNumber(args, 'windowWidth', 854) ?? 854,
            height: optionalNumber(args, 'windowHeight', 480) ?? 480,
            fullscreen: false
          }
        }
        if (args.notes !== undefined) patch.notes = optionalString(args, 'notes')
        if (args.tags !== undefined) patch.tags = requireStringArray(args, 'tags')
        if (Object.keys(patch).length === 0) return { ok: false, output: '没有提供任何要修改的字段。' }
        const updated = await ctx.services.launcher.updateInstance(target.id, patch as never)
        return {
          ok: true,
          output: `已更新实例「${updated.name}」：${Object.keys(patch).join('、')}`,
          meta: { instanceId: updated.id }
        }
      }
    },

    /* ---------------------------- 版本 ---------------------------- */
    {
      name: 'mc_list_versions',
      description: '列出已安装的版本与可用版本清单（含版本类型与加载器）。安装新版本前先看看有哪些已装。',
      parameters: {
        type: 'object',
        properties: {
          showAvailable: { type: 'boolean', description: '是否同时列出可下载的版本（较长），默认 false' }
        },
        required: []
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const versions = await ctx.services.launcher.listVersions()
        const installed = versions.filter((v) => v.installed)
        const lines = [
          `## 已安装版本（${installed.length} 个）`,
          installed.length > 0
            ? installed.map((v) => `- ${v.id}（类型 ${v.type}，加载器 ${v.loaderType}）`).join('\n')
            : '- （无）'
        ]
        if (optionalBoolean(args, 'showAvailable')) {
          const available = versions.filter((v) => !v.installed)
          lines.push(`\n## 可安装版本（共 ${available.length} 个，仅显示前 40）`)
          lines.push(available.slice(0, 40).map((v) => `- ${v.id}（${v.type}）`).join('\n'))
        }
        return { ok: true, output: cut(lines.join('\n')), meta: { installed: installed.length } }
      }
    },
    {
      name: 'mc_install_version',
      description:
        '下载安装某个 Minecraft 原版版本（客户端 jar + 库 + 资源文件）。这是耗时较长的操作（几百 MB），调用前应告知用户。' +
        '若目标只是检查环境，请不要安装。',
      parameters: {
        type: 'object',
        properties: { gameVersion: { type: 'string', description: '要安装的版本号，例如 1.20.1' } },
        required: ['gameVersion']
      },
      category: 'minecraft',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `下载安装 Minecraft ${String(args.gameVersion ?? '')}`,
        detail: '将从镜像或官方源下载数百 MB 的游戏文件到本地磁盘',
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        const gameVersion = requireString(args, 'gameVersion')
        ctx.emit({ type: 'notice', level: 'info', message: `开始安装 Minecraft ${gameVersion}…` })
        const result = await ctx.services.launcher.installVersion(gameVersion)
        return {
          ok: true,
          output: `已安装 Minecraft ${gameVersion}（版本 id: ${result.versionId}）。`,
          meta: result
        }
      }
    },
    {
      name: 'mc_install_loader',
      description:
        '为某个版本安装 Mod 加载器（fabric / quilt / forge / neoforge / optifine）。' +
        '安装 Forge/NeoForge/OptiFine 需要本地已有可用的 Java。安装完成后会生成新的版本 id（例如 1.20.1-forge-47.2.0）。',
      parameters: {
        type: 'object',
        properties: {
          gameVersion: { type: 'string', description: '目标游戏版本，例如 1.20.1' },
          loaderType: { type: 'string', description: '加载器类型：fabric/quilt/forge/neoforge/optifine' },
          loaderVersion: { type: 'string', description: '加载器版本；不填则自动选择推荐版本' },
          createInstance: { type: 'boolean', description: '是否同时创建一个使用该加载器的实例，默认 true' },
          instanceName: { type: 'string', description: '新实例名称' }
        },
        required: ['gameVersion', 'loaderType']
      },
      category: 'minecraft',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `安装 ${String(args.loaderType ?? '')} 加载器（MC ${String(args.gameVersion ?? '')}）`,
        detail: '会下载安装器与依赖库，并可能执行加载器的安装程序',
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        const gameVersion = requireString(args, 'gameVersion')
        const loaderType = requireString(args, 'loaderType') as LoaderType
        const instances = await ctx.services.launcher.listInstances()
        const gameDir = instances[0]?.gameDir ?? ''
        if (!gameDir) {
          return { ok: false, output: '还没有任何实例，无法确定游戏目录。请先用 mc_create_instance 创建实例。' }
        }
        const result = await ctx.services.launcher.installLoader({
          gameDir,
          versionId: gameVersion,
          loaderType,
          loaderVersion: optionalString(args, 'loaderVersion') ?? '',
          createInstance: optionalBoolean(args, 'createInstance', true),
          instanceName: optionalString(args, 'instanceName')
        })
        const warnings = result.warnings.length > 0 ? `\n\n注意事项：\n${result.warnings.map((w) => `- ${w}`).join('\n')}` : ''
        return {
          ok: true,
          output: `已安装 ${loaderType} ${result.loaderVersion}（版本 id：${result.versionId}）${warnings}`,
          meta: result
        }
      }
    },
    {
      name: 'mc_verify_version',
      description:
        '校验某个版本的安装完整性：检查客户端 jar、库文件、资源文件是否缺失或损坏。启动失败或有奇怪报错时先跑这个。',
      parameters: {
        type: 'object',
        properties: {
          gameVersion: { type: 'string', description: '要校验的版本 id' },
          instance: { type: 'string', description: '也可以指定实例（用其实例目录与版本）' }
        },
        required: []
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const instances = await ctx.services.launcher.listInstances()
        const instance = optionalString(args, 'instance')
          ? await resolveInstance(ctx, requireString(args, 'instance'))
          : instances[0]
        if (!instance) return { ok: false, output: '没有可用实例，无法确定游戏目录。' }
        const versionId = optionalString(args, 'gameVersion') ?? instance.versionId
        const result = await ctx.services.launcher.verifyVersion(instance.gameDir, versionId)
        return {
          ok: true,
          output: result.ok
            ? `${versionId} 安装完整，未发现缺失文件。\n${result.detail.slice(0, 20).join('\n')}`
            : `${versionId} 存在问题：\n${result.detail.join('\n')}`,
          meta: result
        }
      }
    },

    /* ---------------------------- 启动 ---------------------------- */
    {
      name: 'mc_launch',
      description:
        '启动游戏。这是有副作用的操作（会打开游戏窗口），只在用户明确要求"启动游戏"时使用。' +
        '若要调试启动问题，建议先 mc_diagnose 与 mc_verify_version。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          debug: { type: 'boolean', description: '是否以调试模式启动（保留控制台日志）' },
          offline: { type: 'boolean', description: '是否离线启动' }
        },
        required: ['instance']
      },
      category: 'minecraft',
      dangerous: true,
      permissionFor: (args) => ({ summary: `启动游戏实例：${String(args.instance ?? '')}`, risk: 'medium' }),
      handler: async (args, ctx) => {
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        const result = await ctx.services.launcher.launch({
          instanceId: target.id,
          debug: optionalBoolean(args, 'debug'),
          offline: optionalBoolean(args, 'offline')
        })
        return { ok: true, output: `已启动实例「${target.name}」（进程 PID ${result.pid}）。可在日志面板查看输出。`, meta: result }
      }
    },
    {
      name: 'mc_game_status',
      description: '查看当前正在运行的游戏实例与它们的运行时长、最近日志尾部。排查"卡在启动界面"之类问题时用。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '只看某个实例（可选）' },
          tailLines: { type: 'number', description: '附带多少行日志，默认 30' }
        },
        required: []
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const running = await ctx.services.launcher.listRunningGames()
        if (running.length === 0) return { ok: true, output: '当前没有正在运行的游戏进程。' }
        const blocks: string[] = []
        for (const info of running) {
          if (optionalString(args, 'instance') && info.instanceId !== optionalString(args, 'instance')) continue
          const uptime = Math.round((Date.now() - Date.parse(info.startedAt)) / 1000)
          let logTail = ''
          try {
            logTail = await ctx.services.launcher.readGameLog(info.instanceId, { tailLines: optionalNumber(args, 'tailLines', 30) ?? 30 })
          } catch {
            logTail = '（无法读取日志）'
          }
          blocks.push(
            `- 实例 ${info.instanceId}｜版本 ${info.versionId}｜PID ${info.pid}｜状态 ${info.state}｜已运行 ${uptime} 秒\n日志尾部：\n${logTail.split('\n').slice(-20).join('\n')}`
          )
        }
        return { ok: true, output: cut(blocks.join('\n\n')), meta: { count: running.length } }
      }
    },
    {
      name: 'mc_stop_game',
      description: '停止正在运行的游戏（先尝试正常关闭，可用 force 强制结束）。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          force: { type: 'boolean', description: '是否强制结束进程，默认 false' }
        },
        required: ['instance']
      },
      category: 'minecraft',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `停止游戏：${String(args.instance ?? '')}`,
        detail: optionalBoolean(args, 'force') ? '强制结束进程（可能丢失未保存的游戏进度）' : '请求正常关闭',
        risk: optionalBoolean(args, 'force') ? 'high' : 'low'
      }),
      handler: async (args, ctx) => {
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        await ctx.services.launcher.stopGame(target.id, optionalBoolean(args, 'force'))
        return { ok: true, output: `已请求停止实例「${target.name}」。` }
      }
    },

    /* ---------------------------- 日志与诊断 ---------------------------- */
    {
      name: 'mc_read_log',
      description:
        '读取游戏日志（默认最新的 mcal-latest.log / latest.log，自动处理 GBK 编码）。' +
        '可以搜索关键字（filter）只看相关行，或只看尾部（tailLines）。这是诊断的主力工具。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          file: { type: 'string', description: '指定日志文件名（如 2024-01-01-1.log.gz 或 crash-reports/xxx.txt）；不填则用最新日志' },
          tailLines: { type: 'number', description: '只看最后 N 行，默认 200' },
          filter: { type: 'string', description: '只保留包含该子串的行（区分大小写的普通文本匹配）' },
          contextLines: { type: 'number', description: 'filter 命中后额外保留前后 N 行，默认 2' }
        },
        required: ['instance']
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        const tailLines = optionalNumber(args, 'tailLines', 200) ?? 200
        const text = await ctx.services.launcher.readGameLog(target.id, {
          tailLines: optionalString(args, 'filter') ? 20_000 : tailLines,
          file: optionalString(args, 'file')
        })
        const filter = optionalString(args, 'filter')
        if (!filter) {
          return { ok: true, output: cut(`实例「${target.name}」日志尾部（${tailLines} 行）：\n${text}`), meta: { lines: text.split('\n').length } }
        }
        const lines = text.split('\n')
        const contextLines = optionalNumber(args, 'contextLines', 2) ?? 2
        const keep = new Set<number>()
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(filter)) continue
          for (let k = Math.max(0, i - contextLines); k <= Math.min(lines.length - 1, i + contextLines); k++) keep.add(k)
        }
        const selected = [...keep].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`)
        if (selected.length === 0) {
          return { ok: true, output: `日志里没有包含「${filter}」的行（共扫描 ${lines.length} 行）。`, meta: { matches: 0 } }
        }
        return {
          ok: true,
          output: cut(`在日志中找到 ${selected.length} 行（含上下文）包含「${filter}」：\n${selected.join('\n')}`),
          meta: { matches: selected.length }
        }
      }
    },
    {
      name: 'mc_diagnose',
      description:
        '运行崩溃诊断引擎：分析日志/崩溃报告，返回结构化的诊断结论（问题分类、证据原文、可执行步骤、关联知识库条目）。' +
        '这是解决用户报错的首选工具——比自己读日志更快更准。诊断完应结合 read_knowledge 给出完整解释。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称（读取其日志与崩溃报告）' },
          logPath: { type: 'string', description: '直接指定日志或崩溃报告文件路径' },
          text: { type: 'string', description: '直接分析给定的文本（例如用户粘贴的报错）' }
        },
        required: []
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const instanceRef = optionalString(args, 'instance')
        const instanceId = instanceRef ? (await resolveInstance(ctx, instanceRef)).id : undefined
        const report = await ctx.services.launcher.diagnose({
          instanceId,
          logPath: optionalString(args, 'logPath'),
          text: optionalString(args, 'text')
        })
        if (report.findings.length === 0) {
          return { ok: true, output: `诊断完成（扫描 ${report.scannedLines} 行），没有识别出已知问题模式。`, meta: report }
        }
        const blocks = report.findings.map((finding, index) => {
          const lines = [
            `${index + 1}. [${finding.severity}] ${finding.title}（${finding.category}，置信度 ${(finding.confidence * 100).toFixed(0)}%）`,
            `   说明：${finding.detail}`,
            finding.evidence.length > 0 ? `   证据：\n${finding.evidence.slice(0, 4).map((e) => `     > ${e.slice(0, 300)}`).join('\n')}` : '',
            `   处理步骤：\n${finding.steps.map((step, i) => `     ${i + 1}) ${step}`).join('\n')}`,
            finding.knowledgeIds?.length ? `   相关知识库：${finding.knowledgeIds.join('、')}` : ''
          ]
            .filter(Boolean)
            .join('\n')
          return lines
        })
        return {
          ok: true,
          output: cut(
            `诊断报告（${report.findings.length} 条发现，扫描 ${report.scannedLines} 行）\n\n${blocks.join('\n\n')}\n\n提示：可用 read_knowledge 读取相关知识库条目获取完整解释与更多排查手段。`
          ),
          meta: { report }
        }
      }
    },
    {
      name: 'mc_check_content',
      description:
        '检查实例的 mod / 资源包 / 光影一致性：缺失前置、版本不匹配、重复 mod、客户端-服务端装错、性能模组互斥、pack_format 不兼容等。' +
        '游戏启动失败或行为异常时，除了看日志也应该跑这个。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          side: { type: 'string', description: '检查哪一侧：client（默认）或 server' }
        },
        required: ['instance']
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        const instance = await ctx.services.launcher.getInstance(target.id)
        if (!instance) return { ok: false, output: '实例不存在' }
        const issues = await ctx.services.launcher.validateContent({
          gameDir: instance.gameDir,
          gameVersion: instance.versionId,
          loaderType: instance.loaderType,
          side: optionalString(args, 'side') === 'server' ? 'server' : 'client'
        })
        if (issues.length === 0) return { ok: true, output: '内容检查通过，未发现问题。' }
        const bySeverity = { error: [] as string[], warning: [] as string[], info: [] as string[] }
        for (const issue of issues) {
          const line = `- [${issue.code}] ${issue.message}${issue.files?.length ? `\n    文件：${issue.files.slice(0, 6).join('、')}` : ''}${issue.suggestion ? `\n    建议：${issue.suggestion}` : ''}`
          bySeverity[issue.severity].push(line)
        }
        const text = [
          bySeverity.error.length ? `## 严重问题（${bySeverity.error.length}）\n${bySeverity.error.join('\n')}` : '',
          bySeverity.warning.length ? `## 警告（${bySeverity.warning.length}）\n${bySeverity.warning.join('\n')}` : '',
          bySeverity.info.length ? `## 提示（${bySeverity.info.length}）\n${bySeverity.info.join('\n')}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
        return { ok: true, output: cut(text), meta: { issues } }
      }
    },

    /* ---------------------------- Mod / 资源 ---------------------------- */
    {
      name: 'mc_scan_content',
      description: '扫描并列出实例的内容文件（mod/资源包/光影/数据包/存档），含元数据（id、版本、支持的 MC 版本、依赖）。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          kind: { type: 'string', description: '只看某一类：mod/resourcepack/shaderpack/datapack/world' }
        },
        required: ['instance']
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        const kind = optionalString(args, 'kind') as ContentKind | undefined
        const files = await ctx.services.launcher.scanContent(target.gameDir)
        const filtered = kind ? files.filter((f) => f.kind === kind) : files
        if (filtered.length === 0) return { ok: true, output: '没有扫描到内容文件。' }
        const lines = filtered.map((file) => {
          const meta = file.meta
          const bits = [
            `[${file.kind}${file.enabled ? '' : ' 已禁用'}] ${file.fileName}`,
            meta?.id ? `id=${meta.id}` : '',
            meta?.version ? `v${meta.version}` : '',
            meta?.loaders?.length ? `加载器=${meta.loaders.join('/')}` : '',
            meta?.gameVersions?.length ? `MC=${meta.gameVersions.join('/')}` : '',
            meta?.environment && meta.environment !== 'both' ? `环境=${meta.environment}` : '',
            meta?.depends?.length ? `依赖=${meta.depends.filter((d) => d.required).map((d) => d.id).join('/')}` : '',
            file.error ? `⚠️ ${file.error}` : ''
          ]
          return `- ${bits.filter(Boolean).join('｜')}`
        })
        return {
          ok: true,
          output: cut(`共 ${filtered.length} 个内容文件：\n${lines.join('\n')}`),
          meta: { count: filtered.length }
        }
      }
    },
    {
      name: 'mc_search_projects',
      description:
        '在 Modrinth 上搜索 mod / 整合包 / 资源包 / 光影 / 数据包 / 插件。可按游戏版本与加载器过滤。' +
        '搜到之后用 mc_install_project 安装（会自动解析必需依赖）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（支持中英文，英文效果更好）' },
          projectType: { type: 'string', description: '类型：mod/modpack/resourcepack/shader/datapack/plugin' },
          gameVersion: { type: 'string', description: '游戏版本，例如 1.20.1' },
          loader: { type: 'string', description: '加载器：fabric/forge/neoforge/quilt' },
          limit: { type: 'number', description: '返回条数，默认 8' }
        },
        required: ['query']
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        if (!ctx.networkAllowed) return { ok: false, output: '当前已禁用网络工具，无法搜索。' }
        const results = await ctx.services.launcher.searchProjects({
          query: requireString(args, 'query'),
          platform: 'modrinth',
          projectType: optionalString(args, 'projectType') as ProjectType | undefined,
          gameVersion: optionalString(args, 'gameVersion'),
          loader: optionalString(args, 'loader') as LoaderType | undefined,
          limit: optionalNumber(args, 'limit', 8) ?? 8
        })
        if (results.length === 0) return { ok: true, output: `没有找到与「${String(args.query)}」匹配的项目。` }
        const lines = results.map(
          (project, index) =>
            `${index + 1}. ${project.title}（id: ${project.projectId}）\n   下载量 ${project.downloads.toLocaleString()}｜${project.categories.slice(0, 4).join('/')}\n   ${project.description.slice(0, 200)}\n   支持版本：${project.gameVersions.slice(0, 8).join(', ')}｜加载器：${project.loaders.join(', ')}`
        )
        return { ok: true, output: cut(lines.join('\n\n')), meta: { results: results.map((r) => r.projectId) } }
      }
    },
    {
      name: 'mc_install_project',
      description:
        '从 Modrinth 安装 mod / 资源包 / 光影 / 数据包到实例，并自动安装必需依赖（withDependencies=true 时）。' +
        '安装后要提醒用户重启游戏才会生效。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          projectId: { type: 'string', description: 'Modrinth 项目 id（来自 mc_search_projects）' },
          versionId: { type: 'string', description: '指定版本 id；不填则自动选择与实例版本/加载器最匹配的版本' },
          projectType: { type: 'string', description: '类型：mod/resourcepack/shader/datapack' },
          withDependencies: { type: 'boolean', description: '是否同时安装必需依赖，默认 true' }
        },
        required: ['instance', 'projectId']
      },
      category: 'minecraft',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `安装项目到实例：${String(args.projectId ?? '')}`,
        detail: `实例：${String(args.instance ?? '')}${args.withDependencies ? '（含必需依赖）' : ''}`,
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        if (!ctx.networkAllowed) return { ok: false, output: '当前已禁用网络工具，无法下载。' }
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        const instance = await ctx.services.launcher.getInstance(target.id)
        if (!instance) return { ok: false, output: '实例不存在' }
        const result = await ctx.services.launcher.installProject({
          platform: (optionalString(args, 'platform') as Platform | undefined) ?? 'modrinth',
          projectId: requireString(args, 'projectId'),
          versionId: optionalString(args, 'versionId'),
          gameDir: instance.gameDir,
          kind: (optionalString(args, 'projectType') as ProjectType | undefined) ?? 'mod',
          gameVersion: instance.versionId,
          loader: instance.loaderType,
          withDependencies: optionalBoolean(args, 'withDependencies', true)
        })
        const warnings = result.warnings?.length ? `\n\n注意：\n${result.warnings.map((w) => `- ${w}`).join('\n')}` : ''
        return {
          ok: true,
          output: `已安装 ${result.files.length} 个文件：\n${result.files.map((f) => `- ${f}`).join('\n')}${warnings}\n\n提醒用户重启游戏后生效。`,
          meta: result
        }
      }
    },
    {
      name: 'mc_toggle_content',
      description:
        '启用或禁用某个 mod / 资源包 / 光影（通过 .disabled 后缀）。排查模组冲突时这是最常用的手段：' +
        '批量禁用一半 mod 来二分定位问题。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '内容文件的完整路径' },
          enabled: { type: 'boolean', description: 'true 启用，false 禁用' }
        },
        required: ['path', 'enabled']
      },
      category: 'minecraft',
      permissionFor: (args) => ({
        summary: `${args.enabled ? '启用' : '禁用'}内容文件：${String(args.path ?? '')}`,
        risk: 'low'
      }),
      handler: async (args, ctx) => {
        const path = requireString(args, 'path')
        await ctx.services.launcher.setContentEnabled(path, optionalBoolean(args, 'enabled', true))
        return { ok: true, output: `已${optionalBoolean(args, 'enabled', true) ? '启用' : '禁用'} ${path}` }
      }
    },

    /* ---------------------------- Java ---------------------------- */
    {
      name: 'mc_list_java',
      description: '列出本机检测到的所有 Java 运行时（版本、发行版、位数、路径）。诊断 Java 相关问题时必用。',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'minecraft',
      readOnly: true,
      handler: async (_args, ctx) => {
        const list = await ctx.services.launcher.listJava()
        if (list.length === 0) {
          return { ok: true, output: '未检测到任何 Java。需要让用户安装 Java（可用启动器的"Java 环境"页面自动下载）。' }
        }
        const lines = list.map(
          (java) =>
            `- Java ${java.majorVersion}${java.is64Bit ? ' (64位)' : ''}｜${java.vendor ?? '未知发行版'}｜${java.version ?? ''}\n  ${java.path}${java.managed ? '（启动器自动安装）' : ''}`
        )
        return { ok: true, output: `检测到 ${list.length} 个 Java：\n${lines.join('\n')}`, meta: { count: list.length } }
      }
    },

    /* ---------------------------- 服务端 ---------------------------- */
    {
      name: 'mc_server_list',
      description: '列出所有服务端实例（核心类型、版本、端口、是否接受 EULA、是否运行中）。',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'minecraft',
      readOnly: true,
      handler: async (_args, ctx) => {
        const servers = await ctx.services.launcher.listServerInstances()
        if (servers.length === 0) return { ok: true, output: '当前没有服务端实例。' }
        const lines = servers.map(
          (server) =>
            `- ${server.name}（id: ${server.id}）｜${server.coreType} ${server.coreVersion}｜MC ${server.gameVersion}\n  目录 ${server.dir}｜端口 ${server.port ?? '默认'}｜EULA ${server.eulaAccepted ? '已接受' : '未接受'}｜内存 ${server.memory.maxMB}MB`
        )
        return { ok: true, output: lines.join('\n\n'), meta: { count: servers.length } }
      }
    },
    {
      name: 'mc_server_create',
      description:
        '创建并安装服务端（下载服务端核心 jar）。核心类型：vanilla/paper/purpur/fabric/quilt/forge/neoforge。' +
        '服务端必须接受 EULA 才能启动——这一步必须由用户确认，不要代替用户接受。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '服务端名称' },
          coreType: { type: 'string', description: '核心类型' },
          gameVersion: { type: 'string', description: '游戏版本' },
          build: { type: 'string', description: '构建号（Paper/Purpur 用）' },
          memoryMB: { type: 'number', description: '最大内存（MB）' },
          port: { type: 'number', description: '端口' },
          acceptEula: { type: 'boolean', description: '是否代为接受 EULA（默认 false，必须由用户明确同意后才可设为 true）' }
        },
        required: ['name', 'coreType', 'gameVersion']
      },
      category: 'minecraft',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `创建服务端：${String(args.name ?? '')}（${String(args.coreType ?? '')} ${String(args.gameVersion ?? '')}）`,
        detail: '将下载服务端核心文件到本地磁盘',
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        const memoryMB = optionalNumber(args, 'memoryMB')
        const server = await ctx.services.launcher.createServer({
          name: requireString(args, 'name'),
          coreType: requireString(args, 'coreType') as ServerCoreType,
          gameVersion: requireString(args, 'gameVersion'),
          coreVersion: optionalString(args, 'build') ?? '',
          memory: memoryMB ? { minMB: memoryMB, maxMB: memoryMB, auto: false } : undefined,
          port: optionalNumber(args, 'port')
        } as never)
        if (optionalBoolean(args, 'acceptEula')) {
          await ctx.services.launcher.acceptEula(server.id, true)
        }
        const eulaNote = optionalBoolean(args, 'acceptEula')
          ? ''
          : '\n\n⚠️ EULA 尚未接受，服务端无法启动。请让用户在界面里确认接受 Minecraft EULA 后再启动。'
        return {
          ok: true,
          output: `已创建服务端「${server.name}」（id: ${server.id}，目录 ${server.dir}，核心 ${server.coreType}）${eulaNote}`,
          meta: { serverId: server.id }
        }
      }
    },
    {
      name: 'mc_server_control',
      description: '启动/停止服务端实例。启动服务端会占用端口并持续运行，只有用户明确要求时才做。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '服务端 id 或名称' },
          action: { type: 'string', description: 'start 或 stop' },
          force: { type: 'boolean', description: '停止时是否强制' }
        },
        required: ['server', 'action']
      },
      category: 'minecraft',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `${String(args.action) === 'start' ? '启动' : '停止'}服务端：${String(args.server ?? '')}`,
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        const ref = requireString(args, 'server')
        const servers = await ctx.services.launcher.listServerInstances()
        const server = servers.find((s) => s.id === ref || s.name === ref) ?? servers.find((s) => s.name.includes(ref))
        if (!server) return { ok: false, output: `找不到服务端「${ref}」。现有：${servers.map((s) => s.name).join('、') || '（无）'}` }
        const action = requireString(args, 'action')
        if (action === 'start') {
          const result = await ctx.services.launcher.startServer(server.id)
          return { ok: true, output: `已启动服务端「${server.name}」（PID ${result.pid}）。` }
        }
        await ctx.services.launcher.stopServer(server.id, optionalBoolean(args, 'force'))
        return { ok: true, output: `已请求停止服务端「${server.name}」。` }
      }
    },
    {
      name: 'mc_server_properties',
      description:
        '读取或修改服务端的 server.properties。只传 server 是读取；传 set 则修改对应项（会自动保留文件里的注释）。' +
        '常用项：online-mode、max-players、difficulty、pvp、white-list、view-distance。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '服务端 id 或名称' },
          set: { type: 'object', description: '要修改的键值对，例如 {"max-players":"20","difficulty":"hard"}' }
        },
        required: ['server']
      },
      category: 'minecraft',
      permissionFor: (args) => {
        const set = args.set as Record<string, unknown> | undefined
        if (!set || Object.keys(set).length === 0) return null
        return {
          summary: `修改服务端配置：${Object.keys(set).join('、')}`,
          detail: Object.entries(set).map(([k, v]) => `${k} = ${String(v)}`).join('\n'),
          risk: 'medium'
        }
      },
      handler: async (args, ctx) => {
        const ref = requireString(args, 'server')
        const servers = await ctx.services.launcher.listServerInstances()
        const server = servers.find((s) => s.id === ref || s.name === ref) ?? servers.find((s) => s.name.includes(ref))
        if (!server) return { ok: false, output: `找不到服务端「${ref}」。` }
        const set = args.set as Record<string, unknown> | undefined
        if (set && Object.keys(set).length > 0) {
          const patch: Record<string, string> = {}
          for (const [key, value] of Object.entries(set)) patch[key] = String(value)
          await ctx.services.launcher.setServerProperties(server.id, patch)
          return { ok: true, output: `已修改 ${Object.keys(patch).length} 项配置：${Object.keys(patch).join('、')}。重启服务端后生效。` }
        }
        const props = await ctx.services.launcher.serverProperties(server.id)
        const important = [
          'online-mode',
          'server-port',
          'max-players',
          'difficulty',
          'gamemode',
          'pvp',
          'white-list',
          'view-distance',
          'simulation-distance',
          'motd',
          'level-name',
          'level-seed',
          'spawn-protection',
          'enable-command-block'
        ]
        const shown = important.filter((key) => props[key] !== undefined).map((key) => `${key} = ${props[key]}`)
        const others = Object.keys(props).filter((key) => !important.includes(key))
        return {
          ok: true,
          output: `server.properties（共 ${Object.keys(props).length} 项）\n\n## 常用项\n${shown.join('\n')}\n\n## 其他项\n${others.map((k) => `${k} = ${props[k]}`).join('\n')}`,
          meta: { props }
        }
      }
    },

    /* ---------------------------- 整合包 ---------------------------- */
    {
      name: 'mc_inspect_modpack',
      description: '检查整合包文件（.zip/.mrpack/或目录），识别格式（CurseForge/Modrinth/MMC/HMCL/MCAL）并列出其中的文件。导入前先看看。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '整合包文件路径' },
          dir: { type: 'string', description: '或整合包目录路径' }
        },
        required: []
      },
      category: 'minecraft',
      readOnly: true,
      handler: async (args, ctx) => {
        const manifest = await ctx.services.launcher.inspectModpack({
          file: optionalString(args, 'file'),
          dir: optionalString(args, 'dir')
        })
        return {
          ok: true,
          output: [
            `格式：${manifest.format}`,
            `名称：${manifest.name}${manifest.version ? ` v${manifest.version}` : ''}`,
            manifest.author ? `作者：${manifest.author}` : '',
            `游戏版本：${manifest.gameVersion ?? '未指定'}｜加载器：${manifest.loaderType ?? '未指定'} ${manifest.loaderVersion ?? ''}`,
            `文件数：${manifest.files.length}`,
            manifest.files.length > 0
              ? `\n示例文件：\n${manifest.files.slice(0, 20).map((f) => `- ${f.path}${f.optional ? '（可选）' : ''}`).join('\n')}`
              : ''
          ]
            .filter(Boolean)
            .join('\n'),
          meta: manifest
        }
      }
    },
    {
      name: 'mc_export_modpack',
      description:
        '把某个实例导出为整合包文件（.zip）。导出会自动排除日志、存档（除非要求包含）与敏感文件（服务器列表、凭据）。',
      parameters: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称' },
          outFile: { type: 'string', description: '输出文件路径（.zip）' },
          format: { type: 'string', description: '格式：modrinth（推荐）/mcal/curseforge' }
        },
        required: ['instance', 'outFile']
      },
      category: 'minecraft',
      handler: async (args, ctx) => {
        const target = await resolveInstance(ctx, requireString(args, 'instance'))
        const result = await ctx.services.launcher.exportModpack({
          instanceId: target.id,
          outFile: requireString(args, 'outFile'),
          format: (optionalString(args, 'format') as 'modrinth' | 'mcal' | 'curseforge' | undefined) ?? 'modrinth'
        })
        return { ok: true, output: `已导出整合包：${result.file}（${result.fileCount} 个文件）`, meta: result }
      }
    }
  ]
}
