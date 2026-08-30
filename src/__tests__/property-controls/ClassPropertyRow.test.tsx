import { describe, expect, it } from 'bun:test'

describe('ClassPropertyRow remove button layout', () => {
  it('does not reserve a right-side gutter that shrinks property controls', async () => {
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css', import.meta.url),
      'utf-8',
    )

    expect(css).not.toMatch(/\.propertyRowWrap\[data-state="set"\]\s*\{[^}]*padding-right:/s)
  })

  it('overlays the remove button on the left label column with a fade', async () => {
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css', import.meta.url),
      'utf-8',
    )
    const controlCss = readFileSync(
      new URL('../../ui/components/ControlRow/ControlRow.module.css', import.meta.url),
      'utf-8',
    )
    const globalsCss = readFileSync(
      new URL('../../styles/globals.css', import.meta.url),
      'utf-8',
    )
    const compactCss = css.replace(/\s+/g, '')

    // The label column is ONE decision, not three. It used to be the literal
    // `100px` written out in ControlRow, here, and in LayoutSection — three
    // copies that had to agree for the hover-revealed remove button to land on
    // the right pixel, and that the properties panel could not narrow without
    // editing all of them. It is now `--control-label-w`, defined once in
    // globals and rebound by the panel to its own tighter `--inspector-label-w`.
    // These assertions pin the indirection, not the number: a future density
    // pass should be able to change the value without touching this test, but
    // must not be able to reintroduce a second copy of it.
    expect(controlCss).toMatch(/grid-template-columns:\s*var\(--control-label-w\)\s+1fr/)
    expect(globalsCss).toMatch(/--control-label-w:\s*\d+px/)
    expect(globalsCss).toMatch(/--control-row-h:\s*\d+px/)
    expect(globalsCss).toMatch(/--inspector-label-w:\s*\d+px/)
    expect(css).toMatch(/--class-remove-label-column:\s*var\(--control-label-w\)/)
    expect(css).toMatch(
      /--class-remove-row-center:\s*calc\(var\(--control-row-h\)\s*\/\s*2\)/,
    )
    expect(css).toMatch(/--class-remove-button-size:\s*\d+px/)
    expect(css).toMatch(/--class-remove-fade-width:\s*36px/)
    expect(css).toMatch(/\.propertyRowWrap\[data-state="set"\]::after\s*\{[^}]*linear-gradient/s)
    expect(compactCss).toContain(
      '.removeBtn{position:absolute;top:calc(var(--class-remove-row-center)-(var(--class-remove-button-size)/2));left:calc(var(--class-remove-label-column)-var(--class-remove-button-size)-4px)',
    )
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*width:\s*var\(--class-remove-button-size\)/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*height:\s*var\(--class-remove-button-size\)/s)
    // There are deliberately two anchoring modes: the base `.removeBtn` rule
    // overlays the inline label column via `left` (no `right`),
    // while the stacked-layout descendant selector `.propertyRowWrapStacked
    // .removeBtn` re-anchors to the row's top-right corner via `right`
    // (stacked cells have no label column to overlay). Anchor the negative
    // assertion to the base rule only (`^\.removeBtn` at line-start) so it
    // can't be satisfied by the tail of the unrelated descendant selector.
    expect(css).not.toMatch(/^\.removeBtn\s*\{[^}]*right:/ms)
    expect(css).not.toMatch(/^\.removeBtn\s*\{[^}]*translateY\(-50%\)/ms)
    expect(css).toMatch(
      /\.propertyRowWrapStacked \.removeBtn\s*\{[^}]*top:\s*0[^}]*left:\s*auto[^}]*right:\s*0/s,
    )

    // A `bare` row — an icon toggle group, or a field whose glyph names it —
    // has no label column to overlay and no room for a 20px button beside a
    // 24px control. Its control carries the clear affordance instead (click
    // the pressed segment, empty the field), so the overlay must be off.
    expect(css).toMatch(/\.propertyRowWrapBare \.removeBtn\s*\{[^}]*display:\s*none/s)
  })

  it('uses a neutral remove affordance instead of the destructive danger hover style', async () => {
    const { readFileSync } = await import('fs')
    const rowSource = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.tsx', import.meta.url),
      'utf-8',
    )
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css', import.meta.url),
      'utf-8',
    )

    // Neutral affordance: no danger hover variant, default color is the
    // secondary-text token, hover shifts to the primary-text token. The exact
    // hover background treatment (subtle white tint, transparent + border, …)
    // is owned by visual design and not pinned here — the contract is just
    // "no danger tokens, no destructive styling".
    expect(rowSource).not.toContain('dangerHover')
    expect(rowSource).toContain('<CloseIcon size={16}')
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*color:\s*var\(--text-muted\)/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn:hover[\s\S]*color:\s*var\(--text\)/s)
    expect(css).not.toContain('editor-danger')
  })
})

describe('StyleRuleComposer module style remove button layout', () => {
  it('does not reserve a right-side gutter for module-owned style rows', async () => {
    // Module-owned style rows were removed when classStyleBindings was deleted.
    // This gate ensures no moduleStyleRow padding-right accidentally reappears.
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/StyleRuleComposer.module.css', import.meta.url),
      'utf-8',
    )

    expect(css).not.toMatch(/\.moduleStyleRow\s*\{[^}]*padding-right:/s)
  })
})
