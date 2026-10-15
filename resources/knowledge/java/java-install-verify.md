---
id: java-install-verify
title: Java 环境安装与验证（32/64 位、JAVA_HOME）
category: java
tags: [Java, 安装, 验证, 32位, 64位, JAVA_HOME, 环境变量, PATH, 下载]
summary: 如何安装 Java、判断是否为 64 位、用 java -version 验证，以及 JAVA_HOME 与 PATH 的正确用法。
updatedAt: 2026-10-10
---

## 症状

- 刚装完 Java，游戏仍提示找不到 Java 或版本不对；
- 分不清电脑上装的是 32 位还是 64 位 Java；
- 想装 Java 但不知道从哪里下载、装哪个发行版。

## 原因

Minecraft 需要的 Java 是「运行环境（JRE）」级别的，但现代 Java 发行版多数只提供 JDK（包含 JRE 功能），装 JDK 完全没问题。常见坑：

- 从搜索广告/第三方站点下载到捆绑了全家桶的安装包；
- 装了 32 位版本（文件名里带 `x86`/`i586`），堆上限约 1.5 GB，跑不起新版本；
- 安装后 PATH 未更新，命令行仍是旧 Java；
- 把 `JAVA_HOME` 指向 `bin` 目录（多余），或指向 JRE 而非 JDK 导致 Gradle 构建失败。

## 解决方案

1. **下载**：到主流发行版官网下载安装包（Adoptium/Temurin、Azul Zulu、Microsoft Build of OpenJDK、Oracle JDK 均可）。选择 `x64` 的 Windows Installer（`.msi`）。
2. **安装**：一路下一步即可；安装器会询问是否设置 `JAVA_HOME` 与 `PATH`，勾选它们。
3. **验证版本与位数**：打开「命令提示符」（cmd），执行：

   ```
   java -version
   ```

   期望输出类似 `openjdk version "21.0.1" 2024-10-15` 和 `OpenJDK 64-Bit Server VM` —— **出现 `64-Bit` 即为 64 位**。若显示 `32-Bit` 或 `Client VM`，说明装错了，请卸载后换 x64 版本。
4. **明确路径**：执行 `where java` 可列出系统里所有 `java.exe` 及其顺序，用它确认哪一个是生效的。
5. **JAVA_HOME**：用于 Gradle/Maven 等构建工具，值应为 JDK 根目录（如 `C:\Program Files\Eclipse Adoptium\jdk-21.0.1`），**不要加 `\bin`**。设置后新开 cmd 执行 `echo %JAVA_HOME%` 验证。
6. **给启动器用**：在启动器的实例设置中直接指向 `...\bin\javaw.exe`（图形界面启动用 javaw 不会弹黑框；命令行调试可用 java.exe）。
7. 权限提醒：安装到 `C:\Program Files` 需要管理员权限；如果无法安装，也可以下载 zip 版解压到用户目录，手动把 `bin` 加进启动器路径。
8. 装好后按 [[java-version-matrix]] 给每个 MC 版本分配 Java。

## 验证

`java -version` 输出 64-Bit 且主版本符合预期；用绝对路径执行 `"...\bin\java.exe" -version` 同样正确；启动器实例选中该路径后游戏能进入主菜单，`latest.log` 中 `Running Java` 行的版本一致。

## 相关内容

- [[java-version-matrix]]
- [[java-multiple-installs]]
- [[java-unsupported-class-version]]
- [[dev-environment-setup]]
