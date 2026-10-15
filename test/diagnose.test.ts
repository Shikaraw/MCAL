/**
 * 诊断引擎测试：只覆盖纯函数与本地计算（无网络）。
 * 所有报错文本都是真实日志/崩溃报告里的片段（fixture 内联在测试文件里）。
 */

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { KnowledgeBase } from '@knowledge/index'
import { DIAGNOSE_RULES, DiagnosticEngine } from '@core/diagnose/engine'
import {
  extractFacts,
  extractMissingDependencyIds,
  detectGraphicsDriver,
  javaVersionForClassFileMajor,
  listRuleCatalog,
  parseCrashReportFields,
  parseHsErrFields,
  recommendedMaxHeapMB
} from '@core/diagnose/rules'
import { detectStartupState, parseLogChunk } from '@core/launch/logparse'

const KNOWLEDGE_ROOT = resolve('resources/knowledge')

/* ------------------------------------------------------------------ *
 *  fixtures（真实报错文本片段）
 * ------------------------------------------------------------------ */

const OOM_LOG = [
  '[12:00:00] [main/INFO] (Minecraft/1.20.1) Loading Minecraft 1.20.1 with Fabric Loader 0.15.11',
  '[12:00:03] [Render thread/ERROR]: java.lang.OutOfMemoryError: Java heap space',
  '[12:00:03] [Render thread/ERROR]: \tat net.minecraft.client.renderer.LevelRenderer.renderLevel(LevelRenderer.java:1234)',
  '[12:00:03] [main/INFO]: JVM Flags: 3 total; -Xmx2048M -Xms2048M -XX:+UseG1GC'
].join('\n')

const UNSUPPORTED_CLASS_VERSION =
  '[12:00:00] [main/ERROR]: java.lang.UnsupportedClassVersionError: com/example/examplemod/ExampleMod has been ' +
  'compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java ' +
  'Runtime only recognizes class file versions up to 52.0'

const HS_ERR = [
  '#',
  '# A fatal error has been detected by the Java Runtime Environment:',
  '#',
  '#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ff8a1b2c3d4, pid=12345, tid=6789',
  '#',
  '# JRE version: OpenJDK Runtime Environment Temurin-17.0.9+9 (17.0.9+9) (build 17.0.9+9)',
  '# Java VM: OpenJDK 64-Bit Server VM Temurin-17.0.9+9 (17.0.9+9, mixed mode, sharing)',
  '# Problematic frame:',
  '# C  [nvoglv64.dll+0x2f1a3c]',
  '#',
  '# Core dump will be written. Default location: C:\\Users\\steve\\.minecraft\\hs_err_pid12345.mdmp',
  '#'
].join('\n')

const CRASH_REPORT = [
  '---- Minecraft Crash Report ----',
  '// I\'m sorry, Dave.',
  '',
  'Time: 2024-05-01 12:00:00',
  'Description: Initializing game',
  '',
  'java.lang.NullPointerException: Initializing game',
  '\tat net.minecraft.client.Minecraft.<init>(Minecraft.java:1234)',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
  '---------------------------------------------------------------------------------------',
  '',
  '-- Head --',
  'Thread: Render thread',
  'Stacktrace:',
  '\tat com.example.mod.MixinFoo.handler(MixinFoo.java:42)',
  '\tat net.minecraft.client.Minecraft.<init>(Minecraft.java:1234)',
  '',
  '-- System Details --',
  'Details:',
  '\tMinecraft Version: 1.20.1',
  '\tMinecraft Version ID: 1.20.1',
  '\tOperating System: Windows 11 (amd64) version 10.0',
  '\tJava Version: 17.0.8, Eclipse Adoptium',
  '\tJava VM Version: OpenJDK 64-Bit Server VM (mixed mode), Eclipse Adoptium',
  '\tMemory: 1234567890 bytes (1177 MB) / 4294967296 bytes (4096 MB) up to 4294967296 bytes (4096 MB)',
  '\tPhysical Memory: Total: 16384 MB',
  '\tCPUs: 16',
  '\tSuspected Mods: Example Mod (examplemod), Sodium (sodium)',
  '\tLaunched Version: 1.20.1-forge-47.2.0',
  '\tBackend library: LWJGL version 3.3.1 build 7',
  '\tMod List:',
  '\t\texamplemod-1.0.0.jar |Example Mod |examplemod |1.0.0 |NONE |COMMON_SET|Manifest: NOSIGNATURE',
  '',
  '-- Affected level --',
  '\tLevel name: MpServer',
  ''
].join('\n')

const FORGE_MISSING_DEPS = [
  '[12:00:00] [main/ERROR] [net.minecraftforge.fml.ModLoadingException/]: Mod loading has failed',
  'net.minecraftforge.fml.ModLoadingException: Missing or unsupported mandatory dependencies:',
  "\tMod ID: 'patchouli', Requested by: 'enchantedbook', Expected range: '[1.20.1-1.0,)', Actual version: '[MISSING]'",
  "\tMod ID: 'curios', Requested by: 'enchantedbook', Expected range: '[1.20.1-5.4.0,)', Actual version: '[MISSING]'"
].join('\n')

const FABRIC_MISSING_DEPS = [
  'net.fabricmc.loader.impl.FormattedException: Mod resolution encountered an error. Please try the following:',
  "\t- Mod 'Fabric API' (fabric-api) 0.90.0 requires any version of mod 'cloth-config' (cloth-config), which is missing!",
  '\t- Reason: cloth-config was not found in the mods folder'
].join('\n')

const MIXIN_FAILED = [
  '[12:00:00] [main/ERROR] [mixin/]: Mixin apply failed sodium-extra.mixins.json:MyMixin -> net.minecraft.class_310:',
  "\torg.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure:",
  '\tat org.spongepowered.asm.mixin.injection.code.Injector.findTargetNodes(Injector.java:197)'
].join('\n')

const NO_SUCH_METHOD = [
  '[12:00:00] [main/ERROR]: java.lang.NoSuchMethodError: \'void net.minecraft.class_310.method_1551()\'',
  '\tat com.example.examplemod.Client.onInitialize(Client.java:42)'
].join('\n')

const SERVER_TICKING = [
  '[12:00:00] [Server thread/ERROR]: Encountered an unexpected exception',
  'java.lang.NullPointerException: Cannot invoke "net.minecraft.world.level.block.entity.BlockEntity.getBlockPos()" because "blockEntity" is null',
  '\tat net.minecraft.server.level.ServerLevel.tickBlockEntities(ServerLevel.java:1234)',
  '[12:00:00] [Server thread/ERROR]: Ticking block entity: create:mechanical_press["facing"=north] @ BlockPos{x=123, y=64, z=-456}'
].join('\n')

const WORLD_CORRUPT = [
  '[12:00:00] [Server thread/ERROR]: Failed to load world: java.io.IOException: Chunk file at (-3, 7) is corrupt',
  '\tat net.minecraft.world.level.chunk.storage.RegionFile.<init>(RegionFile.java:88)'
].join('\n')

const EULA_LOG = [
  '[12:00:00] [main/INFO]: Starting minecraft server version 1.20.1',
  '[12:00:00] [main/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.'
].join('\n')

const GARBLED_LOG = [
  '[12:00:00] [main/WARN]: 鏈嶅姟鍣ㄥ姞杞藉け璐ワ紝璇锋鏌ラ厤缃?',
  '[12:00:00] [main/INFO]: Loading properties'
].join('\n')

const FREEZE_LOG = [
  '[12:00:00] [main/INFO] (Minecraft/1.20.1) Loading Minecraft 1.20.1 with Forge 47.2.0',
  '[12:00:05] [main/INFO] [net.minecraftforge.fml.loading.ModSorter/]: Loading 200 mods:',
  '[12:00:09] [main/INFO] [net.minecraftforge.fml.loading.ModSorter/]: Injecting mods',
  '[12:00:12] [main/INFO] [net.minecraftforge.fml.loading.ModLoader/]: Constructing mods'
].join('\n')

const BENIGN_LOG = [
  '[12:00:00] [main/INFO]: Setting user: Steve',
  '[12:00:05] [Render thread/INFO]: Sound engine started',
  '[12:00:06] [Render thread/INFO]: Created: 1024x1024x4 minecraft:textures/atlas/blocks.png-atlas'
].join('\n')

const UNKNOWN_LOG = '[12:00:00] [main/ERROR]: something totally unknown happened: FooBarBaz while quuxing'

/* ------------------------------------------------------------------ *
 *  规则库自检
 * ------------------------------------------------------------------ */

describe('DIAGNOSE_RULES 规则库', () => {
  it('覆盖全部要求的类别与至少 28 条规则', () => {
    expect(DIAGNOSE_RULES.length).toBeGreaterThanOrEqual(28)
    const ids = new Set(DIAGNOSE_RULES.map((rule) => rule.id))
    expect(ids.size).toBe(DIAGNOSE_RULES.length)

    // 每条规则都必须是可用的：有标题、有正则可匹配、有步骤、有知识库映射
    for (const rule of DIAGNOSE_RULES) {
      expect(rule.title.length, rule.id).toBeGreaterThan(0)
      expect(rule.detail.length, rule.id).toBeGreaterThan(0)
      expect(rule.steps.length, rule.id).toBeGreaterThanOrEqual(3)
      expect(rule.patterns.length, rule.id).toBeGreaterThan(0)
      expect(rule.knowledgeIds.length, rule.id).toBeGreaterThan(0)
      expect(rule.confidence, rule.id).toBeGreaterThan(0)
      expect(rule.confidence, rule.id).toBeLessThanOrEqual(1)
    }

    const catalog = listRuleCatalog()
    expect(catalog.length).toBe(DIAGNOSE_RULES.length)
  })

  it('规则的正则都是合法且可重复使用的（无 g 标志导致的 lastIndex 污染）', () => {
    for (const rule of DIAGNOSE_RULES) {
      for (const pattern of rule.patterns) {
        expect(pattern.re.global, `${rule.id} 不允许使用 g 标志`).toBe(false)
        expect(() => pattern.re.test('sample')).not.toThrow()
        expect(() => rule.excludes?.forEach((re) => re.test('sample'))).not.toThrow()
      }
    }
  })

  it('class file major version → Java 版本映射正确', () => {
    expect(javaVersionForClassFileMajor(52)).toBe(8)
    expect(javaVersionForClassFileMajor(55)).toBe(11)
    expect(javaVersionForClassFileMajor(61)).toBe(17)
    expect(javaVersionForClassFileMajor(65)).toBe(21)
    expect(javaVersionForClassFileMajor(66)).toBe(22)
    expect(javaVersionForClassFileMajor(67)).toBe(23)
    expect(javaVersionForClassFileMajor(99)).toBeNull()
  })

  it('推荐堆大小的公式：物理内存 50%~70%，32 位上限 1.5G', () => {
    expect(recommendedMaxHeapMB(16384)).toBe(9728)
    expect(recommendedMaxHeapMB(8192)).toBe(4608)
    expect(recommendedMaxHeapMB(4096)).toBe(2048)
    expect(recommendedMaxHeapMB(65536)).toBe(12288)
    expect(recommendedMaxHeapMB(65536, { is32Bit: true })).toBe(1536)
    expect(recommendedMaxHeapMB(0)).toBe(4096)
  })
})

/* ------------------------------------------------------------------ *
 *  extractFacts / 崩溃报告 / hs_err 解析
 * ------------------------------------------------------------------ */

describe('extractFacts / 崩溃报告 / hs_err 解析', () => {
  it('从崩溃报告里抽取版本、Java、内存、退出码与栈顶', () => {
    const facts = extractFacts({ text: `${CRASH_REPORT}\nExit Code: -1` })
    expect(facts.gameVersion).toBe('1.20.1')
    expect(facts.javaMajor).toBe(17)
    expect(facts.maxHeapMB).toBe(4096)
    expect(facts.heapUsedMB).toBe(1177)
    expect(facts.physicalMemoryMB).toBe(16384)
    expect(facts.osArch).toBe('amd64')
    expect(facts.osName).toContain('Windows 11')
    expect(facts.loaderType).toBe('forge')
    expect(facts.loaderVersion).toBe('47.2.0')
    expect(facts.exitCode).toBe(-1)
    expect(facts.crashReport?.description).toBe('Initializing game')
    expect(facts.crashReport?.suspectedMods).toEqual(['Example Mod (examplemod)', 'Sodium (sodium)'])
    expect(facts.crashReport?.stackTop).toBe('com.example.mod.MixinFoo.handler(MixinFoo.java:42)')
    expect(facts.modCount).toBe(1)
    expect(facts.mods?.[0]?.id).toBe('examplemod')
    expect(facts.jvmFlags).toBeUndefined()
  })

  it('解析 crash report 的固定字段（Description / Suspected Mods / Stacktrace）', () => {
    const parsed = parseCrashReportFields(CRASH_REPORT)
    expect(parsed.description).toBe('Initializing game')
    expect(parsed.suspectedMods?.length).toBe(2)
    expect(parsed.stackTop).toContain('MixinFoo.handler')
  })

  it('解析 hs_err_pid 文件的关键字段', () => {
    const parsed = parseHsErrFields(HS_ERR)
    expect(parsed.reason).toContain('EXCEPTION_ACCESS_VIOLATION')
    expect(parsed.problematicFrame).toContain('nvoglv64.dll')
    expect(parsed.jreVersion).toContain('17.0.9')
    expect(parsed.outOfMemory).toBe(false)
  })

  it('识别 hs_err 里的内存不足标记', () => {
    const oomHsErr = [
      '#',
      '# A fatal error has been detected by the Java Runtime Environment:',
      '#',
      '#  Out of Memory Error (os_windows.cpp:3495), pid=12345, tid=6789',
      '#',
      '# JRE version: Java(TM) SE Runtime Environment (8.0_392-b08) (build 1.8.0_392-b08)',
      '# Java VM: Java HotSpot(TM) 64-Bit Server VM (25.392-b08 mixed mode windows-amd64 compressed oops)',
      '# Problematic frame:',
      '# C  [jvm.dll+0x7a3f1e]',
      '#',
      '# There is insufficient memory for the Java Runtime Environment to continue.',
      '# Command Line: -Xmx16G -XX:+UseG1GC -jar minecraft.jar'
    ].join('\n')
    const parsed = parseHsErrFields(oomHsErr)
    expect(parsed.outOfMemory).toBe(true)
    expect(parsed.reason).toContain('Out of Memory Error')
    expect(parsed.jreVersion).toContain('8.0_392')
    expect(parsed.commandLine).toContain('-Xmx16G')
  })

  it('从 -Xmx 参数与 Memory 行里解析堆大小', () => {
    const facts = extractFacts({ text: 'JVM Flags: 8 total; -XX:+UseG1GC -Xmx6G -Xms512m' })
    expect(facts.maxHeapMB).toBe(6144)
    expect(facts.jvmFlags).toContain('-Xmx6G')
    const facts2 = extractFacts({ text: 'Memory: 1048576 bytes (1024 MB) / 2147483648 bytes (2048 MB) up to 2147483648 bytes (2048 MB)' })
    expect(facts2.maxHeapMB).toBe(2048)
    expect(facts2.heapUsedMB).toBe(1)
  })

  it('抽取缺失依赖的 modid（Forge 与 Fabric 两种格式）', () => {
    expect(extractMissingDependencyIds(FORGE_MISSING_DEPS)).toEqual(['patchouli', 'curios'])
    expect(extractMissingDependencyIds(FABRIC_MISSING_DEPS)).toContain('cloth-config')
  })

  it('识别驱动 dll 所属厂商', () => {
    expect(detectGraphicsDriver(HS_ERR)?.vendor).toBe('NVIDIA')
    expect(detectGraphicsDriver('C  [atio6axx.dll+0x1234]')?.vendor).toBe('AMD')
    expect(detectGraphicsDriver('C  [ig9icd64.dll+0x1234]')?.vendor).toBe('Intel')
    expect(detectGraphicsDriver('no driver here')).toBeNull()
  })

  it('调用方提供的事实优先于文本抽取', () => {
    const facts = extractFacts({ text: 'Minecraft Version: 1.20.1', facts: { gameVersion: '1.19.2', physicalMemoryMB: 32768 } })
    expect(facts.gameVersion).toBe('1.19.2')
    expect(facts.physicalMemoryMB).toBe(32768)
  })
})

/* ------------------------------------------------------------------ *
 *  规则命中（每条规则用真实报错文本驱动）
 * ------------------------------------------------------------------ */

const engine = new DiagnosticEngine()

describe('DiagnosticEngine 规则命中', () => {
  it('OutOfMemoryError: Java heap space → memory 规则 + 具体 -Xmx 公式', async () => {
    const report = await engine.diagnose({ text: OOM_LOG, facts: { physicalMemoryMB: 16384 } })
    const finding = report.findings.find((item) => item.id === 'oom-heap')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('memory')
    expect(finding?.severity).toBe('error')
    expect(finding?.detail).toContain('9728')
    expect(finding?.steps[0]).toContain('50%~70%')
    expect(finding?.steps.join(' ')).toContain('32 位')
    expect(finding?.evidence.some((line) => line.includes('OutOfMemoryError: Java heap space'))).toBe(true)
    expect(report.gameVersion).toBe('1.20.1')
    expect(report.loaderType).toBe('fabric')
  })

  it('OutOfMemoryError: Metaspace 与 GC overhead limit exceeded 是分开的规则', async () => {
    const meta = await engine.diagnose({ text: 'java.lang.OutOfMemoryError: Metaspace' })
    expect(meta.findings.some((item) => item.id === 'oom-metaspace')).toBe(true)
    expect(meta.findings.find((item) => item.id === 'oom-metaspace')?.steps.join(' ')).toContain('MaxMetaspaceSize')

    const gc = await engine.diagnose({ text: 'java.lang.OutOfMemoryError: GC overhead limit exceeded' })
    expect(gc.findings.some((item) => item.id === 'oom-gc-overhead')).toBe(true)
  })

  it('UnsupportedClassVersionError → 解析 major version 并给出需要的 Java 版本', async () => {
    const report = await engine.diagnose({ text: UNSUPPORTED_CLASS_VERSION })
    const finding = report.findings.find((item) => item.id === 'unsupported-class-version')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('java')
    expect(finding?.title).toContain('21')
    expect(finding?.detail).toContain('65')
    expect(finding?.steps.some((step) => step.includes('Java 21'))).toBe(true)
  })

  it('EXCEPTION_ACCESS_VIOLATION + Problematic frame → 识别 nvoglv64.dll 并要求更新/回退驱动', async () => {
    const report = await engine.diagnose({ text: HS_ERR })
    const graphics = report.findings.find((item) => item.id === 'native-access-violation')
    expect(graphics).toBeDefined()
    expect(graphics?.category).toBe('graphics')
    expect(graphics?.severity).toBe('fatal')
    expect(graphics?.detail).toContain('nvoglv64.dll')
    expect(graphics?.steps.join(' ')).toContain('驱动')
    expect(graphics?.steps.join(' ')).toContain('OptiFine')
    expect(graphics?.confidence).toBeGreaterThan(0.8)
    // hs_err 会同时命中 JVM 致命错误规则（java 类别，去重后仍保留）
    expect(report.findings.some((item) => item.id === 'jvm-fatal-error')).toBe(true)
    expect(report.crashSummary).toContain('nvoglv64.dll')
  })

  it('Exit Code: -1073741819 → 解释 0xC0000005 且说明不是唯一原因', async () => {
    const report = await engine.diagnose({ text: '[12:00:00] [main/INFO] Exit Code: -1073741819' })
    const finding = report.findings.find((item) => item.id === 'exit-code-1073741819')
    expect(finding).toBeDefined()
    expect(finding?.detail).toContain('0xC0000005')
    expect(finding?.detail).toContain('不能据此断定')
    expect(finding?.steps.join(' ')).toContain('hs_err_pid')
    expect(finding?.steps.join(' ')).toContain('crash-report')
    expect(finding?.knowledgeIds).toContain('crash-exit-codes')
  })

  it('Exit Code: 1 无堆栈 → unknown 规则并引导打开控制台/内存参数', async () => {
    const report = await engine.diagnose({ text: '[12:00:00] [main/INFO] Exit Code: 1' })
    const finding = report.findings.find((item) => item.id === 'exit-code-1-no-stack')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('unknown')
    expect(finding?.steps.join(' ')).toContain('控制台')
    expect(finding?.steps.join(' ')).toContain('安全软件')
  })

  it('Exit Code: 1 但有堆栈时不使用“无堆栈”规则', async () => {
    const report = await engine.diagnose({
      text: ['Exit Code: 1', 'java.lang.NoSuchMethodError: \'void com.example.Util.run()\'', '\tat com.example.Core.init(Core.java:1)'].join('\n')
    })
    expect(report.findings.some((item) => item.id === 'exit-code-1-no-stack')).toBe(false)
    expect(report.findings.some((item) => item.id === 'noclass-nosuchmethod')).toBe(true)
  })

  it('Exit Code: -1 → 解释启动器 kill / JVM 未启动', async () => {
    const report = await engine.diagnose({ text: '[12:00:00] [main/INFO] Exit Code: -1' })
    const finding = report.findings.find((item) => item.id === 'exit-code-minus-one')
    expect(finding).toBeDefined()
    expect(finding?.steps.join(' ')).toContain('Java')
  })

  it('Mixin 注入失败 → mod-conflict 且给出二分法与冲突组合', async () => {
    const report = await engine.diagnose({ text: MIXIN_FAILED })
    const finding = report.findings.find((item) => item.id === 'mixin-apply-failed')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('mod-conflict')
    expect(finding?.steps.join(' ')).toContain('二分法')
    expect(finding?.knowledgeIds).toContain('crash-mixin-failed')
  })

  it('Missing or unsupported mandatory dependencies → 提取缺失 modid 并与本地 mods 交叉比对', async () => {
    const report = await engine.diagnose({
      text: FORGE_MISSING_DEPS,
      facts: { mods: [{ fileName: 'enchantedbook-1.0.0.jar', id: 'enchantedbook' }] }
    })
    const finding = report.findings.find((item) => item.id === 'missing-mandatory-dependency')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('mod-missing-dependency')
    expect(finding?.detail).toContain('patchouli')
    expect(finding?.detail).toContain('curios')
    expect(finding?.detail).toContain('确认缺失')
    expect(finding?.steps[0]).toContain('patchouli')
  })

  it('Fabric 的 requires any version of mod ... which is missing → 记入缺失依赖', async () => {
    const report = await engine.diagnose({ text: FABRIC_MISSING_DEPS })
    const finding = report.findings.find((item) => item.category === 'mod-missing-dependency')
    expect(finding).toBeDefined()
    expect(finding?.detail).toContain('cloth-config')
  })

  it('Incompatible mod set! → mod-version-mismatch 并列出涉及的模组', async () => {
    const text = [
      'net.fabricmc.loader.impl.FormattedException: Mod resolution encountered an error. Please try the following:',
      "\t- Mod 'Sodium' (sodium) 0.5.8 requires version 1.20.4 of minecraft, which is not loaded"
    ].join('\n')
    const report = await engine.diagnose({ text })
    const finding = report.findings.find((item) => item.id === 'incompatible-mod-set')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('mod-version-mismatch')
    expect(finding?.detail).toContain('sodium')
  })

  it('NoSuchMethodError → 解析类名并区分缺少前置 / 版本不匹配', async () => {
    const report = await engine.diagnose({ text: NO_SUCH_METHOD })
    const finding = report.findings.find((item) => item.id === 'noclass-nosuchmethod')
    expect(finding).toBeDefined()
    expect(finding?.detail).toContain('net.minecraft.class_310')
    expect(finding?.detail).toContain('MC 版本')
  })

  it('ClassNotFoundException → mod-missing-dependency 并给出类名', async () => {
    const report = await engine.diagnose({
      text: "java.lang.ClassNotFoundException: net.fabricmc.api.ModInitializer\n\tat net.fabricmc.loader.impl.FabricLoaderImpl.load(FabricLoaderImpl.java:1)"
    })
    const finding = report.findings.find((item) => item.id === 'class-not-found')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('mod-missing-dependency')
    expect(finding?.detail).toContain('net.fabricmc.api.ModInitializer')
  })

  it('缺少 mods.toml → loader 规则并点名具体文件', async () => {
    const report = await engine.diagnose({
      text: 'The mod file /home/steve/.minecraft/mods/fabric-mod-1.0.0.jar is missing a mods.toml file'
    })
    const finding = report.findings.find((item) => item.id === 'invalid-mod-file')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('loader')
    expect(finding?.steps[0]).toContain('fabric-mod-1.0.0.jar')
  })

  it('Pixel format not accelerated / GLFW error → graphics', async () => {
    const report = await engine.diagnose({
      text: '[12:00:00] [main/ERROR]: Pixel format not accelerated\n[12:00:00] [main/ERROR]: GLFW error 65542: WGL: The driver does not appear to support OpenGL'
    })
    const finding = report.findings.find((item) => item.id === 'graphics-opengl-unsupported')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('graphics')
    expect(finding?.steps.join(' ')).toContain('基本显示适配器')
  })

  it('资源/资产缺失 → asset 规则并引导重新下载版本', async () => {
    const report = await engine.diagnose({
      text: '[12:00:00] [main/ERROR]: Failed to download file\njava.io.FileNotFoundException: http://resources.download.minecraft.net/ab/abcdef 404'
    })
    const finding = report.findings.find((item) => item.id === 'asset-missing')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('asset')
  })

  it('Invalid session / Failed to verify username → auth', async () => {
    const report = await engine.diagnose({
      text: '[12:00:00] [Render thread/ERROR]: Failed to verify username!\n[12:00:00] [Render thread/INFO]: Invalid session (Try restarting your game)'
    })
    const finding = report.findings.find((item) => item.id === 'auth-failed')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('auth')
    expect(finding?.steps.join(' ')).toContain('重新登录')
  })

  it('Connection refused / UnknownHostException → network', async () => {
    const refused = await engine.diagnose({
      text: 'io.netty.channel.AbstractChannel$AnnotatedConnectException: Connection refused: no further information: mc.example.com/1.2.3.4:25565'
    })
    expect(refused.findings.some((item) => item.id === 'network-connect-failed')).toBe(true)
    const dns = await engine.diagnose({ text: 'java.net.UnknownHostException: mc.example.com' })
    const finding = dns.findings.find((item) => item.id === 'network-connect-failed')
    expect(finding?.detail).toContain('DNS')
  })

  it('服务端 Ticking entity/block entity → 提取坐标作为定位线索', async () => {
    const report = await engine.diagnose({ text: SERVER_TICKING })
    const finding = report.findings.find((item) => item.id === 'server-ticking-crash')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('server')
    expect(finding?.detail).toContain('create:mechanical_press')
    expect(finding?.steps[0]).toContain('BlockPos')
  })

  it('Chunk file ... is corrupt → world 规则并提示先备份', async () => {
    const report = await engine.diagnose({ text: WORLD_CORRUPT })
    const finding = report.findings.find((item) => item.id === 'world-corrupt')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('world')
    expect(finding?.steps[0]).toContain('备份')
  })

  it('Forge installer 失败 → loader 规则', async () => {
    const report = await engine.diagnose({ text: 'The forge installer failed: java.io.IOException: download failed' })
    expect(report.findings.some((item) => item.id === 'forge-install-failed')).toBe(true)
  })

  it('ClassCastException 涉及模组包名 → mod-conflict', async () => {
    const report = await engine.diagnose({
      text: [
        'java.lang.ClassCastException: class com.example.mod.FakeLevel cannot be cast to class net.minecraft.world.level.Level',
        '\tat com.example.mod.MixinLevel.getLevel(MixinLevel.java:33)'
      ].join('\n')
    })
    const finding = report.findings.find((item) => item.id === 'linkage-classcast')
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('mod-conflict')
    expect(finding?.detail).toContain('com.example.mod.FakeLevel')
  })

  it('卡死（preinit 且末尾无堆栈）→ performance 规则；已就绪时不再命中', async () => {
    const frozen = await engine.diagnose({ text: FREEZE_LOG })
    expect(frozen.findings.some((item) => item.id === 'freeze-no-progress')).toBe(true)
    expect(
      frozen.findings.find((item) => item.id === 'freeze-no-progress')?.steps.join(' ')
    ).toContain('jstack')

    const ready = await engine.diagnose({ text: `${FREEZE_LOG}\n${BENIGN_LOG}` })
    expect(ready.findings.some((item) => item.id === 'freeze-no-progress')).toBe(false)
  })

  it('中文乱码 → java 编码规则（-Dfile.encoding=UTF-8）', async () => {
    const report = await engine.diagnose({ text: GARBLED_LOG })
    const finding = report.findings.find((item) => item.id === 'encoding-garbled')
    expect(finding).toBeDefined()
    expect(finding?.steps.join(' ')).toContain('-Dfile.encoding=UTF-8')
  })

  it('渲染线程 ArrayIndexOutOfBoundsException → graphics；非渲染线程不命中该规则', async () => {
    const render = await engine.diagnose({
      text: [
        '[12:00:00] [Render thread/ERROR]: java.lang.ArrayIndexOutOfBoundsException: Index 12 out of bounds for length 8',
        '\tat net.minecraft.client.renderer.block.model.BakedQuad.<init>(BakedQuad.java:12)'
      ].join('\n')
    })
    expect(render.findings.some((item) => item.id === 'render-array-index')).toBe(true)

    const nonRender = await engine.diagnose({
      text: 'java.lang.ArrayIndexOutOfBoundsException: Index 1 out of bounds for length 0\n\tat com.example.util.ListUtil.get(ListUtil.java:5)'
    })
    expect(nonRender.findings.some((item) => item.id === 'render-array-index')).toBe(false)
  })

  it('Bukkit 插件加载失败与 EULA 未同意 → server 规则', async () => {
    const plugin = await engine.diagnose({
      text:
        "[12:00:00] [Server thread/ERROR]: Could not load 'plugins/EssentialsX-2.19.0.jar' in folder 'plugins'\n" +
        'org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [Vault].'
    })
    expect(plugin.findings.some((item) => item.id === 'server-plugin-load-failed')).toBe(true)

    const eula = await engine.diagnose({ text: EULA_LOG })
    expect(eula.findings.some((item) => item.id === 'server-eula-not-accepted')).toBe(true)
    expect(eula.findings.find((item) => item.id === 'server-eula-not-accepted')?.steps[0]).toContain('eula.txt')
  })

  it('The game crashed whilst <stage> 按阶段细分', async () => {
    const init = await engine.diagnose({ text: 'The game crashed whilst initializing game\nError: java.lang.NullPointerException' })
    expect(init.findings.some((item) => item.id === 'crash-stage-initializing')).toBe(true)

    const overlay = await engine.diagnose({
      text: 'The game crashed whilst rendering overlay\nError: java.lang.RuntimeException: Failed to load resource pack'
    })
    expect(overlay.findings.some((item) => item.id === 'crash-stage-rendering-overlay')).toBe(true)

    const ticking = await engine.diagnose({ text: 'The game crashed whilst ticking screen\nError: NullPointerException' })
    expect(ticking.findings.some((item) => item.id === 'crash-stage-ticking-screen')).toBe(true)
  })

  it('崩溃报告（Description: Initializing game）→ stage 规则 + 事实', async () => {
    const report = await engine.diagnose({ text: CRASH_REPORT })
    expect(report.findings.some((item) => item.id === 'crash-stage-initializing')).toBe(true)
    expect(report.crashSummary).toContain('疑似模组')
    expect(report.crashSummary).toContain('Example Mod (examplemod)')
    expect(report.rawExcerpt.length).toBeGreaterThan(50)
  })

  it('Found duplicate mods → mod-conflict 重复模组规则', async () => {
    const report = await engine.diagnose({
      text: ['java.lang.RuntimeException: Found duplicate mods:', '\tsodium 0.5.8 @ /mods/sodium-1.jar', '\tsodium 0.5.11 @ /mods/sodium-2.jar'].join('\n')
    })
    expect(report.findings.some((item) => item.id === 'duplicate-mods')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  去重 / 排序 / 兜底 / 摘要
 * ------------------------------------------------------------------ */

describe('DiagnosticEngine 排序、去重、兜底与摘要', () => {
  it('severity 降序 → confidence 降序', async () => {
    const report = await engine.diagnose({ text: `${HS_ERR}\n${FORGE_MISSING_DEPS}` })
    const ranks = { info: 1, warning: 2, error: 3, fatal: 4 }
    for (let i = 1; i < report.findings.length; i++) {
      const prev = report.findings[i - 1]
      const current = report.findings[i]
      expect(ranks[prev.severity] * 1000 + prev.confidence * 100).toBeGreaterThanOrEqual(
        ranks[current.severity] * 1000 + current.confidence * 100
      )
    }
    expect(report.findings[0]?.severity).toBe('fatal')
  })

  it('同一 category 只保留最相关的一条', async () => {
    const report = await engine.diagnose({
      text: [
        'net.fabricmc.loader.impl.FormattedException: Incompatible mod set!',
        "\t- Mod 'X' (x) 1.0.0 requires version 1.20.1 of minecraft",
        "java.lang.NoSuchMethodError: 'void net.minecraft.class_310.method_1551()'"
      ].join('\n')
    })
    expect(report.findings.filter((item) => item.category === 'mod-version-mismatch').length).toBe(1)
  })

  it('evidence 是原文片段、最多 6 行、每行不超过 300 字', async () => {
    const longLine = `[12:00:00] [main/ERROR]: java.lang.OutOfMemoryError: Java heap space ${'x'.repeat(500)}`
    const lines = [longLine, ...Array.from({ length: 10 }, (_, i) => `[12:00:00] [main/ERROR]: ${i} java.lang.OutOfMemoryError: Java heap space`)]
    const report = await engine.diagnose({ text: lines.join('\n') })
    const finding = report.findings.find((item) => item.id === 'oom-heap')
    expect(finding).toBeDefined()
    expect(finding?.evidence.length).toBeLessThanOrEqual(6)
    for (const line of finding?.evidence ?? []) {
      expect(line.length).toBeLessThanOrEqual(301)
      expect(line).toContain('OutOfMemoryError')
      // 原文片段必须保留（不做改写）
      expect(line.startsWith('[12:00:00]') || line.startsWith('#')).toBe(true)
    }
  })

  it('没有任何命中时返回 unknown 级别的兜底 finding 与通用排查路径', async () => {
    const report = await engine.diagnose({ text: UNKNOWN_LOG })
    expect(report.findings.length).toBeGreaterThan(0)
    const fallback = report.findings[0]
    expect(fallback.category).toBe('unknown')
    expect(fallback.severity).toBe('warning')
    expect(fallback.steps.length).toBeGreaterThanOrEqual(5)
    expect(fallback.steps.join(' ')).toContain('crash-reports')
    expect(fallback.steps.join(' ')).toContain('二分法')
    expect(fallback.evidence.length).toBeGreaterThan(0)
  })

  it('正常退出的日志返回 info 级“未发现已知问题”', async () => {
    const report = await engine.diagnose({ text: BENIGN_LOG })
    expect(report.findings[0]?.id).toBe('no-known-issue')
    expect(report.findings[0]?.severity).toBe('info')
  })

  it('空输入也返回可读报告', async () => {
    const report = await engine.diagnose({ text: '' })
    expect(report.scannedLines).toBe(0)
    expect(report.findings[0]?.id).toBe('input-empty')
  })

  it('minSeverity 与 limit 生效', async () => {
    const report = await engine.diagnose({ text: `${HS_ERR}\n${FORGE_MISSING_DEPS}`, minSeverity: 'fatal' })
    expect(report.findings.every((item) => item.severity === 'fatal')).toBe(true)

    const limited = await engine.diagnose({ text: `${HS_ERR}\n${FORGE_MISSING_DEPS}`, limit: 1 })
    expect(limited.findings.length).toBe(1)
  })

  it('summarize / nextSteps 输出给 Agent 的高密度摘要', async () => {
    const report = await engine.diagnose({ text: OOM_LOG, facts: { physicalMemoryMB: 16384 } })
    const summary = engine.summarize(report)
    expect(summary).toContain('诊断报告')
    expect(summary).toContain('内存')
    expect(summary).toContain('知识库')

    const steps = engine.nextSteps(report)
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((step) => typeof step === 'string' && step.length > 0)).toBe(true)
    expect(steps.join(' ')).toContain('-Xmx')
  })

  it('parseCrashReport / parseHsErr 作为公共方法可用', () => {
    expect(engine.parseCrashReport(CRASH_REPORT)?.description).toBe('Initializing game')
    expect(engine.parseHsErr(HS_ERR).problematicFrame).toContain('nvoglv64.dll')
  })

  it('detectStartupState 与本引擎对卡死的判定一致', () => {
    expect(detectStartupState(parseLogChunk(FREEZE_LOG)).stage).toBe('preinit')
    expect(detectStartupState(parseLogChunk(BENIGN_LOG)).stage).toBe('ready')
  })
})

/* ------------------------------------------------------------------ *
 *  知识库联动
 * ------------------------------------------------------------------ */

describe('诊断引擎与知识库联动', () => {
  it('命中规则映射到真实存在的知识库文章，并做二次检索补充', async () => {
    const knowledge = new KnowledgeBase({ roots: [KNOWLEDGE_ROOT] })
    const report = await engine.diagnose({ text: OOM_LOG, facts: { physicalMemoryMB: 16384 }, knowledge })
    const oom = report.findings.find((item) => item.id === 'oom-heap')
    expect(oom?.knowledgeIds).toContain('crash-out-of-memory')
    for (const id of oom?.knowledgeIds ?? []) {
      expect(await knowledge.read(id)).not.toBeNull()
    }
    // 二次检索应该能补充到内存参数相关的文章
    expect((oom?.knowledgeIds ?? []).length).toBeGreaterThan(1)
  })

  it('所有规则的知识库 id 都能在知识库里查到（防止规则与知识库脱节）', async () => {
    const knowledge = new KnowledgeBase({ roots: [KNOWLEDGE_ROOT] })
    await knowledge.load()
    const missing: string[] = []
    for (const rule of DIAGNOSE_RULES) {
      for (const id of rule.knowledgeIds) {
        if (!(await knowledge.read(id))) missing.push(`${rule.id} → ${id}`)
      }
    }
    expect(missing).toEqual([])
  })
})
