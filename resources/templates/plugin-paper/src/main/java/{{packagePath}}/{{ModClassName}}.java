package {{package}};

import {{package}}.commands.ExampleCommand;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Paper 插件主类（Java 21）。
 *
 * <p>生命周期：onLoad -> onEnable -> （运行期） -> onDisable。
 * 注册命令与事件监听器必须在 onEnable 里完成。</p>
 */
public class {{ModClassName}} extends JavaPlugin implements Listener {
    /** 插件单例：Bukkit.getPluginManager().getPlugin("插件名") 也可拿到，但静态字段更直接。 */
    private static {{ModClassName}} instance;

    public static {{ModClassName}} get() {
        return instance;
    }

    @Override
    public void onEnable() {
        instance = this;

        // 1) 注册命令（plugin.yml 里声明了 commands.example，
        //    这里只需把 executor/tabCompleter 绑定上去）
        var exampleCommand = getCommand("example");
        if (exampleCommand != null) {
            exampleCommand.setExecutor(new ExampleCommand());
            exampleCommand.setTabCompleter(new ExampleCommand());
        } else {
            getLogger().warning("plugin.yml 中缺少 example 命令声明，命令未注册。");
        }

        // 2) 注册事件监听器（本类实现了 Listener，事件方法用 @EventHandler 标注）
        Bukkit.getPluginManager().registerEvents(this, this);

        getLogger().info("{{modName}} 已启用（Paper API " + Bukkit.getMinecraftVersion() + "）");
    }

    @Override
    public void onDisable() {
        // 保存数据、关闭连接池等清理工作放这里
        getLogger().info("{{modName}} 已禁用");
        instance = null;
    }

    /** 事件监听示例：玩家加入时发一条欢迎消息。 */
    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        event.getPlayer().sendMessage(ChatColor.GREEN + "欢迎来到服务器，" + event.getPlayer().getName() + "！");
    }
}
