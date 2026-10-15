---
id: mod-forge-mods-toml
title: mods.toml 字段解读与 mandatory / versionRange 语义
category: mod
tags: [Forge, NeoForge, mods.toml, 依赖, versionRange, mandatory, 元数据, missing mods.toml]
summary: 逐段解读 Forge/NeoForge 模组的 mods.toml：modLoader、mods 段、dependencies 段的 mandatory、versionRange、ordering、side 语义，以及 NeoForge 1.21 起的 type 写法。
updatedAt: 2026-10-11
---

## 症状

- 报错 `Mod file example.jar is missing mods.toml file`——jar 不是有效的 Forge 模组，或被打包工具破坏了；
- 日志里出现「Mod xxx requires yyy / Missing or unsupported mandatory dependencies」；
- 想知道某个 Forge 模组支持的 MC 版本范围，却看不懂 `versionRange`。

## 原因

Forge/NeoForge 模组用 jar 根目录的 `mods.toml`（旧版 1.12.2 是 `mcmod.info`）声明身份与依赖。它是加载器决定「能否加载、加载顺序、需要哪些前置」的依据。理解它就能判断模组是否与当前实例兼容。

## 解决方案

用压缩软件打开模组 jar，查看 `META-INF/mods.toml`（Forge 1.13+ 起路径在 `META-INF`）。典型内容：

```toml
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]]
modId="examplemod"
version="1.0.0"
displayName="Example Mod"
description='''示例模组'''

[[dependencies.examplemod]]
modId="forge"
mandatory=true
versionRange="[47,)"
ordering="NONE"
side="BOTH"

[[dependencies.examplemod]]
modId="minecraft"
mandatory=true
versionRange="[1.20.1,1.21)"
ordering="NONE"
side="BOTH"
```

- `modLoader="javafml"`：Java 模组入口类型；`loaderVersion` 是要求的 Forge/NeoForge 版本范围（对应 Forge 的构建号，如 47.x = 1.20.1）。
- `[[mods]] modId`：模组唯一 id；重复 id 会中止启动。
- `versionRange`：`[1.20.1,1.21)` 表示 ≥1.20.1 且 <1.21；`[47,)` 表示 ≥47。方括号含端点、圆括号不含。
- `mandatory=true`：硬依赖，缺失即拒绝启动；`false` 为软依赖（仅提示）。
- `ordering`：`BEFORE`/`AFTER`/`NONE`，用于影响与其他模组的加载顺序（如 `ordering="AFTER"` 表示在后加载）。
- `side`：`BOTH`/`CLIENT`/`SERVER`，声明依赖在哪个物理侧要求满足。
- NeoForge 1.21 起支持新的依赖写法：

  ```toml
  [[dependencies.examplemod]]
  type = "required"        # required / optional / incompatible / discouraged
  modId = "neoforge"
  versionRange = "[21.1,)"
  ordering = "NONE"
  ```

排查用法：对照 `versionRange` 与你的实例版本，立刻能判断一个模组是否适配；1.20.1 的 Forge 模组装到 1.20.4 会因 `minecraft` 范围不符而报错。

## 验证

启动游戏，Forge 日志中的模组列表里出现该模组及其版本；F3 的 Mods 列表或 Mod 菜单中可见。故意把一个 `mandatory=true` 的前置移走，日志应给出缺失依赖提示。

## 相关内容

- [[mod-fabric-mod-json]]
- [[crash-missing-dependency]]
- [[loader-neoforge-vs-forge]]
- [[dev-forge-neoforge-mod]]
