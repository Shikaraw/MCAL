#version 120

/* ---------------------------------------------------------------------
 *  gbuffers_basic.fsh —— 基础几何的片段着色器（最小可用实现）
 *
 *  输出默认写入 colortex0（MC 的主颜色缓冲）。
 *  做延迟渲染需要写多个缓冲区时，在文件顶部加一行 DRAWBUFFERS 注释：
 *      /* DRAWBUFFERS:0123 *&#47;
 *  格式是「斜杠星号 + DRAWBUFFERS: + 缓冲区编号」，冒号后不能有空格。
 * --------------------------------------------------------------------- */

#include "/lib/common.glsl"

// MC 自动绑定的纹理：texture = 当前几何的贴图（图集或实体贴图）
uniform sampler2D texture;

varying vec2 texcoord;
varying vec4 color;
varying vec2 lmcoord;
varying float blockId;

void main() {
    vec4 texel = texture2D(texture, texcoord);
    vec4 outColor = texel * color;

    // 完全透明的像素直接丢弃，避免写深度造成 z-fighting / 光影溢出
    if (outColor.a < 0.004) discard;

    // 亮度只作为示例：真实光照应在阴影/延迟渲染阶段计算。
    // 这里的天空光权重写死 1.0；需要可调时把 lib/options.glsl 里的
    // SKY_STRENGTH 引进来做 mix 系数即可。
    float light = lightmapBrightness(lmcoord, 1.0);
    outColor.rgb *= mix(0.15, 1.0, light);

    gl_FragColor = outColor;
}
