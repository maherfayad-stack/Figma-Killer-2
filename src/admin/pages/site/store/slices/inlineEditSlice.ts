/**
 * Inline text edit slice — ephemeral canvas UI state for the double-click
 * inline text editor.
 * Contract: docs/agent-refs/canvas-internals.md → "Inline text editing"
 *
 * The session is UI-only state (never persisted, never itself part of undo
 * history). **One session is one write.** Keystrokes only update the
 * session's `draft` (the contentEditable element already shows the text);
 * nothing reaches the page tree, the undo stack or the autosave until the
 * session COMMITS (`endInlineEdit` — Enter, blur, or another gesture taking
 * over), which writes the draft through `updateNodeProps` exactly once: one
 * history entry, one source write. `cancelInlineEdit` (Escape) simply drops
 * the draft — there is nothing to undo, so no partial write can survive it
 * and no timing window (a save landing between the last keystroke and
 * Escape) can leave "all but the last character" on disk.
 *
 * Burst isolation: `startInlineEdit` and `endInlineEdit` both reset
 * `_historyCoalesceKey`, so the commit can never fold into a
 * Properties-panel typing burst for the same prop.
 *
 * **WS-10 §4.4 (Phase 4) — locale-variant frame sessions commit through a
 * SECOND mutation path, `updateLocalizedNodeText`.** A session started in a
 * board frame whose OWN `axes.locale` differs from the board default is
 * editing a node that lives in `localizedPageSlice.ts`'s `localizedPages`
 * map, NOT `site.pages` — writing it through `updateNodeProps` would
 * silently edit the WRONG tree. `session.localeOverride` (resolved once, at
 * `startInlineEdit` time) tells `endInlineEdit` which path to take. That
 * path is undo-EXEMPT (see `localizedPageSlice.ts`).
 */
import { registry } from '@core/module-engine'
import { canUnbindProp, isPropWritableToSource } from '@core/page-tree'
import { isCanvasLayerPageId } from '@core/studio-board'
import { pushToast } from '@ui/components/Toast'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { getActiveTree } from './selectionResolve'
import { selectActiveBoard } from './boardSelectors'
import { localizedPageKey } from './localizedPageSlice'
import { mintPendingCommitId } from './site/structuralCommitRollback'
import { commitCanvasLayerText } from '@site/studio/canvasLayerTextCommit'

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
  /** Prop value when the session started. */
  initialValue: string
  /** The text as typed so far; written to the tree once, on commit. Starts equal to `initialValue`. */
  draft: string
  /** Open with the whole text selected (a freshly drawn text's placeholder) instead of the caret at the end. */
  selectAll?: true
  /**
   * G-6 (OD-20) - the text is CODE (`{count}`, `{t('x')}`) and the session is the
   * user typing over it: committing replaces the code with the draft through
   * `unbindNodeValue` (a journaled source write with its notice and Undo), not
   * through `updateNodeProps`, which would refuse it.
   */
  unbind?: true
}

/**
 * Whether `session` edits THIS rendering of `nodeId` — the same node id in the
 * same breakpoint frame AND the same board frame (two "duplicate as variant"
 * frames share both the node id and the `'studio'` breakpoint id, trap #2).
 * A primitive answer on purpose: `NodeRenderer` subscribes to it once per
 * mounted node (P2-I).
 */
export function isInlineEditSessionFor(
  session: Pick<ActiveInlineEdit, 'nodeId' | 'breakpointId' | 'frameId'> | null,
  nodeId: string,
  breakpointId: string | undefined,
  frameId: string | null,
): boolean {
  return session !== null && session.nodeId === nodeId && session.breakpointId === breakpointId && session.frameId === frameId
}

interface InlineEditSlice {
  activeInlineEdit: ActiveInlineEdit | null
  /**
   * Start a session for `nodeId` in `breakpointId`'s frame (`frameId` when
   * it's a board frame). Returns whether it actually started — `false` (a
   * no-op) when the module doesn't declare `inlineTextEdit`, the node has
   * children (base.link renders children instead of `text`), the text prop
   * is not writable back to source (`codeProps` — toasted, since the user
   * double-clicked visible copy), the prop is dynamically bound, or the
   * stored value isn't a string (corrupt tree → console.warn). Resolves
   * `localeOverride` ONCE here (not re-derived per keystroke) by reading
   * `frameId`'s `BoardFrame.axes.locale` against the board's current
   * `previewAxes.locale` — see this slice's module doc. `live-18`'s bridge
   * frame caller needs the return value to answer the frame's
   * `text:editStart` request; the portal double-click handler ignores it.
   */
  startInlineEdit: (nodeId: string, breakpointId: string, frameId?: string | null, options?: { selectAll?: boolean }) => boolean
  /** Record the text typed so far. Touches only the session draft — no tree write, no history, no save. */
  applyInlineEditValue: (value: string) => void
  /** Commit + close: writes the draft once (one undo entry) iff it differs from the initial value. */
  endInlineEdit: () => void
  /** Discard the draft + close. Nothing was written, so nothing is reverted. */
  cancelInlineEdit: () => void
  /**
   * The text an inspector field is being typed into, painted on the canvas
   * BEFORE it is committed. Transient UI state: no tree write, no history, no
   * save. `NodeRenderer` overlays it on the node's resolved props; the field's
   * single commit (`updateNodeProps`) is what reaches the source.
   */
  previewNodeProps: { nodeId: string; props: Record<string, unknown> } | null
  setPreviewNodeProps: (nodeId: string, props: Record<string, unknown>) => void
  /** Drop the preview (commit, Escape, blur, unmount). Scoped to `nodeId` when given. */
  clearPreviewNodeProps: (nodeId?: string) => void
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
  frameId: string | null | undefined,
) {
  // A loose layer's node lives in its own module's tree, not the active page's.
  if (frameId && isCanvasLayerPageId(frameId)) return state.canvasLayerPages[frameId]?.nodes[nodeId]
  if (localeOverride) {
    return state.localizedPages[localizedPageKey(localeOverride.pageId, localeOverride.locale)]?.nodes[nodeId]
  }
  return getActiveTree(state)?.nodes[nodeId]
}

export const createInlineEditSlice: EditorStoreSliceCreator<InlineEditSlice> = (set, get) => ({
  activeInlineEdit: null,
  previewNodeProps: null,

  setPreviewNodeProps: (nodeId, props) => {
    set((s) => {
      s.previewNodeProps = { nodeId, props }
    })
  },

  clearPreviewNodeProps: (nodeId) => {
    const current = get().previewNodeProps
    if (!current || (nodeId !== undefined && current.nodeId !== nodeId)) return
    set((s) => {
      s.previewNodeProps = null
    })
  },

  startInlineEdit: (nodeId, breakpointId, frameId = null, options) => {
    const state = get()
    const localeOverride = resolveLocaleOverride(state, frameId)
    const node = resolveSessionNode(state, nodeId, localeOverride, frameId)
    if (!node) return false
    const def = registry.get(node.moduleId)
    const spec = def?.inlineTextEdit
    if (!spec) return false
    // Sandboxed (untrusted plugin) modules render in a ModuleSandboxFrame, which
    // never receives the inlineEdit binding — so there'd be no contentEditable
    // element to focus/commit and the session would be stuck. Mirror
    // NodeRenderer's `shouldRenderSandbox` check and never start for them.
    if (def?.editorRuntime?.sandbox && !def.trusted) return false
    // A node rendering children doesn't render its text prop (base.link).
    if (node.children.length > 0) return false
    // Source-locked nodes — propagated from the page-parser's resolved-value /
    // `.map` / ternary / spread detection — are not editable inline. Keyed on
    // `lockReason` (not `locked` alone) so the manual DnD-only "layer lock"
    // keeps its existing semantics.
    //
    // This one gets a TOAST where the other early-returns above stay silent,
    // because it is the only one the user can mistake for a bug: they
    // double-clicked real copy that is plainly right there, and nothing
    // happened. (Double-clicking a container has no inline-edit contract at
    // all, which needs no announcement.) `startInlineEdit` has two callers —
    // the canvas double-click handler and, `live-18`, the bridge-frame
    // interaction hook — so a toast here is always a response to a real
    // gesture, never programmatic noise.
    // Asked of the TEXT PROP, not the node. A node can be structurally locked (a
    // ternary chose it, a `.map` made it) and still hold a perfectly writable
    // literal text child — that is the common case on an imported screen, and
    // refusing it on the node's lock is what made real copy undoubleclickable.
    // `codeProps` names the text prop only when the text came from an expression
    // AND has no `textOrigin` literal to write instead. See
    // `@core/page-tree`'s `sourceWritability`.
    //
    // G-6 (OD-20): the one exception is text the user may TYPE OVER - one plain
    // source location, code that is a value (`canUnbindProp`). The session opens
    // on what the canvas shows, and committing a change replaces the code with
    // the text (Undo restores it); leaving without a change writes nothing.
    // Locale-variant and loose-layer sessions commit through other trees and keep
    // the refusal.
    const unbind =
      !isPropWritableToSource(node, spec.prop) &&
      localeOverride === null &&
      !(frameId && isCanvasLayerPageId(frameId)) &&
      canUnbindProp(node, spec.prop)
    if (!unbind && !isPropWritableToSource(node, spec.prop)) {
      pushToast({
        kind: 'info',
        title: 'This text is set in code',
        body: `${capitalise(node.lockReason ?? 'it is computed in code')}. Edit it in the source file — the Properties panel shows where it comes from.`,
        location: 'canvas:inline-edit',
      })
      return false
    }
    // A dynamically-bound prop isn't literal-editable — the binding would
    // overwrite every keystroke in the canvas preview.
    if (node.dynamicBindings?.[spec.prop]) return false
    const value = unbind && node.props[spec.prop] === undefined ? '' : node.props[spec.prop]
    if (typeof value !== 'string') {
      console.warn(
        `[canvas] inline edit aborted: prop "${spec.prop}" on node "${nodeId}" is not a string`,
      )
      return false
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
        draft: value,
        ...(options?.selectAll ? { selectAll: true as const } : {}),
        ...(unbind ? { unbind: true as const } : {}),
      }
      // Isolate the session's burst from any in-flight coalescing burst for
      // the same key (e.g. Properties-panel typing on the same prop).
      s._historyCoalesceKey = null
    })
    return true
  },

  applyInlineEditValue: (value) => {
    if (!get().activeInlineEdit) return
    set((s) => {
      if (s.activeInlineEdit) s.activeInlineEdit.draft = value
    })
  },

  endInlineEdit: () => {
    const state = get()
    const session = state.activeInlineEdit
    if (!session) return
    // Close first, so the write below renders the node as plain (not editing).
    set((s) => {
      s.activeInlineEdit = null
      s._historyCoalesceKey = null
    })
    if (session.draft === session.initialValue) return
    if (session.unbind) {
      get().unbindNodeValue(session.nodeId, session.prop, session.draft)
      return
    }
    if (session.frameId && isCanvasLayerPageId(session.frameId)) {
      // A loose layer's module is not in the page tree: its draft is committed
      // once, as a source write of its own (see `commitLayerSession`).
      commitLayerSession(set, get, session)
      return
    }
    if (session.localeOverride) {
      // WS-10 §4.4 — a separate, undo-EXEMPT mutation on the localized tree.
      state.updateLocalizedNodeText(session.localeOverride.pageId, session.localeOverride.locale, session.nodeId, session.prop, session.draft)
    } else {
      get().updateNodeProps(session.nodeId, { [session.prop]: session.draft })
    }
    set((s) => {
      s._historyCoalesceKey = null
    })
  },

  cancelInlineEdit: () => {
    if (!get().activeInlineEdit) return
    set((s) => {
      s.activeInlineEdit = null
      s._historyCoalesceKey = null
    })
  },
})

type Set = Parameters<EditorStoreSliceCreator<EditorStore>>[0]
type Get = Parameters<EditorStoreSliceCreator<EditorStore>>[1]

/**
 * Post a loose layer's finished text session as one write. The layer's tree is
 * updated first so the text does not flash back to the old value until the
 * resync; a write that does not land puts the old text back.
 */
function commitLayerSession(set: Set, get: Get, session: NonNullable<EditorStore['activeInlineEdit']>): void {
  const after = session.draft
  const pageId = session.frameId
  if (after === undefined || after === session.initialValue || !pageId) return
  const node = get().canvasLayerPages[pageId]?.nodes[session.nodeId]
  if (!node) return
  const writeProp = (value: string) =>
    set((s) => {
      const target = s.canvasLayerPages[pageId]?.nodes[session.nodeId]
      if (target) target.props[session.prop] = value
    })
  writeProp(after)
  let done = false
  void commitCanvasLayerText({
    node,
    before: session.initialValue,
    after,
    rollback: {
      id: mintPendingCommitId(),
      settle: () => {
        done = true
      },
      rollback: () => {
        if (done) return
        done = true
        writeProp(session.initialValue)
      },
    },
  })
}

/** `value from c.hotelsTitle` -> `Value from c.hotelsTitle`, for use mid-sentence. */
function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`
}
