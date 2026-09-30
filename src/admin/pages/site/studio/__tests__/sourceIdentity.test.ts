/**
 * P1-A — the board's record of who each source position names
 * (`sourceIdentity.ts`): what is captured, how Studio's own writes keep it
 * current, and how a captured element is re-found after the file moved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Page } from '@core/page-tree'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'
import {
  captureIdentities,
  expectationsFor,
  noteBoardRead,
  recordOwnWrites,
  relocateCapturedIds,
  resetSourceIdentities,
  waitForBoardRead,
} from '../sourceIdentity'

const ROOT = 'a.tsx:2:3'

/** A page whose children sit at the given lines, each fingerprinted by its label. */
function page(children: Record<number, string>, extra: Record<string, unknown> = {}): Page {
  const ids = Object.keys(children).map((line) => `a.tsx:${line}:5`)
  return makePage({
    id: 'p',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', children: ids, sourceFingerprint: 'ul#00000000' }),
      ...Object.fromEntries(
        Object.entries(children).map(([line, fingerprint]) => [
          `a.tsx:${line}:5`,
          makeNode({ id: `a.tsx:${line}:5`, moduleId: 'base.text', sourceFingerprint: fingerprint, ...extra }),
        ]),
      ),
    },
  })
}

beforeEach(() => resetSourceIdentities())
afterEach(() => resetSourceIdentities())

describe('sourceIdentity', () => {
  it('captures what the board read, and sends it as expect', () => {
    noteBoardRead([page({ 3: 'li#00000001', 4: 'li#00000002' })], 'reset')
    const capture = captureIdentities(['a.tsx:4:5', 'index:body'])
    expect(expectationsFor(capture)).toEqual({ 'a.tsx:4:5': 'li#00000002' })
  })

  it('a composite id is keyed by the tail it writes to', () => {
    noteBoardRead([page({ 3: 'li#00000001' })], 'reset')
    expect(expectationsFor(captureIdentities(['pages/Home.tsx:9:9~a.tsx:3:5']))).toEqual({
      'pages/Home.tsx:9:9~a.tsx:3:5': 'li#00000001',
    })
  })

  it("records a literal origin's identity under the origin's own location", () => {
    noteBoardRead(
      [page({ 3: 'h1#00000001' }, { textOrigin: { rel: 'copy.ts', line: 2, col: 10, fingerprint: 'literal#0000abcd' } })],
      'reset',
    )
    expect(expectationsFor(captureIdentities(['copy.ts:2:10']))).toEqual({ 'copy.ts:2:10': 'literal#0000abcd' })
  })

  it("Studio's own value write updates a capture taken BEFORE it, in place", () => {
    noteBoardRead([page({ 3: 'li#00000001' })], 'reset')
    const gesture = captureIdentities(['a.tsx:3:5'])
    recordOwnWrites(undefined, [{ nodeId: 'a.tsx:3:5', fingerprint: 'li#0000ffff' }])
    expect(expectationsFor(gesture)).toEqual({ 'a.tsx:3:5': 'li#0000ffff' })
  })

  it('a re-read replaces records, so an earlier capture keeps describing the element it was taken on', () => {
    noteBoardRead([page({ 3: 'li#0000000a', 4: 'li#0000000b', 5: 'li#0000000c' })], 'reset')
    const gesture = captureIdentities(['a.tsx:5:5'])
    // A move renumbered the file: "c" is now at line 4, and line 5 holds "a".
    noteBoardRead([page({ 3: 'li#0000000b', 4: 'li#0000000c', 5: 'li#0000000a' })], 'merge')
    expect(expectationsFor(gesture)).toEqual({ 'a.tsx:5:5': 'li#0000000c' })
    expect(relocateCapturedIds(gesture, ['a.tsx:5:5'])).toEqual(new Map([['a.tsx:5:5', 'a.tsx:4:5']]))
  })

  it('keeps an id whose position still holds the captured element', () => {
    noteBoardRead([page({ 3: 'li#0000000a' })], 'reset')
    const gesture = captureIdentities(['a.tsx:3:5'])
    noteBoardRead([page({ 3: 'li#0000000a', 4: 'li#0000000b' })], 'merge')
    expect(relocateCapturedIds(gesture, ['a.tsx:3:5'])?.get('a.tsx:3:5')).toBe('a.tsx:3:5')
  })

  it('refuses to guess: gone, or found twice, relocates nothing', () => {
    noteBoardRead([page({ 3: 'li#0000000a', 4: 'li#0000000b' })], 'reset')
    const gesture = captureIdentities(['a.tsx:4:5'])
    noteBoardRead([page({ 3: 'li#0000000a' })], 'merge')
    expect(relocateCapturedIds(gesture, ['a.tsx:4:5'])).toBeNull()

    noteBoardRead([page({ 3: 'li#0000000a', 4: 'li#0000000b' })], 'reset')
    const again = captureIdentities(['a.tsx:4:5'])
    noteBoardRead([page({ 6: 'li#0000000b', 7: 'li#0000000b' })], 'merge')
    expect(relocateCapturedIds(again, ['a.tsx:4:5'])).toBeNull()
  })

  it('a merge drops positions its files no longer have, so they cannot become a second candidate', () => {
    noteBoardRead([page({ 3: 'li#0000000a', 4: 'li#0000000b' })], 'reset')
    const gesture = captureIdentities(['a.tsx:4:5'])
    noteBoardRead([page({ 9: 'li#0000000b' })], 'merge')
    expect(relocateCapturedIds(gesture, ['a.tsx:4:5'])?.get('a.tsx:4:5')).toBe('a.tsx:9:5')
  })

  it('waitForBoardRead resolves on the next read, and times out honestly without one', async () => {
    const read = waitForBoardRead(1000)
    noteBoardRead([page({ 3: 'li#0000000a' })], 'merge')
    expect(await read).toBe(true)
    expect(await waitForBoardRead(5)).toBe(false)
  })
})
