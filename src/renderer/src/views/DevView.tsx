/**
 * 开发工作台。
 *
 * 三件事：
 *   1) 模板脚手架 —— 选模板 → 填变量 → 选目录 → 生成可构建的项目骨架（含下一步指引）
 *   2) 构建 —— 选项目目录 → 跑 gradle 任务 → 实时/最终输出
 *   3) 生图 —— 像素风贴图 / 图标 / GUI：预设 + 提示词 → 生成落盘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DevTemplate, ImagePreset } from '@shared/types'
import { mcal } from '../lib/api'
import { loaderLabel } from '../lib/format'
import { reportError, toast, useSettings, useView } from '../state/store'
import { Badge, Button, Chip, Empty, Field, Input, Progress, Tabs, Textarea } from '../components/ui/primitives'
import {
  IconAlert,
  IconCode,
  IconFolder,
  IconImage,
  IconInfo,
  IconPlay,
  IconRefresh,
  IconSparkles,
  IconWrench
} from '../components/ui/icons'

type DevTab = 'scaffold' | 'build' | 'image'

const KIND_LABELS: Record<DevTemplate['kind'], string> = {
  mod: '模组',
  plugin: '服务端插件',
  shaderpack: '光影包',
  resourcepack: '资源包',
  datapack: '数据包',
  modpack: '整合包'
}

const IMAGE_PRESETS: { id: ImagePreset; name: string; note: string; usage: string }[] = [
  { id: 'mc-item', name: '物品图标', note: '16×16 像素风，自动去背', usage: '武器 / 工具 / 材料的背包图标' },
  { id: 'mc-block', name: '方块贴图', note: '16×16，可平铺，不去背', usage: '方块六面贴图（无透视、无阴影）' },
  { id: 'mc-gui', name: 'GUI 界面', note: '256×256 面板，规整边框', usage: '容器界面 / 菜单背景' },
  { id: 'concept-art', name: '概念图', note: '不做像素化，保留原分辨率', usage: 'mod 封面 / 宣传图' },
  { id: 'logo', name: '模组 Logo', note: '128×128，透明背景', usage: '模组列表图标 / 启动页' },
  { id: 'raw', name: '原图', note: '不加风格前缀，不做后处理', usage: '自由发挥，自己后期处理' }
]

const PIXEL_SIZES = [16, 32, 64, 128]

export function DevView(): React.JSX.Element {
  const [tab, setTab] = useState<DevTab>('scaffold')
  const navigate = useView((state) => state.navigate)

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">
          <h2>开发工作台</h2>
          <span className="fs-sm muted">起项目、构建、生成贴图 —— AI 可以帮你写代码，也可以在这里手动操作</span>
        </div>
      </div>

      <div className="page__body">
        <div
          className="mcal-card anim-fade"
          style={{ padding: '12px 16px', marginBottom: 16, borderColor: 'rgba(61,220,132,0.2)' }}
        >
          <div className="row-start gap-3">
            <IconSparkles size={16} className="accent" style={{ marginTop: 2 }} />
            <div className="col gap-1">
              <div className="fs-sm">
                AI 可以帮你写 mod 代码、生成贴图，也可以在这里手动起项目。
              </div>
              <div className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
                最省事的用法：直接在「AI 助手」里说「帮我做一个 Fabric 1.20.1 的自定义物品 mod」，
                它会生成项目、写代码，甚至调用这里的构建能力。下面三个标签页是给想自己动手的玩家的。
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => navigate('agent', { prompt: '帮我用开发工作台起一个 Minecraft 模组项目，并说明接下来该怎么做。' })}>
              让 AI 来做
            </Button>
          </div>
        </div>

        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'scaffold', label: '模板脚手架' },
            { value: 'build', label: '构建项目' },
            { value: 'image', label: '生成贴图' }
          ]}
        />

        <div style={{ marginTop: 16 }}>
          {tab === 'scaffold' ? <ScaffoldTab /> : null}
          {tab === 'build' ? <BuildTab /> : null}
          {tab === 'image' ? <ImageTab /> : null}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  模板脚手架
 * ------------------------------------------------------------------ */

/** 主进程实际返回的内容比类型声明更丰富（含 warnings / nextSteps），这里做一次兼容读取 */
interface ScaffoldOutput {
  files: string[]
  root: string
  warnings?: string[]
  nextSteps?: string[]
}

function ScaffoldTab(): React.JSX.Element {
  const [templates, setTemplates] = useState<DevTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [targetDir, setTargetDir] = useState('')
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<ScaffoldOutput | null>(null)

  const selected = useMemo(() => templates.find((item) => item.id === selectedId) ?? null, [templates, selectedId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await mcal.devTemplates()
      setTemplates(list)
      if (list.length > 0) selectTemplate(list[0])
    } catch (error) {
      reportError(error, '读取模板列表失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function selectTemplate(template: DevTemplate): void {
    setSelectedId(template.id)
    setResult(null)
    const next: Record<string, string> = {}
    for (const variable of template.variables) next[variable.key] = variable.default ?? ''
    setValues(next)
  }

  const pickTarget = useCallback(async () => {
    const dir = await mcal.pickDir({ title: '选择项目生成位置' }).catch((error: unknown) => {
      reportError(error, '选择目录失败')
      return null
    })
    if (dir) setTargetDir(dir)
  }, [])

  const generate = useCallback(async () => {
    if (!selected) return
    if (!targetDir) {
      toast.warn('还没选择目标目录', '生成的工程会放在这个目录下')
      return
    }
    const missing = selected.variables.filter((variable) => variable.required && !(values[variable.key] ?? '').trim())
    if (missing.length > 0) {
      toast.warn('有必填项没填', missing.map((item) => item.label).join('、'))
      return
    }
    setGenerating(true)
    setResult(null)
    try {
      const output = await mcal.devScaffold({ templateId: selected.id, targetDir, options: values })
      setResult(output as ScaffoldOutput)
      toast.ok('项目已生成', `${output.files.length} 个文件 → ${output.root}`)
    } catch (error) {
      reportError(error, '生成项目失败')
    } finally {
      setGenerating(false)
    }
  }, [selected, targetDir, values])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
      {/* 模板列表 */}
      <div className="col gap-2">
        <div className="row-between">
          <span className="fs-sm bold">选择模板</span>
          <Button size="sm" variant="ghost" icon={<IconRefresh size={12} />} onClick={() => void load()}>
            刷新
          </Button>
        </div>
        {loading ? <div className="skeleton" style={{ height: 120 }} /> : null}
        <div className="col gap-2 stagger">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className={`mcal-card ${template.id === selectedId ? 'mcal-card--selected' : 'mcal-card--interactive'}`}
              style={{ padding: '11px 13px', textAlign: 'left' }}
              onClick={() => selectTemplate(template)}
            >
              <div className="row-between gap-2">
                <span className="fs-sm bold truncate">{template.name}</span>
                <Badge tone={template.kind === 'mod' ? 'ok' : template.kind === 'plugin' ? 'info' : 'violet'}>
                  {KIND_LABELS[template.kind] ?? template.kind}
                </Badge>
              </div>
              <div className="fs-xs muted" style={{ marginTop: 4, lineHeight: 'var(--lh-normal)' }}>
                {template.description}
              </div>
              {template.loader ? (
                <div className="fs-xs faint" style={{ marginTop: 4 }}>
                  {loaderLabel(template.loader)}
                </div>
              ) : null}
            </button>
          ))}
        </div>
        {!loading && templates.length === 0 ? (
          <div className="fs-sm muted">没有找到模板。请确认 resources/templates 目录存在。</div>
        ) : null}
      </div>

      {/* 变量表单 */}
      <div className="col gap-4">
        {selected ? (
          <div className="mcal-card" style={{ padding: 18 }}>
            <div className="row-between gap-3" style={{ marginBottom: 14 }}>
              <div className="col gap-1">
                <span className="fs-md bold">{selected.name}</span>
                <span className="fs-xs muted">{selected.description}</span>
              </div>
              <Badge tone="info">{KIND_LABELS[selected.kind] ?? selected.kind}</Badge>
            </div>

            <div className="col gap-4">
              {selected.variables.map((variable) => (
                <Field
                  key={variable.key}
                  label={variable.label || variable.key}
                  required={variable.required}
                  hint={variable.default ? `默认值：${variable.default}` : undefined}
                >
                  <Input
                    value={values[variable.key] ?? ''}
                    onChange={(value) => setValues((previous) => ({ ...previous, [variable.key]: value }))}
                    placeholder={variable.default ?? `请输入 ${variable.label || variable.key}`}
                    monospace
                  />
                </Field>
              ))}

              <Field label="目标目录" required hint="工程会生成在这个目录下（建议新建一个空目录）">
                <div className="row gap-2">
                  <Input value={targetDir} onChange={setTargetDir} placeholder="未选择" monospace />
                  <Button icon={<IconFolder size={14} />} onClick={() => void pickTarget()}>
                    选择
                  </Button>
                </div>
              </Field>

              <div className="row gap-2">
                <Button variant="primary" loading={generating} icon={<IconWrench size={14} />} onClick={() => void generate()}>
                  生成项目
                </Button>
                {targetDir ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void mcal.openPath(targetDir).catch((error: unknown) => reportError(error, '打开目录失败'))
                    }
                  >
                    打开目标目录
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="mcal-card" style={{ padding: 6 }}>
            <Empty icon={<IconCode />} title="先从左边选一个模板" description="Fabric / Forge / NeoForge 模组、Paper 插件、Iris 光影、资源包、数据包、整合包都有现成骨架。" />
          </div>
        )}

        {result ? <ScaffoldResult result={result} template={selected} /> : null}
      </div>
    </div>
  )
}

function ScaffoldResult({
  result,
  template
}: {
  result: ScaffoldOutput
  template: DevTemplate | null
}): React.JSX.Element {
  const kind = template?.kind ?? 'mod'
  const steps: string[] = result.nextSteps && result.nextSteps.length > 0 ? result.nextSteps : []
  if (steps.length === 0) {
    if (kind === 'mod' || kind === 'plugin') {
      steps.push('用 IDE（IntelliJ IDEA / VS Code）打开项目目录，等待 Gradle 同步完成')
      steps.push('在「构建项目」标签页选择该目录，任务填 `build`（Windows 下等价于 gradlew.bat build）')
      steps.push(
        kind === 'mod'
          ? '把 build/libs 下的 jar 放进实例的 mods 目录（注意加载器与游戏版本要一致）'
          : '把 build/libs 下的 jar 放进服务端的 plugins 目录，重启服务端'
      )
    } else if (kind === 'shaderpack') {
      steps.push('把生成的目录（或用压缩工具打成 zip）放进实例的 shaderpacks 目录')
      steps.push('在游戏里「选项 → 视频设置 → 光影」中选择它（需要 Iris 或 OptiFine）')
    } else if (kind === 'resourcepack') {
      steps.push('把生成的目录打包成 zip（保持 pack.mcmeta 在压缩包根目录）')
      steps.push('放进实例的 resourcepacks 目录，在游戏中启用')
    } else if (kind === 'datapack') {
      steps.push('把生成的目录放进存档的 datapacks 目录（单人档：saves/<世界名>/datapacks）')
      steps.push('游戏内执行 /reload 重载数据包')
    } else {
      steps.push('检查生成的清单文件与目录结构')
      steps.push('可直接用启动器的「整合包」页面导入或继续编辑')
    }
  }

  return (
    <div className="mcal-card anim-rise" style={{ padding: 18 }}>
      <div className="row gap-2" style={{ marginBottom: 10 }}>
        <IconInfo size={15} className="accent" />
        <span className="fs-md bold">生成完成</span>
        <Badge tone="ok">{result.files.length} 个文件</Badge>
      </div>
      <div className="fs-xs muted break-all" style={{ marginBottom: 10 }}>
        {result.root}
      </div>

      {result.warnings && result.warnings.length > 0 ? (
        <div
          className="col gap-1"
          style={{
            padding: '9px 12px',
            marginBottom: 12,
            borderRadius: 'var(--r-md)',
            background: 'rgba(255,157,77,0.1)',
            border: '1px solid rgba(255,157,77,0.28)'
          }}
        >
          {result.warnings.map((warning, index) => (
            <span key={index} className="fs-xs" style={{ lineHeight: 'var(--lh-relaxed)' }}>
              {warning}
            </span>
          ))}
        </div>
      ) : null}

      <div className="fs-sm bold" style={{ marginBottom: 6 }}>
        文件列表
      </div>
      <pre className="log-view selectable" style={{ margin: 0, maxHeight: 200 }}>
        {result.files.join('\n')}
      </pre>

      <div className="fs-sm bold" style={{ margin: '14px 0 6px' }}>
        下一步该做什么
      </div>
      <ol className="col gap-2" style={{ paddingLeft: 18 }}>
        {steps.map((step, index) => (
          <li key={index} className="fs-sm dim" style={{ lineHeight: 'var(--lh-relaxed)' }}>
            {step}
          </li>
        ))}
      </ol>

      <div className="row gap-2" style={{ marginTop: 14 }}>
        <Button
          icon={<IconFolder size={14} />}
          onClick={() => void mcal.openPath(result.root).catch((error: unknown) => reportError(error, '打开目录失败'))}
        >
          打开项目目录
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  构建
 * ------------------------------------------------------------------ */

function BuildTab(): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [task, setTask] = useState('build')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<{ ok: boolean; code: number | null; output: string } | null>(null)

  const pickDir = useCallback(async () => {
    const picked = await mcal.pickDir({ title: '选择要构建的项目目录' }).catch((error: unknown) => {
      reportError(error, '选择目录失败')
      return null
    })
    if (picked) setDir(picked)
  }, [])

  const runBuild = useCallback(async () => {
    if (!dir) {
      toast.warn('还没选择项目目录')
      return
    }
    setRunning(true)
    setOutput(null)
    try {
      const result = await mcal.devBuild({ dir, task: task.trim() || 'build' })
      setOutput(result)
      if (result.ok) toast.ok('构建成功', `退出码 ${result.code ?? 0}`)
      else toast.err('构建失败', `退出码 ${result.code ?? '未知'}，详见输出`)
    } catch (error) {
      reportError(error, '构建失败')
    } finally {
      setRunning(false)
    }
  }, [dir, task])

  return (
    <div className="col gap-4" style={{ maxWidth: 900 }}>
      <div className="mcal-card" style={{ padding: 18 }}>
        <div className="col gap-4">
          <Field label="项目目录" required hint="需要包含 gradlew / gradlew.bat 或本机已安装 gradle">
            <div className="row gap-2">
              <Input value={dir} onChange={setDir} placeholder="未选择" monospace />
              <Button icon={<IconFolder size={14} />} onClick={() => void pickDir()}>
                选择
              </Button>
            </div>
          </Field>
          <Field label="Gradle 任务" hint="默认 build；常用：build、runClient、runServer、clean">
            <Input value={task} onChange={setTask} placeholder="build" monospace />
          </Field>
          <div className="row gap-2">
            <Button variant="primary" loading={running} icon={<IconPlay size={14} />} onClick={() => void runBuild()}>
              开始构建
            </Button>
            {dir ? (
              <Button
                variant="ghost"
                icon={<IconFolder size={14} />}
                onClick={() => void mcal.openPath(dir).catch((error: unknown) => reportError(error, '打开目录失败'))}
              >
                打开项目目录
              </Button>
            ) : null}
          </div>
          <div className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
            构建会调用项目的 Gradle wrapper（或系统 gradle），首次构建需要联网下载依赖，可能耗时数分钟。
            构建期间无法取消 —— Gradle 的中断由它自己处理，中途强杀容易留下损坏的缓存。
          </div>
        </div>
      </div>

      {running ? (
        <div className="col gap-2">
          <div className="row gap-2 fs-sm dim">
            <span className="mcal-spinner" style={{ width: 13, height: 13, borderWidth: 1.8 }} />
            正在构建，输出会在完成后显示…
          </div>
          <Progress indeterminate />
        </div>
      ) : null}

      {output ? (
        <div className="mcal-card anim-fade" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="row-between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--c-hairline)' }}>
            <div className="row gap-2">
              <IconCode size={15} className={output.ok ? 'accent' : 'err'} />
              <span className="fs-md bold">构建输出</span>
            </div>
            <div className="row gap-2">
              <Badge tone={output.ok ? 'ok' : 'err'}>{output.ok ? '成功' : '失败'}</Badge>
              <Badge>退出码 {output.code ?? '未知'}</Badge>
            </div>
          </div>
          <pre className="log-view selectable" style={{ margin: 0, borderRadius: 0, border: 'none', maxHeight: 460 }}>
            {output.output || '（没有输出）'}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  生图
 * ------------------------------------------------------------------ */

interface MediaProviderInfo {
  id: string
  name: string
  configured: boolean
  models: string[]
}

function ImageTab(): React.JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigate = useView((state) => state.navigate)

  const [providers, setProviders] = useState<MediaProviderInfo[]>([])
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [preset, setPreset] = useState<ImagePreset>('mc-item')
  const [pixelSize, setPixelSize] = useState(16)
  const [count, setCount] = useState(1)
  const [outputDir, setOutputDir] = useState('')
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<{ files: string[]; provider: string } | null>(null)
  // 生成结果是磁盘路径，渲染进程受 CSP 限制读不了 file://，由主进程转成 data URL
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [previewsReady, setPreviewsReady] = useState(false)

  const activeProviderId = settings?.media.activeProviderId
  const activeProvider = providers.find((item) => item.id === activeProviderId) ?? providers.find((item) => item.configured) ?? providers[0]
  const anyConfigured = providers.some((item) => item.configured)

  const loadProviders = useCallback(async () => {
    try {
      const list = await mcal.mediaProviders()
      setProviders(list)
    } catch (error) {
      reportError(error, '读取生图服务失败')
    }
  }, [])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  useEffect(() => {
    const files = result?.files ?? []
    if (files.length === 0) {
      setPreviews({})
      setPreviewsReady(false)
      return
    }
    let cancelled = false
    setPreviewsReady(false)
    void (async () => {
      const entries = await Promise.all(
        files.map(async (file) => [file, await mcal.readLocalImage(file).catch(() => null)] as const)
      )
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const [file, data] of entries) {
        if (data?.dataUrl) next[file] = data.dataUrl
      }
      setPreviews(next)
      setPreviewsReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [result])

  const pickOutputDir = useCallback(async () => {
    const dir = await mcal.pickDir({ title: '选择图片输出目录' }).catch((error: unknown) => {
      reportError(error, '选择目录失败')
      return null
    })
    if (dir) setOutputDir(dir)
  }, [])

  const generate = useCallback(async () => {
    if (!prompt.trim()) {
      toast.warn('请先填写提示词', '描述你想要的图案，例如「一把生锈的铜剑」')
      return
    }
    setGenerating(true)
    setResult(null)
    setPreviews({})
    setPreviewsReady(false)
    try {
      const output = await mcal.generateImage({
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim() || undefined,
        preset,
        pixelSize,
        count: Math.max(1, Math.min(8, count)),
        outputDir: outputDir || undefined
      })
      setResult(output)
      toast.ok('生成完成', `由 ${output.provider} 生成 ${output.files.length} 张图片`)
    } catch (error) {
      reportError(error, '生成失败')
    } finally {
      setGenerating(false)
    }
  }, [count, negativePrompt, outputDir, pixelSize, preset, prompt])

  const presetInfo = IMAGE_PRESETS.find((item) => item.id === preset)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) 1fr', gap: 16, alignItems: 'start' }}>
      {/* 表单 */}
      <div className="col gap-4">
        {!anyConfigured ? (
          <div
            className="anim-fade"
            style={{
              padding: '11px 13px',
              borderRadius: 'var(--r-md)',
              background: 'rgba(255,157,77,0.1)',
              border: '1px solid rgba(255,157,77,0.28)'
            }}
          >
            <div className="row-start gap-2">
              <IconAlert size={15} className="warn" style={{ marginTop: 2 }} />
              <div className="col gap-1">
                <span className="fs-sm">还没有配置生图服务，无法生成图片。</span>
                <span className="fs-xs muted">支持 OpenAI 兼容接口 / 智谱 CogView / 硅基流动 / 本地 SD WebUI。</span>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => navigate('settings', { tab: 'image' })}>
                去设置生图模型
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mcal-card" style={{ padding: 18 }}>
          <div className="col gap-4">
            <Field label="提示词" required hint="用中文或英文描述都行；预设会自动叠加 MC 风格引导词">
              <Textarea
                value={prompt}
                onChange={setPrompt}
                rows={3}
                placeholder="例如：一把生锈的铜剑，像素风物品图标"
              />
            </Field>

            <Field label="负向提示词" hint="不希望出现的元素，可留空">
              <Input value={negativePrompt} onChange={setNegativePrompt} placeholder="例如：文字, 水印, 3D 渲染" />
            </Field>

            <div className="col gap-2">
              <span className="mcal-field__label">风格预设</span>
              <div className="row gap-2 wrap">
                {IMAGE_PRESETS.map((item) => (
                  <Chip key={item.id} active={preset === item.id} onClick={() => setPreset(item.id)} title={`${item.note}；适用：${item.usage}`}>
                    {item.name}
                  </Chip>
                ))}
              </div>
              {presetInfo ? (
                <div className="fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
                  {presetInfo.note} · 适用：{presetInfo.usage}
                </div>
              ) : null}
            </div>

            <div className="col gap-2">
              <span className="mcal-field__label">像素尺寸</span>
              <div className="row gap-2 wrap">
                {PIXEL_SIZES.map((size) => (
                  <Chip key={size} active={pixelSize === size} onClick={() => setPixelSize(size)}>
                    {size}×{size}
                  </Chip>
                ))}
              </div>
              <div className="fs-xs muted">MC 物品 / 方块用 16；GUI 用 256（由预设决定最终尺寸，这里是对齐参考）</div>
            </div>

            <Field label="生成数量" hint="1 ~ 8 张">
              <Input
                value={String(count)}
                onChange={(value) => {
                  const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10)
                  setCount(Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : 1)
                }}
                type="number"
              />
            </Field>

            <Field label="输出目录" hint="留空则由启动器决定（数据目录下的 media 目录）">
              <div className="row gap-2">
                <Input value={outputDir} onChange={setOutputDir} placeholder="默认位置" monospace />
                <Button icon={<IconFolder size={14} />} onClick={() => void pickOutputDir()}>
                  选择
                </Button>
              </div>
            </Field>

            <Button variant="primary" loading={generating} icon={<IconImage size={14} />} onClick={() => void generate()}>
              生成贴图
            </Button>
            {generating ? <Progress indeterminate tone="info" /> : null}
          </div>
        </div>
      </div>

      {/* 结果 */}
      <div className="col gap-4">
        <div className="mcal-card" style={{ padding: 16 }}>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <span className="fs-sm bold">生图服务</span>
            <div className="row gap-2">
              <Badge tone={anyConfigured ? 'ok' : 'warn'}>{anyConfigured ? '已配置' : '未配置'}</Badge>
              <Button size="sm" variant="ghost" icon={<IconRefresh size={12} />} onClick={() => void loadProviders()}>
                刷新
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate('settings', { tab: 'image' })}>
                去设置
              </Button>
            </div>
          </div>
          <div className="col gap-2 stagger">
            {providers.map((provider) => (
              <div key={provider.id} className="row-between gap-3">
                <div className="col" style={{ minWidth: 0 }}>
                  <span className="fs-sm truncate">{provider.name}</span>
                  <span className="fs-xs faint truncate">
                    {provider.models.length > 0 ? provider.models.join(' / ') : '未配置模型'}
                  </span>
                </div>
                <div className="row gap-2">
                  {provider.id === activeProvider?.id ? <Badge tone="info">当前使用</Badge> : null}
                  <Badge tone={provider.configured ? 'ok' : 'warn'}>{provider.configured ? '可用' : '缺 API Key'}</Badge>
                </div>
              </div>
            ))}
            {providers.length === 0 ? <div className="fs-xs muted">读取中…（若长时间为空，请到设置页检查生图配置）</div> : null}
          </div>
        </div>

        {result ? (
          <div className="mcal-card anim-rise" style={{ padding: 16 }}>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <div className="row gap-2">
                <span className="fs-sm bold">生成结果</span>
                <Badge tone="ok">{result.files.length} 张</Badge>
                <Badge tone="violet">{result.provider}</Badge>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
              {result.files.map((file) => {
                const preview = previews[file]
                const unavailable = previewsReady && !preview
                return (
                  <div key={file} className="col gap-2">
                    <div
                      className="mcal-panel center"
                      style={{
                        height: 140,
                        overflow: 'hidden',
                        backgroundImage:
                          'linear-gradient(45deg, rgba(255,255,255,0.05) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.05) 75%), linear-gradient(45deg, rgba(255,255,255,0.05) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.05) 75%)',
                        backgroundSize: '16px 16px',
                        backgroundPosition: '0 0, 8px 8px'
                      }}
                    >
                      {unavailable ? (
                        <span className="fs-xs muted" style={{ padding: 8, textAlign: 'center' }}>
                          预览不可用，文件已保存到磁盘
                        </span>
                      ) : preview ? (
                        <img
                          src={preview}
                          alt={file}
                          style={{ maxHeight: 140, imageRendering: 'pixelated' }}
                        />
                      ) : (
                        <span className="fs-xs faint">读取预览…</span>
                      )}
                    </div>
                    <span className="fs-xs faint break-all" title={file}>
                      {file.split(/[\\/]/).pop()}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconFolder size={12} />}
                      onClick={() => void mcal.revealPath(file).catch((error: unknown) => reportError(error, '打开失败'))}
                    >
                      打开所在文件夹
                    </Button>
                  </div>
                )
              })}
            </div>
            <div className="fs-xs muted" style={{ marginTop: 10 }}>
              提示：物品图标已自动去背并缩放；方块贴图保持满幅。生成的文件可以直接放进资源包目录使用。
            </div>
          </div>
        ) : (
          <div className="mcal-card" style={{ padding: 6 }}>
            <Empty
              icon={<IconImage />}
              title="还没有生成结果"
              description="左侧填好提示词、选一个风格预设，点「生成贴图」。物品图标建议用 16×16 + 自动去背；方块用「方块贴图」预设。"
            />
          </div>
        )}

        <div className="mcal-card" style={{ padding: 16 }}>
          <div className="row gap-2" style={{ marginBottom: 8 }}>
            <IconInfo size={14} className="accent" />
            <span className="fs-sm bold">使用小贴士</span>
          </div>
          <div className="col gap-2 fs-xs muted" style={{ lineHeight: 'var(--lh-relaxed)' }}>
            <span>· 物品图标：提示词里写明用途和材质，例如「铜制齿轮，像素风物品图标」，效果比抽象描述好。</span>
            <span>· 方块贴图必须整格铺满，所以不做去背；避免在提示词里写「阴影 / 透视 / 3D」。</span>
            <span>· 生成后用「打开所在文件夹」复制到 mod 的 assets/&lt;modid&gt;/textures/item 目录即可。</span>
            <span>· 本地 SD WebUI 不需要 API Key，但生成速度取决于你的显卡。</span>
          </div>
        </div>
      </div>
    </div>
  )
}
