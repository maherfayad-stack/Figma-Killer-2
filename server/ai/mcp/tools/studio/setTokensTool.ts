/**
 * `studio_set_tokens` - change the VALUE of the project's design tokens, as a
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
 * and the token catalog use (`collectProjectTokenSources` -> the gated
 * declaration scan), so the declaration it edits is the one that paints.
 * Several tokens land in one call, all-or-nothing - a palette change is one
 * decision and should not half-apply.
 *
 * ## One honest target, or a refusal - decided by the shared planner
 *
 * `server/handlers/studio/tokenWrite.ts`'s `planTokenEdits` decides which
 * declaration is the token and refuses (`no-such-token`, `read-only-source`,
 * `ambiguous-declaration`, `invalid-input`) when there is no single honest one.
 * The editor's Variables route (`POST /admin/api/studio/token-catalog`) goes
 * through the same planner, so the two writers can never disagree about a
 * refusal. This tool owns only what is the agent's: the write gate, the lock,
 * the turn log and the live reload.
 *
 * ## The write path is the agent's write path
 *
 * The file is resolved through `resolveAgentFilePath(dir, rel, 'write')` -
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
import type { TokenEdit } from '@core/studio-tokens'
import { toLf } from '@core/utils/lineEndings'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { pathRefusal } from './fileReadTools'
import { commitPlannedWrites, currentText, isRefusal, type PlannedFileWrite } from './agentWriteSupport'
import { contentHash, resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import { withProjectWriteLock } from '../../../../handlers/studio/projectWriteLock'
import { collectProjectTokenSources } from '../../../../handlers/studio/projectTokenSources'
import { planTokenEdits } from '../../../../handlers/studio/tokenWrite'
import type { TokenWriteRefusal } from '../../../../handlers/studio/tokenWriteTypes'
import { readTokenWorkspaceFiles } from '../../../../handlers/studio/tokenWorkspaceFiles'

/** Tokens per call - a whole palette, bounded. */
const MAX_TOKENS_PER_CALL = 40

type Scheme = 'light' | 'dark'

const SetTokensInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio - omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    set: Type.Optional(Type.Array(
      Type.Object(
        {
          name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120, description: 'The custom property, with its dashes: "--brand-primary". Must already be declared - studio_list_tokens lists them.' }),
          value: Type.String({ minLength: 1, maxLength: 300, description: 'The new value, one line, exactly as it should appear after the colon: "#ef4550", "clamp(1rem, 2vw, 1.25rem)", "var(--coral-100)". No ";", "{" or "}".' }),
          scheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')], { description: "Which declaration: \"light\" (the default one, :root) or \"dark\" (the one under the project's dark-scheme gate). Default \"light\"." })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_TOKENS_PER_CALL, description: `The tokens to change, up to ${MAX_TOKENS_PER_CALL}. All land or none do.` },
    )),
    rename: Type.Optional(Type.Object(
      {
        name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120, description: 'The declared token to rename, with its dashes.' }),
        to: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120, description: 'Its new name. Must not be declared or named anywhere in the project.' }),
      },
      { additionalProperties: false, description: 'Rename one token: its declarations in every mode AND every var(), string and Tailwind arbitrary value that names it, in one write. Send it alone (not with set or remove).' },
    )),
    remove: Type.Optional(Type.Object(
      {
        name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120, description: 'The declared token to remove, with its dashes.' }),
        replaceWith: Type.Optional(Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120, description: 'Another declared token its readers move to. Required when the token is still used anywhere.' })),
      },
      { additionalProperties: false, description: 'Remove one token: every declaration in every mode. Refused while it is used unless replaceWith says where its readers go. Send it alone (not with set or rename).' },
    )),
  },
  { additionalProperties: false },
)

interface TokenRequest {
  readonly name: string
  readonly value: string
  readonly scheme?: Scheme
}

/** A refusal from inside the request, naming which entry of `set` it came from. */
function forEntry(refusal: ToolRefusal, index: number): ToolRefusal & { entryIndex: number } {
  const prefix = `Entry ${index} refused, so no token was changed: `
  return { ...refusal, entryIndex: index, message: `${prefix}${refusal.message}`, error: `${prefix}${refusal.error}` }
}

function planRefusal(refusal: TokenWriteRefusal): ToolRefusal & { entryIndex: number } {
  // The tool registry has no code of its own for these planner refusals; the
  // message and remedy carry the specifics.
  const code = refusal.code === 'already-declared' || refusal.code === 'no-project-stylesheet' || refusal.code === 'in-use' || refusal.code === 'rename-blocked' ? 'invalid-input' : refusal.code
  return forEntry(
    toolRefusal(code, refusal.message, {
      ...(refusal.remedy ? { remedy: refusal.remedy } : {}),
      ...(refusal.details ? { details: { declarations: [...refusal.details.declarations] } } : {}),
    }),
    refusal.entryIndex,
  )
}

const setTokensTool: AiTool = {
  name: 'studio_set_tokens',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    "Change the values of existing design tokens (CSS custom properties) in one call, all-or-nothing, as a minimal edit to the ONE declaration that is each token - comments, formatting and the other colour scheme's value untouched. Uses the same scan as studio_list_tokens, so it edits the declaration the canvas actually paints. scheme \"dark\" edits the dark-scheme declaration. Refuses no-such-token, read-only-source (a package, Studio's design system or compiled output wins: override it in the project's own stylesheet instead), ambiguous-declaration (declared in two places: every file:line is listed), stale-source, and the usual path refusals. Also renames a token everywhere it is declared or named (rename: { name, to }) and removes one (remove: { name, replaceWith? } - refused while it is used unless replaceWith names where its readers go), each as its own call. Returns { changed: [{ name, scheme, file, line, from, to }], unchanged, renamed, removed, files: [{ path, hash }] }. Requires studio.write.",
  inputSchema: SetTokensInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, set, rename, remove } = input as {
      dir?: string
      set?: TokenRequest[]
      rename?: { name: string; to: string }
      remove?: { name: string; replaceWith?: string }
    }
    if ([set, rename, remove].filter((request) => request !== undefined).length !== 1) {
      return toolRefusal('invalid-input', 'Send exactly one of set, rename or remove.', {
        remedy: 'A rename or remove rewrites many files, so it is its own call; value changes go in set.',
      })
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    // The scan runs outside the lock (it may compile the project's styles);
    // the lock below re-reads each file and refuses if it moved since.
    const sources = await collectProjectTokenSources(dir)
    const edits: TokenEdit[] = rename
      ? [{ op: 'rename', name: rename.name, to: rename.to }]
      : remove
        ? [{ op: 'remove', name: remove.name, ...(remove.replaceWith ? { replaceWith: remove.replaceWith } : {}) }]
        : (set ?? []).map((request) => ({ op: 'set', name: request.name, value: request.value, target: request.scheme ?? 'light' }))
    const plan = planTokenEdits(sources, edits, rename || remove ? readTokenWorkspaceFiles(dir) : [])
    if (!plan.ok) return planRefusal(plan)

    return withProjectWriteLock(dir, () => {
      const plans: PlannedFileWrite[] = []
      for (const file of plan.files) {
        const target = resolveAgentFilePath(dir, file.file, 'write')
        if (!target.ok) return forEntry(pathRefusal(target), 0)
        const current = currentText(target, undefined)
        if (isRefusal(current)) return forEntry(current, 0)
        if (current.content === null || toLf(current.content) !== toLf(file.original)) {
          return forEntry(toolRefusal('stale-source', `"${target.rel}" changed while its tokens were being read, so nothing was written.`, {
            remedy: 'Call studio_set_tokens again; it re-reads the file.',
          }), 0)
        }
        plans.push({ target, original: current.content, next: file.next })
      }

      const committed = commitPlannedWrites(dir, ctx, plans)
      if (isRefusal(committed)) return committed
      return {
        ok: true as const,
        dir,
        changed: plan.changed.map(({ name, target, file, line, from, to }) => ({ name, scheme: target, file, line, from, to })),
        unchanged: plan.unchanged.map(({ name, target }) => ({ name, scheme: target })),
        renamed: plan.renamed,
        removed: plan.removed,
        files: plans.map((entry) => ({ path: entry.target.rel, hash: contentHash(entry.next) })),
      }
    })
  },
}

export const studioSetTokensMcpTools: AiTool[] = [setTokensTool]
