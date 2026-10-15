---
id: graphics-opengl-version
title: OpenGL 版本过低 / Pixel format not accelerated
category: graphics
tags: [OpenGL, Pixel format not accelerated, GLFW error 65542, 显卡, 驱动, 核显, 远程桌面, 虚拟机, 1.17, 崩溃]
summary: 启动时报 Pixel format not accelerated 或 GLFW 报驱动不支持 OpenGL 时，问题在显卡驱动或运行环境（远程桌面/虚拟机），与游戏文件无关。
updatedAt: 2026-10-06
---

## 症状

游戏在打开窗口阶段崩溃，退出码常见 `-1` 或 `1`，控制台/日志出现：

```
org.lwjgl.LWJGLException: Pixel format not accelerated
```

或（1.17 及以后使用 GLFW）：

```
GLFW error 65542: WGL: The driver does not appear to support OpenGL
```

也有 `The game crashed whilst initializing game` 后紧接上述文本，以及 `Failed to create window` 之类的表述。任务管理器里 javaw.exe 一闪而过。

## 原因

`Pixel format not accelerated` 的字面意思是「系统找不到支持硬件加速的 OpenGL 像素格式」，即 **OpenGL 完全不可用**，而不是 OpenGL 版本号不够。常见场景：

- 显卡驱动未安装或损坏（设备管理器里显示「Microsoft 基本显示适配器」）；
- 在**远程桌面（RDP）**会话里启动游戏：RDP 只提供软件 OpenGL 1.1，无法满足游戏要求；
- 虚拟机（VMware/VirtualBox/Hyper-V）没有启用 3D 加速或未安装 Guest 驱动；
- 双显卡笔记本上核显驱动异常，游戏被分配到核显后创建上下文失败；
- Windows 更新/驱动更新中断导致 OpenGL ICD 注册丢失。

另需区分「GL 版本不够」：**Minecraft 1.17 及以后要求 OpenGL 3.2 核心模式**，老硬件/老驱动会以崩溃或黑屏形式失败；1.16.5 及以前要求低得多，老机器仍可运行。

## 解决方案

1. 打开设备管理器 → 显示适配器：若只有「Microsoft 基本显示适配器」，先安装显卡官方驱动（NVIDIA/AMD/Intel 官网，按型号下载）。
2. 若在远程桌面里运行，改用本机直接运行；必须远程时使用 Parsec、Moonlight 等支持硬件编码的串流方案，不要用 RDP 启动游戏。
3. 虚拟机：VMware 勾选「加速 3D 图形」并安装 VMware Tools；VirtualBox 启用 3D 加速并安装增强功能；仍失败则不要指望虚拟机玩 1.17+。
4. 双显卡笔记本：Windows 设置 → 系统 → 显示 → 图形 → 添加 `javaw.exe`（你的 Java 路径）→ 选「高性能（独显）」；NVIDIA 控制面板 → 管理 3D 设置 → 程序设置中同样指定。
5. 驱动损坏：用 DDU（Display Driver Uninstaller）在安全模式彻底卸载后重装；不要在装机助手类工具里更新驱动。
6. 老设备想继续玩：1.16.5 及更早版本对老旧 GPU 宽容得多；或用支持软件渲染的启动方式（如 Mesa llvmpipe，性能极低，仅作验证手段）。
7. 验证 OpenGL 可用性：用 GPU-Z 或 OpenGL Extensions Viewer 查看当前 OpenGL 版本，1.17+ 需 ≥ 3.2。

## 验证

游戏能打开窗口进入主菜单；按 `F3` 左上角显示正确的显卡型号与 OpenGL 版本；启动器不再报 `Pixel format not accelerated`/`GLFW error 65542`。

## 相关内容

- [[graphics-gpu-selection]]
- [[crash-access-violation-driver]]
- [[crash-exit-codes]]
- [[graphics-fps-tuning]]
