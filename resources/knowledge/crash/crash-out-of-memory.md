---
id: crash-out-of-memory
title: 内存不足崩溃（OutOfMemoryError）
category: crash
tags: [内存, OOM, 崩溃, Java heap space, GC overhead limit exceeded, Metaspace, 内存不足, 分配内存]
summary: 游戏因 Java 堆内存不足而崩溃或卡死，崩溃报告出现 java.lang.OutOfMemoryError 时，先分清堆太小、Metaspace 不足还是内存泄漏，再调整 -Xmx 或排查模组。
updatedAt: 2026-10-01
---

## 症状

游戏在加载世界、生成新区块或长时间游玩后崩溃、卡死甚至直接关掉窗口。`logs/latest.log` 或 `crash-reports/` 中的崩溃报告里出现下列之一：

- `java.lang.OutOfMemoryError: Java heap space`
- `java.lang.OutOfMemoryError: GC overhead limit exceeded`
- `java.lang.OutOfMemoryError: Metaspace`
- `Could not reserve enough space for 1572864KB object heap`

崩溃报告的 Description 行常见 `Exception generating new chunk`、`Ticking entity` 或 `Rendering screen`，紧接着第一行堆栈就是上面的 OutOfMemoryError。用任务管理器观察 javaw.exe，内存（内存/提交大小）会顶到 -Xmx 设置的上限附近。

## 原因

- **Java heap space**：堆内存真的不够。模组多、渲染距离大、高清材质、一次性生成大量区块都会显著抬高占用；也可能是某个模组泄漏，内存只涨不落。
- **GC overhead limit exceeded**：堆几乎被塞满，JVM 把 98% 以上时间花在 GC 却回收不出空间，是 Java heap space 的前兆。
- **Metaspace**：类元数据区耗尽。常见于启动器里手动设置了过小的 `-XX:MaxMetaspaceSize`，加载几百个模组时 Metaspace 通常要几百 MB。
- **Could not reserve enough space**：JVM 连连续地址空间都申请不到，多半是 32 位 Java（堆上限约 1.5 GB），或 -Xmx 超过系统实际能提交的内存。

## 解决方案

1. 在启动器的「JVM 参数 / 内存设置」里调整最大内存 -Xmx：1.12.2 及更老 2–4 GB；1.16–1.18 至少 4 GB；1.18 以上或大型整合包 4–8 GB；配合 128x 以上高清材质再加 2–4 GB。一般不要超过物理内存的 50%~70%。
2. 确认使用的是 64 位 Java（命令行执行 `java -version`，输出含 `64-Bit`）。若日志里是 `Could not reserve enough space`，先按 [[java-version-matrix]] 换成对应版本的 64 位 Java。
3. 若报的是 `OutOfMemoryError: Metaspace`：删掉 JVM 参数里的 `-XX:MaxMetaspaceSize=...`，或改为 `-XX:MaxMetaspaceSize=512M` 以上；迁移到 Java 17/21 通常也能缓解。
4. 若内存已加够仍在同一处溢出、且内存曲线只涨不回：禁用全部非前置模组做二分定位，重点看内存上涨时在做什么（自动刷怪、结构生成、极端机器）。
5. 临时缓解：把渲染距离降到 8–12（Options → Video Settings → Render Distance）、关闭光影和 128x 以上材质包。

## 验证

重启后进入同一场景并连续游玩 30 分钟以上，任务管理器中 javaw.exe 内存稳定在 -Xmx 限制内且不持续上涨，`latest.log` 不再出现任何 OutOfMemoryError。

## 相关内容

- [[java-memory-flags]]
- [[crash-read-crash-report]]
- [[misc-common-myths]]
- [[crash-freeze-black-screen]]
