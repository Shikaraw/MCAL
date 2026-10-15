# {{modName}}（资源包 / MC 1.20.x）

由 MCAL 项目脚手架生成的资源包骨架。

- 名称：`{{modName}}`
- 作者：{{author}}，版本：{{modVersion}}，协议：{{license}}
- 目标：Minecraft 1.20.1（pack_format **15**，`supported_formats` 15~18）

## 目录结构

```
.
├─ pack.mcmeta                                   # 资源包元数据（pack_format）
└─ assets/
   └─ minecraft/                                 # 覆盖原版命名空间
      ├─ blockstates/example_block.json          # 方块状态 -> 模型
      ├─ models/
      │   ├─ block/example_block.json            # 方块模型（cube_all）
      │   └─ item/{{modid}}_item.json            # 物品模型（item/generated）
      ├─ textures/item/                          # 贴图目录（放 PNG）
      └─ lang/zh_cn.json                         # 中文语言文件
```

## pack_format 对照（资源包 / 数据包是两套独立编号！）

| MC 版本 | 资源包 pack_format | 数据包 pack_format |
| --- | --- | --- |
| 1.19.4 | 13 | 12 |
| 1.20 ~ 1.20.1 | **15** | 15 |
| 1.20.2 | 18 | 18 |
| 1.20.3 ~ 1.20.4 | 22 | 26 |
| 1.20.5 ~ 1.20.6 | 32 | 41 |
| 1.21 | 34 | 48 |

1.20.2 起 `pack.mcmeta` 支持 `supported_formats`（数组或 min/max 对象），
可以声明同一份资源包兼容多个版本；低版本 MC 会忽略这个字段。

## 打包与使用

1. 把 `pack.mcmeta` 与 `assets/` **一起**压缩成 zip（zip 根目录下直接是它们，不要多一层文件夹）；
2. 放到 `.minecraft/resourcepacks/`；
3. 游戏内 `选项 → 资源包` 启用；
4. 改完贴图如果没生效：按 `F3+T` 重载资源，或退出世界再进。

## 如何替换原版材质

- **命名空间**：放在 `assets/minecraft/...` 里就是「覆盖原版」；
  自定义命名空间（不覆盖、只给 mod 用）应写成 `assets/<命名空间>/...`；
- **对应关系**：`blockstates/<方块>.json` → `models/block/<模型>.json` → `textures/block/<贴图>.png`；
  物品同理走 `models/item/*.json` + `textures/item/*.png`；
- **物品贴图**：`item/generated` 模型的 `layer0` 必须指到 `textures/item/<名字>.png`，
  贴图本身建议 **16x16**（HD 也可以，48x48 以上要放到 `textures/<更大的尺寸>/` 目录或用 `textures/` 根）；
- **方块贴图**：`cube_all` 只看 `all`；要每面不同用 `cube` + `down/up/north/south/east/west`；
- **语言文件**：只写要改的 key 即可，未写的 key 会回退到原版（不要在资源包里放完整原版语言文件）。

## 常见错误

1. **启用时提示「资源包无效 / 需要新版 Minecraft」**
   `pack_format` 不匹配目标版本；按上表改（1.20.1 应为 15）。
2. **贴图变成黑白紫格**
   路径大小写错误（Linux/macOS 服务端严格区分大小写）、PNG 不是 32 位、或文件名与 JSON 引用不一致。
3. **模型变成黑紫方块 / 「missing model」**
   JSON 里的 `parent` / `textures` 路径写错：命名空间后必须跟 `:`，且不能用 `.json` 后缀。
4. **JSON 解析失败**
   多写了逗号、用了注释、或文件编码不是 UTF-8（Windows 记事本另存为「UTF-8」而非「UTF-8 with BOM」）。
5. **中文乱码**
   语言文件必须是 UTF-8 无 BOM；键名里的 `.` 不能漏。
6. **改了 name 描述不生效**
   `pack.mcmeta` 的 `description` 只在资源包列表显示，改完需要重进游戏或 F3+T。
7. **zip 里多了一层文件夹**
   资源包要求 zip 根目录直接是 `pack.mcmeta` 与 `assets/`。
