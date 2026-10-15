# {{modName}} 的示例函数
# 用法：游戏内执行 /function {{modid}}:hello
#
# mcfunction 的规则：
#   - 每行一条命令，行首不需要斜杠 /
#   - # 开头是注释
#   - 用 $ 开头的行是宏（需 1.20.2+ 且函数带 with 参数），本模板未使用
#   - 命令里的 @s / @a / @p 等选择器按执行者上下文生效

say 欢迎使用 {{modName}}！

# 给所有玩家提示（tellraw 的 JSON 里用 \" 转义）
tellraw @a {"text":"[{{modid}}] 数据包已加载，输入 /function {{modid}}:hello 试试","color":"green"}

# 给予执行者一个物品（示例：苹果）
give @s minecraft:apple 1

# 播放音效
playsound minecraft:entity.player.levelup player @a ~ ~ ~ 0.5 1.2

# 条件执行示例：只有脚下是草方块时才提示
execute if block ~ ~-1 ~ minecraft:grass_block run say 你正站在草地上
