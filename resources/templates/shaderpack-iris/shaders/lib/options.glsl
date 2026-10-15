#ifndef LIB_OPTIONS_INCLUDED
#define LIB_OPTIONS_INCLUDED

/* ---------------------------------------------------------------------
 *  lib/options.glsl —— 光影包的「选项」声明
 *
 *  写法规则（OptiFine 与 Iris 通用）：
 *      #define 选项名 默认值 // [可选值1 可选值2 可选值3]
 *  方括号里的可选值会按下标映射成 0、1、2…（例如 // [2 1 0] 表示该选项的
 *  显示顺序/取值对应关系），Iris 会根据这些注释在设置界面生成下拉框；
 *  shaders.properties 的 sliders/screen 里引用这些名字。
 *
 *  注意：同一选项只需要声明一次。本文件被 composite.fsh 与 final.fsh
 *  同时 #include，若换到别的光影包结构，建议只保留一处声明。
 * --------------------------------------------------------------------- */

// 色调映射：0 = 关闭（直出），1 = ACES filmic，2 = 简单 Reinhard
#define TONEMAP_MODE 1 // [0 1 2]

// 曝光（EV 形式的倍率）
#define EXPOSURE 1.00 // [0.50 0.75 1.00 1.25 1.50 2.00]

// 饱和度：0 = 灰度，1 = 原色
#define SATURATION 1.05 // [0.00 0.50 0.75 1.00 1.05 1.25 1.50]

// 对比度（以 0.5 中灰为中心）
#define CONTRAST 1.02 // [0.90 0.95 1.00 1.02 1.05 1.10]

// 暗角强度
#define VIGNETTE 0.20 // [0.00 0.10 0.20 0.35 0.50]

// 锐化强度
#define SHARPNESS 0.15 // [0.00 0.10 0.15 0.25 0.40]

// 阴影分辨率档位（示例选项，供 profile 使用）
#define SHADOW_QUALITY 1 // [0 1 2]

// 阴影模糊（本骨架未实现阴影，仅作为滑块示例）
#define SHADOW_BLUR 1.0 // [0.5 1.0 1.5 2.0]

// 天空亮度
#define SKY_STRENGTH 1.0 // [0.5 0.75 1.0 1.25 1.5]

// 调试视图：取消注释即可直接看缓冲区（排查白屏/黑屏/深度问题）
// #define DEBUG
// #define DEBUG_DEPTH
// #define DEBUG_NORMAL

// ---------------------------------------------------------------------
// 在代码里用 #if 分支读取选项的示例：
//   #if TONEMAP_MODE == 1
//       color = tonemapACES(color);
//   #elif TONEMAP_MODE == 2
//       color = color / (1.0 + color);
//   #endif
// GLSL 120 的预处理器支持 #if / #elif / #ifdef / #ifndef。
// --------------------------------------------------------------------- */

#endif
