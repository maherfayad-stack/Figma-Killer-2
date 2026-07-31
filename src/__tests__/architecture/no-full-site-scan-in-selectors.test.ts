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
 * is an imperative one-off read, not a subscribed selector) must not ALSO
 * contain a `for (const page of X.pages)` loop anywhere in the same file.
 * File-scoped rather than argument-scoped on purpose — `InPlaceInspector`'s
 * defect was a same-file helper function the selector called, not an inline
 * loop inside the `useEditorStore(...)` call itself, and a helper is exactly
 * as reachable from a render as an inline loop.
 *
 * Scoped to the for-of shape specifically, not "any iteration over `.pages`":
 * a bare `.pages.find(`/`.some(` that resolves ONE page by id is O(pages),
 * the same cost class as resolving a page by id anywhere else in this
 * codebase, and is not the defect — see the `FOR_OF_PAGES_RE` comment below
 * for why a broader method-chain regex was tried and reverted.
 *
 * Fix: read from (or extend) the O(1) indexes maintained on the site slice —
 * `src/admin/pages/site/store/slices/site/nodeIndex.ts`
 * (`_nodeIdToPageIds`, `_textOriginKeyToCount`, `_inlineTailToCount`) —
 * instead of scanning `site.pages`. If the lookup a selector needs isn't one
 * of the three, add a new index there following the same
 * rebuild-at-load / incrementally-maintained-by-mutations pattern, rather
 * than scanning inline.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, relative, extname, sep } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const SCAN_ROOT = join(SRC_ROOT, 'admin')

/**
 * Files that legitimately call `useEditorStore(` AND contain a `pages` walk
 * in the same file for a reason unrelated to a reactive selector (e.g. the
 * walk runs inside an imperative `.getState()`-driven handler, not inside a
 * subscribed selector). Add new entries here ONLY with a justification —
 * this gate exists specifically because "it's probably fine" was wrong three
 * times already.
 */
const FULL_SITE_SCAN_ALLOWLIST = new Set<string>([
  // pkg-02/WS-3.3 — registerProjectModules.ts's `siteHasUnregisteredPackageNode`
  // walks `useEditorStore.getState().site.pages` IMPERATIVELY, once per
  // `useEffect` run keyed on `[projectDir, trust]` (a project load/switch or
  // a trust-tier promotion) — never inside a subscribed `useEditorStore(selector)`
  // callback, so it does not run on every store change. The file does import
  // `useEditorStore` (for `.getState()`), which is what this gate's text
  // match can't distinguish from a reactive selector subscription.
  'admin/pages/site/studio/registerProjectModules.ts',
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
    if (/^\s*\/\//.test(line)) continue
    if (FOR_OF_PAGES_RE.test(line)) hits.push(i + 1)
  }
  return hits
}

describe('Architecture gate — no full-site pages scan reachable from a useEditorStore selector', () => {
  it('no file calling useEditorStore( also walks the full site.pages array', () => {
    const violations: string[] = []

    for (const file of collectSourceFiles(SCAN_ROOT)) {
      let content: string
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!USE_EDITOR_STORE_HOOK_RE.test(content)) continue

      const rel = toPosix(relative(SRC_ROOT, file))
      if (FULL_SITE_SCAN_ALLOWLIST.has(rel)) continue

      const hitLines = findFullSiteScanLines(content)
      for (const lineNum of hitLines) {
        violations.push(`${rel}:${lineNum}`)
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[no-full-site-scan-in-selectors] A file that subscribes to useEditorStore( also ' +
        'contains a `for (const page of X.pages)` loop.\n' +
        'useEditorStore selectors re-run on EVERY store change, so a for-of over every page — ' +
        'especially one nested with a walk of Object.values(page.nodes), O(pages*nodes) — runs ' +
        'on every keystroke. This is the WS-5.2 defect class (three real instances of it ' +
        'shipped: PropertiesPanelBody.sharedTextOriginCount, InPlaceInspector.findNodeById, ' +
        'SharedComponentNotice.instanceCount — all now fixed).\n\n' +
        'Fix: read from the O(1) site-slice index instead of scanning ' +
        '(src/admin/pages/site/store/slices/site/nodeIndex.ts — _nodeIdToPageIds, ' +
        '_textOriginKeyToCount, _inlineTailToCount), or add a new incrementally-maintained ' +
        'index there following the same rebuild-at-load / patched-by-DirtyMarks pattern.\n\n' +
        'If this file genuinely does not need the fix (the walk is imperative, not inside a ' +
        'subscribed selector), add it to FULL_SITE_SCAN_ALLOWLIST in this test file with a ' +
        'justification comment.\n\n' +
        'Violations:\n' + violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})
