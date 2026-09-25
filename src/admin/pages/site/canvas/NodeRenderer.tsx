/**
 * NodeRenderer — renders a single PageNode in the editor canvas.
 *
 * Performance notes (Contribution #312 + #495):
 * ─────────────────────────────────────────────
 * - memo() prevents re-renders when unrelated nodes change.
 * - Per-node Zustand selector: subscribes ONLY to the specific node's data.
 *   Editing node A never re-renders NodeRenderer for node B.
 * - Selection/hover handled via CanvasSelectionContext (no DOM event bubbling).
 * - The selection is NOT in context (Perf fix #495), and not a store selector
 *   either (P2-I): `useIsNodeSelected` is a KEYED read — one store listener
 *   diffs the old and new selection and wakes only the nodes whose answer
 *   changed (`canvasNodeSelection.ts`).
 * - Hover is not read here at all. It lives off the store (`canvasHover.ts`)
 *   and its ring is the overlay's, drawn inside the frame; the per-node hover
 *   subscription this used to carry fed a `data-hovered` attribute that no
 *   stylesheet read.
 * - Zustand re-runs EVERY subscriber's selector on EVERY store set, and this
 *   component is mounted once per node per mounted frame, so each store
 *   subscription below is a multiplier on every keystroke, click and
 *   pan commit (`per-node-selector-budget.test.ts` counts them; the sweep in
 *   `scripts/bench/lib/canvasSubscriberSweep.ts` times them). They return
 *   primitives or existing references — never a fresh object — and must stay
 *   O(1)-ish: the active-page resolution is single-slot memoized in
 *   `selectActivePage`, the form-preview helpers cache their parent index per
 *   tree identity, and `getCanvasNodeClassIds` passes the node's own array
 *   through untouched when no preview applies. Store ACTIONS are read through
 *   `getState()` in the handlers that call them, which subscribes to nothing.
 */

import { memo, use, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { InlineEditBinding } from '@core/module-engine'
import { readInlineEditableText, seedInlineEditableContent } from '@modules/base/shared/inlineText'
import { useEditorStore, selectCanvasPageFor } from '@site/store/store'
import { isInlineEditSessionFor } from '@site/store/slices/inlineEditSlice'
import { resolveProps } from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { NodeWrapperProps as NodeWrapperPropsType } from '@core/module-engine'
import { resolveDynamicProps, effectiveNodeBindings, type TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { PageNode } from '@core/page-tree'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { ModuleSandboxFrame } from './ModuleSandboxFrame'
import {
  isSuppressedPointerTarget,
  markClickActivated,
  setSuppressedPointerTarget,
  takeActivatedClick,
  takeSuppressedPointerTarget,
} from './canvasNodeGestureLatch'
import {
  focusNodeWithoutScrolling,
  isCanvasEditorControlTarget,
  isClosestCanvasNodeTarget,
  isEditableTextTarget,
  isFocusableElement,
  shouldSuppressAuthoredFormControlEvent,
} from './canvasEventTargets'
import { PackageComponentPlaceholder } from './PackageComponentPlaceholder'
import { canvasProjectAssetScope, projectAssetProps, projectAssetStyle } from './canvasProjectAssetUrl'
import {
  CanvasBreakpointContext,
  CanvasFrameContext,
  CanvasInteractionContext,
  CanvasPageContext,
  CanvasSelectionContext,
  CanvasTemplateContext,
} from './CanvasContexts'
import {
  addEditorFormPreviewProps,
  resolveEditorFormPreviewState,
  resolveEditorFormPreviewSuccessMessage,
} from './canvasFormPreview'
import { useResponsiveBackgroundStyle } from '@admin/shared/media/hooks/useResponsiveBackgroundStyle'
import { getCanvasNodeClassIds, getCanvasNodeClassName } from './canvasNodeClassName'
import { useIsNodeSelected } from './canvasNodeSelection'
import { nodeRenderKey } from './nodeRenderKeys'
import { mergePreviewedInlineStyles } from './canvasNodeInlineStyle'
import { findEnclosingComponentRef, findEnclosingInstance, resolveInstanceEntry, type AnnotatedPageNode } from './canvasSelectionUtils'
import { useLoopPreviewItems } from './useLoopPreviewItems'
import styles from './NodeRenderer.module.css'

// ---------------------------------------------------------------------------
// NodeRenderer
// ---------------------------------------------------------------------------

interface NodeRendererProps {
  nodeId: string
}

// React Compiler exception #2: memo() re-render bailout on a hot, recursive
// per-node canvas renderer (O(N) critical path) — kept intentionally.
export const NodeRenderer = memo(function NodeRenderer({ nodeId }: NodeRendererProps) {
  // The page this frame renders. `null` (no CanvasPageContext provider) means
  // "the active canvas document" — every CMS/VC frame. Board frames provide a
  // page id so this NodeRenderer resolves against that frame's own page.
  const contextPageId = use(CanvasPageContext)
  const breakpointId = use(CanvasBreakpointContext)
  // WS-10 Phase 2 — owning BoardFrame id (`null` outside board context). NOT
  // `breakpointId` — see `CanvasFrameContext`'s doc. Declared before `node`
  // below (its selector closure reads it — TDZ).
  const frameId = use(CanvasFrameContext)
  // A live frame is the page as a visitor gets it, so an authored control has
  // to activate there: focus a field and type into it, open a select. Design
  // frames suppress all of that, because a click on a control in an EDITING
  // surface means "select this node". Same switch
  // `useCanvasFormControlSuppression` reads at the document level; the
  // node-level handlers below were the one place still applying the design
  // rule to both.
  const interaction = use(CanvasInteractionContext)
  const suppressesFormControls = interaction !== 'live'
  /**
   * Whether this frame's clicks belong to the EDITOR outright.
   *
   * On a design frame they do, and the canvas stops a click dead in the capture
   * phase. A LIVE frame is the page as a visitor gets it, and the capture-phase
   * `stopPropagation()` there meant the authored component's own `onClick`
   * NEVER RAN — the event was swallowed above it, before it could reach the
   * button inside the `display: contents` host that carries this bag. With the
   * prototype player armed that turned into "the link fires OR the component
   * does, never both", which is the whole complaint. `preventDefault()` stays
   * in both: an authored `<a href>` must not navigate the frame away.
   */
  const ownsAuthoredEvents = interaction !== 'live'
  // Per-node subscription — editing this node's props only re-renders THIS
  // component. `frameId` (§4.4/Phase 4) lets a locale-variant frame read
  // `localizedPageSlice.ts`'s tree instead of `site.pages` — see
  // `selectCanvasPageFor`'s own doc.
  const node = useEditorStore((s) => selectCanvasPageFor(s, contextPageId, frameId)?.nodes[nodeId] ?? null)
  const templateContext = use(CanvasTemplateContext)

  // Keyed selection read (P2-I) — see the module doc. Multi-select: every node
  // in the set shows the ring. WS-10 Phase 2 — scoped to the originating
  // BoardFrame (`selectedNodeFrameId`, "null means global") so a "duplicate as
  // variant" sibling (same node ids, trap #2) doesn't light up.
  const isSelected = useIsNodeSelected(nodeId, frameId)
  // Inline text edit session — matched only in the SESSION'S frame. Gated on
  // `frameId` too, not just `breakpointId` (every board frame shares ONE
  // synthetic breakpoint id, `'studio'`) — without it, a "duplicate as
  // variant" sibling sharing this node id (trap #2) would ALSO show the
  // contentEditable surface. Closes `canvas-08`'s "Known gap" note.
  //
  // A primitive, not the `useShallow` object this used to be (P2-I): that
  // selector allocated an object per node per store change and then
  // shallow-compared it — with the preview pair below, ~45% of the whole
  // canvas sweep. The session's `initialValue` and `multiline` are constant for
  // its whole life, so they are read through `getState()` exactly where they
  // are used (the seeding effect, the Enter handler).
  const isInlineEditing = useEditorStore((s) => isInlineEditSessionFor(s.activeInlineEdit, nodeId, breakpointId, frameId))
  const editableRef = useRef<HTMLElement | null>(null)
  // Canvas preview state for THIS node — the class-target hover preview
  // (`previewClassAssignment`) and its Rule 7 (panel-22) Element-target
  // mirror (`previewNodeStyles`). Two plain selectors, each returning the
  // store's own object or `null`, so neither allocates (P2-I). Both are
  // filtered to this node's id so unrelated nodes never re-render while a
  // preview is live elsewhere.
  const previewClassAssignment = useEditorStore((s) =>
    s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null,
  )
  const previewNodeStyles = useEditorStore((s) => (s.previewNodeStyles?.nodeIds.includes(nodeId) ? s.previewNodeStyles : null))
  const editorFormPreviewState = useEditorStore((s) => resolveEditorFormPreviewState(s, nodeId))
  const editorFormPreviewSuccessMessage = useEditorStore((s) => resolveEditorFormPreviewSuccessMessage(s, nodeId))
  const mcClassName = useEditorStore((s) => {
    const canvasNode = selectCanvasPageFor(s, contextPageId, frameId)?.nodes[nodeId]
    const preview = s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null
    return getCanvasNodeClassName(canvasNode?.classIds, preview, nodeId, s.site?.styleRules)
  })
  const { onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick, onNodePointerDown, onNodePointerUp } =
    use(CanvasSelectionContext)

  const handleNodeClick = (clickedNodeId: string, e: React.MouseEvent) => {
    // Imperative store access is correct here (event handler, not render path).
    const state = useEditorStore.getState()
    const page = selectCanvasPageFor(state, contextPageId, frameId)

    // instance-ui-01 — Figma's nesting model for `studio.instance` (WS-4.2): a
    // click anywhere inside a not-yet-entered instance's subtree selects the
    // INSTANCE, not the descendant. Checked before the VC lock-down below —
    // independent mechanisms, a click resolves to at most one in practice.
    if (page) {
      const enclosingInstance = findEnclosingInstance(page, clickedNodeId, state.enteredInstanceIds)
      if (enclosingInstance !== null) {
        onNodeClick(enclosingInstance, e, breakpointId, frameId)
        return
      }
    }

    // B3 — VC lock-down: redirect clicks inside inlined VC bodies to the ref node.
    if (state.activeDocument?.kind !== 'visualComponent' && page) {
      const enclosing = findEnclosingComponentRef(page.nodes as Record<string, AnnotatedPageNode>, clickedNodeId)
      if (enclosing !== null && !enclosing.isInsideSlotContent) {
        // Clicked inside a VC body (not slot content) — route to the ref.
        onNodeClick(enclosing.refId, e, breakpointId, frameId)
        return
      }
    }
    onNodeClick(clickedNodeId, e, breakpointId, frameId)
  }

  const handleNodeContextMenu = (clickedNodeId: string, e: React.MouseEvent) => {
    onNodeContextMenu(clickedNodeId, e, breakpointId, frameId)
  }

  // instance-ui-01 — Figma's "double-click enters it and selects the inner
  // node under the cursor": a double-click inside a not-yet-entered instance
  // opens ONE level (pushes `enteredInstanceIds`) and selects what is under
  // the cursor at the next level down — a nested instance whole, or the exact
  // node (`resolveInstanceEntry`, P2-B). Bypasses `handleNodeClick`'s
  // redirect and the module's ordinary double-click (inline edit). Nothing
  // closed around the node: falls through to ordinary behaviour unchanged.
  const handleNodeDoubleClick = (clickedNodeId: string, e: React.MouseEvent) => {
    const state = useEditorStore.getState()
    const page = selectCanvasPageFor(state, contextPageId, frameId)
    const entry = page ? resolveInstanceEntry(page, clickedNodeId, state.enteredInstanceIds) : null
    if (entry) {
      state.enterInstance(entry.enter)
      onNodeClick(entry.select, e, breakpointId, frameId)
      return
    }
    onNodeDoubleClick(clickedNodeId, e, breakpointId, frameId)
  }

  const handleNodeHover = (hoveredNodeId: string | null) => {
    if (hoveredNodeId !== null) {
      const state = useEditorStore.getState()
      const page = selectCanvasPageFor(state, contextPageId, frameId)

      // instance-ui-01 — clamp the hover ring to the enclosing not-yet-
      // entered instance, same redirect as click above.
      if (page) {
        const enclosingInstance = findEnclosingInstance(page, hoveredNodeId, state.enteredInstanceIds)
        if (enclosingInstance !== null) {
          onNodeHover(enclosingInstance, breakpointId, frameId)
          return
        }
      }

      // B3 — VC lock-down: clamp hover ring to the ref node for VC body nodes.
      if (state.activeDocument?.kind !== 'visualComponent' && page) {
        const enclosing = findEnclosingComponentRef(
          page.nodes as Record<string, AnnotatedPageNode>,
          hoveredNodeId,
        )
        if (enclosing !== null && !enclosing.isInsideSlotContent) {
          onNodeHover(enclosing.refId, breakpointId, frameId)
          return
        }
      }
    }
    onNodeHover(hoveredNodeId, breakpointId, frameId)
  }

  // Subscribe to module registry changes so plugin module packs that activate
  // after the canvas mounted trigger a re-render — otherwise the canvas would
  // freeze on `Unknown module` even after the registry receives the module.
  useSyncExternalStore(
    registry.subscribe.bind(registry),
    registry.generation.bind(registry),
    registry.generation.bind(registry),
  )

  // On session start, seed the editable element's content imperatively (React
  // does NOT own it — see inlineEditableElementProps), then focus and drop the
  // caret at the end. Layout effect → runs before paint, so the editor is live
  // on the first frame. The element lives in the breakpoint iframe
  // (same-origin); focusing it focuses the iframe in the parent — no
  // cross-frame negotiation needed. Deps are constant for the whole session, so
  // this runs once per session (never mid-edit, which would wipe the edits).
  // Trade-off: a programmatic mutation that swaps the node's element mid-session
  // (e.g. an RPC changing base.text's `tag`) remounts a fresh, unseeded element
  // and is not re-seeded. Unreachable from the UI — interacting with the
  // Properties panel blurs the editor, which ends the session first.
  useLayoutEffect(() => {
    if (!isInlineEditing) return
    const el = editableRef.current
    if (!el) return
    seedInlineEditableContent(el, useEditorStore.getState().activeInlineEdit?.initialValue ?? '')
    el.focus()
    const doc = el.ownerDocument
    const sel = doc.defaultView?.getSelection()
    if (!sel) return
    const range = doc.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }, [isInlineEditing])

  // A portal frame lives on the admin origin, so a site-root `url('/bg.png')`
  // in the node's own style resolves to the project asset route here — the
  // same resolution the props below and every CSS injector get
  // (`canvasProjectAssetUrl.ts`, P5-B2). Render-time only; the store keeps
  // what the source says.
  const assetScope = canvasProjectAssetScope()
  const inlineStyle = projectAssetStyle(
    useResponsiveBackgroundStyle(mergePreviewedInlineStyles(node?.inlineStyles, previewNodeStyles, nodeId)),
    assetScope,
  )

  if (!node) return null
  if (node.hidden) return null

  const definition = registry.get(node.moduleId)
  if (!definition) {
    // WS-3.3 — an unregistered `pkg.*` node is an EXPECTED, actionable state
    // (Tier 0, a bundle refusal, or a fetch in flight), not a broken
    // reference — show `PackageComponentPlaceholder` instead of the generic
    // "Unknown module" box. Any other unregistered id (a stale `alm.*`
    // reference, a plugin module pack that failed to activate, …) keeps the
    // original fallback.
    if (node.moduleId.startsWith('pkg.')) {
      return <PackageComponentPlaceholder moduleId={node.moduleId} />
    }
    return (
      <div
        className={styles.unknownModule}
        data-studio-unknown-module=""
        title={`Unknown module: ${node.moduleId}`}
      >
        <WarningDiamondSolidIcon size={14} /> Unknown module: {node.moduleId}
      </div>
    )
  }

  // Render children recursively. For `base.loop` nodes, delegate to a
  // dedicated component (`LoopIterationsPreview`) that uses hooks to fetch
  // real iteration data via the CMS API and round-robins variants across
  // iterations. Each iteration pushes a real LoopItem onto the entry stack
  // via a nested CanvasTemplateContext.Provider so dynamic bindings inside
  // the loop body resolve against the iteration item — same semantics as
  // the publisher's renderLoop().
  const children =
    node.moduleId === 'base.loop' && node.children.length > 0 ? (
      <LoopIterationsPreview node={node} baseTemplateContext={templateContext} />
    ) : (
      // PERF-6 — keyed by the node's CARRIED render key, not its id: a write
      // that renumbered this child's `rel:line:col` re-renders it in place
      // rather than remounting it (`nodeRenderKeys.ts`).
      node.children.map((childId) => <NodeRenderer key={nodeRenderKey(contextPageId, childId)} nodeId={childId} />)
    )

  const ComponentType = definition.component
  const shouldRenderSandbox = Boolean(definition.editorRuntime?.sandbox && !definition.trusted)
  // Pass the module schema so resolveProps drops breakpoint overrides for
  // non-responsive (content) keys — text/tag/src etc. must look identical
  // across every breakpoint frame, since published HTML is one document.
  //
  // Resource URLs (`src`, `srcSet`, `poster`) resolve last, for every module
  // at once: a site-root `src="/hero.png"` would otherwise load from the
  // admin origin and show broken (P5-B2, `canvasProjectAssetUrl.ts`).
  const effectiveProps = projectAssetProps(
    addEditorFormPreviewProps(
      node.moduleId,
      resolveDynamicProps(
      resolveProps(node, breakpointId, definition.schema),
      effectiveNodeBindings(node),
      templateContext,
      ),
      editorFormPreviewState,
      editorFormPreviewSuccessMessage,
    ),
    assetScope,
  )

  // Build className from classIds using the user-facing class names.
  const effectiveClassIds = getCanvasNodeClassIds(node.classIds, previewClassAssignment, nodeId)

  // Editor attributes + event handlers the module spreads onto its root
  // element. Previously this was a wrapping `<div class="nodeWrapper">`
  // around every node — that wrapper broke CSS combinators (`body > nav`,
  // `:nth-child()`, etc.) because it sat between every authored element.
  // Moving the bag onto the module's own root removes the wrapper entirely
  // and the canvas DOM matches the published DOM exactly.
  const nodeWrapperProps: NodeWrapperPropsType = {
    'data-node-id': nodeId,
    'data-module-id': node.moduleId,
    tabIndex: 0,
    ...(isSelected ? { 'data-canvas-selected': 'true' as const } : {}),
    ...(inlineStyle ? { style: inlineStyle } : {}),
    onPointerDownCapture: (e) => {
      focusNodeWithoutScrolling(e.currentTarget, e.target, isInlineEditing)
      // The press half of the player's gesture. Guarded by the same
      // "innermost node wins" predicate the click handlers use, so exactly one
      // node in the path latches it — the one the pointer is actually on.
      if (isClosestCanvasNodeTarget(e.target, e.currentTarget) && !isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        onNodePointerDown(nodeId)
      }
      if (!suppressesFormControls || !shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) {
        // A press this node does not suppress still STARTS a new gesture, so
        // whatever the last one latched is over.
        setSuppressedPointerTarget(null)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setSuppressedPointerTarget(e.currentTarget)
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onMouseDownCapture: (e) => {
      if (!suppressesFormControls || !shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) {
        setSuppressedPointerTarget(null)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      // The compatibility mousedown for a pointerdown this gesture already
      // acted on. Deliberately does NOT clear the latch: the click still to
      // come belongs to the same gesture.
      if (isSuppressedPointerTarget(e.currentTarget)) return
      setSuppressedPointerTarget(e.currentTarget)
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onPointerUpCapture: (e) => {
      // The release half. Reported against THIS node whatever the component
      // did to its own DOM in between — see `onNodePointerDown`'s doc for why
      // the player cannot wait for the `click`.
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      onNodePointerUp(nodeId)
    },
    onFocusCapture: (e) => {
      // A live frame is the page as a visitor gets it: blurring every field
      // the instant it is focused is exactly what made nothing typeable there.
      if (!suppressesFormControls) return
      if (!shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) return
      if (isFocusableElement(e.target)) e.target.blur()
    },
    onClickCapture: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      // Always: an authored `<a href>` must not navigate the frame away.
      e.preventDefault()
      // Only on an EDITING surface — see `ownsAuthoredEvents`.
      if (ownsAuthoredEvents) e.stopPropagation()
      // CLOSES the gesture a suppressed pointerdown opened.
      if (takeSuppressedPointerTarget(e.currentTarget)) return
      // The bubble-phase twin below sees the same native event a moment later
      // whenever propagation was left alive — see `canvasNodeGestureLatch`.
      markClickActivated(ownsAuthoredEvents ? null : (e as unknown as React.MouseEvent).nativeEvent)
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onClick: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      if (ownsAuthoredEvents) e.stopPropagation()
      if (takeActivatedClick((e as unknown as React.MouseEvent).nativeEvent)) return
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onDoubleClickCapture: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      handleNodeDoubleClick(nodeId, e as unknown as React.MouseEvent)
    },
    onDoubleClick: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleNodeDoubleClick(nodeId, e as unknown as React.MouseEvent)
    },
    onContextMenuCapture: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      handleNodeContextMenu(nodeId, e as unknown as React.MouseEvent)
    },
    onContextMenu: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleNodeContextMenu(nodeId, e as unknown as React.MouseEvent)
    },
    onKeyDown: (e) => {
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      // Editable-target guard: the canvas treats Enter / Space as
      // "click this node" so a focused-but-not-clicked node can be
      // activated from the keyboard. When the keystroke originates from
      // an `<input>` / `<textarea>` / `[contenteditable]` (e.g. a form
      // field the author placed inside their page), we leave the
      // keystroke alone so it can land in the field.
      if (isEditableTextTarget(e.target)) return
      // instance-ui-01 — Enter belongs to the instance-entry gesture (Figma's
      // "Enter steps INTO the component") whenever the current selection is a
      // `studio.instance`. A browser pass is what caught this: an instance
      // renders no element, so DOM focus after selecting one sits on whatever
      // was last clicked — often the iframe `<body>`, which is itself a canvas
      // node with this very handler. Enter therefore fired "click me" on the
      // BODY, replacing the instance selection with the page root, and by the
      // time the parent-document listener (`useCanvasSelectionKeyboard`) saw the
      // bridged keystroke the selection was no longer an instance, so nothing
      // was entered and the following Escape had nothing to step out of.
      // Yielding here cannot strand the keystroke: `useCanvasSelectionKeyboard`
      // is unconditionally mounted for the same editable, non-live canvas.
      if (e.key === 'Enter') {
        const state = useEditorStore.getState()
        const selectedId = state.selectedNodeId
        const selected = selectedId ? selectCanvasPageFor(state, contextPageId, frameId)?.nodes[selectedId] : null
        if (selected?.moduleId === 'studio.instance') return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleNodeClick(nodeId, e as unknown as React.MouseEvent)
      }
    },
    onMouseEnter: () => handleNodeHover(nodeId),
    onMouseLeave: () => handleNodeHover(null),
  }

  // Inline editing: this node's element becomes the contentEditable surface.
  // The binding seeds it from the frozen initial value and reads edits back
  // out; the live commit flows through `applyInlineEditValue` (coalesced into
  // one undo entry). While editing we strip the selection/click/dblclick
  // handlers from the element so native caret placement and text selection
  // work — only the data attributes (needed by the selection-ring overlay)
  // and inline style remain.
  const inlineEditBinding: InlineEditBinding | undefined = isInlineEditing
    ? {
        ref: editableRef,
        onInput: (e) =>
          useEditorStore.getState().applyInlineEditValue(readInlineEditableText(e.currentTarget as HTMLElement)),
        onKeyDown: (e) => {
          const state = useEditorStore.getState()
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            state.cancelInlineEdit()
            return
          }
          if (e.key === 'Enter') {
            // Cmd/Ctrl+Enter always commits. Plain Enter commits for
            // single-line modules; for multiline it falls through so the
            // browser inserts the hard break the author wants.
            if (e.metaKey || e.ctrlKey || !state.activeInlineEdit?.multiline) {
              e.preventDefault()
              state.endInlineEdit()
            }
          }
        },
        onBlur: () => useEditorStore.getState().endInlineEdit(),
      }
    : undefined

  const effectiveWrapperProps: NodeWrapperPropsType = isInlineEditing
    ? {
        'data-node-id': nodeId,
        'data-module-id': node.moduleId,
        ...(isSelected ? { 'data-canvas-selected': 'true' as const } : {}),
        ...(inlineStyle ? { style: inlineStyle } : {}),
      }
    : nodeWrapperProps

  // Per-module isolation: a buggy module render must not collapse the
  // entire canvas. The boundary scope is per-module render path; the rest
  // of the page tree keeps working. resetKeys on the moduleId means an
  // editor swap to a different module clears any stuck error.
  // The boundary renders its fallback in place and stays silent — that is
  // now the default for every seam but `admin-shell`, so the explicit
  // `silentToast` this used to carry is gone.
  return (
    <ErrorBoundary location="node-renderer" resetKeys={[node.moduleId, nodeId]}>
      {shouldRenderSandbox ? (
        <ModuleSandboxFrame
          moduleDefinition={definition}
          props={effectiveProps}
          nodeId={nodeId}
          isSelected={isSelected}
          mcClassName={mcClassName}
          classIds={effectiveClassIds}
        />
      ) : (
        <ComponentType
          props={effectiveProps as never}
          nodeId={nodeId}
          isSelected={isSelected}
          mcClassName={mcClassName}
          nodeWrapperProps={effectiveWrapperProps}
          codeProps={node.codeProps}
          codeFunctionPaths={node.codeFunctionPaths}
          inlineEdit={inlineEditBinding}
        >
          {isInlineEditing ? undefined : children}
        </ComponentType>
      )}
    </ErrorBoundary>
  )
})

// ---------------------------------------------------------------------------
// Loop iteration preview
// ---------------------------------------------------------------------------

interface LoopIterationsPreviewProps {
  node: PageNode
  baseTemplateContext?: TemplateRenderDataContext
}

/**
 * Render a `base.loop` node's children once per real iteration item.
 *
 * Mirrors the publisher's `renderLoop()` in `src/core/publisher/render.ts`:
 *   - Round-robin children when N variants × M items.
 *   - Augmented `templateContext` per iteration via Context.Provider, so
 *     dynamic bindings inside the loop body resolve to the iteration's
 *     `currentEntry`.
 *
 * Iteration data comes from `useLoopPreviewItems`, which dispatches per
 * source: built-in sources (`content.entries`, `site.media`) fetch real
 * data via the CMS API; in-memory sources (`site.pages`) read directly
 * from the store; plugin sources fall back to their `preview()` method.
 *
 * Empty result (source not picked yet, no rows, fetch in flight) renders
 * nothing — same as the publisher's empty-loop behaviour. Once data
 * arrives the component re-renders with real iterations.
 */
function LoopIterationsPreview({ node, baseTemplateContext }: LoopIterationsPreviewProps) {
  const items = useLoopPreviewItems(node)
  if (items.length === 0) return null

  const baseStack = baseTemplateContext?.entryStack ?? []
  return (
    <>
      {items.map((item, i) => {
        const variantId = node.children[i % node.children.length]
        // Preserve the parent's `page` / `site` / `viewer` / `route`
        // frames so bindings against those sources keep resolving
        // inside loop iterations. Only the entry stack changes per
        // iteration — push the iteration item on top.
        const augmentedContext: TemplateRenderDataContext = {
          ...baseTemplateContext,
          entryStack: [...baseStack, item],
        }
        return (
          <CanvasTemplateContext.Provider
            key={`${variantId}-${i}-${item.id}`}
            value={augmentedContext}
          >
            <NodeRenderer nodeId={variantId} />
          </CanvasTemplateContext.Provider>
        )
      })}
    </>
  )
}

// NodeWrapper as a wrapping `<div>` is gone. The editor attributes and
// handlers it used to host are now in `nodeWrapperProps` (built up above and
// passed into each module's component). The publisher emits the same root
// element the canvas does, so the canvas DOM matches the published DOM 1:1.

// The DOM event-target predicates this component's handlers rely on live in
// `./canvasEventTargets` — a separate reason to change (classifying a target,
// not rendering a node), and what brought this module back under the size
// ceiling.

// The per-gesture latches that collapse pointerdown / mousedown / click into
// ONE activation live in `./canvasNodeGestureLatch`.
