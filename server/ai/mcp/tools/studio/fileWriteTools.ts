/**
 * Studio file WRITE tools — `studio_write_file`, `studio_edit_file` and the
 * atomic `studio_edit_files` — the API-key path's way to author a screen
 * (P4-C, AI-2).
 *
 * ## Why they exist
 *
 * A Studio turn on the `claude` CLI writes files with the CLI's native
 * `Write`/`Edit`. The HTTP drivers (Anthropic API key, OpenAI, OpenRouter,
 * Ollama, a custom endpoint) have no native tools at all, and the in-canvas
 * surface deliberately withholds the AST edit tools — so an API-key user had an
 * assistant that could look, measure and resize frames, and could not write a
 * single line, while its prompt told it to "Write" and "Edit".
 *
 * ## Who holds them
 *
 * ONLY the in-canvas agent on an HTTP driver (`STUDIO_HTTP_AGENT_FILE_TOOL_NAMES`).
 * They are deliberately not in the external MCP catalog: an external
 * connector is never bound to a project (`connectorWorkspace.ts` binds only
 * the CLI's per-turn session connector, which has native tools), and these
 * tools never take a directory — they write only into the project the turn is
 * about (`ctx.workspaceDir`, validated by the chat handler). Offering them to a
 * client for which they could only ever refuse would be a tool that lies.
 *
 * ## What every write shares
 *
 *   - **One containment rule** — `resolveAgentFilePath(dir, path, 'write')`:
 *     inside the project on the textual and the real path, never into
 *     `.studio/`, `.claude/`, `.git/`, `node_modules/` or build output (the
 *     SAME deny list as the CLI path's hook), never a credential file, never
 *     through a hard link.
 *   - **A stale-source guard** — `expectedHash` is the `hash` a read handed
 *     out. A write whose file moved on since refuses `stale-source` instead of
 *     silently discarding the change it never saw; overwriting an existing file
 *     REQUIRES it.
 *   - **The project write lock** — `withProjectWriteLock`, held across the
 *     check and the write, so a canvas save cannot land between them, and so
 *     the project watcher (P1-D) recognises the write as Studio's own instead
 *     of pushing a second, unordered reload.
 *   - **The turn write log** — `appendTurnWrite`, the same log the CLI path's
 *     `PostToolUse` hook fills, so the next turn's digest reports what this one
 *     wrote and whether it was verified.
 *   - **Live reload** — one `pushStudioDiskChange` per call naming every file
 *     it wrote, the push the watcher would have sent: every open tab re-reads
 *     exactly those files after flushing its own unsaved edits.
 *   - **Text only, bounded** — at most {@link AGENT_FILE_MAX_BYTES}, UTF-8, no
 *     NUL bytes. Images and fonts land through the asset tools.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { toolRefusal, type ToolRefusal } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { AGENT_FILE_MAX_BYTES, pathRefusal } from './fileReadTools'
import { pushStudioDiskChange } from './liveReloadPush'
import {
  contentHash,
  hasOtherHardLinks,
  readTextFile,
  resolveAgentFilePath,
  statIfPresent,
  type AgentFileTarget,
} from '../../../../handlers/studio/agentFileAccess'
import { withProjectWriteLock } from '../../../../handlers/studio/projectWriteLock'
import { appendTurnWrite } from '../../../../handlers/studio/turnWriteLog'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'

const EXPECTED_HASH_FIELD = Type.Optional(
  Type.String({
    description: 'The `hash` studio_read_file (or a previous write/edit of this file) returned. The write refuses with stale-source when the file on disk no longer has that hash — someone changed it after you read it.',
  }),
)

/** The open project this turn writes into, or the refusal when there is none. */
function turnProject(ctx: ToolContext): string | ToolRefusal {
  if (!ctx.workspaceDir) {
    return toolRefusal('no-open-project', 'No Studio project is open for this turn, so there is nowhere to write.', {
      remedy: 'Ask the user to open the project in Studio and send the message again.',
    })
  }
  return resolveToolProjectDir(undefined, ctx)
}

/** Text content a write may land, or the refusal. */
function checkContent(content: string, rel: string): ToolRefusal | null {
  if (content.includes('\0')) {
    return toolRefusal('not-text', `The content for "${rel}" contains a NUL character, so it is not text.`, {
      remedy: 'Images, fonts and other binary files go through studio_upload_asset or studio_fetch_remote_asset.',
    })
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > AGENT_FILE_MAX_BYTES) {
    return toolRefusal('file-too-large', `The content for "${rel}" is ${bytes.toLocaleString('en-US')} bytes, over the ${AGENT_FILE_MAX_BYTES.toLocaleString('en-US')}-byte cap.`, {
      remedy: 'Split it: move a large section into its own component file, or its styles into their own stylesheet.',
    })
  }
  return null
}

function staleRefusal(rel: string, expectedHash: string, actualHash: string): ToolRefusal {
  return toolRefusal('stale-source', `"${rel}" changed since you read it (you passed hash ${expectedHash}; it is now ${actualHash}), so writing would discard a change you never saw.`, {
    remedy: 'Read it again with studio_read_file and rebuild the change against what is there now.',
    details: { path: rel, hash: actualHash },
  })
}

/**
 * The current text of an existing target, with every refusal a write shares:
 * not a regular file, a hard link, not text, over the cap, stale. `null`
 * content means the file does not exist yet.
 */
function currentText(
  target: AgentFileTarget,
  expectedHash: string | undefined,
): { content: string | null; hash: string | null } | ToolRefusal {
  const stat = statIfPresent(target.abs)
  if (!stat) {
    if (expectedHash !== undefined) {
      return toolRefusal('stale-source', `"${target.rel}" does not exist any more, but you passed a hash for it.`, {
        remedy: 'List the folder with studio_list_files to see what is there now.',
      })
    }
    return { content: null, hash: null }
  }
  if (!stat.isFile()) return toolRefusal('not-a-file', `"${target.rel}" is a directory, not a file.`)
  if (hasOtherHardLinks(stat)) {
    return toolRefusal('protected-path', `"${target.rel}" has other hard-linked names on disk, so writing it would change them too — possibly outside the project.`)
  }
  const read = readTextFile(target.abs, AGENT_FILE_MAX_BYTES)
  if (read.kind === 'too-large') {
    return toolRefusal('file-too-large', `"${target.rel}" is ${read.bytes.toLocaleString('en-US')} bytes, over the ${AGENT_FILE_MAX_BYTES.toLocaleString('en-US')}-byte cap for the file tools.`)
  }
  if (read.kind === 'not-text') return toolRefusal('not-text', `"${target.rel}" ${read.reason}, so a text tool cannot rewrite it.`)
  if (read.kind !== 'text') return toolRefusal('not-a-file', `"${target.rel}" could not be read as a file.`)
  if (expectedHash !== undefined && expectedHash !== read.hash) return staleRefusal(target.rel, expectedHash, read.hash)
  return { content: read.content, hash: read.hash }
}

function isRefusal(value: unknown): value is ToolRefusal {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

/** Record every written file in the turn log and push one reload naming all of them. Runs after the bytes landed. */
function afterWrites(dir: string, ctx: ToolContext, written: readonly AgentFileTarget[]): void {
  if (written.length === 0) return
  const userKey = studioAgentUserKey(ctx.userId)
  for (const target of written) appendTurnWrite(dir, userKey, target.abs)
  pushStudioDiskChange(dir, written.map((target) => target.rel))
}

// ---------------------------------------------------------------------------
// studio_write_file
// ---------------------------------------------------------------------------

const WriteFileInputSchema = Type.Object(
  {
    path: Type.String({ description: 'Path of the file inside the open project, relative to its root, e.g. "pages/Checkout.tsx". Missing folders are created.' }),
    content: Type.String({ description: `The COMPLETE new content of the file — not a fragment. At most ${AGENT_FILE_MAX_BYTES.toLocaleString('en-US')} bytes of UTF-8 text.` }),
    expectedHash: EXPECTED_HASH_FIELD,
  },
  { additionalProperties: false },
)

const writeFileTool: AiTool = {
  name: 'studio_write_file',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Create a file, or replace one whole, in the open project — the way to write a new screen (its .tsx and its .module.css) in one call each. The canvas re-renders the file as soon as it lands. Creating a file needs only path and content. Replacing an EXISTING file needs expectedHash (from studio_read_file): without it, or when the file changed since that read, it refuses with stale-source rather than overwrite work you never saw — for a small change to an existing file use studio_edit_file instead. Refuses protected-path for anything in .studio/, .claude/, .git/, node_modules/ or build output and for credential files, and path-outside-project for anything outside the project. Returns { path, created, bytes, hash } — hash is the new version, good for the next edit. Requires studio.write.',
  inputSchema: WriteFileInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { path: rawPath, content, expectedHash } = input as { path: string; content: string; expectedHash?: string }
    const dir = turnProject(ctx)
    if (typeof dir !== 'string') return dir
    const target = resolveAgentFilePath(dir, rawPath, 'write')
    if (!target.ok) return pathRefusal(target)
    const contentProblem = checkContent(content, target.rel)
    if (contentProblem) return contentProblem

    const outcome = await withProjectWriteLock(dir, () => {
      const current = currentText(target, expectedHash)
      if (isRefusal(current)) return current
      if (current.content !== null && expectedHash === undefined) {
        return toolRefusal('stale-source', `"${target.rel}" already exists, and replacing it whole without having read it would discard whatever it holds now.`, {
          remedy: 'Read it with studio_read_file and pass its hash as expectedHash — or change just the part you mean with studio_edit_file.',
          details: { path: target.rel, hash: current.hash },
        })
      }
      if (current.content === content) {
        return { ok: true as const, path: target.rel, created: false, unchanged: true, bytes: Buffer.byteLength(content, 'utf8'), hash: current.hash }
      }
      mkdirSync(dirname(target.abs), { recursive: true })
      // A NEW file is created exclusively: if something outside Studio (an
      // editor, a git checkout) created it since the check above, this
      // refuses instead of overwriting work the model never saw.
      try {
        writeFileSync(target.abs, content, { encoding: 'utf8', flag: current.content === null ? 'wx' : 'w' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        return toolRefusal('stale-source', `"${target.rel}" was created by something else a moment ago, so it was not overwritten.`, {
          remedy: 'Read it with studio_read_file, then write again with its hash as expectedHash.',
        })
      }
      afterWrites(dir, ctx, [target])
      return { ok: true as const, path: target.rel, created: current.content === null, bytes: Buffer.byteLength(content, 'utf8'), hash: contentHash(content) }
    })
    return outcome
  },
}

// ---------------------------------------------------------------------------
// studio_edit_file / studio_edit_files — exact-string replacement
// ---------------------------------------------------------------------------

const EditFields = {
  path: Type.String({ description: 'Path of an EXISTING file inside the open project, relative to its root, e.g. "pages/Checkout.module.css".' }),
  oldString: Type.String({
    minLength: 1,
    description: 'The exact text to replace, copied from the file — whitespace, indentation and line breaks included. It must occur exactly once unless replaceAll is true; include a line or two of surrounding context to make it unique.',
  }),
  newString: Type.String({ description: 'The text that replaces oldString. May be empty, to delete it.' }),
  replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every occurrence of oldString instead of requiring exactly one. Default false.' })),
  expectedHash: EXPECTED_HASH_FIELD,
}

const EditFileInputSchema = Type.Object(EditFields, { additionalProperties: false })

type EditInput = Static<typeof EditFileInputSchema>

/** 1-based line numbers of every occurrence of `needle` in `haystack` (at most `cap`). */
function occurrenceLines(haystack: string, needle: string, cap: number): { count: number; lines: number[] } {
  const lines: number[] = []
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    count += 1
    if (lines.length < cap) lines.push(haystack.slice(0, at).split('\n').length)
    from = at + needle.length
  }
  return { count, lines }
}

/**
 * Apply one exact-string edit to `content`, or refuse. A file written with
 * CRLF line endings is matched with the edit's own `\n`s widened to `\r\n`:
 * a model copies text back with `\n`, and "no match" on a line-ending
 * difference it cannot see is a wasted round.
 */
function applyEdit(content: string, edit: EditInput, rel: string): { content: string; replacements: number } | ToolRefusal {
  if (edit.oldString === edit.newString) {
    return toolRefusal('invalid-input', `The edit to "${rel}" replaces a string with itself, which changes nothing.`)
  }
  const crlf = content.includes('\r\n') && !edit.oldString.includes('\r')
  const oldString = crlf ? edit.oldString.replace(/\n/g, '\r\n') : edit.oldString
  const newString = crlf ? edit.newString.replace(/\r?\n/g, '\r\n') : edit.newString
  const { count, lines } = occurrenceLines(content, oldString, 10)
  if (count === 0) {
    return toolRefusal('edit-no-match', `oldString does not occur in "${rel}".`, {
      remedy: 'Read the file again with studio_read_file and copy the exact text, including whitespace and line breaks.',
    })
  }
  if (count > 1 && !edit.replaceAll) {
    return toolRefusal('edit-ambiguous', `oldString occurs ${count} times in "${rel}" (lines ${lines.join(', ')}${count > lines.length ? ', …' : ''}).`, {
      remedy: 'Add surrounding lines to oldString until it names exactly one place, or pass replaceAll:true if every occurrence should change.',
      details: { occurrences: count, lines },
    })
  }
  return edit.replaceAll
    ? { content: content.split(oldString).join(newString), replacements: count }
    : { content: content.replace(oldString, () => newString), replacements: 1 }
}

const editFileTool: AiTool = {
  name: 'studio_edit_file',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Change part of an existing file in the open project by exact string replacement: oldString (copied exactly from the file, and occurring exactly once — or pass replaceAll:true) becomes newString. The right tool for a text change, a prop, a style rule, an import. Refuses edit-no-match when oldString is not in the file, edit-ambiguous (with the line numbers) when it occurs more than once, and stale-source when you pass an expectedHash the file no longer has. Same path rules as studio_write_file. Returns { path, replacements, hash }. For several edits that must land together — a component and its stylesheet, a rename across files — use studio_edit_files. Requires studio.write.',
  inputSchema: EditFileInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const edit = input as EditInput
    const dir = turnProject(ctx)
    if (typeof dir !== 'string') return dir
    const target = resolveAgentFilePath(dir, edit.path, 'write')
    if (!target.ok) return pathRefusal(target)

    return withProjectWriteLock(dir, () => {
      const current = currentText(target, edit.expectedHash)
      if (isRefusal(current)) return current
      if (current.content === null) {
        return toolRefusal('no-such-file', `"${target.rel}" does not exist, so there is nothing to edit.`, {
          remedy: 'Create it with studio_write_file, or find the real path with studio_list_files.',
        })
      }
      const next = applyEdit(current.content, edit, target.rel)
      if (isRefusal(next)) return next
      const contentProblem = checkContent(next.content, target.rel)
      if (contentProblem) return contentProblem
      writeFileSync(target.abs, next.content, 'utf8')
      afterWrites(dir, ctx, [target])
      return { ok: true as const, path: target.rel, replacements: next.replacements, hash: contentHash(next.content) }
    })
  },
}

/** Upper bound on one atomic batch — far above a rename across a real project, and small enough to reason about. */
const EDIT_FILES_MAX_EDITS = 50

const EditFilesInputSchema = Type.Object(
  {
    edits: Type.Array(Type.Object(EditFields, { additionalProperties: false }), {
      minItems: 1,
      maxItems: EDIT_FILES_MAX_EDITS,
      description: 'The edits, applied in order. Several edits may target the same file; each applies to the result of the ones before it. expectedHash, when given, is checked against the file as it is on disk BEFORE any of these edits.',
    }),
  },
  { additionalProperties: false },
)

const editFilesTool: AiTool = {
  name: 'studio_edit_files',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    `Apply up to ${EDIT_FILES_MAX_EDITS} exact-string edits across one or more existing files ALL-OR-NOTHING: every edit is checked first (path rules, oldString found exactly once unless replaceAll, expectedHash), and if any one would refuse, NOTHING is written and the refusal names the edit (editIndex). Use it for a change that must not land half-way — a component and its stylesheet, a renamed class or prop across files, a translation key added to every dictionary. The canvas reloads once for the whole batch. Returns { files: [{ path, hash }], edits }. Requires studio.write.`,
  inputSchema: EditFilesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { edits } = input as { edits: readonly EditInput[] }
    const dir = turnProject(ctx)
    if (typeof dir !== 'string') return dir

    const targets: AgentFileTarget[] = []
    for (const [index, edit] of edits.entries()) {
      const target = resolveAgentFilePath(dir, edit.path, 'write')
      if (!target.ok) return withEditIndex(pathRefusal(target), index)
      targets.push(target)
    }

    return withProjectWriteLock(dir, () => {
      // Plan every file's final content before touching the disk.
      const plans = new Map<string, { target: AgentFileTarget; original: string; next: string }>()
      for (const [index, edit] of edits.entries()) {
        const target = targets[index]!
        let plan = plans.get(target.rel)
        if (!plan) {
          const current = currentText(target, edit.expectedHash)
          if (isRefusal(current)) return withEditIndex(current, index)
          if (current.content === null) {
            return withEditIndex(toolRefusal('no-such-file', `"${target.rel}" does not exist, so there is nothing to edit.`, {
              remedy: 'Create it with studio_write_file first, then edit.',
            }), index)
          }
          plan = { target, original: current.content, next: current.content }
          plans.set(target.rel, plan)
        } else if (edit.expectedHash !== undefined && edit.expectedHash !== contentHash(plan.original)) {
          return withEditIndex(staleRefusal(target.rel, edit.expectedHash, contentHash(plan.original)), index)
        }
        const next = applyEdit(plan.next, edit, target.rel)
        if (isRefusal(next)) return withEditIndex(next, index)
        const contentProblem = checkContent(next.content, target.rel)
        if (contentProblem) return withEditIndex(contentProblem, index)
        plan.next = next.content
      }

      // Write. A failure part-way restores every file already written, so the
      // batch is all-or-nothing on disk, not only in the checks above.
      const written: Array<{ target: AgentFileTarget; original: string }> = []
      try {
        for (const plan of plans.values()) {
          if (plan.next === plan.original) continue
          writeFileSync(plan.target.abs, plan.next, 'utf8')
          written.push({ target: plan.target, original: plan.original })
        }
      } catch (err) {
        const unrestored: string[] = []
        for (const { target, original } of written) {
          try {
            writeFileSync(target.abs, original, 'utf8')
          } catch (restoreErr) {
            console.error('[studio:mcp] studio_edit_files could not restore a file after a failed batch:', restoreErr)
            unrestored.push(target.rel)
          }
        }
        // A file that could not be restored DID change: log it and reload it like any write.
        afterWrites(dir, ctx, written.map(({ target }) => target).filter((target) => unrestored.includes(target.rel)))
        return toolRefusal('io-error', `Writing the batch failed (${err instanceof Error ? err.message : String(err)}). ${unrestored.length === 0 ? 'Every file already written was restored, so nothing changed.' : `These files could not be restored and hold the new content: ${unrestored.join(', ')}.`}`)
      }
      afterWrites(dir, ctx, written.map(({ target }) => target))
      return {
        ok: true as const,
        files: [...plans.values()].map((plan) => ({ path: plan.target.rel, hash: contentHash(plan.next), changed: plan.next !== plan.original })),
        edits: edits.length,
      }
    })
  },
}

/** A refusal from inside a batch, naming which edit it came from. */
function withEditIndex(refusal: ToolRefusal, index: number): ToolRefusal & { editIndex: number } {
  const prefix = `Edit ${index} (counting from 0) refused, so nothing in the batch was written: `
  return { ...refusal, editIndex: index, message: `${prefix}${refusal.message}`, error: `${prefix}${refusal.error}` }
}

/**
 * The file-authoring tools, for the in-canvas agent on an HTTP driver only.
 * Not part of `studioMcpTools` — see this module's doc.
 */
export const studioAgentFileWriteTools: AiTool[] = [writeFileTool, editFileTool, editFilesTool]
