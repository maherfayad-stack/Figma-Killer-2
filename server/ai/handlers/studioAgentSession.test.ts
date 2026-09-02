/**
 * `agentSession` persistence (WS-12 §5.1) — exercised directly against
 * `mergeStudioMeta`/`readStudioMeta` (the same primitives the HTTP handler
 * calls), matching this repo's own convention of not building HTTP-level
 * tests for `server/ai/handlers/*` (none of its siblings do either).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeStudioMeta, readStudioMeta } from '../../handlers/studio/studioMeta'

describe('agentSession persistence (WS-12 §5.1)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-agent-session-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips effort through .studio/meta.json', () => {
    expect(readStudioMeta(dir).agentSession?.effort).toBeUndefined()
    mergeStudioMeta(dir, { agentSession: { effort: 'high' } })
    expect(readStudioMeta(dir).agentSession?.effort).toBe('high')
  })

  it('clearing effort (empty agentSession) removes the persisted value', () => {
    mergeStudioMeta(dir, { agentSession: { effort: 'max' } })
    expect(readStudioMeta(dir).agentSession?.effort).toBe('max')
    mergeStudioMeta(dir, { agentSession: {} })
    expect(readStudioMeta(dir).agentSession?.effort).toBeUndefined()
  })

  it('AgentSessionSchema declares no permission-mode field at all — the type system itself refuses one', () => {
    // `mergeStudioMeta` is a generic, unvalidated merge (any caller could
    // technically write extra JSON keys); the REAL guarantee that Bypass
    // never persists is that `studioAgentSession.ts`'s own POST handler
    // never constructs an object with a mode field in the first place — this
    // assertion is a compile-time check of that source, not a runtime one.
    // @ts-expect-error — `mode` is not a key `AgentSessionSchema`/`AgentSession` declares.
    const invalid: import('../../handlers/studio/studioMeta').AgentSession = { effort: 'low', mode: 'bypassPermissions' }
    expect(invalid.effort).toBe('low')
  })

  it('does not disturb other meta fields (trust, previewAxes) when only agentSession changes', () => {
    mergeStudioMeta(dir, { trust: 'render-packages' })
    mergeStudioMeta(dir, { agentSession: { effort: 'medium' } })
    const meta = readStudioMeta(dir)
    expect(meta.trust).toBe('render-packages')
    expect(meta.agentSession?.effort).toBe('medium')
  })
})
