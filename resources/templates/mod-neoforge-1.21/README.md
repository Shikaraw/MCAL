# {{modName}}（NeoForge / MC 1.21）

由 MCAL 项目脚手架生成的 NeoForge 模组工程（Java 21）。

- 模组 id：`{{modid}}`
- 主类：`{{package}}.{{ModClassName}}`
- 目标环境：Minecraft 1.21，Java 21
- 协议：{{license}}

## 目录结构

```
.
├─ build.gradle                 # net.neoforged.gradle.userdev 构建脚本
├─ gradle.properties            # neo_version / 插件版本集中在这里
├─ settings.gradle              # NeoForged 插件仓库
├─ gradle/wrapper/              # 仅 properties，无二进制 jar
└─ src/main
   ├─ java/{{packagePath}}/{{ModClassName}}.java  # @Mod 主类
   └─ resources
      ├─ META-INF/neoforge.mods.toml   # 元数据 + type="required" 依赖
      ├─ pack.mcmeta                   # 1.21 资源包格式为 34
      └─ assets/{{modid}}/lang/{en_us,zh_cn}.json
```

## 环境准备

| 项目 | 要求 |
| --- | --- |
| JDK | **21**（MC 1.21 要求；1.20.5+ 全部转 21） |
| Gradle | 8.x |
| 编辑器 | IntelliJ IDEA |

## 构建

```bash
gradlew.bat build        # Windows
./gradlew build          # macOS / Linux / Git Bash
```

> 无 wrapper 时：先 `gradle wrapper` 生成，或直接用系统 `gradle build`。

产物：`build/libs/{{modid}}-{{modVersion}}.jar`。调试：

```bash
./gradlew runClient / runServer / runData
```

## 安装到游戏

1. 安装 **NeoForge 1.21** 客户端（<https://neoforged.net/> 下载安装器）；
2. 把 jar 丢进 `.minecraft/mods/`；
3. 启动游戏，日志中应出现 `[{{modid}}] 模组构造完成`。

## NeoForge 与 Forge 的关键差异（踩坑重点）

| 项目 | Forge 1.20.1 | NeoForge 1.21 |
| --- | --- | --- |
| 元数据文件 | `META-INF/mods.toml` | `META-INF/neoforge.mods.toml` |
| 依赖必填字段 | `mandatory = true` | `type = "required"` |
| 主类构造参数 | `FMLJavaModLoadingContext` | `IEventBus` + `ModContainer` |
| 事件注解 | `@Mod.EventBusSubscriber(bus = MOD/FORGE)` | `@EventBusSubscriber(bus = MOD/GAME)` |
| DeferredRegister 包 | `net.minecraftforge.registries.*` | `net.neoforged.neoforge.registries.*` |
| 注册表常量 | `ForgeRegistries.ITEMS` | `Registries.ITEM`（`createItems()` 更省事） |
| 资源包格式 | 15（1.20.1） | 34（1.21） |

## 常见坑

1. **`Could not find net.neoforged:neoforge:21.0.x`**
   `neo_version` 或插件版本过期。注意 1.21 与 1.21.1 的 NeoForge 版本不同（21.0.x vs 21.1.x），
   到 <https://projects.neoforged.net/neoforged/neoforge> 核对。
2. **插件解析失败（`net.neoforged.gradle.userdev` not found）**
   `settings.gradle` 里的 `https://maven.neoforged.net/releases` 不能被删；
   若换成 `net.neoforged.moddev` 插件，`plugins {}`、`runs` 写法都要换，别混用。
3. **`neoforge.mods.toml` 解析失败**
   依赖块必须写 `type = "required"`（写成 Forge 的 `mandatory = true` 在 1.21 上语义不对）；
   文件必须叫 `neoforge.mods.toml`，写在 `META-INF/` 下。
4. **Java 版本不匹配（`class file version 65` 之类）**
   构建与运行的 JDK 都必须是 21；IDEA 里 Gradle JVM 与项目 SDK 一起改。
5. **事件不触发**
   NeoForge 只有两条总线：`MOD`（注册、加载期）与 `GAME`（游戏内）；写错 bus 时代码不报错但永不执行。
