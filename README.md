# MCAL · Minecraft Agent Launcher

> 面向 AI 时代的 Minecraft 启动器：把 PCL / HMCL 级别的启动器能力，和一个能读写文件、会查知识库、记得住你踩过的坑的 AI 智能体放进同一个 Electron 应用里。

MCAL 不是"启动器 + 一个聊天窗口"。智能体和启动器是同一套引擎的两个入口：Agent 调用的 `mc_diagnose`、`mc_install_loader`、`dev_scaffold_project` 和你在界面上点按钮走的是同一条代码路径，所以它能真的帮你装版本、查崩溃、写模组，而不是只会"给你一段操作步骤"。

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [配置 AI 模型](#配置-ai-模型)
- [界面导览](#界面导览)
- [智能体能力](#智能体能力)
- [项目结构](#项目结构)
- [开发与构建](#开发与构建)
- [设计取舍](#设计取舍)
- [常见问题](#常见问题)

---

## 它能做什么

### 启动器本行

| 能力 | 说明 |
| --- | --- |
| 原版安装 | Mojang 官方清单（含快照/远古版本），按版本 JSON 的规则求值解析库、资源、natives |
| 加载器 | Fabric / Quilt / Forge / NeoForge / OptiFine，Fabric 系走元数据直装，Forge 系调官方 installer（无头模式 + 手动兜底） |
| Java 管理 | 自动探测系统 Java（注册表 / 常见目录 / PATH / 启动器托管目录），按版本需求匹配，可从 Mojang 或 Adoptium 下载安装 |
| 账号 | 离线账号（含正确的 `OfflinePlayer:` UUID 派生）；正版登录接口已预留 |
| 启动 | 完整 JVM / 游戏参数构建、占位符替换、natives 解压、classpath 拼装、日志实时解析与阶段判定 |
| 内存与优化 | 按系统内存推荐堆大小，Aikar 风格 JVM 参数 |
| 下载加速 | BMCLAPI 镜像，多源回退、哈希校验、断点续传、并发控制、限速 |
| 版本校验 | 一键校验库/资源/客户端 jar 的完整性，缺什么补什么 |

### 内容与整合包

- **内容管理**：mods / resourcepacks / shaderpacks / datapacks / 存档的扫描、元数据解析（`fabric.mod.json`、`mods.toml`、`pack.mcmeta`、NBT）、批量启停、依赖检查、性能模组互斥检查
- **Modrinth 集成**：搜索、筛选、版本选择、依赖自动解析安装
- **整合包**：识别 `.mrpack`（Modrinth）、CurseForge manifest、MMC `mmc-pack.json`、HMCL 与 MCAL 自有格式；导入时自动装加载器并下载依赖，导出可指定格式
- **崩溃诊断**：37 条规则覆盖常见崩溃（Mixin 失败、缺依赖、版本不匹配、OOM、驱动问题、HS_ERR 等），从崩溃报告/logs 里抽证据，交叉引用知识库给出处置建议

### 开发者功能

- **服务端**：原版 / Paper / Purpur / Fabric / Quilt / Forge / NeoForge / 混合端等核心的版本查询、下载、安装、启停、`server.properties` 图形化编辑、EULA、控制台
- **开发脚手架**：8 套模板（Fabric / Forge / NeoForge 模组、Paper 插件、资源包、数据包、Iris 光影、MCAL 整合包），填参数生成完整工程；调 Gradle 构建
- **美术资源**：接入生图模型（OpenAI 兼容 / 智谱 CogView / SiliconFlow / 本地 SD WebUI / 自定义），内置"MC 物品图标 / 方块贴图"预设，生成后自动像素化（中位切分量化 + 缩放）与去背，直接产出可用的 16×16 贴图

### 智能体

- 读写文件、执行命令、装版本、装加载器、查崩溃、搜知识库、写代码 —— 48 个工具
- 长期记忆：自动记录"问题 → 原因 → 解决方案"，下次遇到相似问题会主动回忆
- 57 篇离线知识库（BM25 + 中文分词 + 同义词表检索），诊断结果直接挂知识点
- 技能系统：渐进式披露的操作手册（如 `diagnose-crash`），Agent 按需展开步骤
- 危险操作授权：删除文件、改配置、跑命令前弹窗确认，可设白名单

---

## 快速开始

### 环境要求

- Node.js ≥ 20.19
- npm ≥ 10
- Windows / macOS / Linux 桌面环境

### 安装与运行

```bash
npm install          # 依赖（Electron 走 npmmirror 镜像，见 .npmrc）
npm run dev          # 开发模式启动
```

首次启动会引导你设置游戏根目录（默认 `%APPDATA%\.minecraft` 或你指定的位置）与 AI 模型。

### 常用命令

```bash
npm run dev          # 开发（热重载）
npm run build        # 构建到 out/
npm run typecheck    # 主进程 + 渲染进程类型检查
npm test             # 单元测试（vitest，395 项）
npm run icon         # 重新生成应用图标 resources/icon.png
npm run dist         # 打包安装包（Windows: NSIS + 便携版）
npm run pack         # 只打包不解压（调试用）
```

> **注意**：MCAL 自身不会下载任何游戏资源。只有你在界面上主动点击安装版本/加载器/Java 时才会联网下载，且会明确提示体积。

---

## 配置 AI 模型

设置 → AI 模型。内置 8 个预设，选一个填 API Key 即可：

| 预设 | 说明 |
| --- | --- |
| DeepSeek | 默认推荐，中文与工具调用都稳 |
| Moonshot (Kimi) | 长上下文 |
| 智谱 GLM | 国内直连 |
| 通义千问 DashScope | 阿里云 |
| SiliconFlow | 聚合多家开源模型 |
| OpenRouter | 聚合海外模型 |
| Ollama | 本地部署，无需 Key |
| LM Studio | 本地部署，无需 Key |

全部走 OpenAI 兼容协议（`/chat/completions` + SSE 流式 + `tool_calls`），所以任何兼容端点都能用"自定义"接进来。填完点"测试连接"确认可用。

**Token 用量**：每次对话结束会显示本轮 input/output token 与上下文占用比例，接近上限时自动压缩历史（保留结论，丢弃过程）。

---

## 界面导览

左侧导航分四组：

**游戏**
- **主页** —— 实例切换、一键启动、实时日志、上次会话回顾、环境体检（Java 缺失/版本不符、内存过小、近期崩溃报告会直接给出建议）
- **实例** —— 实例的增删改查，每个实例独立配置游戏目录、版本、加载器、内存、JVM 参数、窗口大小
- **版本** —— 已安装版本列表 + 在线版本清单，安装/校验/补全/删除

**内容**
- **内容管理** —— 五类内容的扫描、导入（支持拖拽）、启停、依赖与冲突检查、Modrinth 下载
- **整合包** —— 导入前预览（识别格式、列出模组、预估体积），导入后汇报；也可以把当前实例导出成整合包
- **服务端** —— 开服包下载、安装、启停、控制台、属性编辑

**智能体**
- **AI 助手** —— 对话界面，工具调用过程可见，危险操作弹授权
- **记忆** —— 查看/编辑/删除 Agent 记住的解决方案
- **知识库** —— 浏览 57 篇文章，也能直接给 Agent 指定"参考这篇"

**开发**
- **开发工作台** —— 脚手架生成、项目构建、AI 贴图生成
- **设置** —— 模型、镜像、Java、游戏目录、Agent 权限模式、主题与动效

界面全手写（无 UI 组件库），支持三套配色（Obsidian 暗 / Verdant 绿 / Ember 暖），动效分级（完整 / 精简 / 关闭）照顾低配机器。

---

## 智能体能力

### 工具清单（48 个）

| 分类 | 数量 | 例子 |
| --- | --- | --- |
| 文件系统 | 8 | `read_file`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep`、`delete_path`、`make_dir` |
| Minecraft | 25 | `mc_list_instances`、`mc_install_version`、`mc_install_loader`、`mc_launch`、`mc_diagnose`、`mc_read_log`、`mc_install_project`、`mc_server_control` … |
| 开发与媒体 | 6 | `dev_scaffold_project`、`dev_build_project`、`dev_write_source`、`media_generate_texture` … |
| 元工具 | 8 | `todo_write`、`skill_read`、`knowledge_search`、`memory_write` … |
| 命令 | 1 | `run_command`（高风险命令需授权） |

### 权限模式

设置 → Agent 权限，四档：

- **只读** —— 只能看，不能改
- **自动（安全）** —— 读写项目/实例目录自动放行，删文件、跑命令、动系统目录要确认
- **自动（全部）** —— 除极少数系统路径外全部放行
- **每次询问** —— 任何工具调用都确认

所有文件操作都被限制在设定的工作目录白名单内（`assertInsideRoots`），Agent 没法跑到白名单外乱翻。

### 记忆怎么工作的

1. 你描述问题 → Agent 诊断出结果 → 自动写入一条记忆：`问题 / 原因 / 解决方案 / 涉及版本与加载器 / 标签`
2. 下一次对话开始时，系统按当前实例的版本、加载器、错误关键字检索相关记忆，注入到上下文
3. 相似度 ≥ 75% 的记忆会被合并而不是新增，避免堆积
4. 命中的记忆会累加命中次数，搜索时排序更高；长时间未命中的会按时间衰减

你在"记忆"页面可以随时修正或删掉记错的内容。

---

## 项目结构

```
MinecraftAgentLauncher/
├── src/
│   ├── shared/types.ts        # 所有跨进程契约：领域类型 + IPC 通道 + API 接口
│   ├── core/                  # 与 UI 无关的引擎（可单独测试）
│   │   ├── util/              # 日志、哈希/格式化、文件系统辅助
│   │   ├── net/               # HTTP 客户端、镜像解析、并发下载器
│   │   ├── mojang/            # 版本清单、规则求值、版本 JSON 合并、资源、安装
│   │   ├── launch/            # 参数构建、natives、classpath、日志解析、进程管理
│   │   ├── java/              # Java 需求推导、探测、下载安装
│   │   ├── loaders/           # Fabric / Quilt / Forge / NeoForge / OptiFine
│   │   ├── content/           # 内容扫描与元数据解析（TOML / NBT / pack.mcmeta）
│   │   ├── platform/          # Modrinth 等平台客户端
│   │   ├── diagnose/          # 37 条崩溃诊断规则 + 推理引擎
│   │   ├── modpack/           # 整合包识别、导入、导出
│   │   ├── server/            # 开服包注册表 + 服务端进程管理
│   │   ├── dev/               # 开发模板、脚手架、Gradle 构建
│   │   └── media/             # 生图服务、PNG 编解码与像素处理
│   ├── knowledge/             # 知识库索引与检索（BM25 + 中文分词 + 同义词）
│   ├── agent/                 # AI 智能体运行时
│   │   ├── provider/          # OpenAI 兼容流式提供者 + 8 个预设
│   │   ├── tools/             # 工具注册表与 48 个工具实现
│   │   ├── memory/            # 记忆存储、检索、合并
│   │   ├── context/           # token 估算与上下文压缩
│   │   ├── skills/            # 技能注册表（SKILL.md 渐进式披露）
│   │   ├── prompt.ts          # 系统提示构建
│   │   ├── session.ts         # 会话持久化
│   │   └── harness.ts         # 主循环：压缩 → 流式 → 工具执行 → 循环
│   ├── main/                  # Electron 主进程
│   │   ├── container.ts       # 服务容器：组装所有引擎
│   │   ├── launcher-api.ts    # 启动器服务门面
│   │   ├── ipc.ts             # 95 个 IPC 处理器 + 窗口控制
│   │   ├── tasks.ts           # 后台任务与进度广播
│   │   └── index.ts           # 引导与生命周期
│   ├── preload/               # contextBridge 暴露 window.mcal
│   └── renderer/              # React 19 界面（全手写，无 UI 库）
│       ├── styles/            # 设计令牌 + 全局样式与动画
│       ├── components/ui/     # 图标、基础组件、Markdown 渲染器
│       ├── components/layout/ # 应用外壳、侧边栏、状态条、Toast
│       ├── state/             # zustand 状态
│       └── views/             # 12 个页面
├── resources/
│   ├── knowledge/             # 57 篇离线知识库文章（11 个分类）
│   ├── skills/                # 技能手册（SKILL.md）
│   ├── templates/             # 8 套开发脚手架模板
│   └── icon.png               # 应用图标（由 npm run icon 生成）
├── scripts/gen-icon.mjs       # 手写 PNG 编码的图标生成器
├── test/                      # vitest 单元测试
└── reference/                 # PCL2 / HMCL 源码，仅作算法参考（见下方说明）
```

更详细的模块划分、数据流与扩展点见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 开发与构建

### 分层规则

```
renderer  →  preload(window.mcal)  →  main(ipc.ts)  →  launcher-api / container  →  core/*
                                                                            ↑
                                                             agent/harness → agent/tools
```

- `src/core/**`、`src/agent/**`、`src/knowledge/**` **不允许** import `electron`
  （唯一例外：`main/index.ts` 的窗口图标等纯环境判断）。这样它们能在 vitest 里直接跑。
- 渲染进程不直接碰 Node API，一切经过 `window.mcal`。
- 新增跨进程能力要改四个地方：`shared/types.ts`（类型 + 通道）→ `main/ipc.ts`（处理器）→ `preload/index.ts`（桥接）→ `renderer/src/lib/api.ts`（前端封装）。

### 测试

```bash
npm test                 # 全部
npx vitest run test/mojang.test.ts   # 单个文件
```

测试全部是纯逻辑测试（不联网、不下载）：版本 JSON 合并、规则求值、参数占位符、natives 选择、classpath、TOML/NBT 解析、诊断规则、整合包识别、模板渲染、PNG 编解码、记忆检索、工具权限判定等。

### 打包

```bash
npm run dist        # 当前平台
npm run dist:win    # Windows（NSIS 安装包 + 便携版）
```

产物在 `release/`。图标由 `npm run icon` 生成（脚本手写 PNG 编码，不依赖图形库）。

---

## 设计取舍

**为什么不用 UI 组件库？**
启动器要长时间停留在屏幕上，还要承载日志、贴图预览、对话流这些非标准控件。手写一套 CSS 令牌 + 类系统反而更快、更统一，也省掉了把第三方主题改造成自己风格的成本。图标同理，全部内联 SVG。

**为什么自己写 BM25 而不是上向量库？**
知识库只有 57 篇、总计几百 KB，BM25 配上中文 n-gram 分词和同义词表（93 组，如 "闪退/崩溃/报错/卡死"）已经足够准，还能完全离线、零依赖、毫秒级返回。向量检索要引入模型和几百 MB 的权重，不值。

**为什么工具跑在主进程？**
Agent 要操作的是 `%APPDATA%\.minecraft`、实例目录、Java 安装目录这些真实路径，而且要和界面上点按钮走同一套引擎。放主进程可以直接复用 `core/*`，配合路径白名单保证安全边界。

**关于 `reference/`**
`reference/PCL2`、`reference/HMCL` 是下载下来作参考的上游源码（HMCL 为 GPL-3.0）。MCAL 只从中学算法与事实（例如镜像端点、安装器调用方式、参数细节、日志特征），**不复制其代码**；`src/` 下的实现全部独立编写。若要对照阅读，请注意两者的许可证差异。

---

## 常见问题

**启动游戏提示找不到 Java？**
主页的"环境体检"会直接告诉你当前实例需要哪个大版本、本机有哪些。去"Java"页面下载对应版本，或在设置里手动指定 `java.exe` 路径。

**下载很慢或失败？**
设置 → 下载 → 镜像源切到 BMCLAPI。下载器本身也有多源回退，单文件失败会重试而不是整体中断。

**Forge 安装失败？**
Forge 官方安装器需要 `launcher_profiles.json` 存在（原版启动器会创建）。MCAL 会尝试自动生成；如果安装器仍报错，可以在"版本"页面用"手动模式"：先装好原版，再让 MCAL 用解压方式处理 installer jar 并生成版本 JSON。

**AI 助手说它不能装东西？**
检查设置 → Agent 权限是不是"只读"。另外确认模型支持 function calling —— 纯文本模型只能聊天，工具调用会失败。

**生图出来的贴图不能直接用？**
用"MC 物品图标"或"方块贴图"预设，它们会自动做像素化与去背。生成的文件在开发工作台里可以直接"打开所在文件夹"，丢进资源包的 `assets/<namespace>/textures/` 即可。

**Agent 记错了我的问题怎么办？**
"记忆"页面可以编辑或删除任意一条；也可以直接在对话里说"这条记忆是错的"，它会用 `memory_write` 修正。

---

## 许可证

MIT（项目自身代码）。`reference/` 下的第三方源码遵循其各自许可证（HMCL 为 GPL-3.0）。
