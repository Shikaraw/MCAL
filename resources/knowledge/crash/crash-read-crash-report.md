---
id: crash-read-crash-report
title: 崩溃报告怎么读（Description / Stacktrace / Suspected Mods）
category: crash
tags: [崩溃报告, crash-report, 日志, Description, Stacktrace, Suspected Mods, Mod List, latest.log, 读日志]
summary: 崩溃报告各字段的含义与阅读顺序：先看 Description 与第一段堆栈，再看 Suspected Mods / Mod List 与 System Details，最后用 mods 列表二分验证。
updatedAt: 2026-10-07
---

## 症状

游戏崩溃后 `.minecraft/crash-reports/` 里生成形如 `crash-2026-10-07_12.00.00-client.txt` 的文件，用户面对几千行文本不知道从哪看起；有时甚至只有 `logs/latest.log` 没有崩溃报告。

## 原因

这是「不知道怎么用信息」的问题而不是游戏故障。崩溃报告是排查的第一手资料，它的结构是固定的。

## 解决方案

按以下顺序阅读（自上而下）：

1. **头部三行**：文件最上方是 `---- Minecraft Crash Report ----`、`Time:` 与 `Description:`。`Description` 是游戏自己归纳的场景，如 `Ticking entity`（实体 tick 时崩）、`Rendering overlay`（渲染界面时崩）、`Initializing game`（初始化时崩），先定场景。
2. **第一段堆栈**：`Description` 下面紧跟着异常类型与消息，例如 `java.lang.NullPointerException: Cannot invoke "" because "" is null` 或 `java.lang.NoSuchMethodError: ...`，再往下是 `at 包名.类名.方法名(文件名:行号)` 列表。**看最上面 3~8 行 `at`**，第一个「不是 net.minecraft/原版包名」的类通常就是问题源头。
3. **`-- Head --` 与 `-- Affected level --`**：Head 对 `Ticking entity` 类崩溃尤其有用，会打印实体/NBT 上下文；`Affected level` 给出世界名、维度、玩家位置与区块统计。
4. **`-- System Details --`**：确认 `Minecraft Version`、`Java Version`（是否符合版本要求）、`Java VM Version`、`Memory`（是否接近堆上限）、`CPU`。这里的 `Loaded Mods: N mods loaded` / `Mod List:` 是模组清单，便于核对数量与顺序。
5. **Fabric 的 `Suspected Mods`**：Fabric Loader 会根据堆栈里的包名推测责任模组，直接列出「Suspected Mods: sodium」。注意这是推测，可能有多个，仍要结合堆栈判断。
6. **`-- Mixin --`/`-- Mod --` 段**：出现 Mixin 失败时看这一段，里面有 `from mod xxx` 与目标类，见 [[crash-mixin-failed]]。
7. 没有崩溃报告时用 `logs/latest.log`：检索 `ERROR`、`FATAL`、`Exception`、`Caused by`，最后 50 行往往就是原因；更有用的关键字是 `Failed to load mod`、`Missing`、`Failed to download`。
8. 用结论验证：按堆栈提到的模组做增删测试，确认修复后同一场景不再生成新的崩溃报告。

补充：崩溃报告只记客户端进程。服务端崩溃要看 `logs/latest.log` 与 `crash-reports/`（服务端同结构），JVM 级崩溃看 `hs_err_pid*.log`（见 [[crash-fatal-error-hs-err]]）。

## 验证

用同一份崩溃报告能说出「触发场景、异常类型、嫌疑模组/驱动、下一步动作」四要素；修复后不再生成新的 `crash-report` 文件。

## 相关内容

- [[crash-mixin-failed]]
- [[crash-fatal-error-hs-err]]
- [[crash-exit-codes]]
- [[launcher-game-dirs]]
