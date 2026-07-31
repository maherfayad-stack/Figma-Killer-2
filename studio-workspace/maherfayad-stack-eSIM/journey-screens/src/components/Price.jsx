import riyalSvg from '../assets/icons/riyal-symbol.svg?raw'
import './Price.css'

export default function Price({ value, strikethrough = false, color }) {
  return (
    <span className="price" style={color ? { '--fill-0': color } : undefined}>
      <span className="price__symbol" dangerouslySetInnerHTML={{ __html: riyalSvg }} />
      <span className={`price__value${strikethrough ? ' price__value--strike' : ''}`}>{value}</span>
    </span>
  )
}
