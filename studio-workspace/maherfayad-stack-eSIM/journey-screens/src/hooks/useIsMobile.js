import { useEffect, useState } from 'react'

export default function useIsMobile(breakpoint = 500) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (e) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [breakpoint])

  return isMobile
}
