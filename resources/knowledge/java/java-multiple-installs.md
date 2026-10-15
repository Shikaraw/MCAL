---
id: java-multiple-installs
title: 多个 Java 共存导致选错 Java
category: java
tags: [Java, 多版本, 选错Java, PATH, JAVA_HOME, 启动器, 版本不对, 环境变量]
summary: 机器上装了多个 Java 时，游戏或用命令行工具可能选到错误的那个；本文说明启动器如何指定 Java、PATH/JAVA_HOME 的影响与验证方法。
updatedAt: 2026-10-09
---

## 症状

- 明明装了 Java 21，游戏仍报 `Unsupported class file major version 61`；
- 命令行 `java -version` 显示的版本与预期不同；
- 装了新版 Java 后，用命令行启动 Forge 服务端却报老版本才有的错误；
- 启动器 Java 下拉列表里有好几个路径，分不清该选哪个。

## 原因

Windows 上 Java 的查找有两条途径：

1. **PATH 环境变量**：`java` 命令按 PATH 中顺序找第一个匹配的 `java.exe`。安装新 Java 时勾选了「Set JAVA_HOME / 更新 PATH」的会覆盖排序，Windows 系统里旧的路径（如 `C:\Program Files (x86)\Common Files\Oracle\Java\javapath`）常常排在最前面，导致 `java -version` 显示的仍是旧版本。
2. **启动器自己的 Java 配置**：现代启动器（HMCL、PCL、Prism、官方启动器）都有「Java 路径 / 自动检测」设置，优先级高于 PATH。

`JAVA_HOME` 只被部分构建工具（Gradle、Maven）和脚本使用，游戏本身不读它，但用命令行跑 `gradlew`、Forge 服务端脚本时会用到。

## 解决方案

1. 在启动器的实例设置里**显式指定 Java 可执行文件路径**（`javaw.exe` / `java.exe` 的完整路径），不要用「自动」；每个实例按其游戏版本选择（[[java-version-matrix]]）。
2. 找到机器上的 Java：文件资源管理器查看常见目录，如 `C:\Program Files\Java\`、`C:\Program Files\Eclipse Adoptium\`、`C:\Program Files\Microsoft\jdk-21*`、启动器自带的 `runtime` 目录（官方启动器会把 Java 放在 `.minecraft\runtime\`）。
3. 验证单个 Java 的版本：在 cmd 里执行 `"C:\Program Files\Eclipse Adoptium\jdk-21.0.1\bin\java.exe" -version`，输出应包含 `openjdk version "21.0.1"` 与 `64-Bit`。
4. 命令行场景下把 PATH 里正确的 Java 目录上移（系统属性 → 高级 → 环境变量 → 编辑 PATH），或干脆用绝对路径；`JAVA_HOME` 指向 JDK 根目录（如 `C:\Program Files\Eclipse Adoptium\jdk-21.0.1`），不要带 `\bin`。
5. 不要卸载「其他版本」：1.8 与 21 共存是正常需求。只需保证每个实例配置正确。
6. 想排查「启动器到底用了哪个 Java」：看 `latest.log` 开头的 `Running Java ... (版本)` 行，或 F3 界面的 Java 信息。

## 验证

启动实例后，`latest.log` 中的 Java 版本与你在启动器中指定的完全一致（含位数 64-Bit）；命令行执行的 `java -version` 与 PATH 设置一致；两者互不干扰，1.12.2 与 1.21 两个实例都能正常启动。

## 相关内容

- [[java-version-matrix]]
- [[java-install-verify]]
- [[java-unsupported-class-version]]
- [[launcher-launch-pipeline]]
