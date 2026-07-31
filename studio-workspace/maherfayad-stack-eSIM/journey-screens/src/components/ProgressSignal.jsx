import './ProgressSignal.css'

export default function ProgressSignal({ step, total = 4, label }) {
  return (
    <div className="esim-progress">
      <div className="esim-progress__track" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`esim-progress__seg${i < step ? ' esim-progress__seg--filled' : ''}`}
          />
        ))}
      </div>
      {label && <span className="esim-progress__label">{label}</span>}
    </div>
  )
}
