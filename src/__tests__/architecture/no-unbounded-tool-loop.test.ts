/**
 * Architecture gate — every driver loop has a ceiling (Z3).
 *
 * The rule: **a file under `server/ai/drivers/` that writes `for (;;)` or
 * `while (true)` must name one of the two turn ceilings** — `MAX_TOOL_ROUNDS`
 * (the shared HTTP tool loop's round cap, `http/toolLoop.ts`) or
 * `TOTAL_TURN_CAP_MS` (the `claude` CLI's total wall-time cap,
 * `claudeCliSpawn.ts`) — or be listed below as a stream drain with the reason
 * it cannot run away.
 *
 * Why a gate and not a code review note: this is the exact defect that came
 * back. The HTTP loop was a bare `for (;;)` whose only exits were "the model
 * stopped", "the transport died", and abort, and the CLI driver had an IDLE
 * timeout that a turn streaming steadily forever re-arms on every chunk. Both
 * are shapes where the loop looks healthy while the user watches one page take
 * twenty minutes. A new driver loop written the same way would reintroduce it
 * silently, because nothing about an infinite loop fails a test.
 *
 * The allowlist is a real category, not an escape hatch: a loop that reads a
 * `ReadableStream` to `done` is bounded by the stream, terminates when the pipe
 * closes, and never re-issues work to a provider or a subprocess. Those are the
 * only entries permitted, each with a stated reason. A NEW entry needs the same
 * — "it is fine" is not a reason.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const DRIVERS_DIR = join(REPO_ROOT, 'server/ai/drivers')

/** The identifiers that count as declaring a ceiling. */
const CEILING_NAMES = ['MAX_TOOL_ROUNDS', 'TOTAL_TURN_CAP_MS']

const UNBOUNDED_LOOP_RE = /for\s*\(\s*;\s*;\s*\)|while\s*\(\s*true\s*\)/

/**
 * Repo-relative paths whose infinite loops are stream drains: each reads a
 * `ReadableStream` until `done` and stops when the pipe closes. Nothing in
 * them asks a provider or a subprocess for more work, so a ceiling would be a
 * bound on someone else's data, not on this loop's own behaviour.
 */
const STREAM_DRAIN_ALLOWLIST: Record<string, string> = {
  'server/ai/drivers/http/sse.ts':
    'Both loops read the provider response body to `done` and split frames out of the buffer. ' +
    'The response is what ends them; the turn-level ceiling belongs to `toolLoop.ts`, which owns re-POSTing.',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (extname(full) === '.ts' || extname(full) === '.tsx') out.push(full)
  }
  return out
}

describe('no unbounded driver loop', () => {
  it('every `for (;;)` / `while (true)` under server/ai/drivers names a ceiling or is an allowlisted stream drain', () => {
    const offenders: string[] = []

    for (const file of walk(DRIVERS_DIR)) {
      const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
      if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue
      const source = readFileSync(file, 'utf8')
      if (!UNBOUNDED_LOOP_RE.test(source)) continue
      if (rel in STREAM_DRAIN_ALLOWLIST) continue
      if (CEILING_NAMES.some((name) => source.includes(name))) continue
      offenders.push(rel)
    }

    expect(offenders).toEqual([])
  })

  it('both ceilings exist where the gate says they do', () => {
    const toolLoop = readFileSync(join(REPO_ROOT, 'server/ai/drivers/http/toolLoop.ts'), 'utf8')
    const spawn = readFileSync(join(REPO_ROOT, 'server/ai/drivers/claudeCliSpawn.ts'), 'utf8')

    // Declared, not merely mentioned — a gate that passes on a comment naming
    // the constant would be satisfied by a file that no longer has one.
    expect(toolLoop).toContain('export const MAX_TOOL_ROUNDS')
    expect(spawn).toContain('export const TOTAL_TURN_CAP_MS')
  })

  it('keeps the allowlist honest — every entry still exists and still has a loop', () => {
    for (const [rel, reason] of Object.entries(STREAM_DRAIN_ALLOWLIST)) {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8')
      expect(UNBOUNDED_LOOP_RE.test(source)).toBe(true)
      expect(reason.length).toBeGreaterThan(40)
    }
  })
})
