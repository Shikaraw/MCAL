---
id: graphics-fps-tuning
title: 帧率优化陷阱：为什么「优化」后更卡了
category: graphics
tags: [帧率, FPS, 卡顿, 优化, 掉帧, 渲染距离, 模拟距离, Vsync, 限帧, 陷阱, 火花, MSPT]
summary: 帧率优化最常见的五个误区（盲目加内存、叠加优化模组、混淆渲染/模拟距离、不限帧、误用设置），以及以「稳定帧时间」为目标的正确调法。
updatedAt: 2026-10-06
---

## 症状

- 装了多种「优化」模组后帧数不升反降，甚至启动崩溃；
- 帧数平均值很高但每隔几秒明显卡一下（顿挫感）；
- 拉高 `-Xmx` 后没有任何提升，反而卡顿更重；
- 画质设成最低仍然只有 30 FPS，而 GPU/CPU 占用都不高。

## 原因

- **把 -Xmx 当帧率开关**：内存只影响 GC 与区块加载，和渲染帧率无关；堆开得过大反而让 GC 单次停顿更久（见 [[java-memory-flags]]）。
- **优化模组叠加**：两个渲染核心（Sodium/Embeddium/OptiFine）或多套光照优化（Starlight/Phosphor 类同功能）同装会互相打架，比重装前更慢。
- **混用渲染距离与模拟距离**：渲染距离决定画到什么，模拟距离决定区块运算到哪。降渲染距离对帧率立竿见影，降模拟距离影响机器运行。
- **不限帧 + 垂直同步关闭**：帧率无上限时 GPU 满载空转，笔记本更快撞温度墙降频，反而周期性掉帧。
- **卡顿源不在画面**：自动农场、刷怪塔、红石机器带来的服务端 Tick 压力（MSPT 高）会以「顿挫」形式表现，靠画质设置解决不了。
- **后台干扰**：Windows 游戏模式/硬件加速 GPU 计划、录屏软件、杀毒实时扫描都会在区块加载时造成尖峰。

## 解决方案

1. 先测量再动手：按 `F3+L` 开启调试分析（1.17+，结果写入 `debug/` 目录），或装 Spark（Fabric/Forge 均有），区分卡顿来自渲染还是服务端 Tick。
2. 设置侧的最优解排队：
   - Render Distance 8–12（16 以上收益递减且显存吃紧）；
   - Simulation Distance 4–8；
   - 关闭体积云/雾、把 Particles 调低、Graphics 用 Fancy（避免 Fabulous 与光影冲突）；
   - FPS 上限设为显示器刷新率或略低（如 120Hz 屏设 120），不要「无限制」；VSync 用「自适应/快同步」或直接限帧。
3. 优化模组只装一套：Fabric 用 `Sodium + Lithium + FerriteCore (+Iris)`；Forge 用 `Embeddium + Oculus + FerriteCore`；详见 [[mod-performance-stack]]。
4. 内存给够即可：一般整合包 4–8 GB，大型 200+ 模组包 8–12 GB；不要超过物理内存一半以上。
5. 处理 Tick 卡顿：降低刷怪塔/自动机产量，拆分区域，远端机器用区块加载器改成按需加载；预生成世界（Chunky）能显著减少跑图时的新区块生成尖峰。
6. 系统侧：电源计划高性能、关闭录屏/直播软件、把 `.minecraft` 与 Java 加入杀毒白名单、更新显卡驱动。
7. 调参一次只改一项并记录前后 FPS，避免「改了一堆变量」后无法归因。

## 验证

用同一场景做基准：出生点站立 60 秒与直线跑图 60 秒的 1% low 帧率提升且尖峰减少；F3 中帧时间曲线平稳（无周期性大尖峰）；GPU 温度不再触发降频。

## 相关内容

- [[mod-performance-stack]]
- [[graphics-shader-issues]]
- [[java-memory-flags]]
- [[server-performance-tuning]]
