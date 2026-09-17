import './Chip.css'
import { ChevronDownIcon } from '../icons/LineIcons'

export function Chip({ label, selected = false, dropdown = false, icon, state = 'default', skeleton = false, dir = 'ltr', className = '', ...props }) {
  if (skeleton) {
    return <span className={['chip', 'chip--skeleton', className].filter(Boolean).join(' ')} dir={dir} />
  }

  const cls = [
    'chip',
    selected && 'chip--selected',
    dropdown && 'chip--dropdown',
    state === 'error' && 'chip--error',
    className,
  ].filter(Boolean).join(' ')

  return (
    <button className={cls} dir={dir} type="button" {...props}>
      {icon && <span className="chip__icon">{icon}</span>}
      <span className="chip__label">{label}</span>
      {dropdown && (
        <span className="chip__chevron">
          <ChevronDownIcon />
        </span>
      )}
    </button>
  )
}
