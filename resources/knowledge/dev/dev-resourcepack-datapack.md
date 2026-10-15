---
id: dev-resourcepack-datapack
title: 资源包 / 数据包开发规范（目录、pack.mcmeta、版本差异）
category: dev
tags: [资源包, 数据包, datapack, pack.mcmeta, pack_format, 模型, blockstates, 函数, reload, 1.20.5, 组件, 开发]
summary: 资源包与数据包的目录规范、pack.mcmeta 写法、常见 JSON 结构，以及 1.20.5+ 组件/1.21.x 目录改名等跨版本差异。
updatedAt: 2026-10-02
---

## 症状

- 自建资源包进游戏标红或提示格式不支持；
- 数据包通过 `/datapack list` 能启用但函数不执行、配方不生效；
- `/reload` 报解析错误，只说某文件某行有问题；
- 从 1.20 复制到 1.21 的数据包突然全部失效。

## 原因

两者都是「按固定目录与 JSON schema 加载」的资源：

- **资源包**（客户端，`resourcepacks/`）：根目录必须直接有 `pack.mcmeta` 与 `assets/<命名空间>/...`；1.13 起目录扁平化并使用了新的复数/单数命名（`textures/block`、`models/item`、`blockstates`、`lang`、`sounds.json`、`font` 等）。
- **数据包**（服务端/世界，`saves/<世界>/datapacks/` 或 `config/` 下）：根目录有 `pack.mcmeta` 与 `data/<命名空间>/...`，服务内容如 `functions`、`loot_tables`、`recipes`、`structures`、`tags`、`advancements`、`predicates`。
- **版本格式**：资源包与数据包的 `pack_format` 是两套独立编号，都随版本频繁变动。1.20.5 起物品 NBT 改为数据组件（`components`）；1.21.x 进一步调整数据驱动内容（如附魔、画变种）与目录命名。跨版本沿用旧 schema 会出现「加载失败/解析错误」。
- 数据包的 `minecraft:load` / `minecraft:tick` 是函数标签，用于每加载/每 tick 执行入口。

## 解决方案

1. 最小资源包：
   - `pack.mcmeta`：`{"pack":{"pack_format": <对应数字>, "description": "..."}}`（对照表见 [[resourcepack-not-working]]）；
   - `assets/<命名空间>/textures/...`、`models/...`、`lang/zh_cn.json`（键值对形式的翻译）；
   - 方块/物品模型：`blockstates/<id>.json` 描述状态到模型的映射（`variants` 或 `multipart`），`models/block/<id>.json` 用 `parent`+`textures`（简单方块）或 `elements`（自定义几何）。
2. 最小数据包：
   - `pack.mcmeta`（同样的字段，但 `pack_format` 用数据包版本号）；
   - `data/<命名空间>/function/<name>.mcfunction`（目录名以对应版本为准，1.21.2 前后有复数→单数的调整，务必按目标版本检查）；
   - 自动执行：`data/minecraft/tags/function/load.json` 与 `tick.json` 中列出函数 id（旧版本目录名为 `tags/functions`）。
3. 调试入口：资源包改完按 `F3+T` 重载；数据包在游戏内执行 `/reload`，聊天栏与控制台会给出出错文件与大致行号；服务端数据包同样用 `/reload`。
4. 跨版本迁移流程：先确认目标版本的 pack_format、目录命名与 JSON schema（以 Minecraft Wiki 的 Pack format / Data pack 页面为准）；从简单内容（配方、函数）开始逐项验证，不要一次迁移全部内容。
5. 1.20.5+ 重点差异：物品堆叠的 NBT 改为 `components`；`predicate` 结构与 loot function 的写法调整；1.21 增加数据驱动附魔等。迁移时优先用官方数据生成器或对应版本的示例包核对。
6. 发布规范：命名空间用小写字母/数字/下划线；资源包 zip 根目录不能多套一层文件夹；数据包可打包成 zip 或目录放入 `datapacks/`。

## 验证

资源包在列表中不标红并正确显示自定义材质/文本；数据包 `/datapack list` 显示为已启用，`/function <命名空间>:<名字>` 可手动执行且 `/reload` 无报错；重载后行为一致。

## 相关内容

- [[resourcepack-not-working]]
- [[resourcepack-conflict-order]]
- [[dev-fabric-mod]]
- [[pack-format-structure]]
