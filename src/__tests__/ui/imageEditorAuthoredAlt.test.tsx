/**
 * P5-B3 — the canvas `<img>` keeps its AUTHORED `alt` (found, not fixed, in
 * P5-B2 #262).
 *
 * A Studio page's `<img src="/hero.png" alt="Team photo" />` is parsed onto
 * `props.alt`, but `ImageEditor` rendered `alt=""` — the CMS media-library
 * rule, which knows nothing of a Studio page. So the canvas told a screen
 * reader (and the accessibility audit) that an image the user DESCRIBED was
 * decorative, and every image a drop wrote with `alt="hero"` read as blank.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ImageModule } from '@modules/base/image'
import { ImageEditor } from '@modules/base/image/ImageEditor'

afterEach(cleanup)

function renderedImg(props: Record<string, unknown>): HTMLImageElement {
  const { container } = render(<ImageEditor props={{ ...ImageModule.defaults, ...props } as typeof ImageModule.defaults} />)
  const img = container.querySelector('img')
  if (!img) throw new Error('no <img> rendered')
  return img
}

describe('ImageEditor — alt', () => {
  it('renders the alt the source declares', () => {
    expect(renderedImg({ src: '/hero.png', alt: 'Team photo' }).getAttribute('alt')).toBe('Team photo')
  })

  it('keeps an authored EMPTY alt empty — that is the author saying "decorative"', () => {
    expect(renderedImg({ src: '/divider.png', alt: '' }).getAttribute('alt')).toBe('')
  })

  it('with no authored alt at all, the old behaviour stands (empty)', () => {
    expect(renderedImg({ src: '/hero.png' }).getAttribute('alt')).toBe('')
  })
})
