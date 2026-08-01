/**
 * claudeCliSpawn.ts — incremental NDJSON line reader over a fake process.
 * Never spawns the real CLI — every `SpawnedProcessLike` here is synthetic.
 */
import { describe, expect, it } from 'bun:test'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { ClaudeCliSpawnError, spawnClaudeCliNdjson, type ClaudeCliRawEvent } from './claudeCliSpawn'

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]!))
      i += 1
    },
  })
}

interface FakeOpts {
  stdoutChunks: string[]
  stderr?: string
  exitCode?: number
  killable?: { wasKilled: () => boolean }
}

function fakeSpawn(opts: FakeOpts): SubprocessSpawnFn {
  let killed = false
  return () => {
    const proc: SpawnedProcessLike = {
      stdout: streamFromChunks(opts.stdoutChunks),
      stderr: streamFromChunks(opts.stderr ? [opts.stderr] : []),
      exited: Promise.resolve(opts.exitCode ?? 0),
      kill: () => { killed = true },
    }
    if (opts.killable) opts.killable.wasKilled = () => killed
    return proc
  }
}

async function collect(gen: AsyncGenerator<ClaudeCliRawEvent>): Promise<ClaudeCliRawEvent[]> {
  const out: ClaudeCliRawEvent[] = []
  for await (const event of gen) out.push(event)
  return out
}

describe('spawnClaudeCliNdjson', () => {
  it('yields one line event per newline-delimited JSON object, then a terminal exit event', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude', 'auth', 'status', '--json'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      spawn: fakeSpawn({
        stdoutChunks: ['{"type":"system","subtype":"init"}\n{"type":"result","is_error":false}\n'],
        exitCode: 0,
      }),
    }))

    expect(events).toEqual([
      { kind: 'line', value: { type: 'system', subtype: 'init' } },
      { kind: 'line', value: { type: 'result', is_error: false } },
      { kind: 'exit', exitCode: 0, stderr: '', timedOut: false },
    ])
  })

  it('reassembles a line split across multiple stdout chunks', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      spawn: fakeSpawn({
        stdoutChunks: ['{"type":"sys', 'tem","subtype":"in', 'it"}\n'],
        exitCode: 0,
      }),
    }))
    expect(events).toEqual([
      { kind: 'line', value: { type: 'system', subtype: 'init' } },
      { kind: 'exit', exitCode: 0, stderr: '', timedOut: false },
    ])
  })

  it('parses a final line with no trailing newline', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      spawn: fakeSpawn({
        stdoutChunks: ['{"type":"result","is_error":false}'],
        exitCode: 0,
      }),
    }))
    expect(events).toEqual([
      { kind: 'line', value: { type: 'result', is_error: false } },
      { kind: 'exit', exitCode: 0, stderr: '', timedOut: false },
    ])
  })

  it('skips a malformed line without failing the whole stream', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      spawn: fakeSpawn({
        stdoutChunks: ['not json\n{"type":"result","is_error":false}\n'],
        exitCode: 0,
      }),
    }))
    expect(events).toEqual([
      { kind: 'line', value: { type: 'result', is_error: false } },
      { kind: 'exit', exitCode: 0, stderr: '', timedOut: false },
    ])
  })

  it('carries captured stderr on the terminal exit event (the crash-diagnostic case)', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      spawn: fakeSpawn({
        stdoutChunks: [],
        stderr: 'segmentation fault',
        exitCode: 134,
      }),
    }))
    expect(events).toEqual([{ kind: 'exit', exitCode: 134, stderr: 'segmentation fault', timedOut: false }])
  })

  it('kills the process when the signal aborts', async () => {
    const killable = { wasKilled: () => false }
    const controller = new AbortController()
    const spawn = fakeSpawn({ stdoutChunks: [], exitCode: 0, killable })
    controller.abort()
    await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: controller.signal,
      spawn,
    }))
    expect(killable.wasKilled()).toBe(true)
  })

  it('throws ClaudeCliSpawnError when the binary cannot be started', async () => {
    const spawn: SubprocessSpawnFn = () => {
      throw new Error('ENOENT')
    }
    await expect(collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      spawn,
    }))).rejects.toThrow(ClaudeCliSpawnError)
  })
})
