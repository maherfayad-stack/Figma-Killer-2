/**
 * Security review F1 (PR #223), end to end: a file an imported repo planted
 * in `public/` reaches the Fill picker through `project-assets`, and the
 * picker writes `wrapUrlPayload(asset.src)` into the user's stylesheet.
 *
 * Before the fix, `public/a'), url(evil.png), url('.png` became
 * `url('/a'), url(evil.png), url('.png')`: the quote closed the CSS string
 * and the rest was injected as further declarations. The server's URL rule
 * (`assetSiteUrl.ts`) now percent-encodes every segment, so the payload stays
 * one `url()` holding one opaque string.
 *
 * Lives under `src/__tests__` because it crosses the boundary on purpose: the
 * server's listing feeds the admin's CSS writer, and no server file may import
 * admin code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describeProjectImageAssets } from '../../../server/handlers/studio/projectAssets'
import { wrapUrlPayload } from '@site/panels/PropertiesPanel/gradientValue'

const HOSTILE = "a'), url(evil.png), url('.png"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-url-css-'))
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8')
  fs.mkdirSync(path.join(tmpDir, 'public'))
  fs.writeFileSync(path.join(tmpDir, 'public', HOSTILE), 'x')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('a hostile public/ file name through the Fill picker', () => {
  it('stays ONE url() holding one opaque string', () => {
    const asset = describeProjectImageAssets(tmpDir).find((entry) => entry.relPath === `public/${HOSTILE}`)
    expect(asset?.src).toBeTruthy()

    const written = wrapUrlPayload(asset!.src!)

    // One url(), one single-quoted payload, no quote, parenthesis, comma or
    // whitespace inside it: nothing that could end the string or the function.
    expect(written).toMatch(/^url\('[^'"()\s,;{}\\]+'\)$/)
    expect(written).not.toContain('url(evil.png)')
    expect(written).toBe("url('/a%27%29%2C%20url%28evil.png%29%2C%20url%28%27.png')")
  })
})
