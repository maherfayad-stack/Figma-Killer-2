/**
 * Architecture gate — FrameDocumentAdapter isolation.
 *
 * "The canvas DOM must be the DOM React renders" (`canvas-engineer`'s own
 * rule book) is enforced structurally, not just by review: after `live-05`,
 * a raw `iframe.contentDocument`/`iframe.contentWindow` reach-in is banned
 * everywhere under `src/admin/pages/site/canvas/` except through one of the
 * sanctioned escape hatches — `PortalFrameAdapter`'s own internals, its
 * `getPortalWindow()` accessor, and `frameAdapter/resolvePortalDocument.ts`,
 * the one shared helper every other portal-mode-only caller goes through.
 * Every other injector/hook reads a `FrameDocumentAdapter` from context
 * instead, so a cross-origin Tier 2 frame (`BridgeFrameAdapter`) can drive
 * the exact same call sites a same-origin frame does.
 *
 * This does NOT ban a bare `Document`/`Window`-typed function parameter —
 * only the literal property reads `.contentDocument`/`.contentWindow`. A
 * portal-mode-only Class A function (`ownElementForNode(doc: Document, …)`
 * in `canvasNodeLookup.ts`, `isCanvasSpacePanActive(doc: Document)` in
 * `canvasPanInput.ts`, and many more) legitimately receives an
 * already-resolved `Document`/`Window` from a caller that went through the
 * registry — banning the parameter TYPE, not just the reach-in, would have
 * meant allowlisting most of this directory file-by-file for no real safety
 * gain: none of those functions could reach into an iframe on their own even
 * if they wanted to, they only ever see what their caller already resolved.
 * An earlier version of this gate banned `: Document`/`<Document>` outright;
 * un-skipping it against the ACTUAL shape the `live-05` migration converged
 * on turned up ~15 legitimate Class A files, which is what motivated this
 * narrower, more precise pattern set.
 *
 * Modeled on `live-origin-isolation.test.ts`'s grep-based scan pattern —
 * this is a structural gate proven by source text, not a running-canvas
 * test.
 *
 * `frameAdapter/BridgeFrameAdapter.ts` legitimately uses the word
 * `contentDocument`/`contentWindow` in prose comments (documenting why it
 * does NOT hold one) — the scan below strips comments first so prose never
 * trips it, matching `live-origin-isolation`'s own "blank out comments,
 * check code" technique.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const CANVAS_DIR = join(REPO_ROOT, 'src/admin/pages/site/canvas')

/**
 * Files allowed to hold a raw `.contentDocument`/`.contentWindow` reach-in.
 *
 *   - `PortalFrameAdapter.ts` + its own test file: the portal adapter's
 *     literal implementation.
 *   - `IframeFrameSurface.tsx`: the actual origin point. It reads the
 *     iframe's `srcDoc` document/window to CONSTRUCT the `PortalFrameAdapter`
 *     and the `iframeDoc.body` `createPortal` target in the first place —
 *     every other file's `Document` traces back to this one having already
 *     done the reach-in.
 *   - `iframeFrameObservers.ts`: `useIframeFrameAutoHeight.ts`'s own
 *     portal-mode-only observer wiring needs live `ResizeObserver`/
 *     `MutationObserver` constructors from the FRAME's window specifically
 *     (not the parent's) — richer than a single `Document` reference, so
 *     that hook's portal branch reaches in directly, by design (see its own
 *     doc comment).
 *   - `ModuleSandboxFrame.tsx`: a Tier 1 `pkg.*` component sandbox iframe —
 *     its own `postMessage` bridge protocol, not a `FrameDocumentAdapter`-
 *     governed canvas breakpoint frame. Out of `live-05`'s scope entirely.
 *   - `useBridgeFrameDiagnostics.ts` (Z5): the one file that reaches for a
 *     BRIDGE frame's `contentWindow`, and the only sanctioned reach-in that
 *     is not portal-mode. It is not driving the frame's DOM — a cross-origin
 *     `WindowProxy` exposes nothing to drive — it is using the reference
 *     purely as the `WeakMap` KEY `canvasDiagnosticsBuffer.ts` stores under,
 *     because that is the same key `agent/studioPageDiagnostics.ts` reads
 *     (`iframe.contentWindow`) for a portal frame. Recording under any other
 *     key would make `studio_page_diagnostics` report `no-collector` for
 *     exactly the Tier-2 frames most likely to be broken. Nothing is read
 *     off the window; if it were, a cross-origin SecurityError would say so
 *     immediately.
 *   - `iframeFrameSurfaceContract.ts`: the handle TYPE the file above
 *     returns. `contentDocument`/`contentOverlayRoot` are declarations, not
 *     reach-ins — the fields exist because `IframeFrameSurface` performs the
 *     one sanctioned reach-in and hands the result back. They are migrating
 *     to `adapter` field by field; when the last one goes, so does this
 *     entry.
 *   - Three test files that legitimately assert on the raw DOM a portal-mode
 *     `IframeFrameSurface`/adapter construction actually produced.
 */
const ALLOWLIST = new Set([
  'src/admin/pages/site/canvas/frameAdapter/PortalFrameAdapter.ts',
  'src/__tests__/canvas/frameAdapter/PortalFrameAdapter.test.ts',
  'src/admin/pages/site/canvas/IframeFrameSurface.tsx',
  'src/admin/pages/site/canvas/iframeFrameSurfaceContract.ts',
  'src/admin/pages/site/canvas/iframeFrameObservers.ts',
  'src/admin/pages/site/canvas/ModuleSandboxFrame.tsx',
  'src/admin/pages/site/canvas/useBridgeFrameDiagnostics.ts',
  'src/admin/pages/site/canvas/__tests__/useIframeFrameAutoHeight.test.tsx',
  'src/admin/pages/site/canvas/__tests__/canvasDiagnosticsInjector.test.tsx',
  'src/admin/pages/site/canvas/__tests__/iframeFrameSurfaceDocumentMode.test.tsx',
])

const BANNED_PATTERNS: RegExp[] = [/\bcontentDocument\b/, /\bcontentWindow\b/]

function collectFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.tmp' || entry === 'dist') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      out.push(full)
    }
  }
  return out
}

/** Blanks out `/* *\/` block comments and `//` line comments while preserving line/column positions, so prose mentioning "Document" never trips the scan below — same technique `live-origin-isolation.test.ts` uses for "cookie". */
function stripComments(src: string): string {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
  return blanked.replace(/\/\/.*$/gm, (match) => ' '.repeat(match.length))
}

describe('frame-document-adapter isolation gate', () => {
  const files = collectFiles(CANVAS_DIR)
    // Also scan this gate's own two test files, co-located under
    // `src/__tests__/canvas/frameAdapter/` rather than `canvas/` itself.
    .concat(collectFiles(join(REPO_ROOT, 'src/__tests__/canvas/frameAdapter')))

  it('found at least one file to scan (the scan itself is not silently vacuous)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no stray contentDocument/contentWindow reach-in outside the sanctioned escape hatches', () => {
    const violations: string[] = []
    for (const file of files) {
      const relPath = relative(REPO_ROOT, file).replaceAll('\\', '/')
      if (ALLOWLIST.has(relPath)) continue
      const codeOnly = stripComments(readFileSync(file, 'utf8'))
      const lines = codeOnly.split('\n')
      lines.forEach((line, index) => {
        for (const pattern of BANNED_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`  ${relPath}:${index + 1}: ${line.trim()}`)
            break
          }
        }
      })
    }
    if (violations.length > 0) {
      throw new Error(
        `[frame-document-adapter-isolation] contentDocument/contentWindow usage found outside the allowlist:\n${violations.join('\n')}`,
      )
    }
    expect(violations).toHaveLength(0)
  })
})
