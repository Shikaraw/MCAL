#version 120

/* ---------------------------------------------------------------------
 *  composite.fsh —— 后处理示例（曝光 / 对比度 / 饱和度 / 锐化 / 暗角）
 *
 *  要点：
 *   - 采样 colortex0 得到上一阶段的画面，处理后写回 colortex0；
 *     需要保留原图时请自己增加 colortex1 作为中间缓冲（Iris/OptiFine 会自动分配）；
 *   - GM 里可用的内置 uniform：viewWidth/viewHeight（像素）、frameTimeCounter（秒）、
 *     isEyeInWater、blindness、nightVision、rainStrength 等；
 *   - 屏幕 uv 的 texel：vec2 texel = 1.0 / vec2(viewWidth, viewHeight)。
 * --------------------------------------------------------------------- */

#include "/lib/common.glsl"
#include "/lib/options.glsl"

/* DRAWBUFFERS:0 */

uniform sampler2D colortex0;

uniform float viewWidth;
uniform float viewHeight;
uniform float frameTimeCounter;
uniform int isEyeInWater;

varying vec2 texcoord;

void main() {
    vec2 texel = vec2(1.0 / viewWidth, 1.0 / viewHeight);

    vec3 color = texture2D(colortex0, texcoord).rgb;

    // ---- 锐化（3x3 拉普拉斯风格，纹素采样有轻微性能开销，按需关闭） ----
#if SHARPNESS > 0
    vec3 up    = texture2D(colortex0, texcoord + vec2(0.0, texel.y)).rgb;
    vec3 down  = texture2D(colortex0, texcoord - vec2(0.0, texel.y)).rgb;
    vec3 left  = texture2D(colortex0, texcoord - vec2(texel.x, 0.0)).rgb;
    vec3 right = texture2D(colortex0, texcoord + vec2(texel.x, 0.0)).rgb;
    color = sharpen3(color, up, down, left, right, SHARPNESS);
#endif

    // ---- 暗角（色彩相关处理统一放在 final.fsh，避免重复处理） ----
    color = applyVignette(color, texcoord, VIGNETTE);

    // 水下轻微偏蓝（示例，可按需删除）
    if (isEyeInWater == 1) {
        color = mix(color, color * vec3(0.75, 0.85, 1.15), 0.5);
    }

    // ---- 调试视图：直接在画面里看缓冲内容，排查白屏/黑屏问题 ----
#ifdef DEBUG
    // 屏幕坐标网格 + 帧时间闪烁，用来确认 shader 真的在运行
    float checker = mod(floor(texcoord.x * viewWidth / 32.0) + floor(texcoord.y * viewHeight / 32.0), 2.0);
    color = mix(color, vec3(checker) * 0.15 + 0.1, 0.5);
#endif

    gl_FragColor = vec4(color, 1.0);
}
