import { useEffect } from 'react'
import { Background, Sidebar, StatusStrip, Toasts } from './components/layout/Shell'
import { TitleBar } from './components/layout/TitleBar'
import { useInstances, useSettings, useSystem, useTasks, useView } from './state/store'
import { HomeView } from './views/HomeView'
import { InstancesView } from './views/InstancesView'
import { VersionsView } from './views/VersionsView'
import { ContentView } from './views/ContentView'
import { ModpackView } from './views/ModpackView'
import { ServerView } from './views/ServerView'
import { JavaView } from './views/JavaView'
import { AgentView } from './views/AgentView'
import { MemoryView } from './views/MemoryView'
import { KnowledgeView } from './views/KnowledgeView'
import { DevView } from './views/DevView'
import { SettingsView } from './views/SettingsView'

export function App(): React.JSX.Element {
  const view = useView((state) => state.view)
  const loadSettings = useSettings((state) => state.load)
  const refreshInstances = useInstances((state) => state.refresh)
  const initTasks = useTasks((state) => state.init)
  const loadSystem = useSystem((state) => state.load)

  useEffect(() => {
    void loadSettings()
    void refreshInstances()
    initTasks()
    void loadSystem()
  }, [loadSettings, refreshInstances, initTasks, loadSystem])

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflow: 'hidden',
        background: 'var(--c-void)'
      }}
    >
      <TitleBar />
      <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Background />
        <Sidebar />
        <main
          style={{
            position: 'relative',
            zIndex: 1,
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <StatusStrip />
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ViewSwitch view={view} />
          </div>
        </main>
        <Toasts />
      </div>
    </div>
  )
}

function ViewSwitch({ view }: { view: string }): React.JSX.Element {
  switch (view) {
    case 'instances':
      return <InstancesView />
    case 'versions':
      return <VersionsView />
    case 'content':
      return <ContentView />
    case 'modpack':
      return <ModpackView />
    case 'server':
      return <ServerView />
    case 'java':
      return <JavaView />
    case 'agent':
      return <AgentView />
    case 'memory':
      return <MemoryView />
    case 'knowledge':
      return <KnowledgeView />
    case 'dev':
      return <DevView />
    case 'settings':
      return <SettingsView />
    case 'home':
    default:
      return <HomeView />
  }
}
