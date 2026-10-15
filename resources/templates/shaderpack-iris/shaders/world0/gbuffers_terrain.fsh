#version 120

/* ---------------------------------------------------------------------
 *  world0/gbuffers_terrain.fsh —— 地形片段着色器（纹理采样 + 光照贴图）
 *
 *  真实光影包会在这一阶段写入 GBuffer（法线/光照/高光），
 *  本骨架只演示：纹理采样、顶点色调色、光照贴图与雾的粗略处理。
 * --------------------------------------------------------------------- */

#include "/lib/common.glsl"

uniform sampler2D texture;      // 地形图集
uniform sampler2D lightmap;     // 光照贴图（MC 提供，16x16 渐变纹理）

uniform vec3 fogColor;          // 当前生物群系的雾色（含时间/天气影响）
uniform float fogDensity;
uniform float far;
uniform int fogMode;            // 0 = linear, 1 = exp, 2 = exp2（本骨架简化处理，只做提示）

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 color;
varying vec3 normal;
varying vec3 bitangent;
varying float blockId;

void main() {
    // 1) 采样地形图集与光照贴图
    vec4 texel = texture2D(texture, texcoord);
    vec4 light = texture2D(lightmap, lmcoord);

    // 2) 顶点色（生物群系着色、受击红闪等）
    vec4 outColor = texel * color;

    // 3) 光照：直接使用光照贴图颜色 * 一个基础环境光
    outColor.rgb *= light.rgb * (0.15 + 0.85 * lightmapBrightness(lmcoord, 1.0));

    // 4) 雾（简化版：按视距线性混合，真实实现请用 fogMode/fogDensity）
    //    gl_FragCoord.z 是屏幕深度，配合 far 做粗略线性雾只是示例。
    if (fogMode >= 0) {
        float dist = clamp(gl_FragCoord.z, 0.0, 1.0);
        float fogFactor = clamp((dist - 0.55) / 0.35, 0.0, 1.0);
        outColor.rgb = mix(outColor.rgb, fogColor, fogFactor * 0.75);
    }

    // 5) 透明度小于阈值直接丢弃（避免树叶/草写入深度）
    if (outColor.a < 0.004) discard;

    gl_FragColor = outColor;
}
