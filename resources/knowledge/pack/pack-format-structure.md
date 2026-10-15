---
id: pack-format-structure
title: 整合包格式解析（CurseForge / Modrinth / MultiMC / HMCL）
category: pack
tags: [整合包, 格式, CurseForge, manifest.json, Modrinth, modrinth.index.json, MultiMC, mmc-pack.json, HMCL, 导入失败, overrides]
summary: 四种主流整合包格式的内部结构与导入失败的常见原因，便于手动修复或迁移整合包。
updatedAt: 2026-10-02
---

## 症状

- 导入整合包后模组缺失、版本不对，或启动直接报 `Missing or unsupported mandatory dependencies`；
- 想手动安装整合包但不知道 `overrides` 目录怎么用；
- 换了启动器后整合包打不开；
- 整合包文件（zip）里明明有模组，安装后 `mods` 目录却是空的。

## 原因

主流整合包本质是「清单 + 覆盖文件」：

- **CurseForge（CurseForge manifest）**：zip 根目录 `manifest.json`，包含 `minecraft.version`、`minecraft.modLoaders`（如 `forge-47.2.0`、`fabric-0.15.0`）、`files`（每条为 `projectID` + `fileID`，指向 CurseForge 平台的文件）与 `overrides` 文件夹名。安装器需要联网按 ID 拉取文件；`projectID/fileID` 在平台下架或作者删档时就会下载失败。
- **Modrinth（.mrpack）**：`modrinth.index.json` 描述 `formatVersion`、`game`、`dependencies`（`minecraft`、`fabric-loader` 等）、`files`（含 `path`、`hashes`、`downloads` URL、`env.client/server`）以及 `overrides/`、`client-overrides/`、`server-overrides/`。
- **MultiMC / Prism（实例导出）**：`instance.cfg` + `mmc-pack.json`（组件列表 uid 与 version，如 `net.minecraft`、`net.fabricmc.fabric-loader`、`net.minecraftforge`）+ `.minecraft` 目录。
- **HMCL**：可直接导入以上格式并导出 zip 整合包，目录内保留完整 `mods`、`config` 与版本 json；旧 MCBBS 格式的包也能被 HMCL 识别导入。

导入失败的共性问题：网络（拉不到 manifest 里的文件）、平台不一致（CurseForge 包用 Modrinth 启动器装）、版本字段与实际实例不匹配、覆盖文件冲突。

## 解决方案

1. 识别格式：解压 zip 看根目录——有 `manifest.json` 是 CurseForge；有 `modrinth.index.json` 或 `.mrpack` 是 Modrinth；有 `instance.cfg`/`mmc-pack.json` 是 MultiMC 系。
2. 导入前确认启动器支持该格式（HMCL、PCL、Prism、本启动器对 CF/Modrinth 普遍支持）。
3. CurseForge 包下载失败时：换支持 CurseForge API 的启动器或配置代理/镜像；手动补文件时**必须**按 manifest 里 `fileID` 对应的版本号下载，不能随手拿最新版（版本不匹配会崩，见 [[crash-mod-version-mismatch]]）。
4. 手动安装：把 `overrides/`（或 `client-overrides/`）里的内容原样复制到实例目录（与 `.minecraft` 合并），注意其中可能包含 `config/`、`defaultconfigs/`、`resourcepacks/`、`shaderpacks/`、`options.txt`；Modrinth 包的 client-overrides 只给客户端用。
5. 导入后核对三件事：游戏版本、加载器版本、`mods` 文件数量与清单数量是否一致；不一致就要先补齐再启动。
6. 跨启动器迁移：MultiMC 导出的是完整实例（含 loader 组件），可直接导入 Prism；CurseForge 包建议在目标启动器里重新导入一次而非手拷。
7. 导出/分享自己的整合包：Modrinth 格式对文件去重与来源声明更规范，推荐优先使用。

## 验证

导入后启动器显示的 MC 版本与加载器与清单一致；`mods` 数量与清单吻合；能进入主菜单且模组列表无缺失依赖；进入世界正常。

## 相关内容

- [[pack-distribution-notes]]
- [[loader-version-matrix]]
- [[launcher-game-dirs]]
- [[crash-missing-dependency]]
