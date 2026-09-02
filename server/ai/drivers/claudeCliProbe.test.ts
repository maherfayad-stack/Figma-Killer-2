/**
 * claudeCliProbe.ts — `claude auth status --json` classification, with a
 * fake spawn (never the real binary, never a real process — per the task
 * constraint that tests must not spawn the real CLI).
 */
import { describe, expect, it } from 'bun:test'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { probeClaudeCliAuth } from './claudeCliProbe'

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function fakeSpawn(opts: { stdout?: string; stderr?: string; exitCode?: number; throwOnSpawn?: Error }): SubprocessSpawnFn {
  return () => {
    if (opts.throwOnSpawn) throw opts.throwOnSpawn
    const proc: SpawnedProcessLike = {
      stdout: streamFromString(opts.stdout ?? ''),
      stderr: streamFromString(opts.stderr ?? ''),
      exited: Promise.resolve(opts.exitCode ?? 0),
      kill: () => {},
    }
    return proc
  }
}

describe('probeClaudeCliAuth', () => {
  it('classifies exit 0 + loggedIn:true as logged-in', async () => {
    const result = await probeClaudeCliAuth({
      configDir: '/data/claude-cli/u1',
      spawn: fakeSpawn({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }),
        exitCode: 0,
      }),
    })
    expect(result).toEqual({
      status: 'logged-in',
      authStatus: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' },
    })
  })

  it('classifies exit 1 + loggedIn:false as logged-out', async () => {
    const result = await probeClaudeCliAuth({
      configDir: '/data/claude-cli/u1',
      spawn: fakeSpawn({
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
        exitCode: 1,
      }),
    })
    expect(result).toEqual({
      status: 'logged-out',
      authStatus: { loggedIn: false, authMethod: 'none' },
    })
  })

  // WS-11 §4.0 trap #1: `apiKeySource` reads "none" even when fully logged
  // in — a body carrying it must still classify as logged-in from `loggedIn`
  // alone, proving the probe never keys off `apiKeySource`.
  it('ignores apiKeySource entirely — classifies purely from loggedIn', async () => {
    const result = await probeClaudeCliAuth({
      configDir: '/data/claude-cli/u1',
      spawn: fakeSpawn({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', apiKeySource: 'none' }),
        exitCode: 0,
      }),
    })
    expect(result.status).toBe('logged-in')
  })

  it('reports not-installed when the binary cannot be spawned (ENOENT)', async () => {
    const err = new Error('Failed to spawn process "claude": ENOENT No such file or directory')
    const result = await probeClaudeCliAuth({
      configDir: '/data/claude-cli/u1',
      spawn: fakeSpawn({ throwOnSpawn: err }),
    })
    expect(result).toEqual({ status: 'not-installed' })
  })

  it('reports probe-failed with a reason for an unrecognised response body', async () => {
    const result = await probeClaudeCliAuth({
      configDir: '/data/claude-cli/u1',
      spawn: fakeSpawn({ stdout: 'not json at all', stderr: 'weird output', exitCode: 3 }),
    })
    expect(result.status).toBe('probe-failed')
    if (result.status === 'probe-failed') {
      expect(result.reason).toContain('weird output')
    }
  })

  it('never throws for any spawn failure shape', async () => {
    const err = new Error('some unexpected native error')
    await expect(probeClaudeCliAuth({
      configDir: '/data/claude-cli/u1',
      spawn: fakeSpawn({ throwOnSpawn: err }),
    })).resolves.toBeDefined()
  })
})
