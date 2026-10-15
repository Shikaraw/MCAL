/**
 * Quilt 加载器安装。
 *
 * 与 Fabric 的差异（reference/HMCL/.../download/quilt/QuiltInstallTask.java 与
 * QuiltRemoteVersion.LOADER_META_URL）：
 *  - meta 版本是 v3：`{quiltMeta}/v3/versions/loader/<gameVersion>`
 *    列表元素形如 `{ loader: { version, stable }, hashed: {...}, intermediary: {...}, launcherMeta }`；
 *    HMCL 在拼库时优先用 intermediary、没有时才用 hashed，并把 org.quiltmc 的库指向
 *    https://maven.quiltmc.org/repository/release/ —— 但这些库信息已经完整包含在我们直接
 *    写入的 profile json 里，不需要手工重建。
 *  - profile：`{quiltMeta}/v3/versions/loader/<gameVersion>/<loaderVersion>/profile/json`
 *  - 版本 id：`quilt-loader-<loaderVersion>-<gameVersion>`
 *
 * 因为 Quilt 是 Fabric 的 fork，协议（含库版本提升/覆盖继承）与 Fabric 完全同构，
 * 这里直接复用 FabricLikeLoader。
 */

import { OFFICIAL_ENDPOINTS } from '@core/net/mirror'
import { FabricLikeLoader, type FabricLikeLoaderOptions } from './fabric'

export class QuiltLoader extends FabricLikeLoader {
  constructor(opts: FabricLikeLoaderOptions) {
    super(opts, {
      // 必须用 quiltMeta 常量：MirrorResolver 按 url 前缀分别映射 fabric/quilt 两套 meta
      metaEndpoint: OFFICIAL_ENDPOINTS.quiltMeta,
      listPath: (gameVersion) => `/v3/versions/loader/${encodeURIComponent(gameVersion)}`,
      profilePath: (gameVersion, loaderVersion) =>
        `/v3/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
      idPrefix: 'quilt-loader-',
      cacheNamespace: 'quilt',
      displayName: 'Quilt'
    })
  }
}
