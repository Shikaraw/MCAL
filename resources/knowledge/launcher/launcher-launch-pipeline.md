---
id: launcher-launch-pipeline
title: 启动器工作原理：从版本 json 到游戏进程
category: launcher
tags: [启动器, 原理, version json, libraries, assets, classpath, natives, 参数, Failed to download file, ClassNotFoundException, inheritsFrom]
summary: 一次启动实际上发生五件事：解析版本 json → 解析库与规则 → 校验资源 → 拼 classpath 与参数 → 启动 Java 进程；理解流程即可定位任何「启动失败」。
updatedAt: 2026-10-08
---

## 症状

- 启动器卡在「下载/校验文件」阶段，报 `Failed to download file: https://...`；
- 点启动后进程秒退，日志出现 `Could not find or load main class`、`java.lang.ClassNotFoundException`、`NoClassDefFoundError`；
- 游戏根目录越来越大，`assets`、`libraries` 被误删后游戏又「变回原版」；
- 同一个版本用不同启动器行为不一致。

## 原因

启动一个 Minecraft 实例（原版）本质上由启动器完成以下流水线：

1. **解析版本 json**：读取 `versions/<id>/<id>.json`。若含 `inheritsFrom`（Forge/Fabric 等），先加载原版父 json 再叠加：`mainClass`、`libraries`、`arguments` 逐层合并。
2. **解析库（libraries）**：每个库是 Maven 坐标（如 `org.lwjgl:lwjgl:3.3.1`），带 `rules` 决定当前系统是否启用（`os.name` = windows/osx/linux、`os.arch`）；`natives` 字段按系统挑出本机原生包。老版本会把 natives 解压到临时目录并用 `-Djava.library.path` 指定，1.19+ 一般直接把 natives jar 放进 classpath。
3. **校验与下载资源**：`assetIndex` 指向 `assets/indexes/<版本>.json`，逐条比对 `assets/objects/<hash 前两位>/<hash>`，缺失即下载。这是「下载中」停留最久的一步。
4. **拼参数与 classpath**：classpath 顺序为全部库 + 客户端 jar；JVM 参数与游戏参数来自 `arguments`（旧版本为 `minecraftArguments` 字符串），占位符如 `${auth_player_name}`、`${version_name}`、`${game_directory}`、`${assets_root}`、`${assets_index_name}`、`${auth_uuid}`、`${auth_access_token}`、`${user_type}` 由启动器替换为真实值。
5. **启动进程**：`java <JVM参数> -cp <classpath> <mainClass> <游戏参数>`，游戏日志写入 `logs/latest.log`。

失败点全部落在这五步里：下载失败、规则选错（装错平台的库）、classpath 缺库、参数占位符没替换全（外置登录/第三方启动器常见）、Java 版本不对。

## 解决方案

1. 定位阶段：看启动器日志/控制台停留在哪一步。`Failed to download file` → 第 3 步网络/镜像问题；`Could not find or load main class` → 第 2/4 步缺库或 mainClass 写错；秒退无日志 → 第 5 步 JVM 参数非法。
2. 校验时反复失败的个别文件：手动清理 `assets/objects` 下对应哈希文件（或整个被截断的 `.part` 临时文件）再重试；换镜像源（BMCLAPI 等）。
3. 缺库：删除该版本的获取缓存后让启动器重新解析；若是自建版本 json，检查 `libraries` 是否被误删、`rules` 是否排除了当前系统。
4. 不要手工删除 `libraries/`、`assets/` 里的文件来「省空间」——它们被所有实例共享，可通过对启动器设置重新校验来修复。
5. 多加载器版本：`inheritsFrom` 链要完整（Fabric/Forge/NeoForge 都会链到原版），缺少父版本时启动器应重新安装该原版版本。
6. 对比测试：同一实例用官方启动器/另一个启动器启动，能区分「实例文件问题」还是「启动器解析问题」。

## 验证

启动器日志中能看到从「解析版本」到「启动进程」的完整流程且无失败项；游戏进入主菜单；`logs/latest.log` 第一行显示正确的游戏版本与加载器信息。

## 相关内容

- [[crash-exit-codes]]
- [[launcher-args]]
- [[launcher-game-dirs]]
- [[loader-fabric-bootstrap]]
