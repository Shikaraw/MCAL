---
id: crash-missing-dependency
title: 缺失前置模组（Missing or unsupported mandatory dependencies）
category: crash
tags: [前置, 依赖, 缺失, Missing or unsupported mandatory dependencies, Fabric API, 不兼容, 崩溃, requires]
summary: 模组解析阶段报 Missing or unsupported mandatory dependencies / Mod xxx requires yyy，按日志给出的 mod id 与版本范围补齐前置模组即可解决。
updatedAt: 2026-10-03
---

## 症状

游戏在出现加载条之前就失败，Fabric 控制台打出：

```
net.fabricmc.loader.impl.FormattedException: Mod resolution encountered an incompatible mod set!
Missing or unsupported mandatory dependencies:
	Mod ID: 'fabric-api', Requested by: 'xxx', Expected range: '>=0.90.0', Actual version: '[MISSING]'
```

或出现类似 `Mod xxx requires yyy version 1.2.0 or later`、`Mod ID: 'architectury', Requested by: 'yyy', Expected range: '*', Actual version: '[MISSING]'` 的清单。Forge/NeoForge 侧则常在 `latest.log` 里给出「Mod xxx requires yyy」形式的缺失说明，并停止加载。

## 原因

模组在元数据里声明了硬性依赖（`depends` / `mandatory = true`），加载器在解析阶段发现依赖不存在或版本号不在要求范围内，于是拒绝启动。最常见的前置是 Fabric API、Architectury API、Cloth Config、GeckoLib、Kotlin 运行时（Kotlin for Forge / Fabric Language Kotlin）等。另一种情况是依赖装了但版本太旧：`Actual version: '0.80.0'` 不在 `>=0.90.0` 范围内。

## 解决方案

1. 在日志里复制 `Mod ID:` 后面的 id 和 `Requested by:` 后面的模组名，例如缺 `fabric-api`、`architectury`、`cloth-config`。
2. 到 Modrinth 或 CurseForge 搜索该 id，下载与当前**游戏版本 + 加载器**完全一致的文件，放进 `mods` 目录。
3. 注意依赖的「版本范围」：日志写 `Expected range: '>=0.90.0'`，就不能放 0.80.0 的旧版本；优先选该前置当前最新版。
4. Forge/NeoForge 上要区分：`forge`、`neoforge`、`minecraft` 本身也是依赖 id，报 `Mod ID: 'neoforge'` 说明模组装错了平台（把 NeoForge 模组装进了 Forge 实例）。
5. 若已经是正确前置但版本仍不合，升级**整个组合**（前置 + 依赖它的模组）到同一时间点的版本。
6. 常见前置清单与用途见 [[mod-common-dependencies]]。

## 验证

重新启动，加载条能走完并进入标题界面；`latest.log` 中不再出现 `Missing or unsupported mandatory dependencies`，也没有 `[MISSING]` 字样。

## 相关内容

- [[mod-common-dependencies]]
- [[mod-fabric-mod-json]]
- [[mod-forge-mods-toml]]
- [[crash-mod-version-mismatch]]
