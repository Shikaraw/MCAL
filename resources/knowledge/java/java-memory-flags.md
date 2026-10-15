---
id: java-memory-flags
title: 内存参数怎么设置（-Xmx、32 位上限、GC 选择）
category: java
tags: [内存, Xmx, JVM参数, GC, G1, ZGC, 内存设置, 分配内存, 虚拟内存, 卡顿]
summary: -Xmx/-Xms 的正确用法、32 位 Java 约 1.5 GB 的硬上限、客户端与服务端 GC 参数的区别，以及为什么不建议把内存拉到物理内存的 50%~70% 以上。
updatedAt: 2026-10-09
---

## 症状

- 整合包卡顿，不知道给多少内存合适；
- 设置了 `-Xmx8G` 却报 `Could not reserve enough space for 8388608KB object heap`；
- 内存越大反而频繁卡顿、系统整体变慢；
- 服务端请教「Aikar flags 能不能照抄到客户端」。

## 原因

JVM 内存参数控制 Java 堆（heap）与相关区域：

- `-Xmx`：堆上限。游戏运行时的对象都放这里，装不下就是 OutOfMemoryError。
- `-Xms`：初始堆。**设置 -Xms 与 -Xmx 相同**可以减少运行中的扩容抖动（现代 JVM 下影响已经较小）。
- `-XX:MaxMetaspaceSize`：类元数据区上限，模组多时需要几百 MB，设太小会 `OutOfMemoryError: Metaspace`。
- 32 位 Java 的地址空间上限约 2 GB，实际可分配堆约 1.5–1.6 GB，超过就报 `Could not reserve enough space`。
- 除堆之外，JVM 还需要线程栈、GC 结构、Native 内存、DirectByteBuffer（光影/材质会用到），所以物理内存必须留有余量：把 -Xmx 设得比物理内存还大，操作系统会把堆换页到磁盘（虚拟内存），GC 扫描大堆 + 换页会让游戏剧烈卡顿甚至假死。

GC 选择：Java 9 以后客户端默认 G1，够用；`-XX:+UseZGC` 在超大堆（16 GB 以上）下停顿短，但小堆下不一定比 G1 快；**Aikar's Flags（G1 调优）是为服务端设计的**，客户端照抄收益有限，还可能引起卡顿。

## 解决方案

1. 按用途给内存（-Xmx）：
   - 1.12.2 及更老原版/轻量包：2–4 GB；
   - 1.16–1.18：4 GB 起；
   - 1.18 以上原版：4 GB；主流整合包：6–8 GB；
   - 256x 以上高清材质或 400+ 模组巨型包：8–10 GB；
   - 富余不多时以「物理内存的 50%~70% 为上限」试，16 GB 机器一般最多给 8–10 GB。
2. 在启动器里写成 `-Xmx6G -Xms2G` 形式；启动器提供内存滑块的直接拖滑块即可，不要同时在「JVM 参数」里再写一遍。
3. 确保使用 64 位 Java（`java -version` 含 `64-Bit`）；若报 `Could not reserve enough space`，先换 64 位再谈数值。
4. 不要手动加 `-XX:MaxMetaspaceSize`；若已有且小于 256M，删掉或改为 `-XX:MaxMetaspaceSize=512M`。
5. 客户端 GC 就用默认；确需调优再加 `-XX:+UseG1GC -XX:MaxGCPauseMillis=100`。服务端参考 [[server-performance-tuning]] 的 Aikar flags。
6. 若加大了内存仍然越玩越卡，排查内存泄漏（[[crash-out-of-memory]]）而不是无限加数值。

## 验证

游戏运行时 F3 界面与任务管理器显示堆占用量稳定低于 -Xmx；长时间游玩无 OutOfMemoryError，系统整体响应正常（切换窗口不卡顿）；`latest.log` 无 GC 相关警告。

## 相关内容

- [[crash-out-of-memory]]
- [[java-install-verify]]
- [[server-performance-tuning]]
- [[misc-common-myths]]
