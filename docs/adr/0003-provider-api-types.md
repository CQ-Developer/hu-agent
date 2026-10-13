# ADR 0003：Provider 适配层与三种 API 接入类型

- 状态：已接受
- 日期：2026-10-13（模型配置支持 API 类型选择时确定）

## 背景

原实现只支持 OpenAI Chat Completions 协议（`type: 'openai-compatible'`）。但同一厂商往往同时提供多种接入方式（OpenAI 有 Chat Completions 与 Responses；Anthropic 是独立的 Messages API），不同厂商支持的子集也不同。需求要求模型配置时选择 API 类型。

## 决策

1. Provider 配置用 `apiType` 表达接入协议，取值：
   - `openai-chat`：`POST {baseUrl}/chat/completions`
   - `openai-responses`：`POST {baseUrl}/responses`
   - `anthropic-messages`：`POST {baseUrl}/messages`（`x-api-key` + `anthropic-version`）
2. 网关（`ModelGateway`）按 apiType 分派到独立适配器，对外只暴露统一的 `StreamEvent`（text / reasoning / tool_call / usage / done）。
3. 适配器各自负责：消息与工具结构转换、SSE 事件解析、思考强度映射、usage 字段归一化。
4. 旧配置（`type: 'openai-compatible'`）在加载时自动迁移为 `apiType: 'openai-chat'`。

## 关键映射与取舍

| 能力 | openai-chat | openai-responses | anthropic-messages |
| --- | --- | --- | --- |
| 思考强度 | `reasoning_effort` | `reasoning: { effort, summary }` | `thinking.budget_tokens`（2048/8192/16384） |
| 思考内容流 | `reasoning_content` 增量 | `reasoning_summary_text.delta` | `thinking_delta` + `signature_delta` |
| 工具结果 | `role: tool` 消息 | `function_call_output` 条目 | user 消息内的 `tool_result` 块（相邻合并） |
| 缓存 token | `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` | `input_tokens_details.cached_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| 思考签名 | 无 | 无（不回传 reasoning 条目） | 有，工具续轮必须回传 thinking 块 |

Anthropic 的 thinking 签名随会话 JSONL 的 `reasoning` 部分持久化；Responses API 的历史 reasoning 条目不回传（服务端仍保留上下文），避免因缺少加密字段导致 400。

## 后果

- 新增协议只需实现一个 `ProviderStreamOptions -> StreamEvent` 的适配器并注册，不改循环与 UI；
- 代价是三套协议的事件解析需要各自维护单测（已覆盖请求体转换与流式解析）；
- 思考强度是"尽力而为"的能力：未声明的模型不发送相关参数；
- 验证情况：`anthropic-messages` 适配器已用 DeepSeek 的 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`）真实联调——基础对话、思考强度（budget）、工具调用与思考签名回放均通过。
