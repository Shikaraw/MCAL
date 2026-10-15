---
id: crash-fatal-error-hs-err
title: JVM 致命错误与 hs_err_pid 日志解读
category: crash
tags: [hs_err_pid, fatal error, JVM, SIGSEGV, 崩溃, EXCEPTION_ACCESS_VIOLATION, 原生崩溃, 日志]
summary: 出现 A fatal error has been detected by the Java Runtime Environment 时，如何读 hs_err_pid*.log 的 Problematic frame、Java frames 段定位是驱动、原生库还是 JVM 本身。
updatedAt: 2026-10-07
---

## 症状

游戏窗口瞬间消失，或整个 Java 进程「静悄悄地死了」，游戏目录里出现 `hs_err_pid12345.log`。文件开头：

```
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGSEGV (0xb) at pc=0x00007f8e..., pid=12345, tid=1234
#
# JRE version: OpenJDK Runtime Environment (21.0.1+12) (build 21.0.1+12)
# Java VM: OpenJDK 64-Bit Server VM (21.0.1+12, mixed mode)
# Problematic frame:
# C  [nvoglv64.dll+0x1a2b3c]
```

随后的段包括 `siginfo`、`Registers`、`Stack`、`Java frames`、`Dynamic libraries`、`VM Arguments` 等。

## 原因

hs_err 是 HotSpot 在检测到**原生层**致命错误（段错误、栈溢出、内存访问违规）时写出的现场报告。它与普通崩溃报告的区别在于：普通崩溃是「Java 抛异常」，可以在日志里看到堆栈；hs_err 是「进程被打死」，Java 层往往没有机会记录。

`siginfo` 里的 `EXCEPTION_ACCESS_VIOLATION (0xc0000005)` 表示读写了非法内存；`SIGSEGV` 表示段错误；`StackOverflowError` 相关的 `SIGSEGV` 则常因为递归过深（模组 bug）。

## 解决方案

1. 打开 `hs_err_pid*.log`，只读三段：
   - `Problematic frame:`：出错的模块。`C [xxx.dll+offset]` 是原生库，`J` 开头是 JIT 编译的 Java 代码，`V` 是 VM 自身。
   - `Java frames:`：即出错时的 Java 调用栈。这里的类名会指向具体模组，例如 `mod.xxx.SomeClass.method`。
   - `VM Arguments:`：确认实际生效的 JVM 参数是否正确。
2. 若 `Problematic frame` 是显卡驱动 DLL（`nvoglv64.dll`、`atio6axx.dll`、`ig*icd64.dll` 等）：按 [[crash-access-violation-driver]] 处理（更新/回退驱动、关光影定位）。
3. 若 `Problematic frame` 是某个模组携带的原生库或 `lwjgl.dll`：在 `Java frames` 中找出进入原生代码的模组，移除或升级它。
4. 若 `Problematic frame: J ...` 指向 Java 代码：说明是模组 Java 层 bug（常见于复杂渲染/并发），升级该模组并向作者附上此日志。
5. 若 `Problematic frame` 为 `[jvm.dll+...]` 且 `VM Arguments` 里有可疑参数：恢复到启动器默认参数重试（尤其是自定义 GC 参数、`-XX:+UseZGC`、大量 `-XX:` 调优参数）；把该 hs_err 提交给 Java 发行版项目。
6. 排查期间修改的参数（超频、驱动、模组）要一次只改一项，便于确认是哪一项生效。

## 验证

修复后重复触发原场景，不再生成新的 `hs_err_pid*.log`，游戏进程退出码为 0；若仍旧生成，日志中的 `Problematic frame` 应指向同一模块（否则说明是随机性问题，需继续排查）。

## 相关内容

- [[crash-access-violation-driver]]
- [[crash-exit-codes]]
- [[java-memory-flags]]
- [[crash-read-crash-report]]
