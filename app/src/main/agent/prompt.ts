/** 系统提示词（design 5.2.3）：角色、工作空间、Skill 元数据与工具规范。
 *
 * 提示词本体保持单一语言书写（避免翻译影响提示词质量），
 * 仅按当前语言注入「回复语言」指令（design 5.13）。
 */

import { getLocale } from '../i18n'

const REPLY_LANGUAGE: Record<string, string> = {
  'zh-CN': '- 回答与注释默认使用简体中文；代码与标识符使用英文。',
  'en-US':
    '- Reply and write comments in English by default; keep code and identifiers in English.',
}

export function buildSystemPrompt(workspaceRoot: string, skillSection?: string): string {
  const parts = [
    '你是 hu-agent，一个在用户本地机器上工作的编程助手。',
    '',
    '行为准则：',
    REPLY_LANGUAGE[getLocale()] ?? REPLY_LANGUAGE['zh-CN'],
    '- 需要文件内容时先读取，不要凭空猜测；修改文件使用 edit_file 精确替换，整文件重写使用 write_file。',
    '- 执行命令前先说明目的；命令失败时阅读错误输出再决定下一步，不要盲目重试。',
    '- 不编造工具执行结果；不确定时通过 ask、读取文件或可用 Skill 确认。',
    '',
    `工作空间根目录：${workspaceRoot}`,
    '所有文件路径与命令工作目录都相对该目录；越界路径会被拒绝。',
  ]
  if (skillSection) parts.push('', skillSection)
  return parts.join('\n')
}

/** 历史压缩提示（模型面向文案，白名单见 scripts/i18n-config.mjs） */
export const HISTORY_SUMMARY_SYSTEM =
  '你是对话压缩器。把用户给出的对话记录压缩成要点摘要，保留事实、数字、路径与未完成事项。只输出摘要正文。'
