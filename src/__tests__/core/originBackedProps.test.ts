/**
 * Origin-backed props — editing copy that reaches the JSX through an
 * expression.
 *
 * `title={t.home.skipTheTaxiQueue}` is a code-valued prop, so the call site is
 * not a writeback target: baking a string there would destroy the i18n
 * binding. But the evaluator followed it to a real string literal in
 * `i18n/translations.ts`, and THAT is editable — which is the difference
 * between "this copy is locked" and "this copy is edited one hop away".
 *
 * The two halves must agree or the feature is actively destructive:
 * `isPropWritableToSource` authorises the edit ONLY on the promise that the
 * write path aims at the origin. These tests pin both ends of that promise.
 */
import { describe, expect, it } from 'bun:test'
import { isPropPatchWritableToSource, isPropWritableToSource } from '@core/page-tree'

const ORIGIN = { rel: 'i18n/translations.ts', line: 21, col: 25 }

/** A design-system node whose `title` came from a dictionary lookup and whose `className` came from an opaque expression. */
const NODE = {
  lockReason: undefined,
  codeProps: ['title', 'className'],
  resolvedProps: {
    title: { source: 't.home.skipTheTaxiQueue', note: 'dynamic key…', origin: ORIGIN },
    className: { source: 'styles.card' },
  },
}

describe('isPropWritableToSource', () => {
  it('unlocks a code-valued prop whose literal the evaluator located', () => {
    // The regression this exists for: extracting copy into a dictionary made
    // every extracted prop read-only in the properties panel.
    expect(isPropWritableToSource(NODE, 'title')).toBe(true)
  })

  it('still refuses a code-valued prop with no traceable literal', () => {
    // `styles.card` resolves to a string too, but not one this parser can
    // point at — there is no honest target, so the refusal stands.
    expect(isPropWritableToSource(NODE, 'className')).toBe(false)
  })

  it('leaves an ordinary prop alone', () => {
    expect(isPropWritableToSource(NODE, 'imageSize')).toBe(true)
  })

  it('applies the same rule to a patch, key by key', () => {
    expect(isPropPatchWritableToSource(NODE, { title: 'New' })).toBe(true)
    expect(isPropPatchWritableToSource(NODE, { className: 'x' })).toBe(false)
    // All-or-nothing: one unwritable key refuses the whole patch.
    expect(isPropPatchWritableToSource(NODE, { title: 'New', className: 'x' })).toBe(false)
  })

  it('keeps the strict rule for an inline-style property', () => {
    // `color: ACCENT` usually resolves through a module-scope const, and
    // repainting every element that reads it because someone touched one
    // element's colour picker is not what they asked for. Styles also have
    // their own editing surface.
    const styled = {
      codeProps: ['style:color'],
      resolvedProps: { 'style:color': { source: 'ACCENT', origin: ORIGIN } },
    }
    expect(isPropWritableToSource(styled, 'style:color')).toBe(false)
  })
})
