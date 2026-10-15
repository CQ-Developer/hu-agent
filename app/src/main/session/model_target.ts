/**
 * 会话模型目标（`provider/modelId`）的解析与自愈。
 *
 * 背景（2026-10-15 实测缺陷）：用户把 provider 从 `deepseek` 改成 `token-hub` 后，历史会话里
 * 仍存着旧目标 `deepseek/deepseek-flash`；pi 的模型注册表找不到它，回合以 `no_model` 失败，
 * 而模型下拉显示的是"当前可用模型"。这里把"不可用的旧目标回退到当前默认模型"做成纯函数，
 * 由 IPC 层在读取/运行会话前调用并持久化，避免历史会话永远打不通。
 */

export interface ModelTarget {
  provider: string
  modelId: string
}

/** `provider/modelId` → 目标；非法返回 null（modelId 可含 `/`，只按第一个斜杠切分） */
export function parseModelTarget(target: string | undefined | null): ModelTarget | null {
  const value = (target ?? '').trim()
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

export interface HealResult {
  /** 最终可用目标（可能是回退后的默认）；无可用目标时为 null */
  target: string | null
  /** 是否发生回退（调用方据此把新目标写回会话） */
  healed: boolean
}

/**
 * 选择会话应使用的模型目标：
 * 1. 会话已存目标仍在可用列表 → 原样使用；
 * 2. 否则回退到默认目标（若默认可用）→ `healed = true`，调用方持久化；
 * 3. 都不行 → null（上层按"未配置模型"处理）。
 */
export function healModelTarget(
  stored: string | undefined | null,
  available: Iterable<string>,
  fallback: string | undefined | null,
): HealResult {
  const usable = new Set(available)
  if (stored && usable.has(stored)) return { target: stored, healed: false }
  if (fallback && usable.has(fallback)) return { target: fallback, healed: true }
  return { target: null, healed: false }
}
