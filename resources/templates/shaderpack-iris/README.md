# {{modName}}（Iris / OptiFine 光影包）

由 MCAL 项目脚手架生成的光影包骨架（GLSL 120，最小可用）。

- 名称：`{{modName}}`
- 作者：{{author}}
- 版本：{{modVersion}}
- 协议：{{license}}
- 目标：Iris（Fabric/NeoForge/Quilt）与 OptiFine 均可加载

## 目录结构

```
.
├─ README.md
└─ shaders/                      # 光影包根目录必须叫 shaders
   ├─ shaders.properties         # 设置界面：screen / sliders / profiles
   ├─ gbuffers_basic.vsh/.fsh    # 基础几何（粒子等）
   ├─ composite.vsh/.fsh         # 全屏后处理（锐化、暗角、调试视图）
   ├─ final.fsh                  # 最终输出：线性空间色调映射 + 调色
   ├─ lib/
   │   ├─ common.glsl            # 共享工具函数（法线编码、亮度、噪波、tonemap…）
   │   └─ options.glsl           # #define 选项（会出现在设置界面）
   └─ world0/                    # 主世界专用程序（其余维度可加 world-1 / world1）
      ├─ gbuffers_terrain.vsh
      └─ gbuffers_terrain.fsh
```

`world0` / `world-1` / `world1` 分别对应主世界、下界、末地（dimension id）；
放在维度子目录里的程序优先于根目录同名程序。

## 安装与调试

1. 把整个光影包目录压缩为 zip（**zip 根目录下直接是 `shaders/`**，不要多一层壳）；
2. Iris：`.minecraft/shaderpacks/`；OptiFine：`.minecraft/shaderpacks/` 同样位置；
3. 游戏内 `视频设置 → 光影` 选择；Iris 下用 `Ctrl+O`（默认）打开光影设置界面确认
   `#define` 选项与滑块正常显示；
4. 出问题先看 `.minecraft/logs/latest.log` 里的 GLSL 编译日志（会带行号）。

## GLSL 版本怎么选

| 版本 | 适用 | 说明 |
| --- | --- | --- |
| `#version 120` | MC 1.12 ~ 1.21（最通用） | 固定管线风格：`gl_Vertex`、`ftransform()`、`varying`、`gl_FragColor`。**本模板使用** |
| `#version 330 core` | 现代 Iris/OptiFine 光影 | `in/out`、`texture()`、自定义 layout；需要自己处理 attribute 绑定，且不再有 `gl_Color` 等内置量 |
| `#version 150 compatibility` | 过渡方案 | 保留部分兼容变量 |

选 120 的好处是兼容老版本 MC 与 OptiFine；代价是没有现代语法（不能用 `texture()`、`mix` 的 bvec 重载等）。要升级到 330，必须把所有程序一起改，不能混用。

## Iris vs OptiFine 差异

| 项目 | OptiFine | Iris |
| --- | --- | --- |
| `#define` 选项 / shaders.properties | 支持 | 支持（解析器兼容 OF 语法） |
| 内置 uniform | 完整 | 完整（`viewWidth`、`frameTimeCounter`、`cameraPosition`…） |
| `block.properties`（方块 id → 名字） | 支持 | 支持，但需要在 shaders.properties 里 `#include` 或写好映射 |
| 特殊程序（deferred 等） | 支持 `deferred*.fsh`、`shadow*.fsh` | 支持，行为基本一致 |
| 阴影缓冲 | `shadowtex0/1` | 同名（Iris 兼容） |
| `iris.properties` | 无 | Iris 专属扩展（不要依赖它做主要功能） |
| 报错信息 | 宽松，常静默失败 | 更严格，编译错误会明确指出文件行号 |
| 已知坑 | 老版本对 `#version 330` 支持差 | 某些 OF 专属 uniform（如 `frameTimeCounter` 的旧名）不可用 |

**建议**：只用两边都有的特性；出问题时同时用 Iris 与 OptiFine 各测一遍。

## 调试建议

1. **`#define DEBUG`**：`lib/options.glsl` 里取消注释即可看到屏幕网格叠加，
   能立刻确认 shader 是否真的在运行（而不是被回退到原版渲染）。
2. **`#define DEBUG_DEPTH`**：在 `final.fsh` 里可视化深度缓冲，用来排查深度写入/阴影问题。
3. **最小化法定位白屏**：把 `final.fsh` 直接改成 `gl_FragColor = vec4(1, 0, 1, 1);`，
   如果画面变紫说明流水线在跑，问题在采样/颜色空间；如果没变紫，说明程序没被加载（文件名/路径错误）。
4. **颜色空间**：缓冲是 sRGB，物理化处理前 `srgbToLinear`，最后 `linearToSrgb`；
   只做一半会得到“发灰”或“过曝”的典型症状。
5. **性能**：先把 `SHARPNESS` 设为 0、去掉多余的 `texture2D` 采样，逐步加回来定位瓶颈。
6. **精度/色带**：天空渐变出现色带时，加 dither（见 `final.fsh`）或提高缓冲格式
   （`colortex0` 用 `RGBA16F` 需要在 `shaders.properties` 里声明 `colortex0Format`）。

## 常见坑

1. **文件夹名不是 `shaders`**：光影包加载失败或选项为空。
2. **`#include` 路径**：以 `shaders/` 为根，写 `/lib/common.glsl`（前面要有斜杠）；
   相对路径在部分版本上不可靠。
3. **在 `world0/` 里 include 根目录文件**：路径依然从 `shaders/` 起算，不要写成 `../lib/...`。
4. **`gl_FragColor` vs `out`**：`#version 120` 用 `gl_FragColor`；用 330 时必须换 `out`，混用直接编译失败。
5. **`DRAWBUFFERS` 注释格式**：必须是 `/* DRAWBUFFERS:0123 */` 且冒号后无空格，写错会导致输出到错误缓冲（黑屏）。
6. **`shaders.properties` 选项名与 `#define` 不一致**：界面里会出现空选项或选项不生效。
7. **同一选项在多个文件里重复 `#define`**：按照本骨架只在 `lib/options.glsl` 声明一次，
   多个程序 `#include` 它即可。
