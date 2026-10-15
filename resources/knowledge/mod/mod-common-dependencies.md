---
id: mod-common-dependencies
title: 常见前置模组说明（Fabric API / Architectury / Cloth Config / GeckoLib 等）
category: mod
tags: [前置, 依赖, Fabric API, Architectury, Cloth Config, GeckoLib, Kotlin, Curios, Trinkets, 模组]
summary: 主流前置模组的用途、适用加载器与安装要点，帮助你正确补齐 Missing mandatory dependencies 中列出的依赖。
updatedAt: 2026-10-13
---

## 症状

- 反复看到 `Missing or unsupported mandatory dependencies` / `Mod xxx requires yyy`，但不知道该下哪个前置；
- 前置装了却仍然报缺版本，或装了错的平台版本（Forge 的装到 Fabric 上）；
- 不知道前置是否需要一起更新。

## 原因

很多模组把通用功能抽成独立前置（API 库），本身不含玩法内容。前置缺失或版本不匹配时，加载器会在解析阶段直接拒绝启动。不同加载器和版本的前置完全不同，且前置自身也在更新，老前置配新模组常见报错。

## 解决方案

对照日志里的 `Mod ID` 安装对应前置：

| 前置 | 用途 | 适用平台 |
| --- | --- | --- |
| Fabric API | Fabric 生态基础 API（事件、注册、渲染接口） | Fabric/Quilt（Forge 不需要） |
| Architectury API | 让一个模组同时支持 Fabric/Forge 的跨平台框架 | Fabric + Forge/NeoForge |
| Cloth Config | 提供配置界面 UI 的库 | Fabric + Forge/NeoForge |
| GeckoLib | 动画实体渲染库（很多生物/载具模组需要） | Fabric + Forge/NeoForge |
| Fabric Language Kotlin / Kotlin for Forge | 用 Kotlin 编写的模组运行时 | 分别对应 Fabric / Forge |
| owo-lib | 现代 UI/配置库 | Fabric |
| YACL | YetAnotherConfigLib，配置界面库 | Fabric + NeoForge |
| Curios / Trinkets | 饰品槽位 API（Curios 为 Forge/NeoForge，Trinkets 为 Fabric） | 分别对应 |
| Balm、Bookshelf、Puzzles Lib、Caelus、Player Animator | 各作者自有的基础库 | 视模组说明 |

安装要点：

1. 前置必须装在**与目标模组相同的加载器与游戏版本**上；下载页面筛选「游戏版本 + 加载器」。
2. 前置一般只放主 jar 一个文件，不要装重复版本（多个版本会引发冲突，见 [[crash-mod-conflict]]）。
3. 更新模组时同步更新它依赖的前置；日志提示 `Expected range: '>=0.90.0'` 就下载不低于该版本的前置。
4. 服务端只装服务端需要的双端前置；纯客户端前置（如某些 UI 库）不用放进服务器。
5. 前置本身版本也会影响性能与崩溃，尽量使用整合包作者锁定的版本组合。

## 验证

启动游戏进入主菜单，F3 或 Mod Menu 模组列表里前置与目标模组都出现且版本正确；此前 `Missing or unsupported mandatory dependencies` 报错消失，能进入世界正常游玩。

## 相关内容

- [[crash-missing-dependency]]
- [[mod-client-server-side]]
- [[mod-fabric-mod-json]]
- [[mod-forge-mods-toml]]
