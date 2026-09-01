/**
 * No canvas overlay may swallow `pointerdown` with `stopPropagation`.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * `CanvasRoot` binds `@use-gesture`'s drag (for the middle-button and
 * space+primary pan) with `filterTaps: true`. That option makes use-gesture
 * suppress the `click` that follows anything it classified as a drag — it
 * calls `stopPropagation()` on the click during React's dispatch, at the React
 * ROOT container.
 *
 * An overlay that calls `event.stopPropagation()` in `onPointerDown` therefore
 * does something much worse than it intends: use-gesture never sees the press,
 * so its tap state stays stale from the last real drag, and it then suppresses
 * EVERY subsequent click inside the canvas. The comment popover shipped with
 * exactly this, and the result was that Reply, Resolve, Cancel, Delete and the
 * kebab were all completely dead to a real mouse — while still working for a
 * synthetic `element.click()`, which is why unit tests and a naive browser
 * check both passed.
 *
 * The swallow was never needed: `CanvasRoot`'s `handleCanvasClick` already
 * ignores any target that is not the canvas root or the transform layer, and
 * `useMarqueeSelection`'s pointerdown already ignores any target but the
 * canvas root. Guard by target, not by stopping propagation.
 *
 * Stopping `click` is fine and NOT flagged: by then use-gesture has already
 * seen the full press/release pair, so its tap state is correct.
 */
import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const CANVAS_ROOT = join(import.meta.dir, '../../admin/pages/site/canvas')

/**
 * THREE SPELLINGS, BECAUSE THIS GATE HAS BEEN BLIND TWICE
 * ──────────────────────────────────────────────────────
 * `onPointerDown={(e) => e.stopPropagation()}`, the block-bodied form
 * `onPointerDown={(e) => { /* … *\/ e.stopPropagation() }}`, and the named form
 * `onPointerDown={handlePress}`.
 *
 * The first version matched only the concise body — and the very bug it was
 * written for was still live in `CommentPin`, whose handler had a block body
 * with an explanatory comment in it. The second version still could not see a
 * handler hoisted into a named function, which is what `CommentPin`'s drag
 * gesture needed it to be. Each time, the gate reported green over exactly the
 * code it exists to watch. A gate that matches one spelling of a hazard is
 * worse than no gate.
 *
 * So: find the handler however it is spelled, resolve a named one to its
 * declaration in the same file, and look for the call anywhere in that body.
 */
const POINTERDOWN_INLINE = /onPointerDown=\{\s*\(?\s*(\w+)[^)]*\)?\s*=>\s*(\{[\s\S]*?\n\s*\}|[^\n]*)\}/g
const POINTERDOWN_NAMED = /onPointerDown=\{\s*(\w+)\s*\}/g

/** The `{ … }` block starting at or after `from`, brace-matched. */
function blockAt(source: string, from: number): string | null {
  const open = source.indexOf('{', from)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

/**
 * The body and first parameter name of `const <name> = (<param>…) => {…}` or
 * `function <name>(<param>…) {…}`, declared anywhere in the same file.
 */
function namedHandler(source: string, name: string): { param: string; body: string } | null {
  const decl = new RegExp(
    `(?:const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(|function\\s+${name}\\s*\\()\\s*(\\w+)`,
  ).exec(source)
  if (!decl) return null
  const body = blockAt(source, decl.index + decl[0].length)
  return body ? { param: decl[1] ?? '', body } : null
}

function swallowsPointerDown(source: string): boolean {
  for (const match of source.matchAll(POINTERDOWN_INLINE)) {
    const [, param, body] = match
    if (body?.includes(`${param}.stopPropagation()`)) return true
  }
  for (const match of source.matchAll(POINTERDOWN_NAMED)) {
    const handler = namedHandler(source, match[1] ?? '')
    if (handler?.param && handler.body.includes(`${handler.param}.stopPropagation()`)) return true
  }
  return false
}

/**
 * PRE-EXISTING, NOT ENDORSED.
 *
 * Each of these swallows `pointerdown` on a single focusable control (a
 * frame's inline rename input, a ladder row, a doc block's editable surface)
 * rather than on a container full of buttons, which is why none of them is as
 * visibly broken as the comment popover was — the thing you click IS the thing
 * that stopped the event, and its own handler still runs.
 *
 * They are still latent instances of the same hazard: after clicking into one
 * of these, use-gesture's tap state is stale, so the NEXT click anywhere in
 * the canvas can be suppressed. Fixing them means guarding the canvas gestures
 * by target instead, which is a change to the shared pan/drag plumbing and
 * wants its own pass — see STATE.md `comment-01`.
 *
 * Do not add to this list to make a new failure go away. Guard by target.
 */
const ALLOWLIST = new Set<string>([
  'BoardFramesLayer/BoardFrameView.tsx',
  'CanvasTreeLadderRowButton.tsx',
  'BoardDocsLayer/DocBlockView.tsx',
])

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full))
    else if (extname(entry) === '.tsx') out.push(full)
  }
  return out
}

describe('the detector itself', () => {
  // Twice now, this gate has passed while the hazard was live in the tree.
  // These fixtures are the cheapest way to keep the third spelling honest.
  it('catches every spelling of the swallow', () => {
    expect(swallowsPointerDown('onPointerDown={(e) => e.stopPropagation()}')).toBe(true)
    expect(
      swallowsPointerDown('onPointerDown={(event) => {\n  // why\n  event.stopPropagation()\n}}'),
    ).toBe(true)
    expect(
      swallowsPointerDown(
        'const press = (event: ReactPointerEvent) => {\n  event.stopPropagation()\n}\nonPointerDown={press}',
      ),
    ).toBe(true)
    expect(
      swallowsPointerDown(
        'function press(event) {\n  event.stopPropagation()\n}\nonPointerDown={press}',
      ),
    ).toBe(true)
  })

  it('does not flag a handler that only stops the click', () => {
    expect(
      swallowsPointerDown(
        'const press = (event) => {\n  setDragging(true)\n}\nonPointerDown={press}',
      ),
    ).toBe(false)
    expect(swallowsPointerDown('onClick={(e) => e.stopPropagation()}')).toBe(false)
  })
})

describe('canvas overlays do not swallow pointerdown', () => {
  it('no overlay stops pointerdown propagation', () => {
    const offenders = tsxFiles(CANVAS_ROOT)
      .filter((file) => ![...ALLOWLIST].some((allowed) => file.endsWith(allowed)))
      .filter((file) => swallowsPointerDown(readFileSync(file, 'utf8')))
      .map((file) => file.slice(file.indexOf('src/')))

    expect(offenders).toEqual([])
  })
})
