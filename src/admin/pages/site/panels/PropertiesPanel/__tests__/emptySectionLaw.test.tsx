/**
 * StyleSectionsEditor — the empty-section law
 * (docs/features/inspector-disclosure.md §1 Law 1 / §4 G1).
 *
 * `collapsedWhenEmpty` sections (transform / animations / interaction —
 * every entry left in THIS registry) render as a single header line with a
 * "+" when nothing is set — ANYWHERE, not just on the active breakpoint/
 * condition tab — and must never collapse while an active style search is
 * filtering the panel. `position`/`size`/`appearance`/`layout`/`spacing`/
 * `fill`/`border`/`effects`/`typography` used to be members of this same
 * registry but all migrated out to their own `INSPECTOR_SECTIONS` manifest
 * entries (`STATE.md` `panel-25`, P3 items 1-9) — Fill's own Law-1 coverage
 * now lives in `inspector/sections/__tests__/fillSection.test.tsx`, Stroke's
 * in `inspector/sections/__tests__/strokeSection.test.tsx`, Shadow's in
 * `inspector/sections/__tests__/shadowSection.test.tsx`, Blur's in
 * `inspector/sections/__tests__/blurSection.test.tsx`. Typography's own
 * migration (`TextSection.tsx`, item 9) dropped `collapsedWhenEmpty`
 * entirely rather than moving a Law-1 test elsewhere — a text layer always
 * has real font values to show, so there is no genuinely empty state for it
 * (`TextSection.tsx`'s own doc), and its coverage lives in
 * `inspector/sections/__tests__/textSection.test.tsx` instead. Tests (a)-(f)
 * below therefore exercise `transform` (this registry's own resident
 * example) rather than the departed `typography`; `transformOrigin` are a
 * NEW entry in this registry, relocated here from the old `effects` entry's
 * own ⚙ popover — see `classStyleSections.ts`'s own doc for why.
 *
 * An empty section is also not a DISCLOSURE — no chevron, no toggle, nothing
 * to open. The header earns its accordion when the first value lands in it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { StyleSectionsEditor } from '../StyleSectionsEditor'
import { setEditorPreference } from '@site/preferences/editorPreferences'

/** Multi-property write channel — see `StyleSectionsEditor`'s `onChangeMany`. */
function noopMany() {}

afterEach(() => {
  cleanup()
  setEditorPreference('propertiesSectionsExpanded', true)
})

function noop() {}

type EditorProps = ComponentProps<typeof StyleSectionsEditor>

function renderEditor(overrides: Partial<EditorProps> = {}) {
  return render(
    <StyleSectionsEditor
      storedStyles={{}}
      currentStyles={{}}
      sectionKey="base"
      styleQuery=""
      onChange={noop}
      onChangeMany={noopMany}
      onRemove={noop}
      onClearProperties={noop}
      onPreview={noop}
      onClearPreview={noop}
      {...overrides}
    />,
  )
}

describe('StyleSectionsEditor — empty-section law (G1)', () => {
  it('(a) an empty collapsible section renders its header only, with a "+"', () => {
    renderEditor()

    // Transform is `collapsedWhenEmpty` and nothing is set anywhere — no
    // property grid, just the header line and its "+".
    expect(document.querySelector('[data-testid="css-property-row-transform"]')).toBeNull()
    expect(screen.getByRole('button', { name: /add transform/i })).toBeDefined()

    // Same one-line treatment for the other collapsible section.
    expect(screen.getByRole('button', { name: /add interaction/i })).toBeDefined()
  })

  it('(b) a section with a base value set renders its body', () => {
    renderEditor({ storedStyles: { transform: 'rotate(10deg)' } })

    expect(document.querySelector('[data-testid="css-property-row-transform"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add transform/i })).toBeNull()
    expect(screen.getByTestId('class-style-section-dot-transform')).toBeDefined()
  })

  it('(c) a section whose ONLY value is on a non-active breakpoint still renders its body', () => {
    // The active tab's own bag is empty; the value lives on another context
    // (e.g. a tablet breakpoint override), surfaced via `crossContextStyles`.
    renderEditor({
      storedStyles: {},
      crossContextStyles: [{}, { transform: 'rotate(10deg)' }],
    })

    expect(document.querySelector('[data-testid="css-property-row-transform"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add transform/i })).toBeNull()
    // The dot reflects the cross-context value too — the section isn't just
    // open, it visibly says something is set somewhere.
    expect(screen.getByTestId('class-style-section-dot-transform')).toBeDefined()
  })

  it('a value on a non-active breakpoint does NOT force a truly empty section open', () => {
    renderEditor({
      storedStyles: {},
      crossContextStyles: [{}, {}],
    })

    expect(document.querySelector('[data-testid="css-property-row-transform"]')).toBeNull()
    expect(screen.getByRole('button', { name: /add transform/i })).toBeDefined()
  })

  it('(d) an active style search forces bodies open, even for an otherwise-empty section', () => {
    renderEditor({ storedStyles: {}, styleQuery: 'transform' })

    expect(document.querySelector('[data-testid="css-property-row-transform"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add transform/i })).toBeNull()
  })

  it('clicking "+" reveals the section body for this render', () => {
    renderEditor()

    expect(document.querySelector('[data-testid="css-property-row-transform"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /add transform/i }))
    expect(document.querySelector('[data-testid="css-property-row-transform"]')).not.toBeNull()
  })

  it('(e) an empty section is NOT a disclosure — no chevron, no toggle, no body', () => {
    renderEditor()

    const transform = document.querySelector('[data-style-section="transform"]')!
    // The disclosure toggle is the only control in a Section header that
    // carries `aria-expanded` for the section itself. Transform's empty
    // header offers a plain "+" and nothing else, so the whole subtree has
    // no expandable control and no body element to expand into.
    expect(transform.querySelectorAll('[aria-expanded]')).toHaveLength(0)
    expect(transform.querySelector('svg')).not.toBeNull() // the section's own icon survives
    expect(transform.textContent).toContain('Transform')
  })

  it('(f) a filled section IS a disclosure — the accordion comes back with content', () => {
    renderEditor({ storedStyles: { transform: 'rotate(10deg)' } })

    const transform = document.querySelector('[data-style-section="transform"]')!
    const toggle = transform.querySelector('[aria-expanded]')
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('aria-expanded')).toBe('true')
  })

  it('(g) adding the first value opens the section, even with sections collapsed by default', () => {
    // With the preference off, a section that stops being empty would open at
    // the user's collapsed default — "+ Transition" would write motion
    // straight into the panel and show a closed header. The add gesture
    // reveals as well as writes. (Fill's own version of this test moved to
    // `inspector/sections/__tests__/fillSection.test.tsx` once Fill migrated
    // to its own manifest entry, `STATE.md` `panel-25` P3 item 5; Shadow's
    // moved to `inspector/sections/__tests__/shadowSection.test.tsx`, P3 item
    // 7. Animations is the remaining `StyleSectionsEditor`-hosted
    // collapsedWhenEmpty section whose "+" writes a real value immediately —
    // "Transition" rather than "Animation" so this pure-component test never
    // has to touch the animation menu item's `createAmbientRule` store call.)
    setEditorPreference('propertiesSectionsExpanded', false)

    const written: Array<[string, unknown]> = []
    const { rerender } = render(
      <StyleSectionsEditor
        storedStyles={{}}
        currentStyles={{}}
        sectionKey="base"
        styleQuery=""
        onChange={(property, value) => written.push([String(property), value])}
        onChangeMany={noopMany}
        onRemove={noop}
        onClearProperties={noop}
        onPreview={noop}
        onClearPreview={noop}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /add animations/i }))
    fireEvent.click(screen.getByText('Transition'))
    expect(written).toHaveLength(1)
    expect(written[0]![0]).toBe('transition')

    // The store round-trip the real panel does: the written value comes back
    // as `storedStyles`, and the section must now be showing its body rather
    // than sitting closed behind the collapsed-by-default preference.
    rerender(
      <StyleSectionsEditor
        storedStyles={{ transition: String(written[0]![1]) }}
        currentStyles={{}}
        sectionKey="base"
        styleQuery=""
        onChange={noop}
        onChangeMany={noopMany}
        onRemove={noop}
        onClearProperties={noop}
        onPreview={noop}
        onClearPreview={noop}
      />,
    )

    const animations = document.querySelector('[data-style-section="animations"]')!
    expect(animations.querySelector('[aria-expanded="true"]')).not.toBeNull()
  })
})
