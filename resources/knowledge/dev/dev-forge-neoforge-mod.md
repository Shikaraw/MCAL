---
id: dev-forge-neoforge-mod
title: Forge / NeoForge 工程结构与事件总线差异
category: dev
tags: [Forge, NeoForge, 开发, mods.toml, neoforge.mods.toml, 事件总线, EventBusSubscriber, DeferredRegister, MDK, 注册]
summary: Forge 与 NeoForge 模组工程的文件结构、mods.toml 字段，以及两者在事件总线、注册方式与命名空间上的关键差异。
updatedAt: 2026-10-01
---

## 症状

- MDK 工程同步/构建失败，`runClient` 报依赖缺失或类找不到；
- 模组装进游戏不加载，日志报 `Missing or unsupported mandatory dependencies` 或找不到主类；
- 从 Forge 迁移到 NeoForge 时大量 `net.minecraftforge` 包引用报错；
- 事件监听器不触发（不知道注册到哪个总线）。

## 原因

Forge 与 NeoForge 的工程骨架相似（MDK、Gradle、`mods.toml`），但自 1.20.4 起在命名空间与 API 上分道扬镳：

- **元数据**：Forge 用 `src/main/resources/META-INF/mods.toml`；NeoForge 1.21 起改用 `neoforge.mods.toml`，服务端/客户端都会读取。两者都需要 `pack.mcmeta`。
- **事件总线**：Forge 有两套——模组总线（注册物品、加载期事件）与 `MinecraftForge.EVENT_BUS`（游戏内事件），通过 `@Mod.EventBusSubscriber(modid = "...", bus = Mod.EventBusSubscriber.Bus.MOD/FORGE)` 指定；NeoForge 对应 `@EventBusSubscriber(modid = "...", bus = EventBusSubscriber.Bus.MOD/GAME)`，事件类在 `net.neoforged` 命名空间下（`NeoForge.EVENT_BUS`）。
- **模组主类**：Forge 习惯在构造器里 `FMLJavaModLoadingContext.get().getModEventBus()` 拿总线；NeoForge 的主流写法是构造器直接接收 `IEventBus modEventBus`（以及 `ModContainer` 等）参数。
- **注册**：双方都用 `DeferredRegister`，但包路径不同（`net.minecraftforge.registries.DeferredRegister` vs `net.neoforged.neoforge.registries.DeferredRegister`），可选的数据生成（datagen）流程也略有差异。

## 解决方案

1. 下载对应 MDK：Forge 从 files.minecraftforge.net 的 MDK 链接，NeoForge 从 neoforged.net 的 MDK；解压后用 IDEA 打开根目录，确认 `gradle.properties` 中版本字段与目标 MC 一致。
2. `mods.toml`/`neoforge.mods.toml` 必备字段：`modLoader`、`loaderVersion`、`license`，以及 `[[mods]]` 块的 `modId`（全小写、与代码 `@Mod("modid")` 完全一致）、`version`、`displayName`、`authors`；依赖写在 `dependencies.<modId>` 表（TOML 中写作双方括号块）：`modId`、`mandatory`、`versionRange`（如 `[1.20.1,1.21)`）、`ordering`、`side`。
3. 注册内容：在模组总线（MOD）监听 `FMLCommonSetupEvent`（Forge）/`FMLCommonSetupEvent`（NeoForge 同名不同包）做初始化；物品/方块用 `DeferredRegister` 注册，`register(modEventBus)`。
4. 监听游戏事件：`@EventBusSubscriber` 指定游戏总线，或者手动 `NeoForge.EVENT_BUS.register(this)` / `MinecraftForge.EVENT_BUS.register(this)`；构造器注入的事件总线只用于模组生命周期事件，不要混用。
5. 编写代码时统一命名空间：NeoForge 工程不要出现 `net.minecraftforge` 导入；迁移时用全局搜索替换并核对 API 名称变化（部分方法签名在 NeoForge 中被简化）。
6. 发布前 `./gradlew build`；产物在 `build/libs/`。测试时用 `runClient`/`runServer` 两个任务分别验证双端。

## 验证

`runClient` 能加载模组并显示注册的物品/界面；主菜单 Mods 列表无红字依赖报错；把 jar 放入正式实例的 `mods/` 与 `runServer` 均正常；服务器日志无 `Missing or unsupported mandatory dependencies`。

## 相关内容

- [[mod-forge-mods-toml]]
- [[loader-neoforge-vs-forge]]
- [[dev-environment-setup]]
- [[crash-missing-dependency]]
