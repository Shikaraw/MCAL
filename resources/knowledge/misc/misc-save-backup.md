---
id: misc-save-backup
title: 存档备份与损坏恢复
category: misc
tags: [存档, 备份, 恢复, level.dat, region, mca, 损坏, Chunk file at, 世界加载失败, 服务器, save-off]
summary: 存档该备份哪些文件、什么时候必须备份、损坏后如何从备份或 level.dat_old 恢复，以及区块级修复的边界。
updatedAt: 2026-10-01
---

## 症状

- 世界能列出但打开时卡在「Loading world」或直接崩溃；
- 日志出现 `Chunk file at [x, z] is in the wrong location; relocating. (Expected ..., got ...)` 或区块加载报错；
- 更新版本后旧存档打不开、出生点地形残缺；
- 服务器崩溃后世界文件损坏。

## 原因

单人存档位于 `.minecraft/saves/<世界名>/`，核心内容：

- `level.dat`（世界元数据，含版本、种子、玩家数据指针）；
- `region/*.mca`（按区域分组的区块数据）、`entities/`、`poi/`（1.14+）；
- `playerdata/`、`stats/`、`data/`（地图、记分板等）、`DIM-1`/`DIM1`（旧版本维度目录）。

服务器中世界通常为 `world/`（原版含 `world/DIM-1`、`world/DIM1`）或 Bukkit 系的 `world`、`world_nether`、`world_the_end`。

损坏来源：写入过程中断电/强杀进程、磁盘故障、用不同版本反复打开（数据格式只升不降）、手动编辑 NBT 出错。注意 `Chunk file ... in the wrong location` 往往是「移动过存档目录」导致的正常重定位提示，不一定是损坏。

## 解决方案

1. **备份时机**：版本升级前、装/卸大型模组前、服务器更新前、跑图机器大规模改建前。备份 = 复制整个 `saves/<世界名>` 或服务器 world 目录到别处（可压缩）。
2. 服务器备份流程：控制台执行 `/save-all`，然后 `/save-off`，复制 `world*` 目录，完成后 `/save-on`；不要在运行中直接复制。
3. **恢复**：把备份目录替换回 `saves/`（先改名原目录保留现场，便于对比）；确认目录名与 `level.dat` 匹配。
4. `level.dat` 损坏但存在 `level.dat_old`：关闭游戏后把 `level.dat_old` 复制为 `level.dat`（这是游戏自动保留的上一份元数据）；能进世界即成功。
5. 单个区域损坏：用备份中对应的 `.mca` 覆盖损坏文件（区域文件按坐标命名，注意维度不同文件在不同目录）。
6. 区块级救援只能靠第三方编辑器（Amulet 等）删除无法加载的区块，操作前必须先复制一份存档；地形会留下空洞，但能保住其余内容。
7. 跨版本：升级后的存档**不要**再用旧版本打开；确需降级只能用升级前的备份（见 [[loader-upgrade-downgrade]]）。
8. 日常防护：给世界开启「定期自动备份」类模组/插件；把存档目录放在可靠磁盘，避免直接放在同步网盘（写入冲突会损坏 region）。

## 验证

恢复后世界能加载、出生点与主要建筑完整、日志无区块错误；服务器 `/save-all` 与备份流程演练一次成功；能在备份目录里找到最近一次备份。

## 相关内容

- [[crash-corrupt-save]]
- [[crash-world-load]]
- [[loader-upgrade-downgrade]]
- [[launcher-game-dirs]]
