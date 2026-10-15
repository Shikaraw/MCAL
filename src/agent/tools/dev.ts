/**
 * 开发与美术资源工具：让 Agent 能帮用户起项目、构建、生成贴图。
 */

import { join, resolve } from 'node:path'
import type { ImagePreset, ToolInvocationContext } from '@shared/types'
import { optionalBoolean, optionalNumber, optionalString, requireString, type ToolDefinitionWithHandler } from './registry'

function cut(text: string, max = 10_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字）` : text
}

export function createDevTools(): ToolDefinitionWithHandler[] {
  return [
    {
      name: 'dev_list_templates',
      description:
        '列出可用的项目模板（Fabric/Forge/NeoForge 模组、Paper 插件、Iris 光影、资源包、数据包、整合包）。' +
        '用户说"帮我做一个 mod/插件/光影"时，先用这个看有哪些模板。',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'dev',
      readOnly: true,
      handler: async (_args, ctx) => {
        const templates = await ctx.services.dev.listTemplates()
        if (templates.length === 0) return { ok: true, output: '没有可用模板。' }
        const lines = templates.map(
          (template) =>
            `- ${template.id}（${template.name}｜类型 ${template.kind}${template.loader ? `｜加载器 ${template.loader}` : ''}）\n  ${template.description}\n  变量：${template.variables.map((v) => `${v.key}${v.required ? '(必填)' : ''}${v.default !== undefined ? `=${v.default}` : ''}`).join(', ')}`
        )
        return { ok: true, output: `可用模板（${templates.length} 个）：\n\n${lines.join('\n\n')}`, meta: { templates: templates.map((t) => t.id) } }
      }
    },
    {
      name: 'dev_scaffold_project',
      description:
        '用模板生成一个完整的项目（真实文件会写入磁盘）。生成后要告知用户：产物在哪里、需要什么 JDK、如何构建、如何安装到游戏。' +
        '变量至少要提供 name；package 建议用 com.<作者>.<modid> 形式。',
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id（来自 dev_list_templates）' },
          targetDir: { type: 'string', description: '目标目录（绝对路径）' },
          variables: { type: 'object', description: '模板变量，例如 {"name":"My Mod","package":"com.example.mymod","author":"Someone"}' },
          force: { type: 'boolean', description: '目标目录非空时是否仍然写入，默认 false' }
        },
        required: ['templateId', 'targetDir']
      },
      category: 'dev',
      permissionFor: (args) => ({
        summary: `生成项目：${String(args.templateId ?? '')} → ${String(args.targetDir ?? '')}`,
        detail: '会写入多个文件到目标目录',
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        const templateId = requireString(args, 'templateId')
        const targetDir = resolve(requireString(args, 'targetDir'))
        const variables = (args.variables ?? {}) as Record<string, string>
        const result = await ctx.services.dev.scaffold(templateId, targetDir, variables)
        const tree = result.files.slice(0, 60).map((f) => `- ${f}`).join('\n')
        return {
          ok: true,
          output: `已生成项目到 ${result.root}（${result.files.length} 个文件）：\n${tree}${result.files.length > 60 ? `\n…（还有 ${result.files.length - 60} 个文件）` : ''}`,
          files: result.files.map((f) => join(result.root, f)),
          meta: result
        }
      }
    },
    {
      name: 'dev_build_project',
      description:
        '在项目目录执行 Gradle 构建（优先用项目里的 gradlew，其次用系统 gradle）。构建 mod/插件后产物通常位于 build/libs/*.jar。' +
        '构建可能耗时数分钟并需要联网下载依赖，请先告知用户。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '项目目录' },
          task: { type: 'string', description: 'Gradle 任务，默认 build' }
        },
        required: ['dir']
      },
      category: 'dev',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `构建项目：${String(args.dir ?? '')}`,
        detail: '将执行 Gradle 任务，可能联网下载依赖并运行较长时间',
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        const dir = resolve(requireString(args, 'dir'))
        const result = await ctx.services.dev.buildProject(dir, optionalString(args, 'task'))
        const summary = result.ok
          ? `构建成功（耗时 ${(result.output.length > 0 ? '' : '')}退出码 ${result.code}）`
          : `构建失败（退出码 ${result.code}）`
        return {
          ok: result.ok,
          output: cut(`${summary}\n\n输出尾部：\n${result.output.split('\n').slice(-80).join('\n')}`),
          meta: { exitCode: result.code }
        }
      }
    },
    {
      name: 'dev_write_source',
      description:
        '写项目源码的便捷封装：等价于 write_file，但会自动把相对路径解析到项目根目录，并拒绝覆盖 build/ 与 .gradle/ 目录。' +
        '适合在生成模板后批量创建额外的类文件。',
      parameters: {
        type: 'object',
        properties: {
          projectDir: { type: 'string', description: '项目根目录' },
          relativePath: { type: 'string', description: '相对项目根的路径，例如 src/main/java/com/example/MyItem.java' },
          content: { type: 'string', description: '文件内容' }
        },
        required: ['projectDir', 'relativePath', 'content']
      },
      category: 'dev',
      permissionFor: (args) => ({
        summary: `写入源码：${String(args.relativePath ?? '')}`,
        risk: 'low'
      }),
      handler: async (args, ctx) => {
        const projectDir = resolve(requireString(args, 'projectDir'))
        const relativePath = requireString(args, 'relativePath').replace(/\\/g, '/')
        if (relativePath.startsWith('/') || relativePath.includes('..')) {
          return { ok: false, output: '相对路径不合法（不允许绝对路径或 ..）' }
        }
        if (/^(build|\.gradle|\.git|out)\//.test(relativePath)) {
          return { ok: false, output: `不允许写入构建产物目录：${relativePath}` }
        }
        const target = join(projectDir, relativePath)
        const { writeFileAtomic, ensureDir } = await import('@core/util/fsx')
        const { dirname } = await import('node:path')
        await ensureDir(dirname(target))
        await writeFileAtomic(target, String(args.content ?? ''))
        return { ok: true, output: `已写入 ${target}`, files: [target] }
      }
    }
  ]
}

export function createMediaTools(): ToolDefinitionWithHandler[] {
  return [
    {
      name: 'media_list_providers',
      description: '列出已配置的生图模型（用于生成贴图、图标、材质、概念图）。若都未配置，需引导用户在设置里填写 API Key。',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'media',
      readOnly: true,
      handler: async (_args, ctx) => {
        const providers = await ctx.services.media.listProviders()
        if (providers.length === 0) return { ok: true, output: '没有配置任何生图服务。请引导用户在「设置 → 生图模型」中配置（支持 OpenAI 兼容接口/智谱/硅基流动/本地 SD WebUI）。' }
        const lines = providers.map((p) => `- ${p.id}（${p.name}）${p.configured ? '✅ 已配置' : '❌ 未配置 API Key'}｜模型：${p.models.join(', ')}`)
        return { ok: true, output: lines.join('\n'), meta: { providers } }
      }
    },
    {
      name: 'media_generate_texture',
      description:
        '用生图模型生成 Minecraft 美术资源（物品贴图、方块贴图、GUI、图标、概念图），并自动做 MC 化后处理（去背、像素化到 16/32/64、调色板量化、生成 mipmap）。' +
        '生成的图会保存到磁盘并返回路径。提示词请用英文描述画面内容，风格由 preset 自动注入。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述（英文效果最好），例如 "a glowing blue crystal sword with runes"' },
          negativePrompt: { type: 'string', description: '不想出现的内容' },
          preset: { type: 'string', description: '风格：mc-item（物品）/mc-block（方块）/mc-gui（界面）/concept-art（概念图）/logo（图标）/raw（不做 MC 化）' },
          pixelSize: { type: 'number', description: '输出像素尺寸（16/32/64/128），预设会自动决定' },
          count: { type: 'number', description: '生成几张，默认 1，最多 4' },
          outputDir: { type: 'string', description: '输出目录，默认写到启动器数据目录的 generated/ 下' },
          width: { type: 'number', description: '生成尺寸宽（模型侧），默认 1024' },
          height: { type: 'number', description: '生成尺寸高（模型侧），默认 1024' },
          seed: { type: 'number', description: '随机种子（可复现）' }
        },
        required: ['prompt']
      },
      category: 'media',
      dangerous: true,
      permissionFor: (args) => ({
        summary: `生成美术资源：${String(args.prompt ?? '').slice(0, 60)}`,
        detail: `会调用生图模型（可能产生费用）｜输出到 ${String(args.outputDir ?? '默认目录')}`,
        risk: 'medium'
      }),
      handler: async (args, ctx) => {
        if (!ctx.networkAllowed) return { ok: false, output: '当前已禁用网络工具，无法调用生图模型。' }
        const result = await ctx.services.media.generateImage({
          prompt: requireString(args, 'prompt'),
          negativePrompt: optionalString(args, 'negativePrompt'),
          preset: (optionalString(args, 'preset') as ImagePreset | undefined) ?? 'mc-item',
          pixelSize: optionalNumber(args, 'pixelSize'),
          count: Math.min(4, Math.max(1, optionalNumber(args, 'count', 1) ?? 1)),
          outputDir: optionalString(args, 'outputDir'),
          width: optionalNumber(args, 'width', 1024),
          height: optionalNumber(args, 'height', 1024),
          seed: optionalNumber(args, 'seed')
        })
        return {
          ok: true,
          output: `已生成 ${result.files.length} 个文件（服务商：${result.provider}）：\n${result.files.map((f) => `- ${f}`).join('\n')}`,
          files: result.files,
          meta: result
        }
      }
    }
  ]
}

/** 供上层构造工具集时使用 */
export function devToolsFor(_ctx: ToolInvocationContext): ToolDefinitionWithHandler[] {
  return createDevTools()
}
