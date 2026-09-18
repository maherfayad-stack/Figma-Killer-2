import './Slider.css'

export function Slider({ value = 0, min = 0, max = 100, step, onChange, ticks, dir = 'ltr', className, ...props }) {
  const resolvedStep = step ?? (ticks > 1 ? (max - min) / (ticks - 1) : 1)
  const pct = ((value - min) / (max - min)) * 100
  const cls = ['slider', className].filter(Boolean).join(' ')

  return (
    <div className={cls} dir={dir}>
      <input
        type="range"
        className="slider__input"
        min={min}
        max={max}
        step={resolvedStep}
        value={value}
        onChange={e => onChange?.(Number(e.target.value))}
        style={{ '--slider-pct': `${pct}%` }}
        {...props}
      />
      {ticks > 1 && (
        <div className="slider__ticks" aria-hidden="true">
          {Array.from({ length: ticks }, (_, i) => (
            <div key={i} className="slider__tick" />
          ))}
        </div>
      )}
    </div>
  )
}
