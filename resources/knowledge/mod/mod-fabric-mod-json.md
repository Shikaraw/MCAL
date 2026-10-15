---
id: mod-fabric-mod-json
title: fabric.mod.json 字段解读与依赖声明
category: mod
tags: [Fabric, fabric.mod.json, 依赖, 元数据, 模组, 开发, 前置]
summary: 逐字段解读 Fabric 模组的元数据文件 fabric.mod.json，重点说明 id、environment、entrypoints、depends 与 mixins 字段如何决定加载行为。
updatedAt: 2026-10-11
---

## 症状

- 自己打包的 Fabric 模组放进 `mods` 后游戏没有加载它也没有报错；
- 日志出现 `Missing or unsupported mandatory dependencies`，但不知道依赖声明写在哪里；
- 想知道某个 Fabric 模组的 id、支持的游戏版本，却看不懂 jar 里的文件。

## 原因

Fabric 模组在 jar 根目录有一个 `fabric.mod.json`，它是加载器判断「这是什么模组、能不能在当前环境运行、要加载哪些入口」的唯一依据。字段写错就会静默失败或被拒绝加载。

## 解决方案

理解下列关键字段（以实际文件为例）：

```json
{
  "schemaVersion": 1,
  "id": "examplemod",
  "version": "1.0.0+1.21",
  "name": "Example Mod",
  "environment": "*",
  "entrypoints": {
    "main": ["com.example.ExampleMod"],
    "client": ["com.example.ExampleModClient"]
  },
  "depends": {
    "fabricloader": ">=0.15.0",
    "minecraft": "~1.21",
    "java": ">=21",
    "fabric-api": "*"
  },
  "mixins": ["examplemod.mixins.json"]
}
```

1. `id`：模组唯一标识（小写、可含连字符），重复 id 会被加载器拒绝；报错时的 `Mod ID: 'xxx'` 即此值。
2. `version`：模组版本，可带 `+1.21` 之类的构建元数据；依赖检查里 `Expected range` 与此比较。
3. `environment`：`"*"` 双端 / `"client"` 仅客户端 / `"server"` 仅服务端。声明 `client` 的模组装到服务端会被跳过（而不是崩溃），但被其他双端模组依赖时可能报错。
4. `entrypoints`：代码入口。`main` 双端、`client` 仅客户端、`server` 仅服务端、`modmenu` 用于 Mod Menu 集成、`preLaunch` 在游戏启动前执行。写错类名 → `ClassNotFoundException`。
5. `depends`：**硬依赖**，写在这里的模组缺失/版本不符会直接拒绝启动，日志给出 `Missing or unsupported mandatory dependencies`；常见写法 `"minecraft": ">=1.20.1 <1.20.5"` 或 `"~1.21"`（表示 1.21.x）。`java: ">=21"` 表示运行环境 Java 主版本。
6. `recommends` / `suggests`：软依赖，仅提示，不影响加载。
7. `mixins`：Mixins 配置文件名（也是 jar 内路径）；重复提供同名 mixin 会导致冲突。
8. `accessWidener`、`icon`、`contact`、`license`：访问拓宽器路径、图标、作者信息与许可证。

排查实际模组时：用压缩软件打开 jar 查看该文件，或看 Mod Menu 的模组详情页。

## 验证

用 `java -jar fabric-server-launch.jar` 或客户端启动后，F3/Mod Menu 中能看到该模组且 id 与 `fabric.mod.json` 一致；故意删掉一个 `depends` 中的前置，启动应报 `Missing or unsupported mandatory dependencies`（说明依赖声明生效）。

## 相关内容

- [[mod-forge-mods-toml]]
- [[crash-missing-dependency]]
- [[mod-common-dependencies]]
- [[dev-fabric-mod]]
