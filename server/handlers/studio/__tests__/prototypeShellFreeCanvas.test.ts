/**
 * P5-G (design §8, G-EX-1 and G-EX-3) — the free canvas never reaches the
 * running app or a download.
 *
 * A loose layer is scratch. The live preview and a deploy are the project's own
 * build from `index.html` plus the generated shell, whose board registry is the
 * ONE place Studio writes board data the running app reads. So:
 *
 *  - the generated registry is BYTE-IDENTICAL with and without loose layers on
 *    the board, and never names `.studio`;
 *  - the downloaded zip carries no layer module.
 *
 * Opened for real (the regenerated file on disk, the actual archive), like
 * `prototypeShellBoards.test.ts`: the claim is about the bytes a visitor's
 * browser and a user's download receive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { unzipSync } from 'fflate'
import { ensurePrototypeShell } from '../prototypeShell'
import { buildStudioDownloadResponse } from '../../studioDownload'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-free-canvas-'))
  fs.mkdirSync(path.join(tmpDir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'export default function Home() { return <div /> }\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeBoards(withLayers: boolean): void {
  fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
  const board = {
    id: 'b1',
    name: 'Board 1',
    frames: [{ id: 'f1', pageId: 'home', x: 0, y: 0, width: 393, height: 852 }],
    notes: [],
    docs: [],
    ...(withLayers ? { layers: [{ id: 'cl0123456789', x: 1200, y: 40, z: 1 }] } : {}),
  }
  fs.writeFileSync(path.join(tmpDir, '.studio', 'boards.json'), `${JSON.stringify({ version: 1, boards: [board] }, null, 2)}\n`)
}

function writeLayerModule(): void {
  fs.mkdirSync(path.join(tmpDir, '.studio', 'canvas'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.studio', 'canvas', 'cl0123456789.tsx'),
    'export default function CanvasLayer() {\n  return <img src="/secret-scratch.png" alt="scratch" />\n}\n',
  )
}

const registry = () => fs.readFileSync(path.join(tmpDir, 'prototype', 'registry.generated.jsx'), 'utf8')

describe('the free canvas never reaches the running app (G-EX-1)', () => {
  it('generates a byte-identical registry with and without loose layers, and imports nothing from .studio', () => {
    writeBoards(false)
    ensurePrototypeShell(tmpDir)
    const without = registry()

    writeBoards(true)
    writeLayerModule()
    ensurePrototypeShell(tmpDir)
    const withLayers = registry()

    expect(withLayers).toBe(without)
    // The banner says where the data came from; no IMPORT may ever reach into it.
    expect(withLayers).not.toMatch(/from ['"][^'"]*.studio/)
    expect(withLayers).not.toContain('cl0123456789')
    expect(withLayers).not.toContain('secret-scratch')
  })
})

describe('the free canvas never leaves in a download (G-EX-3)', () => {
  it('ships no layer module in the zip', async () => {
    writeBoards(true)
    writeLayerModule()
    const response = await buildStudioDownloadResponse(tmpDir)
    const entries = Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))
    expect(entries.some((entry) => entry.includes('.studio'))).toBe(false)
    expect(entries.some((entry) => entry.includes('cl0123456789'))).toBe(false)
  })
})
