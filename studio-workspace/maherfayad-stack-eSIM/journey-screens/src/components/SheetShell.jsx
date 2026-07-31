import StatusBar from './StatusBar'
import SheetHeader from './SheetHeader'
import './SheetShell.css'

export default function SheetShell({ title, onClose, children, className }) {
  return (
    <div className={`sheet-shell${className ? ` ${className}` : ''}`}>
      <div className="sheet-shell__top">
        <StatusBar className="sheet-shell__status-bar" />
      </div>

      <div className="sheet-shell__panel">
        <SheetHeader title={title} onClose={onClose} />
        {children}
      </div>
    </div>
  )
}
