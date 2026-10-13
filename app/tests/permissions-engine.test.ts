/** 权限引擎单测（design 5.5.2/5.5.3）。 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditLog } from '../src/main/permissions/audit'
import type { InteractionBroker } from '../src/main/permissions/broker'
import { PermissionEngine } from '../src/main/permissions/engine'
import type { ApprovalChoice, PermissionCheck, PolicyRule } from '../src/main/permissions/types'
import { appendWorkspaceRule, loadWorkspaceRules } from '../src/main/workspace-settings'

class FakeBroker {
  calls: unknown[] = []
  choice: ApprovalChoice = 'deny'

  async requestApproval(request: unknown): Promise<ApprovalChoice> {
    this.calls.push(request)
    return this.choice
  }
}

function makeCheck(root: string, overrides: Partial<PermissionCheck>): PermissionCheck {
  return {
    workspaceRoot: root,
    sessionId: 's1',
    turnId: 't1',
    toolCallId: 'c1',
    toolName: 'read_file',
    category: 'read',
    input: {},
    ...overrides,
  }
}

describe('PermissionEngine', () => {
  let root: string
  let broker: FakeBroker
  let audit: AuditLog

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huagent-engine-'))
    broker = new FakeBroker()
    audit = new AuditLog(join(root, '.hu', 'logs', 'audit.jsonl'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function engine(rules: PolicyRule[] = [], grants = new Map<string, Set<string>>()): PermissionEngine {
    return new PermissionEngine({
      workspaceRoot: root,
      rules,
      globalRules: [],
      grants,
      broker: broker as unknown as InteractionBroker,
      audit,
      persistRule: (rule) => appendWorkspaceRule(join(root, '.hu', 'settings.json'), rule),
    })
  }

  it('工作空间内读取直接允许，不触发授权卡片', async () => {
    const decision = await engine().check(makeCheck(root, { input: { path: 'src/a.ts' } }))
    expect(decision.action).toBe('allow')
    expect(broker.calls).toHaveLength(0)
  })

  it('工作空间外读取触发授权；拒绝时不放行', async () => {
    broker.choice = 'deny'
    const decision = await engine().check(makeCheck(root, { input: { path: '../outside.txt' } }))
    expect(decision.action).toBe('deny')
    expect(broker.calls).toHaveLength(1)
  })

  it('“一次”授权不记忆，第二次仍会询问', async () => {
    broker.choice = 'allow_once'
    const instance = engine()
    await instance.check(makeCheck(root, { input: { path: '../outside.txt' } }))
    await instance.check(makeCheck(root, { input: { path: '../outside.txt' } }))
    expect(broker.calls).toHaveLength(2)
  })

  it('“本会话”授权后同路径不再询问', async () => {
    broker.choice = 'allow_session'
    const instance = engine()
    await instance.check(makeCheck(root, { input: { path: '../outside.txt' } }))
    const second = await instance.check(makeCheck(root, { input: { path: '../outside.txt' } }))
    expect(second.action).toBe('allow')
    expect(broker.calls).toHaveLength(1)
  })

  it('“始终允许”写入工作空间策略并可被重新加载', async () => {
    broker.choice = 'allow_always'
    await engine().check(makeCheck(root, { input: { path: '../outside.txt' } }))

    const rules = await loadWorkspaceRules(join(root, '.hu', 'settings.json'))
    expect(rules).toHaveLength(1)
    expect(rules[0]?.action).toBe('allow')

    // 新引擎实例（模拟重启）加载规则后不再询问
    broker.calls = []
    const reloaded = engine(rules)
    const decision = await reloaded.check(makeCheck(root, { input: { path: '../outside.txt' } }))
    expect(decision.action).toBe('allow')
    expect(broker.calls).toHaveLength(0)
  })

  it('敏感路径直接拒绝，不弹卡片', async () => {
    const decision = await engine().check(
      makeCheck(root, { input: { path: join(homedir(), '.ssh', 'id_rsa') } }),
    )
    expect(decision.action).toBe('deny')
    expect(broker.calls).toHaveLength(0)
  })

  it('保护文件写入直接拒绝，不弹卡片', async () => {
    const decision = await engine().check(
      makeCheck(root, {
        toolName: 'write_file',
        category: 'write',
        input: { path: '.hu/settings.json', content: '{}' },
      }),
    )
    expect(decision.action).toBe('deny')
    expect(broker.calls).toHaveLength(0)
  })

  it('策略规则优先于默认：显式 allow 越界路径', async () => {
    const rules: PolicyRule[] = [{ tools: ['read_file'], paths: ['<workspace>/../shared/**'], action: 'allow' }]
    const decision = await engine(rules).check(makeCheck(root, { input: { path: '../shared/a.txt' } }))
    expect(decision.action).toBe('allow')
    expect(broker.calls).toHaveLength(0)
  })

  it('exec 默认询问，授权卡片带命令摘要', async () => {
    broker.choice = 'allow_once'
    const decision = await engine().check(
      makeCheck(root, { toolName: 'bash', category: 'exec', input: { command: 'ls -la' } }),
    )
    expect(decision.action).toBe('allow')
    expect((broker.calls[0] as { summary: string }).summary).toBe('ls -la')
  })

  it('每次决策写入审计日志', async () => {
    const instance = engine()
    await instance.check(makeCheck(root, { input: { path: 'a.txt' } }))
    const raw = await readFile(join(root, '.hu', 'logs', 'audit.jsonl'), 'utf8')
    const entries = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; decision: string; argsDigest: string })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ tool: 'read_file', decision: 'allow' })
    expect(entries[0]?.argsDigest.startsWith('sha256:')).toBe(true)
  })
})
