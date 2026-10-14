/**
 * i18n 源码扫描器：基于 TypeScript AST 找出「应翻译但未包 t()」的中文文案。
 *
 * 同时服务两处：
 * - `scripts/i18n-migrate.mjs`：把文案包进 t()（一次性迁移）
 * - `tests/i18n.test.ts`：CI 中强制「无漏翻」
 *
 * 判定规则（中文原文即消息键，见 src/shared/i18n/index.ts）：
 * - 翻译对象：字符串字面量、模板字符串、JSX 文本节点
 * - 不翻译：已在 t(...) 内、import/export、对象属性名、switch case、
 *   比较/逻辑判断（===/!==/includes/startsWith/...）、元素访问、类型声明
 */

import ts from 'typescript'

const CJK = /[\u3000-\u9fff]/

const LOGIC_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'match',
  'search',
  'test',
  'get',
  'has',
  'startsWith',
])

const COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
])

export function scriptKindFor(fileName) {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

export function parseSource(text, fileName) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
}

function isInsideTranslateCall(node) {
  let parent = node.parent
  while (parent !== undefined) {
    if (
      ts.isCallExpression(parent) &&
      parent.expression.getText(parent.getSourceFile()) === 't' &&
      parent.arguments.some((argument) => argument === node)
    ) {
      return true
    }
    if (ts.isStatement(parent) || ts.isJsxElement(parent)) break
    parent = parent.parent
  }
  return false
}

/** 是否处于「非文案」语境（逻辑判断、类型、导入、键名等） */
function isNonDisplayContext(node) {
  let current = node
  let parent = node.parent
  while (parent !== undefined) {
    if (ts.isCaseClause(parent) && parent.expression === current) return true
    if (ts.isBinaryExpression(parent) && COMPARISON.has(parent.operatorToken.kind)) return true
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      LOGIC_METHODS.has(parent.expression.name.text)
    ) {
      return true
    }
    if (ts.isElementAccessExpression(parent)) return true
    if (ts.isPropertyAssignment(parent) && parent.name === current) return true
    if (
      ts.isImportDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportDeclaration(parent) ||
      ts.isExternalModuleReference(parent)
    ) {
      return true
    }
    if (ts.isLiteralTypeNode(parent) || ts.isTypeAliasDeclaration(parent)) return true
    current = parent
    parent = parent.parent
  }
  return false
}

export function templateBody(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  let body = node.head.text
  for (const span of node.templateSpans) body += '{' + '}' + span.literal.text
  return body
}

/** JSX 文本按 JSX 语义归一空白（换行+缩进折叠为单空格），否则多行文案无法作为键 */
export function normalizeJsxText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** 模板插值内是否含中文（含则本遍先翻译内层，下一遍再翻译模板本体） */
function spansHaveCjk(node) {
  return node.templateSpans.some((span) => {
    let found = false
    const visit = (child) => {
      if (!found && ts.isStringLiteral(child) && hasCjk(child.text)) found = true
      if (!found) ts.forEachChild(child, visit)
    }
    visit(span.expression)
    return found
  })
}

function hasCjk(value) {
  return CJK.test(value)
}

/**
 * 收集文件中需要翻译的节点。
 * @param options.includeTemplates 是否本遍处理模板字符串（嵌套插值需先处理内层）
 * @returns {{ node: ts.Node, kind: 'string'|'template'|'jsx-text', key: string }[]}
 */
export function collectTranslatable(text, fileName, options = {}) {
  const { includeTemplates = true } = options
  const source = parseSource(text, fileName)
  const found = []

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const key = normalizeJsxText(node.text)
      if (hasCjk(key)) found.push({ node, kind: 'jsx-text', key })
      return
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (hasCjk(node.text) && !isInsideTranslateCall(node) && !isNonDisplayContext(node)) {
        found.push({ node, kind: 'string', key: node.text })
        return
      }
      return
    }
    if (ts.isTemplateExpression(node)) {
      const body = templateBody(node)
      const deferred = !includeTemplates || spansHaveCjk(node)
      if (!deferred && hasCjk(body) && !isInsideTranslateCall(node) && !isNonDisplayContext(node)) {
        found.push({ node, kind: 'template', key: buildTemplateKey(node).key })
        return
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return found
}

/** 模板字符串 → { key: '已选 {count} 项', params: [{name, expr}] } */
export function buildTemplateKey(node) {
  const params = []
  const used = new Set()
  let counter = 0
  const parts = [node.head.text]

  node.templateSpans.forEach((span, index) => {
    const expr = span.expression.getText(span.getSourceFile())
    let name = expr.split('.').pop().trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || used.has(name)) {
      name = String(counter++)
    }
    used.add(name)
    params.push({ name, expr })
    parts.push('{' + name + '}')
    parts.push(index === node.templateSpans.length - 1 ? span.literal.text : span.literal.text)
  })

  return { key: parts.join(''), params }
}

export function escapeSingleQuoted(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

/** 把文件内的中文字符串字面量全部视为消息键（用于 error-codes.ts 这类「键注册表」） */
export function collectPlainStrings(text, fileName) {
  const source = parseSource(text, fileName)
  const keys = []
  const visit = (node) => {
    if (ts.isStringLiteral(node) && hasCjk(node.text)) keys.push({ key: node.text, params: [] })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return keys
}

/** 提取文件中 t() 调用的全部消息键（供词典完整性与漏翻检查使用） */
export function collectKeys(text, fileName) {
  const source = parseSource(text, fileName)
  const keys = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 't' &&
      node.arguments.length > 0
    ) {
      const [first] = node.arguments
      if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
        keys.push({ key: first.text, params: [] })
      } else if (ts.isTemplateExpression(first)) {
        const { key, params } = buildTemplateKey(first)
        keys.push({ key, params: params.map((p) => p.name) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return keys
}

/** 生成替换文本（保持原有空白与引号风格） */
export function replacementFor(entry, sourceText, sourceFile) {
  const { node, kind } = entry
  const start = node.getStart(sourceFile)
  const end = node.getEnd()

  if (kind === 'jsx-text') {
    const raw = sourceText.slice(start, end)
    const lead = raw.slice(0, raw.length - raw.trimStart().length)
    const trail = raw.slice(raw.trimEnd().length)
    return `${lead}{t('${escapeSingleQuoted(normalizeJsxText(raw))}')}${trail}`
  }

  if (kind === 'template') {
    const { key, params } = buildTemplateKey(node)
    // 仅当表达式本身就是该标识符时才用简写，否则必须显式赋值
    const args = params.map((p) => (p.expr.trim() === p.name ? p.name : `${p.name}: ${p.expr}`))
    return `t('${escapeSingleQuoted(key)}'${params.length ? `, { ${args.join(', ')} }` : ''})`
  }

  const raw = sourceText.slice(start, end)
  const call = `t(${raw})`
  const parent = node.parent
  if (parent !== undefined && ts.isJsxAttribute(parent) && parent.initializer === node) {
    return `{${call}}`
  }
  return call
}
