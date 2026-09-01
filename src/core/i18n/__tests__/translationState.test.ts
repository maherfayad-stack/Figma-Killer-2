/**
 * isUntranslated — the rule the Content panel counts by and the AI translate
 * action selects by.
 *
 * The case worth gating is the one that was measured in the wild: a model
 * asked to translate a bare product-ish noun hands the SOURCE back unchanged,
 * and the old `trim() === ''` rule scored that as done. Four keys on a real
 * project (`page2.page2`, `popup.popup`, `sheet.sheet`, `sheet2.sheet2`) were
 * therefore both uncountable and untargetable — the panel said "Missing ar
 * (0)" while an Arabic sheet rendered a Latin `Sheet2` at the top of it.
 */
import { describe, expect, it } from 'bun:test'
import { isUntranslated } from '../translationState'

describe('isUntranslated', () => {
  it('treats a blank target as untranslated, exactly as before', () => {
    expect(isUntranslated('Sheet', '')).toBe(true)
    expect(isUntranslated('Sheet', '   ')).toBe(true)
    expect(isUntranslated('Sheet', undefined)).toBe(true)
  })

  it('treats the source handed back unchanged as untranslated', () => {
    // The measured failure. Whitespace differences do not make it a translation.
    expect(isUntranslated('Sheet2', 'Sheet2')).toBe(true)
    expect(isUntranslated('Popup', '  Popup  ')).toBe(true)
  })

  it('accepts a real translation', () => {
    expect(isUntranslated('Flights', 'طيران')).toBe(false)
    expect(isUntranslated('Not now', 'ليس الآن')).toBe(false)
  })

  it('leaves digit- and punctuation-only values alone even when identical', () => {
    // `9:41` is correct as-is in every locale, so flagging it would be noise
    // with no plausible fix behind it.
    expect(isUntranslated('9:41', '9:41')).toBe(false)
    expect(isUntranslated('—', '—')).toBe(false)
    expect(isUntranslated('2025', '2025')).toBe(false)
  })

  it('catches an echoed non-Latin source too', () => {
    // The source is not necessarily English; a Cyrillic or CJK string echoed
    // back is the same failure.
    expect(isUntranslated('Привет', 'Привет')).toBe(true)
    expect(isUntranslated('日本語', '日本語')).toBe(true)
  })

  it('says nothing needs doing when there is no source to translate from', () => {
    // The server already skips these; the panel must agree, or it would count
    // a row the action will never touch.
    expect(isUntranslated('', 'anything')).toBe(false)
    expect(isUntranslated(undefined, 'anything')).toBe(false)
  })
})
