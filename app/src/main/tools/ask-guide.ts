/** ask_guide：主动向用户提问并给出选项（design 5.4.3）。 */

import { defineTool, type ToolResult } from './types'

interface Option {
  label: string
  value: string
  description?: string
}

interface Input {
  question: string
  options: Option[]
  recommended?: string
  allow_free_text?: boolean
}

export const askGuideTool = defineTool<Input>({
  name: 'ask_guide',
  category: 'interact',
  description:
    '当需要用户拍板时使用：给出结构化选项（可带推荐项）并阻塞等待选择，而不是在正文里追问。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要询问的问题' },
      options: {
        type: 'array',
        description: '候选项（1-6 个）',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '显示文案' },
            value: { type: 'string', description: '返回给模型的值' },
            description: { type: 'string', description: '补充说明' },
          },
          required: ['label', 'value'],
        },
      },
      recommended: { type: 'string', description: '推荐项的 value' },
      allow_free_text: { type: 'boolean', description: '是否允许用户自定义输入' },
    },
    required: ['question', 'options'],
  },
  async run(input, ctx): Promise<ToolResult> {
    if (!input.question || !Array.isArray(input.options) || input.options.length === 0) {
      return { status: 'error', output: 'ask_guide 需要 question 与至少一个 option' }
    }

    const answer = await ctx.interactions.askGuide({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      question: input.question,
      options: input.options.slice(0, 6).map((option) => ({
        label: option.label,
        value: option.value,
        description: option.description,
      })),
      recommended: input.recommended,
      allowFreeText: input.allow_free_text ?? false,
    })

    if (!answer) return { status: 'denied', output: '用户取消了提问（无选择）' }
    return { status: 'ok', output: `用户选择：${answer}` }
  },
})
