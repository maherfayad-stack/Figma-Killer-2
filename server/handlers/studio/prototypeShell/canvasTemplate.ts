/**
 * canvasTemplate — the board renderer the shell ships: `CanvasPanel.jsx` and
 * its stylesheet.
 *
 * Split from `shellFiles.ts` because it is a different thing to get right. That
 * module is the app around the design — an entry point, a toolbar, a phone
 * frame. This one is the pan/zoom board itself: bounds, wheel-zoom toward the
 * cursor, drag-to-pan, and the screen-space captions that must stay legible
 * however far out the board is zoomed.
 *
 * Written once into a workspace and never touched again, like everything else
 * in `shellFiles.ts` — a user who reworks their board renderer keeps it.
 *
 * Same no-backticks rule as its sibling: these are template literals, so the
 * emitted code composes strings with `+` and `.join(' ')` rather than template
 * literals of its own.
 */
import { PROTOTYPE_SHELL_DIR, type ShellFile } from './shellPaths'

/**
 * The canvas.
 *
 * Deliberately NOT the skill's `computeLayout` row packing: a Studio board
 * already carries the x/y the author arranged, so laying the frames out again
 * from scratch would throw away the one thing the board is for. Frames render
 * at their real board coordinates; the only thing computed here is the fit.
 *
 * Every frame is a live React tree, same as the skill's version, and carries a
 * full-bleed overlay so the preview inside cannot be interacted with — the
 * whole thumbnail is one target that jumps into the flow view.
 */
const CANVAS_PANEL_JSX = `import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './CanvasPanel.css'

/* Row spacing, taken from the reference canvas this is modelled on. A board is
   a ROW, and rows stack down the page — the "contact sheet" reading that makes
   a whole prototype legible at a glance. */
const H_GAP = 120
const V_GAP = 200
const MARGIN = 80
const HEAD_OFFSET = 56

/**
 * Lay the boards out as titled rows.
 *
 * This deliberately does NOT use each frame's board x/y, and that is the one
 * judgement call in this file worth defending. A Studio board stores the exact
 * position the author dragged every frame to, and honouring it is right INSIDE
 * Studio, where dragging is how you arrange. But the export is a viewer: read
 * back as a contact sheet, arbitrary positions become arbitrary gaps, and a
 * board with three frames 400px apart reads as three lost screens rather than
 * one flow.
 *
 * What IS preserved is the author's ORDER. Frames are sorted by their board
 * position (left to right, then top to bottom), so the sequence you arranged is
 * the sequence you read — only the spacing is regularised. Nothing here writes
 * to '.studio/boards.json'; your board is untouched.
 *
 * Sticky notes and doc cards ride along at the end of their own board's row,
 * because dropping a user's annotations to make a layout tidier is not a
 * trade this gets to make.
 */
function computeLayout(rows) {
  const frames = []
  const notes = []
  const docs = []
  const heads = []
  let y = MARGIN

  for (const row of rows) {
    const ordered = [...row.frames].sort((a, b) => a.x - b.x || a.y - b.y)
    let x = MARGIN
    let rowH = 0

    heads.push({ key: row.key, title: row.title, x: MARGIN, y })

    for (const frame of ordered) {
      frames.push({ item: frame, x, y: y + HEAD_OFFSET, w: frame.width, h: frame.height })
      x += frame.width + H_GAP
      rowH = Math.max(rowH, frame.height)
    }
    for (const note of row.notes) {
      notes.push({ item: note, x, y: y + HEAD_OFFSET, w: note.w, h: note.h })
      x += note.w + H_GAP
      rowH = Math.max(rowH, note.h)
    }
    for (const doc of row.docs) {
      docs.push({ item: doc, x, y: y + HEAD_OFFSET, w: doc.w, h: doc.h })
      x += doc.w + H_GAP
      rowH = Math.max(rowH, doc.h)
    }

    y += HEAD_OFFSET + rowH + V_GAP
  }

  return { frames, notes, docs, heads }
}

/** The extent of everything placed, so the view can fit it. */
function layoutBounds(placed) {
  if (placed.length === 0) return { x: 0, y: 0, w: 1, h: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of placed) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.w)
    maxY = Math.max(maxY, box.y + box.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export default function CanvasPanel({ rows, renderFrame, onOpenFrame, onClose }) {
  const containerRef = useRef(null)
  const [zoom, setZoom] = useState(0.3)
  const [offset, setOffset] = useState({ x: 40, y: 40 })
  const zoomRef = useRef(0.3)
  const offsetRef = useRef({ x: 40, y: 40 })
  const moved = useRef(false)
  // Set the moment the view is the user's own doing. Until then a resize is
  // free to re-fit; after it, the view belongs to them.
  const touched = useRef(false)

  const layout = useMemo(() => computeLayout(rows), [rows])
  const bounds = useMemo(
    () => layoutBounds([...layout.frames, ...layout.notes, ...layout.docs]),
    [layout],
  )

  const applyView = useCallback((nextZoom, nextOffset) => {
    zoomRef.current = nextZoom
    offsetRef.current = nextOffset
    setZoom(nextZoom)
    setOffset(nextOffset)
  }, [])

  const fitAll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Room at the bottom for the floating HUD, so the last row is not tucked under it.
    const usableH = Math.max(rect.height - 110, 1)
    // A flat 160px gutter is comfortable on a laptop and absurd on a phone,
    // where it ate 40% of the width and shrank the board to a tenth of size.
    const margin = Math.min(MARGIN, rect.width * 0.15, usableH * 0.15)
    const next = Math.min((rect.width - margin) / bounds.w, (usableH - margin) / bounds.h, 1)
    const z = Math.max(next, 0.05)
    applyView(z, {
      x: (rect.width - bounds.w * z) / 2 - bounds.x * z,
      y: (usableH - bounds.h * z) / 2 - bounds.y * z + 20,
    })
    touched.current = false
  }, [applyView, bounds])

  /**
   * Fit on mount, and again whenever the viewport changes size — but only while
   * the view is still the one this computed. Without the resize half, a board
   * fitted at one window size stayed at that zoom and offset forever: narrow
   * the window (or rotate a phone) and the design sat at a tenth of its size in
   * a corner. Without the 'touched' half, a resize would throw away a pan the
   * user had deliberately made.
   */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    fitAll()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { if (!touched.current) fitAll() })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fitAll])

  const zoomTo = useCallback((nextZoom, cx, cy) => {
    const clamped = Math.min(Math.max(nextZoom, 0.05), 2)
    const ratio = clamped / zoomRef.current
    applyView(clamped, {
      x: cx - (cx - offsetRef.current.x) * ratio,
      y: cy - (cy - offsetRef.current.y) * ratio,
    })
  }, [applyView])

  // Non-passive so the page does not scroll behind the board.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      touched.current = true
      const rect = el.getBoundingClientRect()
      // deltaMode 1 is lines and 2 is pages — a mouse wheel reports one of
      // those rather than pixels, and treating a 3-line notch as 3 pixels makes
      // the zoom feel dead on any hardware that is not a trackpad. The step is
      // then clamped so one violent scroll cannot jump the whole zoom range.
      let delta = event.deltaY
      if (event.deltaMode === 1) delta *= 20
      else if (event.deltaMode === 2) delta *= 400
      const step = Math.sign(delta) * Math.min(Math.abs(delta) * 0.005, 0.2)
      zoomTo(zoomRef.current * (1 - step), event.clientX - rect.left, event.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  /** Zoom about the middle of the viewport — what a +/- button is understood to mean. */
  const zoomBy = useCallback((factor) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    touched.current = true
    zoomTo(zoomRef.current * factor, rect.width / 2, rect.height / 2)
  }, [zoomTo])

  useEffect(() => {
    const onKey = (event) => {
      // Escape leaves the board for the screen view, with no modifier — the
      // one shortcut here that is not a zoom.
      if (event.key === 'Escape' && onClose) { onClose(); return }
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key === '0') { event.preventDefault(); fitAll() }
      else if (event.key === '=' || event.key === '+') { event.preventDefault(); zoomBy(1.2) }
      else if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fitAll, zoomBy, onClose])

  /**
   * Drag-to-pan, tracked on the WINDOW rather than by capturing the pointer.
   *
   * setPointerCapture on this container is what the first version did, and it
   * silently killed every button on the board. Pointer capture retargets the
   * compatibility mouse events as well as the pointer ones, so the click fired
   * on the container instead of on the button under the cursor: the frame hit
   * areas and all four HUD buttons were dead, which is why clicking a screen
   * never opened it and Fit did nothing. Window listeners pan just as well and
   * leave the click where it belongs.
   */
  function onPointerDown(event) {
    if (event.button !== 0) return
    // A press that starts on the HUD is aimed at a button, not at the board.
    if (event.target.closest && event.target.closest('.canvas__hud')) return

    const start = { x: event.clientX, y: event.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y }
    moved.current = false

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - start.x
      const dy = moveEvent.clientY - start.y
      // Under 4px is a click with a shaky hand, not a pan. Past that the flag
      // stays set through the click that follows, so panning off a frame does
      // not navigate.
      if (!moved.current && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      moved.current = true
      touched.current = true
      applyView(zoomRef.current, { x: start.ox + dx, y: start.oy + dy })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Captions are drawn in SCREEN space — positioned by the pan/zoom maths but
  // never scaled — so they stay legible however far out the board is. That
  // makes them collide as frames shrink, so each is bounded to its own frame's
  // on-screen width and dropped entirely below 60px.
  //
  // Above the frame, not below it: a board with frames stacked close together
  // put each caption on top of the frame beneath it, and a label overlapping
  // the next screen reads as a rendering bug. Above is also where Figma puts
  // it, so it lands where a designer already looks.
  function captionFor(placed) {
    const w = placed.w * zoom
    if (w < 60) return null
    return (
      <p
        key={'cap-' + placed.item.key}
        className="canvas-frame__label"
        style={{ left: placed.x * zoom + offset.x, top: (placed.y + placed.h) * zoom + offset.y + 10, width: w }}
      >
        {placed.item.label}
      </p>
    )
  }

  return (
    <div
      ref={containerRef}
      className="canvas"
      onPointerDown={onPointerDown}
    >
      <div
        className="canvas__world"
        style={{ transform: 'translate(' + offset.x + 'px,' + offset.y + 'px) scale(' + zoom + ')' }}
      >
        {layout.notes.map((placed) => (
          <div
            key={placed.item.id}
            className={['canvas-note', 'canvas-note--' + (placed.item.color || 'yellow')].join(' ')}
            style={{ left: placed.x, top: placed.y, width: placed.w, height: placed.h }}
          >
            {placed.item.text}
          </div>
        ))}
        {layout.docs.map((placed) => (
          <div
            key={placed.item.id}
            className="canvas-doc"
            style={{ left: placed.x, top: placed.y, width: placed.w, minHeight: placed.h }}
            dangerouslySetInnerHTML={{ __html: placed.item.html }}
          />
        ))}
        {layout.frames.map((placed) => (
          <div
            key={placed.item.key}
            className="canvas-frame"
            style={{ left: placed.x, top: placed.y, width: placed.w, height: placed.h }}
          >
            <div className="canvas-frame__phone">{renderFrame(placed.item)}</div>
            <button
              type="button"
              className="canvas-frame__hit"
              aria-label={'Open ' + placed.item.label}
              onClick={() => { if (!moved.current) onOpenFrame(placed.item) }}
            />
          </div>
        ))}
      </div>
      {/* Row headings, in screen space so they stay legible at any zoom. */}
      {layout.heads.map((head) => (
        <p
          key={'head-' + head.key}
          className="canvas__section"
          style={{ left: head.x * zoom + offset.x, top: (head.y + HEAD_OFFSET) * zoom + offset.y - 28 }}
        >
          {head.title}
        </p>
      ))}
      {layout.frames.map(captionFor)}
      <div className="canvas__hud" dir="ltr">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out (Ctrl -)">&minus;</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" title="Zoom in (Ctrl +)">+</button>
        <i />
        <button type="button" data-text onClick={fitAll} title="Fit all (Ctrl 0)">Fit</button>
        {onClose && (
          <>
            <i />
            <button type="button" data-text onClick={onClose} title="Close (Esc)">Close</button>
          </>
        )}
      </div>
    </div>
  )
}
`

const CANVAS_PANEL_CSS = `.canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  cursor: grab;
  /* The dot grid is what makes a board read as a canvas rather than as a page
     with screenshots on it — it gives the pan and zoom something to move
     against. Fixed to the viewport rather than the world on purpose: a grid
     that scaled with the zoom would either vanish or turn into stripes. */
  background-color: var(--shell-board);
  background-image: radial-gradient(circle, var(--shell-dot) 1px, transparent 1px);
  background-size: 24px 24px;
  touch-action: none;
  user-select: none;
}

.canvas:active { cursor: grabbing; }

.canvas__world {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
}

.canvas-frame {
  position: absolute;
}

/* The device surface. A full-screen sheet insets its backdrop, so without a
   background the strips down each side would be see-through.
   The mockup is three stacked box-shadows rather than a border or a wrapper
   element: a 10px ring in the bezel colour, a 1px edge around that, and the
   drop shadow. Shadows do not affect layout, so the frame's box stays exactly
   the size the board says it is — a real 10px border would push every frame
   out of the position the author arranged. */
.canvas-frame__phone {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 50px;
  background: var(--background-base-default);
  transform: translateZ(0);
  box-shadow:
    0 0 0 10px var(--shell-bezel),
    0 0 0 11px var(--shell-line),
    0 24px 80px rgba(0, 0, 0, 0.28);
  transition: box-shadow 0.2s;
}

/* One target for the whole thumbnail — the preview inside must not be
   interactive on the board. */
.canvas-frame__hit {
  position: absolute;
  inset: 0;
  border: 0;
  padding: 0;
  background: transparent;
  border-radius: 50px;
  cursor: pointer;
}

/* Hover paints the BEZEL, not a ring inside the screen — the highlight should
   read as picking up the device, not as drawing on the design. */
.canvas-frame:hover .canvas-frame__phone {
  box-shadow:
    0 0 0 10px var(--shell-bezel),
    0 0 0 12px var(--shell-accent),
    0 24px 80px rgba(0, 0, 0, 0.32);
}

.canvas-frame__hit:focus-visible { outline: 3px solid var(--shell-accent); outline-offset: 12px; border-radius: 58px; }

/* Screen space: positioned by the pan/zoom maths, never scaled. */
.canvas-frame__label {
  position: absolute;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  text-align: center;
  color: var(--shell-text-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.canvas-note {
  position: absolute;
  padding: 16px;
  font-size: 14px;
  line-height: 1.4;
  white-space: pre-wrap;
  border-radius: 4px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}

.canvas-note--yellow { background: #fdf0a8; color: #4a3d00; }
.canvas-note--green  { background: #c7ecc9; color: #14401a; }
.canvas-note--blue   { background: #c5ddf7; color: #0e2f52; }
.canvas-note--pink   { background: #f8ccdd; color: #4d1029; }
.canvas-note--gray   { background: #dcdcdc; color: #2b2b2b; }

.canvas-doc {
  position: absolute;
  padding: 20px 24px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--shell-text);
  background: var(--shell-surface);
  border-radius: 12px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
}

/* The board's name, drawn in SCREEN space beside the frame captions so it
   stays legible however far the canvas is zoomed out — the same reason the
   captions are. */
.canvas__section {
  position: absolute;
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--shell-text);
  white-space: nowrap;
  pointer-events: none;
}

.canvas__hud {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 10px;
  background: var(--shell-surface);
  border: 1px solid var(--shell-line);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
}

.canvas__hud button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--shell-text);
  font: inherit;
  font-size: 16px;
  cursor: pointer;
  transition: background 0.1s;
}

.canvas__hud button:hover { background: var(--shell-hover); }

/* The word buttons size to their text; the glyph buttons stay square. */
.canvas__hud button[data-text] {
  width: auto;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 600;
}

.canvas__hud span { min-width: 44px; text-align: center; font-size: 12px; font-weight: 500; color: var(--shell-text-subtle); }

.canvas__hud i {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--shell-line);
}
`


/** The board renderer, written once. */
export function canvasShellFiles(): ShellFile[] {
  return [
    { relPath: `${PROTOTYPE_SHELL_DIR}/CanvasPanel.jsx`, contents: CANVAS_PANEL_JSX },
    { relPath: `${PROTOTYPE_SHELL_DIR}/CanvasPanel.css`, contents: CANVAS_PANEL_CSS },
  ]
}
