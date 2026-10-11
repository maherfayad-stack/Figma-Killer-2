/**
 * `decideTextCommit` — the pure half of `TextControl`'s draft-then-commit
 * (P2-G, UX-16). The rendered half (typing, Enter, Escape, blur) is
 * `src/__tests__/property-controls/TextControl.test.tsx`.
 */
import { describe, expect, it } from 'bun:test'
import { decideTextCommit } from './textFieldDraft'

const identity = (raw: string) => raw
const withPx = (raw: string) => (/^-?\d+(\.\d+)?$/.test(raw) ? `${raw}px` : raw)

describe('decideTextCommit', () => {
  it('writes the typed value when it differs from the current one', () => {
    expect(decideTextCommit({ raw: 'Buy now', value: 'Get started', mixed: false, dirty: true, resolve: identity })).toBe(
      'Buy now',
    )
  })

  it('writes nothing when the user never typed — focus-and-leave is not an edit', () => {
    expect(decideTextCommit({ raw: 'Get started', value: 'Get started', mixed: false, dirty: false, resolve: identity })).toBeNull()
    // Even when the field text differs from the value (a resolved display),
    // an untouched field must not write.
    expect(decideTextCommit({ raw: '50', value: '50px', mixed: false, dirty: false, resolve: withPx })).toBeNull()
  })

  it('writes nothing when the typed value resolves to the current one', () => {
    expect(decideTextCommit({ raw: '50', value: '50px', mixed: false, dirty: true, resolve: withPx })).toBeNull()
  })

  it('resolves before writing — a bare number takes the field unit', () => {
    expect(decideTextCommit({ raw: '24', value: '50px', mixed: false, dirty: true, resolve: withPx })).toBe('24px')
  })

  it('keeps a Mixed field mixed when it was not typed in', () => {
    expect(decideTextCommit({ raw: '', value: 'a', mixed: true, dirty: false, resolve: identity })).toBeNull()
  })

  it('writes any typed value on a Mixed field — there is no single current value to match', () => {
    expect(decideTextCommit({ raw: 'a', value: 'a', mixed: true, dirty: true, resolve: identity })).toBe('a')
  })

  it('lets the user clear a field on purpose', () => {
    expect(decideTextCommit({ raw: '', value: 'Get started', mixed: false, dirty: true, resolve: identity })).toBe('')
  })
})
