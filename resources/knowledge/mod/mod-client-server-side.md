---
id: mod-client-server-side
title: 客户端模组与服务端模组（Client/Server/Both 的区别）
category: mod
tags: [模组, 客户端, 服务端, 双端, side, client, server, 装错, 联机, 报错]
summary: 模组按运行位置分为仅客户端、仅服务端、双端三类；装错会崩溃或让服务器拒绝连接，本文给出判断题与常见例子。
updatedAt: 2026-10-10
---

## 症状

- 单机能用，一联机就被踢掉或连不上；
- 服务端启动时崩溃，日志显示某模组加载失败；
- 把所有模组都装进服务器后发现服务器根本起不来；
- 客户端加入服务器时看到「此服务器缺少/不需要某模组」类提示。

## 原因

Minecraft 的代码分为客户端类与服务端类。模组用元数据声明自己运行的位置：

- **仅客户端（client-only）**：如小地图、光影、HUD、按键显示、Sodium 等渲染优化。典型标记：Fabric 的 `"environment": "client"`，Forge 的 `side = CLIENT` 或依赖 `dist = CLIENT`。
- **仅服务端（server-only）**：如区块预生成、服务器性能优化、管理工具。
- **双端（both）**：内容类模组（新增方块/物品/生物）——这类必须两端都装，否则联机时客户端不认新内容。

装错的表现：仅客户端的模组装进服务端会在启动或玩家进入时崩溃（引用了不存在于服务端的渲染类）；仅服务端的模组装进客户端通常无害但通常无意义。双端模组只装一端时，可能出现「服务器不认识物品/方块」或客户端进服后被拒绝。

## 解决方案

1. 判断模组性质，优先看下载页面标注：
   - Modrinth：版本文件上有 `Client` / `Server` 标签；
   - CurseForge：侧栏「Environment」写 Client only / Server only / Client and server；
   - 或直接看元数据：Fabric 的 `fabric.mod.json` 中 `"environment": "client"`，Forge 的 `mods.toml` 中 `side`/`displayTest` 相关配置。
2. 搭建服务器时：只放「双端 + 仅服务端」模组；把仅客户端模组（小地图、光影、UI）留在客户端。
3. 创建客户端整合包时：两者都放，双端模组不可缺少。
4. 联机报「缺少模组/模组不匹配」时，对比两端的 `mods` 列表与版本：双端模组必须**版本号完全一致**（例如 Fabric 服务器与客户端都装 `sodium 0.5.8`）。
5. 如果某个仅客户端模组必须存在于服务器上（少见，例如某些协议优化），请在服务器安装它的服务端衍生版或替代品。
6. 记忆点：`mods` 目录里出现 `xxx-server.jar` / `xxx-client.jar` 之分时，按后缀各就各位。

## 验证

客户端能进入服务器并正常游玩 10 分钟以上，服务器 `latest.log` 无 `ClassNotFoundException`/`NoSuchMethodError` 指向渲染类；客户端与小地图、光影等功能均正常，服务端重启也不报模组错误。

## 相关内容

- [[mod-fabric-mod-json]]
- [[mod-forge-mods-toml]]
- [[server-connection-troubleshooting]]
- [[server-core-selection]]
