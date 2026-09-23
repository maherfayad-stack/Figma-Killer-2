/**
 * assetSiteUrl — THE "file on disk → URL" rule (IMG-1, audit 07 §A.1 bug 2).
 *
 * It replaced three copies that disagreed. The cases below are the ones where
 * they disagreed: a monorepo's app root (the client copy joined `public` to
 * the PROJECT dir), a `public/` that is not the app's (the old server copy
 * took whatever followed the LAST `public/` anywhere in the path), and a file
 * no dev server serves at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { assetSiteUrlResolver } from '../studio/assetSiteUrl'
import { resolveAppRoot } from '../studio/appRoot'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-site-url-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(rel: string, contents: string): void {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

describe('assetSiteUrlResolver — app root is the project dir', () => {
  beforeEach(() => write('package.json', JSON.stringify({ name: 'app', devDependencies: { vite: '^5.0.0' } })))

  it('serves a public/ file from the site root and calls it build-safe', () => {
    const url = assetSiteUrlResolver(tmpDir)
    expect(url('public/hero.png')).toEqual({ src: '/hero.png', buildSafe: true })
    expect(url('public/img/nested/hero.png')).toEqual({ src: '/img/nested/hero.png', buildSafe: true })
  })

  it('gives a bundled file its dev-server URL, flagged not build-safe', () => {
    expect(assetSiteUrlResolver(tmpDir)('src/assets/EN-2.png')).toEqual({
      src: '/src/assets/EN-2.png',
      buildSafe: false,
    })
  })

  it('does not treat a public/ folder somewhere inside the source tree as the public root', () => {
    // The old `droppedAssetSrc` answered `/x.png` here: whatever followed the
    // LAST `public/`. Nothing serves `src/public/x.png` at `/x.png`.
    expect(assetSiteUrlResolver(tmpDir)('src/public/x.png')).toEqual({ src: '/src/public/x.png', buildSafe: false })
  })

  it('does not treat static/ as a public root', () => {
    expect(assetSiteUrlResolver(tmpDir)('static/hero.png')).toEqual({ src: '/static/hero.png', buildSafe: false })
  })
})

describe('assetSiteUrlResolver — a monorepo app root', () => {
  beforeEach(() => {
    write('web/package.json', JSON.stringify({ name: 'web', devDependencies: { vite: '^5.0.0' } }))
    // Guard the fixture: the rule is only interesting if the probe really
    // found the nested app root.
    expect(resolveAppRoot(tmpDir)).toBe(path.resolve(tmpDir, 'web'))
  })

  it("serves the APP's public/ from the site root", () => {
    expect(assetSiteUrlResolver(tmpDir)('web/public/hero.png')).toEqual({ src: '/hero.png', buildSafe: true })
  })

  it("does not call the PROJECT dir's public/ build-safe — the app never serves it", () => {
    // The deleted client rule (`IMAGE_FILL_UPLOAD_DIR` joined to the project
    // dir) landed fill uploads exactly here and wrote `url('/hero.png')`.
    expect(assetSiteUrlResolver(tmpDir)('public/hero.png')).toBeNull()
  })

  it('gives a file inside the app its URL relative to the app root, not the project', () => {
    expect(assetSiteUrlResolver(tmpDir)('web/src/assets/a.png')).toEqual({ src: '/src/assets/a.png', buildSafe: false })
  })

  it('answers null for a file outside the app root', () => {
    expect(assetSiteUrlResolver(tmpDir)('docs/diagram.png')).toBeNull()
  })
})

/**
 * Security review F1. The URL is pasted VERBATIM into the user's source: an
 * `<img src="…">` string and a CSS `url('…')`. File names come from an
 * imported repo and are untrusted, so every byte that means something in a
 * URL, a JSX string or a CSS string is percent-encoded, and a path that could
 * read as protocol-relative is refused.
 */
describe('assetSiteUrlResolver — a hostile file name cannot escape the URL', () => {
  beforeEach(() => write('package.json', JSON.stringify({ name: 'app' })))

  const src = (relPath: string) => assetSiteUrlResolver(tmpDir)(relPath)?.src ?? null

  it('encodes a quote and parentheses, the CSS url() breakout', () => {
    expect(src("public/a'), url(evil.png), url('.png")).toBe('/a%27%29%2C%20url%28evil.png%29%2C%20url%28%27.png')
  })

  it('encodes a backslash, so a backslash-host URL can never be produced', () => {
    expect(src('public/\\evil.com/x.png')).toBe('/%5Cevil.com/x.png')
  })

  it('encodes #, a space, and the other characters encodeURIComponent leaves alone', () => {
    expect(src('public/q#x.png')).toBe('/q%23x.png')
    expect(src('public/sub dir/b c.png')).toBe('/sub%20dir/b%20c.png')
    expect(src("public/!'()*.png")).toBe('/%21%27%28%29%2A.png')
    expect(src('src/a;b{c}:d".png')).toBe('/src/a%3Bb%7Bc%7D%3Ad%22.png')
  })

  it('refuses a path with an empty segment, so //host can never be produced', () => {
    expect(src('public//evil.com/x.png')).toBeNull()
    expect(src('//evil.com/x.png')).toBeNull()
    expect(src('src//x.png')).toBeNull()
  })

  it('leaves an ordinary name exactly as it was', () => {
    expect(src('public/img/hero-1_a.b~c.png')).toBe('/img/hero-1_a.b~c.png')
  })

  it('never emits anything outside [A-Za-z0-9._~%-] and single / separators', () => {
    for (const hostile of ["public/a'b", 'public/x"y', 'public/<script>', 'public/{x}', 'public/a\nb', 'public/%2e%2e']) {
      const out = src(hostile)
      expect(out).toMatch(/^\/[A-Za-z0-9._~%-]+(\/[A-Za-z0-9._~%-]+)*$/)
    }
  })
})
