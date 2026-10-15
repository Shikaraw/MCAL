---
id: dev-fabric-mod
title: Fabric 模组工程结构与 mixins.json
category: dev
tags: [Fabric, 开发, fabric.mod.json, mixins.json, mixin, loom, entrypoint, JAVA_17, 工程结构, InvalidInjectionException]
summary: Fabric 模组的目录结构、fabric.mod.json 与 mixins.json 字段含义，以及开发/调试 mixin 的实用参数。
updatedAt: 2026-10-03
---

## 症状

- 工程能 build 但 `runClient` 里模组不加载，日志提示 `Cannot find entrypoint`；
- Mixin 报 `Mixin apply failed` 或 `InvalidInjectionException`；
- 发布后别人装了没效果，报 `requires version 1.20.1` 之类；
- `mixins.json` 改了没反应，或报 JSON 解析错误。

## 原因

Fabric 模组由两套元数据驱动：

- `fabric.mod.json` 决定「模组本身」：`id`、`version`、`environment`（`*`/`client`/`server`）、`entrypoints`（`main`/`client`/`server`/`modmenu`）、`depends`/`suggests`/`breaks`、`mixins` 列表；
- `<modid>.mixins.json` 决定「Mixin 如何注入」：`package` 指向 mixin 类所在包，`compatibilityLevel` 必须 ≥ 编译所用 Java 级别（如 Java 17 对应 `JAVA_17`，Java 21 → `JAVA_21`），`mixins`/`client`/`server` 数组列类名，`injectors.defaultRequire=1` 让注入失败时直接报错（开发期建议保持）。
- 开发期使用 Yarn 映射名编写代码，`build` 时 loom 自动 remap；直接手改构建产物或用未 remap 的 jar 分发都会出问题。

## 解决方案

1. 用官方 fabric-example-mod 模板（或 `./gradlew` 模板生成器）起步，目录结构：
   - `src/main/java/<包名>/<Mod主类>.java`
   - `src/main/resources/fabric.mod.json`
   - `src/main/resources/<modid>.mixins.json`（如不需要 mixin 可不建）
   - `src/main/resources/assets/<modid>/...`（贴图、lang）
   - `gradle.properties`（`minecraft_version`、`yarn_mappings`、`loader_version`、`fabric_version`）
2. `fabric.mod.json` 最小可用示例：

```json
{
  "schemaVersion": 1,
  "id": "examplemod",
  "version": "1.0.0",
  "name": "Example Mod",
  "environment": "*",
  "entrypoints": { "main": ["com.example.ExampleMod"] },
  "mixins": ["examplemod.mixins.json"],
  "depends": { "fabricloader": ">=0.15.0", "minecraft": "~1.20.1", "java": ">=17" }
}
```

3. `mixins.json` 关键字段：`package` 必须是 mixin 类所在包（类文件里写相对全名，如 `"MixinMinecraft"`）；`compatibilityLevel` 与 `gradle.properties` 中 `java.version` 一致；客户端专属 mixin 放 `client` 数组。
4. 写 Mixin：`@Mixin(Target.class)` + `@Inject(method = "xxx", at = @At("HEAD"))`，回调参数签名必须与目标方法一致；改返回值用 `CallbackInfoReturnable<T>`。
5. 调试：加 JVM 参数 `-Dmixin.debug.export=true` 会把注入后的类导出到 `.mixin.out/` 便于对比；`-Dmixin.debug.verbose=true` 输出详细注入日志；注入失败时先核对目标方法名与描述符（开发环境是 Yarn 名）。
6. 依赖 Fabric API 时在 `build.gradle` 引入 `fabric_version` 并在 `depends` 中声明 `fabric-api`；发布前跑 `./gradlew remapJar`（通常在 `build` 中自动执行），产物在 `build/libs/<modid>-<version>.jar`。

## 验证

`./gradlew runClient` 后模组功能生效；日志中能看到你的 mixin 注入成功的信息（开启 mixin debug 时）；把 `build/libs` 的 jar 复制到正式实例的 `mods/` 中同样生效。

## 相关内容

- [[dev-environment-setup]]
- [[crash-mixin-failed]]
- [[mod-fabric-mod-json]]
- [[mod-common-dependencies]]
