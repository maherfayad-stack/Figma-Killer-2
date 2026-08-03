export function ChevronLeft() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M12 4l-6 6 6 6" />
    </svg>
  )
}

export function ChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M4 6l4 4 4-4" />
    </svg>
  )
}

export function AppleGlyph() {
  return (
    <svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
      <path fill="currentColor" d="M16.365 12.72c-.02-2.21 1.803-3.27 1.886-3.324-1.028-1.504-2.628-1.71-3.198-1.734-1.363-.138-2.66.803-3.353.803-.69 0-1.762-.783-2.9-.76-1.492.022-2.865.867-3.632 2.201-1.55 2.687-.394 6.657 1.113 8.837.737 1.067 1.615 2.264 2.77 2.221 1.11-.045 1.527-.72 2.87-.72 1.343 0 1.717.72 2.892.696 1.196-.02 1.955-1.086 2.687-2.157.849-1.238 1.198-2.44 1.217-2.502-.027-.012-2.333-.895-2.352-3.561zM14.16 5.86c.613-.744 1.027-1.777.914-2.802-.883.036-1.953.588-2.588 1.332-.57.66-1.068 1.712-.935 2.718.986.076 1.995-.5 2.609-1.248z" />
    </svg>
  )
}

export function GoogleGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export function IconEnvelope() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5.5" width="18" height="13" rx="1.5" {...stroke} />
      <path d="M3.5 6.5l8.5 6.5 8.5-6.5" {...stroke} />
    </svg>
  )
}

export function IconSms() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" {...stroke} />
    </svg>
  )
}

export function IconAirplane() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 13l7.5-1 4.5 6.5 1.8-.6-2-6.4 4.5-1.2c1.4-.4 2.4-1.4 2-2.4-.3-1-1.7-1.3-3-.9l-4.4 1.2-4.5-4.9-1.7.5 2.3 6-6 1.6z" {...stroke} />
    </svg>
  )
}

export function IconCalendar() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" {...stroke} />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" {...stroke} />
    </svg>
  )
}

export function IconDiscount() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" {...stroke} />
      <path d="M8.5 15.5l7-7" {...stroke} />
      <circle cx="9" cy="9" r="1.2" {...stroke} />
      <circle cx="15" cy="15" r="1.2" {...stroke} />
    </svg>
  )
}

export function IconLightning() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2L4 14h6l-1 8 9-12h-6z" {...stroke} />
    </svg>
  )
}

export function IconChartDown() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6l6 6 4-4 8 8M21 16v4h-4" {...stroke} />
    </svg>
  )
}
