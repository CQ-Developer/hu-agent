/** 路径沙箱单测（design 5.5.4/5.5.5）。 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  canonicalizePath,
  expandUser,
  isProtectedWritePath,
  isSensitivePath,
} from '../src/main/permissions/paths'
import { PermissionPathError } from '../src/main/permissions/types'

describe('权限路径沙箱', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huagent-perm-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('工作空间内相对/绝对路径都判定为 inside', async () => {
    await writeFile(join(root, 'a.txt'), 'hi', 'utf8')
    const relative = await canonicalizePath('a.txt', root)
    const absolute = await canonicalizePath(join(root, 'a.txt'), root)
    expect(relative.insideWorkspace).toBe(true)
    expect(absolute.insideWorkspace).toBe(true)
  })

  it('.. 逃逸判定为 outside', async () => {
    const result = await canonicalizePath('../outside.txt', root)
    expect(result.insideWorkspace).toBe(false)
  })

  it('符号链接指向工作空间外时判定为 outside', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'huagent-outside-'))
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'x', 'utf8')
      try {
        await symlink(outsideDir, join(root, 'link'), 'junction')
      } catch {
        return // Windows 无权限创建符号链接时跳过
      }
      const result = await canonicalizePath('link/secret.txt', root)
      expect(result.insideWorkspace).toBe(false)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('~ 展开为用户目录', () => {
    expect(expandUser('~/.ssh/config')).toBe(join(homedir(), '.ssh', 'config'))
  })

  it('敏感路径匹配 ~/.ssh 与 ~/.aws', () => {
    expect(isSensitivePath(join(homedir(), '.ssh', 'id_rsa'), root)).toBe(true)
    expect(isSensitivePath(join(homedir(), '.aws', 'credentials'), root)).toBe(true)
    expect(isSensitivePath(join(root, 'src', 'index.ts'), root)).toBe(false)
  })

  it('保护文件（写入）匹配工作空间 .hu 配置与全局密钥文件', () => {
    expect(isProtectedWritePath(join(root, '.hu', 'settings.json'), root)).toBe(true)
    expect(isProtectedWritePath(join(root, '.hu', 'logs', 'audit.jsonl'), root)).toBe(true)
    expect(isProtectedWritePath(join(homedir(), '.hu-agent', 'config.json'), root)).toBe(true)
    expect(isProtectedWritePath(join(root, 'src', 'app.ts'), root)).toBe(false)
  })

  it('Windows 下拒绝保留设备名与 UNC 路径', async () => {
    if (process.platform !== 'win32') return
    await expect(canonicalizePath('NUL', root)).rejects.toBeInstanceOf(PermissionPathError)
    await expect(canonicalizePath('\\\\server\\share\\x', root)).rejects.toBeInstanceOf(PermissionPathError)
  })

  it('空路径报错', async () => {
    await expect(canonicalizePath('', root)).rejects.toBeInstanceOf(PermissionPathError)
  })
})
