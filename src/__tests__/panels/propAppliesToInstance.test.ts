/**
 * propAppliesToInstance — the gate `renderModuleTabContent.tsx` checks
 * before rendering a design-system module's `appliesWhen`-carrying control
 * (a `pkg.*`/`alm.*` component's schema, built by
 * `src/modules/alm/register.tsx`'s `buildSchema` off
 * `PropSpec.appliesWhen`). Pure-function test, no React, no store — the same
 * posture `componentCallSiteRows.test.ts` uses for the `studio.instance`
 * counterpart of this exact rule.
 */
import { describe, expect, it } from 'bun:test'
import { propAppliesToInstance } from '@site/panels/PropertiesPanel/renderModuleTabContent'

describe('propAppliesToInstance', () => {
  const cardArtGate = { prop: 'variant', values: ['apple-pay', 'gpay-card', 'gpay-personalized'] }

  it('hides the row when the gating prop is not one of the documented values', () => {
    expect(propAppliesToInstance(cardArtGate, 'cardArt', { variant: 'primary' })).toBe(false)
  })

  it('shows the row when the gating prop matches one of the documented values', () => {
    expect(propAppliesToInstance(cardArtGate, 'cardArt', { variant: 'gpay-card' })).toBe(true)
  })

  it('a real value on the gated prop itself always outranks the gate', () => {
    // The reported bug's inverse: someone hand-writes
    // `<Button variant="primary" cardArt="/x.png">`. Hiding the row here
    // would make a real, live prop value silently un-editable.
    expect(propAppliesToInstance(cardArtGate, 'cardArt', { variant: 'primary', cardArt: '/x.png' })).toBe(true)
  })

  it('hides the row when the gating prop is unset entirely', () => {
    expect(propAppliesToInstance(cardArtGate, 'cardArt', {})).toBe(false)
  })
})
