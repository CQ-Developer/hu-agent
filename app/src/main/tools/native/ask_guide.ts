/**
 * pi 原生工具（R2）：`ask_guide`。
 *
 * 交互类工具：需要用户拍板时给出结构化选项并**阻塞等待**选择，而不是在正文里追问。
 * 走我们的 `InteractionBroker`（企业侧能力：审批与提问都由它统一桥接到 UI），
 * 因此按会话构造（需要 sessionId/turnId，用于把请求路由到正确的窗口与轮次）。
 */

import { Type } from 'typebox'

import type { InteractionBroker } from '../../permissions/broker'
import { ToolFailure, type NativeTool, type ToolFactoryOptions } from './tool'

interface GuideInput {
  question: string
  options: Array<{ label: string; value: string; description?: string }>
  recommended?: string
  allow_free_text?: boolean
}

export interface AskGuideOptions extends ToolFactoryOptions {
  interactions: InteractionBroker
  sessionId: string
  turnId: string
}

export function createAskGuideTool(options: AskGuideOptions): NativeTool {
  return {
    name: 'ask_guide',
    label: '向用户提问',
    category: 'interact',
    description: '当需要用户拍板时使用：给出结构化选项（可带推荐项）并阻塞等待选择，而不是在正文里追问。',
    parameters: Type.Object({
      question: Type.String({ description: '要询问的问题' }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: '显示文案' }),
          value: Type.String({ description: '返回给模型的值' }),
          description: Type.Optional(Type.String({ description: '补充说明' })),
        }),
        { description: '候选项（最多 6 个）' },
      ),
      recommended: Type.Optional(Type.String({ description: '推荐项的 value' })),
      allow_free_text: Type.Optional(Type.Boolean({ description: '是否允许用户自定义输入' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as GuideInput
      if (!input.question || !Array.isArray(input.options) || input.options.length === 0) {
        throw new ToolFailure('ask_guide 需要 question 与至少一个 option')
      }

      const answer = await options.interactions.askGuide({
        sessionId: options.sessionId,
        turnId: options.turnId,
        question: input.question,
        options: input.options.slice(0, 6).map((option) => ({
          label: option.label,
          value: option.value,
          description: option.description,
        })),
        recommended: input.recommended,
        allowFreeText: input.allow_free_text ?? false,
      })

      // 用户没选（关闭/取消）不是技术错误：status 标 denied 供审计与界面区分
      if (!answer) throw new ToolFailure('用户取消了提问（无选择）', 'denied')

      return {
        content: [{ type: 'text' as const, text: `用户选择：${answer}` }],
        details: { answer },
      }
    },
  }
}
