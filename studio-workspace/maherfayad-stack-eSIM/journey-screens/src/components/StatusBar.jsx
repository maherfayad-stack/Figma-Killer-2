import { useEffect, useState } from 'react'
import './StatusBar.css'

function getTime() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function StatusBar({ className }) {
  const [time, setTime] = useState(getTime)

  useEffect(() => {
    const id = setInterval(() => setTime(getTime()), 15000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={`mock-status-bar${className ? ` ${className}` : ''}`} aria-hidden="true">
      <span className="mock-status-bar__time">{time}</span>
      <div className="mock-status-bar__icons">
        <svg width="17" height="12" viewBox="0 0 17 12" fill="none">
          <rect x="0" y="6" width="3" height="6" rx="1" fill="currentColor" opacity="0.3" />
          <rect x="4.5" y="4" width="3" height="8" rx="1" fill="currentColor" opacity="0.5" />
          <rect x="9" y="2" width="3" height="10" rx="1" fill="currentColor" opacity="0.7" />
          <rect x="13.5" y="0" width="3" height="12" rx="1" fill="currentColor" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <path d="M8 10C8.69 10 9.25 10.56 9.25 11.25S8.69 12.5 8 12.5 6.75 11.94 6.75 11.25 7.31 10 8 10Z" fill="currentColor" />
          <path d="M1.5 4.5C4.54 1.7 11.46 1.7 14.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
          <path d="M3.5 7C5.5 5.3 10.5 5.3 12.5 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
          <path d="M5.5 9.2C6.5 8.4 9.5 8.4 10.5 9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
          <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="currentColor" strokeOpacity="0.35" />
          <rect x="22.5" y="3.5" width="2" height="5" rx="1" fill="currentColor" fillOpacity="0.4" />
          <rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor" />
        </svg>
      </div>
    </div>
  )
}
