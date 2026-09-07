/**
 * Image fill, end to end through the panel (docs/features/inspector-disclosure.md §4 G6.5).
 *
 * The one thing worth asserting at this level: picking a project image writes
 * a `background-image` layer whose URL is the one the USER'S build resolves —
 * not Studio's own `/admin/api/studio/asset` preview URL, which is what the
 * grid renders its thumbnails from. Confusing the two would paste an
 * admin-origin URL into the user's stylesheet.
 *
 * The project asset list is mocked, so this test never touches the network or
 * a real workspace; `projectAssets.test.ts` covers the real directory walk.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const ASSETS = ['public/hero.png', 'src/assets/EN-2.png']

mock.module('../../../studio/projectAssets', () => ({
  fetchProjectImageAssets: () => Promise.resolve(ASSETS),
  invalidateProjectImageAssets: () => {},
  studioAssetPreviewUrl: (relPath: string) => `/admin/api/studio/asset?path=${relPath}`,
  useProjectImageAssets: () => ASSETS,
  imageFillPreviewSrc: (cssUrl: string) => `/admin/api/studio/asset?url=${cssUrl}`,
}))

const { FillSectionActions } = await import('../FillSection')

afterEach(cleanup)

/** The last value `onChange` was given for `backgroundImage`. */
function backgroundImageFrom(calls: Array<[string, unknown]>): unknown {
  return calls.filter(([property]) => property === 'backgroundImage').at(-1)?.[1]
}

describe('Fill — add an image fill', () => {
  it('opens a source picker instead of writing a speculative empty layer', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{}} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))

    expect(screen.getByRole('group', { name: 'Image source' })).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('writes the URL the project\'s build resolves, not the admin preview URL', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{}} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))
    fireEvent.click(screen.getByRole('button', { name: /hero\.png/ }))

    const written = backgroundImageFrom(onChange.mock.calls as Array<[string, unknown]>)
    expect(written).toBe("url('/hero.png')")
    expect(String(written)).not.toContain('/admin/api/studio/asset')
  })

  it('inserts the image ABOVE an existing gradient — first layer paints topmost', () => {
    const gradient = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)'
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{ backgroundImage: gradient }} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))
    fireEvent.click(screen.getByRole('button', { name: /hero\.png/ }))

    expect(backgroundImageFrom(onChange.mock.calls as Array<[string, unknown]>)).toBe(
      `url('/hero.png'), ${gradient}`,
    )
  })

  it('refuses to add a layer when the layer list itself was refused', () => {
    render(<FillSectionActions storedStyles={{ backgroundImage: 'var(--layers)' }} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Add image fill' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('warns on an asset outside the public root instead of silently writing a dev-only URL', () => {
    render(<FillSectionActions storedStyles={{}} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))

    const bundled = screen.getByRole('button', { name: /EN-2\.png/ })
    expect(bundled.textContent).toContain('dev only')
  })
})
