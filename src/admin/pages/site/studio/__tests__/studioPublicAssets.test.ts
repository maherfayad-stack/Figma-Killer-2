/**
 * A design canvas DISPLAYS a Studio project's site-root image (`/hero.png`,
 * its `public/` file) through the authenticated asset route: the canvas
 * iframe lives on the admin origin, where the site-root path names nothing.
 * Found by P5-G's e2e: an image dropped on the free canvas rendered as a
 * zero-size broken image. Display only — nothing here writes a prop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { studioCanvasImageUrl } from '../studioPublicAssets'
import { setStudioLoadedDir } from '../studioWorkspaceDir'

beforeEach(() => {
  window.localStorage.removeItem('studio:studio:dir')
  setStudioLoadedDir('C:/work/demo')
})

afterEach(() => {
  setStudioLoadedDir(null)
})

describe('studioCanvasImageUrl', () => {
  it('maps a site-root path to the asset route under the project public root', () => {
    expect(studioCanvasImageUrl('/hero%20shot.png', 'public')).toBe(
      `/admin/api/studio/asset?dir=${encodeURIComponent('C:/work/demo')}&path=${encodeURIComponent('public/hero shot.png')}`,
    )
    expect(studioCanvasImageUrl('/img/a.png?v=2', 'apps/web/public')).toBe(
      `/admin/api/studio/asset?dir=${encodeURIComponent('C:/work/demo')}&path=${encodeURIComponent('apps/web/public/img/a.png')}`,
    )
  })

  it.each([
    ['an absolute URL', 'https://cdn.example.com/a.png'],
    ['a protocol-relative URL', '//cdn.example.com/a.png'],
    ['an admin route', '/admin/api/studio/asset?dir=x&path=y'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['a relative path', 'img/a.png'],
    ['the bare root', '/'],
  ])('leaves %s alone', (_label, src) => {
    expect(studioCanvasImageUrl(src, 'public')).toBe(src)
  })

  it('is the identity outside a Studio project', () => {
    expect(studioCanvasImageUrl('/hero.png', null)).toBe('/hero.png')
  })
})
