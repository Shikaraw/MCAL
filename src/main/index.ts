/**
 * Electron 主进程入口。
 *
 * 职责：创建服务容器 → 创建窗口 → 注册 IPC → 处理生命周期。
 * 业务逻辑一律放在核心引擎与 LauncherApi 里，这里只做编排。
 */

import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { AgentEvent, PermissionRequest, PermissionResponse } from '@shared/types'
import { logger } from '@core/util/logger'
import { ensureDir } from '@core/util/fsx'
import { ServiceContainer } from './container'
import { LauncherApi } from './launcher-api'
import { registerIpc } from './ipc'
import { registerPendingPermission, rejectAllPending } from './permissions'
import { UpdateService } from './update'
import { APP_NAME, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from './store/defaults'

let mainWindow: BrowserWindow | null = null
let container: ServiceContainer | null = null
let updateService: UpdateService | null = null
let disposeIpc: (() => void) | null = null

/** 判定资源目录：dev 下是项目根，打包后在 asar 内 */
function resolveResourcesRoot(): string {
  return join(app.getAppPath(), 'resources')
}

/** 窗口图标：打包后由 electron-builder 复制到 resourcesPath，开发时直接读项目内文件。 */
function resolveWindowIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png'), join(resolveResourcesRoot(), 'icon.png')]
    : [join(resolveResourcesRoot(), 'icon.png')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform === 'darwin',
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 允许渲染进程加载本地字体与图片（贴图预览）
      webSecurity: true
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  // 外部链接交给系统浏览器打开，不在应用内导航
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 阻止渲染进程被导航到外部页面
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer && url.startsWith(devServer)) return
    // 只放行应用自己的渲染页面：file:// 整站放行等于让任意本地 HTML 接管这个窗口
    if (url.startsWith(pathToFileURL(join(__dirname, '../renderer')).href)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function bootstrap(): Promise<void> {
  const rootDir = app.getPath('userData')
  await ensureDir(rootDir)
  logger.setFilePath(join(rootDir, 'logs', 'mcal.log'))
  logger.info('main', `${APP_NAME} 启动（Electron ${process.versions.electron}, Node ${process.versions.node}）`)

  container = new ServiceContainer({
    rootDir,
    resourcesRoot: resolveResourcesRoot(),
    userResourcesRoot: join(rootDir, 'user-resources'),
    appVersion: app.getVersion()
  })
  await container.init()

  const api = new LauncherApi({
    container,
    getAccount: () => container!.settings.getActiveAccount()
  })
  container.setLauncherApi(api)
  await container.refreshMemo()

  // Agent 事件桥：主进程 → 渲染进程；授权请求往返
  container.emitAgentEvent = (sessionId: string, event: AgentEvent): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('agent:event', { sessionId, event })
  }

  container.requestAgentPermission = async (
    sessionId: string,
    request: Omit<PermissionRequest, 'id'>
  ): Promise<PermissionResponse> => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { id: '', decision: 'deny', scope: 'once' }
    }
    const { randomUUID } = await import('node:crypto')
    const id = `perm_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    container!.emitAgentEvent(sessionId, { type: 'permission_request', request: { ...request, id } })
    return new Promise<PermissionResponse>((resolve) => {
      registerPendingPermission(id, resolve)
    })
  }

  mainWindow = createWindow()

  updateService = new UpdateService({
    getVersion: () => app.getVersion(),
    getSettings: () => ({ update: container!.settings.get().update }),
    getWindow: () => mainWindow,
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:event', event)
      }
    }
  })

  disposeIpc = registerIpc({
    container,
    api,
    getWindow: () => mainWindow,
    emitAgentEvent: (sessionId, event) => container!.emitAgentEvent(sessionId, event),
    updateService,
    onQuit: () => app.quit()
  })

  // 任务进度广播
  container.tasks.onEvent((task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task:event', task)
    }
  })

  // 启动后自动检查更新：等窗口先画出来，失败也只是后台一条日志
  if (container.settings.get().update.autoCheck) {
    setTimeout(() => {
      void updateService
        ?.check()
        .then((result) => {
          // 记录检查时间，让设置页的「上次检查」在自动检查后也是准的
          container!.settings.update({ update: { lastCheckAt: result.checkedAt } })
          void container!.settings.flush().catch(() => undefined)
          // 检查成功就把结果推给界面（无论有没有新版本）：「关于」页靠它同步「上次检查」时间
          if (result.ok) {
            mainWindow?.webContents.send('update:event', { type: 'available', result })
          }
        })
        .catch((err: unknown) => logger.debug('main', `启动检查更新失败：${String(err)}`))
    }, 3000)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.mcal.launcher')
  nativeTheme.themeSource = 'dark'

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    await bootstrap()
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    logger.error('main', `启动失败：${message}`)
    const { dialog } = await import('electron')
    dialog.showErrorBox('MCAL 启动失败', message)
    app.quit()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  rejectAllPending('应用退出')
  void (async () => {
    try {
      disposeIpc?.()
      await container?.shutdown()
    } catch (err) {
      logger.error('main', `退出清理失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })()
})

process.on('uncaughtException', (err) => {
  logger.error('main', `未捕获异常：${err.stack ?? err.message}`)
})
process.on('unhandledRejection', (reason) => {
  logger.error('main', `未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : String(reason)}`)
})
