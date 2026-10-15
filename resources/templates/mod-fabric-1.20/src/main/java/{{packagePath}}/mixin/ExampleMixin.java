package {{package}}.mixin;

import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Mixin 注入示例。
 *
 * <p>Mixin 是「在编译后修改其它类字节码」的机制。要点：</p>
 * <ul>
 *   <li>类必须出现在 {@code {{modid}}.mixins.json} 的 {@code mixins}/{@code client} 数组里，
 *       且 {@code package} 字段必须等于本类所在包名；</li>
 *   <li>{@code compatibilityLevel} 必须 ≥ 编译所用 Java 级别（Java 17 对应 JAVA_17）；</li>
 *   <li>注入点使用 {@code @At("HEAD")} / {@code @At("RETURN")} / 目标方法名 + 描述符，
 *       描述符可在 IDE 里通过 bytecode 视图或 {@code javap -s} 获取；</li>
 *   <li>{@code @Inject} 默认不修改原逻辑；需要拦截/改返回值时给方法加 {@code CallbackInfoReturnable<T>}
 *       并调用 {@code cir.setReturnValue(...)}（同时 {@code cancellable = true}）。</li>
 * </ul>
 *
 * <p>调试技巧：JVM 参数 {@code -Dmixin.debug.export=true} 会把注入后的类导出到 run/.mixin.out，
 * 用 IDEA 反编译即可看到真实注入结果。</p>
 */
@Mixin(MinecraftServer.class)
public class ExampleMixin {
    /**
     * 在 MinecraftServer#loadWorld 的 HEAD 注入（方法名在不同映射下不同，这里仅作演示）。
     * 若编译报「找不到方法」，先用 IDE 打开 MinecraftServer 复制真实签名替换 method 值。
     */
    @Inject(method = "loadWorld", at = @At("HEAD"))
    private void {{modid}}$onLoadWorld(CallbackInfo ci) {
        // 这里可以访问 this（即 MinecraftServer 实例），因为是实例注入
        System.out.println("[{{modid}}] ExampleMixin: MinecraftServer#loadWorld 被调用");
    }
}
