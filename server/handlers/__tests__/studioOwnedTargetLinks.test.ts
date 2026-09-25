/**
 * `isStudioOwnedTargetUnlinked` — the store rule inside the writeback's one
 * decoder (`canonicalSourceRel`).
 *
 * The free canvas (P5-G) admits exactly one Studio-owned writeback target,
 * `.studio/canvas/<id>.tsx`. The user-source rule judges a link by where it
 * LANDS, so a cloned repository shipping `.studio/canvas -> ../pages` would
 * have had a scratch layer's edit written into a real page (and
 * `.studio/canvas/<id>.tsx -> ../../src/App.tsx` into the app's root). A
 * Studio-owned target follows the `.studio` store rule instead: no link
 * anywhere on the way. The user's own source keeps its rule — a link that
 * stays inside the project is still followed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isStudioOwnedTargetUnlinked } from '../studioEditRouting'

const LAYER = '.studio/canvas/clabcdefghij.tsx'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-owned-target-'))
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'clabcdefghij.tsx'), 'export default function Page() { return <main /> }\n')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('isStudioOwnedTargetUnlinked', () => {
  it('accepts a layer module reached through plain folders', () => {
    fs.mkdirSync(path.join(dir, '.studio', 'canvas'), { recursive: true })
    fs.writeFileSync(path.join(dir, ...LAYER.split('/')), 'export default function Layer() { return <div /> }\n')
    expect(isStudioOwnedTargetUnlinked(dir, LAYER)).toBe(true)
  })

  it('refuses a .studio/canvas that is a link into the project’s own pages', () => {
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    fs.symlinkSync(path.join(dir, 'pages'), path.join(dir, '.studio', 'canvas'), 'junction')
    expect(isStudioOwnedTargetUnlinked(dir, LAYER)).toBe(false)
  })

  it('refuses a .studio that is a link, even to a folder inside the project', () => {
    fs.mkdirSync(path.join(dir, 'scratch', 'canvas'), { recursive: true })
    fs.symlinkSync(path.join(dir, 'scratch'), path.join(dir, '.studio'), 'junction')
    expect(isStudioOwnedTargetUnlinked(dir, LAYER)).toBe(false)
  })

  it('leaves the user’s own source to the user-source rule: an in-project link is not its business', () => {
    fs.symlinkSync(path.join(dir, 'pages'), path.join(dir, 'mirror'), 'junction')
    expect(isStudioOwnedTargetUnlinked(dir, 'mirror/clabcdefghij.tsx')).toBe(true)
  })
})
