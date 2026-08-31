/**
 * StickyNoteView — one selectable, draggable, resizable, colourable,
 * inline-editable sticky note.
 *
 * Pointer behaviour (select, drag-move with snapping, drag-resize) is not
 * implemented here: it is `useAnnotationInteraction`, shared with
 * `DocBlockView`. This file owns what a NOTE is — its colour identity, its
 * auto-fitting text, its chrome and its context menu.
 *
 * Editing: a note is selected by one click and edited by clicking it AGAIN
 * (or by double-clicking, from any state). That two-step is deliberate and is
 * how Miro and Figma both behave — on an infinite canvas a single click is
 * how you pick something up, so making the first click also enter a text
 * caret makes the note impossible to select without risking an edit. Blur or
 * Escape commits; Escape additionally restores the pre-edit text.
 *
 * The editing session is local state, NOT `inlineEditSlice` — that slice is
 * page-tree specific and a note is board furniture, not a node.
 *
 * Text auto-fits the note's box (`useAutoFitText`), which is why there is no
 * font-size control here: on a sticky, you resize the note.
 *
 * The note is drawn as a physical object — an opaque pastel square with dark
 * ink, centred text, no border, and a tight contact shadow — not as an admin
 * surface. The colour tokens behind that are deliberately theme-independent;
 * see `--note-*` in `globals.css`.
 *
 * `memo()`'d (React Compiler exception #2 — a hot, list-rendered component;
 * see `NodeRenderer.tsx`'s identical justification): `BoardNotesLayer`
 * re-renders on every write to `board.notes`, and every OTHER note's `note`
 * prop stays referentially stable across that write (`moveNote`/`upsertNote`
 * in `boardsModel.ts` `.map()`-replace only the touched note, reusing every
 * sibling's object reference), so this bailout skips every note not
 * involved in the write. Every other prop this reads comes from its OWN
 * `useEditorStore` subscriptions (e.g. `selected`), not from a parent-bound
 * closure, so there is nothing here for the memo to be defeated by.
 */
import { useEffect, useRef, useState, memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { StickyNote, NoteColor } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { isAnnotationSelected } from '@site/store/slices/boardAnnotationSliceActions'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import { useAnnotationInteraction } from '../useAnnotationInteraction'
import { RESIZE_HANDLES } from '../rectResize'
import { useAutoFitText } from './useAutoFitText'
import styles from './StickyNoteView.module.css'

const NOTE_COLORS: NoteColor[] = ['yellow', 'green', 'blue', 'pink', 'gray']

/** Pointer travel (screen px) beyond which a gesture is a drag, not a click. */
const DRAG_SLOP_PX = 3

const COLOR_LABELS: Record<NoteColor, string> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
  gray: 'Gray',
}

interface StickyNoteViewProps {
  note: StickyNote
}

function StickyNoteViewImpl({ note }: StickyNoteViewProps) {
  const moveNote = useEditorStore((s) => s.moveNote)
  const updateNoteText = useEditorStore((s) => s.updateNoteText)
  const setNoteColor = useEditorStore((s) => s.setNoteColor)
  const removeNote = useEditorStore((s) => s.removeNote)
  const duplicateSelectedAnnotations = useEditorStore((s) => s.duplicateSelectedAnnotations)
  const reorderSelectedAnnotations = useEditorStore((s) => s.reorderSelectedAnnotations)
  const selected = useEditorStore((s) => isAnnotationSelected(s.selectedAnnotations, { kind: 'note', id: note.id }))

  const textRef = useRef<HTMLDivElement>(null)
  const textBoxRef = useRef<HTMLDivElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  // The text as it was when editing began — Escape restores it.
  const preEditTextRef = useRef(note.text)
  // Whether this gesture is a click on an already-selected note (which opens
  // the editor on release) and whether it has since travelled far enough to be
  // a drag instead. The slop is what stops the sub-pixel movement of an
  // ordinary trackpad click from reading as a drag.
  const pendingEditRef = useRef(false)
  const movedRef = useRef(false)
  const downPointRef = useRef({ x: 0, y: 0 })

  const interaction = useAnnotationInteraction({
    ref: { kind: 'note', id: note.id },
    rect: { x: note.x, y: note.y, w: note.w, h: note.h },
    onMove: (x, y) => moveNote(note.id, x, y),
  })

  useAutoFitText(textRef, textBoxRef, note.text)

  // Focus the text element the moment it becomes contentEditable, and put the
  // caret at the end rather than at position 0 — a note you re-open to append
  // to is the common case.
  useEffect(() => {
    if (!isEditing) return
    const el = textRef.current
    if (!el) return
    el.focus()
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [isEditing])

  const beginEditing = () => {
    preEditTextRef.current = note.text
    setIsEditing(true)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-note-chrome]')) return
    // While editing, the text owns the pointer so a click inside it places a
    // caret instead of starting a drag.
    if (isEditing && target.closest('[data-note-text]')) return
    if (e.button !== 0) return

    downPointRef.current = { x: e.clientX, y: e.clientY }
    movedRef.current = false
    // A click on an ALREADY-selected note opens the editor — but only on
    // pointerUP, and only if the pointer never travelled: deciding here would
    // enter an edit at the start of every drag. Read BEFORE `select`, so the
    // same click cannot both select and edit.
    pendingEditRef.current = selected && !e.shiftKey && !e.metaKey && !e.ctrlKey
    interaction.select(e)
    interaction.startMove(e)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (
      Math.abs(e.clientX - downPointRef.current.x) > DRAG_SLOP_PX ||
      Math.abs(e.clientY - downPointRef.current.y) > DRAG_SLOP_PX
    ) {
      movedRef.current = true
    }
    interaction.onMovePointerMove(e)
    interaction.onResizePointerMove(e)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const shouldEdit = pendingEditRef.current && !movedRef.current
    pendingEditRef.current = false
    movedRef.current = false
    interaction.endDrag(e)
    if (shouldEdit) beginEditing()
  }

  const handleTextBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    // `innerText`, not `textContent`: pressing Enter in a contentEditable
    // inserts a `<div>` or `<br>`, and `textContent` concatenates across them —
    // a two-line note would commit as one run-on line. `innerText` is the
    // rendered text, line breaks included, which is what the note stores and
    // what `white-space: pre-wrap` renders back. (jsdom implements only
    // `textContent`, hence the fallback.)
    const el = e.currentTarget
    updateNoteText(note.id, el.innerText ?? el.textContent ?? '')
    setIsEditing(false)
  }

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (textRef.current) textRef.current.textContent = preEditTextRef.current
      updateNoteText(note.id, preEditTextRef.current)
      setIsEditing(false)
      return
    }
    // Every other key belongs to the text — never to the canvas's own
    // Delete / Cmd+D / arrow-key handlers.
    e.stopPropagation()
  }

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    // Right-clicking an unselected note selects it first, so the menu's
    // selection-wide actions (duplicate, reorder) act on what was clicked.
    if (!selected) interaction.select({ shiftKey: false, metaKey: false, ctrlKey: false })
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <>
      <div
        className={cn(styles.note, selected && styles.noteSelected)}
        data-note-color={note.color}
        // Marquee hit-testing reads these (`measureAnnotationRects` in
        // `useMarqueeSelection.ts`), which is why they are on the outer box.
        data-annotation-kind="note"
        data-annotation-id={note.id}
        data-testid="sticky-note"
        // Board-coordinate placement — the note lives inside CanvasTransformLayer,
        // which already carries the pan/zoom transform, so these are plain board
        // units with no manual pan/zoom math. Set as CSS custom properties (not
        // raw left/top/width/height) so the module reads them back via var(--x)
        // per the project's inline-style convention.
        style={{
          '--note-x': `${note.x}px`,
          '--note-y': `${note.y}px`,
          '--note-w': `${note.w}px`,
          '--note-h': `${note.h}px`,
          '--annotation-z': note.z ?? 0,
        } as CSSProperties}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(e) => { pendingEditRef.current = false; interaction.endDrag(e) }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('[data-note-chrome]')) return
          beginEditing()
        }}
        onContextMenu={handleContextMenu}
      >
        <div className={styles.chrome} data-note-chrome>
          <div className={styles.swatches}>
            {NOTE_COLORS.map((color) => (
              <Button
                key={color}
                variant="ghost"
                size="micro"
                iconOnly
                pressed={color === note.color}
                aria-label={`Set note color to ${COLOR_LABELS[color]}`}
                className={styles.swatch}
                style={{ '--swatch-color': `var(--note-${color})` } as CSSProperties}
                onClick={() => setNoteColor(note.id, color)}
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="micro"
            iconOnly
            tone="danger"
            aria-label="Delete note"
            onClick={() => removeNote(note.id)}
          >
            <CloseIcon size={11} aria-hidden="true" />
          </Button>
        </div>

        {/* Box and text are separate elements — the box centres and clips, the
            text is what `useAutoFitText` measures and sizes. See that hook. */}
        <div ref={textBoxRef} className={styles.textBox} data-note-text>
          <div
            ref={textRef}
            className={styles.text}
            data-empty={!isEditing && !note.text ? 'true' : undefined}
            contentEditable={isEditing}
            suppressContentEditableWarning
            onBlur={handleTextBlur}
            onKeyDown={handleTextKeyDown}
          >
            {note.text || (isEditing ? '' : 'Double-click to edit')}
          </div>
        </div>

        {/* Resize handles — selected note only, mirroring a board frame's
            own selected-only handles. See rectResize.ts for the geometry. */}
        {selected && !isEditing && RESIZE_HANDLES.map((handle) => (
          <div
            key={handle}
            className={styles.resizeHandle}
            data-handle={handle}
            data-note-chrome
            onPointerDown={interaction.startResize(handle)}
            onPointerMove={interaction.onResizePointerMove}
            onPointerUp={interaction.endDrag}
            onPointerCancel={interaction.endDrag}
          />
        ))}
      </div>

      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Sticky note options"
          animateExit
          onClose={() => setContextMenu(null)}
        >
          <ContextMenuItem onClick={() => { setContextMenu(null); beginEditing() }}>
            Edit text
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { setContextMenu(null); duplicateSelectedAnnotations() }}>
            <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
            Duplicate
          </ContextMenuItem>
          <ContextMenuSeparator />
          {NOTE_COLORS.map((color) => (
            <ContextMenuItem
              key={color}
              selected={color === note.color}
              onClick={() => { setContextMenu(null); setNoteColor(note.id, color) }}
            >
              <span
                className={styles.menuSwatch}
                style={{ '--swatch-color': `var(--note-${color})` } as CSSProperties}
                aria-hidden="true"
              />
              {COLOR_LABELS[color]}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => { setContextMenu(null); reorderSelectedAnnotations('front') }}>
            Bring to front
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { setContextMenu(null); reorderSelectedAnnotations('back') }}>
            Send to back
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger onClick={() => { setContextMenu(null); removeNote(note.id) }}>
            <span aria-hidden="true"><CloseIcon size={13} /></span>
            Delete
          </ContextMenuItem>
        </ContextMenu>,
        document.body,
      )}
    </>
  )
}

export const StickyNoteView = memo(StickyNoteViewImpl)
