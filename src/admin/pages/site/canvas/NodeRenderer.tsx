/**
 * NodeRenderer — renders a single PageNode in the editor canvas.
 *
 * Performance notes (Contribution #312 + #495):
 * ─────────────────────────────────────────────
 * - memo() prevents re-renders when unrelated nodes change.
 * - Per-node Zustand selector: subscribes ONLY to the specific node's data.
 *   Editing node A never re-renders NodeRenderer for node B.
 * - Selection/hover handled via CanvasSelectionContext (no DOM event bubbling).
 * - selectedNodeId / hoveredNodeId are NOT in context (Perf fix #495): each
 *   NodeRenderer subscribes directly to its own boolean — only the 2 affected
 *   nodes re-render per selection/hover event (O(2) not O(N)).
 * - Zustand re-runs EVERY subscriber's selector on EVERY store set, so the
 *   per-node selectors below must be O(1)-ish per sweep: the active-page
 *   resolution is single-slot memoized in `selectActivePage`, the
 *   form-preview helpers cache their parent index per tree identity, and
 *   `getCanvasNodeClassIds` passes the node's own array through untouched
 *   when no preview applies — selector outputs stay referentially stable.
 */

import { memo, use, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { InlineEditBinding } from '@core/module-engine'
import { readInlineEditableText, seedInlineEditableContent } from '@modules/base/shared/inlineText'
import { useEditorStore, selectCanvasPageFor } from '@site/store/store'
import { resolveProps } from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { NodeWrapperProps as NodeWrapperPropsType } from '@core/module-engine'
import { resolveDynamicProps, effectiveNodeBindings, type TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { PageNode } from '@core/page-tree'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { ModuleSandboxFrame } from './ModuleSandboxFrame'
import {
  focusNodeWithoutScrolling,
  isCanvasEditorControlTarget,
  isClosestCanvasNodeTarget,
  isEditableTextTarget,
  isFocusableElement,
  shouldSuppressAuthoredFormControlEvent,
} from './canvasEventTargets'
import { PackageComponentPlaceholder } from './PackageComponentPlaceholder'
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
import { findEnclosingComponentRef, findEnclosingInstance, type AnnotatedPageNode } from './canvasSelectionUtils'
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
  // surface means "select this node". Same switch `useCanvasFormControlSuppression`
  // reads at the document level; the node-level handlers below were the one
  // place still applying the design rule to both.
  const suppressesFormControls = use(CanvasInteractionContext) !== 'live'
  // Per-node subscription — editing this node's props only re-renders THIS
  // component. `frameId` (§4.4/Phase 4) lets a locale-variant frame read
  // `localizedPageSlice.ts`'s tree instead of `site.pages` — see
  // `selectCanvasPageFor`'s own doc.
  const node = useEditorStore((s) => selectCanvasPageFor(s, contextPageId, frameId)?.nodes[nodeId] ?? null)
  const templateContext = use(CanvasTemplateContext)

  // Per-node selection/hover subscriptions (Perf fix — Contribution #495).
  // Only the 2 nodes whose boolean flips will re-render on any selection/hover
  // event. Context carries only stable callbacks — no context-driven re-renders.
  //
  // Multi-select: this checks `selectedNodeIds.includes(nodeId)` so every node
  // in a multi-selection shows the selection ring. The selector still resolves
  // to a boolean, so per-node memoization isn't disturbed — only rows whose
  // `includes(nodeId)` result flips will re-render.
  //
  // WS-10 Phase 2 — `selectedNodeFrameId`/`hoveredFrameId` scope to the
  // originating BoardFrame ("null means global", mirroring `hoveredBreakpointId`)
  // so a "duplicate as variant" sibling (same node ids, trap #2) doesn't light up.
  const isSelected = useEditorStore(
    (s) =>
      s.selectedNodeIds.includes(nodeId) &&
      (!s.selectedNodeFrameId || s.selectedNodeFrameId === frameId),
  )
  const isHovered = useEditorStore(
    (s) =>
      s.hoveredNodeId === nodeId &&
      (!s.hoveredBreakpointId || s.hoveredBreakpointId === breakpointId) &&
      (!s.hoveredFrameId || s.hoveredFrameId === frameId),
  )
  // Inline text edit session — true only in the SESSION'S frame. Gated on
  // `frameId` too, not just `breakpointId` (every board frame shares ONE
  // synthetic breakpoint id, `'studio'`) — without it, a "duplicate as
  // variant" sibling sharing this node id (trap #2) would ALSO show the
  // contentEditable surface. Closes `canvas-08`'s "Known gap" note — Phase 4
  // needs this correct, not just untested.
  const isInlineEditing = useEditorStore(
    (s) =>
      s.activeInlineEdit !== null &&
      s.activeInlineEdit.nodeId === nodeId &&
      s.activeInlineEdit.breakpointId === breakpointId &&
      s.activeInlineEdit.frameId === frameId,
  )
  // Session values, read as primitives so per-node memoization stays clean.
  // Both are constant for the whole session (initialValue seeds the frozen
  // content; multiline decides Enter's behaviour).
  const inlineEditInitialValue = useEditorStore((s) =>
    s.activeInlineEdit?.nodeId === nodeId &&
    s.activeInlineEdit.breakpointId === breakpointId &&
    s.activeInlineEdit.frameId === frameId
      ? s.activeInlineEdit.initialValue
      : null,
  )
  const inlineEditMultiline = useEditorStore((s) =>
    s.activeInlineEdit?.nodeId === nodeId &&
    s.activeInlineEdit.breakpointId === breakpointId &&
    s.activeInlineEdit.frameId === frameId
      ? s.activeInlineEdit.multiline
      : false,
  )
  const applyInlineEditValue = useEditorStore((s) => s.applyInlineEditValue)
  const endInlineEdit = useEditorStore((s) => s.endInlineEdit)
  const cancelInlineEdit = useEditorStore((s) => s.cancelInlineEdit)
  const editableRef = useRef<HTMLElement | null>(null)
  const previewClassAssignment = useEditorStore(
    (s) => s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null,
  )
  const editorFormPreviewState = useEditorStore((s) => resolveEditorFormPreviewState(s, nodeId))
  const editorFormPreviewSuccessMessage = useEditorStore((s) => resolveEditorFormPreviewSuccessMessage(s, nodeId))
  const mcClassName = useEditorStore((s) => {
    const canvasNode = selectCanvasPageFor(s, contextPageId, frameId)?.nodes[nodeId]
    const preview = s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null
    return getCanvasNodeClassName(canvasNode?.classIds, preview, nodeId, s.site?.styleRules)
  })
  const { onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick } = use(CanvasSelectionContext)

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

  // instance-ui-01 — Figma's "Enter / double-click enters it and selects the
  // inner node under the cursor": a double-click inside a not-yet-entered
  // instance enters it (pushes `enteredInstanceIds`) and selects the EXACT
  // descendant, bypassing `handleNodeClick`'s redirect and the module's
  // ordinary double-click (inline edit). Already-entered instance: falls
  // through to ordinary behaviour unchanged.
  const handleNodeDoubleClick = (clickedNodeId: string, e: React.MouseEvent) => {
    const state = useEditorStore.getState()
    const page = selectCanvasPageFor(state, contextPageId, frameId)
    if (page) {
      const enclosingInstance = findEnclosingInstance(page, clickedNodeId, state.enteredInstanceIds)
      if (enclosingInstance !== null) {
        state.enterInstance(enclosingInstance)
        onNodeClick(clickedNodeId, e, breakpointId, frameId)
        return
      }
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
    seedInlineEditableContent(el, inlineEditInitialValue ?? '')
    el.focus()
    const doc = el.ownerDocument
    const sel = doc.defaultView?.getSelection()
    if (!sel) return
    const range = doc.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }, [isInlineEditing, inlineEditInitialValue])

  const inlineStyle = useResponsiveBackgroundStyle(node?.inlineStyles)

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
      node.children.map((childId) => <NodeRenderer key={childId} nodeId={childId} />)
    )

  const ComponentType = definition.component
  const shouldRenderSandbox = Boolean(definition.editorRuntime?.sandbox && !definition.trusted)
  // Pass the module schema so resolveProps drops breakpoint overrides for
  // non-responsive (content) keys — text/tag/src etc. must look identical
  // across every breakpoint frame, since published HTML is one document.
  const effectiveProps = addEditorFormPreviewProps(
    node.moduleId,
    resolveDynamicProps(
    resolveProps(node, breakpointId, definition.schema),
    effectiveNodeBindings(node),
    templateContext,
    ),
    editorFormPreviewState,
    editorFormPreviewSuccessMessage,
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
    ...(isHovered && !isSelected ? { 'data-hovered': 'true' as const } : {}),
    onPointerDownCapture: (e) => {
      focusNodeWithoutScrolling(e.currentTarget, e.target, isInlineEditing)
      if (!suppressesFormControls || !shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) {
        // A press this node does not suppress still STARTS a new gesture, so
        // whatever the last one latched is over. Without this, a latch left
        // armed by a press that never became a click would swallow the next
        // click on that same element.
        latestSuppressedPointerTarget = null
        return
      }
      e.preventDefault()
      e.stopPropagation()
      latestSuppressedPointerTarget = e.currentTarget
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onMouseDownCapture: (e) => {
      if (!suppressesFormControls || !shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) {
        latestSuppressedPointerTarget = null
        return
      }
      e.preventDefault()
      e.stopPropagation()
      // The compatibility mousedown for a pointerdown this gesture already
      // acted on. Deliberately does NOT clear the latch: the click still to
      // come belongs to the same gesture.
      if (latestSuppressedPointerTarget === e.currentTarget) return
      latestSuppressedPointerTarget = e.currentTarget
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onFocusCapture: (e) => {
      if (!suppressesFormControls) return
      if (!shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) return
      if (isFocusableElement(e.target)) e.target.blur()
    },
    onClickCapture: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      // CLOSES the gesture a suppressed pointerdown opened. Without this, one
      // click on an authored control activated the node TWICE — harmless while
      // activation only meant "select this node", and not harmless at all once
      // the player made it mean "follow this link": every prototype link on a
      // button fired twice, pushing the same screen onto the stack twice, so
      // going back once landed on the screen you were already looking at.
      if (latestSuppressedPointerTarget === e.currentTarget) {
        latestSuppressedPointerTarget = null
        return
      }
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onClick: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
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
        onInput: (e) => applyInlineEditValue(readInlineEditableText(e.currentTarget as HTMLElement)),
        onKeyDown: (e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelInlineEdit()
            return
          }
          if (e.key === 'Enter') {
            // Cmd/Ctrl+Enter always commits. Plain Enter commits for
            // single-line modules; for multiline it falls through so the
            // browser inserts the hard break the author wants.
            if (e.metaKey || e.ctrlKey || !inlineEditMultiline) {
              e.preventDefault()
              endInlineEdit()
            }
          }
        },
        onBlur: () => endInlineEdit(),
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
  // silentToast: the canvas-level boundary already toasts; 100 nodes with
  // one bad module would otherwise produce 100 identical toasts per render.
  return (
    <ErrorBoundary
      location="node-renderer"
      resetKeys={[node.moduleId, nodeId]}
      silentToast
    >
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

// The node whose authored control the CURRENT pointer gesture suppressed, so
// that gesture activates it exactly once however many events it raises —
// pointerdown, then a compatibility mousedown, then the click. Set when the
// gesture opens, cleared by the click that ends it.
//
// Stays HERE, not in `canvasEventTargets`: that module is pure classification,
// and this is state only this component's own handlers write.
let latestSuppressedPointerTarget: EventTarget | null = null
