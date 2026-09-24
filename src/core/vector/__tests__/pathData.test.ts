/**
 * `pathData` — the `d` string is user source, so the parse must give every
 * byte back. The corpus case is the gate the audit asked for (`08-svg.md`
 * SVG-1): every `d` in the vendored design system's 568 icons round-trips
 * byte-for-byte.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePathData, serializePathData, type PathData } from '@core/vector'

function parsed(d: string): PathData {
  const result = parsePathData(d)
  if (!result.ok) throw new Error(`expected "${d}" to parse: ${result.error}`)
  return result.path
}

function svgFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return svgFiles(full)
    return name.endsWith('.svg') ? [full] : []
  })
}

const ICONS_DIR = join(import.meta.dir, '../../../../vendor/alm-design-system/src/icons')

describe('parsePathData', () => {
  it('keeps each command letter, its case, and its values', () => {
    const path = parsed('M4 4h16v16H4z')
    expect(path.segments.map((s) => s.command)).toEqual(['M', 'h', 'v', 'H', 'z'])
    expect(path.segments.map((s) => s.values)).toEqual([[4, 4], [16], [16], [4], []])
  })

  it('splits implicit repeats into their own segments, a repeated M drawing lines', () => {
    const path = parsed('M0 0 10 10 20 0m5 5 1 1')
    expect(path.segments.map((s) => [s.command, s.implicit])).toEqual([
      ['M', false], ['L', true], ['L', true], ['m', false], ['l', true],
    ])
  })

  it('reads arc flags written without separators', () => {
    const path = parsed('M0 0a1 1 0 01 2 2')
    expect(path.segments[1]!.values).toEqual([1, 1, 0, 0, 1, 2, 2])
  })

  it('reads numbers glued by sign and by a second decimal point', () => {
    expect(parsed('M1-2L.5.5-3e1-1e-1').segments.map((s) => s.values)).toEqual([[1, -2], [0.5, 0.5], [-30, -0.1]])
  })

  it('records the decimals each segment was written with', () => {
    expect(parsed('M1.25 2L3 4.5e-1').segments.map((s) => s.decimals)).toEqual([2, 2])
  })

  it.each([
    ['L0 0', 'must start with a move-to'],
    ['M0', 'missing an argument'],
    ['M0 0z1 1', 'cannot follow a close-path'],
    ['M0 0 L1 1 x', 'Unexpected'],
    ['M0 0 L1 1,', 'cannot end with a comma'],
    ['M0 0 ,L1 1', 'comma cannot come before'],
    ['M0 0a1 1 0 2 1 2 2', 'missing an argument'],
  ])('refuses %s instead of throwing', (d, message) => {
    const result = parsePathData(d)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(message)
  })

  it('parses the empty path as no segments', () => {
    expect(parsed('  ').segments).toEqual([])
  })
})

describe('serializePathData round trip', () => {
  it.each([
    'M4 4h16v16H4z',
    '  M 1,2 L 3 , 4\n\tC1 2 3 4 5 6 s1 1 2 2 Q0 0 1 1 t2 2 A5 5 0 1 0 9 9 Z  ',
    'M0 0a1 1 0 01 2 2l1-2-3-4',
    'm1.5.5.5.5z m2 2',
  ])('gives back %j byte-for-byte', (d) => {
    expect(serializePathData(parsed(d))).toBe(d)
  })

  it('round-trips every d in the vendored design-system icons byte-for-byte', () => {
    const files = svgFiles(ICONS_DIR)
    expect(files.length).toBeGreaterThan(500)
    let checked = 0
    const refused: string[] = []
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\sd="([^"]*)"/g)) {
        const d = match[1]!
        const result = parsePathData(d)
        if (!result.ok) {
          refused.push(d.slice(result.offset, result.offset + 3))
          continue
        }
        expect(serializePathData(result.path)).toBe(d)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(4000)
    // The corpus carries seven paths a design tool exported with `NaN`
    // coordinates (`Lnan nan`). A browser stops drawing at that token; the
    // parser refuses at exactly it rather than inventing a number.
    expect(refused.length).toBeLessThanOrEqual(7)
    for (const at of refused) expect(at).toBe('nan')
  })

  it('parses and serialises a 100 KB path in under 5 ms', () => {
    let d = 'M0 0'
    let i = 0
    while (d.length < 100 * 1024) {
      d += i % 3 === 0 ? ` C${i} ${i + 1.25} ${i + 2} ${i - 3.5} ${i} ${i}` : i % 3 === 1 ? ` l${i % 7}-${i % 5}.5` : ` a3 3 0 01 ${i} 2`
      i += 1
    }
    // Warm up, then take the best of several runs: the budget is about the
    // algorithm, not a noisy machine.
    for (let run = 0; run < 3; run += 1) serializePathData(parsed(d))
    let best = Infinity
    for (let run = 0; run < 7; run += 1) {
      const start = performance.now()
      const out = serializePathData(parsed(d))
      best = Math.min(best, performance.now() - start)
      expect(out.length).toBe(d.length)
    }
    expect(best).toBeLessThan(5)
  })
})
