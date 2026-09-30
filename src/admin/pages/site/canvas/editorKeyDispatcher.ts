/**
 * editorKeyDispatcher — the scope registry behind the editor's ONE keydown
 * listener (`useEditorKeyDispatcher`, mounted once in `SitePage`).
 *
 * ## The problem this replaces
 *
 * Before `K1` the editor workspace owned 21 independent `keydown` listeners.
 * Nine of them were persistent parent-`document` shortcut listeners — the
 * selection ladder, the annotation keys, the frame nudge, select-all, the tool
 * letters, copy-as-PNG, the prototype-link keys, undo/redo, and a second Delete
 * listener in `CanvasRoot` that existed only because the first one (a React
 * `onKeyDown` on the canvas div) stopped firing the moment focus left the
 * canvas. Each re-implemented the same four guards, and which one won a shared
 * keystroke was decided by **mount order** — an implementation detail that
 * changed whenever a hook moved in `CanvasRoot`, and that three separate
 * docblocks had to describe in prose ("mounted AFTER the annotation hook on
 * purpose", "listens in CAPTURE so a step-out can never be undone by a later
 * handler", …).
 *
 * ## The model
 *
 * One listener, one ordered ladder of SCOPES. A scope is active or it is not;
 * the dispatcher walks the ladder in this fixed order and gives each ACTIVE
 * scope first refusal on the keystroke:
 *
 *   inline-edit > vector-edit > prototype-link > annotation > node > board > global
 *
 * `handle` returns `true` when it CLAIMED the keystroke — dispatch stops there.
 * Returning `false` means "not mine", and the next scope down gets it. That
 * fall-through is what preserves every existing shared-key behaviour without a
 * single capture-phase listener:
 *
 *   - Delete with a prototype connector AND a node selected goes to the
 *     connector (prototype-link is higher), which is what
 *     `usePrototypeLinkKeyboard`'s capture listener + `stopPropagation` bought
 *     before — except now it is a stated rule instead of a phase trick.
 *   - Arrow keys with notes AND frames selected nudge the notes (annotation is
 *     higher than board), which is what mounting order bought before.
 *   - `T` / `F` / `C` still fire with a node selected, because the node scope
 *     does not claim them and the board scope below it does.
 *
 * ## `inline-edit` claims everything and does nothing
 *
 * While a canvas inline text edit is open, the contentEditable element owns the
 * keyboard. The scope is active, and its `handle` returns `true` for every
 * keystroke without acting — a halt, not a handler. This is load-bearing:
 * `useIframeEventForwarding` already refuses to forward during a session, but a
 * keystroke typed while focus sits in the PARENT document would otherwise still
 * reach the canvas shortcuts, and the worst case there is ⌘Z running the store
 * `undo()` while the contentEditable DOM keeps the text — after which the store
 * and the DOM never agree again.
 *
 * ## `vector-edit` sits right under it (P5-D)
 *
 * While an inline `<svg>` is in vector edit mode, or the pen tool is drawing,
 * the keyboard means POINTS: Escape / ⏎ leave or finish, arrows nudge an
 * anchor, Delete must not delete the whole svg. That rung has to outrank
 * `node` (which would move or delete the selected element) and `board`
 * (whose Escape would put a tool away mid-path). See `useVectorEditKeys.ts`
 * and `CanvasPenToolLayer.tsx`.
 *
 * ⌘S (`usePersistence`) and ⌘K (`SpotlightRoot`) are deliberately NOT on this
 * ladder: they are window-level admin-shell shortcuts that must survive an
 * inline edit, and they are not part of the canvas key layer this module owns.
 *
 * ## keyup is a broadcast, not a claim
 *
 * `handleKeyUp` runs for EVERY registered scope regardless of `isActive`, and
 * cannot claim. It exists for "a held key was released": ending an undo burst
 * (`endBoardGesture`) and lowering the Space-pan flag. "The hold is over" is
 * true whether or not the scope that started it is still the active one.
 *
 * ## Losing focus releases EVERY key (ERR-11)
 *
 * A key released while the window does not have focus sends its keyup to some
 * other application, so a hold that was in progress when the user Alt-Tabbed
 * away, or clicked into devtools, never ends — Space-pan left every frame
 * unclickable until Space was pressed again. `handleKeyUp(null)` is the same
 * broadcast with no event: "every key is up now". The dispatcher sends it on
 * window `blur` and on the document going hidden, and the frame relays send it
 * when a frame's own window loses focus (`canvasFrameKeyRelay.ts`).
 */

/** The precedence ladder, highest first. The order IS the contract. */
export const EDITOR_KEY_SCOPE_ORDER = [
  'inline-edit',
  'vector-edit',
  'prototype-link',
  'annotation',
  'node',
  'board',
  'global',
] as const

export type EditorKeyScopeId = (typeof EDITOR_KEY_SCOPE_ORDER)[number]

export interface EditorKeyScope {
  /** Which rung of the ladder this handler sits on. */
  id: EditorKeyScopeId
  /**
   * Coarse "could this scope claim anything right now?" gate, read fresh on
   * every keystroke. Cheap predicates only — this runs for every key the user
   * presses anywhere in the admin shell.
   */
  isActive: () => boolean
  /** Returns true when the keystroke was CLAIMED and dispatch should stop. */
  handle: (event: KeyboardEvent) => boolean
  /**
   * Optional "a held key was released" broadcast. Never claims. `null` means
   * EVERY key was released — the window lost focus (see the module doc).
   */
  handleKeyUp?: (event: KeyboardEvent | null) => void
}

const registered: EditorKeyScope[] = []

/**
 * Register a scope handler. Returns the unregister function, so the whole
 * lifecycle is one line in a `useEffect`.
 *
 * Several handlers may share one id (the `board` rung carries four). Within a
 * rung they run in registration order; ACROSS rungs the ladder above decides,
 * so a hook moving in `CanvasRoot` can no longer change who wins a keystroke.
 */
export function registerEditorKeyScope(scope: EditorKeyScope): () => void {
  registered.push(scope)
  return () => {
    const index = registered.indexOf(scope)
    if (index !== -1) registered.splice(index, 1)
  }
}

/**
 * Walk the ladder and give each active scope first refusal. Returns true when
 * some scope claimed the keystroke.
 *
 * The dispatcher itself never calls `preventDefault` — claiming and preventing
 * are different decisions, and only the handler knows whether the browser's own
 * behaviour for this key should also be suppressed.
 */
export function dispatchEditorKeyDown(event: KeyboardEvent): boolean {
  for (const scopeId of EDITOR_KEY_SCOPE_ORDER) {
    for (const scope of registered) {
      if (scope.id !== scopeId) continue
      if (!scope.isActive()) continue
      if (scope.handle(event)) return true
    }
  }
  return false
}

/**
 * Broadcast a key release to every registered scope — `null` for "every key is
 * up" (focus left the window). See the module doc.
 */
export function dispatchEditorKeyUp(event: KeyboardEvent | null): void {
  for (const scope of registered) scope.handleKeyUp?.(event)
}

/**
 * A window in the editor just lost focus — the editor's own, or a frame's.
 * Release every key if focus actually LEFT the editor (Alt-Tab, devtools, the
 * address bar), and do nothing if it only moved between the editor document
 * and one of its frames: `Document.hasFocus()` is true while any descendant
 * frame holds focus, so a click into a frame is not a release. Checked on the
 * next task because focus lands on its new owner only after `blur` has run.
 */
export function releaseEditorKeysIfFocusLeft(editorDocument: Document): void {
  setTimeout(() => {
    if (!editorDocument.hasFocus()) dispatchEditorKeyUp(null)
  }, 0)
}

/** Test seam — the ids currently registered, in ladder order. */
export function registeredEditorKeyScopeIds(): EditorKeyScopeId[] {
  const ids: EditorKeyScopeId[] = []
  for (const scopeId of EDITOR_KEY_SCOPE_ORDER) {
    for (const scope of registered) if (scope.id === scopeId) ids.push(scope.id)
  }
  return ids
}
