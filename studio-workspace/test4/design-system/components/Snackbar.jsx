import { useEffect } from 'react'
import './Snackbar.css'

export function Snackbar({
  message,
  show = false,
  duration = 3000,
  onClose,
  dir = 'ltr',
  className,
  ...props
}) {
  useEffect(() => {
    if (!show || !duration || !onClose) return
    const id = setTimeout(onClose, duration)
    return () => clearTimeout(id)
  }, [show, duration, onClose])

  const cls = ['snackbar', show && 'snackbar--visible', className].filter(Boolean).join(' ')

  return (
    <div className={cls} role="status" aria-live="polite" dir={dir} {...props}>
      <p className="snackbar__message">{message}</p>
    </div>
  )
}
