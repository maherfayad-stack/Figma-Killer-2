/**
 * "Edited 2 days ago" — the launcher card's one sentence about a project's
 * last edit.
 *
 * Deliberately NOT the AgentPanel's `formatRelativeTime`, which answers a
 * different question in a different place: that one is a terse chip glued to
 * a chat message ("5m", "3h") sized for a 290px panel. This is a full clause
 * on a home-surface card, and a card that said "Edited 3h" would read as
 * truncated rather than terse. Same input, different sentence — sharing one
 * formatter would mean one of the two call sites getting the wrong voice.
 *
 * `now` is injectable so the unit test is not a clock race.
 */
export function formatEditedAgo(epochMs: number, now: number = Date.now()): string {
  const ms = now - epochMs
  if (!Number.isFinite(ms)) return ''
  // A future mtime is a real thing (a clock skew, a restored archive). Saying
  // "in 3 hours" on a launcher card helps nobody, so it reads as just-edited.
  const minutes = Math.floor(Math.max(ms, 0) / 60_000)
  if (minutes < 1) return 'Edited just now'
  if (minutes < 60) return `Edited ${plural(minutes, 'minute')} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Edited ${plural(hours, 'hour')} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `Edited ${plural(days, 'day')} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `Edited ${plural(months, 'month')} ago`
  return `Edited ${plural(Math.floor(days / 365), 'year')} ago`
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}
