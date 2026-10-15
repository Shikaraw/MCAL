#ifndef LIB_COMMON_INCLUDED
#define LIB_COMMON_INCLUDED

/* ---------------------------------------------------------------------
 *  lib/common.glsl —— 光影包共享工具函数
 *
 *  约定：
 *   - 本文件只放「纯函数」，不声明 uniform / varying，
 *     这样才能被顶点着色器与片段着色器同时 #include；
 *   - 目标 GLSL 版本是 120（Minecraft 1.12~1.21 的光影通用版本），
 *     没有 texture()/in/out 等现代语法，请使用 texture2D/varying/gl_FragColor；
 *   - Iris 与 OptiFine 都支持 `#include "/lib/xxx.glsl"`（路径以 shaders/ 为根）。
 * --------------------------------------------------------------------- */

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

/* ------------------------------ 颜色 ------------------------------ */

/** Rec.709 感知亮度 */
float luma(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

/** sRGB <-> 线性空间。做物理化的光照/色调映射前必须转换。 */
vec3 srgbToLinear(vec3 color) {
    return pow(color, vec3(2.2));
}

vec3 linearToSrgb(vec3 color) {
    return pow(color, vec3(1.0 / 2.2));
}

/** 亮度调整：amount > 0 变亮，< 0 变暗（保持色相） */
vec3 adjustBrightness(vec3 color, float amount) {
    return color + amount;
}

/** 对比度：以中灰 0.5 为中心拉伸 */
vec3 adjustContrast(vec3 color, float contrast) {
    return (color - 0.5) * contrast + 0.5;
}

/** 饱和度：0 = 灰度，1 = 原色，>1 更艳 */
vec3 adjustSaturation(vec3 color, float saturation) {
    float l = luma(color);
    return mix(vec3(l), color, saturation);
}

/* --------------------------- 法线编码 --------------------------- */

/**
 * 八面体（octahedral）法线编码：把单位法线压成 2 个分量，便于写进 RG 通道。
 * 解码见 decodeNormal。两者必须成对使用，否则光照方向会明显错误。
 */
vec2 encodeNormal(vec3 n) {
    n /= (abs(n.x) + abs(n.y) + abs(n.z));
    vec2 enc = n.xy;
    if (n.z < 0.0) {
        enc = (vec2(1.0) - abs(n.yx)) * sign(n.xy);
    }
    return enc * 0.5 + 0.5;
}

vec3 decodeNormal(vec2 enc) {
    enc = enc * 2.0 - 1.0;
    vec3 n = vec3(enc.xy, 1.0 - abs(enc.x) - abs(enc.y));
    float t = clamp(-n.z, 0.0, 1.0);
    n.x += (n.x > 0.0) ? -t : t;
    n.y += (n.y > 0.0) ? -t : t;
    return normalize(n);
}

/** 线性插值式 fresnel（Schlick 近似），f0 一般取 0.04 */
float fresnel(float cosTheta, float f0) {
    return f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

/* ----------------------------- 噪波 ----------------------------- */

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

/** 二维值噪声（平滑插值），用于云、雾、噪点抖动 */
float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm2D(vec2 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        sum += noise2D(p) * amp;
        p *= 2.03;
        amp *= 0.5;
    }
    return sum;
}

/* --------------------------- 后处理辅助 --------------------------- */

/** ACES filmic 近似色调映射（Narkowicz 2015） */
vec3 tonemapACES(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/** 简单暗角：uv 为 0..1 屏幕坐标，strength 建议 0.1~0.6 */
vec3 applyVignette(vec3 color, vec2 uv, float strength) {
    vec2 d = uv - 0.5;
    float v = 1.0 - dot(d, d) * strength * 4.0;
    return color * clamp(v, 0.0, 1.0);
}

/** 3x3 锐化（unsharp 风格）。texel 为 1/分辨率 */
vec3 sharpen3(vec3 center, vec3 up, vec3 down, vec3 left, vec3 right, float amount) {
    return center + (center * 4.0 - up - down - left - right) * amount;
}

/** 3x3 高斯模糊的一维权重（配合两次分离卷积） */
float gaussianWeight(float offset) {
    return exp(-offset * offset * 2.0);
}

/** MC 光照贴图坐标(0..1) -> 近似亮度；blockLight/skyLight 分别来自 lmcoord.x / lmcoord.y */
float lightmapBrightness(vec2 lmcoord, float skyStrength) {
    float block = lmcoord.x;
    float sky = lmcoord.y * skyStrength;
    return clamp(max(block, sky), 0.0, 1.0);
}

#endif
