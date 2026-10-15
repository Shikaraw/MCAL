---
id: loader-forge-install-fail
title: Forge 安装失败排查（installer 报错 / 双击没反应）
category: loader
tags: [Forge, 安装失败, installer, There was an error during installation, installer.log, 403, Could not find or load main class, Java, 启动不了]
summary: Forge installer 弹窗报错、日志下载超时或双击没反应时，按 Java 版本、网络镜像、安装目录权限三步定位并完成安装。
updatedAt: 2026-10-10
---

## 症状

运行 `forge-<mc>-<forge>-installer.jar`（官方或从镜像下载）时出现以下一种或多种情况：

- 弹窗提示 `There was an error during installation`，点确定后 installer 文件夹下留下 `installer.log`；
- 控制台/日志中滚动 `Failed to download ...`、`java.net.ConnectException: Connection refused`、`java.net.SocketTimeoutException: Read timed out` 或 `HTTP response code: 403`；
- 双击 jar 完全没反应，或 Windows 弹「此应用无法在你的电脑上运行」；
- 命令行运行时报 `Could not find or load main class`、`Unsupported class file major version 61/65`。

即使 installer 显示成功，启动器里也可能找不到新增的 Forge 版本。

## 原因

Forge 的安装分两段：先由 installer 下载并校验所有前置库（Maven 坐标的 jar），再写入 `versions/` 与 `libraries/`。失败点通常有三类：

1. **Java 不匹配**：installer 由较新 Java 编译。1.17+ 的安装器要求 Java 16/17 起步，1.20.5+ 的 Forge 安装器要求 Java 21；用 Java 8 运行会直接报 Unsupported class file major version。
2. **网络**：安装所需的库托管在 `maven.minecraftforge.net` 与 `libraries.minecraft.net`，国内直连经常超时或返回 403/404；用本地镜像架设的启动器不受影响，纯官方 installer 受影响最大。
3. **权限/路径**：在 `C:\Program Files` 等受保护目录或只读磁盘上安装，写 `versions/`、`libraries/` 失败；磁盘空间不足也在此时报错。

## 解决方案

1. 确认用于安装的 Java 版本：命令行执行 `java -version`，对照 [[java-version-matrix]] 选择目标版本对应的 JDK（1.16.5 用 8，1.18–1.20.4 用 17，1.20.5+ 用 21）。
2. 改用命令行安装，方便看到真实报错：`java -jar forge-1.20.1-47.2.0-installer.jar --installClient`，失败后第一时间打开同目录下的 `installer.log`，看第一条 `Caused by`。
3. 网络类失败（连接超时、403/404）：
   - 优先改用带镜像加速的启动器（如 HMCL/PCL 内置 Forge 安装），它们会从 BMCLAPI 等镜像拉取库文件；
   - 或给 JVM 配置代理后再跑 installer；
   - 反复重试有时也能成功，但更推荐换镜像方案。
4. 把 `.minecraft` 放在用户目录（如 `D:\Minecraft\.minecraft`），不要放在 `Program Files`；确保磁盘剩余空间足够（Forge 安装通常需要数百 MB 以上）。
5. 确认 installer 与游戏版本匹配（文件名里的 `1.20.1` 必须与目标实例一致）；不要用 Forge 47.x 的安装器去装 1.19.2。
6. 安装成功后检查：`.minecraft/versions/` 下出现 `1.20.1-forge-47.2.0` 文件夹，`libraries/net/minecraftforge/` 下有对应 jar。

## 验证

启动器版本列表中能选中 `1.20.1-forge-47.2.0` 并成功启动到主菜单；主菜单出现 **Mods / Mod List** 按钮；`logs/latest.log` 开头能看到 Forge 与 ModLauncher 的版本行，没有 `Failed to download` 或 `Missing` 字样。

## 相关内容

- [[loader-version-matrix]]
- [[loader-neoforge-vs-forge]]
- [[java-version-matrix]]
- [[java-install-verify]]
