---
id: resourcepack-not-working
title: 资源包不生效 / 提示格式不兼容（pack_format 对照）
category: resourcepack
tags: [资源包, 材质包, pack_format, pack.mcmeta, 不生效, 不兼容, Pack format, 1.20.2, 1.21, 红色, 扁平化]
summary: 资源包被标红提示格式不兼容、启用后材质没变化时，按 pack_format 对照表修改 pack.mcmeta，并检查 1.13 扁平化后的目录结构。
updatedAt: 2026-10-04
---

## 症状

- 资源包放进 `resourcepacks/` 后列表里显示但被**红色高亮**，悬停提示格式不受支持（如 `Pack format 99 is not supported`）；
- 能启用但材质、音效、字体完全没变；
- 只有部分文件生效，另一些显示紫黑格子（missing texture）；
- 整合包自带的资源包在游戏里却「用不了」。

## 原因

- **pack_format 不匹配**：`pack.mcmeta` 里的 `pack_format` 数字必须落在游戏当前支持范围内。MC 每次小版本调整资源包格式号，跨版本直接启用会被拒绝（红色）。
- **1.13 扁平化**：资源包目录从 `assets/minecraft/textures/blocks` 改为 `textures/block`（复数变单数、合并/改名）等；为 1.12.2 写的包在 1.13+ 上路径全部失效。
- **zip 结构错误**：压缩包里多套了一层文件夹（如 `MyPack/MyPack/pack.mcmeta`），游戏把外层当根目录就找不到 `pack.mcmeta`。
- **1.20.2+ 起支持 `supported_formats` 范围**：老包没有这个字段时，只能用与 `pack_format` 精确匹配的版本区间，跨小版本就标红。

## 解决方案

1. 对照 pack_format（资源包）表确认目标数字：

   | 游戏版本 | pack_format |
   | --- | --- |
   | 1.6.1–1.8.9 | 1 |
   | 1.9–1.10.2 | 2 |
   | 1.11–1.12.2 | 3 |
   | 1.13–1.14.4 | 4 |
   | 1.15–1.16.1 | 5 |
   | 1.16.2–1.16.5 | 6 |
   | 1.17–1.17.1 | 7 |
   | 1.18–1.18.2 | 8 |
   | 1.19–1.19.2 | 9 |
   | 1.19.3 | 12 |
   | 1.19.4 | 13 |
   | 1.20–1.20.1 | 15 |
   | 1.20.2 | 18 |
   | 1.20.3–1.20.4 | 22 |
   | 1.20.5–1.20.6 | 32 |
   | 1.21–1.21.1 | 34 |
   | 1.21.2–1.21.3 | 42 |
   | 1.21.4 | 46 |

   更高的 1.21.x 小版本还会继续上调，以 Minecraft Wiki 的 Pack format 页面为准。
2. 修改方法：用 7-Zip 打开资源包 zip，编辑 `pack.mcmeta`（或解压后改完再压缩）。新格式示例：`{"pack":{"pack_format": 34, "description": "My Pack"}}`；1.20.2+ 可加 `"supported_formats": [15, 34]` 让包在多个版本可用。
3. 检查目录结构：zip 根目录应直接包含 `pack.mcmeta` 与 `assets/`；多一层就重新打包。
4. 1.13+ 检查路径：`textures/block`、`textures/item`、`models/block`、`blockstates`、`lang` 等；把旧包的 `textures/blocks` 手改过来只对部分文件有效，完整移植需要处理重命名映射。
5. 只变了部分材质时，用资源包里的文件路径与游戏实际需要的路径逐一核对（紫黑格子对应的就是缺路径/缺文件）。
6. 整合包自带的资源包若被禁用，在资源包界面手动启用；部分整合包用模组（如 ResourcePackOverrides）锁定顺序，属正常现象。

## 验证

资源包在列表中不再标红，启用后材质/音效按预期变化；`logs/latest.log` 里不再出现资源包加载失败信息；游戏内按 `F3+T` 重载后同样生效。

## 相关内容

- [[resourcepack-conflict-order]]
- [[dev-resourcepack-datapack]]
- [[resourcepack-hd-vram]]
