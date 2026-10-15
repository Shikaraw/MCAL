---
id: pack-distribution-notes
title: 整合包分发与版权注意事项
category: pack
tags: [整合包, 分发, 版权, 许可, OptiFine, CurseForge, Modrinth, EULA, 再分发, 商业, 合规]
summary: 把别人的模组打进整合包分发前必须确认授权：平台清单引用、模组许可、OptiFine 与 Mojang 资源的再分发红线。
updatedAt: 2026-10-01
---

## 症状

- 做好的整合包上传网盘后被作者要求下架；
- 整合包内的模组出现「某人禁止整合」声明；
- 想上传到 CurseForge/Modrinth 但不清楚哪些文件能打包；
- 服务器端商用整合包是否合规没有把握。

## 原因

整合包由大量第三方内容（模组、资源包、光影、配置文件）组成，每一件都有自己的许可证与作者意愿：

- **模组许可**：从 MIT/CC0 到「保留所有权利」都有，后者默认**不允许再分发**（包括打包进整合包）。很多作者在页面写明「允许整合包收录」，但可能附加条件（不得收费、必须注明来源）。
- **平台政策**：CurseForge 的第三方分发政策允许在标注来源的情况下将包内模组用于整合包；Modrinth 的 `.mrpack` 用哈希与下载地址引用，不打包文件本身，是更合规的分发形态。
- **OptiFine**：其许可明确限制再分发，不能把 OptiFine 的 jar 放进整合包，应引导用户自行从官网下载（这也是很多整合包不内置 OF 的原因）。
- **Mojang 资源**：游戏本体 jar 与 `assets`（音效、语言、纹理）不允许再次分发，整合包不能把它们打包进去。
- **商业用途**：Minecraft EULA 禁止用游戏本身牟利的方式（如出售游戏内优势）；收费服务器与整合包分发要避免触碰这条，且部分模组作者禁止在收费场景使用。

## 解决方案

1. 分发形态优先选「清单引用」：Modrinth `.mrpack` 的 `files` 使用下载 URL + 哈希，CurseForge `manifest.json` 使用 `projectID/fileID`，两者都不把模组文件放进包里，是最稳妥的方式。
2. 必须打包文件（如自建整合包放网盘）时：逐个检查模组页面是否允许再分发（CurseForge 项目页有「Allow distribution of this mod in modpacks」标识，Modrinth 有 `distribution` 标记）；不允许的从包里剔除，改为安装说明里给出下载链接。
3. OptiFine 一律不打包，整合包说明中写明「需要 OptiFine 可自行安装」，或改用 Iris/Oculus 等替代方案（见 [[loader-optifine-and-alternatives]]）。
4. 保留出处：在整合包描述中列出模组清单与作者链接；保留模组 jar 内的版权文件，不要修改模组本体（改配置可以，重分发修改版不行）。
5. 收费问题：即使允许收录，若整合包要收费或含付费服专用内容，必须单独确认作者态度；不要用「爱发电/付费网盘」等方式变相售卖他人模组。
6. 服务器运营：使用整合包开服一般不违反模组许可，但公开收费服的权限（VIP 特权限等）需遵守 Minecraft 商业使用指南，别把「卖装备/权限」做成游戏性优势。
7. 上传平台前用平台的模组许可批量检查工具（CurseForge 上传流程会自动列出受限模组），比人肉检查更可靠。

## 验证

整合包在目标平台通过审核或导入测试；文件清单中不含禁止再分发的模组与 OptiFine；描述页包含来源声明；下载安装后能正常启动（说明「需自备」的内容有明确指引）。

## 相关内容

- [[pack-format-structure]]
- [[loader-optifine-and-alternatives]]
- [[mod-download-safety]]
- [[loader-neoforge-vs-forge]]
