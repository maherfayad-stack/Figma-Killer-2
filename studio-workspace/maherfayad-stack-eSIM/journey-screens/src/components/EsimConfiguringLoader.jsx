import { useEffect, useState } from 'react'

const PHASE_STEP_MS = 700

// "Installing eSIM" radar loader — steps through PHASES on a timer, then
// calls onDone. Shared by any screen that hands off to a configuring state
// (Settings install, manual entry install).
export default function EsimConfiguringLoader({ title, phases, onDone }) {
  const [phaseIndex, setPhaseIndex] = useState(0)

  useEffect(() => {
    const stepTimer = setInterval(() => {
      setPhaseIndex((i) => Math.min(i + 1, phases.length - 1))
    }, PHASE_STEP_MS)
    const doneTimer = setTimeout(() => onDone?.(), PHASE_STEP_MS * phases.length + 200)
    return () => {
      clearInterval(stepTimer)
      clearTimeout(doneTimer)
    }
  }, [onDone, phases])

  return (
    <div className="esim-configuring">
      <div className="esim-radar" aria-hidden="true">
        <span className="esim-radar__ring" />
        <span className="esim-radar__ring" />
        <span className="esim-radar__ring" />
        <span className="esim-radar__orbit" />
        <span className="esim-radar__core" />
      </div>
      <p className="esim-config-title">{title}</p>
      <p className="esim-config-phase">{phases[phaseIndex]}</p>
      <div className="esim-config-track" aria-hidden="true">
        {phases.map((_, i) => (
          <span
            key={i}
            className={`esim-config-seg${i < phaseIndex ? ' esim-config-seg--done' : i === phaseIndex ? ' esim-config-seg--active' : ''}`}
          />
        ))}
      </div>
    </div>
  )
}
