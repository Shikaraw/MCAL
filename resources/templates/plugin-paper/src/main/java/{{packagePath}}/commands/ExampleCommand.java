package {{package}}.commands;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

/**
 * /example 命令实现：同时实现 {@link CommandExecutor}（执行）与
 * {@link TabCompleter}（补全），这也是 Bukkit 系插件最常见的写法。
 *
 * <p>命令本身（名称、别名、权限）在 plugin.yml 中声明，本类只负责逻辑。</p>
 */
public class ExampleCommand implements CommandExecutor, TabCompleter {

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        // 权限检查：plugin.yml 里已配 permission，但代码里再校验一次更稳妥
        if (!sender.hasPermission("{{modid}}.command.example")) {
            sender.sendMessage(ChatColor.RED + "你没有权限执行该命令。");
            return true; // 返回 true 表示命令已被处理（不再显示 usage）
        }

        if (args.length == 0) {
            sender.sendMessage(ChatColor.YELLOW + "用法：" + ChatColor.WHITE + "/" + label + " [player]");
            return true;
        }

        switch (args[0].toLowerCase(Locale.ROOT)) {
            case "reload" -> {
                // 注意：/reload 会重载所有插件，容易引起状态错乱，仅建议开发期使用
                sender.sendMessage(ChatColor.GREEN + "（示例）重载完成");
            }
            case "hello" -> {
                Player target = args.length >= 2 ? Bukkit.getPlayerExact(args[1]) : asPlayer(sender);
                if (target == null) {
                    sender.sendMessage(ChatColor.RED + "找不到玩家：" + args[1]);
                    return true;
                }
                target.sendMessage(ChatColor.AQUA + "Hello from {{modid}}!");
                sender.sendMessage(ChatColor.GREEN + "已向 " + target.getName() + " 发送问候。");
            }
            default -> sender.sendMessage(ChatColor.RED + "未知子命令：" + args[0]);
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        List<String> out = new ArrayList<>();
        if (args.length == 1) {
            for (String sub : new String[] {"hello", "reload"}) {
                if (sub.startsWith(args[0].toLowerCase(Locale.ROOT))) out.add(sub);
            }
        } else if (args.length == 2 && args[0].equalsIgnoreCase("hello")) {
            for (Player player : Bukkit.getOnlinePlayers()) {
                if (player.getName().toLowerCase(Locale.ROOT).startsWith(args[1].toLowerCase(Locale.ROOT))) {
                    out.add(player.getName());
                }
            }
        }
        return out;
    }

    private static Player asPlayer(CommandSender sender) {
        return sender instanceof Player player ? player : null;
    }
}
