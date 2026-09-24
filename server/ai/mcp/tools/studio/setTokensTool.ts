/**
 * `studio_set_tokens` — change the VALUE of the project's design tokens, as a
 * formatting-preserving CST edit on the one declaration that is the token
 * (AI-15).
 *
 * ## Why a tool, when the agent can already edit a stylesheet
 *
 * Editing a token by hand means finding which of the stylesheets the canvas
 * loads declares it, which of that file's declarations is the light one and
 * which the dark one, and whether a package or Studio's own design system is
 * the one that actually wins. `studio_list_tokens` answers the first question
 * with a `file:line`; this answers all of them with the SAME scan the canvas
 * and the token listing use (`collectProjectTokenSources` →
 * `collectRootScopeDeclarations`), so the declaration it edits is the one that
 * paints. Several tokens land in one call, all-or-nothing — a palette change
 * is one decision and should not half-apply.
 *
 * ## One honest target, or a refusal
 *
 * A write lands only when exactly one declaration IS the token for the
 * requested scheme:
 *
 *   - declared nowhere the canvas loads → `no-such-token` (and, for a dark
 *     request, whether a light value exists);
 *   - the winning declaration is a package's, Studio's built-in design
 *     system's, or compiled output's → `read-only-source`, with where to
 *     override it instead;
 *   - declared in two project stylesheets for that scheme, or twice in one
 *     (a second selector, a responsive `@media` override) → `ambiguous-declaration`,
 *     listing every `file:line` so the agent can edit the one it means.
 *
 * ## The write path is the agent's write path
 *
 * The file is resolved through `resolveAgentFilePath(dir, rel, 'write')` —
 * the one containment rule and the one agent write gate (`agentWriteRefusal`)
 * the CLI hook and the file tools share. A `.css` stylesheet is not a
 * host-executed file, so the gate allows it; a stylesheet under `.studio/`,
 * `prototype/` or build output refuses exactly as it would for
 * `studio_edit_file`. The write holds `withProjectWriteLock`, re-reads the
 * file inside it and refuses `stale-source` if it no longer matches what was
 * scanned, then commits through `commitPlannedWrites` (atomic across files,
 * turn-logged, live-reloaded).
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal, type ToolRefusal } from '@core/ai'
import { listCustomPropertyDeclarations, setCustomPropertyValueAtLine } from '@core/css-codemods'
import { toLf } from '@core/utils/lineEndings'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { pathRefusal } from './fileReadTools'
import { commitPlannedWrites, currentText, isRefusal, type PlannedFileWrite } from './agentWriteSupport'
import { contentHash, resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import { withProjectWriteLock } from '../../../../handlers/studio/projectWriteLock'
import { collectProjectTokenSources } from '../../../../handlers/studio/projectTokenSources'
import type { TokenCssSource } from '../../../../handlers/studio/projectTokenIndex'
import { collectRootScopeDeclarations, type ScopedDeclaration } from '../../../../handlers/studio/tokenExtractCssScan'

/** Tokens per call — a whole palette, bounded. */
const MAX_TOKENS_PER_CALL = 40

type Scheme = 'light' | 'dark'

const SetTokensInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    set: Type.Array(
      Type.Object(
        {
          name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120, description: 'The custom property, with its dashes: "--brand-primary". Must already be declared — studio_list_tokens lists them.' }),
          value: Type.String({ minLength: 1, maxLength: 300, description: 'The new value, one line, exactly as it should appear after the colon: "#ef4550", "clamp(1rem, 2vw, 1.25rem)", "var(--coral-100)". No ";", "{" or "}".' }),
          scheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')], { description: 'Which declaration: "light" (the default one, :root) or "dark" (the one under the project\'s dark-scheme gate). Default "light".' })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_TOKENS_PER_CALL, description: `The tokens to change, up to ${MAX_TOKENS_PER_CALL}. All land or none do.` },
    ),
  },
  { additionalProperties: false },
)

interface TokenRequest {
  readonly name: string
  readonly value: string
  readonly scheme?: Scheme
}

interface ScannedSource {
  readonly source: TokenCssSource
  readonly light: Map<string, ScopedDeclaration>
  readonly dark: Map<string, ScopedDeclaration>
}

/** Where one requested token will be written: the file, the line of the winning declaration, and the other scheme's line in the same file (not a duplicate). */
interface TokenTarget {
  /** Index into the call's `set`, for naming the entry a refusal came from. */
  readonly entryIndex: number
  readonly request: TokenRequest & { readonly scheme: Scheme }
  readonly source: TokenCssSource
  readonly line: number
  readonly otherSchemeLine: number | null
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function where(scanned: ScannedSource, declaration: ScopedDeclaration): string {
  return `${scanned.source.file}:${lineAt(scanned.source.css, declaration.offset)}`
}

/** The honest target for one request, or the refusal that explains why there is none. */
function resolveTarget(request: TokenRequest, entryIndex: number, scans: readonly ScannedSource[]): TokenTarget | ToolRefusal {
  const scheme: Scheme = request.scheme ?? 'light'
  const other: Scheme = scheme === 'light' ? 'dark' : 'light'
  const candidates = scans.filter((scan) => scan[scheme].has(request.name))

  if (candidates.length === 0) {
    const inOther = scans.some((scan) => scan[other].has(request.name))
    return toolRefusal('no-such-token', inOther
      ? `${request.name} has a ${other} value but no ${scheme} declaration in any stylesheet the canvas loads, so there is no ${scheme} value to change.`
      : `${request.name} is not declared at the document root of any stylesheet the canvas loads.`, {
      remedy: inOther
        ? `Add the ${scheme} declaration yourself with the file tools, next to the ${other} one (studio_list_tokens gives its file:line), inside the project's existing ${scheme === 'dark' ? 'dark-scheme gate' : ':root rule'}.`
        : 'Check the name with studio_list_tokens. To introduce a new token, declare it in the project\'s own global stylesheet with the file tools.',
    })
  }

  const winner = candidates[candidates.length - 1]!
  if (winner.source.origin !== 'project') {
    const from = winner.source.origin === 'compiled'
      ? 'compiled Sass/PostCSS/Tailwind output'
      : winner.source.origin === 'package' ? `a package stylesheet (${winner.source.file})` : 'Studio\'s built-in design system'
    return toolRefusal('read-only-source', `The ${scheme} value of ${request.name} that the canvas paints comes from ${from}, which is not a project file this tool edits in place.`, {
      remedy: winner.source.origin === 'compiled'
        ? `Search the project's source for "${request.name}" to find the file it was compiled from, and edit that file with the file tools.`
        : `Override it in the project's own global stylesheet: declare ${request.name} there${scheme === 'dark' ? ' under the dark-scheme gate' : ' in :root'} with the file tools. The project's declaration wins because it loads later.`,
    })
  }

  const projectCandidates = candidates.filter((scan) => scan.source.origin === 'project')
  if (projectCandidates.length > 1) {
    const places = projectCandidates.map((scan) => where(scan, scan[scheme].get(request.name)!))
    return toolRefusal('ambiguous-declaration', `${request.name} (${scheme}) is declared in ${places.length} project stylesheets: ${places.join(', ')}. The last one wins on the canvas, but changing it would leave the others contradicting it.`, {
      remedy: 'Decide which declaration is the token, edit it (and remove or align the others) with the file tools, then call studio_set_tokens again.',
      details: { declarations: places },
    })
  }

  const declaration = winner[scheme].get(request.name)!
  const otherDeclaration = winner[other].get(request.name)
  return {
    entryIndex,
    request: { ...request, scheme },
    source: winner.source,
    line: lineAt(winner.source.css, declaration.offset),
    otherSchemeLine: otherDeclaration ? lineAt(winner.source.css, otherDeclaration.offset) : null,
  }
}

/** A refusal from inside the batch, naming which entry of `set` it came from. */
function forEntry(refusal: ToolRefusal, index: number): ToolRefusal & { entryIndex: number } {
  const prefix = `set[${index}] refused, so no token was changed: `
  return { ...refusal, entryIndex: index, message: `${prefix}${refusal.message}`, error: `${prefix}${refusal.error}` }
}

const setTokensTool: AiTool = {
  name: 'studio_set_tokens',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Change the values of existing design tokens (CSS custom properties) in one call, all-or-nothing, as a minimal edit to the ONE declaration that is each token — comments, formatting and the other colour scheme\'s value untouched. Uses the same scan as studio_list_tokens, so it edits the declaration the canvas actually paints. scheme "dark" edits the dark-scheme declaration. Refuses no-such-token, read-only-source (a package, Studio\'s design system or compiled output wins: override it in the project\'s own stylesheet instead), ambiguous-declaration (declared in two places: every file:line is listed), stale-source, and the usual path refusals. Returns { changed: [{ name, scheme, file, line, from, to }], unchanged, files: [{ path, hash }] }. Requires studio.write.',
  inputSchema: SetTokensInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, set } = input as { dir?: string; set: TokenRequest[] }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const seen = new Set<string>()
    for (const [index, request] of set.entries()) {
      const key = `${request.name}|${request.scheme ?? 'light'}`
      if (seen.has(key)) return forEntry(toolRefusal('invalid-input', `${request.name} (${request.scheme ?? 'light'}) is listed twice.`), index)
      seen.add(key)
    }

    // The scan runs outside the lock (it may compile the project's styles);
    // the lock below re-reads each file and refuses if it moved since.
    const scans: ScannedSource[] = (await collectProjectTokenSources(dir)).map((source) => ({ source, ...collectRootScopeDeclarations(source.css) }))
    const targets: TokenTarget[] = []
    for (const [index, request] of set.entries()) {
      const target = resolveTarget(request, index, scans)
      if (isRefusal(target)) return forEntry(target, index)
      targets.push(target)
    }

    return withProjectWriteLock(dir, () => {
      const byFile = new Map<string, TokenTarget[]>()
      for (const target of targets) byFile.set(target.source.file, [...(byFile.get(target.source.file) ?? []), target])

      const plans: PlannedFileWrite[] = []
      const changed: Array<{ name: string; scheme: Scheme; file: string; line: number; from: string; to: string }> = []
      const unchanged: Array<{ name: string; scheme: Scheme }> = []
      for (const [file, fileTargets] of byFile) {
        const entryIndex = fileTargets[0]!.entryIndex
        const target = resolveAgentFilePath(dir, file, 'write')
        if (!target.ok) return forEntry(pathRefusal(target), entryIndex)
        const current = currentText(target, undefined)
        if (isRefusal(current)) return forEntry(current, entryIndex)
        if (current.content === null || toLf(current.content) !== toLf(fileTargets[0]!.source.css)) {
          return forEntry(toolRefusal('stale-source', `"${target.rel}" changed while its tokens were being read, so nothing was written.`, {
            remedy: 'Call studio_set_tokens again; it re-reads the file.',
          }), entryIndex)
        }

        // Bottom-up, so a multi-line value collapsing to one line cannot shift
        // a declaration still waiting to be edited above it.
        let text = current.content
        for (const tokenTarget of [...fileTargets].sort((a, b) => b.line - a.line)) {
          const { name, scheme, value } = tokenTarget.request
          const expected = new Set([tokenTarget.line, ...(tokenTarget.otherSchemeLine === null ? [] : [tokenTarget.otherSchemeLine])])
          const extra = listCustomPropertyDeclarations(text, name).filter((decl) => !expected.has(decl.line))
          if (extra.length > 0) {
            const places = [`${target.rel}:${tokenTarget.line}`, ...extra.map((decl) => `${target.rel}:${decl.line}${decl.atRules.length > 0 ? ` (${decl.atRules.join(' ')})` : ''}`)]
            return forEntry(toolRefusal('ambiguous-declaration', `${name} is declared ${places.length} times in "${target.rel}" (${places.join(', ')}) — a second selector or a responsive override — so one edit would leave the others contradicting it.`, {
              remedy: 'Edit the declaration you mean with the file tools, and align or remove the others in the same change.',
              details: { declarations: places },
            }), tokenTarget.entryIndex)
          }
          const edit = setCustomPropertyValueAtLine(text, name, tokenTarget.line, value)
          if (!edit.ok) {
            return forEntry(toolRefusal(edit.reason === 'invalid-value' ? 'invalid-input' : 'stale-source', edit.message, {
              remedy: edit.reason === 'invalid-value' ? 'Pass one value, on one line, with no ";", "{" or "}".' : 'Call studio_set_tokens again; it re-reads the file.',
            }), tokenTarget.entryIndex)
          }
          text = edit.css
          if (edit.changed) changed.push({ name, scheme, file: target.rel, line: tokenTarget.line, from: edit.previous, to: value.trim() })
          else unchanged.push({ name, scheme })
        }
        plans.push({ target, original: current.content, next: text })
      }

      const committed = commitPlannedWrites(dir, ctx, plans)
      if (isRefusal(committed)) return committed
      return {
        ok: true as const,
        dir,
        changed,
        unchanged,
        files: plans.map((plan) => ({ path: plan.target.rel, hash: contentHash(plan.next) })),
      }
    })
  },
}

export const studioSetTokensMcpTools: AiTool[] = [setTokensTool]
