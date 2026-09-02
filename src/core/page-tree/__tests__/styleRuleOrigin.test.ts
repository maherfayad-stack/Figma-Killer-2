/**
 * styleRuleOrigin — the shared `sc-` prefix / `0` import-timestamp facts
 * three call sites now read from one place: `studioCss.ts` (mints ids),
 * `styleRuleWriteback.ts` (write-back eligibility), and `canvasClassCss.ts`
 * (`board-27`'s canvas overlay filter).
 */
import { describe, expect, it } from 'bun:test'
import { IMPORTED_RULE_ID_PREFIX, IMPORTED_RULE_TIMESTAMP, isImportedStyleRuleId } from '../styleRuleOrigin'

describe('isImportedStyleRuleId', () => {
  it('is true for an id carrying the imported-rule prefix', () => {
    expect(isImportedStyleRuleId('sc-abc1234567')).toBe(true)
    expect(isImportedStyleRuleId(`${IMPORTED_RULE_ID_PREFIX}whatever`)).toBe(true)
  })

  it('is false for a bare nanoid — an editor-authored rule', () => {
    expect(isImportedStyleRuleId('V1StGXR8IZ5jdHi6B-myT')).toBe(false)
  })

  it('is false for an empty string', () => {
    expect(isImportedStyleRuleId('')).toBe(false)
  })
})

describe('IMPORTED_RULE_TIMESTAMP', () => {
  it('is 0 — NOT the same value parseTimestamp falls back to (Date.now())', () => {
    // This constant used to carry a doc comment claiming it matched
    // `parseTimestamp`'s fallback. That claim was wrong — `parseTimestamp`
    // falls back to `Date.now()`, not `0`. Pinning the literal value here
    // so the fact stays correct even if the doc comment drifts again.
    expect(IMPORTED_RULE_TIMESTAMP).toBe(0)
  })
})
