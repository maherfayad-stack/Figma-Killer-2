/**
 * assetDrop — D2 G15's write route. Two halves are tested here, and only one of
 * them is new code:
 *
 *  - **the product decision** (`resolveDroppedAssetHome`, plus the literal
 *    from `assetSiteUrl.ts`, which has its own test): which directory in THIS
 *    project can back a literal `<img src>`, when Studio may create it, and
 *    what the literal actually is. That decision is the whole reason this
 *    route exists rather than a second caller of `asset-upload`.
 *  - **the landing contract** (IMG-1): the response shape, content dedupe,
 *    idempotent replay, and SVG sanitisation proven ON THIS ROUTE.
 *  - **that the shared security pipeline still applies**. The route delegates
 *    every guard to `landAssetBytes`, so the tests that matter are the ones
 *    proving delegation actually happened: a non-image is refused by CONTENT
 *    (not by its declared type), an oversize body never lands, and the write
 *    directory is server-derived so there is no client string to traverse with.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { landAssetBytes } from '../studio/assetLanding'
import { assetSiteUrlResolver } from '../studio/assetSiteUrl'
import { createStudioRouteTestHarness, type StudioRouteTestHarness } from './helpers/studioRouteHarness'
import {
  resolveDroppedAssetHome,
  tryServeStudioAssetDrop,
  MAX_ASSET_DROP_BYTES,
} from '../studio/assetDrop'

let tmpDir: string
/** The replay store for keyed requests. Never this repo's own `.data/`. */
let replayRoot: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-drop-'))
  replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-drop-replay-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(replayRoot, { recursive: true, force: true })
})

// Minimal-but-real magic-number prefixes — sniffing only inspects the header.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
/** Same length as `PNG_BYTES`, different content. */
const OTHER_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1])
const NOT_AN_IMAGE = new TextEncoder().encode('%PDF-1.7\nnot an image at all\n')

function write(rel: string, contents: string): void {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** A Vite-shaped project — the framework detection this route's directory decision reads. */
function seedViteProject(): void {
  write('package.json', JSON.stringify({ name: 'app', devDependencies: { vite: '^5.0.0' } }))
  write('vite.config.ts', "export default {}\n")
  write('src/App.tsx', 'export default function App() { return <div /> }\n')
}

function dropRequest(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array; type?: string }): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  if (file) form.append('file', new File([file.bytes], file.name, file.type ? { type: file.type } : undefined))
  return new Request('http://localhost/admin/api/studio/asset-drop', { method: 'POST', body: form })
}

/**
 * The sub-router carries no auth of its own: `asset-drop` is a `studio.write`
 * line in `routeCapabilities.ts`, so `gateStudioRequest` has already answered
 * the CSRF and capability questions by the time this function is called
 * (`sec-14`'s gate; `sec-17` shipped an inline pair against a base that had no
 * table, and integration replaced it with the declaration). These tests drive
 * the sub-router directly, which is what the real dispatch does after the
 * gate. The `authorization` block at the bottom drives the GATE instead,
 * through `tryServeStudio`.
 */
const serve = (req: Request) =>
  tryServeStudioAssetDrop(req, new URL(req.url), '/admin/api/studio/asset-drop', { idempotencyRoot: replayRoot })

describe('tryServeStudioAssetDrop — routing', () => {
  it('returns null for a non-matching path', async () => {
    const req = new Request('http://localhost/admin/api/studio/other', { method: 'POST' })
    expect(
      await tryServeStudioAssetDrop(req, new URL(req.url), '/admin/api/studio/other'),
    ).toBeNull()
  })

  it('returns null for a matching path with the wrong method', async () => {
    const req = new Request('http://localhost/admin/api/studio/asset-drop', { method: 'GET' })
    expect(await serve(req)).toBeNull()
  })
})

describe('resolveDroppedAssetHome — the one honest location', () => {
  it('uses an existing public/ folder', () => {
    seedViteProject()
    fs.mkdirSync(path.join(tmpDir, 'public'))
    const home = resolveDroppedAssetHome(tmpDir)
    expect(home.ok).toBe(true)
    if (!home.ok) return
    expect(home.relToProject).toBe('public')
  })

  it('CREATES public/ for a framework whose contract already serves it', () => {
    seedViteProject()
    expect(fs.existsSync(path.join(tmpDir, 'public'))).toBe(false)
    const home = resolveDroppedAssetHome(tmpDir)
    expect(home.ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'public'))).toBe(true)
  })

  it('REFUSES rather than guessing when no framework was detected and there is no public/', () => {
    write('package.json', JSON.stringify({ name: 'mystery' }))
    write('index.js', 'console.log(1)\n')
    const home = resolveDroppedAssetHome(tmpDir)
    expect(home.ok).toBe(false)
    if (home.ok) return
    expect(home.error).toContain('public/')
    expect(fs.existsSync(path.join(tmpDir, 'public'))).toBe(false)
  })
})

describe('tryServeStudioAssetDrop — happy path', () => {
  beforeEach(seedViteProject)

  it('lands the image in public/ and reports the literal src an <img> can use', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'hero.png', bytes: PNG_BYTES }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as Record<string, unknown>
    expect(body).toEqual({
      ok: true,
      mode: 'public',
      relPath: 'public/hero.png',
      src: '/hero.png',
      width: null,
      height: null,
      deduped: false,
    })
    expect(fs.readFileSync(path.join(tmpDir, 'public', 'hero.png'))).toEqual(Buffer.from(PNG_BYTES))
  })

  it('derives the extension from the CONTENT, not the declared name or type', async () => {
    const res = await serve(
      dropRequest({ dir: tmpDir }, { name: 'lying.png', bytes: JPEG_BYTES, type: 'image/png' }),
    )
    const body = (await res!.json()) as { relPath: string; src: string }
    expect(body.relPath).toBe('public/lying.jpg')
    expect(body.src).toBe('/lying.jpg')
  })

  it('never overwrites an existing file of the same name', async () => {
    await serve(dropRequest({ dir: tmpDir }, { name: 'logo.png', bytes: PNG_BYTES }))
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'logo.png', bytes: OTHER_PNG_BYTES }))
    const body = (await res!.json()) as { src: string; deduped: boolean }
    expect(body).toMatchObject({ src: '/logo-2.png', deduped: false })
    expect(fs.readFileSync(path.join(tmpDir, 'public', 'logo.png'))).toEqual(Buffer.from(PNG_BYTES))
  })

  it('reports the intrinsic size read from the header', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0,
      8, 6, 0, 0, 0,
    ])
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'sized.png', bytes: png }))
    expect(await res!.json()).toMatchObject({ width: 640, height: 480 })
  })

  it("lands in the APP root's public/ in a monorepo, and the src is served from the site root", async () => {
    const mono = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-drop-mono-'))
    try {
      fs.mkdirSync(path.join(mono, 'web'), { recursive: true })
      fs.writeFileSync(
        path.join(mono, 'web', 'package.json'),
        JSON.stringify({ name: 'web', devDependencies: { vite: '^5.0.0' } }),
        'utf8',
      )
      // The app's own public/ exists; the PROJECT dir has none. The old client
      // rule (`IMAGE_FILL_UPLOAD_DIR` joined to the project dir) would have
      // created `<project>/public/` here, which nothing serves.
      fs.mkdirSync(path.join(mono, 'web', 'public'))
      const res = await serve(dropRequest({ dir: mono }, { name: 'hero.png', bytes: PNG_BYTES }))
      expect(await res!.json()).toMatchObject({ relPath: 'web/public/hero.png', src: '/hero.png' })
      expect(fs.existsSync(path.join(mono, 'public'))).toBe(false)
    } finally {
      fs.rmSync(mono, { recursive: true, force: true })
    }
  })

  it('strips path separators out of the declared filename', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }, { name: '../../etc/passwd.png', bytes: PNG_BYTES }))
    const body = (await res!.json()) as { relPath: string }
    expect(body.relPath).toBe('public/passwd.png')
    expect(fs.existsSync(path.join(tmpDir, 'public', 'passwd.png'))).toBe(true)
  })
})

describe('tryServeStudioAssetDrop — refusals', () => {
  beforeEach(seedViteProject)

  it('refuses a non-image by its CONTENT, naming what it is not', async () => {
    const res = await serve(
      dropRequest({ dir: tmpDir }, { name: 'report.png', bytes: NOT_AN_IMAGE, type: 'image/png' }),
    )
    expect(res!.status).toBe(400)
    const body = (await res!.json()) as { error: string }
    expect(body.error).toContain('not a recognized image format')
    expect(fs.existsSync(path.join(tmpDir, 'public', 'report.png'))).toBe(false)
  })

  it('refuses a request with no file at all', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }))
    expect(res!.status).toBe(400)
  })

  it('refuses an empty file', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'empty.png', bytes: new Uint8Array(0) }))
    expect(res!.status).toBe(400)
  })

  it('refuses a body past the streamed size cap without writing anything', async () => {
    const oversize = new Uint8Array(MAX_ASSET_DROP_BYTES + 1024)
    oversize.set(PNG_BYTES, 0)
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'huge.png', bytes: oversize }))
    expect(res!.status).toBeGreaterThanOrEqual(400)
    expect(fs.existsSync(path.join(tmpDir, 'public', 'huge.png'))).toBe(false)
  })

  it('refuses with 409 when the project has no public/ and no framework convention', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-drop-bare-'))
    try {
      fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'mystery' }), 'utf8')
      fs.writeFileSync(path.join(bare, 'index.js'), 'console.log(1)\n', 'utf8')
      const res = await serve(dropRequest({ dir: bare }, { name: 'hero.png', bytes: PNG_BYTES }))
      expect(res!.status).toBe(409)
      const body = (await res!.json()) as { error: string }
      expect(body.error).toContain('public/')
      expect(fs.existsSync(path.join(bare, 'public'))).toBe(false)
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })
})

/**
 * `sec-17` — who is allowed to ask at all.
 *
 * This route writes caller-supplied bytes into the user's repository, and
 * before this block it had neither of the two checks the rest of Studio's
 * write surface carries. The exploit is not subtle: a multipart POST is a
 * shape a plain cross-origin `<form>` can send with no JavaScript and no
 * preflight, so any page the user has open in another tab could drop a file
 * of its choosing into whichever project they happen to be editing — and then
 * `<img src="/that-file.svg">` is one gesture away from being written into
 * their source by hand.
 *
 * These drive `tryServeStudio` itself rather than the sub-router, because that
 * is where the checks now live: `routeCapabilities.ts` declares `asset-drop` a
 * write, and `gateStudioRequest` refuses before the body is read. What this
 * block adds over `studioRouteGate.test.ts` — which walks every declared route
 * — is the half a table walk cannot assert: that the refusal left NOTHING on
 * disk.
 */
describe('tryServeStudioAssetDrop — authorization', () => {
  let routes: StudioRouteTestHarness

  beforeAll(async () => {
    routes = await createStudioRouteTestHarness()
  })

  afterAll(async () => {
    await routes.cleanup()
  })

  beforeEach(seedViteProject)

  /** Signed in as the Owner — the capability holds; only CSRF can refuse. */
  const asOwner = (req: Request) => routes.serve(req, new URL(req.url))
  /** No session at all. */
  const anonymous = (req: Request) => routes.serveAnonymous(req, new URL(req.url))

  /**
   * `Origin` is a forbidden header in the `Request` constructor, so it is set
   * afterwards — which is also exactly why the check is worth something: only
   * the browser writes that header and a page cannot forge it.
   */
  it('refuses a forged cross-origin POST before any byte is written', async () => {
    const req = dropRequest({ dir: tmpDir }, { name: 'forged.png', bytes: PNG_BYTES })
    req.headers.set('origin', 'https://evil.test')

    const res = await asOwner(req)
    expect(res!.status).toBe(403)
    expect(fs.existsSync(path.join(tmpDir, 'public', 'forged.png'))).toBe(false)
  })

  it('says nothing about the filesystem when it refuses', async () => {
    const req = dropRequest({ dir: tmpDir }, { name: 'forged.png', bytes: PNG_BYTES })
    req.headers.set('origin', 'https://evil.test')
    const body = (await (await asOwner(req))!.json()) as { error: string }
    expect(body.error).not.toContain(tmpDir)
  })

  it('refuses a same-origin POST with no session, and writes nothing', async () => {
    const req = dropRequest({ dir: tmpDir }, { name: 'anon.png', bytes: PNG_BYTES })

    const res = await anonymous(req)
    expect(res!.status).toBe(401)
    expect(fs.existsSync(path.join(tmpDir, 'public', 'anon.png'))).toBe(false)
  })
})

/**
 * `sec-17` — the filename and the `src` literal, driven with the inputs that
 * would break out of the JSX attribute the drop is about to write.
 *
 * The route's `src` goes straight into `<img src="…">` as a string
 * prop. A name carrying a quote, an angle bracket, a brace or a newline would
 * either terminate the attribute early or open a JSX expression container, so
 * these assert the DERIVED name rather than the declared one — and that the
 * file actually on disk is the one the `src` names.
 */
describe('tryServeStudioAssetDrop — the name that reaches the source', () => {
  beforeEach(seedViteProject)

  /**
   * The exact composition the route performs, minus HTTP. Driven directly
   * rather than through `dropRequest` because a multipart body cannot CARRY
   * some of these names — Bun's serializer percent-escapes a `"` and drops an
   * entry whose filename contains a `:` — and a guard that is only ever fed
   * names the transport already defanged has not been driven at all.
   */
  // `dedupe: false` so every hostile name is really WRITTEN: with the same
  // bytes each time, a deduping landing would hand back the first file and
  // the naming rule under test would never run again.
  const landedSrc = (name: string): string => {
    const landed = landAssetBytes(tmpDir, 'public', PNG_BYTES, name, { dedupe: false })
    if (!landed.ok) throw new Error(`refused: ${landed.error}`)
    const url = assetSiteUrlResolver(tmpDir)(landed.relPath)
    if (url === null) throw new Error(`no URL for ${landed.relPath}`)
    return url.src
  }

  it('cannot produce a src that breaks out of the JSX attribute', () => {
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true })
    for (const hostile of [
      'a"onerror="alert(1).png',
      "it's.png",
      '<script>.png',
      '{process.env.SECRET}.png',
      'line\nbreak.png',
      'sp ace.png',
      'photo.png:evil', // NTFS alternate data stream
      'trailing. .png',
      'nul\u0000byte.png',
      'e\u0301\u00e9.png', // combining acute vs. precomposed — normalisation
      'CON.png', // Windows reserved device name
      'NUL',
    ]) {
      const src = landedSrc(hostile)
      expect({ hostile, src }).toEqual({ hostile, src: expect.stringMatching(/^\/[A-Za-z0-9_-]+\.png$/) })
      // The file the literal names is the file that was actually written.
      expect(fs.existsSync(path.join(tmpDir, 'public', src.slice(1)))).toBe(true)
    }
  })

  it('never emits a traversal or a protocol-relative src', () => {
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true })
    for (const hostile of [
      '../../secret.png',
      '..\\..\\secret.png',
      '//evil.test/x.png',
      '/etc/passwd.png',
      'C:\\Windows\\System32\\x.png',
      '\\\\?\\C:\\evil.png',
    ]) {
      const src = landedSrc(hostile)
      expect(src.startsWith('//')).toBe(false)
      expect(src).not.toContain('..')
      expect(src.split('/')).toHaveLength(2)
    }
  })

  it('sanitises an SVG before it reaches disk, and still serves it from the site root', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil.test")</script><rect width="1" height="1"/></svg>',
    )
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'mark.png', bytes: svg }))
    const body = (await res!.json()) as { src: string }
    // The BYTES decided the extension, not the `.png` the caller declared.
    expect(body.src).toBe('/mark.svg')
    const onDisk = fs.readFileSync(path.join(tmpDir, 'public', 'mark.svg'), 'utf8')
    expect(onDisk).not.toContain('<script')
    expect(onDisk).not.toContain('evil.test')
  })

  it('writes exactly one file when the body carries two', async () => {
    const form = new FormData()
    form.append('dir', tmpDir)
    form.append('file', new File([PNG_BYTES], 'first.png'))
    form.append('file', new File([PNG_BYTES], 'second.png'))
    const req = new Request('http://localhost/admin/api/studio/asset-drop', { method: 'POST', body: form })

    const res = await serve(req)
    expect(res!.status).toBe(200)
    expect(fs.readdirSync(path.join(tmpDir, 'public'))).toEqual(['first.png'])
  })
})

/**
 * IMG-1 — the landing contract a retry depends on. `asset-drop` is in
 * `apiClient.ts`'s `IDEMPOTENT_REPLAY_PATHS`, so a gateway-down response is
 * retried with the SAME `X-Studio-Idempotency-Key`. Two independent guards
 * make that safe: the server replays the recorded answer without running the
 * route, and even with no record (a different key, or an expired one) the
 * landing dedupes by content instead of writing `hero-2.png`.
 */
describe('tryServeStudioAssetDrop — dedupe and replay', () => {
  beforeEach(seedViteProject)

  const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e'

  function keyedDrop(name: string, bytes: Uint8Array): Request {
    const req = dropRequest({ dir: tmpDir }, { name, bytes })
    req.headers.set('x-studio-idempotency-key', KEY)
    return req
  }

  it('a second drop of the same bytes reuses the file and says so', async () => {
    await serve(dropRequest({ dir: tmpDir }, { name: 'hero.png', bytes: PNG_BYTES }))
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'hero.png', bytes: PNG_BYTES }))
    expect(await res!.json()).toMatchObject({ relPath: 'public/hero.png', src: '/hero.png', deduped: true })
    expect(fs.readdirSync(path.join(tmpDir, 'public'))).toEqual(['hero.png'])
  })

  it('a retry carrying the same idempotency key gets the first answer back, verbatim, without landing again', async () => {
    const first = await serve(keyedDrop('hero.png', PNG_BYTES))
    const firstBody = await first!.text()
    // The replay must not depend on the bytes: even a DIFFERENT body under the
    // same key is answered from the record, because the route never runs.
    const replay = await serve(keyedDrop('other.png', OTHER_PNG_BYTES))

    expect(replay!.status).toBe(200)
    expect(await replay!.text()).toBe(firstBody)
    expect(JSON.parse(firstBody)).toMatchObject({ relPath: 'public/hero.png', deduped: false })
    expect(fs.readdirSync(path.join(tmpDir, 'public'))).toEqual(['hero.png'])
  })

  it('a refusal is never recorded, so a corrected retry under the same key still runs', async () => {
    const refused = await serve(keyedDrop('report.png', NOT_AN_IMAGE))
    expect(refused!.status).toBe(400)
    const retried = await serve(keyedDrop('hero.png', PNG_BYTES))
    expect(retried!.status).toBe(200)
    expect(await retried!.json()).toMatchObject({ relPath: 'public/hero.png' })
  })
})

/**
 * Audit 07 §A.5: the SVG sanitiser proven on THIS route, with every vector
 * the drop could carry. `assetLanding.test.ts` covers the shared pipeline;
 * this is the route-level proof that the drop actually goes through it.
 */
describe('tryServeStudioAssetDrop — a hostile SVG is sanitised before it lands', () => {
  beforeEach(seedViteProject)

  it('strips onload, <script>, <foreignObject> and a javascript: xlink:href', async () => {
    const svg = new TextEncoder().encode(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="steal()" viewBox="0 0 10 10">',
        '<script>fetch("//evil.test")</script>',
        '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
        '<a xlink:href="javascript:alert(1)"><rect width="10" height="10"/></a>',
        '</svg>',
      ].join(''),
    )
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'logo.svg', bytes: svg, type: 'image/svg+xml' }))
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { relPath: string; src: string; width: number | null }
    expect(body).toMatchObject({ relPath: 'public/logo.svg', src: '/logo.svg', width: 10 })

    const onDisk = fs.readFileSync(path.join(tmpDir, 'public', 'logo.svg'), 'utf8').toLowerCase()
    expect(onDisk).not.toContain('onload')
    expect(onDisk).not.toContain('<script')
    expect(onDisk).not.toContain('foreignobject')
    expect(onDisk).not.toContain('javascript:')
    expect(onDisk).toContain('<rect')
  })
})
