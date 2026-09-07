import { describe, expect, it } from 'bun:test'
import { formatEditedAgo } from './editedAgo'

const NOW = Date.parse('2026-09-07T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatEditedAgo', () => {
  it('reads as a clause, not a chip', () => {
    expect(formatEditedAgo(NOW - 2 * DAY, NOW)).toBe('Edited 2 days ago')
    expect(formatEditedAgo(NOW - 3 * HOUR, NOW)).toBe('Edited 3 hours ago')
    expect(formatEditedAgo(NOW - 5 * MINUTE, NOW)).toBe('Edited 5 minutes ago')
  })

  it('singularises', () => {
    expect(formatEditedAgo(NOW - MINUTE, NOW)).toBe('Edited 1 minute ago')
    expect(formatEditedAgo(NOW - HOUR, NOW)).toBe('Edited 1 hour ago')
    expect(formatEditedAgo(NOW - DAY, NOW)).toBe('Edited 1 day ago')
  })

  it('climbs to months and years rather than printing 400 days', () => {
    expect(formatEditedAgo(NOW - 45 * DAY, NOW)).toBe('Edited 1 month ago')
    expect(formatEditedAgo(NOW - 400 * DAY, NOW)).toBe('Edited 1 year ago')
  })

  it('says "just now" under a minute', () => {
    expect(formatEditedAgo(NOW, NOW)).toBe('Edited just now')
    expect(formatEditedAgo(NOW - 30_000, NOW)).toBe('Edited just now')
  })

  // A future mtime is real — a clock skew, a restored archive. "Edited in 3
  // hours" on a launcher card helps nobody.
  it('never reads into the future', () => {
    expect(formatEditedAgo(NOW + 3 * HOUR, NOW)).toBe('Edited just now')
  })

  it('says nothing at all rather than "Edited NaN days ago"', () => {
    expect(formatEditedAgo(Number.NaN, NOW)).toBe('')
  })
})
