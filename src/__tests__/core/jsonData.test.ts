/**
 * `asJsonDataValue` — the gate between a module's defaults bag and a write into
 * the user's repository.
 *
 * A design-system module's `propsSchema` is `Unknown` for every prop, so the
 * bag can hold anything: a string, an array of tab descriptors, a React
 * element, a no-op handler, a `studio-slot:` sentinel. What has an exact JSX
 * spelling gets written; what does not is dropped, because writing a guess into
 * someone's source is worse than writing nothing.
 *
 * The rule that actually needed pinning is the RECURSIVE one. An `actions`
 * array holding `{ label: 'Book', onClick: fn }` is half-writable, and writing
 * the writable half would put a button in the user's screen that does nothing
 * when tapped — a defect they would chase in their own code.
 */
import { describe, expect, it } from 'bun:test'
import { asJsonDataValue } from '@core/utils/jsonData'

describe('asJsonDataValue', () => {
  it('keeps every JSON primitive, null included', () => {
    expect(asJsonDataValue('Home')).toBe('Home')
    expect(asJsonDataValue(40)).toBe(40)
    expect(asJsonDataValue(false)).toBe(false)
    // `null` is a value a source file can hold; `undefined` is the absence of
    // one, which an insert spells by not writing the prop.
    expect(asJsonDataValue(null)).toBe(null)
    expect(asJsonDataValue(undefined)).toBeUndefined()
  })

  it('keeps the documented shape of a real collection prop', () => {
    const items = [{ label: 'Home' }, { label: 'Explore' }, { label: 'My Trips' }]
    expect(asJsonDataValue(items)).toEqual(items)
  })

  it('drops a value that has no JSX spelling', () => {
    expect(asJsonDataValue(() => {})).toBeUndefined()
    // The `{ svg }` shape the parser captures for an icon prop is data, but the
    // React element a default would need is not.
    expect(asJsonDataValue(Symbol('x'))).toBeUndefined()
  })

  it('drops the WHOLE prop when one leaf is unwritable', () => {
    // Not `[{ label: 'Book' }]` — a button that does nothing when tapped is
    // worse than no button.
    expect(asJsonDataValue([{ label: 'Book', onClick: () => {} }])).toBeUndefined()
    expect(asJsonDataValue({ toolbar: { title: 'Trips', onBack: () => {} } })).toBeUndefined()
  })

  it('drops an object holding an undefined value', () => {
    // `{ label: 'Home', icon: undefined }` cannot be written as-is, and
    // silently omitting the key would change the shape the caller asked for.
    expect(asJsonDataValue({ label: 'Home', icon: undefined })).toBeUndefined()
  })

  it('keeps nesting intact', () => {
    const value = { items: ['Flights', 'Stays'], value: 0, meta: { pinned: true } }
    expect(asJsonDataValue(value)).toEqual(value)
  })
})
