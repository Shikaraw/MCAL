---
id: loader-neoforge-vs-forge
title: NeoForge 还是 Forge？分叉现状与选择
category: loader
tags: [NeoForge, Forge, 选择, 不兼容, LoadingFailedException, neoforge.mods.toml, Missing or unsupported mandatory dependencies, 1.20.1]
summary: NeoForge 已从 Forge 分叉为独立项目，1.20.2 之后两者的模组不通用；按整合包/模组发布页选择加载器，避免装错平台导致的加载失败。
updatedAt: 2026-10-09
---

## 症状

把 Forge 模组装进 NeoForge 实例（或反之）后启动失败，日志大致是：

```
net.neoforged.fml.LoadingFailedException: Loading errors encountered:
	Missing or unsupported mandatory dependencies:
	Mod ID: 'neoforge', Requested by: 'xxx', Expected range: '[1.21,)', Actual version: '[MISSING]'
```

或被 Forge 侧的 `net.minecraftforge.fml.LoadingFailedException` 拦下。也有模组直接报 `Mod file ... is not a valid mod file` 或界面提示 `Incompatible mod set!`。

## 原因

2023 年 Forge 社区因治理问题分裂，NeoForge 从 Forge 分叉：

- **1.20.2**：NeoForge 与 Forge 20.2 高度同源，模组在这两个平台上大多可共用；
- **1.20.4 / 1.20.6 起**：两个项目独立演进，包名从 `net.minecraftforge` 分裂出 `net.neoforged`，事件与注册 API 逐步分道扬镳；
- **1.21 起**：NeoForge 的模组元数据文件名改为 `neoforge.mods.toml`，Forge 仍用 `mods.toml`；两者的 jar 不能互换；
- **版本号规则不同**：Forge 用「MC 小版本 → 递增主号」（如 1.20.1 → 47.x、1.21.1 → 52.x）；NeoForge 用「MC 版本号自身」（1.20.2 → 20.2.x、1.20.4 → 20.4.x、1.21.1 → 21.1.x、1.21.4 → 21.4.x），且 NeoForge 不支持 1.20.1 及更早版本。

选择逻辑其实很简单：**模组/整合包作者发布的是哪个平台，就用哪个**。1.20.1 及以前只能是 Forge；新版本（1.20.4+）社区生态重心在 NeoForge。

## 解决方案

1. 打开要玩的整合包/模组页面，看它的依赖标注：标 `NeoForge` 就装 NeoForge，标 `Forge` 就装 Forge；标两者则按整合包主文件里 manifest 指定的那个。
2. 新实例一律「先装加载器，再放模组」：NeoForge 用其官方 installer（或启动器内置安装），Forge 同理（见 [[loader-forge-install-fail]]）。
3. 不要尝试把 Forge 模组改名/改 toml 后塞进 NeoForge 实例，反之亦然；1.20.2 之外的版本这不会生效。
4. 同一实例中 Forge 与 NeoForge **不能共存**，也不需要共存。
5. 从 Forge 迁移到 NeoForge（例如 1.20.1 整合包升级到 1.21.1）属于跨版本迁移，必须逐个确认模组有 NeoForge 构建，参考 [[loader-upgrade-downgrade]] 的流程。
6. 报错时按日志区分：`Mod ID: 'neoforge'` 缺失说明模组装错平台；`Mod ID: 'minecraft'` 缺失说明模组与游戏版本不符。

## 验证

启动日志开头打印 `NeoForge version 21.1.x`（或 Forge 的对应版本行）；主菜单 Mods 列表显示所有模组且没有红色依赖报错；能正常进入世界。

## 相关内容

- [[loader-version-matrix]]
- [[crash-missing-dependency]]
- [[mod-forge-mods-toml]]
- [[loader-upgrade-downgrade]]
