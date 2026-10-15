#version 120

/* ---------------------------------------------------------------------
 *  final.fsh —— 最终输出阶段（色调映射 + 调色）
 *
 *  final 阶段是流水线的最后一环：这里写出的颜色会直接显示到屏幕。
 *  正确做法：
 *      sRGB 采样 -> 转线性 -> 曝光/色调映射 -> 转回 sRGB -> 输出
 *  MC 的缓冲内容本身是 sRGB 空间，因此必须成对转换，否则画面发灰/过曝。
 *
 *  调试建议：
 *   - 取消 lib/options.glsl 里的 #define DEBUG_DEPTH / DEBUG_NORMAL 即可可视化
 *     深度、法线缓冲；
 *   - 出白屏先确认 viewWidth/viewHeight 是否非零（除零会得到 NaN）。
 * --------------------------------------------------------------------- */

#include "/lib/common.glsl"
#include "/lib/options.glsl"

/* DRAWBUFFERS:0 */

uniform sampler2D colortex0;
uniform sampler2D depthtex0;

uniform float viewWidth;
uniform float viewHeight;

/** 帧计数器（Iris/OptiFine 内置）：用于产生每帧变化的噪点，避免静态色带 */
uniform int frameCounter;

varying vec2 texcoord;

void main() {
    vec3 sRGB = texture2D(colortex0, texcoord).rgb;

#ifdef DEBUG_DEPTH
    // 深度可视化：近处亮、远处暗（透视深度非线性，这里只做示意）
    float depth = texture2D(depthtex0, texcoord).r;
    gl_FragColor = vec4(vec3(1.0 - depth), 1.0);
    return;
#endif

#ifdef DEBUG_NORMAL
    // 法线缓冲可视化需要 GBuffer（gbuffers_* 写 colortex1），本骨架未启用时
    // 这里退化为显示亮度，方便确认 final 阶段确实执行了。
    gl_FragColor = vec4(vec3(luma(sRGB)), 1.0);
    return;
#endif

    // ---- 线性空间色调映射 ----
    vec3 linear = srgbToLinear(sRGB) * EXPOSURE;

#if TONEMAP_MODE == 1
    linear = tonemapACES(linear);
#elif TONEMAP_MODE == 2
    linear = linear / (1.0 + linear); // Reinhard
#endif

    vec3 outColor = linearToSrgb(linear);

    // ---- 调色（饱和度/对比度） ----
    outColor = adjustSaturation(outColor, SATURATION);
    outColor = adjustContrast(outColor, CONTRAST);

    // 轻微抖动，缓解天空/渐变区域的色带（-0.5..0.5 个色阶）
    float dither = (hash12(texcoord * vec2(viewWidth, viewHeight) + float(frameCounter) * 0.618) - 0.5) / 255.0;
    outColor += dither;

    gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
