---
id: crash-exit-codes
title: 退出码含义与排查（Exit Code -1073741819 / 1 / -1）
category: crash
tags: [退出码, Exit Code, -1073741819, 0xC0000005, Exit Code 1, Exit Code -1, 崩溃, 0xC000007B]
summary: 启动器报告的 Exit Code: -1073741819、Exit Code: 1、Exit Code: -1 等分别代表什么，如何结合 latest.log 与 hs_err_pid 日志快速定位。
updatedAt: 2026-10-02
---

## 症状

游戏窗口关闭后，启动器控制台打出类似：

```
Process exited with code -1073741819
Exit Code: 1
Game crashed with exit code -1
```

有的启动器只显示 `Exit Code: 1`，有的显示十六进制 `0xC0000005`。同样的退出码可能对应完全不同的原因，必须结合日志判断。

## 原因

Windows 下进程退出码是无符号 32 位数，启动器常显示为有符号十进制：

- **0**：正常退出，启动器却报错时通常是自己关闭了游戏或杀毒软件拦截。
- **1**：Java 层抛出了未捕获异常后退出。几乎总能在这个时间点的 `logs/latest.log` 末尾找到完整的 Java 堆栈（模组加载失败、Java 版本错误、资源包问题等）。
- **-1（0xFFFFFFFF）**：进程未能正常启动或被强制终止的常见形态，例如 JVM 参数非法导致 java.exe 直接失败、启动器自身包装进程报错。这类情况要优先看**启动器自己的日志/控制台**，而不是游戏日志。
- **-1073741819（0xC0000005，STATUS_ACCESS_VIOLATION）**：原生内存访问违规，绝大多数是显卡驱动或模组携带的原生库问题，见 [[crash-access-violation-driver]]。
- **-1073741701（0xC000007B）**：Windows 报「应用程序无法正常启动」的经典错误，通常是 32/64 位 DLL 混用、驱动安装损坏或缺运行库。
- **-1073740791（0xC0000409）**：原生层栈保护/缓冲溢出，常见于原生库 bug 或驱动异常。

## 解决方案

1. **先定时间点**：记录崩溃时刻，打开 `logs/latest.log` 看最后 50 行；有 `crash-reports/` 就一并打开。
2. 存在 `hs_err_pid*.log` → 按 [[crash-fatal-error-hs-err]] 读 `Problematic frame`，按驱动问题处理。
3. 退出码为 1 且有 Java 堆栈 → 按堆栈最顶部的类名/异常名检索本知识库（如 `NoSuchMethodError`、`Mixin apply failed`）。
4. 退出码为 1 但日志停在下载/校验阶段 → 检查网络、镜像与文件完整性，常见于 `Failed to download file`。
5. 退出码为 -1 且游戏日志没有任何输出 → 检查 JVM 参数拼写（`-Xmx4G` 这类参数写错会让 JVM 直接拒绝启动）、检查是否 32 位 Java 分配了 4G 堆、检查杀毒软件是否拦截了 javaw.exe。
6. 出现 0xC000007B → 卸载所有旧版 Java 只保留需要的一个（见 [[java-multiple-installs]]），用 DDU 重装显卡驱动，确认游戏目录没有被放入手动复制的 32 位 DLL。
7. 仍无法判断时，用「原生启动器」或另一个启动器启动同一实例对比，可区分是实例问题还是启动器问题。

## 验证

修复后进入游戏正常游玩并正常退出，启动器显示退出码为 0；此前必现的退出码不再出现。

## 相关内容

- [[crash-access-violation-driver]]
- [[launcher-launch-pipeline]]
- [[launcher-args]]
- [[java-install-verify]]
