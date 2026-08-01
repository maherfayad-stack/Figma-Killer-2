/**
 * pageScaffold — WS-13 step 4: what `POST /admin/api/studio/page` writes and
 * where it places it, so a scaffolded screen is canonical by construction and
 * immediately visible. Three independent concerns, each small enough that
 * inlining it into `studio.ts` would fight that module's own "HTTP routing
 * layer only" doc comment:
 *
 *   - `detectPageFileExtension` — D5: match the project's existing
 *     convention, `.tsx` when there is none.
 *   - `autoPlaceBoardFrame` — D5 §11.3: "a scaffolded screen the user cannot
 *     see is not a screen." Written directly to `.studio/boards.json`, never
 *     assuming a browser tab is open — an MCP/agent caller (WS-12
 *     `studio_create_page`) may create the very first page a human never
 *     opened Studio for yet.
 *   - `scaffoldedPageRootNodeId` — the root node id WS-12 §3's
 *     `studio_create_page` needs to address the new screen, read by actually
 *     PARSING the file just written. Node ids are source locations (trap #2)
 *     — never construct one from the path/name we happen to know.
 *
 * The scaffold TEXT itself (`starterPage` in `../studioProjects.ts`) is
 * unchanged by this module — it was already canonical (literal props, literal
 * text, no `className`/stylesheet at all, so rule 7's "one authored styling
 * mechanism" is trivially satisfied for every project regardless of which one
 * it uses). `canonicalCheck.test.ts`'s sibling in this area,
 * `pageScaffold.test.ts`, asserts that directly against `checkCanonicalJsx`
 * rather than eyeballing it — see that file's module doc for why matching an
 * existing screen's STYLING mechanism specifically was deliberately NOT
 * attempted here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parsePageFile } from '@core/page-parser'
import {
  createBoard,
  createBoardsFile,
  defaultFramePosition,
  parseBoardsFile,
  serializeBoardsFile,
  upsertBoard,
  upsertFrame,
  type BoardsFile,
} from '@core/studio-board'
import {
  discoverPageFiles,
  nextPageName,
  pageComponentNameFromInput,
  projectPagesDir,
  starterPage,
} from '../studioProjects'
import { pageIdFromRelPath } from '../studioPageLoad'
import { readStudioMeta } from './studioMeta'

/**
 * A scaffolded page, or the one refusal this operation has. `conflict` is a
 * value rather than a thrown error because "that name is taken" is an ordinary
 * answer the caller maps to 409 — not an exception.
 */
export type ScaffoldPageResult =
  | { ok: true; relPath: string; pageId: string; title: string; rootNodeId: string | undefined }
  | { ok: false; conflict: string }

/**
 * Scaffold a new page, canonical by construction (WS-13 step 4), and place its
 * board frame. `dir` is already resolved and containment-checked by the route;
 * everything downstream of that is the real work, which is why it lives here
 * rather than in `studio.ts` — same split as `studioDownload.ts`.
 */
export function createScaffoldedPage(dir: string, nameInput: string): ScaffoldPageResult {
  const pagesDir = projectPagesDir(dir)
  const ext = detectPageFileExtension(pagesDir)
  // A supplied name wins; otherwise auto-name `Page`, `Page2`, … (one-click),
  // checked against the SAME extension the file is about to be written with —
  // see `nextPageName`'s own doc comment for why that must match.
  const componentName = pageComponentNameFromInput(nameInput) || nextPageName(pagesDir, ext)
  const relPath = `${componentName}${ext}`
  const file = join(pagesDir, relPath)
  if (existsSync(file)) return { ok: false, conflict: `A page named "${componentName}" already exists.` }
  mkdirSync(pagesDir, { recursive: true })
  writeFileSync(file, starterPage(componentName))
  const pageId = pageIdFromRelPath(relPath)
  // D5 §11.3 — a scaffolded screen the user cannot see is not a screen.
  autoPlaceBoardFrame(dir, pageId)
  // Node ids are source locations (trap #2) — read the root by parsing the
  // file just written, never constructed from the name/path.
  return { ok: true, relPath, pageId, title: componentName, rootNodeId: scaffoldedPageRootNodeId(dir, file) }
}

/**
 * `.tsx` unless the project's existing pages are UNAMBIGUOUSLY `.jsx` — any
 * `.tsx` present at all, or no pages yet, keeps the D5 default. Matches the
 * common real shape: a hand-authored or GitHub-imported plain-JS repo (no
 * `.tsx` anywhere) versus everything else, rather than a majority vote that
 * could flip on a single stray file.
 */
export function detectPageFileExtension(pagesDir: string): '.tsx' | '.jsx' {
  if (!existsSync(pagesDir)) return '.tsx'
  const files = discoverPageFiles(pagesDir)
  const hasTsx = files.some((rel) => rel.endsWith('.tsx'))
  const hasJsx = files.some((rel) => rel.endsWith('.jsx'))
  return hasJsx && !hasTsx ? '.jsx' : '.tsx'
}

function boardsFilePath(dir: string): string {
  return join(dir, '.studio', 'boards.json')
}

/**
 * Places `pageId` on the project's board at the next free grid slot
 * (`defaultFramePosition`, the same layout `boardSlice.ts`'s `addFrame`/
 * `seedFramesForActiveBoard` use client-side) and persists it — D5 §11.3.
 *
 * The FIRST board in the file is the target, matching `loadBoards`' own
 * "first board is the default" precedent (`file.boards[0].id` becomes
 * `activeBoardId` on load). When no `boards.json` exists yet at all (a brand
 * new project an agent scaffolds into before any human has opened it in a
 * browser), a board is created here — `crypto.randomUUID()` + `'Board 1'`,
 * the exact shape `boardSlice.ts`'s `loadBoards` synthesizes for the same
 * case, so a browser opening this project afterward sees no discontinuity.
 *
 * WS-10 Phase 2 keyed every `BoardFrame` by its OWN `id`, not `pageId` (two
 * frames of the same page — "duplicate as variant" — need distinct
 * addresses). `upsertFrame` mints nothing itself ("no `crypto.randomUUID()`
 * inside it", `boardsModel.ts`'s own doc) — the caller does, same as
 * `boardSlice.ts`'s own frame-creating actions, so this generates one here.
 *
 * Idempotent: a PAGE already placed on the board (by `pageId`, regardless of
 * which frame id it landed under) is left untouched rather than duplicated
 * or re-positioned — a scaffolded screen gets exactly one frame, never a
 * second "variant" of itself.
 */
export function autoPlaceBoardFrame(dir: string, pageId: string): void {
  const file = boardsFilePath(dir)
  const existing: BoardsFile = existsSync(file) ? parseBoardsFile(readFileSync(file, 'utf8')) : createBoardsFile()
  const board = existing.boards[0] ?? createBoard(crypto.randomUUID(), 'Board 1')
  if (board.frames.some((f) => f.pageId === pageId)) return

  const { x, y } = defaultFramePosition(board.frames.length)
  // WS-7.2 — a page scaffolded after "apply to all pages" inherits the
  // project's own frame default instead of the hardcoded FRAME_WIDTH/HEIGHT,
  // same precedent `boardSlice.ts`'s `addFrame` follows.
  const frameDefaults = readStudioMeta(dir).frameDefaults ?? {}
  const frame: Parameters<typeof upsertFrame>[1] = { id: crypto.randomUUID(), pageId, x, y }
  if (frameDefaults.width) frame.width = frameDefaults.width
  if (frameDefaults.height) frame.height = frameDefaults.height

  const updated = upsertBoard(existing, upsertFrame(board, frame))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, serializeBoardsFile(updated))
}

/**
 * The scaffolded file's own root node id — its one returned JSX root, read
 * by actually parsing `file` with the SAME parser every other node id in
 * Studio comes from. `undefined` on anything unexpected: `parsePageFile`
 * itself never throws (`ParsedPage` with empty `rootIds` on a guard trip), so
 * this degrades to "no root to report" rather than fabricating one — trap #2.
 */
export function scaffoldedPageRootNodeId(dir: string, file: string): string | undefined {
  return parsePageFile(file, dir).rootIds[0]
}
