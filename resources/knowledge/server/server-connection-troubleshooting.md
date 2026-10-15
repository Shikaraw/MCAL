---
id: server-connection-troubleshooting
title: 连不上服务器的排查（Connection refused / timed out / ReadTimeout）
category: server
tags: [连不上, Connection refused, ConnectException, timed out, ReadTimeoutException, Failed to verify username, whitelist, Outdated client, 端口, 防火墙]
summary: 按报错文本区分「服务端没开、端口不通、网络抖动、版本不符、正版验证失败」五类原因，逐层排查到能连接为止。
updatedAt: 2026-10-05
---

## 症状

客户端连接服务器失败，常见提示：

```
io.netty.channel.AbstractChannel$AnnotatedConnectException: Connection refused: no further information:
java.net.ConnectException: Connection timed out: no further information:
Internal Exception: io.netty.handler.timeout.ReadTimeoutException
Internal Exception: java.io.IOException: An existing connection was forcibly closed by the remote host
java.net.UnknownHostException: play.example.com
Disconnected: Outdated client! Please use 1.20.1
Disconnected: Outdated server! I'm still on 1.20.4
Failed to verify username!
You are not whitelisted on this server!
```

## 原因

- **Connection refused**：地址能到达但目标端口没有服务监听——服务器没开、端口写错、监听在别的地址（只绑了 `127.0.0.1`）、防火墙主动拒绝。
- **timed out**：目标端口完全无响应——安全组/防火墙丢包、路由器未做端口转发、运营商 CGNAT、服务端程序假死。
- **ReadTimeout / 连接被强制关闭**：能连上但通信中断——网络抖动、穿透不稳定、服务端卡顿（`Can't keep up`）、模组/协议不匹配。
- **UnknownHostException**：域名解析失败——域名拼错、域名未解析、DNS 被污染（用 IP 直连验证）。
- **Outdated client/server**：客户端与服务端游戏版本不一致；模组服一般是「模组集合不一致」。
- **Failed to verify username!**：服务端 `online-mode=true` 时无法访问 Mojang 会话服务器（服务端网络问题），玩家会被踢。
- **whitelist**：服务器开了白名单但该玩家未加入 `whitelist.json`。

## 解决方案

1. 用报错文本分流：
   - refused → 去服务端确认进程还在、`server-port` 与连接地址端口一致、`server-ip` 是否被限制为 `127.0.0.1`；
   - timed out → 依次检查安全组/防火墙、路由器端口转发、ISP 是否有公网 IP；不确定就用内网穿透做对照测试；
   - ReadTimeout → 检查服务端是否在卡顿（看控制台 `Can't keep up`），换穿透线路，或让服务端也 ping 一下；
   - UnknownHost → 换 IP 直连测试，确认域名与解析。
2. 版本不一致：客户端换到服务器版本（或反过来），模组服要求「同一套模组 + 同一加载器版本」。
3. `Failed to verify username!` 属服务端问题：给服务器配置可访问 `sessionserver.mojang.com` 的网络/代理，或临时改 `online-mode=false` 测试（不推荐长期离线）。
4. 白名单：控制台执行 `whitelist add <玩家名>`（注意区分大小写与正版 ID），再 `whitelist reload`。
5. 服务器满员：看 `max-players`，或玩家被 `player-idle-timeout` 踢下线。
6. 模组服「能进服但秒断」：把模组集合对齐（缺失/多余都会断开），客户端与服务端均用同版本加载器；错误详情看客户端 `logs/latest.log` 与服务器控制台的 Disconnect 原因。
7. 自建服务端在云主机上时：确认控制台安全组已放行 TCP 25565（这是「服务器能看到 Done 但外部连不上」的第一原因）。

## 验证

客户端能稳定在线 10 分钟以上、无 ReadTimeout 踢出；服务器控制台看到玩家加入与退出消息；双方日志无验证/版本错误。

## 相关内容

- [[server-setup]]
- [[server-core-selection]]
- [[launcher-login-modes]]
- [[server-performance-tuning]]
