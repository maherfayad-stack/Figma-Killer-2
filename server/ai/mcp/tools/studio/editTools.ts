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
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import {
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
import { readBoardsFileOrEmpty } from '../../../../handlers/studio/boardGeometry'

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
    'Apply a batch of typed source edits to a project\'s .tsx/.jsx files in one call — the same engine POST /admin/api/studio/save runs (ordering bottom-to-top so a line-shifting codemod can\'t invalidate a pending edit\'s location, dedup, per-edit try/catch, shared-component detection). Seven VALUE kinds rewrite a single existing span in place, normally preserving line count: prop, text, style, class, literal, tag, asset. detach and swap also rewrite an existing element, but by inlining or retargeting a WHOLE component body — typically many lines, so treat them as line-count-changing too. Three STRUCTURAL kinds change WHERE markup is and always change the file\'s line count: insert (add a new element — nodeId is the CONTAINER\'s location, not the new element\'s; optional anchorNodeId/position places it beside an existing sibling, default appends as the last child. WITH importSpecifier, name is a component to import, e.g. "Button" from "@alm-design/design-system"; WITHOUT importSpecifier, name is a plain intrinsic HTML tag — "div", "span", "button", "img" — which needs no import, and is how you build the layout structure a screen is made of. children builds the element\'s CONTENT in the SAME call: either a literal text string (<span>Sign in</span>) or an ARRAY OF NESTED ELEMENTS, each with the same { name, importSpecifier?, props?, children? } shape, nested arbitrarily deep. BUILD A WHOLE SCREEN IN ONE insert — do NOT insert one element per call and re-read between them: every insert shifts node ids, so per-element inserts cost a re-parse each and a ~30-node screen becomes ~30 sequential round trips (measured: over twenty minutes for one screen). A nested subtree needs no intermediate node ids at all, because nothing reads one between the levels. All imports for the whole tree are written in one pass, and the whole subtree is validated before any byte is written, so a bad grandchild refuses without leaving a half-built element), delete (remove an element), move (reorder — nodeId is the element being moved, anchorNodeId + position name where it goes). The class kind ({ kind: "class", nodeId, add: string[], remove: string[] }) adds/removes whole class TOKENS in an element\'s className attribute — add/remove are class NAMES (e.g. "bg-blue-600"), never the editor\'s own "sc-<hash>" style-rule ids. This is how a Tailwind (or any plain-string-class) element edit reaches disk: swapping bg-red-500 for bg-blue-600 on an element is a class edit, not a css edit — css below only ever targets a hand-authored stylesheet rule. class writes a bare className="a b" literal, an expression-wrapped string/template (className={"a b"} or className={`a b`}), and cn(...)/clsx(...)/classNames(...)/classnames(...) calls (ADD merges into a literal argument or appends one; REMOVE strips the token from every literal argument, best-effort — a token reachable only through a non-literal argument, e.g. isActive && "active", is left alone); it creates the attribute when absent. It refuses by name rather than guessing: css-module-binding (className={styles.card}, a default import from a *.module.css file — edit the class\'s own declaration in the stylesheet instead), template-dynamic (removing a token from a dynamic template literal, e.g. `a ${x}` — a token might live in the interpolated part, which can\'t be read from source text; ADD to the same shape still works, appended to the static head), unsupported-call (a function call other than cn/clsx/classNames/classnames), spread-attribute (className={...spread}), and unsupported-expression (a bare identifier, ternary, or any other shape). A request where every add token is already present and every remove token already absent is a silent no-op, not a refusal. One more kind, css, writes a declaration into a stylesheet directly (file + selector + property + value) rather than a JSX node — the rule is CREATED at the end of the file when the selector is not there yet, so this both edits existing styles and authors new ones (e.g. filling in the .module.css studio_create_page scaffolds next to each page). The file must already exist and be hand-authored CSS: a compiled/generated stylesheet is refused by name. This is the "make big changes at once" tool — for a single detach/swap, studio_codemod\'s richer per-call result is usually more convenient. Returns { written, skipped, shifted, sharedComponents, refusals, pageIds } — `shifted: true` means a write changed a touched file\'s line count, so any node id you decoded BEFORE this call is now stale (re-call studio_list_pages/studio_find_nodes) — this is GUARANTEED for insert/delete/move and LIKELY for detach/swap, never for the seven single-line value kinds; `sharedComponents: true` means an edit landed on an inlined component instance, route chrome, or a detach/swap; `refusals` lists WHY any detach/swap/delete/insert/move/css/class edit specifically didn\'t write, with a named reason rather than a generic skip; `pageIds` names the pages this batch touched — if the caller has the project open in a browser tab, its canvas is nudged to re-read exactly those pages (best-effort; nothing to do if no browser is open). Requires studio.write.',
  inputSchema: ApplyEditsInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, edits } = input as { dir?: string; edits: StudioEdit[] }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const { touchedFiles, ...result } = applyStudioEditBatch(dir, edits)
    const pageIds = touchedFilesToPageIds(dir, touchedFiles)
    // Best-effort — a failed/absent bridge never affects this tool's own result.
    pushStudioLiveReload(ctx.userId, { dir, pageIds })
    return { ok: true, dir, ...result, pageIds }
  },
}

// ---------------------------------------------------------------------------
// studio_set_frames — bulk board geometry (.studio/boards.json)
// ---------------------------------------------------------------------------

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
    const boardsFile = readBoardsFileOrEmpty(dir)
    const targetSet = pageIds ? new Set(pageIds) : null

    let resized = 0
    const resizedPageIds = new Set<string>()
    const missing = new Set(pageIds ?? [])
    const boards: Board[] = boardsFile.boards.map((board) => {
      let next = board
      for (const frame of board.frames) {
        if (targetSet && !targetSet.has(frame.pageId)) continue
        next = resizeFrame(next, frame.pageId, width, height)
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
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Dispatch one of the higher-level structural codemods by verb: "rename-tag" (setJsxTagName), "set-import-specifier" (setImportSpecifier), "detach" (inline a LOCAL component\'s own JSX at its call site — refuses with a specific reason for hooks/data-driven/undestructured-props bodies or a package component; see detachComponentInstance), "extract-component" (the detach-refusal escape hatch — duplicate the component under a fresh name and repoint just this call site; see extractComponentCopy), "swap" (retarget an instance at a DIFFERENT component, diffing props — requires newComponentName/newComponentSource/newComponentFile; see swapComponentInstance). detach/swap/extract-component return { ok:false, code:"refused", reason, message } on refusal — never a silent no-op — and { ok:true, shifted:true, pageIds, ... } on success (node ids downstream of this file are now stale — re-call studio_list_pages/studio_find_nodes; pageIds names the touched page and, if the caller has the project open in a browser tab, nudges its canvas to re-read it, best-effort). Requires studio.write.',
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

    const loc = studioEditLocation(nodeId)
    if (!loc) {
      return {
        ok: false,
        code: 'no-writable-location',
        message: `Node "${nodeId}" has no single writable source location (synthetic node or a \`.map\` iteration).`,
      }
    }
    const target = { file: join(dir, ...loc.rel.split('/')), line: loc.line, col: loc.col }
    // Every verb's call-site target is this one file — computed once, reused
    // by whichever branch below actually succeeds. Pushed only on a WRITTEN
    // outcome (never on a `missing-param`/`refused` early return).
    const pageIds = touchedFilesToPageIds(dir, [target.file])
    const notifyReload = (): void => pushStudioLiveReload(ctx.userId, { dir, pageIds })

    if (verb === 'rename-tag') {
      if (!tag) return { ok: false, code: 'missing-param', message: 'rename-tag requires "tag".' }
      setJsxTagName({ ...target, tag })
      notifyReload()
      return { ok: true, verb, nodeId, pageIds }
    }

    if (verb === 'set-import-specifier') {
      if (!specifier) return { ok: false, code: 'missing-param', message: 'set-import-specifier requires "specifier".' }
      setImportSpecifier({ ...target, specifier })
      notifyReload()
      return { ok: true, verb, nodeId, pageIds }
    }

    if (verb === 'detach') {
      const result = detachComponentInstance({ ...target, workspaceRoot: dir })
      if (!result.ok) return { ok: false, code: 'refused', reason: result.refusal.reason, message: result.refusal.message }
      notifyReload()
      return { ok: true, verb, nodeId, shifted: true, branchNote: result.branchNote, pageIds }
    }

    if (verb === 'extract-component') {
      const result = extractComponentCopy({ ...target, workspaceRoot: dir })
      if (!result.ok) return { ok: false, code: 'refused', reason: result.refusal.reason, message: result.refusal.message }
      notifyReload()
      return { ok: true, verb, nodeId, shifted: true, newFile: result.newFile, newComponentName: result.newComponentName, pageIds }
    }

    if (verb === 'swap') {
      if (!newComponentName || !newComponentSource || !newComponentFile) {
        return { ok: false, code: 'missing-param', message: 'swap requires newComponentName, newComponentSource, and newComponentFile.' }
      }
      const result = swapComponentInstance({ ...target, workspaceRoot: dir, newComponentName, newComponentSource, newComponentFile })
      if (!result.ok) return { ok: false, code: 'refused', reason: result.refusal.reason, message: result.refusal.message }
      notifyReload()
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

    return { ok: false, code: 'unknown-verb', message: `Unknown codemod verb: ${verb}` }
  },
}

export const studioEditMcpTools: AiTool[] = [applyEditsTool, setFramesTool, codemodTool]
