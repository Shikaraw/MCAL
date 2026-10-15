/**
 * 开发能力测试：模板注册表、脚手架渲染、变量校验、gradle 构建辅助。
 *
 * 全部离线：
 *  - 模板来自仓库里的 resources/templates（真实文件）；
 *  - 需要「异常模板」时在临时目录里现造 fixture，测完删除；
 *  - 不执行任何 gradle 命令（只测 parseErrors / findArtifacts / resolveCommand 等纯逻辑）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TemplateRegistry, resolveDefaultTemplatesRoot, type TemplateManifest } from '@core/dev/templates'
import {
  Scaffolder,
  gitignoreFor,
  normalizeModId,
  renderPath,
  renderText,
  toPascalCase
} from '@core/dev/scaffold'
import { ProjectBuilder } from '@core/dev/builder'
import { walkFiles } from '@core/util/fsx'

const TEMPLATES_ROOT = resolveDefaultTemplatesRoot(resolve('.'))

let workDir = ''
let registry: TemplateRegistry
let scaffolder: Scaffolder

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mcal-dev-'))
  registry = new TemplateRegistry({ templatesRoot: TEMPLATES_ROOT })
  scaffolder = new Scaffolder({ registry })
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ *
 *  模板注册表
 * ------------------------------------------------------------------ */

describe('TemplateRegistry：模板扫描', () => {
  it('扫描出全部 8 个内置模板，且每个都有 variables 定义', async () => {
    const templates = await registry.list()
    const ids = templates.map((t) => t.id).sort()
    expect(ids).toEqual([
      'datapack-1.20',
      'mod-fabric-1.20',
      'mod-forge-1.20',
      'mod-neoforge-1.21',
      'modpack-mcal',
      'plugin-paper',
      'resourcepack-1.20',
      'shaderpack-iris'
    ])
    for (const template of templates) {
      expect(template.variables.length, `${template.id} 缺少 variables`).toBeGreaterThan(0)
      expect(template.description.length, `${template.id} 描述为空`).toBeGreaterThan(0)
      expect(template.dir).toBe(template.id)
    }
  })

  it('类型与加载器映射正确', async () => {
    const byId = new Map((await registry.list()).map((t) => [t.id, t]))
    expect(byId.get('mod-fabric-1.20')?.kind).toBe('mod')
    expect(byId.get('mod-fabric-1.20')?.loader).toBe('fabric')
    expect(byId.get('mod-forge-1.20')?.loader).toBe('forge')
    expect(byId.get('mod-neoforge-1.21')?.loader).toBe('neoforge')
    expect(byId.get('plugin-paper')?.kind).toBe('plugin')
    expect(byId.get('shaderpack-iris')?.kind).toBe('shaderpack')
    expect(byId.get('resourcepack-1.20')?.kind).toBe('resourcepack')
    expect(byId.get('datapack-1.20')?.kind).toBe('datapack')
    expect(byId.get('modpack-mcal')?.kind).toBe('modpack')
  })

  it('readFiles 读取真实文件且跳过 template.json', async () => {
    const files = await registry.readFiles('mod-fabric-1.20')
    const paths = files.map((f) => f.path)
    expect(paths).toContain('build.gradle')
    expect(paths).toContain('gradle.properties')
    expect(paths).toContain('src/main/resources/{{modid}}.mixins.json')
    expect(paths).toContain('src/main/java/{{packagePath}}/{{ModClassName}}.java')
    expect(paths).not.toContain('template.json')

    const buildGradle = files.find((f) => f.path === 'build.gradle')?.content ?? ''
    expect(buildGradle).toContain("id 'fabric-loom'")
    // 国内加速源注释必须存在
    expect(buildGradle).toContain('https://maven.aliyun.com/repository/public')
    expect(buildGradle).toContain('https://bmclapi2.bangbang93.com/maven')
  })

  it('get 未知 id 返回 null', async () => {
    expect(await registry.get('not-exist')).toBeNull()
  })

  it('缺少 template.json 的目录按目录名推断', async () => {
    const root = join(workDir, 'inferred-templates')
    mkdirSync(join(root, 'shaderpack-demo'), { recursive: true })
    writeFileSync(join(root, 'shaderpack-demo', 'shaders.properties'), 'screen = [A]\n', 'utf8')
    const tempRegistry = new TemplateRegistry({ templatesRoot: root })
    const list = await tempRegistry.list()
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe('shaderpack')
    expect(list[0].id).toBe('shaderpack-demo')
  })
})

/* ------------------------------------------------------------------ *
 *  变量派生与渲染
 * ------------------------------------------------------------------ */

describe('变量派生与占位符渲染', () => {
  it('normalizeModId：小写、非字母数字转下划线、去连续下划线', () => {
    expect(normalizeModId('My Cool Mod')).toBe('my_cool_mod')
    expect(normalizeModId('My  Cool--Mod!!')).toBe('my_cool_mod')
    expect(normalizeModId('  _Leading_  ')).toBe('leading')
    expect(normalizeModId('Mod1')).toBe('mod1')
  })

  it('toPascalCase：处理空格/连字符/camelCase 与数字开头', () => {
    expect(toPascalCase('my cool-mod')).toBe('MyCoolMod')
    expect(toPascalCase('myCoolMod')).toBe('MyCoolMod')
    expect(toPascalCase('123 mod')).toBe('Mod123Mod')
    expect(toPascalCase('###')).toBe('')
  })

  it('renderText 容错空格，未定义变量原样保留并记录', () => {
    const missing = new Set<string>()
    expect(renderText('{{modid}} / {{ modid }}', { modid: 'abc' }, missing)).toBe('abc / abc')
    expect(renderText('{{unknown}}', {}, missing)).toBe('{{unknown}}')
    expect([...missing]).toEqual(['unknown'])
  })

  it('renderPath 不残留 {{ }}', () => {
    expect(renderPath('src/main/java/{{packagePath}}/{{ModClassName}}.java', {
      packagePath: 'com/example/demo',
      ModClassName: 'Demo'
    })).toBe('src/main/java/com/example/demo/Demo.java')
    // 未定义变量时路径中的括号被清洗掉（内容里才保留原样）
    const path = renderPath('data/{{modid}}/functions/{{unknown}}.json', { modid: 'demo' })
    expect(path).not.toMatch(/\{\{|\}\}/)
    expect(path).toContain('data/demo/functions/')
  })
})

/* ------------------------------------------------------------------ *
 *  变量校验
 * ------------------------------------------------------------------ */

describe('Scaffolder.resolveVariables：默认值与校验', () => {
  it('派生 modid / ModClassName / packagePath / year', async () => {
    const manifest = (await registry.get('mod-fabric-1.20'))!
    const { values, errors, derived } = scaffolder.resolveVariables(manifest, {
      name: 'My Cool Mod',
      package: 'com.example.mycoolmod'
    })
    expect(errors).toEqual([])
    expect(values.modid).toBe('my_cool_mod')
    expect(values.ModClassName).toBe('MyCoolMod')
    expect(values.packagePath).toBe('com/example/mycoolmod')
    expect(values.modVersion).toBe('1.0.0')
    expect(values.license).toBe('MIT')
    expect(values.year).toBe(String(new Date().getFullYear()))
    expect(derived.modid).toBe('my_cool_mod')
  })

  it('模板变量的默认值可以引用派生变量', async () => {
    const manifest = (await registry.get('mod-forge-1.20'))!
    // template.json 里 package 默认值是 com.example.{{modid}}
    const { values, errors } = scaffolder.resolveVariables(manifest, { name: 'Auto Package' })
    expect(errors).toEqual([])
    expect(values.package).toBe('com.example.auto_package')
    expect(values.packagePath).toBe('com/example/auto_package')
  })

  it('缺少必填变量 / 非法包名会被收集为 errors', async () => {
    // 必填但没有默认值的变量：必须报错
    const bare: TemplateManifest = {
      id: 'bare',
      name: '裸模板',
      kind: 'mod',
      description: '测试必填校验',
      dir: 'bare',
      variables: [{ key: 'name', label: '名称', required: true }]
    }
    expect(scaffolder.resolveVariables(bare, {}).errors.some((e) => e.includes('name'))).toBe(true)

    const manifest = (await registry.get('mod-fabric-1.20'))!
    // 名称为中文 -> 无法派生合法 modid，应给出可读错误
    expect(
      scaffolder.resolveVariables(manifest, { name: '我的模组' }).errors.some((e) => e.includes('modid'))
    ).toBe(true)

    const badPackage = scaffolder.resolveVariables(manifest, { name: 'Demo', package: 'Com.Example!' })
    expect(badPackage.errors.some((e) => e.includes('包名不合法'))).toBe(true)
    // 正确的包名不应报错
    expect(scaffolder.resolveVariables(manifest, { name: 'Demo', package: 'com.example.demo' }).errors).toEqual([])
  })

  it('scaffold 在变量校验失败时抛错且不落盘', async () => {
    const target = join(workDir, 'invalid-target')
    await expect(
      scaffolder.scaffold({ templateId: 'mod-fabric-1.20', targetDir: target, variables: {} })
    ).rejects.toThrow(/变量校验失败/)
    expect(existsSync(target)).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 *  脚手架落盘
 * ------------------------------------------------------------------ */

describe('Scaffolder：渲染与落盘', () => {
  it('生成 Fabric 工程：路径占位符替换、无残留 {{ }}、nextSteps 完整', async () => {
    const target = join(workDir, 'fabric-demo')
    const result = await scaffolder.scaffold({
      templateId: 'mod-fabric-1.20',
      targetDir: target,
      variables: { name: 'Sky Tools', package: 'com.example.skytools', author: 'Tester' }
    })

    expect(result.root).toBe(resolve(target))
    expect(result.warnings).toEqual([])
    expect(result.files).toContain('build.gradle')
    expect(result.files).toContain('gradle.properties')
    expect(result.files).toContain('src/main/java/com/example/skytools/SkyTools.java')
    expect(result.files).toContain('src/client/java/com/example/skytools/SkyToolsClient.java')
    expect(result.files).toContain('src/main/resources/sky_tools.mixins.json')
    expect(result.files).toContain('src/main/java/com/example/skytools/mixin/ExampleMixin.java')

    // 所有生成文件里都不应该残留占位符
    for (const rel of result.files) {
      const content = readFileSync(join(target, rel), 'utf8')
      expect(content, `${rel} 残留占位符`).not.toMatch(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/)
    }

    const fabricModJson = JSON.parse(
      readFileSync(join(target, 'src/main/resources/fabric.mod.json'), 'utf8')
    ) as {
      id: string
      name: string
      entrypoints: { main: string[]; client: string[] }
      depends: Record<string, string>
    }
    expect(fabricModJson.id).toBe('sky_tools')
    expect(fabricModJson.name).toBe('Sky Tools')
    expect(fabricModJson.entrypoints.main).toEqual(['com.example.skytools.SkyTools'])
    expect(fabricModJson.entrypoints.client).toEqual(['com.example.skytools.SkyToolsClient'])
    expect(fabricModJson.depends.minecraft).toBe('~1.20.1')
    expect(fabricModJson.depends.java).toBe('>=17')

    const gradleProperties = readFileSync(join(target, 'gradle.properties'), 'utf8')
    expect(gradleProperties).toContain('archives_base_name=sky_tools')
    expect(gradleProperties).toContain('maven_group=com.example.skytools')

    // 后续指引：构建命令、产物位置、JDK、安装目录
    const steps = result.nextSteps.join('\n')
    expect(steps).toContain('gradlew')
    expect(steps).toContain('gradle wrapper')
    expect(steps).toContain('build/libs/sky_tools-1.0.0.jar')
    expect(steps).toContain('JDK 17')
    expect(steps).toContain('mods')
  })

  it('非 Java 模板（资源包/数据包/光影包）也能正确渲染与给出指引', async () => {
    const packDir = join(workDir, 'pack-demo')
    const packResult = await scaffolder.scaffold({
      templateId: 'resourcepack-1.20',
      targetDir: packDir,
      variables: { name: 'Pixel Pack' }
    })
    expect(packResult.files).toContain('assets/minecraft/models/item/pixel_pack_item.json')
    const mcmeta = JSON.parse(readFileSync(join(packDir, 'pack.mcmeta'), 'utf8')) as {
      pack: { pack_format: number; supported_formats: { min_inclusive: number; max_inclusive: number } }
    }
    expect(mcmeta.pack.pack_format).toBe(15)
    expect(mcmeta.pack.supported_formats.min_inclusive).toBe(15)
    expect(packResult.nextSteps.join('\n')).toContain('resourcepacks')

    const dpDir = join(workDir, 'datapack-demo')
    const dpResult = await scaffolder.scaffold({
      templateId: 'datapack-1.20',
      targetDir: dpDir,
      variables: { name: 'Quest Pack' }
    })
    expect(dpResult.files).toContain('data/quest_pack/functions/hello.mcfunction')
    expect(dpResult.files).toContain('data/minecraft/tags/functions/load.json')
    expect(dpResult.nextSteps.join('\n')).toContain('datapacks')

    const shaderDir = join(workDir, 'shader-demo')
    const shaderResult = await scaffolder.scaffold({
      templateId: 'shaderpack-iris',
      targetDir: shaderDir,
      variables: { name: 'Soft Light' }
    })
    expect(shaderResult.files).toContain('shaders/shaders.properties')
    expect(shaderResult.files).toContain('shaders/lib/common.glsl')
    expect(shaderResult.nextSteps.join('\n')).toContain('shaderpacks')
    const properties = readFileSync(join(shaderDir, 'shaders/shaders.properties'), 'utf8')
    expect(properties).toContain('screen =')
    expect(properties).toContain('sliders =')
  })

  it('plugin 模板生成的 plugin.yml 关键字段完整', async () => {
    const target = join(workDir, 'paper-demo')
    const result = await scaffolder.scaffold({
      templateId: 'plugin-paper',
      targetDir: target,
      variables: { name: 'Kit PvP', package: 'com.example.kitpvp' }
    })
    // Kit PvP -> 类名 KitPvP（camelCase 边界会被拆成独立词）
    expect(result.files).toContain('src/main/java/com/example/kitpvp/KitPvP.java')
    expect(result.files).toContain('src/main/java/com/example/kitpvp/commands/ExampleCommand.java')
    const pluginYml = readFileSync(join(target, 'src/main/resources/plugin.yml'), 'utf8')
    expect(pluginYml).toContain('main: com.example.kitpvp.KitPvP')
    expect(pluginYml).toContain("api-version: '1.21'")
    expect(pluginYml).toContain('kit_pvp.command.example')
    expect(pluginYml).toContain('permissions:')
    expect(result.nextSteps.join('\n')).toContain('JDK 21')
  })

  it('NeoForge 模板使用 neoforge.mods.toml 与 type = "required"', async () => {
    const target = join(workDir, 'neo-demo')
    const result = await scaffolder.scaffold({
      templateId: 'mod-neoforge-1.21',
      targetDir: target,
      variables: { name: 'Neo Demo' }
    })
    expect(result.files).toContain('src/main/resources/META-INF/neoforge.mods.toml')
    const toml = readFileSync(join(target, 'src/main/resources/META-INF/neoforge.mods.toml'), 'utf8')
    expect(toml).toContain('[[dependencies.neo_demo]]')
    expect(toml).toContain('type = "required"')
    expect(toml).toContain('versionRange = "[21.0.0,)"')
  })

  it('模组包模板使用 ModpackManifest 结构', async () => {
    const target = join(workDir, 'modpack-demo')
    const result = await scaffolder.scaffold({
      templateId: 'modpack-mcal',
      targetDir: target,
      variables: { name: 'Adventure Pack', gameVersion: '1.20.1', loaderType: 'fabric', loaderVersion: '0.15.11' }
    })
    const manifest = JSON.parse(readFileSync(join(target, 'mcal-pack.json'), 'utf8')) as {
      format: string
      name: string
      gameVersion: string
      loaderType: string
      files: { path: string; targetDir?: string }[]
    }
    expect(manifest.format).toBe('mcal')
    expect(manifest.name).toBe('Adventure Pack')
    expect(manifest.gameVersion).toBe('1.20.1')
    expect(manifest.loaderType).toBe('fabric')
    expect(manifest.files.length).toBeGreaterThan(0)
    expect(result.files).toContain('overrides/config/README.md')
    // 空目录由 template.json 的 directories 声明创建（不再依赖 .gitkeep）
    expect(existsSync(join(target, 'overrides/mods'))).toBe(true)
    expect(statSync(join(target, 'overrides/mods')).isDirectory()).toBe(true)
  })

  it('未定义变量：警告 + 内容原样保留', async () => {
    const root = join(workDir, 'templates-with-hole')
    mkdirSync(join(root, 'hole-tpl', 'src'), { recursive: true })
    writeFileSync(
      join(root, 'hole-tpl', 'template.json'),
      JSON.stringify({
        id: 'hole-tpl',
        name: '带缺失变量的模板',
        kind: 'mod',
        description: '测试未定义变量',
        variables: [{ key: 'name', label: '名称', required: true }]
      }),
      'utf8'
    )
    writeFileSync(
      join(root, 'hole-tpl', 'src', '{{modid}}.txt'),
      'modid={{modid}} unknown={{missingVar}}\n',
      'utf8'
    )
    const tempRegistry = new TemplateRegistry({ templatesRoot: root })
    const tempScaffolder = new Scaffolder({ registry: tempRegistry })
    const target = join(workDir, 'hole-target')
    const result = await tempScaffolder.scaffold({
      templateId: 'hole-tpl',
      targetDir: target,
      variables: { name: 'Hole Demo' }
    })
    expect(result.files).toContain('src/hole_demo.txt')
    expect(result.warnings.join('\n')).toContain('missingVar')
    expect(readFileSync(join(target, 'src/hole_demo.txt'), 'utf8')).toContain('unknown={{missingVar}}')
  })

  it('目标目录非空：force=false 抛错，force=true 只覆盖同名文件并记录 warning', async () => {
    const target = join(workDir, 'force-demo')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'README.md'), '用户自己写的说明\n', 'utf8')
    writeFileSync(join(target, 'user-file.txt'), '不要动我\n', 'utf8')

    await expect(
      scaffolder.scaffold({ templateId: 'datapack-1.20', targetDir: target, variables: { name: 'Force Demo' } })
    ).rejects.toThrow(/目标目录不为空/)

    const forced = await scaffolder.scaffold({
      templateId: 'datapack-1.20',
      targetDir: target,
      variables: { name: 'Force Demo' },
      force: true
    })
    expect(forced.warnings.some((w) => w.includes('已覆盖同名文件：README.md'))).toBe(true)
    // 用户自己的文件保持原样
    expect(readFileSync(join(target, 'user-file.txt'), 'utf8')).toBe('不要动我\n')
    // 模板文件已写入
    expect(existsSync(join(target, 'data/force_demo/functions/hello.mcfunction'))).toBe(true)
  })

  it('initGit：只写 .gitignore 并通过 nextSteps 提示 git init', async () => {
    const target = join(workDir, 'git-demo')
    const result = await scaffolder.scaffold({
      templateId: 'mod-fabric-1.20',
      targetDir: target,
      variables: { name: 'Git Demo' },
      initGit: true
    })
    expect(result.files).toContain('.gitignore')
    const gitignore = readFileSync(join(target, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.gradle/')
    expect(gitignore).toContain('build/')
    expect(result.nextSteps.join('\n')).toContain('git init')
    // 不调用外部 git：不应出现 .git 目录
    expect(existsSync(join(target, '.git'))).toBe(false)
  })

  it('preview 只渲染不落盘', async () => {
    const target = join(workDir, 'preview-demo')
    const preview = await scaffolder.preview({
      templateId: 'mod-forge-1.20',
      targetDir: target,
      variables: { name: 'Preview Demo' }
    })
    expect(preview.files.length).toBeGreaterThan(5)
    const modsToml = preview.files.find((f) => f.path === 'src/main/resources/META-INF/mods.toml')
    expect(modsToml?.content).toContain('modId = "preview_demo"')
    expect(modsToml?.content).toContain('mandatory = true')
    expect(existsSync(target)).toBe(false)
  })

  it('gitignoreFor 按类型给出合理的忽略项', () => {
    expect(gitignoreFor('mod')).toContain('run/')
    expect(gitignoreFor('shaderpack')).toContain('*.zip')
    expect(gitignoreFor('modpack')).toContain('servers.dat')
  })

  it('全部 8 个内置模板都能生成合法 JSON（并给出 nextSteps）', async () => {
    const templates = await registry.list()
    expect(templates).toHaveLength(8)
    for (const template of templates) {
      const target = join(workDir, `all-${template.id}`)
      const result = await scaffolder.scaffold({
        templateId: template.id,
        targetDir: target,
        variables: { name: `Demo ${template.kind}`, author: 'MCAL' }
      })
      expect(result.files.length, `${template.id} 没有生成文件`).toBeGreaterThan(0)
      expect(result.warnings, `${template.id} 出现未定义变量警告`).toEqual([])
      expect(result.nextSteps.length, `${template.id} 缺少后续指引`).toBeGreaterThan(0)
      for (const rel of result.files) {
        if (!rel.endsWith('.json')) continue
        const text = readFileSync(join(target, rel), 'utf8')
        expect(() => JSON.parse(text), `${template.id} 的 ${rel} 不是合法 JSON`).not.toThrow()
      }
      // README 是中文说明（模板规范要求）
      expect(result.files).toContain('README.md')
    }
  })

  it('模板声明的空目录会被创建（不依赖 .gitkeep）', async () => {
    const target = join(workDir, 'dirs-demo')
    const result = await scaffolder.scaffold({
      templateId: 'mod-fabric-1.20',
      targetDir: target,
      variables: { name: 'Dir Demo' }
    })

    // 变量替换要生效：{{modid}} 应变成 dir_demo
    const blockDir = join(target, 'src/main/resources/assets/dir_demo/textures/block')
    const itemDir = join(target, 'src/main/resources/assets/dir_demo/textures/item')
    expect(existsSync(blockDir), 'textures/block 未创建').toBe(true)
    expect(existsSync(itemDir), 'textures/item 未创建').toBe(true)
    expect(statSync(blockDir).isDirectory()).toBe(true)

    // 目录属于声明而非文件列表，不要混进 files
    expect(result.files.some((rel) => rel.includes('.gitkeep'))).toBe(false)
  })

  it('模板本身不携带任何点文件占位（打包工具会剥掉它们）', async () => {
    const manifests = await registry.list()
    for (const manifest of manifests) {
      const dir = join(TEMPLATES_ROOT, manifest.dir)
      const entries = await walkFiles(dir)
      const dotFiles = entries.filter((rel) => rel.split('/').some((seg) => seg.startsWith('.')))
      expect(dotFiles, `${manifest.id} 含点文件：${dotFiles.join('、')}`).toEqual([])
    }
  })
})

/* ------------------------------------------------------------------ *
 *  ProjectBuilder
 * ------------------------------------------------------------------ */

describe('ProjectBuilder：gradle 输出解析与产物识别', () => {
  const sample = [
    '> Task :compileJava',
    'D:\\proj\\src\\main\\java\\com\\example\\Demo.java:42: error: cannot find symbol',
    '        Registry.register(WRONG, item);',
    '                                   ^',
    '  symbol:   variable WRONG',
    '  location: class com.example.Demo',
    '> Task :compileJava FAILED',
    'FAILURE: Build failed with an exception.',
    '* What went wrong:',
    'Execution failed for task \':compileJava\'.',
    'error: cannot find symbol'
  ].join('\n')

  it('parseErrors 提取 javac 错误与 gradle 失败行', () => {
    const builder = new ProjectBuilder()
    const errors = builder.parseErrors(sample)
    const joined = errors.join('\n')
    expect(joined).toContain('Demo.java:42 编译错误：cannot find symbol')
    expect(joined).toContain('symbol:   variable WRONG')
    expect(joined).toContain('> Task :compileJava FAILED')
    expect(joined).toContain('FAILURE: Build failed with an exception.')
    expect(joined).toContain("Execution failed for task ':compileJava'.")
    // 去重：'error: cannot find symbol' 出现两次只保留一条
    expect(errors.filter((e) => e === 'error: cannot find symbol')).toHaveLength(1)
  })

  it('parseErrors 识别依赖解析失败与 JDK 版本问题', () => {
    const builder = new ProjectBuilder()
    const errors = builder.parseErrors(
      ['Could not resolve all files for configuration \':compileClasspath\'.', 'Could not find net.fabricmc:fabric-loader:9.9.9.', 'Unsupported class file major version 65'].join('\n')
    )
    const joined = errors.join('\n')
    expect(joined).toContain('Could not resolve')
    expect(joined).toContain('Could not find net.fabricmc:fabric-loader:9.9.9.')
    expect(joined).toContain('Unsupported class file major version 65')
  })

  it('findArtifacts 只返回主 jar（排除 sources/dev/slim/javadoc）', async () => {
    const dir = join(workDir, 'artifact-demo')
    mkdirSync(join(dir, 'build', 'libs'), { recursive: true })
    for (const name of ['demo-1.0.0.jar', 'demo-1.0.0-sources.jar', 'demo-1.0.0-dev.jar', 'demo-1.0.0-slim.jar', 'notes.txt']) {
      writeFileSync(join(dir, 'build', 'libs', name), 'x', 'utf8')
    }
    const builder = new ProjectBuilder()
    const artifacts = await builder.findArtifacts(dir)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].endsWith(join('build', 'libs', 'demo-1.0.0.jar'))).toBe(true)
  })

  it('findArtifacts 对不存在的目录返回空数组', async () => {
    const builder = new ProjectBuilder()
    expect(await builder.findArtifacts(join(workDir, 'nothing-here'))).toEqual([])
  })

  it('resolveCommand 优先 wrapper，缺失时回退系统 gradle', () => {
    const builder = new ProjectBuilder()
    const empty = join(workDir, 'no-wrapper')
    mkdirSync(empty, { recursive: true })
    expect(builder.resolveCommand(empty).display).toBe('gradle')

    const withWrapper = join(workDir, 'with-wrapper')
    mkdirSync(withWrapper, { recursive: true })
    writeFileSync(join(withWrapper, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), '@echo off\n', 'utf8')
    const command = builder.resolveCommand(withWrapper)
    if (process.platform === 'win32') {
      expect(command.display.endsWith('gradlew.bat')).toBe(true)
      expect(command.useShell).toBe(true)
    } else {
      expect(command.display).toBe('./gradlew')
      expect(command.useShell).toBe(false)
    }
  })
})
