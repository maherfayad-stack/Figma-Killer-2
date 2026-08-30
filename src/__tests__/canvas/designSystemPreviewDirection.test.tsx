/**
 * The board's direction toggle has to reach a design-system component's
 * JavaScript, not just its CSS.
 *
 * `dir` on the frame's `<html>` drives every `[dir=rtl]` CSS rule a package
 * ships (40 of them in `@alm-design/design-system` alone) and drives NOTHING
 * that resolves direction in JS. ALM's components each call `useDir(prop)` —
 * explicit prop > `DesignSystemProvider` context > a built-in `'ltr'` — and
 * Studio wraps every design-system component in that provider. Wrapping it
 * with NO props, which is what both registration paths used to do, pinned the
 * provider to its `'ltr'` default: the CSS half of an RTL preview flipped and
 * the JS half did not, so a mirrored chevron stayed pointing the wrong way on
 * a screen that was otherwise right-to-left.
 *
 * The assertion is the `dir` attribute ALM puts on each component's own root
 * element, which is the visible end of exactly that chain: frame axes ->
 * `FramePreviewAxesContext` -> the package's provider -> `useDir()` -> DOM.
 *
 * `registerProjectModules.ts`'s generic `pkg.*` path does the identical thing
 * for any installed package's discovered provider; this suite covers the
 * `alm.*` path because it is the one with a real package installed in THIS
 * repo to render against.
 */
import { describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { registry, type ModuleComponentProps } from '@core/module-engine'
import { DEFAULT_PREVIEW_AXES } from '@core/studio-board'
import { FramePreviewAxesContext } from '@site/canvas/previewAxesFrameEffect'
import '@modules/alm/register'

function almButton(): React.FC<ModuleComponentProps> {
  const Component = registry.get('alm.Button')?.component
  if (!Component) throw new Error('alm.Button is not registered')
  return Component as React.FC<ModuleComponentProps>
}

function renderInFrame(direction: 'ltr' | 'rtl'): HTMLElement {
  const Button = almButton()
  const { container } = render(
    <FramePreviewAxesContext.Provider value={{ ...DEFAULT_PREVIEW_AXES, direction }}>
      <Button props={{ label: 'Continue' }} nodeId="n1" isSelected={false} />
    </FramePreviewAxesContext.Provider>,
  )
  const button = container.querySelector('button')
  if (!button) throw new Error('alm.Button rendered no <button>')
  return button
}

describe('design-system components follow the frame preview direction', () => {
  it('renders right-to-left when the frame previews rtl', () => {
    expect(renderInFrame('rtl').getAttribute('dir')).toBe('rtl')
    cleanup()
  })

  it('renders left-to-right when the frame previews ltr', () => {
    expect(renderInFrame('ltr').getAttribute('dir')).toBe('ltr')
    cleanup()
  })

  it('falls back to the board default outside any frame', () => {
    const Button = almButton()
    const { container } = render(<Button props={{ label: 'Continue' }} nodeId="n1" isSelected={false} />)
    expect(container.querySelector('button')?.getAttribute('dir')).toBe(DEFAULT_PREVIEW_AXES.direction)
    cleanup()
  })
})
