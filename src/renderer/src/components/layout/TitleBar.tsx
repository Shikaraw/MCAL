/**
 * 自绘标题栏。
 *
 * Windows / Linux 下主窗口是无边框的（frame: false），系统不再提供最小化、
 * 最大化、关闭按钮，这里补上；macOS 保留系统红绿灯，只留出拖拽区与安全间距。
 *
 * 拖拽靠 CSS 的 -webkit-app-region: drag（见 global.css 的 .mcal-titlebar），
 * 按 Chromium 的原生行为，双击拖拽区会切换最大化，所以我们订阅主进程推来的
 * 窗口状态事件来同步按钮图标，而不是只在自己点击时切换。
 */

import { useEffect, useState } from 'react'
import { IconClose, IconMinus, IconRestore, IconSquare } from '../ui/icons'
import { mcal } from '../../lib/api'
import { useSystem, useView } from '../../state/store'
import { viewLabel } from './nav'

export function TitleBar(): React.JSX.Element {
  const view = useView((state) => state.view)
  const version = useSystem((state) => state.version)
  const [maximized, setMaximized] = useState(false)

  const platform = mcal.windowPlatform()
  const isMac = platform === 'darwin'

  useEffect(() => {
    if (isMac) return
    let alive = true
    void mcal.isWindowMaximized().then((value) => {
      if (alive) setMaximized(value)
    })
    const off = mcal.onWindowMaximizedChange(setMaximized)
    return () => {
      alive = false
      off()
    }
  }, [isMac])

  return (
    <header className="mcal-titlebar" aria-label="窗口标题栏">
      <div className="row gap-2" style={{ paddingLeft: isMac ? 74 : 0, minWidth: 0 }}>
        <span
          className="fs-xs"
          style={{
            width: 18,
            height: 18,
            borderRadius: 6,
            background: 'var(--g-verdant)',
            color: '#04140b',
            fontWeight: 800,
            fontSize: 9,
            letterSpacing: '-0.03em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          M
        </span>
        <span className="fs-xs faint" style={{ letterSpacing: '0.08em' }}>
          MCAL
        </span>
        <span className="fs-xs faint">·</span>
        <span className="fs-xs truncate" style={{ color: 'var(--c-text-soft)' }}>
          {viewLabel(view)}
        </span>
      </div>

      <div className="row" style={{ marginLeft: 'auto', alignItems: 'stretch', height: '100%' }}>
        {version ? (
          <span className="fs-xs faint row" style={{ padding: '0 10px', alignItems: 'center' }}>
            v{version.app}
          </span>
        ) : null}
        {isMac ? null : (
          <>
            <button
              type="button"
              className="mcal-titlebar__btn"
              title="最小化"
              aria-label="最小化"
              onClick={() => mcal.minimizeWindow()}
            >
              <IconMinus size={14} />
            </button>
            <button
              type="button"
              className="mcal-titlebar__btn"
              title={maximized ? '向下还原' : '最大化'}
              aria-label={maximized ? '向下还原' : '最大化'}
              onClick={() => mcal.maximizeWindow()}
            >
              {maximized ? <IconRestore size={13} /> : <IconSquare size={13} />}
            </button>
            <button
              type="button"
              className="mcal-titlebar__btn mcal-titlebar__btn--close"
              title="关闭"
              aria-label="关闭"
              onClick={() => mcal.closeWindow()}
            >
              <IconClose size={14} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
