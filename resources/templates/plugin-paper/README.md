# {{modName}}（Paper 插件 / Java 21）

由 MCAL 项目脚手架生成的 Paper 服务端插件骨架。

- 插件名：`{{ModClassName}}`
- 主类：`{{package}}.{{ModClassName}}`
- 目标服务端：Paper 1.21（api-version `1.21`）
- 协议：{{license}}

## 目录结构

```
.
├─ build.gradle                 # paper-api (compileOnly) + Java 21
├─ settings.gradle
├─ gradle/wrapper/              # 仅 properties，无二进制 jar
└─ src/main
   ├─ java/{{packagePath}}/
   │   ├─ {{ModClassName}}.java          # JavaPlugin 主类（onEnable/onDisable、事件监听）
   │   └─ commands/ExampleCommand.java  # CommandExecutor + TabCompleter
   └─ resources/plugin.yml              # 命令、权限声明
```

## 环境准备

| 项目 | 要求 |
| --- | --- |
| JDK | **21**（Paper 1.20.5+ 需要 21；1.20.1 用 17） |
| Gradle | 8.x |
| 服务端 | Paper 1.21（`java -jar paper.jar --nogui`） |

## 构建

```bash
gradlew.bat build     # Windows
./gradlew build       # macOS / Linux / Git Bash
```

> 无 wrapper 时先执行 `gradle wrapper`，或直接用系统 `gradle build`。

产物：`build/libs/{{modid}}-{{modVersion}}.jar`

## 安装到服务端

1. 把 jar 复制到服务端根目录的 `plugins/` 下；
2. 重启服务端（**不要**依赖 `/reload` 加载新插件）；
3. 控制台应输出 `{{modName}} 已启用`；
4. 游戏内执行 `/example hello` 测试。

## 开发期热重载建议

Bukkit 系插件的热重载（`/reload` 或 PlugManX 之类工具）**容易泄漏类加载器、导致诡异状态**，
推荐流程：

1. 用 Gradle 构建好 jar；
2. 开一个本地测试服，改完代码后**重启服务端**（启动通常只有几秒）；
3. 需要频繁迭代时，用 `-Dcom.mojang.eula.agree=true` + 关闭世界自动保存等方式加速；
4. 生产环境永远用完整重启，避免 `ClassCastException`、事件监听重复注册等问题。

本模板的 `build.gradle` 底部预留了 `deployToServer` 复制任务的注释，按需启用。

## 常见坑

1. **`paper-api` 解析失败**
   仓库地址必须是 `https://repo.papermc.io/repository/maven-public/`；
   版本号形如 `1.21-R0.1-SNAPSHOT`，可在 <https://repo.papermc.io/> 查询。
2. **`main` 类找不到 / 插件加载失败**
   `plugin.yml` 的 `main` 必须是**完整类名**（含包名），且大小写与类名一致；
   `name` 字段里不要放空格与中文。
3. **`/example` 提示未知命令**
   `plugin.yml` 的 `commands` 缺少声明，或 YAML 缩进错误（YAML 对缩进敏感，用空格不要用 Tab）。
4. **`Unsupported class file major version`**
   用 JDK 21 编译、服务端也必须跑在 Java 21 上（Paper 1.20.5+）。
5. **把 paper-api 打进 jar**
   必须 `compileOnly`（运行时由服务端提供）；如果用 shadowJar，记得 `relocate` 第三方库避免冲突。
6. **NMS / 服务端内部 API**
   普通 API 不够用时用 `paperweight-userdev`（<https://docs.papermc.io/paper/dev/userdev/>），
   它使用 Mojang 官方映射，写法与本模板的 `paper-api` 依赖不同。
