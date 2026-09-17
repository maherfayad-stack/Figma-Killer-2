/**
 * projectWriteLock — the mutex that stops a canvas save from landing between
 * two subprocesses of a git verb (G7).
 *
 * Three things are worth testing here and nothing else is:
 *
 *   1. **Order.** A save and a commit issued in either order resolve one
 *      strictly after the other, FIFO, never interleaved. This is the whole
 *      point: the failure it replaces is a commit whose content changed
 *      between `git add` and `git commit`.
 *   2. **`busy`.** A git verb that waits longer than its bound refuses with a
 *      `busy` code — mapped to a 409 at the route — instead of hanging or
 *      hitting git's own `index.lock`. A save has no bound and keeps waiting.
 *   3. **Reentrancy.** A locked operation calling another locked operation
 *      runs it inline. Without this, `pushCurrentBranch` (which reads status
 *      inside its own lock) would deadlock the server on the first click.
 *
 * The git half is exercised end-to-end against real `git` in `git.test.ts`;
 * this file drives the primitive directly so the ordering assertions are
 * deterministic rather than dependent on how long a subprocess takes.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import {
  GIT_LOCK_WAIT_MS,
  isProjectWriteLocked,
  ProjectWriteLockBusyError,
  withProjectWriteLock,
} from '../studio/projectWriteLock'

const created: string[] = []

function makeProjectDir(): string {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, '__write_lock_test_'))
  created.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

describe('withProjectWriteLock — ordering', () => {
  it('serializes a save and a commit issued at the same moment, in arrival order', async () => {
    const dir = makeProjectDir()
    const trace: string[] = []

    // Stands in for a git verb: several awaits, with the critical section
    // spanning all of them — exactly the window a save must not land inside.
    const commit = withProjectWriteLock(dir, async () => {
      trace.push('commit:add')
      await Bun.sleep(20)
      trace.push('commit:write')
      await Bun.sleep(20)
      trace.push('commit:done')
    })

    // Issued while the commit holds the lock.
    const save = withProjectWriteLock(dir, async () => {
      trace.push('save:start')
      await Bun.sleep(5)
      trace.push('save:done')
    })

    await Promise.all([commit, save])

    expect(trace).toEqual(['commit:add', 'commit:write', 'commit:done', 'save:start', 'save:done'])
  })

  it('serializes in the other order too — the save arrives first and the commit waits for it', async () => {
    const dir = makeProjectDir()
    const trace: string[] = []

    const save = withProjectWriteLock(dir, async () => {
      trace.push('save:start')
      await Bun.sleep(20)
      trace.push('save:done')
    })
    const commit = withProjectWriteLock(
      dir,
      async () => {
        trace.push('commit:add')
        await Bun.sleep(5)
        trace.push('commit:done')
      },
      { waitMs: GIT_LOCK_WAIT_MS },
    )

    await Promise.all([save, commit])

    expect(trace).toEqual(['save:start', 'save:done', 'commit:add', 'commit:done'])
  })

  it('hands the lock to waiters FIFO — a later arrival never jumps the queue', async () => {
    const dir = makeProjectDir()
    const order: number[] = []

    const first = withProjectWriteLock(dir, () => Bun.sleep(25))
    const queued = [1, 2, 3].map((n) =>
      withProjectWriteLock(dir, async () => {
        order.push(n)
        await Bun.sleep(1)
      }),
    )

    await Promise.all([first, ...queued])
    expect(order).toEqual([1, 2, 3])
  })

  it('releases the lock when the critical section throws', async () => {
    const dir = makeProjectDir()
    await expect(
      withProjectWriteLock(dir, () => {
        throw new Error('codemod blew up')
      }),
    ).rejects.toThrow('codemod blew up')

    expect(isProjectWriteLocked(dir)).toBe(false)
    // And the next writer gets in immediately.
    await expect(withProjectWriteLock(dir, () => 'ok')).resolves.toBe('ok')
  })

  it('locks per project — a write to one project never blocks another', async () => {
    const a = makeProjectDir()
    const b = makeProjectDir()
    const trace: string[] = []

    const held = withProjectWriteLock(a, async () => {
      trace.push('a:start')
      await Bun.sleep(30)
      trace.push('a:done')
    })
    const other = withProjectWriteLock(b, async () => {
      trace.push('b:start')
      await Bun.sleep(1)
      trace.push('b:done')
    })

    await Promise.all([held, other])
    // b ran to completion while a was still holding its own lock.
    expect(trace).toEqual(['a:start', 'b:start', 'b:done', 'a:done'])
  })

  it('treats a symlinked path as the SAME project — the key is the real path', async () => {
    const real = makeProjectDir()
    const link = path.join(projectsRootDir(), `__write_lock_link_${Date.now()}`)
    try {
      fs.symlinkSync(real, link, 'junction')
    } catch {
      // Creating a symlink needs a privilege this machine may not grant. The
      // rule is asserted on the machines that can; skipping is better than a
      // false green from a weakened assertion.
      return
    }
    created.push(link)

    const trace: string[] = []
    const viaReal = withProjectWriteLock(real, async () => {
      trace.push('real:start')
      await Bun.sleep(20)
      trace.push('real:done')
    })
    const viaLink = withProjectWriteLock(link, async () => {
      trace.push('link:start')
    })

    await Promise.all([viaReal, viaLink])
    expect(trace).toEqual(['real:start', 'real:done', 'link:start'])
  })
})

describe('withProjectWriteLock — busy', () => {
  it('refuses with ProjectWriteLockBusyError once a bounded wait elapses', async () => {
    const dir = makeProjectDir()
    let release = () => {}
    const holder = withProjectWriteLock(dir, () => new Promise<void>((resolve) => (release = resolve)))

    await expect(withProjectWriteLock(dir, () => 'never', { waitMs: 20 })).rejects.toBeInstanceOf(
      ProjectWriteLockBusyError,
    )

    release()
    await holder
  })

  it('names no filesystem path in the busy message — it reaches a browser', async () => {
    const dir = makeProjectDir()
    let release = () => {}
    const holder = withProjectWriteLock(dir, () => new Promise<void>((resolve) => (release = resolve)))

    const err = await withProjectWriteLock(dir, () => 'never', { waitMs: 10 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProjectWriteLockBusyError)
    expect((err as Error).message).not.toContain(dir)
    expect((err as Error).message).not.toContain(projectsRootDir())
    expect((err as ProjectWriteLockBusyError).code).toBe('busy')

    release()
    await holder
  })

  it('keeps an unbounded waiter (a save) in the queue past the point a bounded one gives up', async () => {
    const dir = makeProjectDir()
    let release = () => {}
    const holder = withProjectWriteLock(dir, () => new Promise<void>((resolve) => (release = resolve)))

    let saved = false
    const save = withProjectWriteLock(dir, () => {
      saved = true
    })
    const gitVerb = withProjectWriteLock(dir, () => 'never', { waitMs: 15 }).catch(
      (err: unknown) => (err as Error).name,
    )

    expect(await gitVerb).toBe('ProjectWriteLockBusyError')
    expect(saved).toBe(false)

    release()
    await holder
    await save
    expect(saved).toBe(true)
  })

  it('does not leave a timed-out waiter in the queue to swallow the lock', async () => {
    const dir = makeProjectDir()
    let release = () => {}
    const holder = withProjectWriteLock(dir, () => new Promise<void>((resolve) => (release = resolve)))

    await expect(withProjectWriteLock(dir, () => 'never', { waitMs: 10 })).rejects.toBeInstanceOf(
      ProjectWriteLockBusyError,
    )

    release()
    await holder
    // If the cancelled waiter had kept ownership, this would hang.
    await expect(withProjectWriteLock(dir, () => 'after', { waitMs: 200 })).resolves.toBe('after')
    expect(isProjectWriteLocked(dir)).toBe(false)
  })
})

describe('withProjectWriteLock — reentrancy', () => {
  it('runs a nested acquisition of the same project inline instead of deadlocking', async () => {
    const dir = makeProjectDir()
    const result = await withProjectWriteLock(dir, async () => {
      await Bun.sleep(1)
      // This is `pushCurrentBranch` reading status inside its own lock.
      return withProjectWriteLock(dir, () => 'inner', { waitMs: 10 })
    })
    expect(result).toBe('inner')
    expect(isProjectWriteLocked(dir)).toBe(false)
  })

  it('carries the held key across a subprocess wait — the reentrancy the git verbs actually rely on', async () => {
    const dir = makeProjectDir()
    const result = await withProjectWriteLock(dir, async () => {
      const proc = Bun.spawn(['git', '--version'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      await new Response(proc.stdout).text()
      await proc.exited
      return withProjectWriteLock(dir, () => 'still mine', { waitMs: 10 })
    })
    expect(result).toBe('still mine')
  })

  it('still blocks a DIFFERENT context while a nested acquisition is in flight', async () => {
    const dir = makeProjectDir()
    const trace: string[] = []

    const outer = withProjectWriteLock(dir, async () => {
      trace.push('outer:start')
      await withProjectWriteLock(dir, async () => {
        trace.push('inner')
        await Bun.sleep(20)
      })
      trace.push('outer:done')
    })
    const stranger = withProjectWriteLock(dir, () => {
      trace.push('stranger')
    })

    await Promise.all([outer, stranger])
    expect(trace).toEqual(['outer:start', 'inner', 'outer:done', 'stranger'])
  })
})
