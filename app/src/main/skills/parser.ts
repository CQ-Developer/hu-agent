import { t } from '../i18n'
/** SKILL.md 解析（design 5.7.1）：front matter（YAML 子集）+ 正文。 */

export interface SkillRequires {
  tools?: string[]
  bins?: string[]
  network?: boolean
}

export interface SkillFrontMatter {
  name: string
  description: string
  version?: string
  whenToUse?: string
  requires?: SkillRequires
  tags?: string[]
  minAppVersion?: string
}

export interface ParsedSkill {
  frontMatter: SkillFrontMatter
  body: string
}

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillParseError'
  }
}

/** 简易 semver 比较（忽略 pre-release）；仅用于挑选激活版本。 */
export function compareSemver(left: string, right: string): number {
  const parse = (value: string): number[] =>
    (value.split('-')[0] ?? '').split('.').map((part) => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** 解析 SKILL.md：必须包含 `---` 包裹的 front matter，且带 name/description。 */
export function parseSkillFile(content: string): ParsedSkill {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    throw new SkillParseError(t('SKILL.md 缺少 front matter（应以 --- 开头）'))
  }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) throw new SkillParseError(t('SKILL.md front matter 未闭合（缺少结束的 ---）'))
  const yamlText = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '')

  const raw = parseYamlSubset(yamlText)
  const name = typeof raw.name === 'string' ? raw.name : ''
  const description = typeof raw.description === 'string' ? raw.description : ''
  if (!name) throw new SkillParseError(t('front matter 缺少 name'))
  if (!description) throw new SkillParseError(t('front matter 缺少 description'))

  const requiresRaw = isRecord(raw.requires) ? raw.requires : undefined
  const requires: SkillRequires | undefined = requiresRaw
    ? {
        tools: toStringArray(requiresRaw.tools),
        bins: toStringArray(requiresRaw.bins),
        network: typeof requiresRaw.network === 'boolean' ? requiresRaw.network : undefined,
      }
    : undefined

  return {
    frontMatter: {
      name,
      description,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      whenToUse: typeof raw.when_to_use === 'string' ? raw.when_to_use : undefined,
      requires,
      tags: toStringArray(raw.tags),
      minAppVersion: typeof raw.min_app_version === 'string' ? raw.min_app_version : undefined,
    },
    body,
  }
}

/** 仅支持 Skill front matter 所需的 YAML 子集：一层嵌套、块列表、内联列表、布尔/字符串。 */
export function parseYamlSubset(text: string): Record<string, unknown> {
  const lines = text
    .split('\n')
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }))
    .filter((line) => line.text.length > 0 && !line.text.startsWith('#'))

  const root: Record<string, unknown> = {}
  let index = 0

  const nextContentLine = (): { indent: number; text: string } | undefined => lines[index]

  const parseBlock = (): Record<string, unknown> | unknown[] | string => {
    const first = lines[index]
    if (!first) return {}
    const isArray = first.text.startsWith('- ')
    const container: Record<string, unknown> | unknown[] = isArray ? [] : {}
    const indent = first.indent

    while (index < lines.length) {
      const line = lines[index]
      if (!line || line.indent < indent) break
      if (line.indent > indent) break // 由上层接管

      if (Array.isArray(container)) {
        if (!line.text.startsWith('- ')) break
        container.push(coerceScalar(line.text.slice(2)))
        index += 1
        continue
      }

      const colon = line.text.indexOf(':')
      if (colon < 0) break
      const key = line.text.slice(0, colon).trim()
      const valueText = line.text.slice(colon + 1).trim()
      index += 1

      if (valueText.length > 0) {
        container[key] = coerceScalar(valueText)
        continue
      }

      const child = nextContentLine()
      if (child && child.indent > line.indent) {
        container[key] = parseBlock()
      } else {
        container[key] = {}
      }
    }
    return container
  }

  // 顶层逐键解析（避免顶层被整体当作嵌套块）
  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.indent !== 0) break
    const colon = line.text.indexOf(':')
    if (colon < 0) break
    const key = line.text.slice(0, colon).trim()
    const valueText = line.text.slice(colon + 1).trim()
    index += 1

    if (valueText.length > 0) {
      root[key] = coerceScalar(valueText)
      continue
    }
    const child = nextContentLine()
    if (child && child.indent > 0) {
      root[key] = parseBlock()
    } else {
      root[key] = {}
    }
  }
  return root
}

function coerceScalar(text: string): unknown {
  const value = text.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item.length > 0)
  }
  return stripQuotes(value)
}

function stripQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item))
}
