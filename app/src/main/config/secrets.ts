/** 密钥存储：Electron safeStorage（Windows DPAPI / macOS Keychain 保护加密密钥）。
 *
 * 设计说明见 docs/design.md 5.9：密钥不落明文，配置文件里只保留 apiKeyRef。
 */

import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { safeStorage } from 'electron'

interface SecretsFile {
  values: Record<string, string>
}

export class SecretStore {
  private values = new Map<string, string>()
  private loaded = false

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as SecretsFile
      for (const [key, encoded] of Object.entries(parsed.values ?? {})) {
        this.values.set(key, decode(encoded))
      }
    } catch {
      // 首次运行
    }
  }

  get(key: string): string | null {
    return this.values.get(key) ?? null
  }

  has(key: string): boolean {
    return this.values.has(key)
  }

  async set(key: string, value: string): Promise<void> {
    await this.load()
    this.values.set(key, value)
    await this.persist()
  }

  async delete(key: string): Promise<void> {
    await this.load()
    this.values.delete(key)
    await this.persist()
  }

  private async persist(): Promise<void> {
    const values: Record<string, string> = {}
    for (const [key, value] of this.values) values[key] = encode(value)
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify({ values } satisfies SecretsFile, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}

function encode(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
  return safeStorage.encryptString(value).toString('base64')
}

function decode(encoded: string): string {
  if (encoded.startsWith('plain:')) return Buffer.from(encoded.slice(6), 'base64').toString('utf8')
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return ''
  }
}
