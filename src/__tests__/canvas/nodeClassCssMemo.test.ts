/**
 * S3 — the per-node class-CSS memo a sandboxed module iframe renders through
 * (`canvasClassCss.ts`).
 *
 * `ModuleSandboxFrame` used to subscribe to the whole `site` and run
 * `collectSiteStyleBackgroundImagePaths` + `generateClassCSS` in its render
 * body, once per sandboxed module instance, on every store change. The memo
 * below is what replaced that. Two properties matter and neither is obvious
 * from reading the call site:
 *
 *  1. Repeated calls with unchanged inputs return the SAME string (and the
 *     same path array) — otherwise the `srcDoc`/postMessage plumbing sees a
 *     "changed" value every render and re-posts it.
 *  2. It is keyed by `classIds`, not a single slot. A page with two sandboxed
 *     modules is the common case, and a single-slot memo would miss on every
 *     alternating call — i.e. it would be slower than no memo at all.
 */
import { describe, expect, it } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { generateNodeClassCSS, nodeClassBackgroundImagePaths } from '@site/canvas/canvasClassCss'

function rule(id: string, styles: Record<string, unknown>): StyleRule {
  return {
    id,
    name: id,
    selector: `.${id}`,
    styles,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as StyleRule
}

const BREAKPOINTS = [{ id: 'desktop', width: 1280 }]

function registry(): Record<string, StyleRule> {
  return {
    alpha: rule('alpha', { color: 'red' }),
    beta: rule('beta', { color: 'blue' }),
    gamma: rule('gamma', { backgroundImage: 'url(/uploads/hero.png)' }),
  }
}

describe('per-node class CSS memo', () => {
  it('returns the identical string for repeated calls with unchanged inputs', () => {
    const rules = registry()
    const first = generateNodeClassCSS(rules, ['alpha'], BREAKPOINTS)
    const second = generateNodeClassCSS(rules, ['alpha'], BREAKPOINTS)

    expect(first).toContain('alpha')
    expect(second).toBe(first)
  })

  it('keeps a cache entry per classIds signature — two modules do not thrash one slot', () => {
    const rules = registry()
    const alpha = generateNodeClassCSS(rules, ['alpha'], BREAKPOINTS)
    const beta = generateNodeClassCSS(rules, ['beta'], BREAKPOINTS)

    expect(alpha).not.toBe(beta)
    // Interleaved reads must both still be hits (identical strings, not
    // merely equal ones — a fresh emission would be a new string instance).
    expect(generateNodeClassCSS(rules, ['alpha'], BREAKPOINTS)).toBe(alpha)
    expect(generateNodeClassCSS(rules, ['beta'], BREAKPOINTS)).toBe(beta)
  })

  it('recomputes when the style registry identity changes', () => {
    const before = generateNodeClassCSS(registry(), ['alpha'], BREAKPOINTS)
    const edited = registry()
    edited.alpha = rule('alpha', { color: 'green' })
    const after = generateNodeClassCSS(edited, ['alpha'], BREAKPOINTS)

    expect(before).toContain('red')
    expect(after).toContain('green')
  })

  it('emits nothing for a node with no classes, without touching the cache', () => {
    const rules = registry()
    expect(generateNodeClassCSS(rules, undefined, BREAKPOINTS)).toBe('')
    expect(generateNodeClassCSS(rules, [], BREAKPOINTS)).toBe('')
  })

  it('scans background-image paths from the node rules only, and memoizes the array', () => {
    const rules = registry()
    const paths = nodeClassBackgroundImagePaths(rules, ['gamma'])

    expect(paths).toContain('/uploads/hero.png')
    expect(nodeClassBackgroundImagePaths(rules, ['gamma'])).toBe(paths)
    // A node that references no background image gets a stable empty array —
    // this feeds a hook dependency, so a fresh `[]` per render would re-run it.
    expect(nodeClassBackgroundImagePaths(rules, ['alpha'])).toHaveLength(0)
    expect(nodeClassBackgroundImagePaths(rules, undefined))
      .toBe(nodeClassBackgroundImagePaths(rules, undefined))
  })
})
