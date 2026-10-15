---
id: crash-world-load
title: 世界加载时崩溃（Failed to load world / TileEntity 相关）
category: crash
tags: [世界, 加载, Failed to load world, TileEntity, 方块实体, 崩溃, 存档, 实体]
summary: 进入世界时崩溃、堆栈指向 TileEntity/Entity 时，多为模组与被移除方块的数据不兼容或实体数据损坏；附上安全进入世界的处理步骤。
updatedAt: 2026-10-06
---

## 症状

点击「进入世界」后进度条走到某个阶段崩溃，`crash-reports/` 里出现：

```
Description: Ticking block entity
java.lang.NullPointerException: Cannot invoke "net.minecraft.world.level.block.entity.BlockEntity.getType()" because ...
```

或：

```
Description: Exception in server tick loop
...
Caused by: java.lang.NoSuchMethodError / ClassNotFoundException / IllegalStateException
```

也有 `Failed to load world`、`Exception loading entity`、`Unable to load chunk` 等描述行。有时崩溃只发生在加载进度 100% 的瞬间（此时区数已就绪，实体开始 tick）。

## 原因

1. **移除了模组但世界里还有它的方块/实体**。游戏读到未知方块的方块实体（TileEntity）id，注册表里找不到，抛异常。
2. **实体数据损坏**：某个掉落物/机器/宠物带有非法 NBT（例如被其他模组写坏），加载该实体即崩。
3. **模组版本升级导致的数据格式变化**：新版读取旧格式数据失败，常见于科技类模组。
4. **区块边界处的方块实体**：区域文件半个损坏，加载到它时崩溃（配合 [[crash-corrupt-save]] 一起判断）。

## 解决方案

1. 打开崩溃报告，看 `Description:` 行与堆栈顶部的类：`Ticking block entity` 说明方块实体 tick 崩了；`Ticking entity` 是普通实体；`Loading entity NBT` 是 NBT 反序列化失败。
2. **先装回缺失模组**：如果最近移除了模组，最省事的方案是把模组加回去启动一次，再用 `/give` 处理物品、把相关机器拆掉，然后再移除模组。
3. **不装回模组的抢救法**：用 Amulet Editor 打开世界，找到崩溃坐标附近的方块并删除（或删除整个损坏区块）；也可以在 `level.dat` 的 `Data.Player.Pos` 中把玩家坐标改到出生点以外的安全坐标。
4. **用 NBT 工具清实体**：把世界备份后，用能编辑 `entities` 数据的工具删除可疑实体；不确定时优先删除玩家附近新增的机器。
5. **世界进不去但想拿回物品**：临时安装「更多实用设备/开挂类」模组的做法有风险，推荐直接用存档编辑工具读取 `playerdata/<uuid>.dat` 恢复背包。
6. 修复后统一模组版本（同一存档使用的模组不要频繁增删），并在每次批量改模组前备份存档。

## 验证

世界能加载到可操作状态，能自由移动到崩溃点附近，`/tp` 到原崩溃坐标不再崩溃；`latest.log` 中没有 `Ticking block entity`、`Ticking entity`、`Failed to load world` 等行。

## 相关内容

- [[crash-corrupt-save]]
- [[misc-save-backup]]
- [[crash-read-crash-report]]
