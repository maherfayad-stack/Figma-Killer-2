/**
 * P5-B3 — a project stylesheet's RELATIVE `url(./bg.png)` in a design frame
 * (found, not fixed, in P5-B2 #262).
 *
 * The frame's CSS is injected as text into an `about:srcdoc` document on the
 * admin origin, so `url(./bg.png)` resolved against the admin page and 404ed.
 * Two halves fix it, and both are pinned here:
 *
 *   - the server pins each relative reference to the file it names, as a
 *     `studio-asset:<workspace-rel>` sentinel, when it reads the sheet (it is
 *     the only place that knows which sheet the text came from);
 *   - the canvas turns that sentinel into its asset route's `path=` lookup,
 *     in the editor and on the capture page alike.
 */
import { describe, expect, it } from 'bun:test'
import { STUDIO_ASSET_SENTINEL } from '@core/page-parser'
import { CSS_ASSET_SENTINEL, projectAssetCssUrls, projectAssetUrl, type ProjectAssetUrlScope } from '@site/canvas/canvasProjectAssetUrl'
import { relativeCssUrlsToAssetSentinels } from '../../../server/handlers/studioAsset'

const BASE = 'http://studio.test/admin/site'
const EDITOR: ProjectAssetUrlScope = { route: '/admin/api/studio/asset', query: 'dir=D', base: BASE }
const CAPTURE: ProjectAssetUrlScope = { route: '/admin/api/agent-capture/asset', query: 'token=t0k', base: BASE }

describe('relativeCssUrlsToAssetSentinels (server)', () => {
  it('pins a relative url() to the file it names, relative to the SHEET', () => {
    expect(relativeCssUrlsToAssetSentinels('.hero { background: url(./img/bg.png) }', 'src/styles/app.css')).toBe(
      '.hero { background: url("studio-asset:src/styles/img/bg.png") }',
    )
    expect(relativeCssUrlsToAssetSentinels(".a { background: url('../assets/a b.png') }", 'src/styles/app.css')).toBe(
      '.a { background: url("studio-asset:src/assets/a b.png") }',
    )
    expect(relativeCssUrlsToAssetSentinels('@font-face { src: url("fonts/x.woff2?v=3#iefix") }', 'src/app.css')).toBe(
      '@font-face { src: url("studio-asset:src/fonts/x.woff2") }',
    )
  })

  it('leaves a site-root, absolute, data: or fragment URL exactly as written', () => {
    const css = '.a{background:url(/hero.png)} .b{background:url(https://cdn.test/x.png)} .c{background:url(data:image/png;base64,AA==)} .d{filter:url(#blur)}'
    expect(relativeCssUrlsToAssetSentinels(css, 'src/app.css')).toBe(css)
  })

  it('leaves a reference that climbs out of the project as written', () => {
    const css = '.a { background: url(../../../outside.png) }'
    expect(relativeCssUrlsToAssetSentinels(css, 'src/app.css')).toBe(css)
  })
})

describe('the canvas half', () => {
  it('speaks the same sentinel the parser writes', () => {
    expect(CSS_ASSET_SENTINEL).toBe(STUDIO_ASSET_SENTINEL)
  })

  it('turns the sentinel into the asset route path= lookup, in either scope', () => {
    expect(projectAssetUrl('studio-asset:src/styles/img/bg.png', EDITOR)).toBe(
      '/admin/api/studio/asset?dir=D&path=src%2Fstyles%2Fimg%2Fbg.png',
    )
    expect(projectAssetUrl('studio-asset:src/a.png', CAPTURE)).toBe('/admin/api/agent-capture/asset?token=t0k&path=src%2Fa.png')
  })

  it('end to end: a relative url() in a project sheet reaches the frame as a loadable route', () => {
    const pinned = relativeCssUrlsToAssetSentinels('.hero { background-image: url(./bg.png) }', 'src/app.css')
    expect(projectAssetCssUrls(pinned, EDITOR)).toBe('.hero { background-image: url("/admin/api/studio/asset?dir=D&path=src%2Fbg.png") }')
  })
})
