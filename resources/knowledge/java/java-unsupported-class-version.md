---
id: java-unsupported-class-version
title: UnsupportedClassVersionError（class file major version 61/65）
category: java
tags: [UnsupportedClassVersionError, class file major version, Java, 崩溃, major version 61, major version 65, 版本不对]
summary: 报错 Unsupported class file major version 61（Java 17）或 65（Java 21）时，说明实际运行的 Java 版本低于游戏/模组编译版本，按对照表更换 Java 即可。
updatedAt: 2026-10-08
---

## 症状

启动时立即失败，控制台或 `logs/latest.log` 出现：

```
java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only recognizes class file versions up to 52.0
```

或在使用较新 Java 搭配老工具时被 ASM 拦住：

```
java.lang.IllegalArgumentException: Unsupported class file major version 65
```

## 原因

class 文件版本号与 Java 主版本一一对应：**52 = Java 8，55 = Java 11，60 = Java 16，61 = Java 17，65 = Java 21，66 = Java 22**。

- `class file version 61.0 ... up to 52.0` 意味着：游戏/模组是用 Java 17 编译的，而你实际用 Java 8（52）在跑 → 换 Java 17。
- `Unsupported class file major version 65` 则是相反方向：运行环境（旧版 Mixin/ASM/加载器）不认识 Java 21 的 class 文件，说明要么游戏版本不够新（1.20.5 之前的加载器不支持 Java 21，应换回 Java 17），要么升级加载器/模组版本。
- 两者都是「版本错位」问题，而不是文件损坏。

## 解决方案

1. 先确定游戏版本需要的 Java：1.20.5+ → Java 21；1.18–1.20.4 → Java 17；1.17 → Java 17；1.13–1.16.5 → Java 8。完整对照见 [[java-version-matrix]]。
2. 在启动器的实例设置里指定正确的 Java 路径，**不要依赖系统默认**（系统里可能装了多个 Java）。
3. 报 `major version 61/65` 且提示指向「模组」时，说明该模组要求 Java 17/21：确认游戏版本是否真的支持该 Java；若游戏版本正确，就是模组装错了版本（下载适配当前游戏版本的模组文件）。
4. 报 `Unsupported class file major version 65` 且游戏是 1.20.5 之前：换回 Java 17，或升级整个实例到 1.21。
5. 老版本（1.12.2）用 Java 17/21 会因 LaunchWrapper 等工具不支持而失败，必须换回 Java 8。
6. 改完 Java 后清理启动器缓存中的「natives 目录」不必手动处理——启动器会按 Java 重新解压；但要确认启动器没有把 Java 路径写死在每个实例的配置中。

## 验证

启动游戏，`latest.log` 开头显示 `Running Java <版本> (与所选一致)`，不再出现 `UnsupportedClassVersionError` 或 `Unsupported class file major version`，能正常进入主菜单。

## 相关内容

- [[java-version-matrix]]
- [[java-multiple-installs]]
- [[java-install-verify]]
- [[crash-noclass-nosuchmethod]]
