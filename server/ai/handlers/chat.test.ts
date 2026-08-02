/**
 * `armAbortedReleaseGuard` — the defence-in-depth half of the conversation
 * stream lock fix (see `claudeCliSpawn.test.ts` for the driver-level half).
 *
 * `handleAiChat`'s own `finally` normally releases `acquireConversationStream`'s
 * lock once the driver's promise settles. A driver is not obligated to ever
 * settle — a wedged subprocess pipe on one platform, a future driver bug on
 * another — and until it does, the conversation 409s every later message with
 * "already generating a response" until the server restarts. This guard frees
 * the lock on a bounded timer once the turn aborts, independent of whatever
 * the driver's promise is doing.
 *
 * Tested as a pure unit against a real `AbortController` and fake timers —
 * no HTTP handler, no database, no driver — because the guard's entire
 * contract is "given a signal and a release function, do the right thing on
 * a schedule," which doesn't need any of that machinery to prove.
 */
import { describe, expect, it, mock } from 'bun:test'
import { abandonTurn, armAbortedReleaseGuard } from './chat'

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('armAbortedReleaseGuard', () => {
  it('never calls release when the signal never aborts', async () => {
    const release = mock(() => {})
    const controller = new AbortController()
    const dispose = armAbortedReleaseGuard(controller.signal, release, 5)

    await flushMicrotasks()
    dispose()

    expect(release).not.toHaveBeenCalled()
  })

  it('does not force-release if the natural path disposes before the grace period elapses', async () => {
    const release = mock(() => {})
    const controller = new AbortController()
    const dispose = armAbortedReleaseGuard(controller.signal, release, 50)

    controller.abort()
    dispose() // the "natural" finally settled first — clears the pending timer

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(release).not.toHaveBeenCalled()
  })

  it('force-releases once the grace period elapses after an abort the natural path never unwinds from', async () => {
    const release = mock(() => {})
    const controller = new AbortController()
    armAbortedReleaseGuard(controller.signal, release, 20)

    controller.abort()
    // Deliberately never call dispose() — this is the hung-driver case: the
    // handler's own `finally` never runs, so nothing else frees the lock.
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(release).toHaveBeenCalledTimes(1)
  })

  it('arms immediately when the signal is already aborted before the guard is created', async () => {
    const release = mock(() => {})
    const controller = new AbortController()
    controller.abort()

    armAbortedReleaseGuard(controller.signal, release, 15)
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(release).toHaveBeenCalledTimes(1)
  })

  it('dispose() after the timer already fired is a harmless no-op', async () => {
    const release = mock(() => {})
    const controller = new AbortController()
    const dispose = armAbortedReleaseGuard(controller.signal, release, 10)

    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(release).toHaveBeenCalledTimes(1)

    expect(() => dispose()).not.toThrow()
    // Still exactly once — dispose() after expiry must not somehow re-trigger it.
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('is safe to call twice — the guarded release itself is expected to be idempotent, not this function', async () => {
    // Mirrors the real caller: `acquireConversationStream`'s returned releaser
    // is idempotent, so a guard that fires AND a natural path that later also
    // calls `release` must both be harmless. This guard doesn't dedupe calls
    // to `release` itself — it only ever calls it once per its own timer —
    // but proves it never throws or double-schedules across two independent
    // abort listeners on the same signal.
    const release = mock(() => {})
    const controller = new AbortController()
    const disposeA = armAbortedReleaseGuard(controller.signal, release, 10)
    const disposeB = armAbortedReleaseGuard(controller.signal, release, 10)

    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(release).toHaveBeenCalledTimes(2) // once per independent guard — expected, not a bug
    expect(() => { disposeA(); disposeB() }).not.toThrow()
  })
})

/**
 * `abandonTurn` — the ordering guarantee that makes the guard's forced
 * release SOUND rather than merely convenient: a new turn must never be able
 * to acquire the conversation lock before this one has already been marked
 * unable to write (`runChat`'s `abandonedSignal` check, `runner.ts`). If
 * `release` ran first, a new turn could acquire and start writing in the gap
 * before `turnDeath` aborted — exactly the interleaved-writes hazard
 * `acquireConversationStream` exists to prevent.
 */
describe('abandonTurn', () => {
  it('marks the turn dead BEFORE calling release — release must observe turnDeath already aborted', () => {
    const turnDeath = new AbortController()
    let turnDeathWasAbortedWhenReleaseRan: boolean | undefined
    const release = mock(() => {
      turnDeathWasAbortedWhenReleaseRan = turnDeath.signal.aborted
    })

    abandonTurn(turnDeath, release)

    expect(release).toHaveBeenCalledTimes(1)
    expect(turnDeathWasAbortedWhenReleaseRan).toBe(true)
    expect(turnDeath.signal.aborted).toBe(true)
  })

  it('calls release even if turnDeath was already aborted (idempotent AbortController.abort())', () => {
    const turnDeath = new AbortController()
    turnDeath.abort()
    const release = mock(() => {})

    expect(() => abandonTurn(turnDeath, release)).not.toThrow()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
