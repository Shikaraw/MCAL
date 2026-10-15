package {{package}};

import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.MinecraftClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 客户端入口（仅客户端加载器会调用）。
 *
 * <p>在 fabric.mod.json 的 {@code entrypoints.client} 中登记。
 * 只有这里（以及 {@code src/client} 源码集）才可以安全引用
 * {@code net.minecraft.client.*} 类，放到主入口会在专用服务器上崩溃。</p>
 */
public class {{ModClassName}}Client implements ClientModInitializer {
    private static final Logger LOGGER = LoggerFactory.getLogger({{ModClassName}}.MOD_ID + "-client");

    @Override
    public void onInitializeClient() {
        LOGGER.info("[{}] 客户端初始化", {{ModClassName}}.MOD_ID);

        // 典型的客户端初始化内容：
        //  - 注册按键：KeyBindingHelper.registerKeyBinding(new KeyBinding(...))
        //  - 注册实体渲染器：EntityRendererRegistry.register(...)
        //  - 注册客户端接收包：ClientPlayNetworking.registerGlobalReceiver(...)
        //  - 注册物品栏/工具提示回调：ItemTooltipCallback.EVENT.register(...)
    }

    /** 演示用：获取当前客户端实例（仅可在客户端调用）。 */
    public static MinecraftClient client() {
        return MinecraftClient.getInstance();
    }
}
