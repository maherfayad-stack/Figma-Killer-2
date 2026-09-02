/**
 * classifyClaudeCliStatus — pure classification tested directly against
 * every `ClaudeCliAvailability` variant, no real binary, no real database,
 * no authenticated request (the HTTP wiring around it is a thin pass-through
 * covered by the driver's own probe tests).
 */
import { describe, expect, it } from 'bun:test'
import { classifyClaudeCliStatus } from './claudeCliStatus'
import type { ClaudeCliAvailability } from '../drivers/claudeCliProbe'
import type { ClaudeCliPlatformSupport } from '../../handlers/studio/claudeCliEnv'

const SUPPORTED: ClaudeCliPlatformSupport = { supported: true }
const UNSUPPORTED: ClaudeCliPlatformSupport = {
  supported: false,
  reason: 'The Claude CLI stores credentials in the macOS Keychain…',
}

describe('classifyClaudeCliStatus', () => {
  it('reports "unsupported" with the platform reason, never silently, before touching the probe result', () => {
    const result = classifyClaudeCliStatus(UNSUPPORTED, { status: 'logged-in', authStatus: { loggedIn: true } }, '/data/x')
    expect(result).toEqual({ availability: 'unsupported', reason: UNSUPPORTED.reason })
  })

  it('reports "probe-failed" defensively when no availability result was supplied', () => {
    const result = classifyClaudeCliStatus(SUPPORTED, null, null)
    expect(result.availability).toBe('probe-failed')
    expect(result.reason).toBeTruthy()
  })

  it('reports "logged-in" and surfaces subscriptionType when present', () => {
    const availability: ClaudeCliAvailability = {
      status: 'logged-in',
      authStatus: { loggedIn: true, subscriptionType: 'max' },
    }
    const result = classifyClaudeCliStatus(SUPPORTED, availability, '/data/user-1')
    expect(result).toEqual({ availability: 'logged-in', subscriptionType: 'max' })
  })

  it('reports "logged-in" without subscriptionType when the CLI omits it', () => {
    const availability: ClaudeCliAvailability = { status: 'logged-in', authStatus: { loggedIn: true } }
    const result = classifyClaudeCliStatus(SUPPORTED, availability, '/data/user-1')
    expect(result).toEqual({ availability: 'logged-in' })
  })

  it('reports "logged-out" with a reason and the exact L1 login one-liner', () => {
    const availability: ClaudeCliAvailability = { status: 'logged-out', authStatus: { loggedIn: false } }
    const result = classifyClaudeCliStatus(SUPPORTED, availability, '/data/claude-cli/user-1')
    expect(result.availability).toBe('logged-out')
    expect(result.reason).toBeTruthy()
    expect(result.loginCommand).toBe('CLAUDE_CONFIG_DIR=/data/claude-cli/user-1 claude auth login')
  })

  it('reports "not-installed" with a reason and no login command (nothing to point it at)', () => {
    const availability: ClaudeCliAvailability = { status: 'not-installed' }
    const result = classifyClaudeCliStatus(SUPPORTED, availability, '/data/claude-cli/user-1')
    expect(result).toEqual({
      availability: 'not-installed',
      reason: 'The `claude` CLI is not installed on this host.',
    })
  })

  it('reports "probe-failed" with the raw reason and still offers the login command as a next step', () => {
    const availability: ClaudeCliAvailability = { status: 'probe-failed', reason: 'Claude CLI probe timed out.' }
    const result = classifyClaudeCliStatus(SUPPORTED, availability, '/data/claude-cli/user-1')
    expect(result.availability).toBe('probe-failed')
    expect(result.reason).toBe('Claude CLI probe timed out.')
    expect(result.loginCommand).toBe('CLAUDE_CONFIG_DIR=/data/claude-cli/user-1 claude auth login')
  })

  it('omits loginCommand when configDir is null (config-dir preparation itself failed)', () => {
    const availability: ClaudeCliAvailability = { status: 'logged-out', authStatus: { loggedIn: false } }
    const result = classifyClaudeCliStatus(SUPPORTED, availability, null)
    expect(result.loginCommand).toBeUndefined()
  })
})
