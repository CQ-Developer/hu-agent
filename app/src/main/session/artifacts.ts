/** 超长工具输出的全文落盘（design 5.4.2）。 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class ArtifactStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  /** 保存全文，返回相对工作空间的路径（写入 JSONL 用）。 */
  async save(callId: string, text: string): Promise<string> {
    await this.init()
    const file = join(this.dir, `${sanitize(callId)}.txt`)
    await writeFile(file, text, 'utf8')
    return file
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}
