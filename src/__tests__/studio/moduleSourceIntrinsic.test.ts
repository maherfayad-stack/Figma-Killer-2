/**
 * `sourceIntrinsic` — how a `base.*` module spells itself in a user's React
 * source when it is an intrinsic element rather than an imported component.
 *
 * This is what makes "Add Text / Div / Span" work on a studio-imported page.
 * Before it, the insert path required `sourceImport`, so every `base.*` module
 * was refused with "…is an editor building block, not a component in your
 * project's code" — including `<div>` and `<p>`, which need no import at all
 * and which `insertJsxElement` has always been able to write (it omits
 * `importSpecifier` for exactly this case).
 */
import { describe, it, expect } from 'bun:test'
import { ContainerModule } from '@modules/base/container'
import { TextModule } from '@modules/base/text'

describe('base.container sourceIntrinsic', () => {
  it('spells itself as its own tag', () => {
    expect(ContainerModule.sourceIntrinsic?.({ ...ContainerModule.defaults, tag: 'div' })).toEqual({ tag: 'div' })
    expect(ContainerModule.sourceIntrinsic?.({ ...ContainerModule.defaults, tag: 'section' })).toEqual({ tag: 'section' })
  })

  it('resolves the custom-tag escape hatch, which is how a <span> is stored', () => {
    // `span` is not in `htmlTag.ts`'s built-in list, so it rides the custom
    // hatch — the same representation the HTML importer already produces for
    // an imported <span> (`structurePreservation.test.ts`).
    expect(
      ContainerModule.sourceIntrinsic?.({ ...ContainerModule.defaults, tag: 'custom', customTag: 'span' }),
    ).toEqual({ tag: 'span' })
  })

  it('never yields an unsafe tag name', () => {
    expect(
      ContainerModule.sourceIntrinsic?.({ ...ContainerModule.defaults, tag: 'custom', customTag: 'script' }),
    ).toEqual({ tag: 'div' })
  })

  it('agrees with htmlTag, so the file and the canvas cannot disagree', () => {
    for (const tag of ['div', 'section', 'article', 'nav']) {
      const props = { ...ContainerModule.defaults, tag }
      expect(ContainerModule.sourceIntrinsic?.(props).tag).toBe(ContainerModule.htmlTag?.(props) as string)
    }
  })

  it('carries no text — a container is written empty', () => {
    expect(ContainerModule.sourceIntrinsic?.({ ...ContainerModule.defaults, tag: 'div' }).text).toBeUndefined()
  })
})

describe('base.text sourceIntrinsic', () => {
  it('writes the tag wrapping its literal text', () => {
    expect(TextModule.sourceIntrinsic?.({ ...TextModule.defaults, tag: 'h2', text: 'Hello' })).toEqual({
      tag: 'h2',
      text: 'Hello',
    })
  })

  it('falls back to the default tag for "none", which has no JSX equivalent', () => {
    // 'none' means "no wrapper" on the canvas. A bare text node is not an
    // element, so the parser could never hand an id back for it.
    expect(TextModule.sourceIntrinsic?.({ ...TextModule.defaults, tag: 'none', text: 'Hi' })).toEqual({
      tag: 'p',
      text: 'Hi',
    })
  })

  it('defaults to a paragraph', () => {
    expect(TextModule.sourceIntrinsic?.(TextModule.defaults).tag).toBe('p')
  })
})

describe('modules with no source spelling', () => {
  it('omit sourceIntrinsic, so the insert path still refuses them out loud', async () => {
    const { LoopModule } = await import('@modules/base/loop')
    expect(LoopModule.sourceIntrinsic).toBeUndefined()
  })
})
