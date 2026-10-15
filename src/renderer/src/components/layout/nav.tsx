/** 导航表：侧边栏与（自绘）标题栏共用，单独成模块避免组件间循环依赖。 */

import type { ReactNode } from 'react'
import {
  IconBook,
  IconBox,
  IconBrain,
  IconCode,
  IconCoffee,
  IconCube,
  IconDownload,
  IconHome,
  IconLayers,
  IconServer,
  IconSettings,
  IconSparkles
} from '../ui/icons'
import type { ViewId } from '../../state/store'

export interface NavItem {
  id: ViewId
  label: string
  icon: ReactNode
  group: 'game' | 'ai' | 'system'
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: '启动', icon: <IconHome size={17} />, group: 'game' },
  { id: 'instances', label: '实例', icon: <IconCube size={17} />, group: 'game' },
  { id: 'versions', label: '下载', icon: <IconDownload size={17} />, group: 'game' },
  { id: 'content', label: '资源', icon: <IconBox size={17} />, group: 'game' },
  { id: 'modpack', label: '整合包', icon: <IconLayers size={17} />, group: 'game' },
  { id: 'server', label: '服务端', icon: <IconServer size={17} />, group: 'game' },
  { id: 'java', label: 'Java', icon: <IconCoffee size={17} />, group: 'game' },
  { id: 'agent', label: 'AI 助手', icon: <IconSparkles size={17} />, group: 'ai' },
  { id: 'memory', label: '记忆', icon: <IconBrain size={17} />, group: 'ai' },
  { id: 'knowledge', label: '知识库', icon: <IconBook size={17} />, group: 'ai' },
  { id: 'dev', label: '开发', icon: <IconCode size={17} />, group: 'ai' },
  { id: 'settings', label: '设置', icon: <IconSettings size={17} />, group: 'system' }
]

/** 当前视图的中文标题（标题栏用；导航表里没有的视图回落到品牌名） */
export function viewLabel(id: ViewId): string {
  return NAV_ITEMS.find((item) => item.id === id)?.label ?? 'MCAL'
}
