# {{modName}}（数据包 / MC 1.20.x）

由 MCAL 项目脚手架生成的数据包骨架。

- 名称：`{{modName}}`
- 作者：{{author}}，版本：{{modVersion}}，协议：{{license}}
- 数据包命名空间：`{{modid}}`（由 `data/{{modid}}/` 目录决定）
- 目标：Minecraft 1.20.1（pack_format **15**）

## 目录结构

```
.
├─ pack.mcmeta                                # 数据包元数据（pack_format 15）
└─ data/
   ├─ {{modid}}/
   │   ├─ functions/hello.mcfunction         # 函数：/function {{modid}}:hello
   │   └─ advancements/root.json             # 进度（可用来触发/奖励）
   └─ minecraft/
       └─ tags/functions/load.json           # 世界加载时自动执行的函数标签
```

## 安装与使用

1. **单人世界**：把整个目录复制到存档的 `saves/<世界名>/datapacks/`；
   **服务器**：复制到 `<服务端目录>/world/datapacks/`；
2. 进入世界后执行 `/datapack list` 确认已加载；
3. `/reload` 重载所有数据包（改函数、进度、标签后执行）；
4. `/function {{modid}}:hello` 运行示例函数；
5. 打包分发时把目录压成 zip（zip 根目录直接是 `pack.mcmeta` 与 `data/`）。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/reload` | 重载数据包（函数、进度、标签、战利品表…）；**不会**重载世界结构 |
| `/datapack list` | 列出已加载/可用数据包 |
| `/function {{modid}}:hello` | 执行某个函数 |
| `/function #minecraft:load` | 手动触发 `load` 标签里的所有函数 |
| `/schedule function {{modid}}:hello 5s` | 延迟/循环执行函数（替代旧的 tick.json） |
| `/advancement grant @s only {{modid}}:root` | 授予进度（调试用） |

## 标签（tag）用法

- 标签文件放在 `data/<命名空间>/tags/<类别>/<名字>.json`；
- 1.20 的函数标签路径是 `tags/functions/`（**1.21 起改名为 `tags/function/`**，`advancements` 同理变成 `advancement`）；
- `minecraft:load` / `minecraft:tick` 是原版预定义标签：
  - `load`：数据包加载时执行一次（适合初始化记分板、给玩家 tag）；
  - `tick`：每游戏刻执行（性能敏感，慎用，建议只做 `/schedule` 调度）；
- 自定义标签可以用来分组：`data/{{modid}}/tags/blocks/my_blocks.json`，命令里写 `#{{modid}}:my_blocks`；
- 标签可以嵌套引用其它标签（`#minecraft:planks` 之类），但注意循环引用会加载失败。

## 常见坑

1. **`/reload` 后函数没更新**：确认函数在 `data/{{modid}}/functions/`（1.21 起也仍是 `functions`；
   但 `tag` 目录改名了），且 `pack_format` 与版本匹配。
2. **`Unknown function`**：命名空间或函数名写错；函数名不含 `.mcfunction` 后缀，
   多层目录用 `/` 分隔，例如 `data/{{modid}}/functions/util/init.mcfunction` → `/function {{modid}}:util/init`。
3. **load 标签没执行**：`load.json` 必须放在 `data/minecraft/tags/functions/`，
   且内容形如 `{"values": ["{{modid}}:hello"]}`；同时确认没有用错版本目录名。
4. **函数里命令报语法错**：mcfunction 行首**不能有斜杠** `/`；
   命令内的 `\"` 需要转义；注释用 `#`。
5. **进度不显示**：`criteria` 的 trigger 名要与版本一致（1.20 是 `minecraft:tick`），
   并且该进度确实被授予（可用 `/advancement grant @s only <id>` 验证）。
6. **性能问题**：不要用 `tick.json` 做每刻轮询；优先用 `/schedule`、
   侦测器（predicate）或事件触发的进度。
