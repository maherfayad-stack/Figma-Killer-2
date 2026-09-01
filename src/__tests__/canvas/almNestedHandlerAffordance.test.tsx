/**
 * A handler nested INSIDE an object-valued prop (`toolbar={{ …, onBack: () =>
 * {} }}`) is the same class of bug `board-25` fixed for a top-level handler,
 * one level deeper — see `docs/features/studio-import.md`'s "A function
 * NESTED inside a structured prop" section.
 *
 * `<Navbar toolbar={{ variant: 'default', title: t.page.account, onBack: ()
 * => {} }} surface="default" />` resolves `variant`/`title` fine and drops
 * `onBack` (a function has no JSON form) — but the package draws its leading
 * `.glass-btn--type-back` ONLY when `toolbar.onBack` is truthy, so the
 * button silently vanished from a design that plainly has one. This suite
 * exercises the RENDER half of the fix: `register.tsx`'s `makeComponent`
 * reading `ModuleComponentProps.codeFunctionPaths` and standing a no-op back
 * up at exactly the recorded nested path — never anywhere the caller did not
 * name.
 */
import { describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { registry, type ModuleComponentProps } from '@core/module-engine'
import '@modules/alm/register'

function almNavbar(): React.FC<ModuleComponentProps> {
  const Component = registry.get('alm.Navbar')?.component
  if (!Component) throw new Error('alm.Navbar is not registered')
  return Component as React.FC<ModuleComponentProps>
}

describe('a handler nested inside an object prop still draws its affordance', () => {
  it('draws the back button when codeFunctionPaths names the nested onBack the source wrote', () => {
    const Navbar = almNavbar()
    const { container } = render(
      <Navbar
        props={{ platform: 'ios', surface: 'default', toolbar: { variant: 'default', title: 'Account' } }}
        nodeId="n1"
        isSelected={false}
        codeProps={['toolbar']}
        codeFunctionPaths={['toolbar.onBack']}
      />,
    )
    expect(container.querySelector('.glass-btn--type-back')).not.toBeNull()
    cleanup()
  })

  it('draws no back button when the source never wrote onBack at all', () => {
    // The refusal half: `codeFunctionPaths` absent must never invent an
    // affordance the source does not have (board-25's rule, one level
    // deeper) — a `toolbar` with only `title` renders no back button.
    const Navbar = almNavbar()
    const { container } = render(
      <Navbar
        props={{ platform: 'ios', surface: 'default', toolbar: { variant: 'default', title: 'Account' } }}
        nodeId="n1"
        isSelected={false}
      />,
    )
    expect(container.querySelector('.glass-btn--type-back')).toBeNull()
    cleanup()
  })

  it('does not mutate the node\'s own props object when standing up the nested no-op', () => {
    // `withValueAtPath` must clone along the path rather than writing into
    // the shared node — a second render (or a second node reusing the same
    // resolved object reference) must not see a leaked function.
    const Navbar = almNavbar()
    const toolbar = { variant: 'default', title: 'Account' } as Record<string, unknown>
    const props = { platform: 'ios', surface: 'default', toolbar }
    render(
      <Navbar
        props={props}
        nodeId="n1"
        isSelected={false}
        codeProps={['toolbar']}
        codeFunctionPaths={['toolbar.onBack']}
      />,
    )
    expect(toolbar.onBack).toBeUndefined()
    cleanup()
  })
})
