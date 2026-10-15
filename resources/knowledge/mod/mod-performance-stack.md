---
id: mod-performance-stack
title: 模组性能优化清单（Sodium / Embeddium / Rubidium / Lithium / FerriteCore / Starlight）
category: mod
tags: [优化, 性能, Sodium, Embeddium, Rubidium, Lithium, FerriteCore, Starlight, 掉帧, FPS, 互斥]
summary: 主流性能模组按加载器与版本的搭配清单、互斥关系（OptiFine vs Sodium/Embeddium），以及「装越多越快」的常见误区。
updatedAt: 2026-10-12
---

## 症状

- 原版或整合包帧数低、卡顿，想装优化模组但不知道装哪些；
- 装了优化模组后崩溃、光影失效、材质异常；
- 听说 Sodium 快，但装到 Forge 版本上没用甚至报错。

## 原因

不同加载器与游戏版本对应的渲染内核不同：

- **Fabric 侧**：Sodium（渲染核心）+ Lithium（游戏逻辑优化）+ Iris（光影，配合 Sodium）+ FerriteCore（内存）+ Krypton（网络）+ ImmediatelyFast（UI 渲染）+ EntityCulling（实体剔除）。
- **Forge/NeoForge 侧**：Rubidium 或 Embeddium（Sodium 移植，Rubidium 主要面向 1.16.5/1.18.2/1.19.2，Embeddium 是其后续、覆盖更新版本）+ Oculus（光影，配合前两者）+ FerriteCore + Starlight（光照优化，注意其支持的 MC 版本列表）+ ModernFix / EntityCulling / ImmediatelyFast。Lithium 的 Forge 侧移植（如 Canary 等）版本常滞后，装前确认支持范围。
- **互斥**：OptiFine 与 Sodium/Rubidium/Embeddium **不能共存**；Oculus 与 OptiFine 也不能共存；Rubidium 与 Embeddium 是同功能品，不要同装；两个加载器上同一功能模组只装一个。
- **GeckoLib、Ars 等模组自带的渲染链路**不受 Sodium 影响；但「优化模组」并不改变模组自身的低效代码，某些科技包的卡顿仍在。

## 解决方案

1. Fabric 实例推荐组合：`Sodium + Iris + Lithium + FerriteCore`（+ 可选 Krypton/ImmediatelyFast/EntityCulling）。光影放 `shaderpacks`，需要 Iris。
2. Forge 1.16.5/1.18.2/1.19.2 实例：`Rubidium + Oculus + FerriteCore`；1.20.1 及之后：`Embeddium + Oculus(+ FerriteCore/ModernFix)`。
3. NeoForge 1.21+ 实例：`Embeddium + Oculus + FerriteCore`（NeoForge 有专门构建，注意下载时选择 NeoForge 平台）。
4. **不要装 OptiFine**：若模组包依赖 OptiFine 的特性（CIT、动态光源、连接材质），用替代组合：Iris 负责光影、Continuity 负责连接材质、CIT Resewn/Entity Texture Features 负责 CIT 与皮肤特性。
5. 加模组后若崩溃：先移除全部优化模组确认原版能跑，再一组组加；两个渲染核心（Sodium/Embeddium/Rubidium/OptiFine）永远只能装一个。
6. 优化模组只解决「引擎开销」；真正的帧数瓶颈常是渲染距离、实体数量、机械/自动化（见 [[graphics-fps-tuning]]）。

## 验证

F3 界面 fps 明显提升（常见提升幅度 30%~100%，视硬件而定），画面无渲染错误（方块全黑、UI 闪烁、光影不生效都属于异常）；连续游玩 20 分钟不再出现优化模组相关的崩溃。

## 相关内容

- [[loader-optifine-and-alternatives]]
- [[graphics-fps-tuning]]
- [[crash-mod-conflict]]
- [[graphics-shader-basics]]
