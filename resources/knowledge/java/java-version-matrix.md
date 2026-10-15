---
id: java-version-matrix
title: Java 版本与 Minecraft 版本对照（1.20.5+ 需要 Java 21）
category: java
tags: [Java, 版本, 对照表, Java 8, Java 17, Java 21, 启动不了, 选错Java, 版本要求]
summary: 各 Minecraft 版本要求的 Java 版本完整对照表，以及「游戏起不来时到底该用哪个 Java」的判定方法。
updatedAt: 2026-10-08
---

## 症状

- 点了启动没有任何反应，或立刻退出并出现 `Unsupported class file major version 61/65`；
- 启动器用 Java 8 启动 1.20.5 报错，用 Java 21 启动 1.12.2 报错；
- 玩家问「我这个版本该装哪个 Java」。

## 原因

Minecraft Java 版对 Java 版本有硬性要求：新版本用新语法/新类库编译，用旧 Java 无法加载；反过来老模组/老启动器在新 Java 上也有兼容问题。Java 的「主版本号」与 class 文件版本号一一对应，这是排查 `UnsupportedClassVersionError` 的基础。

## 解决方案

按下表选择 Java（有模组时以「游戏版本」为准；1.20.5+ 必须 Java 21）：

| Minecraft 版本 | 需要的 Java |
| --- | --- |
| 1.6.1 及更早 | Java 6 / 7 |
| 1.7.10 – 1.12.2 | Java 8（1.7.10/1.12.2 用 8 就很稳） |
| 1.13 – 1.16.5 | Java 8（也可用 11，但模组生态普遍按 8 打包，推荐 8） |
| 1.17 – 1.17.1 | Java 16 以上（社区普遍用 17） |
| 1.18 – 1.20.4 | Java 17 |
| 1.20.5 及以后（1.21.x） | Java 21 |
| 快照 | 跟随后续正式版的要求（新快照基本都要求 Java 21） |

具体操作：

1. 打开启动器实例设置，找到「Java 路径 / Java 版本」项，为每个实例单独指定。
2. 1.8.9 及更老的版本用 Java 8 最稳；1.16.5 模组包也用 Java 8（部分整合包作者标注 Java 11 时从其说明）。
3. 1.17+ 若使用 OptiFine，注意 OptiFine 对 Java 版本同样挑剔：1.17/1.18 用 Java 17，1.20.5+ 用 Java 21。
4. Java 21 必须是 64 位；32 位 Java 堆上限约 1.5 GB，1.18+ 整合包必崩。
5. 安装多个 Java 是正常甚至推荐的：老版本实例用 Java 8、新版本用 Java 21，由启动器按实例选择（见 [[java-multiple-installs]]）。
6. 若启动器没给你选，检查其全局 Java 设置；报 `Unsupported class file major version` 时直接按 [[java-unsupported-class-version]] 处理。

## 验证

启动游戏后按 F3 打开调试界面，左上角命令行参数与「Java 版本」行会显示实际使用的 Java（例如 `Java 21.0.1`）；日志开头 `Running Java ... (21.0.1)` 与所选一致。

## 相关内容

- [[java-unsupported-class-version]]
- [[java-multiple-installs]]
- [[java-install-verify]]
- [[loader-version-matrix]]
