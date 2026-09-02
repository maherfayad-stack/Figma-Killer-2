/**
 * pageKinds — the shapes a page can be scaffolded as.
 *
 * A screen is not the only thing a design is made of. A journey is drawn as
 * screens *and* the things presented over them: a dialog asking one question, a
 * short sheet confirming something, a tall sheet holding a whole step. Studio
 * could only ever create the first, so the other three had to be hand-built
 * from an empty starter every time, which meant every author re-derived the
 * scrim, the corner radius and the panel height, and no two came out the same.
 *
 * ## A kind is a creation-time choice, never persisted state
 *
 * Nothing downstream stores or reads it. It selects which starter files get
 * written and what the page is auto-named, and then it is gone — the `.tsx` on
 * disk IS the answer to "what shape is this page", the same way it is the
 * answer to every other question Studio asks about a page. A `kind` recorded in
 * `.studio/meta.json` would be a second source of truth that drifts the moment
 * someone edits the file, which is exactly the failure the "repository is the
 * document" invariant exists to prevent.
 *
 * That is also why there is no per-kind frame SIZE here. An overlay is drawn
 * over the screen presenting it, so its frame is a screen-sized frame: the
 * same size every other page in the project gets from `frameDefaults`
 * (`platformPresets.ts`). A bottom sheet cropped to its own panel loses the one
 * thing that makes it a bottom sheet, which is how much of the screen it leaves showing.
 *
 * Lives here beside `platformPresets.ts` for the reason that file states: the
 * server's scaffold route and the client's "New page" menu both need this
 * vocabulary, and neither layer may import the other's.
 */
import { Type, type Static } from '@sinclair/typebox'

/**
 * Schema-first, so the HTTP route (`projectRoutes.ts`), the MCP tool
 * (`studio_create_page`) and the client all validate against one list instead
 * of three copies of the same four literals that can drift apart.
 */
export const PageKindSchema = Type.Union([
  Type.Literal('screen'),
  Type.Literal('popup'),
  Type.Literal('sheet-small'),
  Type.Literal('sheet-large'),
])

export type PageKind = Static<typeof PageKindSchema>

export interface PageKindPreset {
  kind: PageKind
  /**
   * Menu label, and the whole of what the menu shows. There is deliberately no
   * `description` field: the four kinds are self-evident from their names, and
   * a second muted line under each one made a four-item menu read like a form.
   * The two sheets carry their difference IN the label instead.
   *
   * No em dash, and no other typographic punctuation that a label cannot be
   * typed with. Gated in `__tests__/pageKinds.test.ts`.
   */
  label: string
  /**
   * Base for the auto-generated component name, so an unnamed sheet lands as
   * `Sheet`/`Sheet2` rather than `Page7`. Both sheet kinds share a base on
   * purpose: "small" and "large" is a fact about this drawing, not about what
   * the screen is called, and `nextPageName`'s collision loop already handles
   * two pages wanting the same base.
   */
  nameBase: string
}

export const PAGE_KINDS: readonly PageKindPreset[] = [
  {
    kind: 'screen',
    label: 'Screen',
    nameBase: 'Page',
  },
  {
    kind: 'popup',
    label: 'Popup',
    nameBase: 'Popup',
  },
  {
    kind: 'sheet-small',
    label: 'Bottom sheet (small)',
    nameBase: 'Sheet',
  },
  {
    kind: 'sheet-large',
    label: 'Bottom sheet (large)',
    nameBase: 'Sheet',
  },
] as const

/** The kind a caller that does not choose one gets, which is what "New page" has always meant. */
export const DEFAULT_PAGE_KIND: PageKind = 'screen'

/** The preset for `kind`. Total: `PAGE_KINDS` covers every member of the union. */
export function pageKindPreset(kind: PageKind): PageKindPreset {
  const preset = PAGE_KINDS.find((p) => p.kind === kind)
  // Unreachable for a well-typed caller; the table covers the union.
  if (!preset) throw new Error(`[pageKinds] no preset for kind "${kind}"`)
  return preset
}
