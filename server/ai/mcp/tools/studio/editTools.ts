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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import {
  createBoardsFile,
  parseBoardsFile,
  resizeFrame,
  serializeBoardsFile,
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
import type { AiTool } from '../../../runtime/types'
import { resolveProjectDir } from '../../../../handlers/studioProjects'
import {
  applyStudioEditBatch,
  StudioEditSchema,
  studioEditLocation,
  type StudioEdit,
} from '../../../../handlers/studioWriteback'

const DirField = Type.Optional(
  Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
)

// ---------------------------------------------------------------------------
// studio_apply_edits
// ---------------------------------------------------------------------------

const ApplyEditsInputSchema = Type.Object(
  {
    dir: DirField,
    edits: Type.Array(StudioEditSchema, {
      description: 'A batch of typed source edits — same shape POST /admin/api/studio/save accepts (kind: prop|text|style|literal|tag|asset|detach|swap).',
      minItems: 1,
    }),
  },
  { additionalProperties: false },
)

const applyEditsTool: AiTool = {
  name: 'studio_apply_edits',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Apply a batch of typed source edits (kind: prop|text|style|literal|tag|asset|detach|swap) to a project\'s .tsx/.jsx files in one call — the same engine POST /admin/api/studio/save runs (ordering bottom-to-top so a line-shifting codemod can\'t invalidate a pending edit\'s location, dedup, per-edit try/catch, shared-component detection). This is the "make big changes at once" tool — for a single detach/swap, studio_codemod\'s richer per-call result is usually more convenient. Returns { written, skipped, shifted, sharedComponents, refusals } — `shifted: true` means a write changed a file\'s line count, so any node id you decoded BEFORE this call is now stale (re-call studio_list_pages/studio_find_nodes); `sharedComponents: true` means an edit landed on an inlined component instance, route chrome, or a detach/swap; `refusals` lists WHY any detach/swap edit specifically didn\'t write. Requires studio.write.',
  inputSchema: ApplyEditsInputSchema,
  handler: async (input) => {
    const { dir: dirInput, edits } = input as { dir?: string; edits: StudioEdit[] }
    const dir = resolveProjectDir(dirInput)
    const result = applyStudioEditBatch(dir, edits)
    return { ok: true, dir, ...result }
  },
}

// ---------------------------------------------------------------------------
// studio_set_frames — bulk board geometry (.studio/boards.json)
// ---------------------------------------------------------------------------

function readBoardsFile(dir: string): BoardsFile {
  const file = join(dir, '.studio', 'boards.json')
  return existsSync(file) ? parseBoardsFile(readFileSync(file, 'utf8')) : createBoardsFile()
}

function writeBoardsFile(dir: string, boards: BoardsFile): void {
  const file = join(dir, '.studio', 'boards.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, serializeBoardsFile(boards))
}

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
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Bulk-resize board frames in .studio/boards.json: set width/height on the given pageIds, or on every frame across every board when pageIds is omitted ("set all the pages to a certain width at once"). A pageId with no existing frame on any board is skipped, not created — pair with studio_list_pages first. Requires studio.write.',
  inputSchema: SetFramesInputSchema,
  handler: async (input) => {
    const { dir: dirInput, pageIds, width, height } = input as {
      dir?: string
      pageIds?: string[]
      width: number
      height: number
    }
    const dir = resolveProjectDir(dirInput)
    const boardsFile = readBoardsFile(dir)
    const targetSet = pageIds ? new Set(pageIds) : null

    let resized = 0
    const missing = new Set(pageIds ?? [])
    const boards: Board[] = boardsFile.boards.map((board) => {
      let next = board
      for (const frame of board.frames) {
        if (targetSet && !targetSet.has(frame.pageId)) continue
        next = resizeFrame(next, frame.pageId, width, height)
        resized += 1
        missing.delete(frame.pageId)
      }
      return next
    })

    const updated: BoardsFile = { ...boardsFile, boards }
    writeBoardsFile(dir, updated)

    return {
      ok: true,
      dir,
      resized,
      missing: [...missing], // pageIds explicitly requested that had no frame on any board
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
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Dispatch one of the higher-level structural codemods by verb: "rename-tag" (setJsxTagName), "set-import-specifier" (setImportSpecifier), "detach" (inline a LOCAL component\'s own JSX at its call site — refuses with a specific reason for hooks/data-driven/undestructured-props bodies or a package component; see detachComponentInstance), "extract-component" (the detach-refusal escape hatch — duplicate the component under a fresh name and repoint just this call site; see extractComponentCopy), "swap" (retarget an instance at a DIFFERENT component, diffing props — requires newComponentName/newComponentSource/newComponentFile; see swapComponentInstance). detach/swap/extract-component return { ok:false, code:"refused", reason, message } on refusal — never a silent no-op — and { ok:true, shifted:true, ... } on success (node ids downstream of this file are now stale — re-call studio_list_pages/studio_find_nodes). Requires studio.write.',
  inputSchema: CodemodInputSchema,
  handler: async (input) => {
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
    const dir = resolveProjectDir(dirInput)

    const loc = studioEditLocation(nodeId)
    if (!loc) {
      return {
        ok: false,
        code: 'no-writable-location',
        message: `Node "${nodeId}" has no single writable source location (synthetic node or a \`.map\` iteration).`,
      }
    }
    const target = { file: join(dir, ...loc.rel.split('/')), line: loc.line, col: loc.col }

    if (verb === 'rename-tag') {
      if (!tag) return { ok: false, code: 'missing-param', message: 'rename-tag requires "tag".' }
      setJsxTagName({ ...target, tag })
      return { ok: true, verb, nodeId }
    }

    if (verb === 'set-import-specifier') {
      if (!specifier) return { ok: false, code: 'missing-param', message: 'set-import-specifier requires "specifier".' }
      setImportSpecifier({ ...target, specifier })
      return { ok: true, verb, nodeId }
    }

    if (verb === 'detach') {
      const result = detachComponentInstance({ ...target, workspaceRoot: dir })
      if (!result.ok) return { ok: false, code: 'refused', reason: result.refusal.reason, message: result.refusal.message }
      return { ok: true, verb, nodeId, shifted: true, branchNote: result.branchNote }
    }

    if (verb === 'extract-component') {
      const result = extractComponentCopy({ ...target, workspaceRoot: dir })
      if (!result.ok) return { ok: false, code: 'refused', reason: result.refusal.reason, message: result.refusal.message }
      return { ok: true, verb, nodeId, shifted: true, newFile: result.newFile, newComponentName: result.newComponentName }
    }

    if (verb === 'swap') {
      if (!newComponentName || !newComponentSource || !newComponentFile) {
        return { ok: false, code: 'missing-param', message: 'swap requires newComponentName, newComponentSource, and newComponentFile.' }
      }
      const result = swapComponentInstance({ ...target, workspaceRoot: dir, newComponentName, newComponentSource, newComponentFile })
      if (!result.ok) return { ok: false, code: 'refused', reason: result.refusal.reason, message: result.refusal.message }
      return {
        ok: true,
        verb,
        nodeId,
        shifted: true,
        removedProps: result.removedProps,
        unfilledRequiredProps: result.unfilledRequiredProps,
      }
    }

    return { ok: false, code: 'unknown-verb', message: `Unknown codemod verb: ${verb}` }
  },
}

export const studioEditMcpTools: AiTool[] = [applyEditsTool, setFramesTool, codemodTool]
