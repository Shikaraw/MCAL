#version 120

/* ---------------------------------------------------------------------
 *  gbuffers_basic.vsh —— 基础几何的顶点着色器
 *
 *  这个程序负责「不属于其它专用程序」的几何：粒子、线框、水面辅助面、
 *  部分实体装饰等。保持极简：只做坐标变换与属性传递。
 *
 *  OptiFine / Iris 提供的常用内置变量（GLSL 120 固定管线风格）：
 *    gl_Vertex / gl_Normal / gl_Color / gl_MultiTexCoord0..3
 *    gl_ModelViewProjectionMatrix / gl_NormalMatrix / gl_TextureMatrix[0]
 *    ftransform() = gl_ModelViewProjectionMatrix * gl_Vertex
 *  以及光影包专用 attribute：
 *    mc_Entity      .x = 方块 id（方块类几何才有意义）
 *    mc_midTexCoord .xy = 方块面纹理中心（用于判断是否跨面）
 *    at_tangent     .xyz = 切线，.w = 手性
 * --------------------------------------------------------------------- */

attribute vec4 mc_Entity;
attribute vec4 mc_midTexCoord;

varying vec2 texcoord;
varying vec4 color;
varying vec2 lmcoord;
varying float blockId;

void main() {
    // 屏幕空间坐标
    gl_Position = ftransform();

    // 纹理坐标：gl_TextureMatrix[0] 里包含动画纹理的偏移（水、岩浆等）
    texcoord = (gl_TextureMatrix[0] * gl_MultiTexCoord0).xy;

    // 光照贴图坐标（0..1）：x = 方块光，y = 天空光
    lmcoord = (gl_TextureMatrix[1] * gl_MultiTexCoord1).xy;

    // 顶点颜色：MC 用它做生物群系着色、受击红闪、附魔光效等
    color = gl_Color;

    blockId = mc_Entity.x;
}
