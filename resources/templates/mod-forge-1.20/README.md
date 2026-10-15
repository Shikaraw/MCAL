# {{modName}}（Forge / MC 1.20.1）

由 MCAL 项目脚手架生成的 Forge 模组工程，结构对齐官方 MDK。

- 模组 id：`{{modid}}`
- 主类：`{{package}}.{{ModClassName}}`
- 目标环境：Minecraft 1.20.1，Java 17
- 协议：{{license}}

## 目录结构

```
.
├─ build.gradle                 # ForgeGradle 构建脚本（含 runClient/runServer/runData）
├─ gradle.properties            # 版本号集中在这里
├─ settings.gradle              # 插件仓库 + foojay 工具链解析
├─ gradle/wrapper/              # 仅 properties，无二进制 jar
└─ src/main
   ├─ java/{{packagePath}}/{{ModClassName}}.java   # @Mod 主类
   └─ resources
      ├─ META-INF/mods.toml    # 模组元数据与依赖
      ├─ pack.mcmeta           # 资源包描述（Forge 要求存在）
      └─ assets/{{modid}}/lang/{en_us,zh_cn}.json
```

## 环境准备

| 项目 | 要求 |
| --- | --- |
| JDK | **17**（MC 1.20.1 要求；构建脚本用 toolchain 声明） |
| Gradle | 8.x |
| 编辑器 | IntelliJ IDEA（Minecraft Development 插件可提示 mods.toml 字段） |

## 构建

```bash
# Windows
gradlew.bat build
# macOS / Linux / Git Bash
./gradlew build
```

> 脚手架不生成 `gradle-wrapper.jar`：先执行一次 `gradle wrapper`，或直接用系统 `gradle build`。

产物：`build/libs/{{modid}}-{{modVersion}}.jar`（`-sources.jar` 不要放进 mods）。

调试运行：

```bash
./gradlew runClient    # 启动带模组的客户端
./gradlew runServer    # 启动服务端（--nogui）
./gradlew runData      # 运行数据生成器到 src/generated/resources
```

## 安装到游戏

1. 安装 **Minecraft Forge 1.20.1**（官方安装器）；
2. 把 `build/libs/{{modid}}-{{modVersion}}.jar` 复制到 `.minecraft/mods/`；
3. 启动游戏，`logs/latest.log` 里应能看到 `[{{modid}}] 模组构造完成`。

## 常见坑

1. **`Could not find net.minecraftforge:forge:1.20.1-47.x.y`**
   `gradle.properties` 的 `forge_version` 过期，去官网
   <https://files.minecraftforge.net/net/minecraftforge/forge/index_1.20.1.html> 用最新 47.x.y 替换。
2. **`mods.toml` 报字段错误 / 模组加载失败**
   - `modId` 必须与 `@Mod("...")` 完全一致；
   - `[[mods]]` 与 `[[dependencies.<modId>]]` 是 TOML 数组表语法，写错会直接解析失败；
   - 本模板的 `pack.mcmeta` 必须保留，缺失会导致资源加载异常。
3. **物品注册了但游戏里 `/give` 不到 / 创造模式看不到**
   - DeferredRegister 忘记 `ITEMS.register(modEventBus)`；
   - 语言文件 key 不对（应为 `item.<modid>.<注册名>`）。
4. **事件订阅不生效**
   注册类事件（物品/方块）挂 **mod 事件总线**，游戏内事件挂 **`MinecraftForge.EVENT_BUS`**，别混。
5. **`Unsupported class file major version 65`**
   Gradle 用了 JDK 21 而工具链要求 17；统一 IDEA 的 `Gradle JVM` 与工程 JDK。
6. **国内下载慢**
   `build.gradle` / `settings.gradle` 里预留了阿里云、BMCLAPI 加速源注释，取消注释即可；
   官方的 `maven.minecraftforge.net` 必须保留。
7. **换到 NeoForge 1.21？**
   包名、事件总线、`neoforge.mods.toml`（`mandatory` 改为 `type = "required"`）都不同，
   直接用脚手架里的 `mod-neoforge-1.21` 模板重新生成更省事。
