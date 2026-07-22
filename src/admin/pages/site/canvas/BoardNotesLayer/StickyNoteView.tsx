/**
 * StickyNoteView — one draggable, colorable, inline-editable sticky note.
 *
 * Drag: pointerdown on the note body (excluding the color swatches, delete
 * button, and — while editing — the text itself) starts a drag; pointer
 * capture keeps the move/up handlers firing even if the cursor leaves the
 * note. Screen-space deltas are divided by the canvas `zoom` so the note
 * tracks the cursor 1:1 regardless of zoom level.
 *
 * Edit: double-click enters an editing state that makes the text `contentEditable`
 * and focuses it; blur commits via `updateNoteText` and leaves editing. This is a
 * local editing session only — it does NOT reuse `inlineEditSlice`, which is
 * page-tree specific.
 *
 * Chrome (color swatches + delete) is CSS-only hover/focus-visible, so no
 * extra React state/re-renders are needed to show/hide it.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { StickyNote, NoteColor } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import styles from './StickyNoteView.module.css'

const NOTE_COLORS: NoteColor[] = ['yellow', 'green', 'blue', 'pink', 'gray']

interface StickyNoteViewProps {
  note: StickyNote
}

interface DragState {
  pointerId: number
  startClientX: number
  startClientY: number
  noteX: number
  noteY: number
}

export function StickyNoteView({ note }: StickyNoteViewProps) {
  const moveNote = useEditorStore((s) => s.moveNote)
  const updateNoteText = useEditorStore((s) => s.updateNoteText)
  const setNoteColor = useEditorStore((s) => s.setNoteColor)
  const removeNote = useEditorStore((s) => s.removeNote)

  const dragRef = useRef<DragState | null>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [isEditing, setIsEditing] = useState(false)

  // Focus the text element the moment it becomes contentEditable.
  useEffect(() => {
    if (isEditing) textRef.current?.focus()
  }, [isEditing])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-note-chrome]')) return
    if (isEditing && target.closest('[data-note-text]')) return

    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      noteX: note.x,
      noteY: note.y,
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return

    const zoom = useEditorStore.getState().zoom
    const dx = (e.clientX - drag.startClientX) / zoom
    const dy = (e.clientY - drag.startClientY) / zoom
    moveNote(note.id, drag.noteX + dx, drag.noteY + dy)
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-note-chrome]')) return
    setIsEditing(true)
  }

  const handleTextBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    updateNoteText(note.id, e.currentTarget.textContent ?? '')
    setIsEditing(false)
  }

  return (
    <div
      className={styles.note}
      data-note-color={note.color}
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
      } as CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={handleDoubleClick}
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
              aria-label={`Set note color to ${color}`}
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
          ×
        </Button>
      </div>

      <div
        ref={textRef}
        className={styles.text}
        data-note-text
        contentEditable={isEditing}
        suppressContentEditableWarning
        onBlur={handleTextBlur}
      >
        {note.text || (isEditing ? '' : 'Double-click to edit')}
      </div>
    </div>
  )
}
