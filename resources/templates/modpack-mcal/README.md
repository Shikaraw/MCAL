# {{modName}}（整合包工程）

由 MCAL 项目脚手架生成的整合包工程骨架。

- 名称：`{{modName}}` v{{modVersion}}，作者：{{author}}，协议：{{license}}
- 游戏版本：{{gameVersion}}，加载器：{{loaderType}} {{loaderVersion}}

## 目录结构

```
.
├─ mcal-pack.json                 # MCAL 自有清单（ModpackManifest）
├─ overrides/                     # 安装时原样复制到游戏目录的内容
│  ├─ config/                     # 模组配置
│  │  └─ README.md
│  └─ mods/                       # 需要自带、无法用下载地址描述的 mod
└─ README.md
```

## mcal-pack.json 字段说明

| 字段 | 含义 |
| --- | --- |
| `format` | 固定 `mcal` |
| `name` / `version` / `author` / `description` | 展示信息 |
| `gameVersion` | 目标 MC 版本，如 `1.20.1` |
| `loaderType` | `vanilla` / `fabric` / `forge` / `neoforge` / `quilt` |
| `loaderVersion` | 加载器版本（Fabric 形如 `0.15.11`，Forge 形如 `47.2.0`） |
| `overridesDir` | 覆盖目录名，默认 `overrides` |
| `files[]` | 文件清单，见下 |
| `extra` | 自定义扩展字段（MCAL 原样保留） |

`files[]` 每个条目的字段：

- `path`：安装到游戏目录后的相对路径（如 `mods/sodium.jar`）；
- `targetDir`：目标子目录（`mods` / `resourcepacks` / `shaderpacks` / `config`），可选；
- `platform`：能对应到平台项目时写 `{ type: "modrinth" | "curseforge", projectId, versionId }`，
  启动器可直接用平台 API 下载并校验；
- `downloads[]`：直链下载地址（无平台信息时必填）；
- `hashes` / `fileSize`：校验用（`sha1`、`sha512`）；
- `optional`：可选文件（安装器可让用户勾选）。

> 上面的示例条目是**占位内容**：`platform.versionId` 或 `downloads/hashes` 必须换成真实值，
> 否则安装器会下载失败。最省事的做法是在 MCAL 里配置好自己的实例后直接「导出为整合包」。

## 如何构建 / 安装 / 分发

1. **本地测试**：把本目录当作工程根，用 MCAL 的「导入整合包」指向 `mcal-pack.json`；
2. **分发**：把整个目录打包成 zip（`mcal-pack.json`、`overrides/` 在 zip 根目录）；
3. **发布到平台**：Modrinth 用 `.mrpack`，CurseForge 用 `manifest.json` 格式，
   两者都由 MCAL 的导出功能生成。

## 三种格式的区别

| 项目 | MCAL（`mcal-pack.json`） | Modrinth（`modrinth.index.json`） | CurseForge（`manifest.json`） |
| --- | --- | --- | --- |
| 文件清单 | `files[]`，可混用平台信息与直链 | `files[]`，每项必须带 `path` + `downloads` + `hashes` | 只存 `{projectID, fileID, required}`，靠 CF API 补全 |
| 覆盖目录 | `overrides/` | `overrides/` | `overrides/` |
| 加载器字段 | `loaderType` + `loaderVersion` | `dependencies`（`minecraft` + `fabric-loader` 等键值） | `minecraft.version` + `modLoaders[].id`（如 `fabric-0.15.11`） |
| 平台标识 | 可选（`platform` 字段） | 项目/版本 id 直接来自 Modrinth | 必须 projectID/fileID，且只能指向 CurseForge 上的项目 |
| 主要限制 | 仅 MCAL 自身可无损往返 | 不能描述「非平台文件」以外的本地改动（放 overrides） | 无法为未上传到 CF 的文件生成合法 id，只能塞进 overrides |

**实践建议**：主工程用 MCAL 格式维护（信息最全），发布时导出成 `.mrpack` / CurseForge zip。
导出前务必确认 overrides 里不含 `servers.dat`、`logs/`、`saves/`、账号 token 等隐私内容。

## 常见坑

1. **安装后 mod 版本不对**：`platform.versionId` 指向了别的 MC 版本的构建；
2. **整合包能装但启动崩**：加载器版本不匹配（`loaderType`/`loaderVersion` 与 `files[]` 里的 mod 不一致）；
3. **配置没生效**：配置文件放错层级（必须是游戏目录下的 `config/`，不是 `overrides/overrides/config/`）；
4. **文件校验失败**：`hashes` 写错或文件被重新打包过；
5. **zip 多了一层目录**：`mcal-pack.json` 必须在压缩包根目录。
