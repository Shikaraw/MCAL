/**
 * 自动更新核心逻辑的统一入口。
 *
 * 只包含纯逻辑（更新源解析、版本比较、检查与版本历史），不依赖 Electron：
 * 网络抓取由调用方注入 FetchLike，主进程侧负责把它接到 Electron 的 net 模块
 * （含系统代理开关与超时），渲染层只消费返回结果。
 */

export * from './mirrors'
export * from './version'
export * from './check'
