import { Button, ProgressStepper, LinearProgressIndicator } from '@alm-design/design-system'
import './EsimStatusBanner.css'

const RING_RADIUS = 17
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const RING_LOW_THRESHOLD = 25

function StatusRing({ percent }) {
  const pct = Math.max(0, Math.min(100, percent))
  const isLow = pct <= RING_LOW_THRESHOLD
  return (
    <div className={`esb-ring${isLow ? ' esb-ring--low' : ''}`} role="img" aria-label={`${pct}%`}>
      <svg className="esb-ring__svg" viewBox="0 0 40 40">
        <circle className="esb-ring__track" cx="20" cy="20" r={RING_RADIUS} />
        <circle
          className="esb-ring__fill"
          cx="20"
          cy="20"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
        />
      </svg>
      <span className="esb-ring__label" aria-hidden="true">{pct}%</span>
    </div>
  )
}

export default function EsimStatusBanner({
  variant = 'layered', // 'layered' | 'tint' | 'row'
  tone, // 'install' | 'lowdata'
  icon,
  title,
  desc,
  installedCount,
  installedTotal,
  percent,
  statLabel,
  buttonLabel,
  onAction,
}) {
  const isLowdata = tone === 'lowdata'
  const iconNode =
    isLowdata && variant !== 'layered' ? (
      <StatusRing percent={percent} />
    ) : (
      <img src={icon} alt="" className="esb__icon" />
    )

  if (variant === 'tint') {
    return (
      <div className={`esb esb--tint esb--${tone}`}>
        <div className="esb-tint__row">
          {iconNode}
          <div className="esb__text">
            <p className="esb__title">{title}</p>
            <p className="esb__desc">{desc}</p>
          </div>
        </div>
        {isLowdata && (
          <div className="esb-tint__bar">
            <LinearProgressIndicator value={percent} className="esb__bar" />
            <span className="esb-tint__percent">{Math.round(percent)}%</span>
          </div>
        )}
        <Button variant="primary" size="small" label={buttonLabel} onClick={onAction} className="esb-tint__button" />
      </div>
    )
  }

  if (variant === 'row') {
    return (
      <div className={`esb esb--row esb--${tone}`}>
        {iconNode}
        <div className="esb__text">
          <p className="esb__title">{title}</p>
          <p className="esb__desc">{desc}</p>
        </div>
        <Button variant="primary" size="small" label={buttonLabel} onClick={onAction} />
      </div>
    )
  }

  return (
    <div className={`esb esb--${tone}`}>
      <div className="esb__top">
        <img src={icon} alt="" className="esb__icon" />
        <div className="esb__text">
          <p className="esb__title">{title}</p>
          <p className="esb__desc">{desc}</p>
        </div>
      </div>
      <div className="esb__bottom">
        <div className="esb__progress">
          {tone === 'install' ? (
            <ProgressStepper steps={installedTotal} currentStep={installedCount} className="esb__stepper" />
          ) : (
            <LinearProgressIndicator value={percent} className="esb__bar" />
          )}
          <p className="esb__stat">{statLabel}</p>
        </div>
        <Button variant="primary" size="small" label={buttonLabel} onClick={onAction} />
      </div>
    </div>
  )
}
