---
id: dev-shader-basics
title: 光影（着色器包）开发基础：目录、GLSL 版本与常用语法
category: dev
tags: [光影开发, GLSL, shader, gbuffers, composite, final, OptiFine, Iris, include, uniform, 教程, 着色器]
summary: 光影包的 shaders 目录程序结构、GLSL 120 语法要点、OptiFine/Iris 的 uniform 与 #include 惯例，以及调试与打包方法。
updatedAt: 2026-10-01
---

## 症状

- 自己写的光影启用后黑屏，日志只有一行编译失败；
- 不知道 `gbuffers_*.vsh/fsh`、`composite`、`final` 各负责什么；
- 从教程复制代码后报语法错误（`texture2D` / `texture`、`varying` / `in out` 混用）；
- 改完文件游戏里没变化。

## 原因

光影包的工作方式是「替换原版渲染各阶段的着色器程序」，运行环境（OptiFine 或 Iris）负责按固定名称加载这些程序并注入统一的 uniform 与 attribute：

- 程序名固定：地形 `gbuffers_terrain`、水面 `gbuffers_water`、天空 `skybasic`/`skytextured`、阴影 `shadow`、后处理 `composite`/`composite1..N`（Iris 用于延迟管线）、输出 `final`；顶点与片元成对（`.vsh`/`.fsh`）。
- **GLSL 版本**：OptiFine 传统环境使用 `#version 120`（兼容性最好，`varying`、`texture2D()`、`gl_ModelViewMatrix` 等内置变量可用）；Iris 同时支持 120 与更新的核心模式写法（`in`/`out`、`texture()`）。混用两套语法会直接编译失败。
- 统一变量由环境提供：`gbufferModelViewProjectionMatrix`、`gbufferModelView`、`cameraPosition`、`sunPosition`、`worldTime`、`frameTimeCounter`、`viewWidth`/`viewHeight` 等；在 `shaders.properties` 中可声明可调选项与 GUI 滑块。
- `#include "/lib/xxx.glsl"` 是 OptiFine/Iris 的预处理器扩展，可拆分公共函数，路径以 `shaders/` 为根。

## 解决方案

1. 目录结构（最小可运行包）：
   ```
   shaders/
     gbuffers_terrain.vsh / .fsh
     gbuffers_water.vsh  / .fsh
     shadow.vsh / .fsh        （可选，阴影开关）
     composite.vsh / .fsh     （可选，后处理）
     final.vsh / .fsh         （可选，输出与色调映射）
     shaders.properties
     lang/zh_CN.lang
   ```
   打包时把 `shaders/` 放进 zip 根目录，扩展名用 `.zip` 放入 `shaderpacks/`。
2. 起步先写纯直通：顶点 `gl_Position = ftransform();`，片元采样颜色后直接输出 `gl_FragColor = texture2D(texture, texcoord);`（GLSL 120），确认能渲染再逐步加效果。
3. 常用语法定型：GLSL 120 用 `attribute/varying/texture2D/gl_FragColor`；如果写 330 核心模式，则用 `in/out/texture/FragColor`，并注意 120 代码不能直接混入。
4. 每加一段效果就单独测一次，优先验证法线、光照方向、阴影贴图是否传入（用调试色输出中间值，是最有效的排错方式）。
5. `shaders.properties` 里声明开关与滑块（如 `sliders=SUNLIGHT:...`、`screen=...`），语言文件 `lang/zh_CN.lang` 提供中文名；Iris 的专属设置放 `iris.properties` 或遵循 Iris 文档。
6. 调试：改完按 `F3+R` 重载光影（以所用环境支持为准）；编译失败会在游戏内或 `logs/latest.log` 中指出文件名与行号，按行定位；不确定目标环境时，先用 Iris 与 OptiFine 各测一遍。
7. 发布：zip 内保留 `shaders/` 顶层结构，写明支持的 MC 与光影加载器版本；避免使用目标环境未实现的 OptiFine 专有特性（Iris 只覆盖其子集）。

## 验证

光影包在 Iris 与 OptiFine（目标支持的环境）中都能被识别并启用；画面效果按预期出现；`F3+R` 重载无报错；把 zip 发给他人安装同样生效。

## 相关内容

- [[graphics-shader-basics]]
- [[graphics-shader-issues]]
- [[dev-resourcepack-datapack]]
- [[mod-performance-stack]]
