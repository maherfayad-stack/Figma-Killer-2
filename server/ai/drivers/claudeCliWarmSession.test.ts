/**
 * The warm session's turn loop, over a fake process. Never spawns the real
 * CLI — but the fake answers with the exact line SEQUENCE the spike recorded
 * (`system/init` → `assistant` → `result`, once per turn, on one stdin), so
 * these tests fail if the assumed turn boundary ever stops matching reality.
 */
import { describe, expect, it } from 'bun:test'
import {
  ClaudeCliWarmSession,
  ClaudeCliWarmSessionDeadError,
  type WarmSubprocessSpawnFn,
} from './claudeCliWarmSession'
import type { ClaudeCliRawEvent } from './claudeCliSpawn'

/** A fake `claude` process whose stdout this test drives line by line. */
class FakeCliProcess {
  readonly writes: string[] = []
  killed = false
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>
  private exitResolve!: (code: number) => void
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly pid = undefined
  readonly stdin = {
    write: (chunk: Uint8Array) => {
      if (this.killed) throw new Error('EPIPE')
      this.writes.push(new TextDecoder().decode(chunk))
    },
    flush: () => {},
    end: () => {},
  }

  constructor(private readonly stderrText = '') {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutController = controller
      },
    })
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.stderrText) controller.enqueue(new TextEncoder().encode(this.stderrText))
        controller.close()
      },
    })
    this.exited = new Promise<number>((resolve) => {
      this.exitResolve = resolve
    })
  }

  emit(...lines: unknown[]): void {
    for (const line of lines) {
      this.stdoutController.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`))
    }
  }

  /** The three-line shape a real turn produced in the spike. */
  emitTurn(text: string): void {
    this.emit(
      { type: 'system', subtype: 'init', session_id: 'fake' },
      { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text }] } },
      { type: 'result', subtype: 'success', is_error: false, result: text },
    )
  }

  die(code = 1): void {
    this.killed = true
    try {
      this.stdoutController.close()
    } catch {
      // Already closed.
    }
    this.exitResolve(code)
  }

  kill(): void {
    this.die(143)
  }
}

function fakeWarmSpawn(proc: FakeCliProcess): WarmSubprocessSpawnFn {
  return () => proc as unknown as ReturnType<WarmSubprocessSpawnFn>
}

function startSession(proc: FakeCliProcess): ClaudeCliWarmSession {
  return ClaudeCliWarmSession.start({
    argv: ['claude', '-p'],
    cwd: '/tmp',
    env: {},
    spawn: fakeWarmSpawn(proc),
    idleTimeoutMs: 2_000,
    interruptGraceMs: 500,
  })
}

async function collect(gen: AsyncGenerator<ClaudeCliRawEvent, void, void>): Promise<ClaudeCliRawEvent[]> {
  const out: ClaudeCliRawEvent[] = []
  for await (const event of gen) out.push(event)
  return out
}

describe('runTurn', () => {
  it('writes the verified user envelope and ends the turn on the `result` line', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)
    const turn = collect(session.runTurn('hello', new AbortController().signal))
    // The process only answers once it has been asked.
    await Bun.sleep(10)
    proc.emitTurn('hi there')

    const events = await turn
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.kind === 'line')).toBe(true)
    expect(JSON.parse(proc.writes[0]!)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
    })
    // Alive and reusable — the whole point.
    expect(session.alive).toBe(true)
    expect(session.busy).toBe(false)
    session.dispose()
  })

  it('serves a SECOND turn on the same process, with no respawn', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)

    const first = collect(session.runTurn('one', new AbortController().signal))
    await Bun.sleep(10)
    proc.emitTurn('first')
    await first

    const second = collect(session.runTurn('two', new AbortController().signal))
    await Bun.sleep(10)
    proc.emitTurn('second')
    const events = await second

    expect(events).toHaveLength(3)
    expect(proc.writes).toHaveLength(2)
    expect(session.turnsServed).toBe(2)
    expect(session.alive).toBe(true)
    session.dispose()
  })

  it('does not leak a previous turn’s late line into the next turn', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)

    const first = collect(session.runTurn('one', new AbortController().signal))
    await Bun.sleep(10)
    proc.emitTurn('first')
    await first
    // A stray control_response arriving after the turn closed.
    proc.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'studio-1' } })
    await Bun.sleep(10)

    const second = collect(session.runTurn('two', new AbortController().signal))
    await Bun.sleep(10)
    proc.emitTurn('second')
    const events = await second

    expect(events).toHaveLength(3)
    expect(events.some((e) => e.kind === 'line' && JSON.stringify(e.value).includes('control_response'))).toBe(false)
    session.dispose()
  })
})

describe('abort', () => {
  it('sends an interrupt and ends the turn WITHOUT killing the session', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)
    const controller = new AbortController()

    const turn = collect(session.runTurn('write an essay', controller.signal))
    await Bun.sleep(10)
    proc.emit({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'The bicycle' }] } })
    await Bun.sleep(10)

    controller.abort()
    await Bun.sleep(10)
    // What the real binary answered: a normal result line, error_during_execution.
    proc.emit({ type: 'result', subtype: 'error_during_execution', is_error: true })

    await turn
    expect(proc.writes).toHaveLength(2)
    expect(JSON.parse(proc.writes[1]!)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    // The session survives its own abort — this is the behaviour that makes
    // cancelling cheap instead of costing a whole respawn.
    expect(session.alive).toBe(true)

    const next = collect(session.runTurn('again', new AbortController().signal))
    await Bun.sleep(10)
    proc.emitTurn('recovered')
    expect(await next).toHaveLength(3)
    session.dispose()
  })

  it('kills the session when an interrupt is never acknowledged', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)
    const controller = new AbortController()

    const turn = collect(session.runTurn('essay', controller.signal))
    await Bun.sleep(10)
    proc.emit({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'x' }] } })
    await Bun.sleep(10)
    controller.abort()

    // No `result` ever arrives — the grace period (500ms here) expires.
    const events = await turn
    expect(events.at(-1)).toMatchObject({ kind: 'exit' })
    expect(session.alive).toBe(false)
  })
})

/**
 * Z3. The idle window cannot see a turn that streams steadily forever — that
 * is a healthy process by its own definition — so the total cap is what ends
 * "twenty minutes on one page". It reuses the abort path's own mechanism
 * (`interrupt`, then the terminating `result`) precisely because the spike
 * proved that path leaves the session usable: a capped turn must cost the
 * turn, not the process and its MCP handshakes.
 */
describe('the total turn cap', () => {
  it('interrupts a turn that runs past the cap and KEEPS the session alive', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)

    const turn = collect(session.runTurn('rebuild the page', new AbortController().signal, 80))
    // Stream steadily for well past the cap — never once idle.
    for (let i = 0; i < 12; i += 1) {
      await Bun.sleep(15)
      proc.emit({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: `chunk ${i}` }] } })
    }
    // The CLI answers the interrupt the way the spike recorded it.
    proc.emit({ type: 'result', subtype: 'error_during_execution', is_error: true })

    const events = await turn
    expect(events.at(-1)).toEqual({ kind: 'turnCapped', capMs: 80 })
    // Exactly one interrupt, and it was sent — not a kill.
    const controls = proc.writes.slice(1).map((w) => JSON.parse(w))
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    expect(proc.killed).toBe(false)
    expect(session.alive).toBe(true)

    // And the session genuinely still serves the next turn.
    const next = collect(session.runTurn('carry on', new AbortController().signal))
    await Bun.sleep(10)
    proc.emitTurn('recovered')
    expect(await next).toHaveLength(3)
    session.dispose()
  })

  it('does not forward the lines that arrive after the cap interrupt', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)

    const turn = collect(session.runTurn('go', new AbortController().signal, 60))
    await Bun.sleep(10)
    proc.emit({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'before' }] } })
    await Bun.sleep(90)
    // Post-interrupt output belongs to a turn the user is about to be told
    // ended; forwarding it would print text after the "stopped" message.
    proc.emit({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'after' }] } })
    proc.emit({ type: 'result', subtype: 'error_during_execution', is_error: true })

    const events = await turn
    expect(JSON.stringify(events)).toContain('before')
    expect(JSON.stringify(events)).not.toContain('after')
    expect(events.at(-1)).toEqual({ kind: 'turnCapped', capMs: 60 })
    session.dispose()
  })

  it('disposes the session when the cap interrupt is never acknowledged', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)

    const turn = collect(session.runTurn('go', new AbortController().signal, 60))
    await Bun.sleep(10)
    proc.emit({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'x' }] } })

    // Nothing ever answers the interrupt — the 500ms grace expires. A wedged
    // process is the one case the cap may not leave running.
    const events = await turn
    expect(events.at(-1)).toEqual({ kind: 'turnCapped', capMs: 60 })
    expect(session.alive).toBe(false)
  })

  it('leaves a turn that finishes inside the cap untouched', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)

    const turn = collect(session.runTurn('hello', new AbortController().signal, 5_000))
    await Bun.sleep(10)
    proc.emitTurn('hi there')

    const events = await turn
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.kind === 'line')).toBe(true)
    // One write: the user line. No control request was ever sent.
    expect(proc.writes).toHaveLength(1)
    session.dispose()
  })
})

describe('crash handling', () => {
  it('throws a dead-session error, before yielding anything, when the process is already gone', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)
    proc.die()
    await Bun.sleep(10)

    expect(session.alive).toBe(false)
    await expect(collect(session.runTurn('hi', new AbortController().signal))).rejects.toThrow(
      ClaudeCliWarmSessionDeadError,
    )
  })

  it('throws a dead-session error when the process dies before producing output for this turn', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)
    const turn = collect(session.runTurn('hi', new AbortController().signal))
    await Bun.sleep(10)
    proc.die()

    await expect(turn).rejects.toThrow(ClaudeCliWarmSessionDeadError)
  })

  it('yields a terminal exit event — not a retryable error — once output has already reached the user', async () => {
    const proc = new FakeCliProcess('boom')
    const session = startSession(proc)
    const turn = collect(session.runTurn('hi', new AbortController().signal))
    await Bun.sleep(10)
    proc.emit({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'partial' }] } })
    await Bun.sleep(10)
    proc.die(1)

    const events = await turn
    expect(events[0]).toMatchObject({ kind: 'line' })
    expect(events.at(-1)).toMatchObject({ kind: 'exit', exitCode: 1 })
  })

  it('refuses two concurrent turns on one stdin', async () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)
    const first = collect(session.runTurn('one', new AbortController().signal))
    await Bun.sleep(10)
    expect(session.busy).toBe(true)

    await expect(collect(session.runTurn('two', new AbortController().signal))).rejects.toThrow(
      ClaudeCliWarmSessionDeadError,
    )
    proc.emitTurn('done')
    await first
    session.dispose()
  })
})

describe('dispose', () => {
  it('is idempotent and marks the session unusable', () => {
    const proc = new FakeCliProcess()
    const session = startSession(proc)
    session.dispose()
    session.dispose()
    expect(session.alive).toBe(false)
    expect(proc.killed).toBe(true)
  })
})
