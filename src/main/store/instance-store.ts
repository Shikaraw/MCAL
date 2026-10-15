/** 实例 / 服务端 存储：JSON 文件 + 内存缓存。 */

import { join } from 'node:path'
import type { Instance, ServerInstance } from '@shared/types'
import { logger } from '@core/util/logger'
import { ensureDir, readJsonSafe, removePath, writeFileAtomic } from '@core/util/fsx'

const log = logger.scoped('store')

class JsonListStore<T extends { id: string }> {
  private file: string
  private items: T[] = []
  private loaded = false
  private label: string

  constructor(file: string, label: string) {
    this.file = file
    this.label = label
  }

  async load(): Promise<T[]> {
    const data = await readJsonSafe<T[] | null>(this.file, null)
    this.items = Array.isArray(data) ? data : []
    this.loaded = true
    return this.items
  }

  private async ensure(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  async list(): Promise<T[]> {
    await this.ensure()
    return [...this.items]
  }

  async get(id: string): Promise<T | null> {
    await this.ensure()
    return this.items.find((item) => item.id === id) ?? null
  }

  async upsert(item: T): Promise<T> {
    await this.ensure()
    const index = this.items.findIndex((existing) => existing.id === item.id)
    if (index >= 0) this.items[index] = item
    else this.items.push(item)
    await this.flush()
    return item
  }

  async remove(id: string): Promise<boolean> {
    await this.ensure()
    const before = this.items.length
    this.items = this.items.filter((item) => item.id !== id)
    if (this.items.length !== before) {
      await this.flush()
      return true
    }
    return false
  }

  async flush(): Promise<void> {
    await ensureDir(join(this.file, '..'))
    await writeFileAtomic(this.file, JSON.stringify(this.items, null, 2))
  }

  async deleteFile(): Promise<void> {
    await removePath(this.file)
    this.items = []
  }

  describe(): string {
    return `${this.label}(${this.items.length})`
  }
}

export class InstanceStore {
  private store: JsonListStore<Instance>

  constructor(opts: { rootDir: string }) {
    this.store = new JsonListStore<Instance>(join(opts.rootDir, 'instances.json'), 'instances')
  }

  load(): Promise<Instance[]> {
    return this.store.load()
  }

  list(): Promise<Instance[]> {
    return this.store.list()
  }

  get(id: string): Promise<Instance | null> {
    return this.store.get(id)
  }

  upsert(instance: Instance): Promise<Instance> {
    log.debug(`保存实例 ${instance.name}`)
    return this.store.upsert(instance)
  }

  remove(id: string): Promise<boolean> {
    return this.store.remove(id)
  }
}

export class ServerLlStore implements ServerInstanceStore {
  private store: JsonListStore<ServerInstance>

  constructor(opts: { rootDir: string }) {
    this.store = new JsonListStore<ServerInstance>(join(opts.rootDir, 'servers.json'), 'servers')
  }

  async load(): Promise<ServerInstance[]> {
    return this.store.load()
  }

  async save(servers: ServerInstance[]): Promise<void> {
    for (const server of servers) await this.store.upsert(server)
    await this.store.flush()
  }

  list(): Promise<ServerInstance[]> {
    return this.store.list()
  }

  get(id: string): Promise<ServerInstance | null> {
    return this.store.get(id)
  }

  upsert(server: ServerInstance): Promise<ServerInstance> {
    return this.store.upsert(server)
  }

  remove(id: string): Promise<boolean> {
    return this.store.remove(id)
  }
}

/** 与 ServerManager 约定的存储接口 */
export interface ServerInstanceStore {
  load(): Promise<ServerInstance[]>
  save(servers: ServerInstance[]): Promise<void>
}

export type { JsonListStore }
