/**
 * The refusal sentences of the repository, read out of the source.
 *
 * A refusal is authored in one of three shapes, and every one of them hands a
 * person the same kind of text, so one reader finds them all:
 *
 *   - an object literal carrying a literal `reason` and a `message`
 *     (`{ ok: false, reason: 'not-found', message: '…' }`);
 *   - a call whose first argument is a literal reason code and whose second is
 *     the message (`refuse('not-found', '…')`, `fail(…)`, `new XError(…)`);
 *   - a top-level `const` the message names (`message: STALE_SOURCE_MESSAGE`),
 *     followed to its initializer when that is a string.
 *
 * A message built by a function (`message: describe(x)`) is not read here: the
 * function is the author, and its own file's literals are read where they are
 * written. What cannot be proven short by reading the source is left to the
 * suite that calls the function.
 *
 * Template spans are replaced by {@link SPAN_WIDTH} characters. A refusal
 * names a file, a binding or a prop, and the usual name is about that long.
 */
import ts from 'typescript'

/** A name interpolated into a sentence is counted as this many characters. */
const SPAN_WIDTH = 10

export interface RefusalSentence {
  /** Repo-relative, posix. */
  file: string
  line: number
  reason: string
  /** The text with every interpolation replaced by {@link SPAN_WIDTH} characters. */
  text: string
  /** A toast that carries an `action`: the button is the remedy, so the body only has to say what is true. */
  remedyIsAction?: boolean
}

/** A run of interpolated names at the very start of a sentence, before the first word of prose. */
const LEADING_NAMES = new RegExp(`^(?:x{${SPAN_WIDTH}})+\\s*(?=[A-Z])`)

const REASON_CODE =/^[a-z]+(-[a-z0-9]+)*$/
const REFUSAL_CALLEE = /refus|fail|Error|Signal|Refusal|reject/i

/** A template span: a sentence constant is read through, anything else is a name of about {@link SPAN_WIDTH} characters. */
function spanText(expr: ts.Expression, constants: ReadonlyMap<string, string>): string {
  const inner = ts.isConditionalExpression(expr) ? expr.whenTrue : expr
  const known = ts.isIdentifier(inner) ? constants.get(inner.text) : undefined
  return known ?? 'x'.repeat(SPAN_WIDTH)
}

function messageText(expr: ts.Expression, constants: ReadonlyMap<string, string>): string | null {
  if (ts.isStringLiteralLike(expr)) return expr.text
  if (ts.isParenthesizedExpression(expr)) return messageText(expr.expression, constants)
  if (ts.isTemplateExpression(expr)) {
    return expr.head.text + expr.templateSpans.map((s) => spanText(s.expression, constants) + s.literal.text).join('')
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = messageText(expr.left, constants) ?? 'x'.repeat(SPAN_WIDTH)
    const right = messageText(expr.right, constants) ?? 'x'.repeat(SPAN_WIDTH)
    return left + right
  }
  if (ts.isIdentifier(expr)) return constants.get(expr.text) ?? null
  return null
}

export function stringConstantsOf(file: string, source: string): Map<string, string> {
  return topLevelStringConstants(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))
}

function topLevelStringConstants(sf: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const text = messageText(decl.initializer, constants)
      if (text !== null) constants.set(decl.name.text, text)
    }
  }
  return constants
}

/** Every refusal sentence a source file writes down, in file order. */
export function readRefusalSentences(file: string, source: string, shared: ReadonlyMap<string, string> = new Map()): RefusalSentence[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const constants = new Map([...shared, ...topLevelStringConstants(sf)])
  const found: RefusalSentence[] = []
  const seen = new Set<number>()
  const push = (reason: string, message: ts.Expression, remedyIsAction = false): void => {
    // `a ? 'one sentence' : 'another'`: each branch is a refusal of its own.
    if (ts.isConditionalExpression(message)) {
      push(reason, message.whenTrue, remedyIsAction)
      push(reason, message.whenFalse, remedyIsAction)
      return
    }
    if (seen.has(message.pos)) return
    const raw = messageText(message, constants)
    if (raw === null) return
    // A sentence assembled from names alone (`${a}${b}`) is judged where its parts are written.
    const text = raw.replace(LEADING_NAMES, '')
    if (/^[x:\s.,]*$/.test(text)) return
    seen.add(message.pos)
    found.push({ file, line: sf.getLineAndCharacterOfPosition(message.getStart()).line + 1, reason, text, ...(remedyIsAction ? { remedyIsAction } : {}) })
  }
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let reason: string | null = null
      let message: ts.Expression | null = null
      let failed = false
      let warning = false
      let toastAction = false
      let toastBody: ts.Expression | null = null
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
        if (prop.name.text === 'reason' && ts.isStringLiteralLike(prop.initializer)) reason = prop.initializer.text
        if (prop.name.text === 'message' || prop.name.text === 'explanation') message = prop.initializer
        if (prop.name.text === 'ok' && prop.initializer.kind === ts.SyntaxKind.FalseKeyword) failed = true
        if (prop.name.text === 'kind' && ts.isStringLiteralLike(prop.initializer) && prop.initializer.text === 'warning') warning = true
        if (prop.name.text === 'body') toastBody = prop.initializer
      }
      toastAction = node.properties.some((p) => (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'action') || ts.isSpreadAssignment(p))
      // A refusal is a warning toast: its body is the sentence the person reads.
      if (warning && toastBody) push('warning-toast', toastBody, toastAction)
      if (message && (reason || failed)) push(reason ?? 'ok-false', message)
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments && node.arguments.length >= 2) {
      const [code, message] = node.arguments
      if (code && message && ts.isStringLiteralLike(code) && REASON_CODE.test(code.text) && REFUSAL_CALLEE.test(node.expression.getText(sf))) {
        push(code.text, message)
      }
    }
    // The server's two refusal doors take their reason from a variable as often as a literal.
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      const callee = node.expression.getText(sf)
      if (callee === 'StudioEditRefusalError' && node.arguments[1]) push('studio-edit-refusal', node.arguments[1])
      if (callee === 'refusalFor' && node.arguments[2]) push('studio-edit-refusal', node.arguments[2])
      // The two typed errors whose own message is what the person reads.
      if ((callee === 'JsxPropTargetError' || callee === 'JsxStyleTargetError') && node.arguments[0]) push(callee, node.arguments[0])
    }
    // `refuse('…')`: a local helper whose only argument is the sentence.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'refuse' && node.arguments.length === 1) {
      push('refuse', node.arguments[0]!)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // A record of sentences keyed by reason (`UNWRITABLE_SENTENCE`).
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !/SENTENCE$/.test(decl.name.text) || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue
      for (const prop of decl.initializer.properties) {
        if (ts.isPropertyAssignment(prop)) push(prop.name.getText(sf).replace(/['"]/g, ''), prop.initializer)
      }
    }
  }
  // A top-level sentence constant named for what it is (`…_REFUSAL`, `…_SENTENCE`).
  for (const [name, text] of topLevelStringConstants(sf)) {
    if (/(?:REFUSAL|SENTENCE|REMEDY)$/.test(name)) found.push({ file, line: 0, reason: name, text })
  }
  return found
}

/** Longest a refusal may be: two toast lines. */
export const MAX_REFUSAL_CHARS = 190
export const MAX_REFUSAL_SENTENCES = 2

/**
 * The verbs a remedy opens with. A refusal's last sentence is the thing to do,
 * so it starts with one of these; a sentence that only states a fact is not a
 * remedy.
 */
const REMEDY_VERBS = [
  'add', 'allow', 'apply', 'ask', 'assign', 'do', 'draw', 'frame', 'nudge', 'pass', 'position', 're-export', 'switch', 'widen', 'change', 'check', 'choose', 'click', 'close', 'convert', 'copy', 'destructure', 'enter', 'insert', 'point', 'reduce', 'rewrite', 'simplify', 'create', 'delete', 'detach',
  'drag', 'drop', 'duplicate', 'edit', 'enable', 'export', 'extract', 'finish', 'fix', 'give', 'group', 'hold', 'import',
  'inline', 'install', 'keep', 'make', 'merge', 'move', 'name', 'open', 'paste', 'pick', 'place', 'press', 'put', 'reload',
  'remove', 'rename', 'reorder', 'replace', 'resize', 'restore', 'retry', 'run', 'save', 'select', 'set', 'show', 'split',
  'start', 'style', 'swap', 'try', 'turn', 'type', 'undo', 'ungroup', 'unlock', 'unroll', 'update', 'use', 'wait', 'wrap', 'write',
]
const REMEDY_VERB = REMEDY_VERBS.join('|')

/** Sentence ends: a stop followed by a space and the start of another sentence. */
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z"“`<'(])/

export function sentencesOf(text: string): string[] {
  return text.trim().split(SENTENCE_BREAK).filter(Boolean)
}

/** Why a refusal sentence breaks the copy rule, or `null` when it keeps it. */
export function copyViolation(text: string, options: { remedyIsAction?: boolean } = {}): string | null {
  const sentences = sentencesOf(text)
  if (sentences.length > MAX_REFUSAL_SENTENCES) return `${sentences.length} sentences (at most ${MAX_REFUSAL_SENTENCES})`
  if (text.length > MAX_REFUSAL_CHARS) return `${text.length} characters (at most ${MAX_REFUSAL_CHARS})`
  const remedy = sentences[sentences.length - 1] ?? ''
  if (options.remedyIsAction) return null
  if (!new RegExp(`^(?:then\\s+)?(?:${REMEDY_VERB})\\b`, 'i').test(remedy)) {
    return 'the last sentence is not a remedy (it must open with what to do: Reload, Drag, Edit, …)'
  }
  if (/,\s+or\s|\beither\b|\bor\s+(?:else|instead)\b/i.test(remedy) || new RegExp(`\\bor\\s+(?:${REMEDY_VERB})\\b`, 'i').test(remedy)) {
    return 'the remedy offers two ways out (one remedy per refusal)'
  }
  return null
}

/**
 * Every sentence-like string in a file: a literal that opens with a capital (or
 * a quote or backtick) and closes with a full stop. Used on the files that build
 * their refusal text through helpers rather than in a `{ reason, message }`
 * shape, where the structured reader cannot see it. `lines` already read are
 * skipped, so a sentence is never judged twice.
 */
export function readSentenceLiterals(file: string, source: string, skipLines: ReadonlySet<number>): RefusalSentence[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: RefusalSentence[] = []
  const visit = (node: ts.Node) => {
    let text: string | null = null
    if (ts.isStringLiteralLike(node)) text = node.text
    else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map((s) => 'x'.repeat(SPAN_WIDTH) + s.literal.text).join('')
    const importLike = node.parent !== undefined && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))
    if (text !== null && !importLike && /^[A-Z"`<'].{40,}[.!]$/s.test(text) && text.includes(' ')) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
      if (!skipLines.has(line)) found.push({ file, line, reason: 'sentence', text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/**
 * Every refusal reason code a file can produce, whether or not its sentence can
 * be read here: an object that carries a literal `reason` next to a `message` /
 * `explanation` / `ok: false`, a refusal call that names its code first, a record
 * of sentences keyed by code, and the two typed errors whose code is a default.
 */
export function readReasonCodes(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const codes = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let reason: string | null = null
      let carriesSentence = false
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
        if (prop.name.text === 'reason' && ts.isStringLiteralLike(prop.initializer) && REASON_CODE.test(prop.initializer.text)) reason = prop.initializer.text
        if (prop.name.text === 'message' || prop.name.text === 'explanation') carriesSentence = true
        if (prop.name.text === 'ok' && prop.initializer.kind === ts.SyntaxKind.FalseKeyword) carriesSentence = true
      }
      if (reason && carriesSentence) codes.add(reason)
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments && node.arguments.length >= 2) {
      const [code] = node.arguments
      const callee = node.expression.getText(sf)
      if (code && ts.isStringLiteralLike(code) && REASON_CODE.test(code.text) && REFUSAL_CALLEE.test(callee)) codes.add(code.text)
      if (callee === 'JsxPropTargetError') {
        const third = node.arguments[2]
        codes.add(third && ts.isStringLiteralLike(third) ? third.text : 'binding-overwrite')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !/SENTENCE$/.test(decl.name.text) || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue
      for (const prop of decl.initializer.properties) {
        if (ts.isPropertyAssignment(prop)) codes.add(prop.name.getText(sf).replace(/['"]/g, ''))
      }
    }
  }
  return [...codes]
}
