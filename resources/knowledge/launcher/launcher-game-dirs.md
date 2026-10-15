---
id: launcher-game-dirs
title: .minecraft 目录结构说明与实例隔离
category: launcher
tags: [目录, .minecraft, 实例隔离, versions, libraries, assets, saves, mods, config, 备份, 磁盘占用]
summary: 解释 .minecraft 下每个目录的用途（哪些共享、哪些属于实例），以及用「版本隔离」让多个整合包互不干扰的方法。
updatedAt: 2026-10-06
---

## 症状

- 想知道哪些目录能删、哪些不能碰；硬盘被 `assets`、`libraries` 占了几十个 GB；
- 装了两个整合包后 `mods`、`config`、`saves` 互相打架；
- 换了启动器后「游戏记录不见了」；
- 想给整合包做备份却不知道备份什么。

## 原因

`.minecraft` 是游戏数据根目录，其中的子目录按「共享层」与「实例层」划分：

| 目录 | 用途 | 是否共享 |
| --- | --- | --- |
| `versions/<id>/` | 每个版本/加载器的 json 与客户端 jar | 各版本独立 |
| `libraries/` | 全部依赖库（Maven 结构） | 全局共享 |
| `assets/` | 音效、语言、纹理等资源，`objects/<hash前两位>/<hash>` | 全局共享 |
| `mods/` `config/` `saves/` `resourcepacks/` `shaderpacks/` `logs/` `crash-reports/` `screenshots/` | 游戏内容与数据 | 默认全局，可被实例隔离 |
| `options.txt` `servers.dat` | 客户端设置与服务器列表 | 默认全局 |

多数启动器支持**版本隔离（instance isolation）**：把 `mods/saves/config` 等移动/重定向到 `versions/<id>/` 下，使多个实例互不影响。官方启动器则通过 profile 的 `gameDir` 指定独立目录实现同样效果。

## 解决方案

1. 记住三类目录的处理策略：
   - 可随意删除但会被重新下载：`assets/objects`（校验后自动补全，不要手删影响性能）、`libraries/`、`logs/`（旧日志）；
   - 绝不能手删：`versions/` 里的 json、`saves/`、`options.txt`；
   - 可安全迁移：`mods`、`config`、`resourcepacks`、`shaderpacks`、`saves`（整体复制到实例目录）。
2. 多实例管理：在启动器里为每个整合包开启「版本隔离」（HMCL 在版本设置中勾选；本启动器创建实例时可按实例指定 gameDir），或直接把整套实例放进独立文件夹。
3. 备份策略（整合包/长期存档）：备份 `saves/` + `config/` + `options.txt` + `mods/` 的列表（或整个实例目录）；`assets/`、`libraries/` 可以不备份（可重新下载，但离线环境除外）。
4. 磁盘清理：`assets/objects` 与 `libraries` 是所有版本共享的，删掉只会在下次启动时重新下载；真正省空间的方法是卸载不再玩的实例（删除对应 `versions/<id>/` 与实例目录）。
5. 换启动器后「存档不见」：通常是新启动器用了不同的 `.minecraft` 路径——把旧目录整体复制/指到新启动器即可；存档在 `saves/<世界名>/`。
6. 分享日志排障：需要提供 `logs/latest.log` 与 `crash-reports/` 里的最新文件；`.minecraft` 路径可在启动器设置中确认。

## 验证

开启版本隔离后，在实例 A 里改 `options.txt`/装模组不影响实例 B；备份目录复制到新机器后游戏能识别存档与配置；磁盘空间符合预期。

## 相关内容

- [[misc-save-backup]]
- [[launcher-launch-pipeline]]
- [[pack-format-structure]]
- [[crash-read-crash-report]]
