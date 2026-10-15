---
id: crash-access-violation-driver
title: 显卡驱动导致的 EXCEPTION_ACCESS_VIOLATION（0xc0000005）
category: crash
tags: [崩溃, 驱动, 显卡, EXCEPTION_ACCESS_VIOLATION, Problematic frame, hs_err_pid, atio6axx.dll, nvoglv64.dll, 0xc0000005]
summary: 游戏突然闪退、退出码 -1073741819，并生成 hs_err_pid 日志；Problematic frame 指向 atio6axx.dll / nvoglv64.dll / ig?icd64.dll 等显卡驱动 DLL 时的定位与修复方法。
updatedAt: 2026-10-02
---

## 症状

游戏在进入世界、切换维度或开光影时毫无提示地关闭窗口，启动器显示 `Exit Code: -1073741819`，游戏目录（或 `.minecraft` 上级目录）出现 `hs_err_pidXXXX.log`，开头类似：

```
# A fatal error has been detected by the Java Runtime Environment:
#
#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb12345678, pid=12345, tid=6789
#
# JRE version: OpenJDK Runtime Environment 21.0.1
# Problematic frame:
# C  [atio6axx.dll+0x13ac9f]
```

有时 Windows 还会弹出「显示驱动已停止响应并已恢复」。注意这与普通 mod 报错不同：`latest.log` 里通常没有 Java 异常堆栈，游戏是「喇叭一声没响直接死」。

## 原因

`EXCEPTION_ACCESS_VIOLATION` 表示原生代码访问了非法内存，纯 Java 的模组代码做不到这一点。能出现在 `Problematic frame` 的通常是：

- `nvoglv64.dll`（NVIDIA OpenGL 驱动）
- `atio6axx.dll`（AMD 64 位 OpenGL 驱动）/ `atioglxx.dll`（32 位）
- `ig7icd64.dll`、`ig9icd64.dll`、`igd10iumd64.dll` 等（Intel 集显 OpenGL 驱动）
- 少数情况下是 `lwjgl.dll` 或其他随模组携带的原生库

即绝大多数是驱动 bug 被某个渲染路径（光影、优化模组、超采样、显存不足）触发。常见诱因：驱动版本太旧或刚更新引入回归、显卡超频、笔记本在集显/独显之间切换时上下文丢失、老驱动跑 1.17+（要求 OpenGL 3.2 核心模式）。

## 解决方案

1. 打开 `hs_err_pid*.log`，看 `Problematic frame:` 那行：`nvoglv64.dll` → NVIDIA；`atio6axx.dll`/`atioglxx.dll` → AMD；`ig*icd64.dll`/`igd*umd64.dll` → Intel。
2. 到显卡厂商官网（不要用第三方驱动工具）更新驱动。如果是更新后才开始崩，用 DDU（Display Driver Uninstaller）在安全模式彻底卸载后安装一个已知稳定版本。
3. 关闭超频工具（MSI Afterburner、AMD Adrenalin 超频页），笔记本在 Windows「设置 → 系统 → 显示 → 图形设置」中为 `javaw.exe` 指定「高性能 / 独显」。
4. 临时移除光影和渲染类优化模组（OptiFine、Iris、Sodium、Embeddium、Oculus 等）验证是否还崩；不再崩则逐个加回定位具体模组。
5. 若 Problematic frame 指向的是某个模组携带的 DLL，直接移除该模组，并向作者反馈该 hs_err 日志。
6. Intel 集显机型：更新到 Intel 官网最新驱动；仍不支持 OpenGL 3.2 的老机器只能关光影或玩 1.16.5 及更老版本。

## 验证

进入此前必崩的同一场景（含光影），连续运行 30 分钟以上不再生成新的 `hs_err_pid*.log`，启动器退出码为 `0`。

## 相关内容

- [[crash-exit-codes]]
- [[crash-fatal-error-hs-err]]
- [[graphics-gpu-selection]]
- [[graphics-opengl-version]]
