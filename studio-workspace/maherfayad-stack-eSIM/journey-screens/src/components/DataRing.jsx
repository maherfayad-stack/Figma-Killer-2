import './DataRing.css'

const RADIUS = 17
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export default function DataRing({ percent, size = 40, tone = 'default', className = '' }) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <div
      className={`data-ring data-ring--${tone}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${pct}%`}
    >
      <svg className="data-ring__svg" viewBox="0 0 40 40">
        <circle className="data-ring__track" cx="20" cy="20" r={RADIUS} />
        <circle
          className="data-ring__fill"
          cx="20"
          cy="20"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
        />
      </svg>
      <span className="data-ring__label" aria-hidden="true">{pct}%</span>
    </div>
  )
}
