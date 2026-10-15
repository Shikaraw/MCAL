#version 120

/* ---------------------------------------------------------------------
 *  world0/gbuffers_terrain.vsh —— 地形（方块）顶点着色器
 *
 *  目录说明：`world0/` 表示「主世界维度」的专用程序；Iris/OptiFine 会为
 *  每个维度查找 world<维度 id>/ 下的同名程序，找不到就回退到 shaders/ 根目录。
 *  其它维度：world-1（下界，dimension id -1）、world1（末地）。
 *
 *  顶点阶段能拿到的常用数据：
 *    at_tangent.w  手性（+1/-1），配合法线算出副切线
 *    mc_Entity.x   方块 id（需要在 shaders.properties 里声明 block.properties
 *                  映射才有实际名字，否则是数字 id）
 *    mc_midTexCoord 方块面纹理中心，用于 uv 与中点比较判断跨面接缝
 * --------------------------------------------------------------------- */

#include "/lib/common.glsl"

attribute vec4 mc_Entity;
attribute vec4 mc_midTexCoord;
attribute vec4 at_tangent;

varying vec2 texcoord;
varying vec2 lmcoord;
varying vec4 color;
varying vec3 normal;
varying vec3 tangent;
varying vec3 bitangent;
varying float blockId;

void main() {
    gl_Position = ftransform();

    texcoord = (gl_TextureMatrix[0] * gl_MultiTexCoord0).xy;
    lmcoord = (gl_TextureMatrix[1] * gl_MultiTexCoord1).xy;

    color = gl_Color;
    blockId = mc_Entity.x;

    normal = normalize(gl_NormalMatrix * gl_Normal);
    tangent = normalize(gl_NormalMatrix * at_tangent.xyz);
    // 副切线：bitangent = cross(normal, tangent) * 手性
    bitangent = normalize(cross(normal, tangent)) * at_tangent.w;
}
