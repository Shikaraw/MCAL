---
id: dev-environment-setup
title: MC 模组开发环境搭建（JDK / Gradle / 国内加速）
category: dev
tags: [开发环境, JDK, Gradle, IDEA, 加速, 镜像, Unsupported class file major version, 工具链, build 失败, JAVA_HOME]
summary: 按目标 MC 版本装 JDK、用 IDEA + Gradle Wrapper 打开模组工程，并配置国内镜像解决依赖下载失败与工具链报错。
updatedAt: 2026-10-03
---

## 症状

- 打开模组工程后 Gradle 同步失败，报 `Unsupported class file major version 65`、`Could not create task ...`；
- `Could not resolve all dependencies for configuration ':compileClasspath'` / `Could not find net.fabricmc:...`，长时间卡在 `Downloading`；
- `No matching toolchains found for requested specification: {languageVersion=17}`；
- `JAVA_HOME is set to an invalid directory`；
- `./gradlew runClient` 下载 Gradle 发行版极慢或超时。

## 原因

- **JDK 与版本不匹配**：不同 MC 版本要求不同 JDK（1.16.5 → 8，1.17–1.20.4 → 17，1.20.5+ → 21）；Gradle 自身也需要足够新的 JVM 运行，二者混用会报 Unsupported class file major version。
- **网络**：Gradle 需要从 Maven Central、Fabric/Forge/NeoForge 的 Maven 仓库、`services.gradle.org` 拉构建与依赖，国内直连普遍超时。
- **工具链（Toolchain）**：现代模板用 Gradle Java Toolchain 指定目标 JDK，本机没装对应 JDK 就报 No matching toolchains。
- **IDE 设置**：IDEA 的「Gradle JVM」与工程内 toolchain 是两个独立设置，只改一个往往仍失败。

## 解决方案

1. 安装 JDK：从 Adoptium Temurin、Azul Zulu 或 Microsoft Build of OpenJDK 下载；按需要并存多个版本（不要用 Oracle 的在线安装器捆绑软件）。
2. 用 IDE 打开工程：推荐 IntelliJ IDEA Community；`File → Open` 选择含 `build.gradle` 的根目录，让 Gradle 自动导入。
3. 配置 Gradle JVM：`Settings → Build Tools → Gradle → Gradle JVM` 选与工程匹配的 JDK（例如 1.20.1 Fabric 工程选 17/21，看模板要求）。若报 Toolchain 错误，在 `build.gradle` 或 `settings.gradle` 里声明本地已有的 JDK 路径，或安装所需版本 JDK。
4. JDK 路径：设置环境变量 `JAVA_HOME` 指向 JDK 根目录，并把 `%JAVA_HOME%\bin` 加入 PATH；命令行 `java -version`、`./gradlew -v` 都要能识别。
5. **国内加速（不改工程文件也能生效）**：在 `~/.gradle/init.gradle`（Windows 为 `C:\Users\<你>\.gradle\init.gradle`）写入镜像，把 Maven Central 等仓库替换为阿里云公共仓库：

```groovy
allprojects {
  repositories {
    maven { url 'https://maven.aliyun.com/repository/public' }
    maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
    mavenCentral()
  }
}
```

   注意：Fabric/Forge/NeoForge 的官方仓库（`maven.fabricmc.net`、`maven.minecraftforge.net`、`maven.neoforged.net`）必须保留，不要被镜像覆盖。
6. Gradle 发行版下载慢：编辑 `gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 为腾讯云/阿里云镜像地址（形如 `https://mirrors.cloud.tencent.com/gradle/gradle-8.x-bin.zip`）。
7. 验证环境：命令行运行 `./gradlew build`（Windows 用 `gradlew.bat build`），产物在 `build/libs/`；再运行 `./gradlew runClient` 启动开发客户端。

## 验证

`gradlew build` 成功生成模组 jar；`runClient` 能进入开发版游戏并加载你的模组；IDEA 中无红色依赖报错，`gradle -v` 显示的 Gradle/JVM 版本与预期一致。

## 相关内容

- [[dev-fabric-mod]]
- [[dev-forge-neoforge-mod]]
- [[java-version-matrix]]
- [[java-install-verify]]
