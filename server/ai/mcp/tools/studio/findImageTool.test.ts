/**
 * studio_find_image — against a local fake stock provider (node:http on
 * loopback: the API and the image host both). No live network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '../../../runtime/types'
import { findImageForAgent, studioFindImageMcpTools, type FindImageDeps } from './findImageTool'
import { IMAGE_CREDITS_FILE, readImageCredits } from './imageCredits'
import type { StockPhotoProvider } from './stockPhotos'

const API_KEY = 'test-key-5f2c9a'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])

let dir: string
let server: http.Server
let port: number
const requests: Array<{ path: string; host: string | undefined; authorization: string | undefined }> = []

function photo(id: number, overrides: Record<string, unknown> = {}) {
  const host = `http://images.stock.test:${port}`
  return {
    id,
    width: 4000,
    height: 3000,
    url: `https://www.pexels.com/photo/${id}/`,
    photographer: `Photographer ${id}`,
    photographer_url: `https://www.pexels.com/@p${id}`,
    alt: `A photo numbered ${id}`,
    src: {
      original: `${host}/photos/${id}/original.jpg`,
      large2x: `${host}/photos/${id}/large2x.jpg`,
      large: `${host}/photos/${id}/large.jpg`,
      medium: `${host}/photos/${id}/medium.jpg`,
    },
    ...overrides,
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-find-image-'))
  requests.length = 0
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    requests.push({ path: url.pathname + url.search, host: req.headers.host, authorization: req.headers.authorization })
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/v1/search') {
      if (req.headers.authorization !== API_KEY) return json(401, { error: 'bad key' })
      const query = url.searchParams.get('query')
      if (query === 'nothing') return json(200, { photos: [] })
      if (query === 'foreign') {
        return json(200, { photos: [photo(90, { src: { original: 'http://evil.test/x.jpg', large2x: `http://evil.test:${port}/photos/90/large2x.jpg`, large: 'http://evil.test/x.jpg', medium: 'http://evil.test/x.jpg' } })] })
      }
      if (query === 'injection') {
        return json(200, { photos: [photo(77, { photographer: 'Eve](https://evil.example) <script>\n# Heading', photographer_url: 'https://evil.example/@eve' })] })
      }
      const perPage = Number(url.searchParams.get('per_page'))
      return json(200, { photos: Array.from({ length: Math.min(perPage, 9) }, (_, i) => photo(i + 1)) })
    }
    const single = /^\/v1\/photos\/(\d+)$/.exec(url.pathname)
    if (single) {
      if (single[1] === '404') return json(404, { error: 'not found' })
      return json(200, photo(Number(single[1])))
    }
    if (url.pathname.startsWith('/photos/')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      // Each photo id gets distinct bytes, so content dedupe does not merge them.
      const id = Number(url.pathname.split('/')[2])
      res.end(Buffer.concat([Buffer.from(JPEG.subarray(0, 20)), Buffer.from([id]), Buffer.from(JPEG.subarray(20))]))
      return
    }
    json(404, {})
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  fs.rmSync(dir, { recursive: true, force: true })
})

function provider(): StockPhotoProvider {
  return {
    id: 'pexels',
    label: 'Pexels',
    apiBase: `http://127.0.0.1:${port}/v1`,
    isProviderImageUrl: (url) => url.protocol === 'http:' && url.hostname === 'images.stock.test',
    licence: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
  }
}

function deps(apiKey: string | null = API_KEY): FindImageDeps {
  return {
    stock: { provider: provider(), apiKey, fetchImpl: Bun.fetch },
    fetch: { allowLoopback: true, resolveHostAddresses: async () => ['127.0.0.1'], fetchImpl: Bun.fetch },
  }
}

function ctx(): ToolContext {
  return { db: {} as never, userId: 'u1', capabilities: [], conversationId: 'c1', snapshot: null, signal: new AbortController().signal }
}

type Landed = { relPath: string; src: string | null; alt: string; credit: string; photoId: number }

describe('studio_find_image — tool shape', () => {
  const tool = studioFindImageMcpTools[0]!
  it('is a headless write, gated on studio.write, with a short description', () => {
    expect(tool.name).toBe('studio_find_image')
    expect(tool.execution).toBe('server')
    expect(tool.requiresWrite).toBe(true)
    expect(tool.sideEffects).toBe('write')
    expect(tool.requiredCapabilities).toEqual(['studio.write'])
    expect(tool.description.length).toBeLessThanOrEqual(900)
  })
})

describe('studio_find_image — no key', () => {
  it('says plainly that stock search is not set up, lands nothing, and is not an error', async () => {
    const result = await findImageForAgent({ dir, query: 'coffee' }, ctx(), deps(null))
    expect(result.ok).toBe(true)
    expect(result.configured).toBe(false)
    expect(result.landed).toEqual([])
    expect(String(result.message)).toContain('PEXELS_API_KEY')
    expect(requests).toEqual([])
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false)
  })
})

describe('studio_find_image — search and land', () => {
  it('lands the best match, credits it, and offers the rest', async () => {
    const result = await findImageForAgent({ dir, query: 'Barista pouring latte', orientation: 'landscape' }, ctx(), deps())
    expect(result.ok).toBe(true)
    const landed = result.landed as Landed[]
    expect(landed).toHaveLength(1)
    expect(landed[0]!.relPath).toBe('src/assets/barista-pouring-latte-pexels-1.jpg')
    expect(landed[0]!.alt).toBe('A photo numbered 1')
    expect(landed[0]!.credit).toBe('Photo by Photographer 1 on Pexels')
    expect(fs.existsSync(path.join(dir, landed[0]!.relPath))).toBe(true)
    expect((result.moreResults as unknown[]).length).toBe(6)
    expect(result.creditsFile).toBe(IMAGE_CREDITS_FILE)

    const credits = fs.readFileSync(path.join(dir, IMAGE_CREDITS_FILE), 'utf8')
    expect(credits).toContain('`src/assets/barista-pouring-latte-pexels-1.jpg` — Photo by [Photographer 1](https://www.pexels.com/@p1) on [Pexels](https://www.pexels.com/photo/1/) · Pexels License (https://www.pexels.com/license/)')
    expect(readImageCredits(dir).get('src/assets/barista-pouring-latte-pexels-1.jpg')).toContain('Photographer 1')

    const search = requests.find((r) => r.path.startsWith('/v1/search'))!
    expect(search.path).toContain('orientation=landscape')
    expect(search.path).toContain('per_page=7')
  })

  it('sends the key to the API and never to the image host, and never returns it', async () => {
    const result = await findImageForAgent({ dir, query: 'coffee' }, ctx(), deps())
    const imageRequests = requests.filter((r) => r.path.startsWith('/photos/'))
    expect(imageRequests.length).toBeGreaterThan(0)
    for (const request of imageRequests) expect(request.authorization).toBeUndefined()
    expect(requests.find((r) => r.path.startsWith('/v1/'))!.authorization).toBe(API_KEY)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('lands several, each credited once, and a repeat lands nothing new', async () => {
    const first = await findImageForAgent({ dir, query: 'coffee', count: 3, size: 'medium' }, ctx(), deps())
    expect((first.landed as Landed[]).map((l) => l.photoId)).toEqual([1, 2, 3])
    expect(requests.filter((r) => r.path.startsWith('/photos/')).every((r) => r.path.endsWith('/large.jpg'))).toBe(true)
    const again = await findImageForAgent({ dir, query: 'coffee', count: 3, size: 'medium' }, ctx(), deps())
    expect((again.landed as Array<{ deduped: boolean }>).every((l) => l.deduped)).toBe(true)
    const credits = fs.readFileSync(path.join(dir, IMAGE_CREDITS_FILE), 'utf8')
    expect(credits.match(/^- `/gm)).toHaveLength(3)
  })

  it('lands a specific photo by photoId', async () => {
    const result = await findImageForAgent({ dir, query: 'hero', photoId: 42 }, ctx(), deps())
    expect((result.landed as Landed[])[0]!.photoId).toBe(42)
    expect(requests.some((r) => r.path === '/v1/photos/42')).toBe(true)
  })

  it('a photoId the provider does not have is a coded refusal', async () => {
    const result = await findImageForAgent({ dir, query: 'hero', photoId: 404 }, ctx(), deps())
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
  })

  it('no match is a plain answer with advice', async () => {
    const result = await findImageForAgent({ dir, query: 'nothing' }, ctx(), deps())
    expect(result.ok).toBe(true)
    expect(result.landed).toEqual([])
    expect(String(result.message)).toContain('fewer, plainer words')
  })

  it('a refused key is stock-key-refused, not retryable, and does not echo the key', async () => {
    const result = await findImageForAgent({ dir, query: 'coffee' }, ctx(), deps('wrong-key'))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('stock-key-refused')
    expect(result.retryable).toBe(false)
    expect(JSON.stringify(result)).not.toContain('wrong-key')
  })
})

describe('studio_find_image — the API response is not trusted to name a host', () => {
  it('does not download an image URL on another host', async () => {
    const result = await findImageForAgent({ dir, query: 'foreign' }, ctx(), deps())
    expect(result.ok).toBe(false)
    expect(result.code).toBe('remote-fetch-failed')
    expect(requests.some((r) => r.path.startsWith('/photos/'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false)
  })

  it('writes a hostile photographer name into the credits as inert text', async () => {
    const result = await findImageForAgent({ dir, query: 'injection' }, ctx(), deps())
    expect(result.ok).toBe(true)
    const credits = fs.readFileSync(path.join(dir, IMAGE_CREDITS_FILE), 'utf8')
    const line = credits.split('\n').find((l) => l.includes('pexels-77'))!
    expect(line).not.toContain('evil.example')
    expect(line).not.toContain('<script>')
    expect(line).not.toContain('](https://evil')
    expect(credits).not.toMatch(/^# Heading/m)
  })
})

describe('studio_find_image — the landing goes through the agent write gate', () => {
  it('refuses a protected target folder and writes nothing', async () => {
    const result = await findImageForAgent({ dir, query: 'coffee', targetDir: 'prototype/img' }, ctx(), deps())
    expect(result.ok).toBe(false)
    expect(result.code).toBe('protected-path')
    expect(fs.existsSync(path.join(dir, 'prototype'))).toBe(false)
    expect(fs.existsSync(path.join(dir, IMAGE_CREDITS_FILE))).toBe(false)
  })

  it('a public/ landing reports the URL the site serves it at', async () => {
    const result = await findImageForAgent({ dir, query: 'coffee', targetDir: 'public/photos' }, ctx(), deps())
    const landed = (result.landed as Landed[])[0]!
    expect(landed.relPath).toBe('public/photos/coffee-pexels-1.jpg')
    expect(landed.src).toBe('/photos/coffee-pexels-1.jpg')
  })
})
