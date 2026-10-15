---
id: mod-download-safety
title: 模组下载来源与安全鉴别
category: mod
tags: [下载, 安全, 模组, Modrinth, CurseForge, 病毒, 鉴别, 依赖, jar]
summary: 学会从 Modrinth/CurseForge 官方页面下载正确文件、识别二次打包与损坏文件，避免恶意 jar 与「整合包里的奇怪模组」。
updatedAt: 2026-10-13
---

## 症状

- 从网盘/论坛下载的模组放进 `mods` 后游戏报各种奇怪错误，甚至 Windows 报毒；
- 分不清下载页上哪个文件是给 Fabric 的、哪个是给 Forge 的；
- 下载到的 jar 打不开或大小为 0 KB / 只有几 KB。

## 原因

模组分发渠道混乱是常见问题源：

- 非官方渠道的 jar 可能被二次打包，夹带修改过的代码、广告、挖矿/木马模块；
- 论坛「整合包」里常混有已改名的 jar、互相冲突的重复模组；
- 浏览器下载中断会留下 0 字节或 HTML 错误页（伪装成 jar），游戏加载时报「不是有效模组」或直接崩溃；
- 同名模组有多个平台/游戏版本文件，选错就会触发 `Incompatible mod set`。

## 解决方案

1. **只用官方渠道**：Modrinth（modrinth.com）与 CurseForge（curseforge.com/minecraft）是绝大多数模组的首发地；模组作者主页/源码仓库（GitHub Releases）也可信。
2. **正确筛选文件**：在项目「Versions / Files」页按「游戏版本 + 加载器」筛选；Fabric 模组的 jar 内有 `fabric.mod.json`，Forge/NeoForge 模组有 `META-INF/mods.toml`——用压缩软件打开看一眼即可判定平台。
3. **校验文件大小**：正常模组至少几十 KB，功能性模组常见几 MB。若为 0 KB、几百字节或能看到 HTML 内容，重新下载。
4. **警惕「整合包里的神秘 jar」**：来路不明、名字被改成 `优化.jar`、`加速.jar`、带中文拼音乱码名，且没有对应项目页的文件，建议直接删除；把 `mods` 目录按文件名排序，人工过一遍所有 jar 的来源。
5. **查依赖**：Modrinth 项目页右侧列出 Required/Embedded 依赖，CurseForge 有 Dependencies 标签；照着补齐（见 [[mod-common-dependencies]]）。
6. **杀毒软件误报**：部分模组包含原生库会被误报，但「报毒 + 来源不明」时应直接放弃该文件，不要盲目加白名单。
7. 从 CurseForge 用启动器一键安装时，注意它可能装入作者声明的额外依赖，装完检查一遍 `mods` 列表。

## 验证

`mods` 目录中每个 jar 都能在 Modrinth/CurseForge 找到对应项目与版本；游戏能启动且模组列表与下载记录一一对应；杀毒软件不再报警（若此前报警的文件已替换为官方版本）。

## 相关内容

- [[pack-distribution-notes]]
- [[mod-common-dependencies]]
- [[crash-missing-dependency]]
- [[pack-format-structure]]
