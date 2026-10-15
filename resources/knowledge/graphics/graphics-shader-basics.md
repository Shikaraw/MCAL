---
id: graphics-shader-basics
title: 光影原理与 Iris / OptiFine 兼容性
category: graphics
tags: [光影, shader, shaderpack, Iris, OptiFine, Oculus, Sodium, 兼容, shaderpacks, 光影不生效]
summary: 光影包是什么、Iris 与 OptiFine 两套运行环境如何选择，以及光影包与游戏/加载器版本绑定带来的兼容规则。
updatedAt: 2026-10-07
---

## 症状

- 把光影包 zip 放进 `shaderpacks/` 后，视频设置里找不到光影选项；
- 光影列表里能看到名字，但启用后没效果或报错；
- 下载的光影包在旧版本能用，换到 1.21 后加载失败；
- 装了 Iris 却提示 Sodium 缺失，或装上 OptiFine 后 Sodium/Oculus 全部失效。

## 原因

光影包（shaderpack）是一组替换原版渲染管线的着色器程序，通常包含 `shaders/` 目录下的 `.vsh/.fsh/.glsl` 文件、`shaders.properties` 与语言文件。**游戏本身不认识光影包**，需要一个「光影加载器」提供运行环境：

- **OptiFine**：自带光影支持，光标 `shaders` 文件夹年代的做法；不支持与 Sodium 系共存；
- **Iris**：现代光影加载器（源自 OptiFine 光影格式的兼容实现），Fabric/Quilt 上与 Sodium 搭配；较新版本也提供 NeoForge 构建；
- **Oculus**：Forge 上的 Iris 移植，配合 Embeddium/Rubidium。

兼容性由三层决定：光影包要求的 **MC 版本**、它依赖的 **光影加载器特性**（OptiFine 专有特性 vs Iris 支持的子集）、以及**渲染核心**（Sodium/Iris 与 OptiFine 互斥）。因此「同一个光影包在所有版本都能用」是不成立的。

## 解决方案

1. 选定环境：
   - Fabric/Quilt：`Sodium + Iris`；
   - Forge：`Embeddium(Rubidium) + Oculus`；
   - NeoForge：选 NeoForge 构建的 `Embeddium + Oculus`（或 Iris 的 NeoForge 版）。
2. 光影包放进 `.minecraft/shaderpacks/`（zip 不用解压；解压成文件夹也可以，但文件夹名不要含中文/特殊字符）。启用路径：Options → Video Settings → Shader Packs（Iris 下为 Shaderpacks），选中后 Apply。
3. 到光影发布页核对支持的 MC 版本与加载器；BSL、Complementary、Photon 等主流包都会分别标注。
4. 检查前置：Iris 需要同版本的 Sodium；Oculus 需要 Embeddium/Rubidium。缺少时视频设置里根本没有光影入口。
5. 光影包对系统要求远高于原版：建议至少 6–8 GB 堆内存并配独显；核显笔记本用轻量光影（如 Complementary 的低配预设）或关闭光影。
6. 与性能模组混装时记住互斥红线：OptiFine 不与 Sodium/Embeddium/Rubidium/Oculus 共存。

## 验证

启用光影后画面光照、水面、天空明显变化；按 `F3` 帧率有变化但不异常（骤降到个位数说明配置过高）；日志中没有光影加载/编译报错；关闭光影后画面恢复正常。

## 相关内容

- [[graphics-shader-issues]]
- [[mod-performance-stack]]
- [[loader-optifine-and-alternatives]]
- [[graphics-fps-tuning]]
