/** 工具输出截断（design 5.4：头 60% + 尾 40%，全文落 artifact）。 */

const OUTPUT_LIMIT = 30_000

export interface TruncateResult {
  output: string
  truncated: boolean
}

export function truncateMiddle(text: string, limit: number = OUTPUT_LIMIT, artifactPath?: string): TruncateResult {
  if (text.length <= limit) return { output: text, truncated: false }
  const headLength = Math.floor(limit * 0.6)
  const tailLength = limit - headLength
  const removed = text.length - limit
  const suffix = artifactPath ? `，全文：${artifactPath}` : ''
  return {
    output: `${text.slice(0, headLength)}\n\n[...已截断 ${removed} 字符${suffix}...]\n\n${text.slice(text.length - tailLength)}`,
    truncated: true,
  }
}
