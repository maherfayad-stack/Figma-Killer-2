/**
 * localizedPageWriteback — WS-10 §4.4 (Phase 4)'s save path: the client half
 * of persisting a locale-variant TEXT edit. Extracted as its own module for
 * the same reason `styleRuleWriteback.ts` is (`debt-01`'s "one module per
 * edit kind" plan, keeping `fsCodemodAdapter.ts` the dispatcher its name
 * promises) — and because the baseline shape here cannot be folded into
 * `fsCodemodAdapter.ts`'s own `loadedValues`.
 *
 * **Why a separate baseline map, keyed `(pageId, locale, nodeId)`.** A
 * locale-variant node SHARES its id with the default tree's node — trap #2,
 * both are parses of the same source file, and node ids are AST positions,
 * never a function of the resolved value (`parsePageFile.ts`). `loadedValues`
 * is keyed by bare `nodeId`. Folding a locale-variant node's baseline into
 * that SAME map would mean whichever tree's snapshot ran last (load order is
 * not deterministic — locale-variant pages fetch lazily, well after the
 * initial `loadSite`) silently wins as "the" baseline for BOTH trees, so an
 * edit in one locale could be diffed against the OTHER locale's original
 * text — either missing a real change (false negative: the `ar` text
 * differs from `en`'s baseline by definition, so "no diff" would be wrong)
 * or, worse, treating an untouched node as changed and writing it. Keying
 * this module's own baseline `${pageId}::${locale}::${nodeId}` (built on
 * `localizedPageSlice.ts`'s own `localizedPageKey`) makes that collision
 * structurally impossible: the `en` frame's baseline and the `ar` frame's
 * baseline are two different map entries, full stop — proven in
 * `localizedPageWriteback.test.ts` by editing the SAME node id in both and
 * asserting two edits, each aimed at a different `textOrigin`.
 *
 * **Deliberately TEXT-ONLY**, matching `inlineEditSlice.ts`'s own scope
 * boundary — `updateLocalizedNodeText` is the ONLY mutation a locale-variant
 * node ever receives (Properties-panel prop/style edits resolve through the
 * default tree instead, a documented decision, not an oversight — see
 * `STATE.md`'s `canvas-10`/`canvas-11`). If that boundary ever moves, extend
 * THIS module, not `fsCodemodAdapter.ts`'s main loop — the same "one module
 * per edit kind" reasoning `styleRuleWriteback.ts` states for itself.
 *
 * **Baseline discipline, in two halves because a fetch and a save are not
 * the same event here** (unlike `styleRuleWriteback.ts`, where every rule
 * arrives in the one `loadSite` call):
 *
 *   1. `watchLocalizedPagesForBaseline()` — called once from
 *      `fsCodemodAdapter.ts`'s `loadSite()` (idempotent: safe to call again
 *      on a project reload). Subscribes to `useEditorStore`'s
 *      `localizedPages` and seeds a baseline entry the INSTANT a
 *      `(pageId, locale)` key is first observed — i.e. the moment
 *      `ensureLocalizedPage`'s fetch resolves, before a user could possibly
 *      have edited it (the canvas cannot render a node to double-click
 *      until the fetch that supplies it has already landed in the store).
 *      Deliberately does NOT re-seed a key it has already seen — an EDIT
 *      also changes `localizedPages` (same field), and re-seeding on every
 *      edit would erase the very diff this baseline exists to detect.
 *   2. `commitLocalizedTextBaseline()` — called from `saveSite()`
 *      AFTER `collectLocalizedTextEdits()`'s edits (if any) have been sent.
 *      Safe to advance EVERY tracked key in bulk at this point (unlike
 *      seeding, which must be per-key and fetch-triggered): every page's
 *      current text has just been diffed and, if it changed, written.
 *
 * The store slice (`localizedPageSlice.ts`) never imports this module —
 * this module WATCHES the store, the store never reaches into the
 * persistence layer, matching `boardSlice.ts`'s own "the store never calls
 * the endpoint itself" precedent.
 *
 * **`undo()` does not apply here, on purpose.** A locale-variant session
 * (`inlineEditSlice.ts`) mutates `localizedPageSlice.ts`'s tree directly and
 * never calls `updateNodeProps`/`mutateActiveTree`, so Mutative's
 * patch-based history never sees these edits — `Cmd+Z` cannot revert a
 * locale-variant text edit (matching `boardSlice.ts`'s own "frame drags
 * aren't in the undo stack either" precedent). `cancelInlineEdit` reverts an
 * in-progress session by re-setting the frozen `initialValue` directly, not
 * via `undo()`. This is a real, user-visible limitation stated here rather
 * than half-wired: do not add `Cmd+Z` support for this path without also
 * building a second, locale-scoped history mechanism — bolting it onto the
 * existing one would try to reference `site.pages` patches that were never
 * produced for this edit.
 */
import { registry } from '@core/module-engine'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'

/** One `kind: 'literal'` edit — identical shape to the default tree's `textOrigin`-backed edit in `fsCodemodAdapter.ts`'s `saveSite`; the server-side codemod (`applyStudioEdit`) is origin-agnostic, so no server change was needed for this write path. */
export interface LocalizedLiteralEditPayload {
  kind: 'literal'
  nodeId: string
  text: string
}

/** `${pageId}::${locale}::${nodeId}` -> the text value as last synced (seed OR commit, whichever most recently observed it). */
let baseline = new Map<string, string>()

/** `${pageId}::${locale}` keys `watchLocalizedPagesForBaseline` has already seeded once — never re-seeded (see this module's "Baseline discipline"). */
let seededKeys = new Set<string>()

let watching = false

function nodeBaselineKey(localizedKey: string, nodeId: string): string {
  return `${localizedKey}::${nodeId}`
}

/** This page's text-bearing, `textOrigin`-backed nodes: `nodeId -> current text value`. Shared by seed/diff/commit so all three agree on exactly which nodes participate. */
function textValuesOf(page: Page): Map<string, string> {
  const values = new Map<string, string>()
  for (const node of Object.values(page.nodes)) {
    const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop
    if (textProp === undefined || !node.textOrigin) continue
    const value = node.props?.[textProp]
    if (typeof value === 'string') values.set(node.id, value)
  }
  return values
}

/**
 * Idempotent — call as often as convenient (`loadSite()` can run more than
 * once per session, on a project reload); only the FIRST call subscribes.
 * See this module's "Baseline discipline" for exactly when a key gets
 * seeded and why re-edits of an already-seeded key are correctly ignored
 * here.
 */
export function watchLocalizedPagesForBaseline(): void {
  if (watching) return
  watching = true
  useEditorStore.subscribe(
    (s) => s.localizedPages,
    (localizedPages) => {
      for (const [key, page] of Object.entries(localizedPages)) {
        if (seededKeys.has(key)) continue
        seededKeys.add(key)
        for (const [nodeId, value] of textValuesOf(page)) {
          baseline.set(nodeBaselineKey(key, nodeId), value)
        }
      }
    },
  )
}

/**
 * Diffs every currently-fetched locale-variant page's text-bearing nodes
 * against the baseline, emitting one `kind: 'literal'` edit per changed
 * node, aimed at THAT node's own `textOrigin` — which is what makes an `ar`
 * frame's edit land in `translations.js`'s `ar` branch and an `en` frame's
 * land in `en`'s, even when both edits touch the SAME node id in one save
 * (two different `textOrigin` locations -> two different `edits[].nodeId`
 * strings -> two independent writes, neither colliding with the other).
 *
 * A node absent from the baseline (its key was somehow never seeded — a bug
 * in `watchLocalizedPagesForBaseline`'s wiring, not an expected state) is
 * skipped rather than treated as "changed from nothing": silently writing
 * an already-correct value is harmless but would hide the real problem.
 */
export function collectLocalizedTextEdits(localizedPages: Record<string, Page>): LocalizedLiteralEditPayload[] {
  const edits: LocalizedLiteralEditPayload[] = []
  for (const [localizedKey, page] of Object.entries(localizedPages)) {
    for (const [nodeId, value] of textValuesOf(page)) {
      const before = baseline.get(nodeBaselineKey(localizedKey, nodeId))
      if (before === undefined || Object.is(before, value)) continue
      const node = page.nodes[nodeId]!
      const { rel, line, col } = node.textOrigin!
      edits.push({ kind: 'literal', nodeId: `${rel}:${line}:${col}`, text: value })
    }
  }
  return edits
}

/** Advance the baseline to the CURRENT text of every fetched locale-variant page — call strictly AFTER `collectLocalizedTextEdits` has run and its edits (if any) have been sent, so nothing pending is silently accepted as "unchanged." Mirrors `styleRuleWriteback.ts`'s `commitBaseline`. */
export function commitLocalizedTextBaseline(localizedPages: Record<string, Page>): void {
  const next = new Map<string, string>()
  for (const [localizedKey, page] of Object.entries(localizedPages)) {
    for (const [nodeId, value] of textValuesOf(page)) {
      next.set(nodeBaselineKey(localizedKey, nodeId), value)
    }
  }
  baseline = next
}

/**
 * Clears the baseline AND the seeded-keys set. Called from `fsCodemodAdapter.ts`'s
 * `loadSite()` on every fresh project load (paired with
 * `localizedPageSlice.ts`'s own `resetLocalizedPages()` store action) so a
 * STALE `(pageId, locale, nodeId)` baseline from a previous project can
 * never silently suppress a real edit's diff in a new one — `pageId` is
 * only unique within one project. Also the test-only reset between cases.
 */
export function resetLocalizedTextBaseline(): void {
  baseline = new Map()
  seededKeys = new Set()
}
