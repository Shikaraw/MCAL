---
name: diagnose-crash
description: 系统化诊断 Minecraft 崩溃：从日志找到根因并给出可执行修复方案
whenToUse: 用户说"游戏崩溃了/打不开/闪退"，或提供了崩溃报告、报错文本、日志片段
---

# 崩溃诊断手册

## 原则

**先找证据，再下结论。** 不要根据"用户说装了光影"就断定是光影问题。MC 的崩溃绝大多数能在日志里找到明确的第一因（root cause），关键是读到正确的行。

## 第 1 步：拿到证据

按以下顺序获取，前面的优先：

1. 用户是否直接贴了报错？→ 直接把原文交给 `mc_diagnose`（`text` 参数）。**不要先让用户重新跑一遍游戏。**
2. 有实例 → `mc_diagnose`（`instance` 参数）会自动读取实例目录下的日志与最新崩溃报告。
3. 需要原始日志 → `mc_read_log`：
   - 想看报错上下文：`filter` 传关键类名（如 `Exception`、`ERROR`、mod 名）
   - 想了解启动到了哪一步：`tailLines: 100`
   - 有多个日志时用 `file` 指定
4. 崩溃报告（`crash-reports/crash-*.txt`）优先于普通日志：里面有 `Description:`（崩溃阶段）与 `Suspected Mods:`（嫌疑 mod）。

## 第 2 步：解读诊断结果

`mc_diagnose` 会返回分类、置信度、证据原文与步骤。按分类决定下一步：

| 分类 | 典型报错 | 下一步 |
|---|---|---|
| java | `UnsupportedClassVersionError`、`class file major version` | 查知识库 `java-version-matrix`，确认该 MC 版本需要的 Java，再用 `mc_update_instance` 指定 Java 路径 |
| memory | `OutOfMemoryError: Java heap space` | `mc_update_instance` 提高 `maxMemoryMB`（物理内存的 50%~70%，并解释上限） |
| mod-missing-dependency | `Missing or unsupported mandatory dependencies` | 从日志提取缺失 modid → `mc_search_projects` 搜索并 `mc_install_project`（带依赖） |
| mod-version-mismatch | `Incompatible mod set`、`NoSuchMethodError` | `mc_check_content` 找出不匹配的 mod，替换为对应 MC 版本的构建 |
| mod-conflict | `Mixin apply failed`、`Duplicate mods` | 二分法：禁用一半 mod 验证 → `mc_toggle_content` |
| graphics | `EXCEPTION_ACCESS_VIOLATION`、`Pixel format not accelerated` | 看 `# Problematic frame` 判断是驱动（`atio6axx.dll`/`nvoglv64.dll`）还是模组；检查光影/OptiFine 冲突 |
| loader | `Forge 安装失败`、`missing mods.toml` | 重新安装加载器；`mc_install_loader` |
| asset | `Failed to download file`、`Unable to load asset index` | `mc_verify_version` 校验完整性，缺失则重装该版本 |

## 第 3 步：验证假设（重要）

**不要跳过验证就宣布修好。** 常用手段：

- 二分法定位冲突 mod：
  1. `mc_scan_content` 拿到 mod 列表
  2. `mc_toggle_content` 批量禁用后半部分
  3. 让用户启动一次（或 `mc_launch`）
  4. 崩溃消失 → 问题在后半部分；仍在 → 在前半部分
  5. 重复直到锁定单个 mod
- 内存类问题：改完后 `mc_instance_info` 确认参数已生效，再让用户启动。
- 版本类问题：`mc_check_content` 确认所有 mod 都声明支持当前版本。

## 第 4 步：交付与沉淀

给用户的回复包含：
1. **结论**：一句话说明是什么问题（现象 → 根因）
2. **证据**：引用日志原文的关键行（1~3 行即可）
3. **操作步骤**：编号，写清具体数值与文件
4. **验证方法**：怎么确认修好了
5. **预防建议**（可选，别啰嗦）

最后用 `memory_write` 记录：`problem` 写现象，`solution` 写实际操作，`verified` 视用户确认情况填写。

## 常见陷阱

- `Exit Code: -1073741819`（0xC0000005）**不是**单一原因，可能是显卡驱动、内存、也可能只是 JVM 崩溃的表现 —— 必须看 `hs_err_pid*.log` 的 `# Problematic frame` 才能定性。
- `Suspected Mods` 是 Forge 的启发式推测，**不等于**一定是那个 mod，有时是它依赖的库版本不对。
- 只改了配置但没让用户重启游戏，等于没修。
- 不要建议用户"重装系统""换电脑"这类无效建议。
