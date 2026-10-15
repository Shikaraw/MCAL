---
id: loader-fabric-bootstrap
title: Fabric 加载原理与安装（profile json、无需 installer）
category: loader
tags: [Fabric, 安装, profile json, inheritsFrom, KnotClient, fabric-loader, 启动失败, Failed to download file, Fabric API]
summary: Fabric 不需要改写游戏 jar，安装等于新增一个继承原版的版本 json；理解这一点就能自行排查 Fabric 启动失败与文件缺失问题。
updatedAt: 2026-10-09
---

## 症状

- 启动器里安装 Fabric 时报 `Failed to download file` 或下载 `meta.fabricmc.net` 元数据超时；
- 启动时报 `Error: Could not find or load main class net.fabricmc.loader.impl.launch.knot.KnotClient`，或 `ClassNotFoundException: net.fabricmc.loader.impl.launch.knot.KnotClient`；
- 模组解析阶段出现 `net.fabricmc.loader.impl.FormattedException: ...`（多为缺依赖，见 [[crash-missing-dependency]]）；
- 启动器列表里有 `fabric-loader-...`，但进去发现是原版界面、模组不生效。

## 原因

Fabric 是「启动时注入」的加载器，不改写 `versions/` 里的原版 jar：

- 安装 Fabric 实际是在 `.minecraft/versions/fabric-loader-<loader>-<mc>/` 下生成一个版本 json，其中 `inheritsFrom` 指向原版版本 id，并用 `libraries` 追加 `net.fabricmc:fabric-loader`、`sponge-mixin`、intermediary 映射等；
- `mainClass` 被替换为 `net.fabricmc.loader.impl.launch.knot.KnotClient`，由它在类加载阶段插入 Mixin 与模组加载逻辑；
- 官方 Fabric Installer 只是做「请求 meta.fabricmc.net → 写 profile 与 jar」两件事；HMCL、PCL 等启动器内置了同样的逻辑，所以「不用 installer 也能装 Fabric」；
- 若上述任一库没下载全（classpath 缺 fabric-loader jar），JVM 就找不到 KnotClient 主类。

## 解决方案

1. 首选在启动器内一键安装 Fabric：选择目标游戏版本，加载器版本选推荐的稳定版（不要选标注 experimental 的）。
2. 启动失败报找不到 KnotClient 时，检查 `.minecraft/versions/fabric-loader-.../` 下的 json 是否存在、`libraries/net/fabricmc/fabric-loader/<版本>/` 下是否有 jar；缺失就删除该 profile 重新安装（而非手工凑文件）。
3. 网络原因（`Failed to download file`）：换有镜像的启动器/在启动器设置里切换下载源后重试；Fabric 元数据也可通过镜像获取。
4. 老启动器不支持 `inheritsFrom` 时，需要生成「合并后的完整版本 json」（把原版 json 与 Fabric 库合并）。现代启动器（含本启动器）均已支持，无需手工合并。
5. 装模组：Fabric 模组必须放 `mods/`，且绝大多数需要 **Fabric API**（id 为 `fabric-api`，见 [[mod-common-dependencies]]）；只装加载器不装 Fabric API 时，模组会在 `depends` 校验阶段报缺失。
6. 确认加载器与游戏版本对应：Fabric Loader 本身跨版本，但模组里的 `minecraft` 依赖范围必须匹配目标版本。

## 验证

启动后主菜单左下/右下角显示 `Fabric Loader <版本>`；`logs/latest.log` 出现 `Loading Minecraft 1.20.1 with Fabric Loader 0.15.x`；安装 Fabric API 后 `mods` 中的模组能在 Mod Menu（若已安装）中列出。

## 相关内容

- [[mod-fabric-mod-json]]
- [[crash-missing-dependency]]
- [[loader-version-matrix]]
- [[loader-forge-install-fail]]
