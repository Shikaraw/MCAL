#version 120

/* ---------------------------------------------------------------------
 *  composite.vsh —— 后处理阶段的顶点着色器
 *
 *  composite 阶段是「全屏四边形」绘制：几何信息没有意义，只需要把
 *  屏幕坐标传给片段着色器，用 colortex0..N 做后处理。
 *  注意：不要在顶点阶段用 varying 传递分辨率相关的东西以外的内容。
 * --------------------------------------------------------------------- */

varying vec2 texcoord;

void main() {
    gl_Position = ftransform();
    texcoord = (gl_TextureMatrix[0] * gl_MultiTexCoord0).xy;
}
