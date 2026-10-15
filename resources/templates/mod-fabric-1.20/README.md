# {{modName}}（Fabric / MC 1.20.1）

由 MCAL 项目脚手架生成的 Fabric 模组工程，结构对齐官方 [fabric-example-mod](https://github.com/FabricMC/fabric-example-mod)。

- 模组 id：`{{modid}}`
- 主类：`{{package}}.{{ModClassName}}`
- 包名：`{{package}}`
- 目标环境：Minecraft 1.20.1，Java 17
- 协议：{{license}}

## 目录结构

```
.
├─ build.gradle                    # 构建脚本（fabric-loom）
├─ gradle.properties               # 版本号集中在这里（改版本先改这里）
├─ settings.gradle                 # 插件仓库
├─ gradle/wrapper/                 # 仅 properties，无二进制 jar
└─ src
   ├─ main/java/{{packagePath}}/
   │   ├─ {{ModClassName}}.java            # 主入口（ModInitializer）
   │   └─ mixin/ExampleMixin.java        # Mixin 注入示例
   ├─ main/resources/
   │   ├─ fabric.mod.json                # 模组元数据
   │   ├─ {{modid}}.mixins.json          # Mixin 配置
   │   ├─ assets/{{modid}}/              # 贴图 / 模型 / 语言文件
   │   │   ├─ blockstates/example_block.json
   │   │   ├─ models/{item,block}/
   │   │   ├─ textures/{item,block}/      # 放 16x16 PNG
   │   │   └─ lang/{en_us,zh_cn}.json
   │   └─ data/{{modid}}/loot_tables/     # 方块掉落（缺失方块挖掉不掉自己）
   └─ client/java/{{packagePath}}/{{ModClassName}}Client.java   # 客户端入口
```

## 环境准备

| 项目 | 要求 |
| --- | --- |
| JDK | **17**（1.20.1 必须 17；1.20.5+ 才需要 21） |
| Gradle | 8.x（用 wrapper 或系统安装的 gradle 均可） |
| 编辑器 | IntelliJ IDEA（推荐安装 Minecraft Development 插件） |

检查 JDK：

```bash
java -version   # 期望 17.x
```

## 构建

```bash
# Windows
gradlew.bat build

# macOS / Linux / Git Bash
./gradlew build
```

> 本模板**不包含 `gradle-wrapper.jar`**（脚手架不携带二进制文件）。
> 若没有 wrapper，有两种选择：
> 1. 用系统 Gradle 生成一次：`gradle wrapper`（生成后即可用 `./gradlew`）；
> 2. 直接用系统 Gradle：`gradle build`。

产物位置：`build/libs/{{modid}}-{{modVersion}}.jar`

- `*-sources.jar` 是源码包，**不要**放进 mods 目录；
- 开发时用 `build` 即可，`runClient` / `runServer` 可直接启动调试客户端/服务端：

```bash
./gradlew runClient
```

## 安装到游戏

1. 确认游戏版本为 **1.20.1**，且已安装 [Fabric Loader](https://fabricmc.net/use/installer/)；
2. 把 `build/libs/{{modid}}-{{modVersion}}.jar`（不含 sources）复制到 `.minecraft/mods/`；
3. 把 **Fabric API** 一起放进 `mods/`（本模板的 `fabric.mod.json` 声明了 `fabric-api` 依赖）；
4. 启动游戏，日志里应出现 `[{{modid}}] 初始化完成。`。

## 常见坑

1. **`Could not resolve` / `Could not find net.fabricmc:...`**
   `gradle.properties` 里的 `yarn_mappings`、`loader_version`、`fabric_version`、`loom_version` 过期了。
   到 <https://fabricmc.net/develop/> 复制当前值即可（loom 版本见
   <https://maven.fabricmc.net/net/fabricmc/fabric-loom/>）。
2. **`Unsupported class file major version`**
   Gradle 用的 JDK 与工程要求不一致。改 IDEA 的 `Gradle JVM` 为 17，或设置 `JAVA_HOME` 指向 JDK 17。
3. **模组不加载 / `Cannot find entrypoint`**
   `fabric.mod.json` 里 entrypoint 的类全名与 `src` 目录下的包名/类名不一致（本模板渲染后应完全匹配）。
4. **Mixin 报 `Mixin apply failed` / `InvalidInjectionException`**
   混淆名对不上（换了 MC 版本或映射），或 `{{modid}}.mixins.json` 的 `package` 字段写错。
   开发期给 JVM 加 `-Dmixin.debug.export=true`，注入后的类会导出到 `run/.mixin.out`。
5. **客户端类在服务端崩溃**
   引用了 `net.minecraft.client.*` 的代码必须放在 `src/client` 源码集 / 客户端入口里。
6. **中文乱码**
   构建脚本已设置 `options.encoding = 'UTF-8'`；若自己新增文件请保持 UTF-8 无 BOM。
7. **国内下载缓慢**
   `build.gradle` 与 `settings.gradle` 里预留了阿里云 / BMCLAPI 加速源注释，取消注释即可；
   注意官方源（`maven.fabricmc.net`）必须保留。
8. **方块是黑紫格 / 挖掉没有掉落**
   黑紫格 = 缺少 `assets/{{modid}}/blockstates/example_block.json`、`models/block/example_block.json`
   或对应的 `textures/block/example_block.png`；挖掉无掉落 = 缺少
   `data/{{modid}}/loot_tables/blocks/example_block.json`（本模板都已附带，自行新增方块时别忘）。
