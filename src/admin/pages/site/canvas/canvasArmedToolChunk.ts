/**
 * canvasArmedToolChunk - the one dynamic import of the armed-tool surface
 * (`CanvasArmedToolLayer`: the box tools' draw layer and the pen's).
 *
 * The surface is a lazy chunk so a session that never draws does not pay for it
 * (`bundle-size-budgets.test.ts`), but a press made before the chunk arrived
 * fell through to whatever is under the pointer instead of drawing. So the
 * editor warms the chunk once it is idle (`warmArmedToolChunk`) and arming a
 * tool finds it already loaded, which makes "a press with a draw tool armed
 * always draws" true from the first press rather than from the first press
 * after a network round trip.
 */
export function loadArmedToolChunk() {
  return import('./CanvasArmedToolLayer')
}

/** Ask the browser to fetch the chunk when it has nothing better to do. Returns the cancel. */
export function warmArmedToolChunk(): () => void {
  const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void })
  if (typeof idle.requestIdleCallback === 'function') {
    const id = idle.requestIdleCallback(() => void loadArmedToolChunk(), { timeout: 3000 })
    return () => idle.cancelIdleCallback?.(id)
  }
  const timer = setTimeout(() => void loadArmedToolChunk(), 1500)
  return () => clearTimeout(timer)
}
