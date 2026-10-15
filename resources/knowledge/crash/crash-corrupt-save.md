---
id: crash-corrupt-save
title: 存档损坏（Chunk file is corrupt）与抢救
category: crash
tags: [存档, 损坏, Chunk file, region, 坏档, 恢复, 备份, corrupt]
summary: 进入世界时报区块损坏、世界图标变灰或加载即崩时，用「备份 → 定位损坏区块 → 删区域文件 / 用工具修复」流程抢救，并说明 level.dat 的作用。
updatedAt: 2026-10-06
---

## 症状

- 选择世界时提示「世界损坏」/ 进入后立刻崩溃；
- 日志中出现 `java.io.IOException: Chunk file at 12, 34 is corrupt.`、`java.util.zip.ZipException: incorrect header check`、`Chunk file at [x, z] is missing or corrupt` 等文本；
- 世界的 `level.dat` 能被读取，但加载到特定区块时卡死或弹出「加载世界时出错」；
- 世界列表里该存档显示的图标为灰色。

## 原因

存档本体是 `saves/<世界名>/` 目录，其中：

- `level.dat`：世界的元数据（种子、时间、玩家初始化信息等），还有一份自动备份 `level.dat_old`；
- `region/r.X.Z.mca`：主世界区块，每个文件覆盖 32×32 个区块；
- `DIM-1/`、`DIM1/`（1.16 之前）或 `dimensions/minecraft/the_nether|the_end/`（1.16 起）：下界/末地的区块；
- `playerdata/`、`stats/`、`advancements/`、`data/` 等。

损坏通常由：游戏写盘时断电/强制结束进程、磁盘坏道、把存档从高版本降级打开、模组写入非法数据导致。区块数据一旦写坏，游戏读到就会抛异常。

## 解决方案

1. **先完整备份**：退出游戏，把整个 `saves/<世界名>` 复制到别处。任何修复操作前都必须有备份。
2. **用日志定位损坏区块坐标**：从报错里的 `x, z` 计算区域文件：区域文件名为 `r.<x>>5>.<z>>5>.mca`（每 512 区块一个文件，即 `Math.floor(x/32)`、`Math.floor(z/32)`）。
3. **删掉该区域文件**（牺牲范围换取能进游戏）：删除对应的 `region/r.X.Z.mca` 后启动游戏，该 512 区块范围会被重新生成为新地形，其余区域不受影响。
4. **用工具定点修复**：用 Amulet Editor 打开世界，定位损坏区块并标记删除（Amulet 支持较新版本）；老版本存档可用 NBTExplorer 逐层检查 `level.dat` 能否被解析。
5. **`level.dat` 损坏**：用同目录的 `level.dat_old` 覆盖它（两份轮流备份），再把玩家坐标改到安全位置（`Data.Player.Pos`）。
6. **降级打开造成的不兼容**：新版本存档不能直接在老版本世界打开（会丢方块甚至损坏），只能回到原版本或复制一份实验。
7. 修好后立刻开启自动备份：把整个 `saves` 目录定期复制到其他磁盘（见 [[misc-save-backup]]）。

## 验证

能进入世界并在损坏坐标附近正常移动、放置/破坏方块，`latest.log` 中不再出现 `Chunk file ... is corrupt` 与 `ZipException`，退出游戏后世界保存无报错。

## 相关内容

- [[misc-save-backup]]
- [[misc-version-system]]
- [[crash-world-load]]
