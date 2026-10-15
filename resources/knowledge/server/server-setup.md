---
id: server-setup
title: 开服必备配置：eula / server.properties / 防火墙
category: server
tags: [开服, eula, server.properties, 防火墙, 端口, 25565, online-mode, 内网穿透, 端口转发, 白名单, You need to agree to the EULA]
summary: 从零开一个 Java 版服务器的完整步骤：Java、server.jar、eula.txt、关键 server.properties 项、防火墙放行与外网访问方案。
updatedAt: 2026-10-05
---

## 症状

- 双击 `server.jar` 后窗口一闪而过，或报 `You need to agree to the EULA in order to run the server. Go to eula.txt for more info.`；
- 服务器跑起来了但朋友连不上，自己只能在本机进入；
- 刷到 `Can't keep up! Is the server overloaded?` 的警告；
- 端口冲突或提示 `FAILED TO BIND TO PORT`。

## 原因

服务端首次启动会生成 `eula.txt` 并要求同意 EULA 后才继续；`server.jar` 双击运行默认没有控制台就绪提示且 Java 参数不受控，推荐用启动脚本。外网访问受「端口是否监听 → 防火墙是否放行 → 路由器是否转发 → 运营商是否有公网 IP」四层限制。`Can't keep up` 说明单 Tick 超过 50ms，需要性能调整（见 [[server-performance-tuning]]）。

## 解决方案

1. 装对 Java：1.16.5 服务端用 Java 8，1.17–1.20.4 用 17，1.20.5+ 用 21（与客户端一致，见 [[java-version-matrix]]）。
2. 下载官方 `server.jar`（或 Paper 的 `paper-*.jar`）放到专属文件夹，写一个启动脚本：
   - Windows `start.bat`：`java -Xms4G -Xmx4G -jar server.jar nogui`；Linux/macOS：`java -Xms4G -Xmx4G -jar server.jar nogui`，建议加 `screen -S mc` 或 systemd 后台运行。
3. 首次运行后编辑 `eula.txt`，把 `eula=false` 改为 `eula=true`，重新启动。
4. 编辑 `server.properties` 的关键项：
   - `online-mode=true`（正版验证；离线服才设 false，且老玩家 UUID 会变化）；
   - `server-port=25565`（默认端口）；
   - `max-players`、`view-distance`（建议 6–8）、`simulation-distance`（4–6，1.18+）；
   - `motd`（服务器列表显示名）、`difficulty`、`gamemode`、`pvp`、`white-list=true` + `enforce-whitelist=true`（配合控制台 `whitelist add 玩家名`）；
   - `level-name`、`level-seed`（改 world 名字前先备份）；
   - `enable-command-block`、`allow-flight`（模组服常需 true）。
5. 防火墙放行 25565/TCP：
   - Windows：高级安全 Windows Defender 防火墙 → 入站规则 → 新建规则 → 端口 → TCP 25565 → 允许；
   - Linux UFW：`sudo ufw allow 25565/tcp`；firewalld：`sudo firewall-cmd --permanent --add-port=25565/tcp && sudo firewall-cmd --reload`。
6. 公网访问：路由器上把 25565 端口转发到服务器的内网 IP（记得给服务器设固定内网 IP）。若运营商不给公网 IP（大内网/CGNAT），用内网穿透（frp、playit.gg、樱花映射等）代替。
7. 内网测试：本机 `localhost:25565` 能进后，用另一台设备用「服务器内网 IP:25565」测试，最后再测公网。

## 验证

服务器控制台出现 `Done (x.xxxs)! For help, type "help"`；内网与外网（或穿透地址）均能进入；`whitelist` 生效，未加白玩家被拒绝；服务器列表能看到 MOTD 与在线人数。

## 相关内容

- [[server-core-selection]]
- [[server-connection-troubleshooting]]
- [[server-performance-tuning]]
- [[java-version-matrix]]
