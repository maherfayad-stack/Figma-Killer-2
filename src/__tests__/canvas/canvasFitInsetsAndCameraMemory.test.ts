/**
 * Two halves of "the board opens where it should": a fit leaves room for the
 * docked Properties sidebar that opens on selection (so the rightmost frame is
 * not left under it), and the camera a person leaves is remembered per board.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { measureCanvasFitInsets } from '@site/canvas/canvasViewportCommands'
import { recallCamera, rememberCamera } from '@site/canvas/canvasCameraMemory'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('measureCanvasFitInsets', () => {
  it('reserves the docked sidebar width while it is closed (it opens on selection)', () => {
    document.body.innerHTML = `
      <div id="root"></div>
      <aside data-testid="right-sidebar" data-mode="docked" data-expanded="false" style="--right-sidebar-panel-layout-width:290px"></aside>`
    const insets = measureCanvasFitInsets(document.getElementById('root')!, 40)
    expect(insets.right).toBe(330)
    expect(insets.left).toBe(40)
  })

  it('reserves nothing once it is open - the canvas root has already shrunk by its width', () => {
    document.body.innerHTML = `
      <div id="root"></div>
      <aside data-testid="right-sidebar" data-mode="docked" data-expanded="true" style="--right-sidebar-panel-layout-width:290px"></aside>`
    expect(measureCanvasFitInsets(document.getElementById('root')!, 40).right).toBe(40)
  })

  it('reserves nothing for a floating (undocked) panel or no sidebar at all', () => {
    document.body.innerHTML = `
      <div id="root"></div>
      <aside data-testid="right-sidebar" data-mode="floating" data-expanded="false" style="--right-sidebar-panel-layout-width:290px"></aside>`
    expect(measureCanvasFitInsets(document.getElementById('root')!, 40).right).toBe(40)
    document.body.innerHTML = `<div id="root"></div>`
    expect(measureCanvasFitInsets(document.getElementById('root')!, 40).right).toBe(40)
  })
})

describe('canvasCameraMemory', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('recalls what was last remembered for that board, and nothing for another', () => {
    rememberCamera('board-1', { zoom: 0.4, panX: 120, panY: -30 })
    expect(recallCamera('board-1')).toEqual({ zoom: 0.4, panX: 120, panY: -30 })
    expect(recallCamera('board-2')).toBeNull()
  })

  it('keeps the newest camera per board', () => {
    rememberCamera('board-1', { zoom: 0.4, panX: 1, panY: 2 })
    rememberCamera('board-1', { zoom: 0.8, panX: 3, panY: 4 })
    expect(recallCamera('board-1')).toEqual({ zoom: 0.8, panX: 3, panY: 4 })
  })

  it('treats a malformed or absurd entry as no memory', () => {
    localStorage.setItem('studio-canvas-camera-v1', '{not json')
    expect(recallCamera('board-1')).toBeNull()
    localStorage.setItem('studio-canvas-camera-v1', JSON.stringify({ '|board-1': { zoom: 0, panX: 0, panY: 0 } }))
    expect(recallCamera('board-1')).toBeNull()
  })
})
