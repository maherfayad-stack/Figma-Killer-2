/**
 * setJsxClassName — Track B2. Adds/removes a class TOKEN in a `className`
 * attribute on the JSX element found at a source location, then writes the
 * change back to disk. This is the real write behind Phase 0 item 0.6's
 * honesty-only stopgap (`classAssignmentUnsavedNotice.ts`) and, per
 * `STUDIO-FIGMA-PARITY-PLAN.md` §5's B2, the thing that makes a Tailwind
 * project editable at all: a fill change on a Tailwind element is
 * `bg-red-500` -> `bg-blue-600`, a `className` token swap, not a CSS edit.
 *
 * FAILS CLOSED, on purpose, and reports WHY (`ClassNameRefusal`) rather than
 * guessing — same posture as `setJsxStyle` (identifier/spread guard) and
 * `detachComponent`/`swapComponentInstance` (named `{ ok, refusal }` result).
 * The shapes this file understands, and the refusal each other shape gets:
 *
 *   | `className` shape                          | Handling |
 *   |---------------------------------------------|----------|
 *   | absent                                       | creates the attribute |
 *   | `className="a b"` (plain string literal)     | token add/remove in place |
 *   | `className={"a b"}` / `` className={`a b`} `` (static expression) | same, token add/remove |
 *   | `` className={`a ${x}`} `` (dynamic template) | ADD appends to the STATIC HEAD only; any REMOVE refuses `template-dynamic` — a token that might live in the interpolated part can never be safely deleted from source text alone |
 *   | `className={cn('a', x)}` / `clsx`/`classNames`/`classnames` | ADD merges into (or appends) a literal string argument; REMOVE strips a token from every literal string argument it appears in (best-effort — a token produced only by a non-literal argument is left alone, matching every other Tier A/B/C path's "never guess" degrade) |
 *   | `className={styles.card}` (a CSS Modules default-import member access) | ADD rewrites it to `` className={`${styles.card} added`} `` — attaching a class is not editing a declaration; any REMOVE refuses `css-module-binding`, because that token is produced by the module and deleting it here would not delete it |
 *   | `className={...spread}`                      | refuses `spread-attribute` |
 *   | any other expression (identifier, ternary, an unrecognized call, …) | refuses `unsupported-expression` / `unsupported-call` |
 *
 * A request that changes nothing (both `add` and `remove` resolve to an empty
 * set once deduped, e.g. every token already present/absent) is a no-op —
 * `{ ok: true }` with the file untouched — so a caller never needs to
 * pre-filter, and an already-applied edit re-sent on a later autosave tick
 * doesn't re-refuse or rewrite anything.
 *
 * Node ids are `rel:line:col` pointing at the element's own tag-name start
 * (see `locateJsxElement.ts`); adding/removing characters inside an
 * attribute never changes the file's LINE count (no newline is ever
 * inserted), so this codemod never shifts another node's `line:col` the way
 * a structural edit does — same behaviour `setJsxProp`/`setJsxStyle` already
 * have.
 */
import {
  Node,
  Project,
  type CallExpression,
  type PropertyAccessExpression,
  type SourceFile,
  type TemplateExpression,
} from 'ts-morph'
import { CLASS_NAME_JOIN_BUILTIN_NAMES } from '@core/page-parser'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'

export interface SetJsxClassNameParams {
  file: string
  line: number
  col: number
  /** Class tokens to add. Order is not preserved — the codemod appends after existing tokens. */
  add: readonly string[]
  /** Class tokens to remove, wherever they appear as a whole token. */
  remove: readonly string[]
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

export type ClassNameRefusalReason =
  | 'spread-attribute'
  | 'css-module-binding'
  | 'template-dynamic'
  | 'unsupported-call'
  | 'unsupported-expression'

export interface ClassNameRefusal {
  reason: ClassNameRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export interface SetJsxClassNameSuccess {
  ok: true
}

export interface SetJsxClassNameFailure {
  ok: false
  refusal: ClassNameRefusal
}

export type SetJsxClassNameResult = SetJsxClassNameSuccess | SetJsxClassNameFailure

/** Splits on whitespace, drops empties, de-dupes — the shape every merge below starts from. */
function tokenize(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0)
}

function dedupe(tokens: readonly string[]): string[] {
  return [...new Set(tokens.map((token) => token.trim()).filter((token) => token.length > 0))]
}

/** Removes `remove` tokens, then appends any `add` token not already present. Order: kept tokens, then newly added ones. */
function mergeTokens(existing: string, add: readonly string[], remove: readonly string[]): string {
  const removeSet = new Set(remove)
  const kept = tokenize(existing).filter((token) => !removeSet.has(token))
  for (const token of add) {
    if (!kept.includes(token)) kept.push(token)
  }
  return kept.join(' ')
}

/** Builds a plain `className="..."` attribute initializer, picking a quote character the value doesn't contain. */
function buildStringInitializer(value: string): string {
  const hasDouble = value.includes('"')
  const hasSingle = value.includes("'")
  if (!hasDouble) return `"${value}"`
  if (!hasSingle) return `'${value}'`
  return `{${JSON.stringify(value)}}`
}

/**
 * Appends `add` tokens to a template literal's STATIC HEAD — the text before
 * its first `${` — leaving every interpolated span untouched. This is the
 * only part of `` `a ${x}` `` this codemod ever owns: everything after the
 * first span depends on a runtime value it cannot read, let alone rewrite.
 */
function appendToTemplateHead(expr: TemplateExpression, add: readonly string[]): void {
  const head = expr.getHead()
  const headText = head.getText() // includes the leading backtick and trailing `${`
  const inner = headText.slice(1, -2)
  const tokens = tokenize(inner)
  for (const token of add) {
    if (!tokens.includes(token)) tokens.push(token)
  }
  const newInner = tokens.length > 0 ? `${tokens.join(' ')} ` : ''
  head.replaceWithText('`' + newInner + '${')
}

/**
 * `className={cn('a', x)}` / `clsx(...)` / `classNames(...)` / `classnames(...)`
 * — matched by identifier name only, the identical set §7.5's evaluator
 * treats as the class-name-join built-in (`CLASS_NAME_JOIN_BUILTIN_NAMES`).
 * Any other callee refuses `unsupported-call` rather than guessing what the
 * function does with its arguments.
 */
function applyClassNameJoinCall(
  expr: CallExpression,
  add: readonly string[],
  remove: readonly string[],
): ClassNameRefusal | null {
  const callee = expr.getExpression()
  if (!Node.isIdentifier(callee) || !CLASS_NAME_JOIN_BUILTIN_NAMES.has(callee.getText())) {
    return {
      reason: 'unsupported-call',
      message:
        `className is set by a function call ("${expr.getText()}") this codemod does not recognize as a ` +
        'class-name join (only cn/clsx/classNames/classnames) — refusing rather than guess what it does with its arguments.',
    }
  }

  if (remove.length > 0) {
    const removeSet = new Set(remove)
    const argsToRemove: Node[] = []
    for (const arg of expr.getArguments()) {
      if (!Node.isStringLiteral(arg)) continue // best-effort: a token only reachable through a non-literal argument is left alone
      const tokens = tokenize(arg.getLiteralValue())
      const kept = tokens.filter((token) => !removeSet.has(token))
      if (kept.length === tokens.length) continue
      if (kept.length === 0) argsToRemove.push(arg)
      else arg.setLiteralValue(kept.join(' '))
    }
    for (const arg of argsToRemove) expr.removeArgument(arg)
  }

  if (add.length > 0) {
    const literalArg = expr.getArguments().find(Node.isStringLiteral)
    if (literalArg) {
      const tokens = tokenize(literalArg.getLiteralValue())
      for (const token of add) {
        if (!tokens.includes(token)) tokens.push(token)
      }
      literalArg.setLiteralValue(tokens.join(' '))
    } else {
      expr.addArgument(JSON.stringify(add.join(' ')))
    }
  }

  return null
}

/** `className={styles.card}` where `styles` is a default import from a `*.module.css` file. */
function isCssModuleBinding(expr: PropertyAccessExpression, sourceFile: SourceFile): boolean {
  const base = expr.getExpression()
  if (!Node.isIdentifier(base)) return false
  const name = base.getText()
  return sourceFile.getImportDeclarations().some((imp) => {
    if (!/\.module\.css$/i.test(imp.getModuleSpecifierValue())) return false
    const defaultImport = imp.getDefaultImport()
    return defaultImport !== undefined && defaultImport.getText() === name
  })
}

export function setJsxClassName(params: SetJsxClassNameParams): SetJsxClassNameResult {
  const { file, line, col } = params
  const add = dedupe(params.add)
  const remove = dedupe(params.remove)
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)

  // Nothing requested — never even inspect the attribute's shape, so a
  // no-op request never refuses (e.g. a spread `className` the caller
  // happens to re-send unchanged on a later autosave tick).
  if (add.length === 0 && remove.length === 0) return { ok: true }

  const existingAttribute = element.getAttribute('className')

  if (!existingAttribute) {
    if (add.length === 0) return { ok: true } // nothing to remove from an attribute that doesn't exist
    element.addAttribute({ name: 'className', initializer: buildStringInitializer(add.join(' ')) })
    sourceFile.saveSync()
    return { ok: true }
  }

  if (!Node.isJsxAttribute(existingAttribute)) {
    // `getAttribute(name)` only matches a spread attribute if `name` happens
    // to equal the literal text "...expr", which should never occur for a
    // real attribute name — guard against silently clobbering one anyway.
    return {
      ok: false,
      refusal: {
        reason: 'spread-attribute',
        message: 'the "className" attribute is a spread attribute — cannot edit an individual class token inside it.',
      },
    }
  }

  const initializer = existingAttribute.getInitializer()

  // Plain string literal attribute value: `className="a b"` (no braces —
  // this is the ordinary hand-written shape).
  if (initializer && Node.isStringLiteral(initializer)) {
    const merged = mergeTokens(initializer.getLiteralValue(), add, remove)
    if (merged.length === 0) existingAttribute.remove()
    else initializer.setLiteralValue(merged)
    sourceFile.saveSync()
    return { ok: true }
  }

  if (!initializer || !Node.isJsxExpression(initializer)) {
    return {
      ok: false,
      refusal: {
        reason: 'unsupported-expression',
        message: 'the "className" attribute has no rewritable value (a valueless shorthand, or a JSX-element/fragment initializer).',
      },
    }
  }

  const expr = initializer.getExpression()
  if (!expr) {
    return {
      ok: false,
      refusal: {
        reason: 'unsupported-expression',
        message: 'the "className" attribute has an empty expression container ({}) — nothing to rewrite.',
      },
    }
  }

  // `className={"a b"}` / `` className={`a b`} `` — a static string wrapped
  // in an expression container. Same token merge as the plain literal above.
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    const merged = mergeTokens(expr.getLiteralValue(), add, remove)
    if (merged.length === 0) existingAttribute.remove()
    else expr.setLiteralValue(merged)
    sourceFile.saveSync()
    return { ok: true }
  }

  // `` className={`a ${x}`} `` — a template literal with an interpolated
  // part. See `appendToTemplateHead`'s doc for exactly what is and isn't
  // owned here.
  if (Node.isTemplateExpression(expr)) {
    if (remove.length > 0) {
      return {
        ok: false,
        refusal: {
          reason: 'template-dynamic',
          message:
            'className is a template literal with an interpolated value ("' +
            expr.getText() +
            '") — a class token could live in the dynamic part, so removing one cannot be done safely from source text alone.',
        },
      }
    }
    if (add.length === 0) return { ok: true }
    appendToTemplateHead(expr, add)
    sourceFile.saveSync()
    return { ok: true }
  }

  // `className={cn('a', x)}` / `clsx(...)` / `classNames(...)` / `classnames(...)`.
  if (Node.isCallExpression(expr)) {
    const refusal = applyClassNameJoinCall(expr, add, remove)
    if (refusal) return { ok: false, refusal }
    sourceFile.saveSync()
    return { ok: true }
  }

  // `className={styles.card}`.
  //
  // REMOVE still refuses, and for the reason the refusal always named: the
  // token the caller wants gone is produced by the module binding, and the
  // honest edit for it is the class's own declaration in the `.module.css`,
  // not this expression.
  //
  // ADD does not have that problem, and refusing it was over-application.
  // Attaching a class is not editing a declaration — it is putting one more
  // token on this one element, which is exactly what
  // `` className={`${styles.card} sc-abc`} `` says. The blanket refusal
  // mattered little while pages were mostly plain strings; it stopped
  // mattering little the moment the agent began authoring every element as a
  // CSS Module binding, at which point NO element on an agent-authored page
  // could take a class at all. The rewrite is single-line (no newline is
  // introduced), so it shifts no other node's `line:col`, same as every other
  // path here.
  if (Node.isPropertyAccessExpression(expr) && isCssModuleBinding(expr, sourceFile)) {
    if (remove.length > 0) {
      return {
        ok: false,
        refusal: {
          reason: 'css-module-binding',
          message:
            `className is bound to a CSS Modules import ("${expr.getText()}") — that token comes from the module, so ` +
            "removing it here would not remove it. Edit the class's own declaration in the stylesheet instead.",
        },
      }
    }
    if (add.length === 0) return { ok: true }
    expr.replaceWithText(`\`\${${expr.getText()}} ${add.join(' ')}\``)
    sourceFile.saveSync()
    return { ok: true }
  }

  return {
    ok: false,
    refusal: {
      reason: 'unsupported-expression',
      message: `className is set by an expression ("${expr.getText()}") this codemod does not understand — refusing rather than guess.`,
    },
  }
}
