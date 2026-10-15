---
id: server-performance-tuning
title: 服务端性能调优：TPS / MSPT、Aikar flags 与预生成
category: server
tags: [性能, TPS, MSPT, Aikar, 卡顿, Can't keep up, 预生成, Chunky, view-distance, GC, 服务端, Spark]
summary: 用 TPS/MSPT 指标定位服务端卡顿，从 JVM 参数（Aikar flags）、世界预生成、视距与实体限制三个层面做有效优化。
updatedAt: 2026-10-04
---

## 症状

- 控制台反复刷 `Can't keep up! Is the server overloaded? Running 12345ms or 247 ticks behind`；
- 玩家反馈无故回弹、方块放置延迟、怪物卡住、箱子打不开；
- `/tps` 显示低于 20（如 18.5），`/mspt` 高于 50；
- 服务器重启后很正常，几小时内逐渐变差。

## 原因

- Minecraft 服务端每 Tick 50ms 预算，20 TPS 为满速。MSPT（每 Tick 毫秒数）持续 >50 或出现尖峰，就会掉 TPS。常见来源：大量实体/掉落物、密集红石与机器、区块生成（跑图）、GC 停顿、磁盘 IO 抖动。
- JVM 侧：堆设置不当（过小频繁 GC、过大单次停顿长）、GC 选择不当、`-Xmx` 与物理内存不匹配。
- 世界侧：未预生成就长期跑图，新区块生成是最重的操作；刷怪/掉落物堆积；`view-distance` 过大导致区块加载/卸载开销。
- 服务器侧：插件/模组本身低效；`sync-chunk-writes=true` 造成磁盘写入阻塞（传统方案会关掉它）。

## 解决方案

1. **先量化**：安装 Spark（或 Paper 自带 `/tps`、`/mspt`）跑一份 profiler，确认是哪个维度卡（实体、区块生成、插件、GC）。不要凭感觉加参数。
2. **JVM 参数（Aikar flags）**：以 8G 堆为例（按实际内存改 `-Xms`/`-Xmx`，其余保持一致）：

```
java -Xms8G -Xmx8G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch
-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M
-XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4
-XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90
-XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem
-XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true
-jar server.jar nogui
```

   堆保持 `-Xms`=`-Xmx`；小服 4–6G 起步即可，给系统留足内存。
3. **预生成世界**：用 Chunky（插件/模组均有）在开荒期预生成主世界与常用维度（例如半径 3000–5000 区块），之后日常在线就不会频繁触发区块生成尖峰。预生成期间限制玩家跑图。
4. **调参**：`view-distance` 6–8、`simulation-distance` 4–6；Paper 的 `paper-world-defaults.yml` 中可调实体激活范围与刷怪上限；`spigot.yml` 的 `merge-radius` 合并掉落物；`max-tick-time=-1` 只用于避免 Watchdog 误杀（需自行监控，不是优化）。
5. **限制浪费**：实体清理（`/kill @e[type=item]` 慎用）、漏斗矿车/大量漏斗改用其他方案、刷怪塔加开关、卸货区用区块加载器按需加载。
6. **磁盘**：把世界放在 SSD；定期重启（每日）是治标，但配合上面各点可显著降低恶化速度。
7. **模组/插件排查**：二分法禁用插件/模组定位元凶；注意单个低效模组（如大范围扫描实体的脚本）足以压垮整服。

## 验证

`/tps` 稳定在 19.9–20.0，`/mspt` 平均 <50 且 95 分位接近平均值；`Can't keep up` 警告消失；玩家操作无回弹；Spark 报告显示主要 tick 时间占比回归合理（区块生成/实体占比明显下降）。

## 相关内容

- [[server-setup]]
- [[server-connection-troubleshooting]]
- [[graphics-fps-tuning]]
- [[server-core-selection]]
