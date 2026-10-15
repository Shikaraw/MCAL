# overrides/config 目录约定

`overrides/` 里的内容会在安装整合包时**原样复制**到游戏目录，因此这里放的是
「不能/不方便用下载地址描述」的文件：

- `config/`：模组配置文件（Forge/NeoForge/Fabric 的 `config/*.toml|json`）；
- `defaultconfigs/`：新世界默认配置（部分整合包的约定目录）；
- `kubejs/`、`scripts/`：KubeJS / CraftTweaker 脚本；
- `resourcepacks/`、`shaderpacks/`：自带资源包与光影；
- `options.txt`、`servers.dat` 等按需放入（注意隐私：发布前务必删除自己的服务器列表与账号相关文件）。

放置建议：

1. 目录结构必须与游戏目录一致，例如配置文件放 `overrides/config/modname-common.toml`；
2. 只放**必须随包分发**的文件，能通过下载地址描述的（mods、资源包）写进 `files[]` 更省体积；
3. 发布前检查是否混入了 `logs/`、`crash-reports/`、`saves/`、`journeymap/` 等个人数据；
4. 本目录下的 README.md 本身也会被复制到 `config/README.md`，正式发布时可删除。
