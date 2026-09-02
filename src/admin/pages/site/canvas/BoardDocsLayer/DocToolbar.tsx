/**
 * DocToolbar — the formatting bar shown while a doc card is being edited.
 *
 * Floats ABOVE the card, portaled to `document.body` at a fixed screen
 * position rather than rendered inside the card. Three reasons, all of which
 * bite immediately if it lives in the card:
 *   - the card lives inside `CanvasTransformLayer`, so an in-card toolbar
 *     would be scaled by the canvas zoom and unreadable at 40%;
 *   - it would take vertical space away from the text it is formatting;
 *   - it can then overhang a narrow card instead of being clipped by it.
 *
 * ## What is on the bar, and what is not
 *
 * Everything one click away is something you reach for while writing a
 * sentence: the block format, the four inline marks, a link, a colour. The
 * two things that are not — alignment and clear-formatting — are per-block
 * decisions made once, and they live behind the overflow menu.
 *
 * The two list kinds are IN the block-format `<Select>`, not separate toggles.
 * A block is a heading or a quote or a list, never two of those, and
 * `docRichText` has to enforce that anyway (see `DocBlockFormat`); putting
 * them in one control says so out loud and takes 56px off the bar. Earlier
 * versions carried font-family and font-size as well and were roughly half as
 * wide again as the card they formatted.
 *
 * ## How the text selection survives touching the toolbar
 *
 * `execCommand` acts on the document's LIVE selection, so a control that
 * collapses or moves it before its handler runs formats nothing. `run()`
 * therefore restores the last known in-card range before dispatching, and puts
 * focus back on the editable so the caret is usable for the next keystroke.
 *
 * The block `<Select>` is CONTROLLED by the caret's real format rather than
 * holding a value of its own. An uncontrolled one cannot re-apply the value it
 * already displays: after setting one paragraph to Heading 1, picking
 * "Heading 1" again with the caret in a plain paragraph is not a change event
 * at all.
 *
 * Suppressing focus is the wrong tool for anything richer than a plain button:
 * an earlier version put `onMouseDown={e => e.preventDefault()}` on the
 * toolbar container, which does keep the caret and also stops the `<Select>`
 * triggers from ever opening, since a custom listbox opens on the very
 * mousedown being cancelled. The plain buttons still suppress their own
 * mousedown as a cheap extra — it avoids a focus round-trip per click, and
 * nothing depends on it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { ColorInput } from '@ui/components/ColorInput'
import { Separator } from '@ui/components/Separator'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import {
  clearFormatting,
  isCommandActive,
  isSelectionInLink,
  readAlignment,
  readBlockFormat,
  removeLink,
  setAlignment,
  setBlockFormat,
  setTextColor,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleUnderline,
  DOC_BLOCK_FORMATS,
  type DocAlignment,
  type DocBlockFormat,
} from './docRichText'
import styles from './DocToolbar.module.css'

interface DocToolbarProps {
  /** The card element the toolbar anchors above. */
  anchor: HTMLElement | null
  /** Called after any command runs, so the card can persist the new HTML. */
  onCommand: () => void
  /** Asks the host for a link URL (a dialog — `prompt()` is banned repo-wide). */
  onRequestLink: () => void
}

/** Vertical gap between the toolbar and the top of the card it formats. */
const ANCHOR_GAP_PX = 8

const ALIGNMENTS: readonly { label: string; value: DocAlignment }[] = [
  { label: 'Align left', value: 'left' },
  { label: 'Align center', value: 'center' },
  { label: 'Align right', value: 'right' },
]

export function DocToolbar({ anchor, onCommand, onRequestLink }: DocToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  // The toolbar is `position: fixed`, so it has to be told where its anchor
  // card is on screen. That position changes only when the canvas transform
  // does, or when the card itself moves or resizes — so it is recomputed on
  // exactly those, never on a timer.
  //
  // An earlier version ran a `requestAnimationFrame` loop for this, on the
  // reasoning that a pan writes the transform imperatively to a ref and emits
  // no event. It measured and wrote to the DOM 60 times a second for the whole
  // editing session and was the cause of a reported lag. It was also
  // unnecessary: the store's `zoom`/`panX`/`panY` DO update (a gesture's
  // ref-write is the mid-gesture optimisation, not the only signal), and the
  // canvas cannot be panned by pointer while a card is being edited anyway —
  // a pointerdown on the canvas ends the session first.
  //
  // Written straight to the element's custom properties rather than through
  // `setState`, so a pan repositions the bar without re-rendering it.
  const zoom = useEditorStore((s) => s.zoom)
  const panX = useEditorStore((s) => s.panX)
  const panY = useEditorStore((s) => s.panY)

  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const el = toolbarRef.current
      if (!el) return
      const rect = anchor.getBoundingClientRect()
      el.style.setProperty('--toolbar-x', `${rect.left}px`)
      el.style.setProperty('--toolbar-y', `${rect.top - ANCHOR_GAP_PX}px`)
    }
    place()
    // Covers the card being dragged or resized under the open toolbar, and any
    // layout change the transform values above cannot see.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(anchor)
    return () => observer.disconnect()
  }, [anchor, zoom, panX, panY])

  // What the CURRENT selection is, so every control shows its real state.
  // Recomputed on `selectionchange` rather than during render: these read live
  // document state, which a render must not do, and nothing else would tell
  // this component the caret moved.
  const [activeCommands, setActiveCommands] = useState<ReadonlySet<string>>(EMPTY_COMMANDS)
  const [blockFormat, setBlockFormatState] = useState<DocBlockFormat>('p')
  const [alignment, setAlignmentState] = useState<DocAlignment>('left')
  const [inLink, setInLink] = useState(false)
  const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null)
  // The last selection that was inside this card's editable body. Restored
  // before every command — see the module doc for why this, and not
  // `preventDefault()` on mousedown.
  const savedRangeRef = useRef<Range | null>(null)

  // `selectionchange` fires on EVERY keystroke, not only when the caret is
  // moved deliberately — so this listener runs at typing speed and must not
  // re-render the toolbar at typing speed. Re-rendering it is not free: it
  // rebuilds a `<Select>`, a `<ColorInput>` and several tooltip-bearing
  // `<Button>`s, which is what made typing in a doc card feel heavy.
  //
  // The guard is that each setter receives a value EQUAL to the one already in
  // state. `readActiveCommands` allocates a fresh `Set` each call, so identity
  // alone always differs; comparing contents turns the common case (typing a
  // word — same formatting throughout) into zero renders, and leaves the rare
  // case (the caret crosses into a bold run) as one.
  useEffect(() => {
    if (!anchor) return
    const sync = () => {
      const selection = document.getSelection()
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      // Only remember a range that belongs to THIS card. A selection made in a
      // panel, another card, or the toolbar's own inputs must not be restored
      // into this editor.
      if (!range || !anchor.contains(range.commonAncestorContainer)) return
      savedRangeRef.current = range.cloneRange()
      const next = readActiveCommands()
      setActiveCommands((current) => (sameCommands(current, next) ? current : next))
      setBlockFormatState(readBlockFormat())
      setAlignmentState(readAlignment())
      setInLink(isSelectionInLink())
    }
    sync()
    document.addEventListener('selectionchange', sync)
    return () => document.removeEventListener('selectionchange', sync)
  }, [anchor])

  if (!anchor) return null

  /**
   * Puts the caret back where the user left it and the FOCUS back on the
   * editable, then runs the command.
   *
   * Each guard below is here because its absence was a visible bug:
   *
   *   1. **Refocus whenever focus has left the editable.** A `<Select>` moves
   *      focus to its own trigger, and the caret has to come back for the next
   *      keystroke. This is NOT what makes a command apply — Chrome runs
   *      `execCommand` against the document selection regardless of where focus
   *      sits, which was measured rather than assumed. It is here for the caret.
   *   2. **Never overwrite a live in-editor selection with a remembered one.**
   *      Most controls are plain buttons that suppress their own mousedown, so
   *      the caret never left; restoring over a good, current selection applies
   *      the command in the wrong place.
   *   3. **Never restore a range whose nodes are gone.** A `Range` holds
   *      references to live nodes, and commands like `formatBlock` REPLACE the
   *      block element — so the range remembered a moment ago can point at
   *      detached nodes. `editable.contains()` is false for a detached node,
   *      which is exactly the test needed.
   *
   * The editable element is looked up from the anchor rather than passed in:
   * it only exists while the card is being edited, so a ref handed down from
   * the parent is still null on the render that first mounts this toolbar.
   */
  const run = (command: () => void) => () => {
    const editable = anchor.querySelector<HTMLElement>('[contenteditable="true"]')
    if (editable) {
      const selection = document.getSelection()
      const live = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const liveIsUsable = live != null && editable.contains(live.commonAncestorContainer)
      const saved = savedRangeRef.current
      const savedIsUsable = saved != null && editable.contains(saved.commonAncestorContainer)
      const focused = document.activeElement === editable || editable.contains(document.activeElement)

      if (!focused) {
        // Clone BEFORE focusing: focusing the host can move the selection, and
        // `getRangeAt` hands back a live object rather than a snapshot.
        const restore = liveIsUsable ? live.cloneRange() : savedIsUsable ? saved : null
        editable.focus()
        if (restore) {
          selection?.removeAllRanges()
          selection?.addRange(restore)
        }
      } else if (!liveIsUsable && savedIsUsable) {
        selection?.removeAllRanges()
        selection?.addRange(saved)
      }
    }
    command()
    // Re-remember the selection the command left behind, rather than waiting
    // for `selectionchange`. A command like `formatBlock` REPLACES the block
    // element, so the range remembered before it is now detached — and if the
    // next click lands on a control that takes focus, the restore above would
    // be working from that dead range.
    if (editable) {
      const after = document.getSelection()
      const range = after && after.rangeCount > 0 ? after.getRangeAt(0) : null
      if (range && editable.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange()
      }
      setBlockFormatState(readBlockFormat())
      setAlignmentState(readAlignment())
      setActiveCommands(readActiveCommands())
    }
    onCommand()
  }

  return createPortal(
    <>
      <div
        ref={toolbarRef}
        className={styles.toolbar}
        // Marks this subtree as "still part of the editing session" for
        // `DocBlockView`'s outside-click check — the toolbar is portaled to
        // `document.body`, so it is not a DOM descendant of the card it edits.
        data-doc-toolbar
        role="toolbar"
        aria-label="Doc formatting"
      >
        {/* Controlled, not `defaultValue`. Two reasons: it shows the format the
            caret is actually in, and an uncontrolled select cannot re-apply the
            value it already displays — picking "Heading 1" a second time (in a
            different paragraph) fired no change event at all. */}
        <Select
          fieldSize="sm"
          className={styles.selectBlock}
          aria-label="Block format"
          value={blockFormat}
          onChange={(e) => run(() => setBlockFormat(e.currentTarget.value as DocBlockFormat))()}
        >
          {DOC_BLOCK_FORMATS.map((format) => (
            <option key={format.value} value={format.value}>{format.label}</option>
          ))}
        </Select>

        <Separator orientation="vertical" />

        <GlyphButton label="Bold" glyph="B" pressed={activeCommands.has('bold')} className={styles.glyphBold} onRun={run(toggleBold)} />
        <GlyphButton label="Italic" glyph="I" pressed={activeCommands.has('italic')} className={styles.glyphItalic} onRun={run(toggleItalic)} />
        <GlyphButton label="Underline" glyph="U" pressed={activeCommands.has('underline')} className={styles.glyphUnderline} onRun={run(toggleUnderline)} />
        <GlyphButton label="Strikethrough" glyph="S" pressed={activeCommands.has('strikeThrough')} className={styles.glyphStrike} onRun={run(toggleStrikethrough)} />

        <Separator orientation="vertical" />

        {/* One link button, not two: it removes the link when the caret is
            already inside one, which is the only time "remove link" is the
            action you want — and a permanently-visible second button for it was
            pure width. */}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          pressed={inLink}
          tooltip={inLink ? 'Remove link' : 'Add link'}
          aria-label={inLink ? 'Remove link' : 'Add link'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={inLink ? run(removeLink) : onRequestLink}
        >
          <LinkIcon size={13} aria-hidden="true" />
        </Button>

        <ColorInput
          fieldSize="sm"
          className={styles.color}
          aria-label="Text colour"
          defaultValue="#ededed"
          onChange={(e) => run(() => setTextColor(e.currentTarget.value))()}
        />

        <Button
          variant="ghost"
          size="sm"
          iconOnly
          tooltip="More formatting"
          aria-label="More formatting"
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setOverflowAt({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <MoreHorizontalSolidIcon size={13} aria-hidden="true" />
        </Button>
      </div>

      {overflowAt && (
        <ContextMenu
          x={overflowAt.x}
          y={overflowAt.y}
          ariaLabel="More formatting"
          animateExit
          onClose={() => setOverflowAt(null)}
        >
          {ALIGNMENTS.map((option) => (
            <ContextMenuItem
              key={option.value}
              selected={option.value === alignment}
              onClick={() => { setOverflowAt(null); run(() => setAlignment(option.value))() }}
            >
              {option.label}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => { setOverflowAt(null); run(clearFormatting)() }}>
            Clear formatting
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>,
    document.body,
  )
}

/** The inline commands the toolbar shows a pressed state for. */
const TOGGLE_COMMANDS = ['bold', 'italic', 'underline', 'strikeThrough'] as const

const EMPTY_COMMANDS: ReadonlySet<string> = new Set()

function readActiveCommands(): ReadonlySet<string> {
  return new Set(TOGGLE_COMMANDS.filter((command) => isCommandActive(command)))
}

/** Content equality for the pressed-state set — see the `selectionchange` effect. */
function sameCommands(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const command of a) if (!b.has(command)) return false
  return true
}

interface GlyphButtonProps {
  label: string
  /** The button's face. A letter or typographic mark, because the vendored icon set has no bold/italic/strike glyphs — see `vendor/pixel-art-icons/`. */
  glyph: ReactNode
  pressed?: boolean
  className?: string
  onRun: () => void
}

function GlyphButton({ label, glyph, pressed, className, onRun }: GlyphButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      tooltip={label}
      aria-label={label}
      pressed={pressed}
      className={className}
      // See the module doc: without this the selection is gone before the
      // command runs.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      <span aria-hidden="true">{glyph}</span>
    </Button>
  )
}
