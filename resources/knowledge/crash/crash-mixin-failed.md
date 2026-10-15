---
id: crash-mixin-failed
title: Mixin 注入失败（Mixin apply failed / InvalidInjectionException）
category: crash
tags: [Mixin, 崩溃, InvalidInjectionException, MixinTransformerError, Mixin apply failed, 冲突, Fabric, Forge]
summary: 日志中出现 Mixin apply failed、Critical injection failure 或 MixinTransformerError 时，说明模组改动原版代码失败，多为模组冲突或版本不匹配，本文给出定位两个涉事模组的方法。
updatedAt: 2026-10-03
---

## 症状

启动或进入游戏时崩溃，`logs/latest.log`、`crash-reports/` 中出现下列形态的文本：

```
Mixin apply failed modid.mixins.json:XXXMixin -> net.minecraft.class_310: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: @Redirect conflict. Skipping ...
org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure: @Inject annotation on xxx failed injection check, (0/1) succeeded. Scanned 1 target(s).
org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered
```

另一类表现是 `Mixin target not found`（找不到被注入的目标方法），常见于游戏版本不匹配的模组。

## 原因

Mixin 是 SpongePowered 的字节码注入框架，Fabric、Forge（1.16+ 内置）、NeoForge、Quilt 都用它来「改写」原版类。失败原因有三种：

1. **两个模组改同一处代码**：例如两个模组都给 `ClientLevel` 的同一方法做 `@Redirect`/`@Inject`，注入点冲突，后加载的失败（`@Redirect conflict`）。
2. **模组与游戏版本不匹配**：目标方法在新版本里被改名或删除，报 `Mixin target not found` / `Scanned 0 target(s)`。
3. **与其他优化模组打架**：Sodium/Embeddium、OptiFine 这类大规模改写渲染的模组，与老 mod 的 Mixin 极易冲突；OptiFine 在 1.16.5 之后与 Forge 生态的冲突尤为典型。

注意版本差异：Fabric 下报错里出现 `net.minecraft.class_310` 这类 intermediary 名是正常的（映射不同），Forge 下则显示 `net.minecraft.client.Minecraft` 之类的 SRG/官方名。同一份 Mixin 代码不能在 Forge 与 Fabric 之间直接通用。

## 解决方案

1. 在日志里向上找到**最后一条 `Loading ...` / `[mixin]` 信息**，即失败模组；报错文本里 `from mod xxx` 也直接给出模组 id。
2. 在冲突报错中找出「目标类 + 两个模组」：`Mixin apply failed A.mixins.json ... @Inject ... from mod B` 说明 A、B 都在改同一处。
3. 对涉事模组逐一升级到适配当前游戏版本的最新版；若已是最新，则二者只能保留一个（二选一），或向作者反馈。
4. 若报 `Mixin target not found`：确认该模组标注支持的 MC 版本与当前一致，下载页里选择正确的「游戏版本 + 加载器」文件。
5. OptiFine 相关冲突：优先改用 Embeddium/Rubidium + Oculus（1.16.5+）或 Iris（Fabric）替代，见 [[loader-optifine-and-alternatives]]。
6. 依次二分：禁用一半模组，能启动就把另一半再对半，直到锁定最小冲突组合。

## 验证

用锁定后的模组组合启动游戏，进入世界游玩 10 分钟以上，`latest.log` 中不再出现 `Mixin apply failed`、`InvalidInjectionException`、`MixinTransformerError`，也不再有崩溃报告生成。

## 相关内容

- [[crash-mod-conflict]]
- [[crash-noclass-nosuchmethod]]
- [[loader-optifine-and-alternatives]]
- [[mod-performance-stack]]
