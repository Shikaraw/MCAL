package {{package}};

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.block.AbstractBlock;
import net.minecraft.block.Block;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.server.command.CommandManager;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 模组主入口（服务端 + 客户端都会加载）。
 *
 * <p>实现 {@link ModInitializer} 后，Fabric 会在游戏启动早期调用 {@link #onInitialize()}。
 * 这里演示四件最常用的事：注册物品、注册方块（含 BlockItem）、注册命令、写日志。</p>
 *
 * <p>注意：主入口不保证客户端类可用（专用服务器上也会执行），
 * 因此所有客户端专属逻辑请放到 {@code {{ModClassName}}Client}（ClientModInitializer）。</p>
 */
public class {{ModClassName}} implements ModInitializer {
    /** 模组 id：必须与 fabric.mod.json 的 id 完全一致（全小写）。 */
    public static final String MOD_ID = "{{modid}}";

    /** 统一日志器，控制台/日志文件里用模组 id 作为前缀便于排查。 */
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    /**
     * 示例物品。1.20.1 的 Fabric API 没有 DeferredRegister，
     * 直接调用 {@code Registry.register} 即可（需保证注册发生在游戏加载前）。
     */
    public static final Item EXAMPLE_ITEM = new Item(new Item.Settings());

    /** 示例方块。方块强度/硬度用 {@link AbstractBlock.Settings} 配置。 */
    public static final Block EXAMPLE_BLOCK = new Block(AbstractBlock.Settings.create().strength(2.0f));

    /** 方块的物品形态（BlockItem）；不注册它方块就没有对应物品。 */
    public static final BlockItem EXAMPLE_BLOCK_ITEM = new BlockItem(EXAMPLE_BLOCK, new Item.Settings());

    @Override
    public void onInitialize() {
        LOGGER.info("[{}] 正在初始化……", MOD_ID);

        // 1) 注册物品：第一个参数是注册表，第二个是 Identifier（命名空间:路径）
        Registry.register(Registries.ITEM, new Identifier(MOD_ID, "example_item"), EXAMPLE_ITEM);

        // 2) 注册方块 + 方块物品
        //    仅注册还不够：方块要能显示需要 assets/<modid>/blockstates/example_block.json
        //    与 models/block/example_block.json；要被挖掉后掉落自己还需要
        //    data/<modid>/loot_tables/blocks/example_block.json（本模板已附带这三个文件）。
        Registry.register(Registries.BLOCK, new Identifier(MOD_ID, "example_block"), EXAMPLE_BLOCK);
        Registry.register(Registries.ITEM, new Identifier(MOD_ID, "example_block"), EXAMPLE_BLOCK_ITEM);

        // 3) 注册命令：/{{modid}} hello
        //    CommandRegistrationCallback 属于 Fabric API 的 v2 命令 API（1.19+ 使用）。
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(
                CommandManager.literal(MOD_ID)
                    .then(CommandManager.literal("hello")
                        .executes(context -> {
                            context.getSource().sendFeedback(
                                () -> Text.literal("Hello from " + MOD_ID + "!"), false);
                            return 1;
                        }))
            )
        );

        // 4) 其它常见入口：Fabric API 的事件注册
        //    ServerTickEvents.END_SERVER_TICK.register(server -> { ... });
        LOGGER.info("[{}] 初始化完成。", MOD_ID);
    }
}
