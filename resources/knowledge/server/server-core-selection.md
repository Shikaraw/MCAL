---
id: server-core-selection
title: 服务端类型选择（原版 / Paper / Forge / Fabric / 代理）
category: server
tags: [服务端, 开服, Paper, Purpur, Spigot, Forge, NeoForge, Fabric, Velocity, 插件, 模组, 混合端, 选择]
summary: 按「要插件还是要模组」选择服务端核心：Paper 系插件端、Forge/NeoForge/Fabric 模组端、Velocity 代理与混合端的取舍。
updatedAt: 2026-10-05
---

## 症状

- 想开服但面对 server.jar、paper.jar、forge-installer、fabric-server-launch.jar 无从下手；
- 把插件丢进 `mods/`、把模组丢进 `plugins/`，服务端启动后没有任何变化或直接报错；
- 装了混合端（如 Mohist/Arclight）后模组与插件都出现玄学崩溃；
- 想开多世界（大厅 + 生存 + 小游戏）不知道要不要上代理。

## 原因

服务端核心分四类，能力边界不同：

1. **原版（vanilla server.jar）**：Mojang 官方，无插件无模组，红石/机制最原汁原味，性能一般。
2. **插件端（Bukkit 系：Spigot → Paper → Purpur）**：基于原版重构，提供 `plugins/` 插件 API 与大量性能优化；Paper 兼容 Spigot 插件，Purpur 是 Paper 的增强分支。不加载 Forge/Fabric 模组。
3. **模组端（Forge / NeoForge / Fabric / Quilt）**：与客户端模组同一套生态，服务端需要「同模组 + 同版本」。Fabric 服务端轻量，Forge 生态庞大，NeoForge 是新版主流。
4. **混合端（Mohist、Arclight、CatServer 等）**：在插件端里嵌入模组加载器，试图同时支持插件与模组。兼容性问题多，遇 Bug 时上游作者通常先让你换纯端，属于「能用则用，出问题优先级低」的选项。
5. **代理（Velocity、BungeeCord/Waterfall）**：不承载游戏逻辑，只做多服转发与统一登录。现代推荐 Velocity。

## 解决方案

1. 明确需求：
   - 只要插件（领地、经济、小游戏）：选 **Paper**（最新稳定构建），需要更多玩法开关选 Purpur；
   - 要模组联机（科技包、魔法包）：选与客户端**完全一致**的 Forge/NeoForge/Fabric 版本，模组集合也要一致；
   - 既要插件又要模组：优先找纯模组方案（如 Fabric 下用服务端模组），混合端作为最后手段；
   - 多个子服务器：代理用 Velocity，后端各服仍按上面选择。
2. 下载渠道：Paper 从 papermc.io 的 builds 页获取 `paper-<版本>-<构建号>.jar`；Forge/NeoForge 用 installer 以 `--installServer` 模式安装；Fabric 用官方 server launcher。
3. 目录规范：插件端插件放 `plugins/`，模组端模组放 `mods/`；混合端的插件与模组目录以文档为准，不要凭感觉互放。
4. 版本一致原则：客户端 1.20.1 + Forge 47.2.0，服务端必须同为 1.20.1 + Forge 47.2.0，模组清单尽可能一致（客户端专属模组如光影/OptiFine 除外，见 [[mod-client-server-side]]）。
5. 代理模式：Velocity 只支持较新版本与正版/外置验证；旧版 BungeeCord 插件生态仍可用但已不推荐。代理转发需要开启 `online-mode` 与转发密钥配置。
6. 混合端用户：务必锁定特定版本组合（模组/插件各自标注兼容版本），升级前先备份，避免「升级一个模组全服崩」。

## 验证

服务端启动日志出现 `Done (x.xxxs)! For help, type "help"`；客户端能连接；插件/模组按预期生效（`/plugins` 或模组物品可用）。

## 相关内容

- [[server-setup]]
- [[server-performance-tuning]]
- [[server-connection-troubleshooting]]
- [[mod-client-server-side]]
