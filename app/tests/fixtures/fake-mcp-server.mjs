/**
 * 测试用 MCP server（stdio，换行分隔 JSON-RPC 2.0）。
 * 提供 echo（分页出现）与 ping，另有一个总是报错的工具 fail。
 */
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    handle(JSON.parse(line))
  }
})

function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      capabilities: { tools: {} },
    })
    return
  }
  if (method === 'tools/list') {
    if (!params?.cursor) {
      respond(id, {
        tools: [{ name: 'echo', description: '回显输入文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
        nextCursor: 'page2',
      })
    } else {
      respond(id, { tools: [{ name: 'ping', description: 'Ping 测试', inputSchema: { type: 'object', properties: {} } }] })
    }
    return
  }
  if (method === 'tools/call') {
    if (params?.name === 'fail') {
      respondError(id, -32000, '工具执行失败')
      return
    }
    respond(id, { content: [{ type: 'text', text: `echo:${params?.arguments?.text ?? ''}` }], isError: false })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (id !== undefined) respondError(id, -32601, `未知方法：${method}`)
}

function respond(id, result) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondError(id, code, message) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}
