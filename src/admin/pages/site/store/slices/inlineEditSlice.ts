/**
 * Inline text edit slice — ephemeral canvas UI state for the double-click
 * inline text editor.
 * Spec: docs/superpowers/specs/2026-06-10-inline-text-editing-design.md
 *
 * The session is UI-only state (never persisted, never itself part of undo
 * history). Live commits route through `updateNodeProps`, whose single-field
 * patches coalesce under `props:<nodeId>:<prop>` (see `coalesceKeyForPatch`
 * in slices/site/nodeActions.ts) — the whole typing burst is ONE undo entry,
 * which is what lets `cancelInlineEdit` revert with a single `undo()`.
 *
 * Burst isolation: `startInlineEdit` and `endInlineEdit` both reset
 * `_historyCoalesceKey`, so the inline burst can never fold into a
 * Properties-panel typing burst for the same prop (or vice versa) — Escape
 * must revert exactly the inline session, nothing more.
 *
 * **WS-10 §4.4 (Phase 4) — locale-variant frame sessions branch to a SECOND
 * mutation path, `updateLocalizedNodeText`.** A session started in a board
 * frame whose OWN `axes.locale` differs from the board default is editing a
 * node that lives in `localizedPageSlice.ts`'s `localizedPages` map, NOT
 * `site.pages` — writing it through `updateNodeProps`/`mutateActiveTree`
 * would silently edit the WRONG tree (the default-locale one, sharing this
 * node's id per trap #2) while displaying the edit in the locale-variant
 * frame, which would both corrupt the default tree and lose the actual
 * locale edit. `session.frameId`/`localeOverride` (resolved once, at
 * `startInlineEdit` time) is what tells `applyInlineEditValue`/
 * `cancelInlineEdit` which path to take. This is a genuinely SEPARATE,
 * undo-EXEMPT mutation (see `localizedPageSlice.ts`'s own doc for why that
 * scope boundary is deliberate) — `session.committed`/`undo()` stay
 * meaningful ONLY for the default-tree path; the locale-variant path
 * reverts by re-setting `initialValue` directly on cancel.
 */
import { registry } from '@core/module-engine'
import { isPropWritableToSource } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { getActiveTree } from './selectionSlice'
import { selectActiveBoard } from './boardSlice'
import { localizedPageKey } from './localizedPageSlice'

interface ActiveInlineEdit {
  nodeId: string
  /** The single string prop being edited (from ModuleDefinition.inlineTextEdit). */
  prop: string
  /** The breakpoint frame the user double-clicked in — owns the overlay. */
  breakpointId: string
  /** WS-10 Phase 2/4 — the owning BoardFrame id, or `null` outside board context. Distinguishes two "duplicate as variant" siblings sharing `breakpointId` AND this node's id (trap #2). */
  frameId: string | null
  /** WS-10 §4.4 (Phase 4) — set when `frameId`'s frame has its own locale override that differs from the board default; names WHICH `(pageId, locale)` tree in `localizedPageSlice.ts` this session mutates instead of `site.pages`. `null` for every other session (the overwhelmingly common case, including all of Phase 1-3). */
  localeOverride: { pageId: string; locale: string } | null
  multiline: boolean
  /** Prop value when the session started; cancel restores it via one undo() (default tree) or a direct re-set (locale-variant tree). */
  initialValue: string
  /** True once a keystroke produced a REAL history entry (a burst exists). Only meaningful for the default-tree (undo-tracked) path. */
  committed: boolean
}

interface InlineEditSlice {
  activeInlineEdit: ActiveInlineEdit | null
  /**
   * Start a session for `nodeId` in `breakpointId`'s frame (`frameId` when
   * it's a board frame). No-ops when the module doesn't declare
   * `inlineTextEdit`, the node has children (base.link renders children
   * instead of `text`), the text prop is not writable back to source
   * (`codeProps` — toasted, since the user double-clicked visible copy), the
   * prop is dynamically bound, or the stored value isn't a string (corrupt
   * tree → console.warn). Resolves `localeOverride` ONCE here (not re-derived
   * per keystroke) by reading `frameId`'s `BoardFrame.axes.locale` against
   * the board's current `previewAxes.locale` — see this slice's module doc.
   */
  startInlineEdit: (nodeId: string, breakpointId: string, frameId?: string | null) => void
  /** Live per-keystroke commit — one coalesced undo entry per session (default tree), or a direct mutation (locale-variant tree). */
  applyInlineEditValue: (value: string) => void
  /** Commit + close. Keystrokes already landed live; this ends session + burst. */
  endInlineEdit: () => void
  /** Revert + close: one undo() (default tree) or a direct re-set of `initialValue` (locale-variant tree), iff the session actually changed something. */
  cancelInlineEdit: () => void
}

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends InlineEditSlice {}
}

/**
 * WS-10 §4.4 (Phase 4) — `{pageId, locale}` when `frameId` names a board
 * frame whose OWN `axes.locale` differs from the board's current
 * `previewAxes.locale`, else `null`. The ONE place a session decides which
 * tree it belongs to — resolved once at `startInlineEdit` time, never
 * re-derived per keystroke (a board-global locale switch mid-session is not
 * a case this needs to track live; `endInlineEdit`/a fresh double-click
 * re-resolves for the next session).
 */
function resolveLocaleOverride(
  state: EditorStore,
  frameId: string | null | undefined,
): { pageId: string; locale: string } | null {
  if (!frameId) return null
  const frame = selectActiveBoard(state)?.frames.find((f) => f.id === frameId)
  const locale = frame?.axes?.locale
  if (!frame || !locale || locale === state.previewAxes.locale) return null
  return { pageId: frame.pageId, locale }
}

/** The node this session addresses — `localizedPageSlice.ts`'s tree for a locale-variant session, the active tree otherwise. Mirrors `selectCanvasPageFor`'s own branch (`store.ts`) without importing it (would cycle: store.ts already imports this slice's creator). */
function resolveSessionNode(
  state: EditorStore,
  nodeId: string,
  localeOverride: { pageId: string; locale: string } | null,
) {
  if (localeOverride) {
    return state.localizedPages[localizedPageKey(localeOverride.pageId, localeOverride.locale)]?.nodes[nodeId]
  }
  return getActiveTree(state)?.nodes[nodeId]
}

export const createInlineEditSlice: EditorStoreSliceCreator<InlineEditSlice> = (set, get) => ({
  activeInlineEdit: null,

  startInlineEdit: (nodeId, breakpointId, frameId = null) => {
    const state = get()
    const localeOverride = resolveLocaleOverride(state, frameId)
    const node = resolveSessionNode(state, nodeId, localeOverride)
    if (!node) return
    const def = registry.get(node.moduleId)
    const spec = def?.inlineTextEdit
    if (!spec) return
    // Sandboxed (untrusted plugin) modules render in a ModuleSandboxFrame, which
    // never receives the inlineEdit binding — so there'd be no contentEditable
    // element to focus/commit and the session would be stuck. Mirror
    // NodeRenderer's `shouldRenderSandbox` check and never start for them.
    if (def?.editorRuntime?.sandbox && !def.trusted) return
    // A node rendering children doesn't render its text prop (base.link).
    if (node.children.length > 0) return
    // Source-locked nodes — propagated from the page-parser's resolved-value /
    // `.map` / ternary / spread detection — are not editable inline. Keyed on
    // `lockReason` (not `locked` alone) so the manual DnD-only "layer lock"
    // keeps its existing semantics.
    //
    // This one gets a TOAST where the other early-returns above stay silent,
    // because it is the only one the user can mistake for a bug: they
    // double-clicked real copy that is plainly right there, and nothing
    // happened. (Double-clicking a container has no inline-edit contract at
    // all, which needs no announcement.) `startInlineEdit` has exactly one
    // caller — the canvas double-click handler — so a toast here is always a
    // response to a real gesture, never programmatic noise.
    // Asked of the TEXT PROP, not the node. A node can be structurally locked (a
    // ternary chose it, a `.map` made it) and still hold a perfectly writable
    // literal text child — that is the common case on an imported screen, and
    // refusing it on the node's lock is what made real copy undoubleclickable.
    // `codeProps` names the text prop only when the text came from an expression
    // AND has no `textOrigin` literal to write instead. See
    // `@core/page-tree`'s `sourceWritability`.
    if (!isPropWritableToSource(node, spec.prop)) {
      pushToast({
        kind: 'info',
        title: 'This text is set in code',
        body: `${capitalise(node.lockReason ?? 'it is computed in code')}. Edit it in the source file — the Properties panel shows where it comes from.`,
        location: 'canvas:inline-edit',
      })
      return
    }
    // A dynamically-bound prop isn't literal-editable — the binding would
    // overwrite every keystroke in the canvas preview.
    if (node.dynamicBindings?.[spec.prop]) return
    const value = node.props[spec.prop]
    if (typeof value !== 'string') {
      console.warn(
        `[canvas] inline edit aborted: prop "${spec.prop}" on node "${nodeId}" is not a string`,
      )
      return
    }
    set((s) => {
      s.activeInlineEdit = {
        nodeId,
        prop: spec.prop,
        breakpointId,
        frameId: frameId ?? null,
        localeOverride,
        multiline: spec.multiline ?? false,
        initialValue: value,
        committed: false,
      }
      // Isolate the session's burst from any in-flight coalescing burst for
      // the same key (e.g. Properties-panel typing on the same prop).
      s._historyCoalesceKey = null
    })
  },

  applyInlineEditValue: (value) => {
    const state = get()
    const session = state.activeInlineEdit
    if (!session) return
    const node = resolveSessionNode(state, session.nodeId, session.localeOverride)
    if (!node) return
    const changed = !Object.is(node.props[session.prop], value)
    if (session.localeOverride) {
      // WS-10 §4.4 — a genuinely separate, undo-EXEMPT mutation on
      // `localizedPageSlice.ts`'s tree, not `site.pages`. See this file's
      // module doc and `localizedPageSlice.ts`'s own for why.
      state.updateLocalizedNodeText(session.localeOverride.pageId, session.localeOverride.locale, session.nodeId, session.prop, value)
    } else {
      // `committed` flips only on a REAL change — updateNodeProps no-ops equal
      // values (recordPatchChanges), and cancel must not undo() unless this
      // session actually pushed a history entry.
      state.updateNodeProps(session.nodeId, { [session.prop]: value })
    }
    if (changed && !session.committed) {
      set((s) => {
        if (s.activeInlineEdit) s.activeInlineEdit.committed = true
      })
    }
  },

  endInlineEdit: () => {
    if (!get().activeInlineEdit) return
    set((s) => {
      s.activeInlineEdit = null
      // End the burst: later edits of the same prop get a fresh undo entry.
      s._historyCoalesceKey = null
    })
  },

  cancelInlineEdit: () => {
    const session = get().activeInlineEdit
    if (!session) return
    if (session.localeOverride) {
      // No undo() entry exists for this path (see module doc) — revert by
      // re-setting the frozen initial value directly, iff it actually
      // changed (mirrors `committed`'s purpose for the default-tree path).
      if (session.committed) {
        get().updateLocalizedNodeText(
          session.localeOverride.pageId,
          session.localeOverride.locale,
          session.nodeId,
          session.prop,
          session.initialValue,
        )
      }
    } else if (session.committed) {
      // The whole session is one coalesced entry — a single undo() restores
      // the pre-session value. undo() also resets _historyCoalesceKey.
      get().undo()
    }
    set((s) => {
      s.activeInlineEdit = null
      s._historyCoalesceKey = null
    })
  },
})

/** `value from c.hotelsTitle` -> `Value from c.hotelsTitle`, for use mid-sentence. */
function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`
}
