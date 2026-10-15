---
id: launcher-login-modes
title: 三种登录方式（微软正版 / 离线 / 外置）与风险
category: launcher
tags: [登录, 微软登录, 正版, 离线模式, 外置登录, authlib-injector, Invalid session, Failed to verify username, 账号安全]
summary: 微软正版、离线模式、外置登录各自的原理、能进哪些服务器，以及 Invalid session 与正版验证失败的排查。
updatedAt: 2026-10-07
---

## 症状

- 连接服务器时报 `Failed to log in: Invalid session (Try restarting your game)`；
- 服务器控制台报 `com.mojang.authlib.GameProfile`/`Failed to verify username!`，玩家被踢出；
- 离线登录进正版服务器被提示 `Invalid session`、`You are not authenticated` 或直接 `Disconnected`；
- 想把单人存档挂到第三方验证服，不知道外置登录是什么。

## 原因

启动器生成三种身份：

- **微软正版登录**：走 Microsoft OAuth（设备码/浏览器授权）→ Xbox Live → Minecraft 服务，最终拿到 `accessToken`（约 24 小时有效）与 `uuid`。它的本质是「让 Mojang 会话服务器能验证你」。Token 过期、系统时间偏差大、代理/网络阻断都会导致 `Invalid session`。
- **离线模式（Offline）**：用户名任意，UUID 由用户名哈希派生，token 是伪造值，只对本机/局域网与 `online-mode=false` 的服务器有效。**不能进正版服务器**（在线模式服务器会拒绝验证），也没有皮肤（除非装了皮肤模组或服务器支持）。
- **外置登录（authlib-injector）**：通过 `-javaagent` 注入，把 Mojang 认证 API 替换为第三方验证服（如各类皮肤站/私服登录服）。玩家在第三方注册后由其签发 token；正版服务器不认，仅适配支持它的服务器。

## 解决方案

1. **Invalid session** 处理顺序：
   - 正版账号：退出启动器重新登录一次拿到新 token；检查系统时间是否准确（误差大直接失败）；
   - 使用代理/VPN 时切换节点或直连（Xbox/Minecraft 认证域名被挡时会登录失败）；
   - 服务器侧问题：服务器无法访问 `sessionserver.mojang.com`（常见于国内服务器未配代理），玩家会看到 `Failed to verify username!`，需服务端解决；
   - 确认游戏版本与服务器版本匹配（不匹配通常是 `Outdated client/server`，不是 Invalid session）。
2. 正版服务器（`online-mode=true`）必须使用微软正版登录；离线模式只用于单人、局域网和自己的离线服务器。
3. 外置登录：在第三方验证站注册并将「认证服务器地址」填入启动器的外置登录设置；启动器会生成 `-javaagent:authlib-injector.jar=<地址>` 参数。只在你信任该验证站时使用。
4. 账号安全：不要在多个启动器里反复登录同一账号导致 token 互踢；不要把正版账号分享给他人（违反 EULA，可能被限制）；不要使用「黑卡/共享号」。
5. 皮肤与披风：离线登录没有官方皮肤，可用支持的自定义皮肤模组；正版登录在服务器与客户端都会正确显示皮肤。
6. 记录身份信息排查时，注意 `logs/latest.log` 可能包含 token 片段，分享日志前先删除/打码。

## 验证

正版登录后能加入 `online-mode=true` 的公开服务器；`F3` 或服务器列表能看到正确的玩家名；不再出现 `Invalid session`。离线登录能进自己的离线服务器与单人世界。

## 相关内容

- [[launcher-launch-pipeline]]
- [[server-connection-troubleshooting]]
- [[server-setup]]
- [[crash-exit-codes]]
