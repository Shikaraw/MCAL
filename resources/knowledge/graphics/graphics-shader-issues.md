---
id: graphics-shader-issues
title: 光影黑屏 / 白屏 / 闪烁与花屏排查
category: graphics
tags: [光影, 黑屏, 白屏, 闪烁, 花屏, 报错, Failed to load shaderpack, Shader compilation failed, Iris, OptiFine, 驱动]
summary: 启用光影后画面全黑、全白、闪烁或天空异常时，按「光影包版本 → 渲染环境 → 驱动 → 图形选项」的顺序逐层排除。
updatedAt: 2026-10-08
---

## 症状

启用光影（或切换到某个光影包）后出现以下一种情况：

- 整个世界纯黑或纯白，HUD 与物品栏正常但场景不可见；
- 屏幕持续闪烁/雪花状噪点，或下雨、水下、维度切换时花屏；
- 天空变成纯色块、太阳月亮消失、实体全部不可见；
- Iris 弹出错误页，日志里出现 `Failed to load shaderpack`、`Shader compilation failed` 并附带 `.fsh`/`.vsh` 行号；
- 切换回「Internal / 关闭光影」立刻恢复正常。

## 原因

按出现频率排序：

1. **版本不匹配**：光影包是按特定 MC + 光影加载器版本编写的，跨版本启用会出现未定义行为；Iris 相比 OptiFine 只实现了其光影格式的子集，OptiFine 专属特性（部分 `shaders.properties` 指令、自定义纹理特效）在 Iris 上可能表现异常。
2. **着色器编译失败**：驱动对 GLSL 支持不完整（尤见于老 Intel 核显与部分老 AMD 驱动），或光影包使用了该驱动不支持的写法；编译失败时部分阶段输出黑屏。
3. **渲染核心冲突**：同时存在 OptiFine 与 Sodium/Iris，或 Oculus 与 Embeddium 版本不匹配，导致 GBuffer 状态错乱。
4. **资源/显存不足**：4K 分辨率 + 高预设光影 + 高清材质把显存吃满，表现为白屏、驱动重置（Windows 提示「显示驱动已停止响应并已恢复」）。
5. **图形设置冲突**：Fabulous（幻觉）图形模式与部分光影不兼容；实体/云设置与光影预设冲突。

## 解决方案

1. 先关闭光影回到 Internal 确认游戏本体正常；再逐个光影包测试，锁定是「所有光影」还是「某个光影包」出问题。
2. 到光影发布页下载**与当前 MC 版本一致**的最新包（很多包会给出 `1.20.x`、`1.21.x` 分支）；不要用旧包硬套新版本。
3. 核对环境完整性：Iris 配 Sodium、Oculus 配 Embeddium/Rubidium，且版本相互匹配；移除 OptiFine 或移除 Sodium 系，二者只留一套。
4. 删除光影包对应的旧配置文件：`.minecraft/config/iris.properties`（或 `config/oculus.properties`）以及 `shaderpacks/` 中同名 `.txt` 预设文件，让设置回到默认。
5. 更新显卡驱动；老显卡若仍编译失败，换用要求更低的轻量光影（Complementary Reimagined 低配、Sildur's Enhanced Default 等），或放弃该包。
6. 排查显存：把分辨率降到 1080p、换 64x 以下材质、光影预设调低（关闭体积云、SSAO、光追式阴影），再观察是否复现。
7. 图形设置改为 Fancy 而非 Fabulous；关闭「实体阴影/云」再逐项打开定位冲突项。

## 验证

再次启用同一光影连续游玩 15 分钟以上，画面光照正常、无闪烁花屏、无驱动重置提示；`logs/latest.log` 中不再出现 `Shader compilation failed` 之类的报错。

## 相关内容

- [[graphics-shader-basics]]
- [[crash-access-violation-driver]]
- [[resourcepack-hd-vram]]
- [[loader-optifine-and-alternatives]]
