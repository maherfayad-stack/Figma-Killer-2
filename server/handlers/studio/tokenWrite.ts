/**
 * tokenWrite - PLAN a change to the project's design tokens: which file, which
 * declaration, what the file holds afterwards - or the refusal that explains why
 * there is no honest target. The ONE planner behind both writers:
 *
 *   - `studio_set_tokens` (the agent; commits through its write gate and turn
 *     log), and
 *   - `POST /admin/api/studio/token-catalog` (the editor; commits under the
 *     project write lock).
 *
 * Planning is pure over the stylesheets the canvas loads
 * (`collectProjectTokenSources`): no filesystem, no lock. The caller re-reads
 * each file under its lock, refuses `stale-source` if it no longer equals
 * {@link PlannedTokenFile.original}, and writes. Two writers, one set of rules,
 * so a refusal means the same thing from both.
 *
 * ## One honest target, or a refusal
 *
 *   - `set` lands only when exactly one declaration IS the token for the
 *     requested mode; declared nowhere -> `no-such-token`; the winning
 *     declaration is a package's / Studio's design system's / compiled output
 *     -> `read-only-source`; declared twice under that mode, or (for the
 *     `light`/`dark` shorthand) also under a mode the shorthand cannot name
 *     (a width `@media`, a locale) -> `ambiguous-declaration`, every
 *     `file:line` listed.
 *   - `insert` declares a NEW token (or a new mode of one) in a project
 *     stylesheet. It never overwrites (`already-declared`). Overriding a
 *     read-only token is an insert of the base mode into the project's own
 *     stylesheet (CT-OD-5).
 */
import {
  gateKey,
  isDarkSchemeGate,
  lineOfOffset,
  scanGatedDeclarations,
  type GatedDeclaration,
  type ModeGate,
  type TokenEdit,
  type TokenTarget,
} from '@core/studio-tokens'
import { insertCustomProperty, setCustomPropertyValueAtLine } from '@core/css-codemods'
import type { TokenCssSource } from './projectTokenIndex'
import { tokenRefusal, type PlannedTokenFile, type TokenWritePlan, type TokenWriteRefusal } from './tokenWriteTypes'
import { planTokenRefactor, type TokenRefactorEdit } from './tokenRefactor'
import type { TokenWorkspaceFile } from './tokenWorkspaceFiles'

interface ScannedSource {
  readonly source: TokenCssSource
  readonly declarations: readonly GatedDeclaration[]
}

interface SourceDecl {
  readonly scanned: ScannedSource
  readonly declaration: GatedDeclaration
  readonly line: number
}

const DEFAULT_TARGET: TokenTarget = 'light'

function resolveGate(target: TokenTarget): ModeGate | null {
  return target === 'light' ? { kind: 'base' } : target === 'dark' ? null : target
}

function matchesTarget(gate: ModeGate, target: TokenTarget): boolean {
  if (target === 'light') return gate.kind === 'base'
  if (target === 'dark') return isDarkSchemeGate(gate)
  return gateKey(gate) === gateKey(target)
}

function targetLabel(target: TokenTarget): string {
  return typeof target === 'string' ? target : gateKey(target)
}

function where(entry: SourceDecl): string {
  return `${entry.scanned.source.file}:${entry.line}`
}

function declarationsOf(scans: readonly ScannedSource[], name: string): SourceDecl[] {
  const found: SourceDecl[] = []
  for (const scanned of scans) {
    for (const declaration of scanned.declarations) {
      if (declaration.name !== name) continue
      found.push({ scanned, declaration, line: lineOfOffset(scanned.source.css, declaration.offset) })
    }
  }
  return found
}

/** The honest `set` target, or the refusal explaining why there is none. */
function resolveSetTarget(edit: Extract<TokenEdit, { op: 'set' }>, entryIndex: number, scans: readonly ScannedSource[]): SourceDecl | TokenWriteRefusal {
  const target = edit.target ?? DEFAULT_TARGET
  const all = declarationsOf(scans, edit.name)
  const candidates = all.filter((entry) => matchesTarget(entry.declaration.gate, target))

  if (candidates.length === 0) {
    const label = targetLabel(target)
    const inOtherMode = all.length > 0
    if (typeof target === 'string' && inOtherMode) {
      const other = target === 'light' ? 'dark' : 'light'
      const hasOther = all.some((entry) => matchesTarget(entry.declaration.gate, other))
      if (hasOther) {
        return tokenRefusal(entryIndex, 'no-such-token', `${edit.name} has a ${other} value but no ${target} declaration in any stylesheet the canvas loads, so there is no ${target} value to change.`, {
          remedy: `Add the ${target} declaration yourself with the file tools, next to the ${other} one (studio_list_tokens gives its file:line), inside the project's existing ${target === 'dark' ? 'dark-scheme gate' : ':root rule'}.`,
        })
      }
    }
    return tokenRefusal(
      entryIndex,
      'no-such-token',
      inOtherMode
        ? `${edit.name} is declared, but not for ${label}, in any stylesheet the canvas loads.`
        : `${edit.name} is not declared at the document root of any stylesheet the canvas loads.`,
      {
        remedy: inOtherMode
          ? 'Declare it for that mode with an insert edit (Variables panel: "+ Mode"), or with the file tools.'
          : "Check the name with studio_list_tokens. To introduce a new token, declare it in the project's own global stylesheet with the file tools (or an insert edit).",
      },
    )
  }

  const winner = candidates[candidates.length - 1]!
  const origin = winner.scanned.source.origin
  if (origin !== 'project') {
    const label = targetLabel(target)
    const from = origin === 'compiled'
      ? 'compiled Sass/PostCSS/Tailwind output'
      : origin === 'package' ? `a package stylesheet (${winner.scanned.source.file})` : "Studio's built-in design system"
    return tokenRefusal(entryIndex, 'read-only-source', `The ${label} value of ${edit.name} that the canvas paints comes from ${from}, which is not a project file this tool edits in place.`, {
      remedy: origin === 'compiled'
        ? `Search the project's source for "${edit.name}" to find the file it was compiled from, and edit that file with the file tools.`
        : `Override it in the project's own global stylesheet: declare ${edit.name} there${target === 'dark' ? ' under the dark-scheme gate' : ' in :root'} (an insert edit does exactly this). The project's declaration wins because it loads later.`,
    })
  }

  const projectCandidates = candidates.filter((entry) => entry.scanned.source.origin === 'project')
  if (projectCandidates.length > 1) {
    const places = projectCandidates.map(where)
    return tokenRefusal(entryIndex, 'ambiguous-declaration', `${edit.name} (${targetLabel(target)}) is declared ${places.length} times in the project: ${places.join(', ')}. The last one wins on the canvas, but changing it would leave the others contradicting it.`, {
      remedy: 'Decide which declaration is the token, edit it (and remove or align the others) with the file tools, then try again.',
      declarations: places,
    })
  }

  // The `light`/`dark` shorthand names the default and the colour scheme. A
  // declaration under another mode (a width @media, a locale, a component
  // scope) is one it cannot name, so one edit would leave it contradicting the
  // new value. An explicit gate target has chosen its mode.
  if (typeof target === 'string') {
    const others = all.filter((entry) => {
      const gate = entry.declaration.gate
      return entry.scanned.source.origin === 'project' && gate.kind !== 'base' && !isDarkSchemeGate(gate) && entry !== winner
    })
    if (others.length > 0) {
      const describe = (entry: SourceDecl): string => `${where(entry)}${entry.declaration.atRules.length > 0 ? ` (${entry.declaration.atRules.join(' ')})` : ''}`
      const places = [where(winner), ...others.map(describe)]
      return tokenRefusal(entryIndex, 'ambiguous-declaration', `${edit.name} is declared ${places.length} times in the project (${places.join(', ')}) - a second selector or a responsive override - so one edit would leave the others contradicting it.`, {
        remedy: 'Edit the declaration you mean with the file tools (or target its mode explicitly), and align or remove the others in the same change.',
        declarations: places,
      })
    }
  }
  return winner
}

/** A stylesheet a new token can be declared in: a hand-written global `.css` file in the project. */
function isInsertableSource(source: TokenCssSource): boolean {
  return source.origin === 'project' && /\.css$/i.test(source.file) && !/\.module\.css$/i.test(source.file)
}

const TAILWIND_THEME_NAMESPACE_RE = /^--(?:color|font|text|spacing|radius|shadow|breakpoint|ease|animate|tracking|leading|blur|aspect|container)-/

function prefixOf(name: string): string {
  return name.slice(2).split('-')[0] ?? ''
}

/** Where a new token goes: beside its siblings, else in the project's token file, else the last global stylesheet. */
function chooseInsertSource(scans: readonly ScannedSource[], name: string, gate: ModeGate): ScannedSource | null {
  const candidates = scans.filter((scanned) => isInsertableSource(scanned.source))
  if (candidates.length === 0) return null
  const key = gateKey(gate)
  const prefix = prefixOf(name)
  const sibling = candidates.findLast((scanned) => scanned.declarations.some((d) => prefixOf(d.name) === prefix && gateKey(d.gate) === key))
  if (sibling) return sibling
  const withBase = candidates.findLast((scanned) => scanned.declarations.some((d) => d.gate.kind === 'base'))
  return withBase ?? candidates[candidates.length - 1]!
}

/**
 * Plan every edit, all-or-nothing: the first refusal is returned and nothing
 * is planned. Edits to one file compose, bottom-up for `set` (so a value
 * collapsing to one line cannot shift a declaration still waiting above it),
 * then inserts.
 */
export function planTokenEdits(
  sources: readonly TokenCssSource[],
  allEdits: readonly TokenEdit[],
  workspace: readonly TokenWorkspaceFile[] = [],
): TokenWritePlan | TokenWriteRefusal {
  const refactor = allEdits.find((edit): edit is TokenRefactorEdit => edit.op === 'rename' || edit.op === 'remove')
  if (refactor) {
    // A rename or remove rewrites mentions across many files, so it is its own
    // request: mixing it with value edits would make "which text is the
    // plan against" depend on the order of the entries.
    if (allEdits.length > 1) {
      return tokenRefusal(allEdits.indexOf(refactor), 'invalid-input', 'A rename or remove must be the only edit in its request.', {
        remedy: 'Send the rename or remove on its own, then the value edits.',
      })
    }
    return planTokenRefactor(sources, workspace, refactor)
  }
  const edits = allEdits.filter((edit): edit is Extract<TokenEdit, { op: 'set' | 'insert' }> => edit.op === 'set' || edit.op === 'insert')
  const seen = new Set<string>()
  for (const [index, edit] of edits.entries()) {
    const key = `${edit.op}|${edit.name}|${targetLabel(edit.target ?? DEFAULT_TARGET)}`
    if (seen.has(key)) return tokenRefusal(index, 'invalid-input', `${edit.name} (${targetLabel(edit.target ?? DEFAULT_TARGET)}) is listed twice.`)
    seen.add(key)
  }

  const scans: ScannedSource[] = sources.map((source) => ({ source, declarations: scanGatedDeclarations(source.css) }))

  const sets: Array<{ entryIndex: number; edit: Extract<TokenEdit, { op: 'set' }>; at: SourceDecl }> = []
  for (const [entryIndex, edit] of edits.entries()) {
    if (edit.op !== 'set') continue
    const at = resolveSetTarget(edit, entryIndex, scans)
    if ('ok' in at) return at
    sets.push({ entryIndex, edit, at })
  }

  const texts = new Map<string, string>()
  const textOf = (source: TokenCssSource): string => texts.get(source.file) ?? source.css
  const changed: Array<{ name: string; target: TokenTarget; file: string; line: number; from: string; to: string }> = []
  const unchanged: Array<{ name: string; target: TokenTarget }> = []

  for (const entry of [...sets].sort((a, b) => b.at.line - a.at.line)) {
    const { source } = entry.at.scanned
    const target = entry.edit.target ?? DEFAULT_TARGET
    const result = setCustomPropertyValueAtLine(textOf(source), entry.edit.name, entry.at.line, entry.edit.value)
    if (!result.ok) {
      return tokenRefusal(entry.entryIndex, result.reason === 'invalid-value' ? 'invalid-input' : 'stale-source', result.message, {
        remedy: result.reason === 'invalid-value' ? 'Pass one value, on one line, with no ";", "{" or "}".' : 'Try again; the file is re-read.',
      })
    }
    texts.set(source.file, result.css)
    if (result.changed) changed.push({ name: entry.edit.name, target, file: source.file, line: entry.at.line, from: result.previous, to: entry.edit.value.trim() })
    else unchanged.push({ name: entry.edit.name, target })
  }

  const inserted: Array<{ name: string; target: TokenTarget; file: string }> = []
  for (const [entryIndex, edit] of edits.entries()) {
    if (edit.op !== 'insert') continue
    const target = edit.target ?? DEFAULT_TARGET
    const gate = resolveGate(target)
    if (!gate) {
      return tokenRefusal(entryIndex, 'invalid-input', 'A new token needs a concrete mode: pass the gate to declare it under (for example a [data-theme="dark"] attribute gate), not "dark".', {
        remedy: 'Use { kind: "attr", attr: "data-theme", value: "dark" } (or the project\'s own dark gate).',
      })
    }
    const existing = declarationsOf(scans, edit.name).filter((entry) => entry.scanned.source.origin === 'project' && gateKey(entry.declaration.gate) === gateKey(gate))
    if (existing.length > 0) {
      return tokenRefusal(entryIndex, 'already-declared', `${edit.name} is already declared for ${targetLabel(target)} at ${existing.map(where).join(', ')}.`, {
        remedy: 'Change its value with a set edit instead.',
        declarations: existing.map(where),
      })
    }

    let destination: ScannedSource | null
    if (edit.file !== undefined) {
      destination = scans.find((scanned) => scanned.source.file === edit.file && isInsertableSource(scanned.source)) ?? null
      if (!destination) {
        return tokenRefusal(entryIndex, 'invalid-input', `"${edit.file}" is not a project stylesheet a token can be declared in.`, {
          remedy: 'Name a hand-written .css file the project imports, or omit the file to let Studio choose.',
        })
      }
    } else {
      destination = chooseInsertSource(scans, edit.name, gate)
      if (!destination) {
        return tokenRefusal(entryIndex, 'no-project-stylesheet', 'The project has no global stylesheet to declare a token in.', {
          remedy: "Create a global stylesheet (src/index.css) and import it from the app's entry module, then try again.",
        })
      }
    }

    const prefix = prefixOf(edit.name)
    const siblings = destination.declarations.filter((d) => prefixOf(d.name) === prefix && gateKey(d.gate) === gateKey(gate) && d.name !== edit.name)
    const useTheme = gate.kind === 'base' && TAILWIND_THEME_NAMESPACE_RE.test(edit.name) && destination.declarations.some((d) => d.inTheme)
    const result = insertCustomProperty(textOf(destination.source), {
      name: edit.name,
      value: edit.value,
      gate,
      ...(useTheme ? { host: 'theme' as const } : {}),
      ...(siblings.length > 0 ? { after: siblings[siblings.length - 1]!.name } : {}),
    })
    if (!result.ok) {
      return tokenRefusal(entryIndex, result.reason === 'already-declared' ? 'already-declared' : 'invalid-input', result.message, {
        remedy: result.reason === 'invalid-value' ? 'Pass one value, on one line, with no ";", "{" or "}".' : undefined,
      })
    }
    texts.set(destination.source.file, result.css)
    inserted.push({ name: edit.name, target, file: destination.source.file })
  }

  const files: PlannedTokenFile[] = []
  for (const [file, next] of texts) {
    const original = sources.find((source) => source.file === file)!.css
    if (next !== original) files.push({ file, original, next })
  }
  return { ok: true, files, changed, unchanged, inserted, renamed: [], removed: [] }
}
