---
id: crash-mod-conflict
title: 模组互相冲突与重复模组
category: crash
tags: [冲突, 重复模组, LinkageError, 类重复, 兼容, 崩溃, Duplicate mod, 模组冲突]
summary: 两个模组提供同名类/同名 Mixin、或同一模组装了两份时，会出现 LinkageError、Duplicate mod、Mixin 冲突等报错；本文给出最小化定位流程。
updatedAt: 2026-10-04
---

## 症状

不一定是崩溃，常见表现有：

- 启动失败，日志出现 `java.lang.LinkageError: loader constraint violation` 或 `duplicate class xxx`；
- Forge/NeoForge 报告 `Duplicate mod` / `Found duplicate mod id` 一类信息并中止加载；
- 能进游戏但行为错乱：配方消失、功能失效、随机崩溃，`latest.log` 中反复出现某个模组的 `Mixin apply failed`；
- 打开某个界面必崩，堆栈指向两个模组各自的类交替出现。

## 原因

- **同一模组装了两份**：`mods` 目录里存在两个不同版本（例如手动更新时把新版拖进去、旧版没删），或大小写不同的重复文件（`Sodium.jar` 与 `sodium.jar` 在部分文件系统下被视为不同文件）。
- **两个模组做同一件事**：两个优化模组都替换渲染器（Sodium 与 OptiFine）、两个模组都注册同一个物品 id、两个模组都携带同一套前置库（各自打包了不同版本的 `org.spongepowered.mixin` 或某个 API）。
- **公共库版本冲突**：A 模组编译时绑定某个库的 1.0 API，B 模组带上 2.0 版本，JVM 先加载到旧版本 → `NoSuchMethodError` 或 `LinkageError`。

## 解决方案

1. 打开 `mods` 目录，按文件名排序，肉眼检查同名模组的不同版本文件，删掉旧版只留一个；同时确认没有 `.jar.disabled`、`.jar.bak` 之类的残留被识别为模组。
2. 在日志中检索 `Duplicate`、`LinkageError`、`duplicate class`、`conflict`，记录出现的模组名。
3. 对报错的两个模组先各自升级到最新版（冲突常在新版修复），仍冲突则二选一：功能重叠的模组（两个光影加载器、两个小地图、两个优化器）只保留一个。
4. 若怀疑公共库冲突：把所有模组升到同一时期的版本，避免混用「半年前下载的模组 + 最新版前置」。
5. 仍不能确定时用二分法：`mods` 目录留一半 → 测试 → 逐步缩小到最小冲突组合（具体步骤见 [[mod-load-order]] 末尾）。
6. 特别提醒：Sodium 与 OptiFine 不能共存；Rubidium/Embeddium 与 OptiFine 也不能共存；同一实例里不要同时装 Iris 与 Oculus。

## 验证

最小冲突组合下启动游戏，进入世界并用 `/give` 或旁观同一场景验证此前报错的功能恢复正常，`latest.log` 中没有 `LinkageError`、`duplicate class`、`Mixin apply failed` 等字样。

## 相关内容

- [[crash-mixin-failed]]
- [[crash-noclass-nosuchmethod]]
- [[mod-load-order]]
- [[graphics-shader-basics]]
