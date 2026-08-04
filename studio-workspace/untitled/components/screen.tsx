import { IconButton } from '@alm-design/design-system'
import './screen.css'

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M10 4L6 8L10 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 6L8 10L12 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function StatusBar() {
  return (
    <div className="s-status-bar" dir="ltr">
      <span className="s-status-time">9:41</span>
      <span className="s-status-notch">&nbsp;</span>
      <span className="s-status-right">
        <svg width="17" height="11" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
          <rect x="0" y="8" width="3" height="4" rx="0.5" />
          <rect x="5" y="5" width="3" height="7" rx="0.5" />
          <rect x="10" y="2" width="3" height="10" rx="0.5" />
          <rect x="15" y="0" width="3" height="12" rx="0.5" />
        </svg>
        <svg width="15" height="11" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M1 4.5 A11 11 0 0 1 15 4.5" />
          <path d="M3.5 7 A7 7 0 0 1 12.5 7" />
          <path d="M6 9.5 A3.5 3.5 0 0 1 10 9.5" />
          <circle cx="8" cy="11" r="0.8" fill="currentColor" stroke="none" />
        </svg>
        <svg width="26" height="12" viewBox="0 0 26 12" fill="none" aria-hidden="true">
          <rect x="0.5" y="0.5" width="23" height="11" rx="2.5" stroke="currentColor" />
          <rect x="24" y="4" width="1.5" height="4" rx="0.5" fill="currentColor" />
          <rect x="2" y="2" width="17" height="8" rx="1.5" fill="currentColor" />
        </svg>
      </span>
    </div>
  )
}

export function BackRow() {
  return (
    <div className="s-back-row">
      <IconButton variant="secondary" size="small" icon={<ChevronLeft />} aria-label="Back" />
    </div>
  )
}

export function MobileNumberInput() {
  return (
    <div className="s-mobile-input">
      <div className="s-mobile-input-code">
        <span className="s-mobile-label">Code</span>
        <div className="s-mobile-input-code-row">
          <span className="s-mobile-value">+966</span>
          <span className="s-mobile-chev">
            <ChevronDown />
          </span>
        </div>
      </div>
      <div className="s-mobile-input-number">
        <span className="s-mobile-label">
          Mobile number <span className="s-mobile-required">*</span>
        </span>
      </div>
    </div>
  )
}

export function PerkRow({ svg, label }: { svg: string; label: string }) {
  return (
    <div className="s-perk-row">
      <Icon svg={svg} />
      <span className="s-perk-label">{label}</span>
    </div>
  )
}

export function Icon({ svg }: { svg: string }) {
  return <span className="s-icon" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function OtpRow() {
  return (
    <div className="s-otp-row">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="s-otp-cell">&nbsp;</div>
      ))}
    </div>
  )
}
