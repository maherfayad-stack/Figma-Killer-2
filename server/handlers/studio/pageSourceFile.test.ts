/**
 * resolvePageSourceFile — exercised against the same committed
 * `studio-workspace/__canonical-fixture/` a real `loadStudioPages` call
 * produces, rather than a hand-built `Page` fixture, so this proves the
 * function against the SHAPE `loadStudioPages` actually returns.
 */
import { describe, expect, it } from 'bun:test'
import * as path from 'node:path'
import { loadStudioPages } from '../studioPageLoad'
import { resolvePageSourceFile } from './pageSourceFile'

const FIXTURE_DIR = path.join(import.meta.dir, '..', '..', '..', 'studio-workspace', '__canonical-fixture')

describe('resolvePageSourceFile', () => {
  it('resolves the real source file for a loaded fixture page', async () => {
    const { pages } = await loadStudioPages(FIXTURE_DIR)
    const canonicalScreen = pages.find((p) => p.title === 'CanonicalScreen')
    expect(canonicalScreen).toBeDefined()

    const file = resolvePageSourceFile(canonicalScreen!)
    expect(file).toBe('src/screens/CanonicalScreen.tsx')
  })

  it('returns null for a page with no decodable node id', () => {
    expect(resolvePageSourceFile({ id: 'empty', title: 'Empty', slug: 'empty', rootNodeId: 'root', nodes: {} } as never)).toBeNull()
  })
})
