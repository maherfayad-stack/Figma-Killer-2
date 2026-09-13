/**
 * hmrState — carries a live frame's ephemeral DOM state across a Vite Fast
 * Refresh, keyed by the `data-node-id` the Vite plugin (L3) stamps on every
 * JSX element at the same source location the parser mints an id for.
 *
 * ## Why this has to exist at all
 *
 * Style-only edits never remount (CSS module HMR is a stylesheet swap), and
 * component edits keep hook state through Fast Refresh — but Fast Refresh
 * itself unmounts and remounts whatever DOM the changed component renders,
 * which throws away everything the DOM element itself was holding: an
 * uncontrolled `<input>`'s typed value, a checkbox's checked state, a scroll
 * container's `scrollTop`, which element had focus, an open `<dialog>`. None
 * of that is React state — it lives on the node — so Fast Refresh's own
 * state-preservation guarantee does not cover it.
 *
 * `snapshotFrameState` runs on Vite's `vite:beforeUpdate`; `restoreFrameState`
 * runs on `vite:afterUpdate`, once the new DOM exists.
 *
 * ## What still resets, on purpose
 *
 * State a component derives from a fetch or a timer (anything not sitting on
 * the DOM node itself) is NOT this module's problem — Fast Refresh's own hook
 * state preservation covers `useState`/`useReducer`, and this module only
 * ever reaches for what the DOM element is holding directly. Documented, not
 * hidden (STUDIO-LIVE-CANVAS-PLAN.md § L4).
 *
 * ## Keyed by `(nodeId, siblingIndex)`, not bare `nodeId`
 *
 * A `.map()` loop compiles to ONE JSX call site executed N times, so every
 * row's DOM element carries the SAME `data-node-id` (`sourceNodeId.ts`'s
 * `#n` suffix only exists in the PARSED STATIC tree — the live DOM the Vite
 * plugin stamps has no per-iteration information to mint it with). Snapshotting
 * "by node id" alone would collide every row's state into one slot. This
 * module disambiguates by POSITION: the Nth element in document order that
 * carries a given node id gets key `${nodeId}#${N}`. If an edit changes how
 * many rows exist, the surplus/deficit entries are silently dropped/left
 * unmatched — honest degradation, not a crash, matching L3's own
 * `liveNodeResolve.ts` posture on the same ambiguity.
 */

interface StoredValue {
  kind: 'value'
  value: string
}

interface StoredChecked {
  kind: 'checked'
  checked: boolean
}

export interface FrameStateSnapshot {
  /** `input`/`textarea`/`select` state, keyed by `${nodeId}#${siblingIndex}`. */
  controls: Record<string, StoredValue | StoredChecked>
  /** Non-zero scroll offsets, keyed the same way. */
  scroll: Record<string, { top: number; left: number }>
  /** Keys of every `[open]` element (`<dialog open>`, `<details open>`) that carries a node id. */
  openElements: string[]
  /** The key of the focused element, or `null` if nothing (or nothing with a node id) was focused. */
  focused: string | null
}

const EMPTY_SNAPSHOT: FrameStateSnapshot = {
  controls: {},
  scroll: {},
  openElements: [],
  focused: null,
}

const NODE_ID_ATTR = 'data-node-id'

/**
 * The key for `el`: its nearest node-id-carrying ancestor (inclusive), plus
 * that ancestor's position among every element sharing the exact same node
 * id, in document order. `null` when no ancestor carries a node id at all —
 * such an element has no addressable identity across a remount and is
 * skipped by every caller.
 */
function keyFor(el: Element, doc: Document): string | null {
  const anchor = el.closest(`[${NODE_ID_ATTR}]`)
  if (!anchor) return null
  const nodeId = anchor.getAttribute(NODE_ID_ATTR)
  if (!nodeId) return null
  const siblings = doc.querySelectorAll(`[${NODE_ID_ATTR}]`)
  let index = 0
  for (const sibling of siblings) {
    if (sibling.getAttribute(NODE_ID_ATTR) !== nodeId) continue
    if (sibling === anchor) break
    index += 1
  }
  return `${nodeId}#${index}`
}

function isCheckable(el: HTMLInputElement): boolean {
  return el.type === 'checkbox' || el.type === 'radio'
}

/**
 * Snapshots every input/textarea/select value + checked state, every
 * non-zero scroll offset, every open `[open]` element, and the currently
 * focused element — all keyed by {@link keyFor}. Pure with respect to `doc`
 * (read-only).
 */
export function snapshotFrameState(doc: Document): FrameStateSnapshot {
  const controls: FrameStateSnapshot['controls'] = {}
  for (const el of doc.querySelectorAll('input, textarea, select')) {
    const key = keyFor(el, doc)
    if (key === null) continue
    if (el instanceof HTMLInputElement && isCheckable(el)) {
      controls[key] = { kind: 'checked', checked: el.checked }
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      controls[key] = { kind: 'value', value: el.value }
    }
  }

  const scroll: FrameStateSnapshot['scroll'] = {}
  for (const el of doc.querySelectorAll(`[${NODE_ID_ATTR}]`)) {
    if (el.scrollTop === 0 && el.scrollLeft === 0) continue
    const key = keyFor(el, doc)
    if (key === null) continue
    scroll[key] = { top: el.scrollTop, left: el.scrollLeft }
  }

  const openElements: string[] = []
  for (const el of doc.querySelectorAll(`[${NODE_ID_ATTR}][open]`)) {
    const key = keyFor(el, doc)
    if (key !== null) openElements.push(key)
  }

  const active = doc.activeElement
  const focused = active && active !== doc.body ? keyFor(active, doc) : null

  return { controls, scroll, openElements, focused }
}

/** The empty snapshot — used before the first `vite:beforeUpdate` has ever fired. */
export function emptyFrameStateSnapshot(): FrameStateSnapshot {
  return EMPTY_SNAPSHOT
}

/**
 * Finds the element `key` (`${nodeId}#${siblingIndex}`) addresses in the
 * POST-update `doc`, or `null` if that many same-id siblings no longer exist
 * (the edit removed that row/element — nothing to restore onto).
 */
function resolveKey(doc: Document, key: string): Element | null {
  const hashIndex = key.lastIndexOf('#')
  if (hashIndex < 0) return null
  const nodeId = key.slice(0, hashIndex)
  const index = Number.parseInt(key.slice(hashIndex + 1), 10)
  if (!Number.isFinite(index) || index < 0) return null
  let seen = 0
  for (const el of doc.querySelectorAll(`[${NODE_ID_ATTR}]`)) {
    if (el.getAttribute(NODE_ID_ATTR) !== nodeId) continue
    if (seen === index) return el
    seen += 1
  }
  return null
}

/**
 * Restores everything `snapshotFrameState` captured, against the DOM that
 * exists after Fast Refresh has finished. Every lookup degrades silently to
 * "skip this entry" when the element it addressed no longer exists — a
 * structural edit that removed a row is not a bug this module reports on.
 */
export function restoreFrameState(doc: Document, snapshot: FrameStateSnapshot): void {
  for (const [key, state] of Object.entries(snapshot.controls)) {
    const el = resolveKey(doc, key)
    if (!el) continue
    if (state.kind === 'checked' && el instanceof HTMLInputElement) {
      el.checked = state.checked
    } else if (
      state.kind === 'value' &&
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
    ) {
      el.value = state.value
    }
  }

  for (const [key, offset] of Object.entries(snapshot.scroll)) {
    const el = resolveKey(doc, key)
    if (!el) continue
    el.scrollTop = offset.top
    el.scrollLeft = offset.left
  }

  for (const key of snapshot.openElements) {
    const el = resolveKey(doc, key)
    if (el && !el.hasAttribute('open')) el.setAttribute('open', '')
  }

  if (snapshot.focused) {
    const el = resolveKey(doc, snapshot.focused)
    if (el instanceof HTMLElement) el.focus()
  }
}

/**
 * Minimal shape of Vite's client HMR hot-context — just the two hooks this
 * module needs, so `runtime.ts` can pass `import.meta.hot` without this file
 * importing `vite/client`'s ambient types (which would make `hmrState.ts`
 * fail to type-check anywhere outside a Vite-processed entry).
 */
export interface ViteHotContext {
  on(event: 'vite:beforeUpdate', cb: () => void): void
  on(event: 'vite:afterUpdate', cb: () => void): void
}

/**
 * Wires snapshot/restore to Vite's own update lifecycle. Untestable outside
 * a real Vite dev server + browser (there is no `import.meta.hot` to fake
 * meaningfully in happy-dom) — `snapshotFrameState`/`restoreFrameState`
 * above carry the actual test coverage; this function is intentionally a
 * thin, inspectable wire-up with no logic of its own to get wrong.
 */
export function wireHmrStateAcrossUpdates(
  doc: Document,
  hot: ViteHotContext,
  onBeforeUpdate?: () => void,
  onAfterUpdate?: () => void,
): void {
  let pending: FrameStateSnapshot = EMPTY_SNAPSHOT
  hot.on('vite:beforeUpdate', () => {
    pending = snapshotFrameState(doc)
    onBeforeUpdate?.()
  })
  hot.on('vite:afterUpdate', () => {
    restoreFrameState(doc, pending)
    pending = EMPTY_SNAPSHOT
    onAfterUpdate?.()
  })
}
