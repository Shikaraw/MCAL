---
id: crash-mod-version-mismatch
title: 模组与游戏版本不匹配（Incompatible mod set / Detected an incompatible mod）
category: crash
tags: [版本不匹配, Incompatible mod set, Detected an incompatible mod, FormattedException, 崩溃, 模组, 游戏版本]
summary: 日志出现 Incompatible mod set！或 Detected an incompatible mod，说明模组要求的游戏版本与当前实例不符；按加载器给出的「A potential solution」逐条修正即可启动。
updatedAt: 2026-10-04
---

## 症状

Fabric 实例启动即失败，控制台出现：

```
Incompatible mod set!
net.fabricmc.loader.impl.FormattedException: Mod resolution encountered an incompatible mod set!
A potential solution has been determined:
	 - Replace mod 'Sodium' (sodium) 0.5.8 with any version that is compatible with:
		 - minecraft 1.19.4 and fabric-api 0.84.0+1.19.4
	 - Install sodium 0.4.10, which is compatible with:
		 - minecraft 1.19.4
	 - Replace mod 'xxx' (id) with a version that supports 1.19.4
```

Forge/NeoForge 侧可能出现 `Detected an incompatible mod` 一类提示，或在 `latest.log` 中报告某模组声明的 Minecraft 版本范围与当前实例不符；加载进度条走到某个模组后直接退出。

## 原因

每个模组在元数据里都声明了它支持的 Minecraft 版本与加载器版本（Fabric 在 `fabric.mod.json` 的 `depends` 中的 `minecraft` 字段，Forge/NeoForge 在 `mods.toml` 的 `versionRange`）。当实际版本不在范围内时：

- `minecraft` 范围不符：例如把 1.20.1 的模组放进 1.20.4 实例；
- 加载器版本不符：例如 1.21 的模组依赖 `neoforge [21.1,)`，而实例是 21.0；
- 前置的版本范围互相咬合不上（A 要 fabric-api ≥0.90，B 要 ≤0.85），形成无解组合。

Fabric 的提示非常友好——`A potential solution has been determined` 下面列出的就是可执行的修复动作。

## 解决方案

1. 直接在日志里逐条读 `A potential solution has been determined:` 之后的建议，优先选择「Replace mod 'xxx' with any version that is compatible with minecraft 1.20.1」这类——即去下载对应版本的文件。
2. 到 Modrinth/CurseForge 项目页面，在「版本筛选」中选择**当前实例的游戏版本与加载器**，下载列表里出现的那个文件（不要用自动推荐的最新版）。
3. 若某个模组没有适配当前游戏版本的文件（常见于 1.20.1 之后没升级的模组），选择：改用其他替代模组、降级游戏版本、或移除该模组。
4. 检查是否有「跨大版本」的模组混装：`mods` 目录里同时存在给 1.16.5 与 1.20.1 的同名模组、或 `xxx-1.16.5.jar` 与 `xxx-1.20.1.jar` 并存，删掉多余的那个。
5. 记住：Forge 模组不能装进 NeoForge 实例、Fabric 模组不能装进 Forge 实例，平台标识也要对上（`fabric.mod.json` vs `mods.toml`）。

## 验证

重启后加载条走完、进入标题界面，`latest.log` 中不再出现 `Incompatible mod set` / `Detected an incompatible mod` / `Mod resolution encountered an incompatible mod set`，且 F3 调试界面里列出的模组数量与预期一致。

## 相关内容

- [[crash-missing-dependency]]
- [[mod-fabric-mod-json]]
- [[mod-forge-mods-toml]]
- [[loader-neoforge-vs-forge]]
