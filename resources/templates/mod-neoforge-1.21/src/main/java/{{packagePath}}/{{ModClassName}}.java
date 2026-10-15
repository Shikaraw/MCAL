package {{package}};

import net.minecraft.core.registries.Registries;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.event.BuildCreativeModeTabContentsEvent;
import net.neoforged.neoforge.event.server.ServerStartingEvent;
import net.neoforged.neoforge.registries.DeferredHolder;
import net.neoforged.neoforge.registries.DeferredRegister;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * NeoForge 模组主类（MC 1.21 / Java 21）。
 *
 * <p>与 Forge 1.20.1 的主要差异：</p>
 * <ul>
 *   <li>包名全部是 {@code net.neoforged.*}，注册表在 {@code net.minecraft.core.registries.Registries}；</li>
 *   <li>构造参数直接注入 {@link IEventBus}（mod 事件总线）与 {@link ModContainer}，
 *       不再需要 {@code FMLJavaModLoadingContext.get()}；</li>
 *   <li>事件订阅注解为 {@code @EventBusSubscriber(bus = EventBusSubscriber.Bus.MOD | GAME)}；</li>
 *   <li>DeferredRegister 有专用工厂：{@code DeferredRegister.createItems(modId)}，
 *       返回 {@code DeferredRegister.Items}，注册结果类型是 {@link DeferredHolder}。</li>
 * </ul>
 */
@Mod({{ModClassName}}.MOD_ID)
public class {{ModClassName}} {
    public static final String MOD_ID = "{{modid}}";

    private static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    /** 用 NeoForge 提供的注册表工厂创建（也可 DeferredRegister.create(Registries.ITEM, MOD_ID)）。 */
    public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(MOD_ID);

    /** 示例物品；1.21 的 Item.Properties 不需要 setId。 */
    public static final DeferredHolder<Item, Item> EXAMPLE_ITEM =
            ITEMS.register("example_item", () -> new Item(new Item.Properties()));

    public {{ModClassName}}(IEventBus modEventBus, ModContainer modContainer) {
        // 挂到 mod 事件总线：漏掉这行物品不会注册
        ITEMS.register(modEventBus);

        modEventBus.addListener(this::addCreative);

        LOGGER.info("[{}] 模组构造完成（容器 {}）", MOD_ID, modContainer.getModId());
    }

    /** 把示例物品加进创造标签页，否则只能用 /give 获取。 */
    private void addCreative(BuildCreativeModeTabContentsEvent event) {
        if (event.getTabKey() == CreativeModeTabs.BUILDING_BLOCKS) {
            event.accept(EXAMPLE_ITEM);
        }
    }

    private static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    /**
     * 注解式订阅示例：GAME 总线订阅游戏内事件（服务器启动）。
     * 注册类事件（commonSetup 等）请用 bus = MOD。
     */
    @EventBusSubscriber(modid = MOD_ID, bus = EventBusSubscriber.Bus.GAME)
    public static class GameEvents {
        @SubscribeEvent
        public static void onServerStarting(ServerStartingEvent event) {
            LOGGER.info("[{}] 服务器启动：{}", MOD_ID, event.getServer());
        }
    }
}
