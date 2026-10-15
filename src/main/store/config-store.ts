/** 启动器配置持久化：单文件 JSON，带默认值合并与节流写入。 */

import { join } from 'node:path'
import type { Account, DeepPartial, McalSettings } from '@shared/types'
import { logger } from '@core/util/logger'
import { ensureDir, pathExists, readJsonSafe, writeFileAtomic } from '@core/util/fsx'

const log = logger.scoped('settings')

export function defaultSettings(rootDir: string): McalSettings {
  return {
    rootDir,
    defaultGameDir: join(rootDir, 'minecraft'),
    mirror: {
      mojang: 'bmclapi',
      forge: 'bmclapi',
      fabric: 'bmclapi',
      modrinth: 'official'
    },
    download: {
      concurrency: 16,
      speedLimitKB: 0,
      timeoutMs: 20_000,
      retries: 3,
      verifyHash: true
    },
    java: {
      scanDirs: [],
      autoDownload: true
    },
    launcher: {
      closeOnLaunch: false,
      minimizeOnLaunch: true,
      showGameWindowLog: true,
      locale: 'zh-CN',
      motion: 'full'
    },
    agent: {
      accessMode: 'workspace',
      permissionMode: 'auto-safe',
      confirmSensitive: true,
      // 记住 10 分钟的授权，避免同一个操作反复弹窗
      grantRememberMs: 10 * 60 * 1000,
      compactionThreshold: 120_000,
      memoryEnabled: true,
      knowledgeEnabled: true,
      memoryRecallLimit: 4,
      networkToolsEnabled: true,
      shellEnabled: true,
      skillDirs: [],
      maxTurnsPerRequest: 25,
      stream: true
    },
    gameDirs: [],
    update: {
      autoCheck: true,
      source: 'mirror',
      mirrorId: 'ghproxy',
      useSystemProxy: false,
      repo: 'Shikaraw/MinecraftAgentLauncher'
    },
    media: {
      providers: []
    },
    providers: [],
    accounts: [],
    activeAccountId: undefined,
    ui: {
      lastView: 'home',
      sidebarCollapsed: false
    }
  }
}

/** 深合并：以默认值为底，用户值覆盖；数组整体替换 */
export function mergeSettings(base: McalSettings, patch: DeepPartial<McalSettings>): McalSettings {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    // 手改坏的文件里可能出现 `"agent": null`，这种一律当没写，避免整个启动器读配置就崩
    if (value === null) continue
    const current = out[key]
    if (Array.isArray(value)) {
      out[key] = value
    } else if (typeof value === 'object' && current !== null && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = mergeSettings(current as McalSettings, value as DeepPartial<McalSettings>)
    } else {
      out[key] = value
    }
  }
  return out as unknown as McalSettings
}

export class SettingsStore {
  private file: string
  private rootDir: string
  private value: McalSettings
  private flushTimer: NodeJS.Timeout | null = null

  constructor(opts: { rootDir: string; file?: string }) {
    this.rootDir = opts.rootDir
    this.file = opts.file ?? join(opts.rootDir, 'settings.json')
    this.value = defaultSettings(opts.rootDir)
  }

  async load(): Promise<McalSettings> {
    const stored = await readJsonSafe<DeepPartial<McalSettings> | null>(this.file, null)
    this.value = stored ? mergeSettings(defaultSettings(this.rootDir), stored) : defaultSettings(this.rootDir)
    // 保证关键路径存在
    this.value.rootDir = this.rootDir
    if (!this.value.defaultGameDir) this.value.defaultGameDir = join(this.rootDir, 'minecraft')
    // 首次运行自动选一个默认 provider
    if (!this.value.agent.activeProviderId && this.value.providers.length > 0) {
      this.value.agent.activeProviderId = this.value.providers[0].id
    }
    log.info(`配置已加载：${this.file}`)
    return this.value
  }

  get(): McalSettings {
    return this.value
  }

  update(patch: DeepPartial<McalSettings>): McalSettings {
    this.value = mergeSettings(this.value, patch)
    this.scheduleFlush()
    return this.value
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 300)
    this.flushTimer.unref?.()
  }

  async flush(): Promise<void> {
    await ensureDir(this.rootDir)
    await writeFileAtomic(this.file, JSON.stringify(this.value, null, 2))
  }

  /* --------------------------- 账号 --------------------------- */

  listAccounts(): Account[] {
    return this.value.accounts
  }

  addAccount(account: Account): Account {
    this.value.accounts = [...this.value.accounts.filter((a) => a.id !== account.id), account]
    if (!this.value.activeAccountId) this.value.activeAccountId = account.id
    void this.flush()
    return account
  }

  removeAccount(id: string): void {
    this.value.accounts = this.value.accounts.filter((a) => a.id !== id)
    if (this.value.activeAccountId === id) this.value.activeAccountId = this.value.accounts[0]?.id
    void this.flush()
  }

  setActiveAccount(id: string): void {
    if (!this.value.accounts.some((a) => a.id === id)) throw new Error(`账号不存在：${id}`)
    this.value.activeAccountId = id
    void this.flush()
  }

  getActiveAccount(): Account | null {
    const id = this.value.activeAccountId
    if (id) {
      const found = this.value.accounts.find((a) => a.id === id)
      if (found) return found
    }
    return this.value.accounts[0] ?? null
  }

  /** 首个已配置的 provider（用于 Agent） */
  getActiveProvider(): McalSettings['providers'][number] | null {
    const id = this.value.agent.activeProviderId
    if (id) {
      const found = this.value.providers.find((p) => p.id === id)
      if (found) return found
    }
    return this.value.providers.find((p) => p.apiKey) ?? null
  }

  async ensureLoaded(): Promise<void> {
    if (!(await pathExists(this.file))) {
      this.value = defaultSettings(this.rootDir)
      await this.flush()
    }
  }
}
