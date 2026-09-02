/**
 * `createRegistryBackgroundImagePathsMemo` (`canvasBackgroundImagePaths.ts`)
 * — proves the site-wide background-path scan `ClassStyleInjector.tsx` uses
 * is keyed on the class registry ALONE, not on a scrub/typing preview tick.
 * See that function's own doc for the full defect: `previewClassStyles`
 * changes on every keystroke in the CSS composer and on every native
 * `pointermove` while scrubbing a value (`ScrubInput.tsx`), and
 * `ClassStyleInjector` mounts once per breakpoint iframe — so before this
 * memo, the O(all style rules) scan ran once per mounted frame on every one
 * of those ticks, for a result that hadn't changed.
 *
 * Mirrors `classStyleInjector.test.ts`'s `createCanvasClassCssMemo` suite —
 * same "injectable counting collector" test seam, same identity-memo shape.
 */
import { describe, expect, it } from 'bun:test'
import { createRegistryBackgroundImagePathsMemo } from '@site/canvas/canvasBackgroundImagePaths'
import { classKindSelector, type StyleRule } from '@core/page-tree'

function makeClass(id: string, backgroundImage: string): StyleRule {
  return {
    id,
    name: id,
    kind: 'class',
    selector: classKindSelector(id),
    order: 0,
    styles: { backgroundImage },
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

function countingMemo() {
  let calls = 0
  const memo = createRegistryBackgroundImagePathsMemo((site) => {
    calls += 1
    const paths = new Set<string>()
    for (const rule of Object.values(site.styleRules)) {
      const match = /url\(["']?(.*?)["']?\)/.exec(String(rule.styles.backgroundImage ?? ''))
      if (match) paths.add(match[1])
    }
    return paths
  })
  return { memo, calls: () => calls }
}

describe('createRegistryBackgroundImagePathsMemo', () => {
  it('scans the registry once, then reuses the cached result for repeated calls with the same identity', () => {
    const { memo, calls } = countingMemo()
    const classes = { hero: makeClass('hero', "url('/uploads/hero.png')") }

    // Simulates a fast-scrub gesture: N pointermove-driven re-renders, all
    // with the SAME `classes` reference (only `previewClassStyles` changed).
    const results = Array.from({ length: 50 }, () => memo(classes))

    expect(calls()).toBe(1)
    for (const result of results) {
      expect(result).toBe(results[0])
    }
    expect(results[0]).toEqual(new Set(['/uploads/hero.png']))
  })

  it('re-scans only when the classes object identity actually changes', () => {
    const { memo, calls } = countingMemo()
    const classesA = { hero: makeClass('hero', "url('/uploads/a.png')") }
    const classesB = { hero: makeClass('hero', "url('/uploads/b.png')") }

    memo(classesA)
    memo(classesA)
    memo(classesA)
    expect(calls()).toBe(1)

    memo(classesB)
    expect(calls()).toBe(2)

    memo(classesA)
    expect(calls()).toBe(3)
  })

  it('multiple frame instances sharing one commit\'s snapshot all hit the cache (frames 2..N reuse frame 1\'s scan)', () => {
    const { memo, calls } = countingMemo()
    const classes = { hero: makeClass('hero', "url('/uploads/hero.png')") }

    // Three breakpoint-frame `ClassStyleInjector`s, same commit.
    memo(classes)
    memo(classes)
    memo(classes)

    expect(calls()).toBe(1)
  })
})
