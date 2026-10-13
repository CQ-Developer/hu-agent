/** 云账户本地配置（design 4.1）：服务器地址与设备指纹持久化在 ~/.hu-agent/cloud.json。
 *
 * 刷新令牌不在这里：它在 safeStorage 密钥库（见 cloud/client.ts）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { cloudConfigFile } from '../config/paths'
import { uuidv7 } from './uuidv7'

export interface CloudConfig {
  serverUrl: string
  /** 设备指纹（首次启动生成，跨会话稳定） */
  deviceId: string
  userId?: string
  email?: string
  displayName?: string
  isSystemAdmin?: boolean
  locale?: string
}

export class CloudStore {
  private cache: CloudConfig | null = null

  constructor(private readonly file: string = cloudConfigFile()) {}

  async load(): Promise<CloudConfig> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<CloudConfig>
      this.cache = {
        serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
        deviceId: parsed.deviceId && parsed.deviceId.length > 0 ? parsed.deviceId : uuidv7(),
        userId: parsed.userId,
        email: parsed.email,
        displayName: parsed.displayName,
        isSystemAdmin: parsed.isSystemAdmin,
        locale: parsed.locale,
      }
    } catch {
      this.cache = { serverUrl: '', deviceId: uuidv7() }
      await this.persist(this.cache)
      return this.cache
    }
    return this.cache
  }

  async save(patch: Partial<CloudConfig>): Promise<CloudConfig> {
    const current = await this.load()
    this.cache = { ...current, ...patch }
    await this.persist(this.cache)
    return this.cache
  }

  /** 登出：清掉账号信息，保留服务器地址与设备指纹。 */
  async clearAccount(): Promise<CloudConfig> {
    return this.save({ userId: undefined, email: undefined, displayName: undefined, isSystemAdmin: undefined })
  }

  private async persist(config: CloudConfig): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(config, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
