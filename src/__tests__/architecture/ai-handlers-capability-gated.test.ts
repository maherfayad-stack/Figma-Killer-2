/**
 * Architecture gate — every handler under `server/ai/handlers/**` calls
 * `requireCapability` (or its allowlist-checked siblings) before doing
 * work.
 *
 * This catches accidental bypasses: an unauthenticated POST against
 * `/admin/api/ai/conversations` would let any visitor enumerate or
 * create chat history. Capability gating is the single chokepoint.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const HANDLERS_DIR = join(REPO_ROOT, 'server/ai/handlers')

const CAPABILITY_GATE_RE = /\brequireCapability\s*\(|\brequireAnyCapability\s*\(/

describe('ai-handlers-capability-gated gate', () => {
  it('every handler file calls requireCapability at least once', () => {
    if (!existsSync(HANDLERS_DIR)) return

    // A colocated `*.test.ts` (e.g. `claudeCliStatus.test.ts` beside
    // `claudeCliStatus.ts`) is never itself a route handler — it tests one,
    // often a pure function factored OUT of the handler specifically so it
    // doesn't need a real request/response round trip. Scanning it for
    // `requireCapability()` would be a false positive on the gate itself,
    // not a real bypass.
    const handlerFiles = readdirSync(HANDLERS_DIR)
      .filter((f) => extname(f) === '.ts' && f !== 'index.ts' && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'))
      .map((f) => join(HANDLERS_DIR, f))

    expect(handlerFiles.length).toBeGreaterThan(0)

    const violations = handlerFiles.filter((file) => {
      const src = readFileSync(file, 'utf8')
      return !CAPABILITY_GATE_RE.test(src)
    })

    if (violations.length > 0) {
      throw new Error(
        `[ai-handlers-capability-gated] handler files don't call requireCapability():\n` +
        violations.map((v) => `  ${relative(REPO_ROOT, v).replaceAll('\\', '/')}`).join('\n') +
        `\n\nEvery /admin/api/ai/** route must gate access via requireCapability()` +
        ` so unauthenticated callers cannot reach the AI runtime.`,
      )
    }
    expect(violations).toHaveLength(0)
  })
})
