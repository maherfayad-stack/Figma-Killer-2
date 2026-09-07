/**
 * studioLoadContract — the SHAPE of a Studio page load: what
 * `loadStudioPages` (`../studioPageLoad.ts`) returns and the one option it
 * takes.
 *
 * A leaf on purpose. These two types are the contract between the load
 * pipeline and everything that consumes a load — the HTTP envelope
 * (`studioLoadResponse.ts`) and W9-5's whole-result memo
 * (`studioLoadMemo.ts`). Keeping them here rather than in the pipeline itself
 * is what lets the memo sit IN FRONT of `loadStudioPages` without the two
 * modules importing each other (gated by `no-circular-dependencies.test.ts`).
 */
import type { ComponentSource } from '@core/page-parser'
import type { ConditionDef, Page, StyleRule } from '@core/page-tree'
import type { StyleRuleSource } from '../studioCss'
import type { StorySummary } from './storyDiscovery'
import type { StyledStyleRuleSource } from './styledStyleRuleSources'

/** Result of the load pipeline: every parsed page, the merged component classification (keyed by node id), and the merged imported-CSS registry. */
export interface StudioLoadResult {
  pages: Page[]
  componentSources: Record<string, ComponentSource>
  /**
   * §6 — imported `.css` parsed into style rules, keyed by rule id. Edits in
   * the CSS Classes panel apply to this in-memory registry immediately;
   * whether they ALSO reach disk depends on `styleRuleSources` below —
   * `panel-02` wires the write-back for rules with a mapped source.
   */
  styleRules: Record<string, StyleRule>
  /**
   * `panel-02` (WS-6.3) — `StyleRule.id -> (file, selector)` for every rule
   * parsed from a real, hand-authored `.css` file. Absent for a rule
   * contributed by `extraCss` (Tailwind/Sass/PostCSS output, rewritten CSS
   * Modules) or a non-`.css` stylesheet — see `studioCss.ts`'s "Write-back
   * mapping" doc for why those stay unmapped on purpose. The client diffs
   * `site.styleRules` against this to decide which class edits can become a
   * `kind: 'css'` `StudioEdit`.
   */
  styleRuleSources: Record<string, StyleRuleSource>
  /**
   * W4-4 Phase B — the CSS-in-JS counterpart of `styleRuleSources`:
   * `StyleRule.id -> the styled-component template it was flattened out of`
   * (`.tsx` file + the `styled.…` tag's `line:col` + the synthetic class).
   * A styled rule reaches the registry through `extraCss` and so has no
   * `styleRuleSources` entry by construction — this is what lets a VALUE edit
   * on one still land in the user's own template instead of being refused as
   * unmapped. Two separate maps on purpose: see
   * `studio/styledStyleRuleSources.ts`'s "Why a separate map".
   */
  styledStyleRuleSources: Record<string, StyledStyleRuleSource>
  /** §6 — reusable `@media`/`@container`/`@supports` conditions the rules reference. */
  conditions: ConditionDef[]
  /**
   * WS-2.3 — `styleCompile.ts`'s `CompiledStyles.vendorCss`: raw CSS read
   * from package `.css` files reached via a bare-specifier import. NEVER
   * parsed into `styleRules`/`classIds` above — the client injects it as its
   * own read-only, below-`user-authored` cascade-layer bucket
   * (`ProjectCssInjector`).
   */
  vendorCss: string
  /**
   * `board-27` — `studioCss.ts`'s `StudioStyles.authoredCss`: every
   * stylesheet this load read, concatenated RAW (extraCss, then each page's
   * own `.css`, in cascade order). The client injects this verbatim
   * (`AuthoredCssInjector`) so the canvas renders exactly what the project's
   * own CSS says, including declarations happy-dom's CSSOM parser silently
   * drops when building `styleRules` above (`color-mix()`,
   * `Canvas`/`CanvasText` system colours, slash-alpha `rgb()`) — see
   * `studioCss.ts`'s "CSSOM in Bun" doc.
   */
  authoredCss: string
  /**
   * W5-3 — one entry per accepted Storybook story that became a page above,
   * in the order they were discovered. Empty for a project with no
   * `*.stories.*` files, which is the zero-cost path. The `/load` route hands
   * this to `boardFrames.ts`'s `syncStoryBoardFrames` so the stories get a
   * board of their own; nothing else reads it, and it is deliberately NOT
   * part of the HTTP load envelope (the client's page list already carries
   * every story as an ordinary page).
   */
  stories: StorySummary[]
}

/** `loadStudioPages` options — today only the targeted-reload page filter. */
export interface StudioLoadOptions {
  /**
   * Track C5 (reload surgery) — return ONLY these page ids, and skip the
   * per-page CONVERT work for every other route. `undefined` (every existing
   * caller) is a full load, unchanged. See `loadStudioPages`'s own doc for
   * exactly which stages this narrows and which stay project-wide.
   */
  pageIds?: readonly string[]
}
