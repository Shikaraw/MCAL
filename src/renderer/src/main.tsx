import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 容器')
}

// 阻止在窗口上意外拖放文件导致的页面跳转（拖拽导入由各页面自行处理）
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
