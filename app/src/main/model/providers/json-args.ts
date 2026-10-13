/** 工具调用参数的容错解析。 */

export function parseArguments(text: string | undefined): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}
