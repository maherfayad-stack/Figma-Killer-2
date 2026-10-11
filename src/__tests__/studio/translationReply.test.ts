/**
 * translationReply — reading a model's answer without throwing away good work.
 *
 * A strict `Record<string, string>` schema check failed on a real 27-key
 * batch, and the reason is the point of this module: dotted keys
 * (`home.searchFlights`) invite a model to reply with the NESTED object they
 * describe. That reply is not wrong, it is differently shaped — so the tests
 * below split cleanly into "shapes that must be absorbed" and "content that
 * must never be written".
 */
import { describe, expect, it } from 'bun:test'
import { parseTranslationReply } from '../../../server/ai/translationReply'

const WANTED = ['home.searchFlights', 'home.from', 'page.signOut']

describe('parseTranslationReply — shapes it absorbs', () => {
  it('reads the flat object it asked for', () => {
    const reply = parseTranslationReply('{"home.from": "من"}', WANTED)
    expect(reply?.translations).toEqual({ 'home.from': 'من' })
  })

  it('flattens a nested reply back to dotted keys — the case that broke a real batch', () => {
    const reply = parseTranslationReply(
      JSON.stringify({ home: { searchFlights: 'ابحث عن رحلات', from: 'من' }, page: { signOut: 'تسجيل الخروج' } }),
      WANTED,
    )
    expect(reply?.translations).toEqual({
      'home.searchFlights': 'ابحث عن رحلات',
      'home.from': 'من',
      'page.signOut': 'تسجيل الخروج',
    })
  })

  it('ignores prose wrapped around the object', () => {
    const reply = parseTranslationReply('Sure! Here are the translations:\n{"home.from": "من"}\nLet me know.', WANTED)
    expect(reply?.translations).toEqual({ 'home.from': 'من' })
  })

  it('ignores a code fence', () => {
    const reply = parseTranslationReply('```json\n{"home.from": "من"}\n```', WANTED)
    expect(reply?.translations).toEqual({ 'home.from': 'من' })
  })

  it('unwraps a single wrapper key that is not one of ours', () => {
    const reply = parseTranslationReply('{"translations": {"home.from": "من"}}', WANTED)
    expect(reply?.translations).toEqual({ 'home.from': 'من' })
  })

  it('does not mistake a genuine single-key answer for a wrapper', () => {
    const reply = parseTranslationReply('{"page.signOut": "تسجيل الخروج"}', WANTED)
    expect(reply?.translations).toEqual({ 'page.signOut': 'تسجيل الخروج' })
  })

  it('is not fooled by a brace inside a translated string', () => {
    const reply = parseTranslationReply('{"home.from": "{count} من"} trailing text', WANTED)
    expect(reply?.translations).toEqual({ 'home.from': '{count} من' })
  })
})

describe('parseTranslationReply — a reply cut off mid-object', () => {
  it('salvages every complete pair before the cut, and reports truncated', () => {
    // The closing brace, and the last value's closing quote, never arrived —
    // realistic for a big batch hitting the driver's own output-token cap.
    const reply = parseTranslationReply('{"home.from": "من", "home.searchFlights": "ابحث عن رحلات", "page.signOut": "تسجيل ال', WANTED)
    expect(reply?.truncated).toBe(true)
    expect(reply?.translations).toEqual({ 'home.from': 'من', 'home.searchFlights': 'ابحث عن رحلات' })
    // The cut key is simply absent — never a half string written as if whole.
    expect(reply?.translations['page.signOut']).toBeUndefined()
  })

  it('salvages a nested reply cut off after closing its second namespace', () => {
    // Both `home` and `page` fully close before the cut (inside a THIRD,
    // unrequested namespace) — two top-level keys survive, which is what
    // keeps this from being mistaken for a single-key wrapper (`unwrap`'s
    // own three-condition guard).
    const reply = parseTranslationReply(
      '{"home": {"from": "من", "searchFlights": "ابحث عن رحلات"}, "page": {"signOut": "تسجيل الخروج"}, "extra": "cut off he',
      WANTED,
    )
    expect(reply?.truncated).toBe(true)
    expect(reply?.translations).toEqual({
      'home.from': 'من',
      'home.searchFlights': 'ابحث عن رحلات',
      'page.signOut': 'تسجيل الخروج',
    })
  })

  it('is not fooled by a brace inside a salvaged string', () => {
    const reply = parseTranslationReply('{"home.from": "{count} من", "home.searchFlights": "ابحث عن رحل', WANTED)
    expect(reply?.truncated).toBe(true)
    expect(reply?.translations).toEqual({ 'home.from': '{count} من' })
  })

  it('reports untruncated for an ordinary, fully-closed reply', () => {
    const reply = parseTranslationReply('{"home.from": "من"}', WANTED)
    expect(reply?.truncated).toBe(false)
  })

  it('returns undefined when the cut lands inside the very first value — nothing to salvage', () => {
    expect(parseTranslationReply('{"home.from": "من witho', WANTED)).toBeUndefined()
  })
})

describe('parseTranslationReply — content it refuses', () => {
  it('drops a key nobody asked for rather than writing it', () => {
    const reply = parseTranslationReply('{"home.from": "من", "home.invented": "خطأ"}', WANTED)
    expect(reply?.translations).toEqual({ 'home.from': 'من' })
    // Reported, so the caller can say what happened instead of silently
    // writing less than it claims.
    expect(reply?.unexpected).toEqual(['home.invented'])
  })

  it('drops a non-string leaf rather than coercing it', () => {
    const reply = parseTranslationReply('{"home.from": 42, "page.signOut": "تسجيل الخروج"}', WANTED)
    expect(reply?.translations).toEqual({ 'page.signOut': 'تسجيل الخروج' })
  })

  it('returns undefined when there is no JSON object at all', () => {
    expect(parseTranslationReply('I cannot translate this.', WANTED)).toBeUndefined()
    expect(parseTranslationReply('{ not json at all', WANTED)).toBeUndefined()
  })
})
