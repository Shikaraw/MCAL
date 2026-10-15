package {{package}};

import com.mojang.logging.LogUtils;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraftforge.event.BuildCreativeModeTabContentsEvent;
import net.minecraftforge.event.server.ServerStartingEvent;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;
import org.slf4j.Logger;

/**
 * Forge 模组主类（MC 1.20.1）。
 *
 * <p>要点：</p>
 * <ul>
 *   <li>{@code @Mod} 的 value 必须与 mods.toml 的 {@code modId} 一致；</li>
 *   <li>构造参数 {@link FMLJavaModLoadingContext} 由 Forge 注入，用来拿 mod 事件总线 / 容器；</li>
 *   <li>注册类内容（物品、方块……）挂到 <b>mod 事件总线</b>；
 *       游戏内事件（玩家交互、服务器生命周期……）挂在 {@code MinecraftForge.EVENT_BUS}；</li>
 *   <li>本类用 {@code @Mod.EventBusSubscriber(bus = MOD)} 把静态订阅方法注册到 mod 总线。</li>
 * </ul>
 */
@Mod({{ModClassName}}.MOD_ID)
public class {{ModClassName}} {
    /** 模组 id：与 mods.toml 的 modId 必须完全一致。 */
    public static final String MOD_ID = "{{modid}}";

    private static final Logger LOGGER = LogUtils.getLogger();

    /** 注册表声明：DeferredRegister 会跟随 mod 事件总线生命周期自动注册。 */
    public static final DeferredRegister<Item> ITEMS =
            DeferredRegister.create(ForgeRegistries.ITEMS, MOD_ID);

    /** 示例物品。 */
    public static final RegistryObject<Item> EXAMPLE_ITEM =
            ITEMS.register("example_item", () -> new Item(new Item.Properties()));

    public {{ModClassName}}(FMLJavaModLoadingContext context) {
        IEventBus modEventBus = context.getModEventBus();

        // 把所有 DeferredRegister 挂到 mod 事件总线（漏掉这一步物品不会被注册）
        ITEMS.register(modEventBus);

        // 也可在这里手动监听生命周期事件，例如：
        // modEventBus.addListener(this::commonSetup);
        modEventBus.addListener(this::addCreative);

        LOGGER.info("[{}] 模组构造完成", MOD_ID);
    }

    /** 把示例物品加进「建筑方块」创造标签页，否则物品只能靠 /give 获得。 */
    private void addCreative(BuildCreativeModeTabContentsEvent event) {
        if (event.getTabKey() == CreativeModeTabs.BUILDING_BLOCKS) {
            event.accept(EXAMPLE_ITEM);
        }
    }

    /**
     * 用注解方式订阅事件（bus = MOD 表示 mod 事件总线）。
     * 若想订阅游戏内事件（例如服务器启动），把 bus 换成 FORGE 或直接使用
     * {@code MinecraftForge.EVENT_BUS.register(...)}。
     */
    @Mod.EventBusSubscriber(modid = MOD_ID, bus = Mod.EventBusSubscriber.Bus.FORGE)
    public static class GameEvents {
        @SubscribeEvent
        public static void onServerStarting(ServerStartingEvent event) {
            LOGGER.info("[{}] 服务器启动事件：{}", MOD_ID, event.getServer());
        }
    }
}
