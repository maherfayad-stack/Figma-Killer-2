/**
 * claudeCliTerminalLaunch.ts — availability rules + the actual launch, with a
 * fake spawn (never the real `claude` binary, never a real terminal — per
 * the task constraint that tests must not spawn either) and a fake `which`
 * (never depends on whatever happens to be installed on the machine running
 * the suite). `Bun.write` still writes the small login script to a real temp
 * file (never executed here — only the SPAWN that would run it is faked) —
 * cleaned up in `afterAll`.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { launchClaudeCliLoginTerminal, resolveTerminalLaunchSupport } from './claudeCliTerminalLaunch'

const FAKE_CLAUDE_BIN = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\claude.cmd'
const fakeWhich = (bin: string): string | null => (bin === 'claude' ? FAKE_CLAUDE_BIN : null)
const missingWhich = (): string | null => null

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function fakeSpawn(opts: { exitCode?: number; stderr?: string; throwOnSpawn?: Error }): SubprocessSpawnFn {
  return () => {
    if (opts.throwOnSpawn) throw opts.throwOnSpawn
    const proc: SpawnedProcessLike = {
      stdout: streamFromString(''),
      stderr: streamFromString(opts.stderr ?? ''),
      exited: Promise.resolve(opts.exitCode ?? 0),
      kill: () => {},
    }
    return proc
  }
}

/** A spawn that behaves differently per call — models the Linux candidate chain. */
function sequencedSpawn(behaviors: SubprocessSpawnFn[]): { spawn: SubprocessSpawnFn; calls: string[][] } {
  const calls: string[][] = []
  let i = 0
  const spawn: SubprocessSpawnFn = (argv, options) => {
    calls.push(argv)
    const behavior = behaviors[i] ?? behaviors[behaviors.length - 1]!
    i += 1
    return behavior(argv, options)
  }
  return { spawn, calls }
}

function loginScriptNames(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('studio-claude-login-')))
}

/**
 * Runs `fn`, then reads back whichever NEW `studio-claude-login-*` temp file
 * appeared in `tmpdir()` during the call — there's exactly one per launch
 * attempt (a fresh `randomUUID()` name each time), so a before/after diff
 * identifies it unambiguously even with other tests' leftovers present.
 */
async function captureLoginScript<T>(fn: () => Promise<T>): Promise<{ result: T; script: string | null }> {
  const before = loginScriptNames()
  const result = await fn()
  const after = loginScriptNames()
  const created = [...after].filter((name) => !before.has(name))
  if (created.length === 0) return { result, script: null }
  // Newest by mtime, in case more than one appeared (shouldn't, but be exact).
  const newest = created
    .map((name) => ({ name, mtime: statSync(join(tmpdir(), name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]!.name
  const script = readFileSync(join(tmpdir(), newest), 'utf8')
  return { result, script }
}

afterAll(() => {
  // Best-effort — remove any real (but never executed) temp scripts this
  // suite wrote via `Bun.write`.
  for (const name of loginScriptNames()) {
    try {
      unlinkSync(join(tmpdir(), name))
    } catch {
      // already gone — fine
    }
  }
})

describe('resolveTerminalLaunchSupport', () => {
  it('is unavailable for a non-loopback request, regardless of platform', () => {
    const result = resolveTerminalLaunchSupport('win32', false)
    expect(result.available).toBe(false)
    expect(result.reason).toContain('remote')
  })

  it('is available on win32 for a loopback request', () => {
    expect(resolveTerminalLaunchSupport('win32', true)).toEqual({ available: true })
  })

  it('is available on linux for a loopback request', () => {
    expect(resolveTerminalLaunchSupport('linux', true)).toEqual({ available: true })
  })

  it('is unavailable on darwin even for a loopback request (Keychain isolation — same reason claudeCli itself is disabled there)', () => {
    const result = resolveTerminalLaunchSupport('darwin', true)
    expect(result.available).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('is unavailable on an unrecognised platform, with a stated reason', () => {
    const result = resolveTerminalLaunchSupport('aix', true)
    expect(result.available).toBe(false)
    expect(result.reason).toContain('aix')
  })
})

describe('launchClaudeCliLoginTerminal — win32', () => {
  it('reports ok:true when the outer powershell exits 0', async () => {
    const { result } = await captureLoginScript(() =>
      launchClaudeCliLoginTerminal({
        configDir: 'C:\\Users\\tester\\.data\\claude-cli\\u1',
        platform: 'win32',
        which: fakeWhich,
        spawn: fakeSpawn({ exitCode: 0 }),
      }),
    )
    expect(result).toEqual({ ok: true })
  })

  // Regression for the exact bug this shape had to catch: a script that
  // merely runs `claude auth login` and relies on the OUTER process's
  // environment silently does nothing, because PowerShell's `Start-Process`
  // (ShellExecute) hands the child a near-empty environment — verified
  // empirically, not assumed. The fix writes PATH in explicitly and invokes
  // the binary by its resolved absolute path, never by bare name.
  it('never relies on inherited PATH — writes PATH explicitly and calls claude by its resolved absolute path', async () => {
    const { script } = await captureLoginScript(() =>
      launchClaudeCliLoginTerminal({
        configDir: 'C:\\Users\\tester\\.data\\claude-cli\\u1',
        platform: 'win32',
        which: fakeWhich,
        spawn: fakeSpawn({ exitCode: 0 }),
      }),
    )
    expect(script).toBeTruthy()
    expect(script).toContain('set "PATH=')
    expect(script).toContain('set "CLAUDE_CONFIG_DIR=C:\\Users\\tester\\.data\\claude-cli\\u1"')
    expect(script).toContain(`call "${FAKE_CLAUDE_BIN}" auth login`)
    // The specific failure mode this guards against: invoking the bare
    // command name and hoping PATH resolves it.
    expect(script).not.toContain('\r\nclaude auth login')
    expect(script).not.toMatch(/[^"]call claude auth login/)
  })

  it('reports a caller-safe reason and refuses to spawn when claude cannot be resolved on PATH', async () => {
    let spawnCalled = false
    const spawn: SubprocessSpawnFn = () => {
      spawnCalled = true
      return fakeSpawn({ exitCode: 0 })([], { cwd: '', env: {}, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    }
    const result = await launchClaudeCliLoginTerminal({
      configDir: 'C:\\Users\\tester\\.data\\claude-cli\\u1',
      platform: 'win32',
      which: missingWhich,
      spawn,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('claude')
    expect(spawnCalled).toBe(false)
  })

  it('reports a caller-safe reason (never raw stderr) when the outer powershell exits nonzero', async () => {
    const result = await launchClaudeCliLoginTerminal({
      configDir: 'C:\\Users\\tester\\.data\\claude-cli\\u1',
      platform: 'win32',
      which: fakeWhich,
      spawn: fakeSpawn({ exitCode: 1, stderr: 'C:\\some\\internal\\path\\leaked in stderr' }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(result.reason).not.toContain('C:\\some\\internal\\path')
  })

  it('reports a caller-safe reason when the spawn itself throws', async () => {
    const result = await launchClaudeCliLoginTerminal({
      configDir: 'C:\\Users\\tester\\.data\\claude-cli\\u1',
      platform: 'win32',
      which: fakeWhich,
      spawn: fakeSpawn({ throwOnSpawn: new Error('ENOENT: powershell.exe not found at /some/internal/path') }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).not.toContain('/some/internal/path')
  })

  it('refuses (without spawning) a config dir containing a quote', async () => {
    let spawnCalled = false
    const spawn: SubprocessSpawnFn = () => {
      spawnCalled = true
      return fakeSpawn({ exitCode: 0 })([], { cwd: '', env: {}, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    }
    const result = await launchClaudeCliLoginTerminal({
      configDir: 'C:\\Users\\te"ster\\.data\\claude-cli\\u1',
      platform: 'win32',
      which: fakeWhich,
      spawn,
    })
    expect(result.ok).toBe(false)
    expect(spawnCalled).toBe(false)
  })
})

describe('launchClaudeCliLoginTerminal — linux', () => {
  it('tries candidates in order and succeeds on the first one present', async () => {
    const { spawn, calls } = sequencedSpawn([fakeSpawn({ exitCode: 0 })])
    const result = await launchClaudeCliLoginTerminal({
      configDir: '/home/tester/.data/claude-cli/u1',
      platform: 'linux',
      spawn,
    })
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.[0]).toBe('x-terminal-emulator')
  })

  it('falls through to the next candidate when one is missing (ENOENT)', async () => {
    const { spawn, calls } = sequencedSpawn([
      () => {
        throw new Error('Failed to spawn "x-terminal-emulator": ENOENT')
      },
      () => {
        throw new Error('Failed to spawn "gnome-terminal": ENOENT')
      },
      fakeSpawn({ exitCode: 0 }),
    ])
    const result = await launchClaudeCliLoginTerminal({
      configDir: '/home/tester/.data/claude-cli/u1',
      platform: 'linux',
      spawn,
    })
    expect(result).toEqual({ ok: true })
    expect(calls.map((c) => c[0])).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole'])
  })

  it('reports ok:false with a stated reason when every candidate is missing', async () => {
    const alwaysMissing: SubprocessSpawnFn = () => {
      throw new Error('ENOENT')
    }
    const result = await launchClaudeCliLoginTerminal({
      configDir: '/home/tester/.data/claude-cli/u1',
      platform: 'linux',
      spawn: alwaysMissing,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('No terminal emulator')
  })
})

describe('launchClaudeCliLoginTerminal — unsupported platform', () => {
  it('reports ok:false without attempting to spawn anything', async () => {
    let spawnCalled = false
    const spawn: SubprocessSpawnFn = () => {
      spawnCalled = true
      return fakeSpawn({ exitCode: 0 })([], { cwd: '', env: {}, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    }
    const result = await launchClaudeCliLoginTerminal({
      configDir: '/Users/tester/.data/claude-cli/u1',
      platform: 'darwin',
      spawn,
    })
    expect(result.ok).toBe(false)
    expect(spawnCalled).toBe(false)
  })
})
