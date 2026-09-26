/**
 * Studio MCP tools — 9.3 bulk edit + structural (headless, server-resolved).
 *
 * `studio_apply_edits` and `studio_set_frames` are headless-safe in a way the
 * CMS "site" page tree is NOT: a Studio project's source files and its board
 * geometry (`.studio/boards.json`) are both filesystem state, read/written
 * through the SAME plain GET/POST round trip the Studio UI itself uses (see
 * `server/handlers/studio.ts`'s `/save` and `/boards` routes) — there is no
 * separate in-memory DB copy for either to desync from. This is different
 * from the CMS page tree, which lives in Postgres/SQLite behind a live
 * editor-store autosave; THAT is the shape `mcp-tooling.md` forbids
 * ("never a headless mutator that would desync the open editor"). Writing
 * straight to a project's `.tsx` files or its `boards.json` while a browser
 * has the same project open carries the ordinary last-write-wins risk any two
 * concurrent editors of the same file have — not a new failure mode.
 *
 * `studio_codemod` dispatches the HIGHER-level verbs. `rename-tag` and
 * `set-import-specifier` are the original two; WS-4.4/4.5 (the instance
 * model) added `detach` (`detachComponentInstance`), `extract-component`
 * (`extractComponentCopy` — the detach-refusal escape hatch: duplicate the
 * component under a fresh name and repoint this one call site), and `swap`
 * (`swapComponentInstance`). All five are real codemods now — none of this
 * tool's verbs return a stub.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { SourceFingerprintSchema, type SourceFingerprintExpectations } from '@core/page-tree'
import { toolRefusal, type ToolRefusal } from '@core/ai'
import {
  resizeFrame,
  type Board,
  type BoardsFile,
} from '@core/studio-board'
import {
  detachComponentInstance,
  extractComponentCopy,
  setImportSpecifier,
  setJsxTagName,
  swapComponentInstance,
} from '@core/ast-codemods'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import {
  applyStudioEditBatch,
  StudioEditSchema,
  studioEditLocation,
  type StudioEdit,
} from '../../../../handlers/studioWriteback'
import { pushStudioLiveReload } from './liveReloadPush'
import { touchedFilesToPageIds } from './touchedPageIds'
import { readBoardsFile, writeBoardsFile } from '../../../../handlers/studio/boardGeometry'
import { withProjectWriteLock } from '../../../../handlers/studio/projectWriteLock'
import { AgentWriteRefusedError, runAgentSourceEdits } from './agentWriteSupport'
import { resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'

const DirField = Type.Optional(
  Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
)

// ---------------------------------------------------------------------------
// studio_apply_edits
// ---------------------------------------------------------------------------

const ApplyEditsInputSchema = Type.Object(
  {
    dir: DirField,
    edits: Type.Array(StudioEditSchema, {
      description: 'A batch of typed source edits — same shape POST /admin/api/studio/save accepts (kind: prop|text|style|class|literal|tag|asset|detach|swap|insert|delete|move|css).',
      minItems: 1,
    }),
    expect: Type.Optional(
      Type.Record(Type.String(), SourceFingerprintSchema, {
        description: 'Optional identity guard: { [nodeId]: sourceFingerprint } for any node id an edit names (nodeId, anchorNodeId, parentNodeId, siblingNodeIds), using the sourceFingerprint studio_find_nodes returned. An edit whose position now holds a different element refuses with reason element-moved and writes nothing, instead of landing on whatever slid into that line after the file changed.',
      }),
    ),
  },
  { additionalProperties: false },
)

/**
 * A codemod's own refusal, rendered as the shared tool refusal.
 *
 * The codemods have their own `reason` vocabulary (`DetachRefusalReason` and
 * friends) — far too specific to fold into the shared code table, and far too
 * useful to drop. So `code` is the one thing every caller branches on
 * (`codemod-refused`, never retryable) and `reason` rides along as a detail,
 * which is exactly the split `studio_git_commit` uses for git's own codes.
 */
function codemodRefusal(refusal: { reason: string; message: string }) {
  return toolRefusal('codemod-refused', refusal.message, {
    remedy: 'This edit has no single honest target. Change the source it is generated from, or use the named escape hatch — never retry the same verb on the same node.',
    details: { reason: refusal.reason },
  })
}

const applyEditsTool: AiTool = {
  name: 'studio_apply_edits',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Apply a batch of typed source edits to a project\'s .tsx/.jsx files and stylesheets in one call. Value kinds rewrite one span in place: prop, text, style, class, literal, tag, asset. Structural kinds: insert (nodeId is the CONTAINER; children nests a subtree, siblings adds a run after it — ONE insert per screen, not one per element), delete, move, duplicate, wrap, group, ungroup, transplant, styled, detach, swap. css writes a declaration into a hand-authored stylesheet, creating a missing rule. Returns { written, skipped, shifted, sharedComponents, refusals, fingerprints, retargeted, pageIds }: shifted:true means node ids read before this call are stale. refusals name each reason (binding-overwrite, element-moved, css-module-binding, template-dynamic, spread-attribute, unsupported-expression, …). Rules per kind: MCP resource studio://tool-notes. Requires studio.write.',
  inputSchema: ApplyEditsInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, edits, expect } = input as { dir?: string; edits: StudioEdit[]; expect?: SourceFingerprintExpectations }
    const dir = resolveToolProjectDir(dirInput, ctx)
    // Every file the engine writes goes through the agent write gate, the
    // content check and the turn checkpoint BEFORE it lands, and into the
    // turn log after (`runAgentSourceEdits`) — the same steps as the file tools.
    const { touchedFiles, ...result } = await withProjectWriteLock(dir, () =>
      runAgentSourceEdits(dir, ctx, () => applyStudioEditBatch(dir, edits, expect ?? {})),
    )
    const pageIds = touchedFilesToPageIds(dir, touchedFiles)
    // Best-effort — a failed/absent bridge never affects this tool's own result.
    pushStudioLiveReload(ctx.userId, { dir, pageIds })
    return { ok: true, dir, ...result, pageIds }
  },
}

// ---------------------------------------------------------------------------
// studio_set_frames — bulk board geometry (.studio/boards.json)
// ---------------------------------------------------------------------------

const SetFramesInputSchema = Type.Object(
  {
    dir: DirField,
    pageIds: Type.Optional(
      Type.Array(Type.String(), { description: 'Page ids to resize (from studio_list_pages). Omit to apply to every frame on every board.' }),
    ),
    width: Type.Number({ minimum: 1, description: 'New frame width in px, applied to every targeted frame.' }),
    height: Type.Number({ minimum: 1, description: 'New frame height in px, applied to every targeted frame.' }),
  },
  { additionalProperties: false },
)

const setFramesTool: AiTool = {
  name: 'studio_set_frames',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Bulk-resize board frames in .studio/boards.json: set width/height on the given pageIds, or on every frame across every board when pageIds is omitted ("set all the pages to a certain width at once"). A pageId with no existing frame on any board is skipped, not created — pair with studio_list_pages first. Returns { resized, missing, pageIds } — pageIds names every frame actually resized; if the caller has the project open in a browser tab, its board geometry is nudged to re-read from disk (best-effort). Requires studio.write.',
  inputSchema: SetFramesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pageIds, width, height } = input as {
      dir?: string
      pageIds?: string[]
      width: number
      height: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const boardsFile = readBoardsFile(dir)
    const targetSet = pageIds ? new Set(pageIds) : null

    let resized = 0
    const resizedPageIds = new Set<string>()
    const missing = new Set(pageIds ?? [])
    const boards: Board[] = boardsFile.boards.map((board) => {
      let next = board
      for (const frame of board.frames) {
        if (targetSet && !targetSet.has(frame.pageId)) continue
        next = resizeFrame(next, frame.id, width, height)
        resized += 1
        resizedPageIds.add(frame.pageId)
        missing.delete(frame.pageId)
      }
      return next
    })

    const updated: BoardsFile = { ...boardsFile, boards }
    writeBoardsFile(dir, updated)

    // No page CONTENT changed here — only frame geometry — so the live-reload
    // push carries no pageIds, just `boardsChanged`, telling the open board (if
    // any) to re-fetch .studio/boards.json rather than re-parse any .tsx.
    pushStudioLiveReload(ctx.userId, { dir, boardsChanged: resized > 0 })

    return {
      ok: true,
      dir,
      resized,
      missing: [...missing], // pageIds explicitly requested that had no frame on any board
      pageIds: [...resizedPageIds],
    }
  },
}

// ---------------------------------------------------------------------------
// studio_codemod — higher-level structural verbs
// ---------------------------------------------------------------------------

const CodemodInputSchema = Type.Object(
  {
    dir: DirField,
    verb: Type.Union(
      [
        Type.Literal('rename-tag'),
        Type.Literal('set-import-specifier'),
        Type.Literal('detach'),
        Type.Literal('swap'),
        Type.Literal('extract-component'),
      ],
      { description: 'Which structural codemod to run.' },
    ),
    nodeId: Type.String({ description: 'The node the codemod targets — for detach/swap/extract-component, a studio.instance node id (its own call-site location, not composite).' }),
    tag: Type.Optional(Type.String({ description: 'rename-tag: the new HTML tag name, e.g. "section".' })),
    specifier: Type.Optional(Type.String({ description: 'set-import-specifier: the new import specifier, e.g. "./icons/NewIcon.svg?raw" or "lucide-react" (still subject to the repo\'s own banned-package rules at review time).' })),
    newComponentName: Type.Optional(Type.String({ description: 'swap: the component to swap IN — its export/display name (and new JSX tag).' })),
    newComponentSource: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('package')], { description: 'swap: whether newComponentFile is a workspace-relative path (local) or a bare package specifier (package).' })),
    newComponentFile: Type.Optional(Type.String({ description: 'swap: workspace-relative POSIX path of the new component\'s file (local), or its bare package specifier (package).' })),
  },
  { additionalProperties: false },
)

const codemodTool: AiTool = {
  name: 'studio_codemod',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Run one structural codemod by verb: rename-tag, set-import-specifier, detach (inline a local component\'s JSX at its call site), extract-component (copy the component under a new name and repoint this call site — the way out when detach refuses), swap (retarget the instance at another component; needs newComponentName, newComponentSource and newComponentFile). A refusal is { ok:false, code:\'codemod-refused\', reason, message, remedy, retryable:false }, never a silent no-op; reason names the cause (hooks, a data-driven body, undestructured props, a package component). Success is { ok:true, shifted:true, pageIds, … }: node ids in that file are now stale, so re-read them. Requires studio.write.',
  inputSchema: CodemodInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, verb, nodeId, tag, specifier, newComponentName, newComponentSource, newComponentFile } = input as {
      dir?: string
      verb: string
      nodeId: string
      tag?: string
      specifier?: string
      newComponentName?: string
      newComponentSource?: 'local' | 'package'
      newComponentFile?: string
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const loc = studioEditLocation(dir, nodeId)
    if (!loc) {
      return toolRefusal(
        'no-writable-location',
        `Node "${nodeId}" has no single writable source location (synthetic node or a \`.map\` iteration).`,
        { remedy: 'Edit the source the node is generated FROM — the component or the array literal — not the generated node.' },
      )
    }
    // The call site goes to the agent write gate BEFORE any verb runs: the
    // hook below refuses each write as it comes, but `extract-component` makes
    // its new file first, and a refusal on the call site after that would
    // leave the copy behind.
    const callSite = resolveAgentFilePath(dir, loc.rel, 'write')
    if (!callSite.ok) return toolRefusal(callSite.code, callSite.message, { remedy: callSite.remedy })
    const target = { file: callSite.abs, line: loc.line, col: loc.col }
    // Every verb's call-site target is this one file — computed once, reused
    // by whichever branch below actually succeeds. Pushed only on a WRITTEN
    // outcome (never on a `missing-param`/`refused` early return).
    const pageIds = touchedFilesToPageIds(dir, [target.file])

    const outcome = await runCodemodAsAgent(dir, ctx, (): CodemodOutcome => {
      if (verb === 'rename-tag') {
        if (!tag) return toolRefusal('missing-param', 'rename-tag requires "tag".')
        setJsxTagName({ ...target, tag })
        return { ok: true, verb, nodeId, pageIds }
      }

      if (verb === 'set-import-specifier') {
        if (!specifier) return toolRefusal('missing-param', 'set-import-specifier requires "specifier".')
        setImportSpecifier({ ...target, specifier })
        return { ok: true, verb, nodeId, pageIds }
      }

      if (verb === 'detach') {
        const result = detachComponentInstance({ ...target, workspaceRoot: dir })
        if (!result.ok) return codemodRefusal(result.refusal)
        return { ok: true, verb, nodeId, shifted: true, branchNote: result.branchNote, pageIds }
      }

      if (verb === 'extract-component') {
        const result = extractComponentCopy({ ...target, workspaceRoot: dir })
        if (!result.ok) return codemodRefusal(result.refusal)
        return { ok: true, verb, nodeId, shifted: true, newFile: result.newFile, newComponentName: result.newComponentName, pageIds }
      }

      if (verb === 'swap') {
        if (!newComponentName || !newComponentSource || !newComponentFile) {
          return toolRefusal('missing-param', 'swap requires newComponentName, newComponentSource, and newComponentFile.')
        }
        const result = swapComponentInstance({ ...target, workspaceRoot: dir, newComponentName, newComponentSource, newComponentFile })
        if (!result.ok) return codemodRefusal(result.refusal)
        return {
          ok: true,
          verb,
          nodeId,
          shifted: true,
          removedProps: result.removedProps,
          unfilledRequiredProps: result.unfilledRequiredProps,
          pageIds,
        }
      }

      return toolRefusal('unknown-verb', `Unknown codemod verb: ${verb}`, {
        remedy: 'Use one of: rename-tag, set-import-specifier, detach, extract-component, swap.',
      })
    })
    // Best-effort, and only on a WRITTEN outcome — a failed/absent bridge never affects this tool's own result.
    if (outcome.ok) pushStudioLiveReload(ctx.userId, { dir, pageIds })
    return outcome
  },
}

type CodemodOutcome = ToolRefusal | ({ ok: true } & Record<string, unknown>)

/**
 * Run one codemod the way every agent source write runs: under the project
 * write lock, with each write it makes shown first to the agent write gate,
 * the content check and the turn checkpoint, and recorded in the turn log
 * after (`runAgentSourceEdits`). A write those steps refuse never lands, and
 * the refusal is the tool's answer.
 */
function runCodemodAsAgent(dir: string, ctx: ToolContext, run: () => CodemodOutcome): Promise<CodemodOutcome> {
  return withProjectWriteLock(dir, () => {
    try {
      return runAgentSourceEdits(dir, ctx, run)
    } catch (err) {
      if (err instanceof AgentWriteRefusedError) return err.refusal
      throw err
    }
  })
}

export const studioEditMcpTools: AiTool[] = [applyEditsTool, setFramesTool, codemodTool]
