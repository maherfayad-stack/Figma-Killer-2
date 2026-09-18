/**
 * claudeCliMcpConfigFile — the file that holds a live connector bearer token
 * (and, once a registered MCP server is approved, a third-party PAT) in
 * plaintext for the duration of a turn.
 *
 * `claudeCli.test.ts` already pins the happy path end to end: the config goes
 * to a path rather than to argv, the path is under `os.tmpdir()`, and the
 * file carries exactly one ACE on Windows / 0600 on POSIX at the moment the
 * CLI is spawned. This file pins the REFUSALS, which that test cannot reach
 * because they need the directory restriction to fail.
 *
 * The staging directory is identified through the `icacls` argv rather than
 * by scanning `os.tmpdir()` for the prefix: `claudeCli.test.ts` creates
 * directories with that same prefix, and under a parallel run a listing-based
 * assertion would see them and flake.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupMcpConfigFile, tryWriteMcpConfigFile, writeMcpConfigFile } from './claudeCliMcpConfigFile'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'

const SECRET = { mcpServers: { studio: { headers: { Authorization: 'Bearer sk-live-not-a-real-token' } } } }

const madeDirs: string[] = []
afterEach(() => {
  for (const dir of madeDirs.splice(0)) cleanupMcpConfigFile(dir)
})

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/**
 * A stand-in for `icacls` that reports `exitCode` and records the directory it
 * was asked to restrict — which is the staging directory, so a test can assert
 * on it without guessing at a `mkdtemp` suffix.
 */
function recordingIcacls(exitCode: number): { spawn: SubprocessSpawnFn; dirs: string[] } {
  const dirs: string[] = []
  const spawn: SubprocessSpawnFn = (argv) => {
    dirs.push(argv[1]!)
    const proc: SpawnedProcessLike = {
      stdout: streamOf(''),
      stderr: streamOf(exitCode === 0 ? '' : 'Access is denied.'),
      exited: Promise.resolve(exitCode),
      kill() {
        // the fake process has already finished
      },
    }
    return proc
  }
  return { spawn, dirs }
}

/** Runs `fn` with `console.error` silenced, returning what it logged. */
async function withSilencedErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const original = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    return { result: await fn(), logged }
  } finally {
    console.error = original
  }
}

// The restriction is a subprocess only on Windows; on POSIX `mkdtemp` itself
// creates the directory at 0700 and `chmod` cannot meaningfully fail
// afterwards, so there is no failure to drive and no seam to drive it with.
const windowsOnly = process.platform === 'win32' ? it : it.skip

describe('writeMcpConfigFile', () => {
  it('writes the config and reports the path it wrote', async () => {
    const file = await writeMcpConfigFile(SECRET)
    madeDirs.push(file.dir)
    expect(file.path).toBe(join(file.dir, 'mcp-config.json'))
    expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual(SECRET)
  })

  windowsOnly('refuses to write the secret at all when the directory could not be restricted', async () => {
    const { spawn, dirs } = recordingIcacls(5)

    const { logged } = await withSilencedErrors(async () => {
      await expect(writeMcpConfigFile(SECRET, { spawn })).rejects.toThrow(/could not be restricted/)
    })

    expect(dirs).toHaveLength(1)
    const staged = dirs[0]!
    // Fail closed AND leave nothing behind: the staging directory is gone, so
    // there is no file holding a token in a directory whose access control we
    // just failed to set — and no half-made directory accumulating in %TEMP%.
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(join(staged, 'mcp-config.json'))).toBe(false)
    expect(logged.some((entry) => String(entry[0]).includes('[ai/privateTempDir]'))).toBe(true)
  })

  windowsOnly('leaves no staging directory behind when the write itself fails', async () => {
    // A config that cannot be serialised stands in for any failure between
    // "directory created" and "file written".
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const { spawn, dirs } = recordingIcacls(0)

    await withSilencedErrors(async () => {
      await expect(writeMcpConfigFile(cyclic, { spawn })).rejects.toThrow()
    })

    expect(dirs).toHaveLength(1)
    expect(existsSync(dirs[0]!)).toBe(false)
  })
})

describe('tryWriteMcpConfigFile', () => {
  windowsOnly('degrades the turn to "no MCP tools" rather than failing it', async () => {
    const { spawn, dirs } = recordingIcacls(5)

    const { result, logged } = await withSilencedErrors(async () => await tryWriteMcpConfigFile(SECRET, { spawn }))

    expect(result).toBeNull()
    expect(logged.some((entry) => String(entry[0]).includes('[ai/claudeCli]'))).toBe(true)
    expect(existsSync(dirs[0]!)).toBe(false)
  })
})

describe('cleanupMcpConfigFile', () => {
  it('removes the directory and the secret inside it, and never throws on a missing one', async () => {
    const file = await writeMcpConfigFile(SECRET)
    cleanupMcpConfigFile(file.dir)
    expect(existsSync(file.dir)).toBe(false)
    expect(existsSync(file.path)).toBe(false)
    // Idempotent — the driver's `finally` may run after an abort already tidied up.
    expect(() => {
      cleanupMcpConfigFile(file.dir)
    }).not.toThrow()
  })
})
