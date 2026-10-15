/**
 * 权限门控测试：访问级别（仅工作区 / 完全访问）× 权限模式 × 敏感操作。
 *
 * 这里只测 registry 的判定函数（纯逻辑，不涉及 electron、不碰真实文件）。
 */

import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ToolRegistry,
  collectPathArgs,
  isOutsideWorkspace,
  type ToolDefinitionWithHandler
} from '@agent/tools/registry'

const WORKSPACE = resolve(join('D:', 'mcal-data'))
const INSTANCE = resolve(join('D:', 'mcal-data', 'instances', 'survival'))
const OUTSIDE = resolve(join('C:', 'Users', 'someone', 'Documents'))

const workspace = { mode: 'workspace' as const, roots: [WORKSPACE, INSTANCE], confirmSensitive: true }
const full = { mode: 'full' as const, roots: [WORKSPACE, INSTANCE], confirmSensitive: true }
const fullNoSensitiveGuard = { mode: 'full' as const, roots: [WORKSPACE, INSTANCE], confirmSensitive: false }

/** 只读工具 */
const readTool: ToolDefinitionWithHandler = {
  name: 'read_file',
  description: 'read',
  parameters: { type: 'object', properties: {} },
  category: 'filesystem',
  readOnly: true,
  requiresPaths: true,
  handler: async () => ({ ok: true, output: '' })
}

/** 普通写工具：工作区内自动放行 */
const writeTool: ToolDefinitionWithHandler = {
  name: 'write_file',
  description: 'write',
  parameters: { type: 'object', properties: {} },
  category: 'filesystem',
  requiresPaths: true,
  permissionFor: (args) => ({ summary: `写入：${String(args.path ?? '')}`, risk: 'low' }),
  handler: async () => ({ ok: true, output: '' })
}

/** 危险写工具：删除 */
const deleteTool: ToolDefinitionWithHandler = {
  name: 'delete_path',
  description: 'delete',
  parameters: { type: 'object', properties: {} },
  category: 'filesystem',
  dangerous: true,
  requiresPaths: true,
  permissionFor: (args) => ({ summary: `删除：${String(args.path ?? '')}`, risk: 'high' }),
  handler: async () => ({ ok: true, output: '' })
}

/** 能绕过沙箱的工具：执行命令 */
const shellTool: ToolDefinitionWithHandler = {
  name: 'run_command',
  description: 'run',
  parameters: { type: 'object', properties: {} },
  category: 'shell',
  dangerous: true,
  escapesWorkspace: true,
  handler: async () => ({ ok: true, output: '' })
}

/** 不声明 requiresPaths 的危险工具（例如安装加载器） */
const installTool: ToolDefinitionWithHandler = {
  name: 'install_loader',
  description: 'install',
  parameters: { type: 'object', properties: {} },
  category: 'minecraft',
  dangerous: true,
  handler: async () => ({ ok: true, output: '' })
}

function registry(): ToolRegistry {
  const reg = new ToolRegistry()
  reg.registerAll([readTool, writeTool, deleteTool, shellTool, installTool])
  return reg
}

const inWorkspace = { path: join(WORKSPACE, 'mods', 'a.jar') }

describe('collectPathArgs / isOutsideWorkspace', () => {
  it('只收集已知路径键，字符串数组也展开', () => {
    expect(collectPathArgs({ path: 'a', paths: ['b', 'c'], content: 'd', timeoutMs: 3 })).toEqual(['a', 'b', 'c'])
  })

  it('子目录算工作区内，前缀相似的旁支目录不算', () => {
    expect(isOutsideWorkspace(join(WORKSPACE, 'a', 'b'), [WORKSPACE])).toBe(false)
    expect(isOutsideWorkspace(`${WORKSPACE}-backup`, [WORKSPACE])).toBe(true)
  })

  it('相对路径按 roots[0] 解析，.. 逃逸算越界', () => {
    expect(isOutsideWorkspace(join('game', 'mods'), [WORKSPACE])).toBe(false)
    expect(isOutsideWorkspace(join('..', '..', 'Windows', 'System32'), [WORKSPACE])).toBe(true)
  })

  it('大小写与斜杠不影响判断（Windows 路径）', () => {
    expect(isOutsideWorkspace(WORKSPACE.toUpperCase().replace(/\\/g, '/'), [WORKSPACE])).toBe(false)
  })

  it('没有 roots 时不判定越界（避免误伤未提供沙箱信息的场景）', () => {
    expect(isOutsideWorkspace(OUTSIDE, [])).toBe(false)
  })
})

describe('仅工作区级别', () => {
  it('工作区内的写入在 auto-safe 下自动放行', () => {
    expect(registry().resolvePermission('write_file', inWorkspace, 'auto-safe', workspace).spec).toBeNull()
  })

  it('工作区外的路径直接拒绝，并且提示如何切换访问级别', () => {
    const verdict = registry().resolvePermission('write_file', { path: join(OUTSIDE, 'x.txt') }, 'auto-all', workspace)
    expect(verdict.spec).toBeNull()
    expect(verdict.denied).toContain('不在允许范围内')
    expect(verdict.denied).toContain('完全访问')
  })

  it('工作区外的读取同样拒绝（只读工具也不例外）', () => {
    const verdict = registry().resolvePermission('read_file', { path: join(OUTSIDE, 'secret.txt') }, 'auto-all', workspace)
    expect(verdict.denied).toBeTruthy()
  })

  it('run_command 一律拒绝：它无法被路径沙箱约束', () => {
    const verdict = registry().resolvePermission('run_command', { command: 'dir' }, 'auto-all', workspace)
    expect(verdict.denied).toContain('仅工作区')
    expect(verdict.spec).toBeNull()
  })

  it('删除工作区内的文件在 auto-safe 下仍要确认', () => {
    expect(registry().resolvePermission('delete_path', inWorkspace, 'auto-safe', workspace).spec?.risk).toBe('high')
  })

  it('deletes 在 auto-all + confirmSensitive 下也要确认', () => {
    const verdict = registry().resolvePermission('delete_path', inWorkspace, 'auto-all', workspace)
    expect(verdict.spec?.risk).toBe('high')
  })

  it('不声明路径参数的工具按原策略走（不误判越界）', () => {
    expect(registry().resolvePermission('install_loader', { version: '1.20.1' }, 'auto-safe', workspace).spec?.risk).toBe(
      'high'
    )
  })
})

describe('完全访问级别', () => {
  it('工作区外的写入在 auto-safe 下必须确认，且风险视为高危', () => {
    const verdict = registry().resolvePermission('write_file', { path: join(OUTSIDE, 'x.txt') }, 'auto-safe', full)
    expect(verdict.spec?.risk).toBe('high')
    expect(verdict.spec?.detail).toContain('工作区之外')
  })

  it('工作区外的写入在 auto-all 下也要确认（confirmSensitive 开启）', () => {
    const verdict = registry().resolvePermission('write_file', { path: join(OUTSIDE, 'x.txt') }, 'auto-all', full)
    expect(verdict.spec).not.toBeNull()
  })

  it('关闭 confirmSensitive 后，auto-all 不再为越界写入弹窗', () => {
    const verdict = registry().resolvePermission(
      'write_file',
      { path: join(OUTSIDE, 'x.txt') },
      'auto-all',
      fullNoSensitiveGuard
    )
    expect(verdict.spec).toBeNull()
  })

  it('工作区外的读取放行（诊断系统 Java、其它启动器目录都要用到）', () => {
    expect(registry().resolvePermission('read_file', { path: join(OUTSIDE, 'log.txt') }, 'auto-safe', full).spec).toBeNull()
  })

  it('工作区内的普通写入仍然自动放行', () => {
    expect(registry().resolvePermission('write_file', inWorkspace, 'auto-safe', full).spec).toBeNull()
  })

  it('run_command 在完全访问下允许执行但必须确认', () => {
    const verdict = registry().resolvePermission('run_command', { command: 'java -version' }, 'ask', full)
    expect(verdict.spec?.risk).toBe('high')
  })
})

describe('权限模式与授权记忆', () => {
  it('只读模式拒绝所有写操作，放行读取', () => {
    const reg = registry()
    expect(reg.resolvePermission('write_file', inWorkspace, 'readonly', workspace).denied).toBeTruthy()
    expect(reg.resolvePermission('read_file', inWorkspace, 'readonly', workspace).spec).toBeNull()
  })

  it('未知工具直接拒绝', () => {
    expect(registry().resolvePermission('nope', {}, 'auto-safe', workspace).denied).toContain('未知工具')
  })

  it('工具已声明的权限说明会被保留，越界信息附加在其后', () => {
    const verdict = registry().resolvePermission('delete_path', { path: join(OUTSIDE, 'a.jar') }, 'ask', full)
    expect(verdict.spec?.summary).toContain('删除')
    expect(verdict.spec?.detail).toContain('工作区之外')
  })
})
