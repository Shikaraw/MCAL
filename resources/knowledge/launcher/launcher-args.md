---
id: launcher-args
title: JVM 参数与游戏参数详解（怎么改、哪些别碰）
category: launcher
tags: [JVM参数, 游戏参数, -Xmx, -Xms, Aikar, GC, Unrecognized VM option, 内存, java, 启动参数, 命令行]
summary: 启动器里「JVM 参数」与「游戏参数」作用完全不同：前者给 Java 虚拟机，后者给 Minecraft 本体；附常见错误写法与推荐参数。
updatedAt: 2026-10-07
---

## 症状

- 启动报 `Unrecognized VM option 'UseZGC'` 或 `Unrecognized VM option`，JVM 直接退出；
- 填了 `-Xmx 4G` 但内存没变，或游戏还是 OOM；
- 想开全屏/指定窗口大小但不知道加在哪里；
- 加了内存参数后游戏反而启动更慢或卡顿。

## 原因

一次启动的命令行形如：

```
java [JVM 参数] -cp <classpath> <mainClass> [游戏参数]
```

- **JVM 参数**：给 Java 虚拟机，必须在 `-cp`/主类之前。包括内存（`-Xms`/`-Xmx`）、GC（`-XX:+UseG1GC` 等）、系统属性（`-D` 开头）。不同大版本 Java 支持的参数不同——Java 8 没有 ZGC，写上就会 `Unrecognized VM option` 直接失败。
- **游戏参数**：给 Minecraft 本体，如 `--username`、`--version`、`--gameDir`、`--assetsDir`、`--uuid`、`--accessToken`、`--width`、`--height`、`--fullscreen`。其中身份相关参数由启动器自动填充，玩家自定义的窗口类参数直接追加即可。
- 两者的常见错误都是**格式**：`-Xmx` 与数值之间不能有空格（`-Xmx 4G` 是错的，正确是 `-Xmx4G`）。

## 解决方案

1. 内存参数写在启动器「JVM 参数 / Java 参数」里，格式 `-Xmx4G -Xms4G`（`-Xms` 与 `-Xmx` 设成相等可减少堆扩张抖动；一般游戏只调 `-Xmx` 也够）。
2. 推荐的基础 GC 参数（Java 8+ 的 G1，Aikar 方案，按堆大小改前两项，其余照抄）：

```
-Xms4G -Xmx4G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch
-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M
-XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4
-XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90
-XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem
-XX:MaxTenuringThreshold=1
```

   1.12.2 及更老版本可用 Java 8 默认 GC（不写任何 GC 参数），或上述 G1 方案。
3. 不要盲目加参数：`-XX:MaxMetaspaceSize` 设太小会导致加载大量模组时报 `OutOfMemoryError: Metaspace`，不写即为动态扩展（推荐）。
4. 编码与日志相关：中文 Windows 下可加 `-Dfile.encoding=UTF-8`；现代版本（1.18+）如遇中文乱码问题优先检查日志编码与字体。
5. 游戏参数：窗口大小用 `--width 1280 --height 720`；全屏用 `--fullscreen`；参数中有空格的内容要用引号包住。这些应写在启动器的「游戏参数 / 附加参数」而非 JVM 参数区。
6. 排查方式：启动后在任务管理器 → 详细信息 → 找到 javaw.exe 右键「打开文件所在位置」→ 属性看不到命令行，可用 Process Explorer 或启动器日志查看完整命令行；`logs/latest.log` 开头也会记录部分环境信息。

## 验证

启动器日志中命令行显示参数已生效且格式正确；游戏内 `F3` 显示的内存上限与 `-Xmx` 一致（右上角内存条满格对应 `-Xmx`）；不再出现 `Unrecognized VM option` 类启动失败。

## 相关内容

- [[java-memory-flags]]
- [[java-multiple-installs]]
- [[launcher-launch-pipeline]]
- [[crash-out-of-memory]]
