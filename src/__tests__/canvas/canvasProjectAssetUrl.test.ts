/**
 * P5-B2 — a portal frame lives on the admin origin, so a site-root
 * `src="/hero.png"` (what every image drop writes) loaded from Studio's own
 * server and showed broken. `canvasProjectAssetUrl.ts` resolves such URLs to
 * the project asset route at the sinks that hand a URL to the frame; these
 * cases pin what is rewritten and, just as much, what is left alone.
 */
import { describe, expect, it } from 'bun:test'
import {
  projectAssetCssUrls,
  projectAssetProps,
  projectAssetSrcset,
  projectAssetStyle,
  projectAssetUrl,
  type ProjectAssetUrlScope,
} from '@site/canvas/canvasProjectAssetUrl'
import { canvasFrameCss } from '@site/canvas/canvasFrameCss'

const DIR = 'C:\\work\\studio-workspace\\shop'
/** The admin page a portal frame inherits its base URL from. */
const BASE = 'http://studio.test/admin/site'
const EDITOR: ProjectAssetUrlScope = { route: '/admin/api/studio/asset', query: `dir=${encodeURIComponent(DIR)}`, base: BASE }
const CAPTURE: ProjectAssetUrlScope = { route: '/admin/api/agent-capture/asset', query: 'token=t0k', base: BASE }

const editorUrl = (url: string) => `/admin/api/studio/asset?dir=${encodeURIComponent(DIR)}&url=${encodeURIComponent(url)}`

describe('projectAssetUrl', () => {
  it('sends a site-root URL to the scope route, the URL itself percent-encoded as `url`', () => {
    expect(projectAssetUrl('/hero.png', EDITOR)).toBe(editorUrl('/hero.png'))
    expect(projectAssetUrl('/img/a%20b.png?v=2', EDITOR)).toBe(editorUrl('/img/a%20b.png?v=2'))
    expect(projectAssetUrl('/hero.png', CAPTURE)).toBe('/admin/api/agent-capture/asset?token=t0k&url=%2Fhero.png')
  })

  it('omits the scope query when there is none (no project chosen yet: the server falls back)', () => {
    expect(projectAssetUrl('/hero.png', { route: '/admin/api/studio/asset', query: '', base: BASE })).toBe(
      '/admin/api/studio/asset?url=%2Fhero.png',
    )
  })

  it('leaves another origin and every non-http(s) scheme exactly as written', () => {
    for (const value of [
      'https://cdn.example/x.png',
      'data:image/png;base64,AAAA',
      'blob:http://studio.test/123', // a drop's optimistic ghost: SAME origin, still left alone
      '//evil.example/x.png', // protocol-relative: another HOST
      '/\\evil.example/x.png', // the WHATWG parser reads this as protocol-relative too
      'http://studio.test:8080/admin/x', // another PORT is another origin
      '',
      '#frag',
    ]) {
      expect(projectAssetUrl(value, EDITOR)).toBe(value)
    }
  })

  it('forwards a relative URL as written; the server resolves site-root URLs only, so it 404s', () => {
    // Resolved against the admin page these would be `/admin/hero.png` and
    // friends: a request on the admin origin page content must never make.
    for (const value of ['hero.png', './hero.png', '../hero.png', 'api/studio/save']) {
      expect(projectAssetUrl(value, EDITOR)).toBe(editorUrl(value))
    }
  })

  /**
   * Security review of #262, nit 1: the `/uploads/` skip was a RAW prefix
   * test, so a value that merely starts with `/uploads/` but normalizes
   * elsewhere passed through untouched and became a cookie-carrying GET.
   */
  it('judges /uploads/ on the NORMALIZED path: /uploads/../admin/… is rewritten, never passed through', () => {
    expect(projectAssetUrl('/uploads/../admin/api/studio/save', EDITOR)).toBe(editorUrl('/admin/api/studio/save'))
    expect(projectAssetUrl('/uploads/%2e%2e/admin/api/x', EDITOR)).toBe(editorUrl('/admin/api/x'))
    expect(projectAssetUrl('/uploads/./%2E%2E/_studio/mcp', EDITOR)).toBe(editorUrl('/_studio/mcp'))
  })

  it('rewrites a same-origin ABSOLUTE or protocol-relative URL into the admin origin too', () => {
    expect(projectAssetUrl('http://studio.test/admin/api/studio/save', EDITOR)).toBe(editorUrl('/admin/api/studio/save'))
    expect(projectAssetUrl('//studio.test/_studio/mcp?x=1', EDITOR)).toBe(editorUrl('/_studio/mcp?x=1'))
    expect(projectAssetUrl('HTTP://STUDIO.TEST/uploads/../admin/x', EDITOR)).toBe(editorUrl('/admin/x'))
  })

  it('no same-origin value reaches /admin/ or /_studio/ except the scope route itself', () => {
    const hostile = [
      '/admin/api/studio/save',
      '/uploads/../admin/api/x',
      '/uploads/%2e%2e/admin/api/x',
      '/uploads/..%2fadmin/x',
      '/_studio/mcp',
      '/uploads/../_studio/mcp',
      'http://studio.test/admin/x',
      '//studio.test/admin/x',
      '/\\studio.test/admin/x',
      '../api/studio/save',
      '/admin/api/studio/asset/../save',
      '/admin/api/studio/asset%2F..%2Fsave',
    ]
    for (const value of hostile) {
      const out = projectAssetUrl(value, EDITOR)
      const requested = new URL(out, BASE)
      if (requested.origin !== new URL(BASE).origin) continue
      expect(requested.pathname === EDITOR.route || !/^\/(admin|_studio)\//.test(requested.pathname)).toBe(true)
    }
  })

  it("leaves the admin's own CMS media library alone: its responsive variants are already loadable", () => {
    expect(projectAssetUrl('/uploads/background-w1024.webp', EDITOR)).toBe('/uploads/background-w1024.webp')
  })

  it('does not rewrite a URL that already points at the scope route (an import the parse resolved)', () => {
    const resolvedImport = `/admin/api/studio/asset?dir=${encodeURIComponent(DIR)}&path=src%2Fassets%2Fhero.png`
    expect(projectAssetUrl(resolvedImport, EDITOR)).toBe(resolvedImport)
    const captureImport = '/admin/api/agent-capture/asset?token=t0k&path=src%2Fa.png'
    expect(projectAssetUrl(captureImport, CAPTURE)).toBe(captureImport)
  })
})

describe('projectAssetSrcset', () => {
  it('resolves each candidate and keeps its descriptor', () => {
    expect(projectAssetSrcset('/a.png 1x, /b.png 2x', EDITOR)).toBe(`${editorUrl('/a.png')} 1x, ${editorUrl('/b.png')} 2x`)
    expect(projectAssetSrcset('https://cdn/a.png 640w, /b.png 1280w', EDITOR)).toBe(
      `https://cdn/a.png 640w, ${editorUrl('/b.png')} 1280w`,
    )
  })
})

describe('projectAssetCssUrls', () => {
  it('rewrites every spelling of a site-root url(), double-quoting the result', () => {
    const css = `.a{background:url(/a.png)} .b{background:url('/b.png')} .c{background:url( "/c.png" )}`
    expect(projectAssetCssUrls(css, EDITOR)).toBe(
      `.a{background:url("${editorUrl('/a.png')}")} .b{background:url("${editorUrl('/b.png')}")} .c{background:url("${editorUrl('/c.png')}")}`,
    )
  })

  it('reaches a font in @font-face and a layered background list', () => {
    const css = `@font-face{font-family:X;src:url(/fonts/x.woff2) format("woff2")}\n.h{background-image:url('/top.png'), linear-gradient(red, blue), url(https://cdn/x.png)}`
    const out = projectAssetCssUrls(css, EDITOR)
    expect(out).toContain(`url("${editorUrl('/fonts/x.woff2')}") format("woff2")`)
    expect(out).toContain(`url("${editorUrl('/top.png')}"), linear-gradient(red, blue), url(https://cdn/x.png)`)
  })

  it('decodes CSS escapes before judging: url(\\2f admin/…) is /admin/…, not a pass-through', () => {
    const out = projectAssetCssUrls('.x{background:url(\\2f admin/api/studio/save)}', EDITOR)
    expect(out).toBe(`.x{background:url("${editorUrl('/admin/api/studio/save')}")}`)
    const quoted = projectAssetCssUrls(".x{background:url('\\2f uploads\\2f ..\\2f admin/x')}", EDITOR)
    expect(quoted).toBe(`.x{background:url("${editorUrl('/admin/x')}")}`)
    const escapedSlash = projectAssetCssUrls('.x{background:url(\\/admin/x)}', EDITOR)
    expect(escapedSlash).toBe(`.x{background:url("${editorUrl('/admin/x')}")}`)
  })

  it('returns the SAME text when nothing is site-root', () => {
    const css = `.a{background:url(data:image/png;base64,AAAA)} .b{background:url('https://x/y.png')} .c{color:red}`
    expect(projectAssetCssUrls(css, EDITOR)).toBe(css)
  })

  it('a hostile file name cannot close the url() it is resolved into', () => {
    // What `assetSiteUrl.ts` writes for `public/a'), url(evil.png), url('.png`.
    const written = "url('/a%27%29%2C%20url%28evil.png%29%2C%20url%28%27.png')"
    const out = projectAssetCssUrls(`.x{background:${written}}`, EDITOR)
    expect(out.match(/url\(/g)).toHaveLength(1)
    expect(out).toMatch(/^\.x\{background:url\("[^"\\\n]+"\)\}$/)
  })
})

describe('projectAssetProps', () => {
  it('resolves src, srcSet and poster and nothing else', () => {
    const props = { src: '/hero.png', srcSet: '/a.png 2x', poster: '/p.png', href: '/about', text: '/hero.png', alt: 'hero' }
    expect(projectAssetProps(props, EDITOR)).toEqual({
      src: editorUrl('/hero.png'),
      srcSet: `${editorUrl('/a.png')} 2x`,
      poster: editorUrl('/p.png'),
      href: '/about',
      text: '/hero.png',
      alt: 'hero',
    })
  })

  it('returns the same object when nothing needed resolving (no fresh object per render)', () => {
    const props = { src: 'https://cdn/x.png', text: 'hi' }
    expect(projectAssetProps(props, EDITOR)).toBe(props)
    const none = { text: 'hi' }
    expect(projectAssetProps(none, EDITOR)).toBe(none)
  })

  it('never mutates the props it was given (they are the store\'s)', () => {
    const props = Object.freeze({ src: '/hero.png' })
    expect(projectAssetProps(props, EDITOR).src).toBe(editorUrl('/hero.png'))
    expect(props.src).toBe('/hero.png')
  })
})

describe('projectAssetStyle', () => {
  it('resolves url() in an inline style and keeps everything else', () => {
    const style = { backgroundImage: "url('/bg.png')", backgroundSize: 'cover', width: 20 }
    expect(projectAssetStyle(style, EDITOR)).toEqual({
      backgroundImage: `url("${editorUrl('/bg.png')}")`,
      backgroundSize: 'cover',
      width: 20,
    })
  })

  it('returns the same object (or undefined) when nothing changed', () => {
    const style = { color: 'red' }
    expect(projectAssetStyle(style, EDITOR)).toBe(style)
    expect(projectAssetStyle(undefined, EDITOR)).toBeUndefined()
  })
})

describe('canvasFrameCss — every injector\'s one canvas-only CSS pass', () => {
  it('resolves site-root url()s alongside the viewport pin', () => {
    const out = canvasFrameCss(".hero{min-height:100vh;background:url('/bg.png')}", { width: 390, height: 844 })
    expect(out).toContain('/admin/api/studio/asset?')
    expect(out).toContain('url=%2Fbg.png')
    expect(out).not.toContain('100vh')
  })
})
