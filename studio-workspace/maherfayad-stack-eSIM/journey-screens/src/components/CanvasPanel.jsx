import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './CanvasPanel.css'

const PHONE_W = 393
const PHONE_H = 852
const H_GAP = 80
const MARGIN = 80

function computeLayout(screens) {
  return screens.map((s, i) => ({ item: s, x: MARGIN + i * (PHONE_W + H_GAP), y: MARGIN }))
}

/** Read-only thumbnail of a single screen — live-rendered React (not an
 * iframe, since we're already inside the same app), with navigation
 * stubbed out since these are just previews. */
function CanvasFrame({ item }) {
  const Screen = item.Component
  return <Screen onClose={() => {}} />
}

/**
 * Lightweight pan/zoom overview of all screens — the "Canvas" button in the
 * top bar. No draggable frames, no sticky notes, no persistence — every
 * screen is live-rendered and clicking a frame jumps straight into it.
 */
export default function CanvasPanel({ screens, onJumpTo, onClose, active }) {
  const containerRef = useRef(null)
  const [zoom, setZoom] = useState(0.3)
  const [offset, setOffset] = useState({ x: 40, y: 40 })
  const zoomRef = useRef(0.3)
  const offsetRef = useRef({ x: 40, y: 40 })
  const activeRef = useRef(active)
  const dragging = useRef(false)
  const dragStart = useRef(null)
  const moved = useRef(false)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  const frames = useMemo(() => computeLayout(screens), [screens])

  const syncZoom = useCallback((nz, mx, my) => {
    const ratio = nz / zoomRef.current
    const nx = mx - (mx - offsetRef.current.x) * ratio
    const ny = my - (my - offsetRef.current.y) * ratio
    zoomRef.current = nz
    offsetRef.current = { x: nx, y: ny }
    setZoom(nz)
    setOffset({ x: nx, y: ny })
  }, [])

  const applyOffset = useCallback((nx, ny) => {
    offsetRef.current = { x: nx, y: ny }
    setOffset({ x: nx, y: ny })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e) => {
      if (!activeRef.current) return
      e.preventDefault()
      let d = e.deltaY
      if (e.deltaMode === 1) d *= 20
      if (e.deltaMode === 2) d *= 400
      const step = Math.sign(d) * Math.min(Math.abs(d) * 0.005, 0.2)
      const nz = Math.max(0.06, Math.min(2, zoomRef.current * (1 - step)))
      const rect = el.getBoundingClientRect()
      syncZoom(nz, e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [syncZoom])

  const fitAll = useCallback(() => {
    const el = containerRef.current
    const { width: vw, height: vh } = el ? el.getBoundingClientRect() : { width: 1200, height: 800 }
    if (frames.length === 0) return
    const minX = Math.min(...frames.map((f) => f.x))
    const minY = Math.min(...frames.map((f) => f.y))
    const maxX = Math.max(...frames.map((f) => f.x + PHONE_W))
    const maxY = Math.max(...frames.map((f) => f.y + PHONE_H))
    const worldW = maxX - minX
    const worldH = maxY - minY
    const PAD = 60
    const nz = Math.min((vw - PAD * 2) / worldW, (vh - PAD * 2) / worldH, 1)
    const nx = PAD + (vw - PAD * 2 - worldW * nz) / 2 - minX * nz
    const ny = PAD - minY * nz
    zoomRef.current = nz
    offsetRef.current = { x: nx, y: ny }
    setZoom(nz)
    setOffset({ x: nx, y: ny })
  }, [frames])

  useEffect(() => {
    if (active) fitAll()
  }, [active, fitAll])

  useEffect(() => {
    const handler = (e) => {
      if (!activeRef.current) return
      if (e.key === 'Escape') {
        onClose?.()
        return
      }
      if ((e.key === '=' || e.key === '+') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        syncZoom(Math.min(2, zoomRef.current * 1.2), rect.width / 2, rect.height / 2)
      }
      if (e.key === '-' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        syncZoom(Math.max(0.06, zoomRef.current / 1.2), rect.width / 2, rect.height / 2)
      }
      if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        fitAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, syncZoom, fitAll])

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    dragging.current = true
    moved.current = false
    dragStart.current = { clientX: e.clientX, clientY: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y }
    e.preventDefault()
  }, [])

  const onMouseMove = useCallback(
    (e) => {
      if (!dragging.current) return
      const dx = dragStart.current.ox + (e.clientX - dragStart.current.clientX)
      const dy = dragStart.current.oy + (e.clientY - dragStart.current.clientY)
      const dist = Math.hypot(e.clientX - dragStart.current.clientX, e.clientY - dragStart.current.clientY)
      if (dist > 4) moved.current = true
      applyOffset(dx, dy)
    },
    [applyOffset],
  )

  const onMouseUp = useCallback(() => {
    dragging.current = false
  }, [])

  const zoomIn = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    syncZoom(Math.min(2, zoomRef.current * 1.25), rect.width / 2, rect.height / 2)
  }, [syncZoom])

  const zoomOut = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    syncZoom(Math.max(0.06, zoomRef.current / 1.25), rect.width / 2, rect.height / 2)
  }, [syncZoom])

  return (
    <div
      ref={containerRef}
      className="esim-canvas-stage"
      style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <div className="esim-canvas-hud" onClick={(e) => e.stopPropagation()}>
        <button className="esim-canvas-hud__btn" onClick={zoomOut} title="Zoom out (Ctrl -)">
          −
        </button>
        <span className="esim-canvas-hud__label">{Math.round(zoom * 100)}%</span>
        <button className="esim-canvas-hud__btn" onClick={zoomIn} title="Zoom in (Ctrl +)">
          +
        </button>
        <div className="esim-canvas-hud__sep" />
        <button className="esim-canvas-hud__btn esim-canvas-hud__btn--text" onClick={fitAll} title="Fit all (Ctrl 0)">
          Fit
        </button>
        <div className="esim-canvas-hud__sep" />
        <button className="esim-canvas-hud__btn esim-canvas-hud__btn--text" onClick={onClose} title="Close (Esc)">
          Close
        </button>
      </div>

      {frames.map((li, i) => {
        const sx = li.x * zoom + offset.x
        const labelY = (li.y + PHONE_H) * zoom + offset.y + 10
        return (
          <p key={`fl-${i}`} className="esim-canvas-frame__label" style={{ left: sx + 4, top: labelY }}>
            {li.item.label}
          </p>
        )
      })}

      <div
        className="esim-canvas-world"
        style={{ transform: `translate(${offset.x}px,${offset.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        {frames.map((li, i) => (
          <div key={i} className="esim-canvas-frame" style={{ left: li.x, top: li.y }}>
            <div className="esim-canvas-frame__phone">
              <CanvasFrame item={li.item} />
              <div
                className="esim-canvas-frame__overlay"
                onClick={(e) => {
                  e.stopPropagation()
                  if (!moved.current) onJumpTo?.(li.item.key)
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
