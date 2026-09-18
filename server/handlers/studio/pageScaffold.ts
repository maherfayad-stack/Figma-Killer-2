/**
 * pageScaffold — WS-13 step 4: what `POST /admin/api/studio/page` writes and
 * where it places it, so a scaffolded screen is canonical by construction and
 * immediately visible. Three independent concerns, each small enough that
 * inlining it into `studio.ts` would fight that module's own "HTTP routing
 * layer only" doc comment:
 *
 *   - `detectPageFileExtension` — D5: match the project's existing
 *     convention, `.tsx` when there is none.
 *   - board placement — D5 §11.3: "a scaffolded screen the user cannot see is
 *     not a screen." Delegated to `boardFrames.ts`'s `autoPlaceBoardFrame`,
 *     which owns every server-side write to `.studio/boards.json` (page
 *     DELETION needs the mirror of it, and a removal function has no honest
 *     home in a module called "pageScaffold").
 *   - `scaffoldedPageRootNodeId` — the root node id WS-12 §3's
 *     `studio_create_page` needs to address the new screen, read by actually
 *     PARSING the file just written. Node ids are source locations (trap #2)
 *     — never construct one from the path/name we happen to know.
 *
 * The scaffold TEXT itself (`starterPage` in `./pageTemplates.ts`) is unchanged
 * by this module — every one of its four page kinds is canonical by
 * construction (literal props, literal text, one `return`, one authored
 * styling mechanism), which is what lets a scaffolded popup or bottom sheet
 * be edited in the Properties panel from the moment it is written.
 * `canonicalCheck.test.ts`'s sibling in this area, `pageScaffold.test.ts`,
 * asserts that directly against `checkCanonicalJsx` rather than eyeballing it
 * — see that file's module doc for why matching an existing screen's STYLING
 * mechanism specifically was deliberately NOT attempted here.
 *
 * A page's KIND (`@core/studio-board`'s `PageKind`) reaches only as far as
 * this function: it picks the starter files and the auto-name base, and is
 * then gone. Nothing persists it — see `pageKinds.ts` for why a kind recorded
 * anywhere would be a second source of truth that drifts from the file.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { designSystemImportSpecifier, parsePageFile } from '@core/page-parser'
import { DEFAULT_PAGE_KIND, type PageKind } from '@core/studio-board'
import {
  discoverPageFiles,
  nextPageName,
  pageComponentNameFromInput,
  projectPagesDir,
} from '../studioProjects'
import { autoPlaceBoardFrame } from './boardFrames'
import { withProjectWriteLock } from './projectWriteLock'

import { detectPageTemplateKit, pageNameBase, starterPage } from './pageTemplates'
import { pageIdFromRelPath } from '../studioPageIds'

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
export function createScaffoldedPage(
  dir: string,
  nameInput: string,
  kind: PageKind = DEFAULT_PAGE_KIND,
  boardId?: string,
): ScaffoldPageResult {
  const pagesDir = projectPagesDir(dir)
  const ext = detectPageFileExtension(pagesDir)
  // A supplied name wins; otherwise auto-name from the KIND's own base
  // (`Page`/`Popup`/`Sheet`, …), checked against the SAME extension the file is
  // about to be written with — see `nextPageName`'s own doc for why that must
  // match.
  const componentName = pageComponentNameFromInput(nameInput) || nextPageName(pagesDir, ext, pageNameBase(kind))
  const relPath = `${componentName}${ext}`
  const file = join(pagesDir, relPath)
  if (existsSync(file)) return { ok: false, conflict: `A page named "${componentName}" already exists.` }
  mkdirSync(pagesDir, { recursive: true })
  // The project's own dialect — a project carrying the built-in design system
  // (`<project>/design-system/`) means the overlay kinds scaffold its real
  // `BottomSheet`/`Dialog` instead of a hand-rolled copy, imported by the
  // relative path from THIS page's directory. Same posture as
  // `detectPageFileExtension` above.
  const starter = starterPage(componentName, kind, {
    kit: detectPageTemplateKit(dir),
    designSystemImport: designSystemImportSpecifier(relative(dir, file).split(sep).join('/')),
  })
  writeFileSync(file, starter.component)
  // Written alongside the component, never lazily: the component imports it by
  // name, so a missing stylesheet is a broken page, not a deferred nicety. A
  // design-system-backed overlay has no stylesheet of its own — the package
  // draws it — and gets no empty file written for it.
  if (starter.styles !== undefined && starter.stylesFileName !== undefined) {
    writeFileSync(join(pagesDir, starter.stylesFileName), starter.styles)
  }
  const pageId = pageIdFromRelPath(relPath)
  // D5 §11.3 — a scaffolded screen the user cannot see is not a screen.
  // `boardId` is which board the author was LOOKING AT when they asked; absent
  // for a headless caller, which has no board open to mean.
  autoPlaceBoardFrame(dir, pageId, boardId)
  // Node ids are source locations (trap #2) — read the root by parsing the
  // file just written, never constructed from the name/path.
  return { ok: true, relPath, pageId, title: componentName, rootNodeId: scaffoldedPageRootNodeId(dir, file) }
}

/**
 * {@link createScaffoldedPage}, serialized against every other writer of this
 * project — **the entry every production caller uses** (`POST
 * /admin/api/studio/page` and the MCP `studio_create_page` tool). The
 * synchronous function above stays exported for tests, which drive it against
 * a temp directory with nothing else running.
 *
 * Scaffolding writes two files and `.studio/boards.json`; a git verb holding
 * the lock across `add` + `commit` must not see half of that. No `waitMs` —
 * creating a page waits rather than failing, for the same reason a save does.
 * See `projectWriteLock.ts`.
 */
export function scaffoldPageLocked(
  dir: string,
  nameInput: string,
  kind: PageKind = DEFAULT_PAGE_KIND,
  boardId?: string,
): Promise<ScaffoldPageResult> {
  return withProjectWriteLock(dir, () => createScaffoldedPage(dir, nameInput, kind, boardId))
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
