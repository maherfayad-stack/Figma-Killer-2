/**
 * `recordBuiltInSignIn` — "a completed OAuth sign-in IS the consent an approval
 * checkbox was asking for", and the four cases where it must stay silent.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRegisteredMcpServers, recordBuiltInSignIn, addRegisteredMcpServer } from './registeredMcpServers'
import { mergeStudioMeta, readStudioMeta } from '../../handlers/studio/studioMeta'

describe('recordBuiltInSignIn', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'studio-signin-approve-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('approves the shipped built-in once the user has signed in to it', () => {
    expect(listRegisteredMcpServers(dir).find((s) => s.name === 'figma')!.approved).toBe(false)
    recordBuiltInSignIn(dir, 'figma', true)
    expect(listRegisteredMcpServers(dir).find((s) => s.name === 'figma')!.approved).toBe(true)
  })

  it('does nothing when there is no sign-in — this never approves on its own', () => {
    recordBuiltInSignIn(dir, 'figma', false)
    expect(readStudioMeta(dir).approvedRegisteredMcpServers ?? []).toEqual([])
  })

  it('refuses a name that is not a shipped built-in', () => {
    addRegisteredMcpServer(dir, { name: 'acme', definition: { transport: 'http', url: 'https://acme.example/mcp' } })
    recordBuiltInSignIn(dir, 'acme', true)
    expect(readStudioMeta(dir).approvedRegisteredMcpServers ?? []).toEqual([])
  })

  it('never overrides a project that replaced the built-in with its own entry', () => {
    addRegisteredMcpServer(dir, { name: 'figma', definition: { transport: 'http', url: 'https://figma.internal/mcp' } })
    recordBuiltInSignIn(dir, 'figma', true)
    expect(readStudioMeta(dir).approvedRegisteredMcpServers ?? []).toEqual([])
  })

  it('never overrides an explicit opt-out', () => {
    mergeStudioMeta(dir, { disabledBuiltInMcpServers: ['figma'] })
    recordBuiltInSignIn(dir, 'figma', true)
    expect(readStudioMeta(dir).approvedRegisteredMcpServers ?? []).toEqual([])
  })
})
