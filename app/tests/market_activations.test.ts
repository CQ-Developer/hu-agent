/**
 * 激活上报条目组装单测（design 5.10.3）：Skill 与 MCP 双类型、作用域与市场来源。
 * `reportActivationSnapshot` 的网络路径由 `cloud_reporter` 测试覆盖，这里只锁纯函数。
 */

import { describe, expect, it } from 'vitest'

import { buildActivationItems, buildMcpActivationItems } from '../src/main/market/activations'
import type { InstalledSkill } from '../src/main/market/installer'
import type { McpCatalogEntry } from '../src/main/mcp/config'
import type { SkillInfo } from '../src/main/skills/manager'

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'pdf-report',
    description: '导出 PDF',
    version: '1.0.0',
    scope: 'global',
    path: '/skills/pdf-report',
    enabled: true,
    ...overrides,
  }
}

function installedSkill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    skillId: 'skill-1',
    teamId: 'team-1',
    name: 'pdf-report',
    version: '1.0.0',
    digest: 'sha256:abc',
    installedAt: '2026-01-01T00:00:00.000Z',
    source: 'market',
    ...overrides,
  }
}

describe('buildActivationItems（Skill）', () => {
  it('只取指定作用域；市场来源带 skillId，本地 Skill refId 为空', () => {
    const items = buildActivationItems(
      [
        skill(), // 有市场来源
        skill({ name: 'local-skill', scope: 'workspace' }), // 本地
        skill({ name: 'other-ws', scope: 'workspace' }),
      ],
      [installedSkill()],
      'global',
    )
    expect(items).toEqual([
      {
        type: 'skill',
        source: 'market',
        refId: 'skill-1',
        name: 'pdf-report',
        version: '1.0.0',
        enabled: true,
      },
    ])

    const workspaceItems = buildActivationItems(
      [skill({ name: 'local-skill', scope: 'workspace' })],
      [],
      'workspace',
    )
    expect(workspaceItems).toEqual([
      { type: 'skill', source: 'local', refId: null, name: 'local-skill', version: '1.0.0', enabled: true },
    ])
  })
})

describe('buildMcpActivationItems', () => {
  function entry(overrides: Partial<McpCatalogEntry['config']> = {}, name = 'github'): McpCatalogEntry {
    return { name, scope: 'global', config: { transport: 'stdio', command: 'npx', ...overrides } }
  }

  it('市场来源带 mcpId 与字符串版本；本地配置 refId/version 为空', () => {
    const items = buildMcpActivationItems(
      [
        entry({ source: { type: 'market', mcpId: 'mcp-1', version: 2 }, enabled: { global: true } }),
        entry({ enabled: { global: true } }, 'local-mcp'),
      ],
      'global',
      'ws_1',
    )
    expect(items).toEqual([
      { type: 'mcp', source: 'market', refId: 'mcp-1', name: 'github', version: '2', enabled: true },
      { type: 'mcp', source: 'local', refId: null, name: 'local-mcp', version: null, enabled: true },
    ])
  })

  it('workspace 作用域按 enabled.workspaces 判定', () => {
    const items = buildMcpActivationItems(
      [
        entry({ enabled: { workspaces: ['ws_1'] } }, 'in-ws'),
        entry({ enabled: { workspaces: ['ws_2'] } }, 'other-ws'),
        entry({ enabled: { global: true } }, 'global-only'),
      ],
      'workspace',
      'ws_1',
    )
    expect(items.map((item) => `${item.name}:${item.enabled}`)).toEqual([
      'in-ws:true',
      'other-ws:false',
      'global-only:false',
    ])
  })
})
