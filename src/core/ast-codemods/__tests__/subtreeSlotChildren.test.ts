/**
 * subtreeSlotChildren — E2.2's read-only candidate listing + naming
 * suggestions. Covers what counts as a candidate (and what doesn't), the
 * tag-derived default name heuristic, and the "children" vs "N real names"
 * rule `suggestSlotNames` applies depending on the caller's selection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listSlotChildCandidates, suggestSlotNames, SOLE_SLOT_DEFAULT_NAME, type SlotChildCandidate } from '../subtreeSlotChildren'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-children-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

describe('listSlotChildCandidates', () => {
  it('lists every element/self-closing/fragment direct child, in source order, skipping text and expression children', () => {
    const file = write('pages/Home.tsx', [
      'export default function Home() {',
      '  return (',
      '    <section>',
      '      <Header />',
      '      loose text',
      '      {count}',
      '      <>{a}{b}</>',
      '      <div className="body">Body</div>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(fs.readFileSync(file, 'utf8'), 'section')

    const candidates = listSlotChildCandidates({ file, line: loc.line, col: loc.col })
    expect(candidates.map((c) => c.index)).toEqual([0, 1, 2])
    expect(candidates[0]).toMatchObject({ kind: 'element', tagName: 'Header' })
    expect(candidates[1]).toMatchObject({ kind: 'fragment' })
    expect(candidates[1]!.tagName).toBeUndefined()
    expect(candidates[2]).toMatchObject({ kind: 'element', tagName: 'div' })
  })

  it('returns an empty list for a self-closing root (no children at all)', () => {
    const file = write('pages/Home.tsx', ['export default function Home() {', '  return <Card />', '}', ''].join('\n'))
    const loc = locateTag(fs.readFileSync(file, 'utf8'), 'Card')

    expect(listSlotChildCandidates({ file, line: loc.line, col: loc.col })).toEqual([])
  })

  it('throws for a stale/missing location, same trust posture as extractSubtreeToComponent', () => {
    const file = write('pages/Home.tsx', ['export default function Home() {', '  return <section><p>Hi</p></section>', '}', ''].join('\n'))
    expect(() => listSlotChildCandidates({ file, line: 999, col: 1 })).toThrow()
  })
})

describe('listSlotChildCandidates — suggestedName heuristic', () => {
  function candidatesFor(jsxLine: string): SlotChildCandidate[] {
    const file = write('pages/Home.tsx', ['export default function Home() {', '  return (', `    <section>${jsxLine}</section>`, '  )', '}', ''].join('\n'))
    const loc = locateTag(fs.readFileSync(file, 'utf8'), 'section')
    return listSlotChildCandidates({ file, line: loc.line, col: loc.col })
  }

  it('a PascalCase component tag suggests its lowerFirst name', () => {
    expect(candidatesFor('<HeaderBar />')[0]!.suggestedName).toBe('headerBar')
  })

  it('a landmark intrinsic tag suggests itself', () => {
    expect(candidatesFor('<nav>Nav</nav>')[0]!.suggestedName).toBe('nav')
  })

  it('a generic intrinsic tag (div/span/…) falls back to a positional slot name', () => {
    expect(candidatesFor('<div>Body</div>')[0]!.suggestedName).toBe('slot1')
  })

  it('a fragment child falls back to a positional slot name', () => {
    expect(candidatesFor('<><a/><b/></>')[0]!.suggestedName).toBe('slot1')
  })
})

describe('suggestSlotNames', () => {
  const candidates: SlotChildCandidate[] = [
    { index: 0, kind: 'element', tagName: 'Header', preview: '<Header/>', suggestedName: 'header' },
    { index: 1, kind: 'element', tagName: 'div', preview: '<div/>', suggestedName: 'slot2' },
    { index: 2, kind: 'element', tagName: 'Icon', preview: '<Icon/>', suggestedName: 'icon' },
    { index: 3, kind: 'element', tagName: 'Icon', preview: '<Icon/>', suggestedName: 'icon' },
  ]

  it('names a lone selection "children", regardless of that candidate\'s own tag', () => {
    expect(suggestSlotNames(candidates, [1])).toEqual(new Map([[1, SOLE_SLOT_DEFAULT_NAME]]))
    expect(suggestSlotNames(candidates, [0])).toEqual(new Map([[0, 'children']]))
  })

  it('names several selections with real, tag-derived names', () => {
    expect(suggestSlotNames(candidates, [0, 1])).toEqual(
      new Map([
        [0, 'header'],
        [1, 'slot2'],
      ]),
    )
  })

  it('disambiguates two selections that would derive the identical base name', () => {
    expect(suggestSlotNames(candidates, [2, 3])).toEqual(
      new Map([
        [2, 'icon'],
        [3, 'icon2'],
      ]),
    )
  })

  it('an empty selection yields an empty map', () => {
    expect(suggestSlotNames(candidates, [])).toEqual(new Map())
  })
})
