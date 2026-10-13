/** CSV 生成（纯函数，便于测试）：RFC 4180 引号转义 + CRLF 行尾。 */

export function escapeCsvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(escapeCsvField).join(','), ...rows.map((row) => row.map(escapeCsvField).join(','))]
  return `${lines.join('\r\n')}\r\n`
}

/** 供渲染进程触发下载（BOM 让 Excel 正确识别 UTF-8）。 */
export function csvBlob(content: string): Blob {
  return new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' })
}
