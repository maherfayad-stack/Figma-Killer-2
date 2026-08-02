/**
 * claudeCliSpawn.ts — incremental NDJSON line reader over a fake process.
 * Never spawns the real CLI — every `SpawnedProcessLike` here is synthetic.
 */
import { describe, expect, it, spyOn } from 'bun:test'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { ClaudeCliSpawnError, spawnClaudeCliNdjson, type ClaudeCliRawEvent } from './claudeCliSpawn'

/**
 * Temporarily overrides `process.platform` for the duration of an async
 * `run`, restoring it only once `run`'s promise settles (not synchronously
 * after starting it — `killDescendants` reads `process.platform` deep inside
 * the async generator's execution, well after this function's own call frame
 * has returned). Never actually changes the platform this process runs on —
 * `process.platform` is just a reported string other code branches on.
 */
async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

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

describe('spawnClaudeCliNdjson — no orphaned child processes', () => {
  /**
   * The regression this pins: the generator's `finally` used to clear the
   * timeout and remove the abort listener WITHOUT killing the child. A consumer
   * that stopped early therefore left a live `claude` process with nothing in
   * the world able to stop it — nine orphans from one turn were observed, one
   * of which held the server's inherited listening socket and made every
   * restart fail with EADDRINUSE.
   */
  it('kills the child when the consumer breaks out of the loop early', async () => {
    const killable = { wasKilled: () => false }
    const gen = spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      stdin: new TextEncoder().encode('hi'),
      signal: new AbortController().signal,
      spawn: fakeSpawn({
        stdoutChunks: ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'],
        exitCode: 0,
        killable,
      }),
    })

    for await (const event of gen) {
      // Stop on the first line, leaving stdout undrained — the abandonment
      // case. `break` runs the generator's `finally`.
      if (event.kind === 'line') break
    }

    expect(killable.wasKilled()).toBe(true)
  })

  it('kills the child when the consumer throws mid-stream', async () => {
    const killable = { wasKilled: () => false }
    const gen = spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      stdin: new TextEncoder().encode('hi'),
      signal: new AbortController().signal,
      spawn: fakeSpawn({ stdoutChunks: ['{"a":1}\n', '{"b":2}\n'], exitCode: 0, killable }),
    })

    await expect((async () => {
      for await (const event of gen) {
        if (event.kind === 'line') throw new Error('consumer exploded')
      }
    })()).rejects.toThrow('consumer exploded')

    expect(killable.wasKilled()).toBe(true)
  })

  it('does NOT kill on a normal, fully-drained run — that would be a spurious kill of an exited process', async () => {
    const killable = { wasKilled: () => false }
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      stdin: new TextEncoder().encode('hi'),
      signal: new AbortController().signal,
      spawn: fakeSpawn({ stdoutChunks: ['{"a":1}\n'], exitCode: 0, killable }),
    }))

    expect(events.at(-1)).toMatchObject({ kind: 'exit', exitCode: 0 })
    expect(killable.wasKilled()).toBe(false)
  })
})

/**
 * A fake process whose stdout arrives on a schedule, and whose `kill()` closes
 * stdout the way a dead child's pipe closes. Without that, killing the fake
 * would leave the reader awaiting a chunk that can never come, and a timeout
 * test would hang instead of failing.
 *
 * `chunks` is a list of `[delayBeforeThisChunkMs, text]`.
 */
function pacedSpawn(opts: {
  chunks: Array<[number, string]>
  killable?: { wasKilled: () => boolean }
}): SubprocessSpawnFn {
  let killed = false
  let closeStdout: () => void = () => {}
  return () => {
    const encoder = new TextEncoder()
    let i = 0
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStdout = () => {
          try {
            controller.close()
          } catch {
            // already closed by the pull that ran out of chunks
          }
        }
      },
      async pull(controller) {
        if (killed || i >= opts.chunks.length) {
          closeStdout()
          return
        }
        const [delay, text] = opts.chunks[i]!
        i += 1
        await Bun.sleep(delay)
        // The kill may have landed while we were sleeping — `closeStdout` has
        // already run, so enqueueing here would throw on a closed controller.
        if (killed) return
        controller.enqueue(encoder.encode(text))
      },
    })
    const proc: SpawnedProcessLike = {
      stdout,
      stderr: streamFromChunks([]),
      exited: Promise.resolve(0),
      kill: () => {
        killed = true
        closeStdout()
      },
    }
    if (opts.killable) opts.killable.wasKilled = () => killed
    return proc
  }
}

describe('spawnClaudeCliNdjson — the timeout is an idle window, not a total cap', () => {
  /**
   * The regression this pins. The backstop timer used to be armed ONCE for the
   * whole run, so a turn that ran longer than the window was killed even while
   * it was actively streaming — the user saw "Claude CLI timed out before
   * producing a reply" on a turn that was visibly producing a reply (observed
   * on an agent mid-way through a series of `Bash` calls). A process emitting
   * output is by definition not the wedged process this backstop exists for.
   */
  it('does not kill a slow turn that keeps streaming, even past the window', async () => {
    const killable = { wasKilled: () => false }
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      stdin: new TextEncoder().encode('hi'),
      signal: new AbortController().signal,
      // 8 × 20ms = 160ms of streaming under a 60ms window. No single gap
      // reaches the window, so nothing here is idle.
      idleTimeoutMs: 60,
      spawn: pacedSpawn({
        chunks: Array.from({ length: 8 }, (_, i) => [20, `{"n":${i}}\n`] as [number, string]),
        killable,
      }),
    }))

    expect(events.filter((e) => e.kind === 'line')).toHaveLength(8)
    expect(events.at(-1)).toMatchObject({ kind: 'exit', timedOut: false })
    expect(killable.wasKilled()).toBe(false)
  })

  it('kills a genuinely silent process once one gap exceeds the window', async () => {
    const killable = { wasKilled: () => false }
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      stdin: new TextEncoder().encode('hi'),
      signal: new AbortController().signal,
      idleTimeoutMs: 50,
      spawn: pacedSpawn({
        // One line, then silence well past the window — the wedge case.
        chunks: [[5, '{"a":1}\n'], [400, '{"b":2}\n']],
        killable,
      }),
    }))

    expect(events.filter((e) => e.kind === 'line')).toEqual([{ kind: 'line', value: { a: 1 } }])
    expect(events.at(-1)).toMatchObject({ kind: 'exit', timedOut: true })
    expect(killable.wasKilled()).toBe(true)
  })

  it('does not count time the CONSUMER spends between yields', async () => {
    const killable = { wasKilled: () => false }
    const gen = spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      stdin: new TextEncoder().encode('hi'),
      signal: new AbortController().signal,
      idleTimeoutMs: 50,
      spawn: pacedSpawn({
        chunks: [[1, '{"a":1}\n'], [1, '{"b":2}\n'], [1, '{"c":3}\n']],
        killable,
      }),
    })

    const events: ClaudeCliRawEvent[] = []
    for await (const event of gen) {
      events.push(event)
      // A slow reader is not a wedged child. 90ms per line is nearly double
      // the window; the child is healthy and must survive it.
      if (event.kind === 'line') await Bun.sleep(90)
    }

    expect(events.filter((e) => e.kind === 'line')).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({ kind: 'exit', timedOut: false })
    expect(killable.wasKilled()).toBe(false)
  })
})

/** A fake process that reports a `pid`, so `killDescendants` doesn't early-return. Every assertion against `process.kill`/`Bun.spawn` below goes through a mock — this never signals or spawns anything real. */
function fakeSpawnWithPid(pid: number): SubprocessSpawnFn {
  return () => {
    const proc: SpawnedProcessLike = {
      stdout: streamFromChunks([]),
      stderr: streamFromChunks([]),
      exited: Promise.resolve(0),
      pid,
      kill: () => {},
    }
    return proc
  }
}

describe('spawnClaudeCliNdjson — POSIX process-group kill (server-14 follow-up)', () => {
  /**
   * The bug this pins: `proc.kill()` signals only the direct `claude`
   * process. On POSIX its subagent grandchildren survive holding the
   * inherited `stderr` pipe open, `pumpCapped` never sees EOF, and the
   * conversation's stream lock (chat.ts) was never released — a 409 on every
   * later message until the server restarted. `killDescendants` must reach
   * the whole process group, not just the child `proc.kill()` already hit.
   */
  it('signals the whole process group with a NEGATIVE pid on POSIX, not just the direct child', async () => {
    await withPlatform('darwin', async () => {
      const killSpy = spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const controller = new AbortController()
        controller.abort()
        await collect(spawnClaudeCliNdjson({
          argv: ['claude'],
          cwd: '/tmp',
          env: {},
          signal: controller.signal,
          spawn: fakeSpawnWithPid(424_242),
        }))
        // The immediate signal is SIGTERM, not SIGKILL — see the escalation
        // tests below for why (the CLI's own session-transcript flush).
        expect(killSpy).toHaveBeenCalledWith(-424_242, 'SIGTERM')
      } finally {
        killSpy.mockRestore()
      }
    })
  })

  /**
   * The finding this pins: going straight to SIGKILL never gives `claude` a
   * chance to flush its own `--resume` session transcript, which a terminal
   * Ctrl+C's SIGINT would. A transcript truncated mid-write leaves the NEXT
   * turn resuming against a corrupt session — permanently broken, just
   * relocated from the stream lock (the bug this whole file exists to fix)
   * to the CLI's own session file.
   */
  it('escalates SIGTERM → SIGKILL, in that order, only once the group is still alive after the grace period', async () => {
    await withPlatform('darwin', async () => {
      // Every call succeeds (no throw) — including the `signal: 0` liveness
      // probe, simulating a group that ignored SIGTERM and is still there.
      const killSpy = spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const controller = new AbortController()
        controller.abort()
        await collect(spawnClaudeCliNdjson({
          argv: ['claude'],
          cwd: '/tmp',
          env: {},
          signal: controller.signal,
          posixKillGraceMs: 15,
          spawn: fakeSpawnWithPid(424_242),
        }))
        // The escalation timer is intentionally NOT awaited by the generator
        // (it must not become another unbounded wait) — give it a moment to
        // fire before asserting.
        await Bun.sleep(60)

        expect(killSpy.mock.calls).toEqual([
          [-424_242, 'SIGTERM'],
          [-424_242, 0], // the liveness probe
          [-424_242, 'SIGKILL'],
        ])
      } finally {
        killSpy.mockRestore()
      }
    })
  })

  it('does NOT escalate to SIGKILL when the group already exited during the grace period', async () => {
    await withPlatform('darwin', async () => {
      const killSpy = spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        // The liveness probe (`signal: 0`) is the one call that reports the
        // group is gone — SIGTERM succeeded on its own.
        if (signal === 0) throw new Error('ESRCH — no such process')
        return true
      })
      try {
        const controller = new AbortController()
        controller.abort()
        await collect(spawnClaudeCliNdjson({
          argv: ['claude'],
          cwd: '/tmp',
          env: {},
          signal: controller.signal,
          posixKillGraceMs: 15,
          spawn: fakeSpawnWithPid(424_242),
        }))
        await Bun.sleep(60)

        expect(killSpy.mock.calls).toEqual([
          [-424_242, 'SIGTERM'],
          [-424_242, 0],
        ])
        expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false)
      } finally {
        killSpy.mockRestore()
      }
    })
  })

  it('never touches process.kill when pid is undefined — the injected-fake case in tests must never signal anything real', async () => {
    await withPlatform('darwin', async () => {
      const killSpy = spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const controller = new AbortController()
        controller.abort()
        await collect(spawnClaudeCliNdjson({
          argv: ['claude'],
          cwd: '/tmp',
          env: {},
          signal: controller.signal,
          spawn: fakeSpawn({ stdoutChunks: [], exitCode: 0 }),
        }))
        expect(killSpy).not.toHaveBeenCalled()
      } finally {
        killSpy.mockRestore()
      }
    })
  })

  it('still reaps the tree via taskkill /T /F on Windows, and never takes the POSIX branch there', async () => {
    await withPlatform('win32', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in for a SpawnedProcessLike from Bun.spawn's much wider real return type
      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => ({ pid: 1 }) as any)
      const killSpy = spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const controller = new AbortController()
        controller.abort()
        await collect(spawnClaudeCliNdjson({
          argv: ['claude'],
          cwd: '/tmp',
          env: {},
          signal: controller.signal,
          spawn: fakeSpawnWithPid(555),
        }))
        expect(spawnSpy).toHaveBeenCalledWith(
          ['taskkill', '/pid', '555', '/T', '/F'],
          expect.objectContaining({ stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }),
        )
        // The POSIX negative-pid branch must never fire on Windows.
        expect(killSpy).not.toHaveBeenCalled()
      } finally {
        spawnSpy.mockRestore()
        killSpy.mockRestore()
      }
    })
  })
})

/**
 * A fake `stderr` stream that either never closes, or emits some bytes and
 * THEN never closes — simulating a grandchild process still holding the
 * write end of the pipe open after the direct child has already exited.
 * `proc.exited` and `stdout` are configurable per test so both the "only
 * stderr is stuck" and "everything is stuck" shapes are covered.
 */
function stuckDrainSpawn(opts: {
  stdoutChunks?: string[]
  stderrText?: string
  exitCode?: number
  exitedNeverResolves?: boolean
}): SubprocessSpawnFn {
  return () => {
    const encoder = new TextEncoder()
    const proc: SpawnedProcessLike = {
      stdout: streamFromChunks(opts.stdoutChunks ?? []),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          if (opts.stderrText) controller.enqueue(encoder.encode(opts.stderrText))
          // Deliberately never closes — no `controller.close()` call — so
          // `pumpCapped`'s read loop never sees `done: true`.
        },
      }),
      // A promise that intentionally never settles, simulating a process the OS never confirms has exited.
      exited: opts.exitedNeverResolves ? new Promise<number>(() => {}) : Promise.resolve(opts.exitCode ?? 0),
      kill: () => {},
    }
    return proc
  }
}

describe('spawnClaudeCliNdjson — bounded final drain (never hang on a stuck pipe)', () => {
  /**
   * The bug this pins, one level up from the process-group fix: even a
   * CORRECT kill can't guarantee the pipe closes (a process outside the
   * killed group could still hold a duplicated fd). `await Promise.all([
   * stderrPromise, proc.exited])` used to be unbounded — this generator, and
   * the chat handler's `finally` awaiting it, would hang forever. `drainGraceMs`
   * bounds it; the terminal `exit` event must always still arrive.
   */
  it('degrades to a completed turn when stderr never reports EOF, but reports the real exit code the process DID give us', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      drainGraceMs: 30,
      spawn: stuckDrainSpawn({ stdoutChunks: ['{"a":1}\n'], exitCode: 7 }),
    }))
    expect(events).toEqual([
      { kind: 'line', value: { a: 1 } },
      { kind: 'exit', exitCode: 7, stderr: '', timedOut: false },
    ])
  })

  it('preserves partial stderr captured before the grace period expires, even though the pipe never closes', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      drainGraceMs: 30,
      spawn: stuckDrainSpawn({ stderrText: 'segmentation fault', exitCode: 134 }),
    }))
    expect(events).toEqual([{ kind: 'exit', exitCode: 134, stderr: 'segmentation fault', timedOut: false }])
  })

  it('reports exitCode null (never fabricated) when even proc.exited never settles — the generator still terminates', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      drainGraceMs: 30,
      spawn: stuckDrainSpawn({ exitedNeverResolves: true }),
    }))
    expect(events).toEqual([{ kind: 'exit', exitCode: null, stderr: '', timedOut: false }])
  })

  it('does not truncate a normal, promptly-draining turn — the grace period never engages when nothing is stuck', async () => {
    const events = await collect(spawnClaudeCliNdjson({
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      drainGraceMs: 30,
      spawn: fakeSpawn({ stdoutChunks: ['{"a":1}\n'], stderr: '', exitCode: 0 }),
    }))
    expect(events).toEqual([
      { kind: 'line', value: { a: 1 } },
      { kind: 'exit', exitCode: 0, stderr: '', timedOut: false },
    ])
  })
})
