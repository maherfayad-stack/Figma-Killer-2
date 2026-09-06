/**
 * Architecture Gate — No full-site `pages` scan reachable from a
 * `useEditorStore` selector (WS-5.2 / store-01)
 *
 * `useEditorStore` selectors re-run on EVERY store change — Zustand invokes
 * every subscribed selector on every `set()` to decide whether its return
 * value changed. Three real defects shipped this shape: `PropertiesPanelBody`
 * (`sharedTextOriginCount`) and `InPlaceInspector` (`findNodeById`) walked
 * every node of every page inline or via a same-file helper; a third,
 * previously undiagnosed instance (`SharedComponentNotice`'s `instanceCount`)
 * turned up while building this gate and was fixed alongside them. On a
 * 40-page/1000-node board that is 40 000 iterations per keystroke.
 *
 * This gate forbids the PATTERN, not those three fixed instances: any file
 * that calls `useEditorStore(` as a reactive hook (NOT `.getState()`, which
 * is an imperative one-off read, not a subscribed selector) must not contain
 * a `for (const page of X.pages)` loop — **nor import a module that does.**
 * File-scoped rather than argument-scoped on purpose — `InPlaceInspector`'s
 * defect was a same-file helper function the selector called, not an inline
 * loop inside the `useEditorStore(...)` call itself, and a helper is exactly
 * as reachable from a render as an inline loop.
 *
 * ### Why it follows an import hop (store-01b)
 *
 * The same-file rule was necessary and not sufficient. Three more instances
 * of the identical defect shipped one import away from it and the gate saw
 * none of them:
 *
 *   - `panels/selectorUsage.ts`'s `buildSelectorUsageMap(site)` — a walk of
 *     every node of every page, called from `SelectorsPanel.tsx` AND
 *     `usePropertiesPanelData.ts` render bodies. Mutative replaces `site` on
 *     every mutation, so the React Compiler memo keyed on it missed on every
 *     keystroke: ~20 000 node visits and a fresh `Map` per character typed.
 *   - `PropertiesPanel/slotOwners.ts`'s `buildSlotOwners(site)` — the same
 *     walk behind a cache keyed on `site` OBJECT IDENTITY, which is exactly
 *     the same thing: a new identity per mutation means a rebuild per
 *     keystroke. It was reached from `SlotFillNotice`'s
 *     `useEditorStore((s) => lookupSlotOwner(s.site, nodeId))` — a
 *     SUBSCRIBED selector, so it ran on every store change, not merely every
 *     render.
 *
 * A "cache keyed on `site`" is not a fix for this defect class; it is the
 * defect wearing a hat. The only fix is an index maintained incrementally by
 * the mutations themselves (`store/slices/site/nodeIndex.ts`).
 *
 * So the gate now walks ONE import hop out of every `useEditorStore(`-calling
 * file: the file itself and every first-party module it VALUE-imports (type-
 * only imports cannot execute a walk and are skipped) must be free of the
 * pattern. One hop, not transitive: two hops out reaches the store slices
 * themselves, where full-site walks are correct — they run inside imperative
 * mutations, not selectors — and a transitive rule would have to allowlist
 * them all back in, which would gut it.
 *
 * Scoped to the for-of shape specifically, not "any iteration over `.pages`":
 * a bare `.pages.find(`/`.some(` that resolves ONE page by id is O(pages),
 * the same cost class as resolving a page by id anywhere else in this
 * codebase, and is not the defect — see the `FOR_OF_PAGES_RE` comment below
 * for why a broader method-chain regex was tried and reverted.
 *
 * Fix: read from (or extend) the O(1) indexes maintained on the site slice —
 * `src/admin/pages/site/store/slices/site/nodeIndex.ts`
 * (`_nodeIdToPageIds`, `_textOriginKeyToCount`, `_inlineTailToCount`,
 * `_classIdToNodeCount`, `_slotOwnerBindings`) — instead of scanning
 * `site.pages`. If the lookup a selector needs isn't one of the five, add a
 * new index there following the same rebuild-at-load /
 * incrementally-maintained-by-mutations pattern, rather than scanning inline.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, relative, extname, sep } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const SCAN_ROOT = join(SRC_ROOT, 'admin')

/**
 * Files that legitimately contain a `pages` walk despite being reachable from
 * a `useEditorStore(` caller — because the walk is imperative (it runs inside
 * a mutation recipe or a `.getState()`-driven handler), not inside a
 * subscribed selector or a render body. Add new entries here ONLY with a
 * justification — this gate exists specifically because "it's probably fine"
 * was wrong five times already.
 *
 * E4 (`STUDIO-FIGMA-PARITY-PLAN.md`) emptied the original version of this
 * list; the entries below arrived with the import-hop widening (store-01b),
 * which reaches the store slices through `store.ts` (it defines the
 * `useUndo`/`useRedo`/… hooks, so it counts as a `useEditorStore(` caller).
 */
const FULL_SITE_SCAN_ALLOWLIST = new Set<string>([
  // THE index. `rebuildNodeIndexes` is the one sanctioned full-site walk in
  // this codebase: it runs at load and on a `marks.all` patch, and exists
  // precisely so nothing else has to walk. Reached one hop from
  // `PropertiesPanelBody` / `SharedComponentNotice`, which import its
  // `textOriginKey` / `inlineTailKey` key-builders (not the walk).
  'admin/pages/site/store/slices/site/nodeIndex.ts',
  // `deleteVisualComponent`'s cascade: strip every `visual-component-ref` to
  // the deleted VC from every page tree. Inside a `mutateSiteWithExplorerReconcile`
  // recipe — a user-initiated delete, once, not a selector.
  'admin/pages/site/store/slices/visualComponentsSlice.ts',
])

// Windows' `path.relative` emits backslashes; normalize before comparing or
// reporting so the gate behaves identically on every OS — several other
// gates in this repo have shipped Windows-only false failures for exactly
// this reason (STATE.md -> standing-01).
function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...collectSourceFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      out.push(full)
    }
  }
  return out
}

// Matches the literal hook call `useEditorStore(` — NOT `useEditorStore.getState(`,
// which is an imperative snapshot read, not a subscribed selector.
const USE_EDITOR_STORE_HOOK_RE = /useEditorStore\(/

// `for (const page of s.site.pages)` and every spelling of "whose owner" in
// between (`state.site.pages`, `site.pages`, `s.site!.pages`, ...).
//
// Deliberately narrower than "any walk over a `.pages` array": a bare
// `.find(`/`.some(`/`.every(` that resolves ONE page by id is O(pages) —
// the same cost class as resolving a page by id anywhere else in this
// codebase (`resolveActiveTreeTarget`, `selectActivePage`, ...) — and is not
// the defect. A method-chain regex over `.pages.` was tried first and
// flagged 14 such call sites, none of them the O(pages*nodes) shape; it also
// false-positived on unrelated `.pages` properties on non-SiteDocument types
// (e.g. `ImportPlan.pages`). The for-of form is what all three real
// instances of this defect used (see module doc comment), so that is what
// this gate forbids.
const FOR_OF_PAGES_RE = /for\s*\(\s*const\s+\w+\s+of\s+[\w$.!?]*\.pages\s*\)/

function findFullSiteScanLines(content: string): number[] {
  const hits: number[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Skip comments — both `//` and a JSDoc/block continuation line. Several
    // of these modules DOCUMENT the defect they were fixed for by quoting the
    // old loop verbatim (`selectionSlice.ts`'s "used to be an O(pages) `for
    // (const page of state.site.pages)` scan"); flagging the fix's own
    // tombstone would teach the next author to delete the explanation.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    if (FOR_OF_PAGES_RE.test(line)) hits.push(i + 1)
  }
  return hits
}

// ---------------------------------------------------------------------------
// One import hop (store-01b)
// ---------------------------------------------------------------------------

/**
 * VALUE imports only. `import type { … } from '…'` and `import { type X }`
 * cannot execute anything at runtime, so a type-only edge can never make a
 * walk reachable from a selector; following it would only produce noise.
 */
const IMPORT_RE = /^\s*import\s+(?!type\s)([\s\S]*?)from\s+['"]([^'"]+)['"]/gm

/** Path aliases this repo's tsconfig defines, as far as this gate needs them. */
const ALIASES: [string, string][] = [
  ['@site/', 'admin/pages/site/'],
  ['@admin/', 'admin/'],
  ['@modules/', 'modules/'],
  ['@core/', 'core/'],
  ['@ui/', 'ui/'],
]

const RESOLVE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx']

/** Resolve an import specifier to a file under `src/`, or null for a package / unresolvable path. */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string | null = null
  if (specifier.startsWith('.')) {
    base = join(fromFile, '..', specifier)
  } else {
    for (const [alias, target] of ALIASES) {
      if (specifier.startsWith(alias)) {
        base = join(SRC_ROOT, target, specifier.slice(alias.length))
        break
      }
    }
  }
  if (!base) return null // node_modules or an alias this gate doesn't care about
  for (const suffix of ['', ...RESOLVE_SUFFIXES]) {
    const candidate = base + suffix
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every first-party file `content` value-imports, resolved to disk. */
function valueImportsOf(file: string, content: string): string[] {
  const out: string[] = []
  for (const match of content.matchAll(IMPORT_RE)) {
    const clause = match[1] ?? ''
    const specifier = match[2]!
    // `import { type A, type B } from …` is type-only in substance.
    const named = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'))
    if (clause.includes('{') && named.trim() && named.split(',').every((n) => /^\s*type\s/.test(n))) {
      continue
    }
    const resolved = resolveImport(file, specifier)
    if (resolved) out.push(resolved)
  }
  return out
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

describe('Architecture gate — no full-site pages scan reachable from a useEditorStore selector', () => {
  it('no file calling useEditorStore( walks the full site.pages array, directly or one import away', () => {
    const violations: string[] = []
    const reported = new Set<string>()

    /** Record every walk in `file`, attributing it to the selector file that can reach it. */
    const check = (file: string, content: string, reachedFrom: string | null) => {
      const rel = toPosix(relative(SRC_ROOT, file))
      if (FULL_SITE_SCAN_ALLOWLIST.has(rel)) return
      for (const lineNum of findFullSiteScanLines(content)) {
        const via = reachedFrom ? ` (imported by ${reachedFrom})` : ''
        const entry = `${rel}:${lineNum}${via}`
        if (reported.has(entry)) continue
        reported.add(entry)
        violations.push(entry)
      }
    }

    for (const file of collectSourceFiles(SCAN_ROOT)) {
      const content = readOrNull(file)
      if (content === null) continue
      if (!USE_EDITOR_STORE_HOOK_RE.test(content)) continue

      check(file, content, null)

      // …and one import hop out. See this module's doc comment for why one.
      const rel = toPosix(relative(SRC_ROOT, file))
      for (const imported of valueImportsOf(file, content)) {
        const importedContent = readOrNull(imported)
        if (importedContent === null) continue
        check(imported, importedContent, rel)
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[no-full-site-scan-in-selectors] A file that subscribes to useEditorStore( contains — ' +
        'or imports a module that contains — a `for (const page of X.pages)` loop.\n' +
        'useEditorStore selectors re-run on EVERY store change, so a for-of over every page — ' +
        'especially one nested with a walk of Object.values(page.nodes), O(pages*nodes) — runs ' +
        'on every keystroke. This is the WS-5.2 defect class (five real instances of it ' +
        'shipped: PropertiesPanelBody.sharedTextOriginCount, InPlaceInspector.findNodeById, ' +
        'SharedComponentNotice.instanceCount, selectorUsage.buildSelectorUsageMap and ' +
        'slotOwners.buildSlotOwners — all now fixed). The last two lived one import hop away ' +
        'from a selector, which is why this gate follows that hop.\n\n' +
        'Fix: read from the O(1) site-slice index instead of scanning ' +
        '(src/admin/pages/site/store/slices/site/nodeIndex.ts — _nodeIdToPageIds, ' +
        '_textOriginKeyToCount, _inlineTailToCount, _classIdToNodeCount, _slotOwnerBindings), ' +
        'or add a new incrementally-maintained index there following the same ' +
        'rebuild-at-load / patched-by-DirtyMarks pattern.\n\n' +
        'A cache keyed on `site` object identity is NOT a fix: Mutative mints a new `site` ' +
        'reference on every mutation, so such a cache rebuilds on every keystroke.\n\n' +
        'If this file genuinely does not need the fix (the walk is imperative, not inside a ' +
        'subscribed selector), add it to FULL_SITE_SCAN_ALLOWLIST in this test file with a ' +
        'justification comment.\n\n' +
        'Violations:\n' + violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('follows the exact import edge the defect hid behind, and detects the walk it hid', () => {
    // Without this, the widening is untested machinery: the rule above passes
    // trivially if `valueImportsOf` silently resolves nothing.
    const notice = join(SCAN_ROOT, 'pages/site/panels/PropertiesPanel/SlotFillNotice.tsx')
    const slotOwners = join(SCAN_ROOT, 'pages/site/panels/PropertiesPanel/slotOwners.ts')
    const content = readFileSync(notice, 'utf8')

    expect(USE_EDITOR_STORE_HOOK_RE.test(content)).toBe(true)
    expect(valueImportsOf(notice, content)).toContain(slotOwners)

    // And the detector still recognises the shape that used to live there.
    expect(findFullSiteScanLines('  for (const page of site.pages) {')).toEqual([1])
    expect(findFullSiteScanLines('  for (const page of state.site!.pages) {')).toEqual([1])
    // A quoted tombstone in a doc comment is not a violation.
    expect(findFullSiteScanLines(' * was `for (const page of site.pages)` before')).toEqual([])
  })
})
