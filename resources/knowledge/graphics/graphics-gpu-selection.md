---
id: graphics-gpu-selection
title: 双显卡笔记本被分配到核显 / 驱动回退
category: graphics
tags: [双显卡, 核显, 独显, 高性能, 帧数低, F3, nvoglv64.dll, atio6axx.dll, 驱动回退, 笔记本]
summary: 笔记本帧数明显偏低、F3 显示核显名称时，用 Windows 图形设置与显卡控制面板把 javaw.exe 固定到独显，并处理驱动回退问题。
updatedAt: 2026-10-05
---

## 症状

- 笔记本配置不低但帧数只有个位数到二十几，游戏内按 `F3` 左上角显示的是 Intel/AMD 核显名称而非独显型号；
- 插电与电池表现差异巨大，独显似乎从未被使用；
- 更新驱动后崩溃增加，`hs_err_pid` 中 `Problematic frame` 指向 `nvoglv64.dll`（NVIDIA）、`atio6axx.dll`（AMD）或 `ig*icd64.dll`（Intel）等驱动模块；
- 外接显示器时才能跑满帧率。

## 原因

- Windows 对 OpenGL 程序的默认 GPU 分配策略偏保守，`javaw.exe` 经常被留在核显上；独显只在「高性能」模式下参与；
- 笔记本的电源模式（节能/平衡）会限制独显供电，甚至触发「驱动回退」：游戏过程中从独显切换到核显导致上下文丢失，表现为黑屏、闪烁或 EXCEPTION_ACCESS_VIOLATION；
- 部分机型的显卡驱动由 OEM 定制（尤其 Intel 核显与 NVIDIA Optimus 组合），使用通用驱动可能不兼容，默认驱动又过旧；
- 超频、温度墙同样会让 GPU 降频，看起来像「没用到独显」。

## 解决方案

1. 固定 GPU：Windows 设置 → 系统 → 显示 → 图形设置 → 添加桌面应用 → 选择你实际使用的 `javaw.exe`（在启动器的 Java 安装目录里，如 `C:\Program Files\Java\jdk-21\bin\javaw.exe`）→ 选项设为「高性能」。
2. 在显卡控制面板再确认一次：
   - NVIDIA：控制面板 → 管理 3D 设置 → 程序设置 → 添加 javaw.exe → 「高性能 NVIDIA 处理器」；
   - AMD：Radeon 软件 → 游戏 → 添加 javaw.exe → 「高性能 GPU」；
   - Intel 新驱动可在「图形设置」中把应用指定给独显。
3. 插电源游玩，Windows 电源计划设为「高性能 / 平衡」，关闭「节电模式」；游戏内开启全屏（独占全屏比窗口化更容易用独显稳定输出）。
4. 驱动策略：优先安装 OEM 官网的「显卡驱动包」；若游戏崩溃频繁，用 DDU 清理后安装 NVIDIA/AMD 官网的稳定版（Studio/WHQL），不要用 Beta。
5. 检查是否发生驱动回退：Windows 事件查看器 → 系统，筛选 `Display`，出现「显示驱动已停止响应并已恢复」即被 TDR 掉。对应处理见 [[crash-access-violation-driver]]。
6. 温度与超频：用 HWiNFO 观察 GPU 温度与频率；90 度以上降频属正常保护，需清灰/散热垫；关闭 MSI Afterburner 的自动超频。
7. 若外接显示器才正常：检查笔记本 MUX 开关/BIOS 里的显卡模式，或确认内屏确实由独显驱动（部分机型内屏永久接核显，这是硬件限制）。

## 验证

`F3` 左上角显示的 GPU 与实物独显一致；帧数明显提升（通常翻倍以上）；连续游玩不再出现「驱动已停止响应并已恢复」的事件记录与新的 hs_err 日志。

## 相关内容

- [[crash-access-violation-driver]]
- [[graphics-opengl-version]]
- [[graphics-fps-tuning]]
- [[crash-fatal-error-hs-err]]
