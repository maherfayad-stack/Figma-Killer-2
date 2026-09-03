/**
 * DocBlockView — one selectable, draggable, resizable, rich-text doc card.
 *
 * Pointer behaviour (select, drag-move with snapping, drag-resize) is
 * `useAnnotationInteraction`, shared with `StickyNoteView`. This file owns what
 * a DOC is: its header, its rich-text editing session, and its context menu.
 *
 * Drag handle: the header bar only. The body carries no move handler, so
 * dragging inside it selects text rather than moving the card — which is what
 * a read-heavy surface has to do. (A sticky note, being small and read-light,
 * is dragged by its whole body instead.)
 *
 * Editing: a card is selected by one click and edited by clicking it AGAIN,
 * or by double-clicking from any state — the same two-step `StickyNoteView`
 * documents, for the same reason. While editing, the body becomes
 * `contentEditable` and `DocToolbar` floats above the card. Escape commits and
 * exits.
 *
 * Rich text, not markdown: `doc.html` is sanitized HTML. It is sanitized on
 * WRITE (`updateDocHtml` in the store) and again on RENDER here — the second
 * pass is not redundant, it covers a hand-edited `.studio/boards.json` that
 * never went through the store at all.
 *
 * `memo()`'d (React Compiler exception #2 — a hot, list-rendered component;
 * see `NodeRenderer.tsx`'s / `StickyNoteView.tsx`'s identical
 * justification): `BoardDocsLayer` re-renders on every write to
 * `board.docs`, and every OTHER doc's `doc` prop stays referentially stable
 * across that write (`moveDoc`/`upsertDoc` in `boardsModel.ts` `.map()`-
 * replace only the touched doc), so this bailout skips every card not
 * involved in the write.
 */
import { useCallback, useEffect, useRef, useState, memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { docContentScale, type DocBlock } from '@core/studio-board'
import { sanitizeBoardDocHtml } from '@core/sanitize'
import { useEditorStore } from '@site/store/store'
import { isAnnotationSelected } from '@site/store/slices/boardAnnotationSliceActions'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { cn } from '@ui/cn'
import { useAnnotationInteraction } from '../useAnnotationInteraction'
import { RESIZE_HANDLES } from '../rectResize'
import { DocToolbar } from './DocToolbar'
import { DocLinkDialog } from './DocLinkDialog'
import { createLink } from './docRichText'
import styles from './DocBlockView.module.css'

interface DocBlockViewProps {
  doc: DocBlock
}

function DocBlockViewImpl({ doc }: DocBlockViewProps) {
  const moveDoc = useEditorStore((s) => s.moveDoc)
  const updateDocHtml = useEditorStore((s) => s.updateDocHtml)
  const removeDoc = useEditorStore((s) => s.removeDoc)
  const duplicateSelectedAnnotations = useEditorStore((s) => s.duplicateSelectedAnnotations)
  const reorderSelectedAnnotations = useEditorStore((s) => s.reorderSelectedAnnotations)
  const selected = useEditorStore((s) => isAnnotationSelected(s.selectedAnnotations, { kind: 'doc', id: doc.id }))

  // The card element is STATE, not a ref: `DocToolbar` receives it as a prop
  // (it anchors to the card's on-screen rect), and reading `ref.current`
  // during render is exactly the "component may not update as expected"
  // hazard `react-hooks/refs` flags — the toolbar would mount against
  // whatever the ref held on the render that happened to run.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)

  const interaction = useAnnotationInteraction({
    ref: { kind: 'doc', id: doc.id },
    rect: { x: doc.x, y: doc.y, w: doc.w, h: doc.h },
    onMove: (x, y) => moveDoc(doc.id, x, y),
  })

  const renderedHtml = sanitizeBoardDocHtml(doc.html)

  /**
   * Writes the editable element's CURRENT html back to the store. Called on
   * blur, on Escape, and after every toolbar command — a toolbar command
   * mutates the DOM directly through `execCommand`, so nothing else would ever
   * observe the change.
   */
  // Exception #1 (react-compiler-and-memoization): both are named in the
  // outside-click effect's dependency array below, where the static
  // exhaustive-deps rule cannot see the compiler's memoization.
  const commit = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    updateDocHtml(doc.id, el.innerHTML)
  }, [doc.id, updateDocHtml])

  // Seed the editable element from the store exactly once per editing session,
  // then leave it alone: React must not re-render children it does not own
  // while the browser holds a caret inside them, and `renderedHtml` changes on
  // every commit — which is this component writing back its OWN value, so
  // re-seeding from it would fight the caret on every keystroke.
  //
  // The once-per-session guard is a ref rather than a trimmed dependency
  // array: silencing `exhaustive-deps` here would make the React Compiler skip
  // optimizing this whole component (it declines to compile anything with a
  // disabled rule of React), which is a real cost for a cosmetic win.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!isEditing) {
      seededRef.current = false
      return
    }
    if (seededRef.current) return
    const el = bodyRef.current
    if (!el) return
    seededRef.current = true
    el.innerHTML = renderedHtml
    el.focus()
  }, [isEditing, renderedHtml])

  const beginEditing = () => setIsEditing(true)

  const endEditing = useCallback(() => {
    commit()
    setIsEditing(false)
  }, [commit])

  /**
   * Ends the session on a pointerdown outside the card — NOT on the editable
   * element's `blur`.
   *
   * Blur was the obvious choice and is wrong: the formatting toolbar is
   * portaled to `document.body`, so focusing one of its `<Select>`s blurs the
   * editor, which committed and unmounted the toolbar mid-click. Every
   * dropdown in it was unusable for that reason. An outside-click check can
   * ask the question that actually matters — "is the thing you just pressed
   * part of this editing session?" — which a blur event cannot, because a
   * portaled menu is not a DOM descendant of anything it belongs to.
   *
   * Capture phase, so the session ends before the click reaches whatever it
   * landed on (another card, the canvas background).
   */
  useEffect(() => {
    if (!isEditing) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (cardEl?.contains(target)) return
      if (target.closest('[data-doc-toolbar]')) return
      // A Select's listbox, the link dialog, a context menu — all portaled,
      // all still this session.
      if (target.closest('[role="dialog"],[role="listbox"],[role="menu"]')) return
      endEditing()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [isEditing, endEditing, cardEl])

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-doc-chrome]')) return
    if (e.button !== 0) return
    interaction.select(e)
    interaction.startMove(e)
  }

  const handleBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isEditing) return
    if (e.button !== 0) return
    // A click on an already-selected card opens the editor. The body has no
    // move gesture (see module doc), so unlike the sticky note there is no
    // drag to distinguish this from — the decision can be made immediately.
    const wasSelected = selected
    interaction.select(e)
    if (wasSelected && !e.shiftKey && !e.metaKey && !e.ctrlKey) beginEditing()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      endEditing()
      return
    }
    // Every other key belongs to the text, never to the canvas's Delete /
    // Cmd+D / arrow-key handlers.
    e.stopPropagation()
  }

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isEditing) return
    e.preventDefault()
    e.stopPropagation()
    if (!selected) interaction.select({ shiftKey: false, metaKey: false, ctrlKey: false })
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <>
      <div
        ref={setCardEl}
        className={cn(styles.doc, selected && styles.docSelected)}
        // Marquee hit-testing reads these — see `StickyNoteView`'s note.
        data-annotation-kind="doc"
        data-annotation-id={doc.id}
        data-testid="doc-block"
        // Board-coordinate placement — the doc card lives inside
        // CanvasTransformLayer, which already carries the pan/zoom transform,
        // so these are plain board units with no manual pan/zoom math. Set as
        // CSS custom properties (not raw left/top/width/height) so the module
        // reads them back via var(--x) per the project's inline-style convention.
        style={{
          '--doc-x': `${doc.x}px`,
          '--doc-y': `${doc.y}px`,
          '--doc-w': `${doc.w}px`,
          '--doc-h': `${doc.h}px`,
          // How much to magnify the card's text. Derived from the card's own
          // width rather than stored, so resizing IS the control and there is
          // no second source of truth to keep in step. See `docContentScale`.
          '--doc-scale': docContentScale(doc.w),
          '--annotation-z': doc.z ?? 0,
        } as CSSProperties}
        onContextMenu={handleContextMenu}
      >
        <div
          className={styles.header}
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={interaction.onMovePointerMove}
          onPointerUp={interaction.endDrag}
          onPointerCancel={interaction.endDrag}
          onDoubleClick={beginEditing}
        >
          <span className={styles.title}>Doc</span>
          <div className={styles.chrome} data-doc-chrome>
            <Button
              variant="ghost"
              size="micro"
              iconOnly
              tone="danger"
              aria-label="Delete doc card"
              // Stop the pointerdown reaching the header's drag handler so a
              // click on delete never starts a drag.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => removeDoc(doc.id)}
            >
              <CloseIcon size={11} aria-hidden="true" />
            </Button>
          </div>
        </div>

        {/*
          The three states share one scroll box, and each renders under its OWN
          key. The keys are load-bearing, not tidiness.

          React reconciles by position and element type, so without them the
          editor `<div>` and the reader `<div>` are the SAME host instance —
          React keeps the DOM node and just swaps its props. That node's
          children, however, are not React's: the editor writes them with
          `el.innerHTML`. Leaving the session, React therefore believed the node
          had no children, mounted the reader's markup, and APPENDED it — the
          card showed everything twice, once unstyled (the leftover, which no
          longer had `.rendered` on it) and once styled. Distinct keys force an
          unmount, which takes the imperative DOM with it.
        */}
        <div className={styles.body} onPointerDown={isEditing ? undefined : handleBodyPointerDown}>
          {isEditing ? (
            <div
              key="editor"
              ref={bodyRef}
              className={cn(styles.rendered, styles.editing)}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="Doc content"
              onKeyDown={handleKeyDown}
            />
          ) : doc.html.trim() ? (
            <div key="reader" className={styles.rendered} dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          ) : (
            <div key="placeholder" className={styles.placeholder}>Double-click to write docs</div>
          )}
        </div>

        {/* Resize handles — selected card only. See rectResize.ts for the geometry. */}
        {selected && !isEditing && RESIZE_HANDLES.map((handle) => (
          <div
            key={handle}
            className={styles.resizeHandle}
            data-handle={handle}
            data-doc-chrome
            onPointerDown={interaction.startResize(handle)}
            onPointerMove={interaction.onResizePointerMove}
            onPointerUp={interaction.endDrag}
            onPointerCancel={interaction.endDrag}
          />
        ))}
      </div>

      {isEditing && (
        <DocToolbar
          anchor={cardEl}
          onCommand={commit}
          onRequestLink={() => setLinkDialogOpen(true)}
        />
      )}

      <DocLinkDialog
        open={linkDialogOpen}
        onClose={() => setLinkDialogOpen(false)}
        onSubmit={(href) => {
          setLinkDialogOpen(false)
          bodyRef.current?.focus()
          createLink(href)
          commit()
        }}
      />

      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Doc card options"
          animateExit
          onClose={() => setContextMenu(null)}
        >
          <ContextMenuItem onClick={() => { setContextMenu(null); beginEditing() }}>
            Edit
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { setContextMenu(null); duplicateSelectedAnnotations() }}>
            <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
            Duplicate
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => { setContextMenu(null); reorderSelectedAnnotations('front') }}>
            Bring to front
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { setContextMenu(null); reorderSelectedAnnotations('back') }}>
            Send to back
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger onClick={() => { setContextMenu(null); removeDoc(doc.id) }}>
            <span aria-hidden="true"><CloseIcon size={13} /></span>
            Delete
          </ContextMenuItem>
        </ContextMenu>,
        document.body,
      )}
    </>
  )
}

export const DocBlockView = memo(DocBlockViewImpl)
