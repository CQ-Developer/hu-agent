/**
 * 轻量数据请求 hook（v1 不引入 TanStack Query，见 design 7.1 备注）：
 * - 自动处理加载态与错误
 * - 请求竞态保护（只接受最后一次请求结果）
 * - reload() 手动重取
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload(): Promise<void>
}

export function useAsync<T>(factory: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const factoryRef = useRef(factory)
  factoryRef.current = factory

  const run = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const result = await factoryRef.current()
      if (id === requestId.current) {
        setData(result)
        setError(null)
      }
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading, error, reload: run }
}
