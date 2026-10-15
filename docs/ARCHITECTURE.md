# MCAL 架构说明

这份文档讲**为什么这样分层**以及**扩展时改哪里**。功能清单见 [README](../README.md)。

---

## 1. 总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                          renderer (React 19)                          │
│  views/ × 12   components/ui   state/ (zustand)   lib/api.ts          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ window.mcal（contextBridge 白名单）
┌───────────────────────────────▼──────────────────────────────────────┐
│                         preload/index.ts                             │
│              ipcRenderer.invoke 包装 + 事件订阅（不改语义）             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ ipcMain.handle（101 个通道）
┌───────────────────────────────▼──────────────────────────────────────┐
│                          main（Electron 主进程）                       │
│  index.ts 引导 ── container.ts 组装 ── ipc.ts 路由                     │
│                     ├── launcher-api.ts（对人：界面调用的门面）          │
│                     ├── tasks.ts（后台任务 + 进度广播）                 │
│                     └── permissions.ts（Agent 授权往返）               │
└──────┬───────────────────────────────────┬───────────────────────────┘
       │                                   │
┌──────▼──────────────┐          ┌─────────▼──────────────────────────┐
│  core/*  MC 引擎      │          │  agent/harness  智能体运行时        │
│  mojang launch java  │◄─────────┤  tools/ ──► 直接调用 core 引擎      │
│  loaders content …   │          │  memory/ context/ skills/ provider │
└──────┬───────────────┘          └─────────┬──────────────────────────┘
       │                                    │
┌──────▼──────────────┐          ┌──────────▼─────────────────────────┐
│ net/  下载/镜像/HTTP  │          │ knowledge/  BM25 知识库检索         │
└─────────────────────┘          └────────────────────────────────────┘
```

**核心不变量**

1. `core/**`、`agent/**`、`knowledge/**` 不 import `electron` —— 它们能在纯 Node 下被 vitest 直接调用。
2. 界面点按钮和 Agent 调工具，**落到同一个引擎方法**。两者不可能行为不一致。
3. 所有跨进程数据形状都在 `src/shared/types.ts` 里定义一次，主进程与渲染进程共用。

---

## 2. 进程与接口边界

### shared/types.ts —— 唯一契约来源

一个文件承载四类信息：

- **领域类型**：`Instance`、`LaunchRequest`、`ContentFile`、`DiagnosticReport`、`MemoryRecord` …
- **IPC 通道常量**：`IPC` 对象，97 条通道（95 条请求/响应 + 2 条主→渲染事件）
- **服务接口**：`LauncherServiceApi`、`KnowledgeServiceApi`、`DevServiceApi`、`MediaServiceApi` —— Agent 工具依赖这些接口而不是具体类，因此可以在测试里塞假实现
- **`McalApi`**：`window.mcal` 的类型

### 新增一个跨进程能力的四处改动

```ts
// 1. shared/types.ts —— 通道 + 接口
IPC.fooBar: 'foo:bar'
McalApi.foo.bar(): Promise<FooResult>

// 2. main/ipc.ts —— 处理器（薄，只做参数整形与委托）
handle(IPC.fooBar, (opts: FooOpts) => api.fooBar(opts))

// 3. preload/index.ts —— 桥接
foo: { bar: (opts) => invoke(IPC.fooBar, opts) }

// 4. renderer/src/lib/api.ts —— 前端封装（这里做类型收窄/转换）
fooBar: (opts: FooOpts) => api().foo.bar(opts) as Promise<FooResult>
```

`ipc.ts` 里的 `handle()` 包装器统一捕获异常、写日志、把错误消息原样抛回渲染进程 —— 所以前端 `catch` 到的 `error.message` 就是真实原因。

### 事件（主 → 渲染）

三路单向广播，都通过 preload 的 `onEvent` 风格订阅，返回取消订阅函数：

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `agent:event` | `{ sessionId, event }` | Agent 流式输出、工具调用、授权请求 |
| `task:event` | `TaskState` | 下载/安装进度 |
| 窗口控制 | — | 最小化/最大化/关闭（`window:*` 通道） |

---

## 3. core —— MC 引擎

按职责分 13 个目录，依赖方向严格向下：`util` ← `net` ← `mojang/launch/java/...`。

### util/

- `logger.ts` —— 带作用域的日志，同时写文件、留 3000 条内存环形缓冲、支持监听器（托盘/日志面板订阅）
- `misc.ts` —— 哈希、格式化、`withRetry`、`mapConcurrent`、`KeyedLock`（避免同一实例并发安装）、`parseJavaMajor`、Maven 坐标解析
- `fsx.ts` —— **所有文件操作的唯一入口**：原子写（临时文件 + rename）、`decodeText`（UTF-8 优先、GB18030 回退、BOM 识别 —— 中文整合包的 TOML/日志经常是 GBK）、`walkFiles`、`assertInsideRoots`（路径沙箱）、`readTailLines`（大日志只读尾部）

### net/

- `mirror.ts` —— `MirrorResolver.resolve(url, scope)` 把官方 URL 映射到 BMCLAPI。**注意**：某些 CDN 路径（如 `piston-data` 的 client.jar）无法从 URL 反推版本号，映射不出来时返回原 URL，由下载器的多地址回退兜底；需要版本号时显式调用 `bmclapiClientJar(versionId)` 拿备选地址。
- `http.ts` —— `HttpClient`：重试（指数退避 + 抖动）、超时、限速、`Range` 断点续传、`downloadWithFallback`（多 URL 依次尝试）
- `downloader.ts` —— `DownloadManager`：并发队列、按 sha1 跳过已完成、进度聚合（文件数 + 字节数 + 速度 + ETA）、失败收集与重试

### mojang/

`manifest`（版本清单，带缓存）→ `version`（版本 JSON 的 `inheritsFrom` 合并、旧版 `arguments` 转换）→ `rules`（`os`/`features` 规则求值）→ `library`（库解析、native classifier 选择、去重）→ `assets`（资源索引、virtual/map_to_resources 两种布局）→ `install`（编排下载 + 校验）。

一个刻意的实现细节：`dedupeLibraries` 的 key 里包含 `natives` 变体，因为 1.19+ 起同一个库在不同平台会有不同的 native 条目，只按 group:artifact 去重会丢文件。

### launch/

`args`（占位符替换 + **`${...}` 未定义时连同所属 flag 一起丢弃**，否则会出现 `--width ${resolution_width}` 这种把字面量喂给 JVM 的 bug）→ `natives`（按规则解压到实例目录）→ `classpath`（顺序敏感：客户端 jar 在前，库按版本 JSON 顺序）→ `process`（`GameProcess`：包装 child_process，处理 Windows 进程树终止）→ `logparse`（逐行识别阶段：启动中/加载中/进入主菜单/崩溃）→ `launcher`（串联全部）

### java/

`requirement`（从版本 JSON 推导所需 Java 大版本，含加载器与模组元数据的额外要求）→ `detect`（扫描注册表、常见安装目录、`JAVA_HOME`、PATH、启动器托管目录，用 `-XshowSettings:properties` 取准确信息，结果缓存）→ `install`（Mojang 官方运行时清单 + Adoptium 备选；Mojang 的 tar.gz 用手写解析器解开，避免引入原生依赖）

### loaders/

三种安装策略：

- **Fabric / Quilt**：直接拉 loader meta JSON 生成版本 JSON，不需要执行任何安装器
- **Forge / NeoForge**：下载 installer jar，`java -jar installer.jar --installClient` 无头执行；前置条件 `launcher_profiles.json` 缺失时自动生成；执行失败则退回"解压 installer → 提取版本 JSON → 手动补库"的手动路径
- **OptiFine**：用 `optifine.Patcher <原版jar> <installer.jar> <输出>` 打补丁，再生成 launchwrapper 版本 JSON

`installer-jar.ts` 提供 `runInstallerJar` / `readInstallProfile` / `extractEmbeddedVersionJson`，`version-id.ts` 负责规范化版本命名（避免 `1.20.1-forge-47.2.0` 与 `forge-47.2.0-1.20.1` 这类重复）。

### content/ 与 platform/

`metadata.ts` 内含**手写的 TOML 子集解析器与 NBT 读取器**（模组元数据用），以及 `pack.mcmeta` 的 `pack_format` ↔ 游戏版本对照表。`manager.ts` 做目录扫描与分类，`platform/modrinth.ts` 封装 Modrinth API（搜索、版本、依赖图）。

### diagnose/

`rules.ts` 37 条规则，每条形如：匹配模式（正则/多行特征）→ 证据抽取 → 严重级别 → 关联知识库 ID → 处置建议。`engine.ts` 收集输入（崩溃报告、latest.log、实例信息、Java 信息、模组列表），跑规则、按置信度排序、组装 `DiagnosticReport`。报告结构可以直接喂给 `MemoryStore.recordDiagnosis`。

### modpack/

`inspect`（识别格式并列出内容与预估体积）→ `install`（装加载器、下依赖、解包 overrides）→ `export`（按目标格式生成清单）。支持 Modrinth `.mrpack`、CurseForge、MMC、HMCL、MCAL 自有格式。

### server/

`cores.ts` 是开服包提供者注册表（原版 / Paper / Purpur / Fabric / Quilt / Forge / NeoForge / 混合端…），负责查版本构建、拼下载地址、给出启动注意事项。`manager.ts` 管进程：启动前准备（EULA、`server.properties` 默认值、内存、Aikar 参数）、新 Forge 用 `@args.txt` 启动、日志解析（就绪判定、玩家进出）、优雅停止与强制终止、`listRunning()` 提供真实进程状态。

### dev/ 与 media/

`templates.ts` + `scaffold.ts`：8 套模板以文件树形式存在 `resources/templates/`，脚手架做变量替换与落盘，并返回 `nextSteps`。`builder.ts` 调 Gradle。

`media/imaging.ts` 是**手写的 PNG 编解码 + 像素处理**：中位切分量化（把 AI 输出的渐变图压成有限色板）、最近邻缩放、边缘去背、调色板对齐。`providers.ts` 是 5 个生图后端，`service.ts` 编排"生成 → 后处理 → 落盘"。全部零原生依赖。

---

## 4. knowledge —— 知识库

`resources/knowledge/<category>/*.md`，每篇带 frontmatter（标题、分类、标签、适用版本）。共 57 篇，11 个分类。

检索实现（`src/knowledge/index.ts`）：

1. `tokenizeForSearch` —— 中文按 bigram/trigram 切分 + 英文词干化 + 保留错误码原样（如 `EXCEPTION_ACCESS_VIOLATION`）
2. BM25 打分，标题与标签加权
3. 同义词表（93 组）扩展查询，例如 `闪退/崩溃/报错/卡死` 互相召回
4. `extractExactKeys` 抽出的错误码直接做高权重提升

`userRoots` 允许用户在 `user-resources/knowledge/` 放自己的文章，与内置文章一起索引 —— 用户积累了经验不用改代码。

---

## 5. agent —— 智能体运行时

> 本层的整体骨架（主循环 / 工具注册与权限门控 / 会话级授权记忆 / todo 与技能系统）参照
> **DeepSeek 开源的 agent harness** 设计思路实现，代码全部在本仓库内、不依赖原项目运行时；
> 差异与完整致谢见 README「开源致谢」一节。

### harness.ts：主循环

```
send(text)
  └─ 入队 → runTurnLoop
       ├─ 压缩检查（needsCompaction → compactConversation）
       ├─ streamAssistant（SSE 流式 → AgentEvent）
       ├─ 无 tool_calls？→ 结束本轮
       └─ executeToolCalls
            ├─ 只读工具：并行，最多 4 并发
            ├─ 写工具：串行（避免竞态）
            ├─ 每个调用前 resolvePermission → 需要则发授权请求并等待响应
            ├─ 结果按长度截断（超长输出给摘要 + 提示用 read_file 分段看）
            └─ 回填 → 下一轮（默认上限 25 轮）
```

关键设计：

- **授权是挂起的 Promise**。`respondPermission` 从 `pendingPermissions` 里取出 resolver 兑现，`abort` 时全部拒绝。渲染进程关掉窗口不会留下挂死的循环。
- **只读并行、写入串行**，因为 Agent 常一次读十几个文件，但写操作必须有序。
- **中止可恢复**：`abort` 中断流与工具，但已产生的消息保留在会话里。

### tools/registry.ts：权限模型

每个工具声明 `dangerous?: boolean`（能否在 auto-safe 模式下自动放行），并可选提供 `permissionFor(args)` 按参数动态给出授权规格（例如写文件时路径落在工作区内就算低风险）。`resolvePermission(name, args, mode, access)` 结合全局模式（`readonly` / `auto-safe` / `auto-all` / `ask`）与参数推导出 `allow` / `ask` / `deny`：只读工具永远放行，`readonly` 模式下非只读工具一律拒绝，`auto-safe` 放行非 dangerous 工具，其余弹授权。

`access` 是第二层门控（访问权限）：`mode: 'workspace' | 'full'` 决定路径沙箱（工具参数里的路径落在允许根之外、或工具声明 `escapesWorkspace` 时，工作区模式下直接 deny 并给出改设置的位置），`confirmSensitive: true` 时对越界写入与 `dangerous` 工具强制升级为 `ask`（风险等级 high），授权结果按工具名在会话内记忆 `grantRememberMs` 毫秒。两层是「权限模式决定要不要问、访问权限决定能不能做」，互不替代。

`ToolResult.meta` 类型是 `unknown` —— 工具可以挂任意结构化结果（`LoaderInstallResult`、`DiagnosticReport`…），harness 用 `asMetaRecord()` 安全降级，避免为了索引签名到处加 `[key: string]: unknown`。

### tools/*.ts：48 个工具

- `fs.ts`（8）——路径全部过 `assertInsideRoots`
- `mc.ts`（25）——**不直接碰引擎，只调 `LauncherServiceApi` 等方法**。这带来两个好处：工具与界面行为必然一致；测试里可以注入假服务
- `dev.ts`（6）、`meta.ts`（8，含 todo / skill / knowledge / memory）、`shell.ts`（1）

### memory/store.ts

JSON 文件存储。`write()` 时先做相似度检查，≥ 75% 就合并（保留更新的方案并追加命中记录），避免同一个问题攒十条。`search()` 的打分 = 文本相似度 + 上下文匹配（同实例/同版本/同加载器加分）+ 验证过的记录加权 + 时间衰减。`recordDiagnosis()` 把 `DiagnosticReport` 直接转成记忆，是"自动积累经验"的入口。

### context/compaction.ts

`estimateTokens` 按字符类型估算（CJK ≈ 0.7 token/字，ASCII ≈ 1/4 词），比调 tokenizer 快且够用。压缩优先让模型自己总结（给定"保留结论、丢弃过程"的指令），失败则退回 `summarizeHeuristically`。

### skills/

`resources/skills/<name>/SKILL.md`，frontmatter 声明名称、描述、触发条件。系统提示里只放**索引**（名称 + 一句话），Agent 判断需要时调 `skill_read` 展开全文 —— 这就是渐进式披露：知识库不占常驻上下文。

### prompt.ts

系统提示分五段：身份、环境（OS/架构/游戏目录/实例/Java）、能力（工具与技能的边界说明）、约定（Java 版本矩阵、加载器规则、日志位置、诊断顺序）、工作流（先复现再动手、改前先读、结论要带证据）。环境段与记忆段是动态注入的，`buildPromptContext()` 在容器里组装。

---

## 6. main —— 编排层

- **container.ts**：`ServiceContainer` 把约 25 个引擎实例化并互相接线，是唯一的"知道所有东西"的地方。它同时负责：
  - `applySettings()` —— 设置变更后把新配置推给相关引擎（镜像、下载并发、Agent provider）
  - `agentRoots()` —— 计算 Agent 的文件访问白名单根
  - `createAgentServices()` —— 实现 `AgentServices` 接口给工具用
  - `emitAgentEvent` / `requestAgentPermission` 是**可覆盖字段**，`index.ts` 在窗口创建后把它们指向 webContents。这样避免了 container → window 的循环依赖。
- **launcher-api.ts**：46 个方法，实现界面需要的所有操作。要求进度/可取消的长任务（装版本、装加载器、下内容、导整合包、装 Java）都创建 `TaskState` 并通过 `tasks.progress` 广播，同时把 `AbortSignal` 注册进 `registerCancel`。
- **tasks.ts**：任务生命周期 + 事件订阅。`TaskState` 含进度（文件数/字节/速度/ETA）、日志尾巴、结果或错误。
- **ipc.ts**：90 个处理器，每个都是一行委托。需要弹原生对话框的通道（选目录/选文件/保存）在这里处理，并把用户取消表达成 `null` 而不是抛错。
- **permissions.ts**：独立的 pending map，单独一个模块是为了打断 `container ↔ ipc` 的导入环。

---

## 7. renderer —— 界面

### 样式体系

`styles/tokens.css` 定义三层令牌：调色板（Obsidian / Verdant / Ember 三套，切 `[data-theme]`）→ 语义令牌（`--bg`、`--fg`、`--accent`…）→ 组件尺寸节奏。`global.css` 是类系统：`.mcal-card`、`.mcal-btn`（多 variant/size）、`.mcal-input`、`.mcal-badge`、`.mcal-modal`、`.markdown`、`.log-view` 等，外加 `.aurora-bg`（三团缓慢漂移的极光）与一套关键帧。

动效分三级 `[data-motion="full|reduced|off"]` —— 低配机器或不喜欢动画的用户可以关掉而不损失任何功能。

### 为什么全部手写

启动器要同时放日志流、贴图预览、对话气泡、进度条，组件库的默认样式改造量比自写还大。图标同理：`icons.tsx` 39 个内联 SVG（含自绘标题栏的最小化/最大化/还原/关闭），没有图标字体或 SVG 精灵图的加载开销。Markdown 渲染器（对话用）也是自己写的，因为需要控制代码块、表格与中文排版。

### 窗口与标题栏

Windows / Linux 下主窗口是**无边框**的（`frame: false`，见 `main/index.ts`），系统不提供最小化/最大化/关闭按钮，由 `components/layout/TitleBar.tsx` 自绘：整条是 `-webkit-app-region: drag` 拖拽区（CSS 类 `.mcal-titlebar`），右侧三个按钮必须带 `no-drag`，否则点击会被当成拖拽窗口。按钮走 `window:minimize|maximize|close`（fire-and-forget 的 `ipcMain.on`，最大化在按钮里 toggle 成还原）；图标与窗口状态同步靠 `window:is-maximized` 查询 + 主进程推送的 `window:maximized-changed`（双击拖拽区、拖到屏幕边缘吸附这些系统手势不经过我们 IPC，只能靠事件）。macOS 保留系统红绿灯（`titleBarStyle: 'hiddenInset'`），标题栏只留拖拽区并给左侧留 74px 安全间距。

> 往标题栏里加东西时注意：整条是拖拽区，任何可点元素都要加 `.mcal-titlebar__btn`（或自行 `no-drag`），否则点击会被当成拖拽窗口。标题栏是布局里独立的一行（内容区在它下面），不会遮挡页面元素。

### 状态

`state/store.ts` 用 zustand 分了几个独立 store：`useToasts`（通知）、`useSettings`（设置 + 主题应用）、`useInstances`（实例/服务端/Java 列表，跨页面共享并去重请求）、`useTasks`（订阅 task:event）、`useSystem`、`useView`（`ViewId` 联合类型 + `navigate(view, params)`，`params` 用于跨页跳转带提示词，例如主页"让 AI 帮你"→ Agent 页并预填问题）。

### 视图

12 个视图在 `views/`，路由是 `App.tsx` 里的 `ViewSwitch`（不引路由库 —— 桌面应用不需要 URL）。每个视图负责自己的数据加载与空状态，空状态给出**下一步动作**而不是干说"暂无数据"（比如内容管理页在无实例时直接引导创建实例）。

Agent 页是唯一有复杂实时逻辑的视图：消费 `agent:event` 流式增量、渲染工具调用卡片（可折叠看参数与结果）、授权弹窗、上下文占用条、会话列表。

---

## 8. 安全边界

| 面 | 措施 |
| --- | --- |
| 渲染进程 | `contextIsolation: true`、`nodeIntegration: false`、CSP 限制为 `self` + `data:`/`blob:` 图片；本地图片经主进程转 data URL，不放宽 `file:` |
| Agent 文件访问 | `assertInsideRoots` 白名单（实例目录、游戏目录、用户资源目录、显式添加的项目目录） |
| Agent 命令 | 高风险正则（`rm -rf`、`format`、`reg delete`、管道下载执行…）→ 强制授权 |
| 授权 | 每次授权可"仅此一次"或"本次会话记住"，dangerous 级别不允许永久放行 |
| 下载 | 官方 sha1 校验，失败文件不入库；镜像不可信时也只是走官方源 |
| 路径 | 文件名过 `sanitizeFileName`，防止整合包里的 `../` 逃逸 |

---

## 9. 测试策略

`test/` 下 10 个文件 395 项测试，全部离线、不下载、不启动游戏：

| 文件 | 覆盖 |
| --- | --- |
| `mojang.test.ts` | 版本 JSON 合并、规则求值、库/资源解析、安装编排（mock 下载器） |
| `launch.test.ts` | 参数占位符、natives 选择、classpath 顺序、日志阶段判定 |
| `loaders.test.ts` | 5 个加载器的元数据解析、版本命名规范化、installer jar profile 读取 |
| `content.test.ts` | TOML/NBT/pack.mcmeta 解析、分类、依赖与冲突判定 |
| `diagnose.test.ts` | 37 条规则各自的命中与不命中、报告组装 |
| `modpack.test.ts` | 5 种格式识别、导入计划、导出产物结构 |
| `server.test.ts` | 开服包地址拼接、属性解析、启动参数 |
| `dev.test.ts` | 8 套模板渲染出合法 JSON、脚手架落盘 |
| `media.test.ts` | PNG 编解码往返、量化、去背、缩放 |
| `knowledge-smoke.test.ts` | 知识库加载、检索召回、同义词、错误码提升 |

写测试时的两个约定：引擎通过构造参数注入 `HttpClient` / `DownloadManager`，测试里塞假实现即可；`core` 不 import electron 这条规则由 `tsconfig.node.json` 的 include 范围 + 分层约定共同保证。

---

## 10. 扩展点

| 想加什么 | 改哪里 |
| --- | --- |
| 新的模组加载器 | `core/loaders/` 加实现 + `LoaderManager` 注册 + `LoaderType` 类型 |
| 新的开服核心 | `core/server/cores.ts` 注册提供者（查版本、拼地址、注意事项） |
| 新的诊断规则 | `core/diagnose/rules.ts` 追加规则对象（含知识库关联 ID） |
| 新的知识文章 | 往 `resources/knowledge/<cat>/` 丢 md，或在 `user-resources/knowledge/` 放用户文章 |
| 新的 Agent 工具 | `agent/tools/*.ts` 定义 + 在 `buildToolRegistry` 注册，声明权限级别 |
| 新的技能手册 | `resources/skills/<name>/SKILL.md`，系统提示索引会自动带上 |
| 新的模型/生图后端 | `agent/provider/index.ts` 加预设；`core/media/providers.ts` 加后端 |
| 新的开发模板 | `resources/templates/<id>/` 加目录 + manifest，`TemplateRegistry` 自动发现 |
| 新的界面页面 | `views/` 加组件 + `ViewId` 联合类型 + `App.tsx` 的 `ViewSwitch` + 侧边栏分组 |

新增能力时优先复用已有引擎方法，避免在工具层或 IPC 层写第二份实现 —— 那正是"智能体和界面行为不一致"的起点。
