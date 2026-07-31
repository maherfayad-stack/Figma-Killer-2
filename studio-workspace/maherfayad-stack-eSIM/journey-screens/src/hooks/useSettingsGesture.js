import { useRef, useCallback } from 'react'

/** Two-finger tap (touch/pen) or right-click (mouse) to open the settings sheet. */
export default function useSettingsGesture(onOpen) {
  const activePointers = useRef(new Set())
  const lastOpenAt = useRef(0)

  const open = useCallback(() => {
    const now = Date.now()
    if (now - lastOpenAt.current < 400) return
    lastOpenAt.current = now
    onOpen()
  }, [onOpen])

  const handleContextMenuCapture = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    open()
  }, [open])

  const handlePointerDownCapture = useCallback((e) => {
    if (e.pointerType === 'mouse' && e.button === 2) {
      e.preventDefault()
      open()
      return
    }
    activePointers.current.add(e.pointerId)
    if (activePointers.current.size === 2) open()
  }, [open])

  const handlePointerUpCapture = useCallback((e) => {
    activePointers.current.delete(e.pointerId)
  }, [])

  const handlePointerCancelCapture = useCallback((e) => {
    activePointers.current.delete(e.pointerId)
  }, [])

  return {
    handleContextMenuCapture,
    handlePointerDownCapture,
    handlePointerUpCapture,
    handlePointerCancelCapture,
  }
}
