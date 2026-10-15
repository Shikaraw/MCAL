---
id: loader-version-matrix
title: 加载器与 MC 版本对应表（Forge / NeoForge / Fabric）
category: loader
tags: [Forge, NeoForge, Fabric, Quilt, 版本对应, 1.20.1, 1.21.1, 对应表, 装错版本, 规律]
summary: 三个主流加载器的版本号规律与支持的 Minecraft 版本对应关系，以及「模组包该用哪个加载器版本」的查询方法。
updatedAt: 2026-10-10
---

## 症状

- 下载模组时看到 `fabric-loader 0.16.x`、`neoforge-21.1.72`、`forge-1.20.1-47.2.0` 不知选哪个；
- 安装时报「加载器版本与游戏版本不匹配」或启动后模组全部报依赖缺失；
- 想把 1.20.1 的整合包在 1.21 上运行，不确定要换什么加载器。

## 原因

三个加载器的版本策略完全不同：

- **Forge**：与 MC 小版本强绑定，版本号独立递增（如 1.20.1 → 47.x，1.21.1 → 52.x）。只有发布了对应 Forge 版本的 MC 版本才能安装（历史锚点：1.7.10 → 10.13.x、1.12.2 → 14.23.x、1.16.5 → 36.2.x、1.18.2 → 40.x、1.20.1 → 47.x）。
- **NeoForge**：版本号直接沿用 MC 版本号（1.20.2 → 20.2.x、1.20.4 → 20.4.x、1.20.6 → 20.6.x、1.21 → 21.0.x、1.21.1 → 21.1.x、1.21.4 → 21.4.x 等），不支持 1.20.1 及更早。
- **Fabric**：Loader 与游戏版本解耦，同一个 Loader 版本可服务多个 MC 版本；真正绑定游戏版本的是 `intermediary` 映射与模组声明的 `minecraft` 依赖范围。Yarn 映射则决定开发期名称，与运行无关。Quilt 基于 Fabric，大多兼容 Fabric 模组，但反过来不成立。

## 解决方案

1. **先定游戏版本，再定加载器**：整合包/模组页面都会写明「Game Version」与「Mod Loader」，照抄即可，不要自行发挥。
2. 老版本（1.7.10 / 1.12.2 / 1.16.5 / 1.20.1）几乎只有 Forge 可选；1.20.2 以上两个平台按模组发布情况选；需要插件与轻量模组混合时选 Fabric。
3. 下载 Forge 时核对文件名里的两个版本号：`forge-<MC版本>-<Forge版本>-installer.jar`，两者都要对。
4. 下载 NeoForge 时直接找与 MC 版本号一致的主线（1.21.1 → 21.1.x），同主线内以 `Recommended`（推荐）版本优先，避免用 `Latest` 的 beta 构建。
5. 下载 Fabric 模组时核对 `fabric.mod.json`/下载页标注的 MC 版本区间与 Fabric API 版本；Loader 更新只影响兼容性，不改变游戏版本。
6. 换版本时按 [[loader-upgrade-downgrade]] 新建实例，不要在同一实例里换加载器大版本。
7. 具体某版本是否有 Forge/NeoForge 构建，以官方下载页（files.minecraftforge.net、neoforged.net）和整合包 manifest 为准；不要凭经验硬凑。

## 验证

启动日志/主菜单显示的加载器版本与所选一致（如 `Forge 47.2.0`、`NeoForge 21.1.x`、`Fabric Loader 0.15.x`），且模组列表无依赖或版本不符的报错。

## 相关内容

- [[loader-neoforge-vs-forge]]
- [[loader-fabric-bootstrap]]
- [[java-version-matrix]]
- [[loader-upgrade-downgrade]]
