import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readIdempotencyKey, withIdempotentReplay } from './idempotentReplay'

let root: string
const USER = 'user-1'
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-idempotent-replay-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function requestWithKey(key: string, init: RequestInit = {}): Request {
  return new Request('http://localhost/admin/api/studio/page', {
    ...init,
    headers: { ...init.headers, 'x-studio-idempotency-key': key },
  })
}

describe('readIdempotencyKey', () => {
  it('accepts a UUID-shaped header value', () => {
    const key = crypto.randomUUID()
    expect(readIdempotencyKey(requestWithKey(key))).toBe(key.toLowerCase())
  })

  it('rejects a missing header', () => {
    expect(readIdempotencyKey(new Request('http://localhost/x'))).toBeNull()
  })

  it('rejects a malformed value rather than letting it become a filename', () => {
    expect(readIdempotencyKey(requestWithKey('../../etc/passwd'))).toBeNull()
    expect(readIdempotencyKey(requestWithKey('not-a-uuid'))).toBeNull()
  })
})

describe('withIdempotentReplay', () => {
  it('runs the handler directly when the request carries no key', async () => {
    let calls = 0
    const res = await withIdempotentReplay(
      new Request('http://localhost/x'),
      USER,
      async () => {
        calls += 1
        return Response.json({ ok: true })
      },
      root,
    )
    expect(calls).toBe(1)
    expect(await res.json()).toEqual({ ok: true })
  })

  // THE CASE THIS EXISTS FOR: a handler's real effect lands, but the process
  // dies (a `bun --watch` restart mid-flight) before the response reaches the
  // client. The retry carries the SAME key. Without this module, the retry
  // would re-run the handler and double the effect (e.g. a second `duplicate`
  // written into the user's source). With it, the retry never calls the
  // handler at all — it gets the original answer back.
  it('replays the stored response for a key already seen, WITHOUT re-running the handler', async () => {
    const key = crypto.randomUUID()
    let calls = 0
    const run = async () => {
      calls += 1
      return Response.json({ ok: true, effect: calls })
    }

    const first = await withIdempotentReplay(requestWithKey(key), USER, run, root)
    expect(await first.json()).toEqual({ ok: true, effect: 1 })

    const replay = await withIdempotentReplay(requestWithKey(key), USER, run, root)
    expect(await replay.json()).toEqual({ ok: true, effect: 1 })
    // The handler ran exactly once — the second call was answered from the
    // durable record, not from a second execution.
    expect(calls).toBe(1)
  })

  it('does not cache a non-2xx response — a genuine refusal is safe to recompute', async () => {
    const key = crypto.randomUUID()
    let calls = 0
    const run = async () => {
      calls += 1
      return Response.json({ error: 'name taken' }, { status: 409 })
    }

    await withIdempotentReplay(requestWithKey(key), USER, run, root)
    await withIdempotentReplay(requestWithKey(key), USER, run, root)
    expect(calls).toBe(2)
  })

  it('two different keys never collide', async () => {
    const keyA = crypto.randomUUID()
    const keyB = crypto.randomUUID()
    const resA = await withIdempotentReplay(requestWithKey(keyA), USER, async () => Response.json({ who: 'a' }), root)
    const resB = await withIdempotentReplay(requestWithKey(keyB), USER, async () => Response.json({ who: 'b' }), root)
    expect(await resA.json()).toEqual({ who: 'a' })
    expect(await resB.json()).toEqual({ who: 'b' })
  })

  it('the record survives being read by a brand-new process — i.e. is not in-memory', async () => {
    // Simulates exactly the failure this module exists to survive: the
    // server process that ran the handler is gone, and a fresh one (no
    // shared memory, just the same `root` on disk) answers the retry.
    const key = crypto.randomUUID()
    await withIdempotentReplay(requestWithKey(key), USER, async () => Response.json({ ok: true }), root)

    // A "fresh process" has no in-memory state to consult — re-reading via
    // the same on-disk root is the only thing that can make this pass.
    let calls = 0
    const replay = await withIdempotentReplay(
      requestWithKey(key),
      USER,
      async () => {
        calls += 1
        return Response.json({ ok: true })
      },
      root,
    )
    expect(calls).toBe(0)
    expect(await replay.json()).toEqual({ ok: true })
  })

  it('an expired record is not replayed — recomputes instead', async () => {
    const key = crypto.randomUUID()
    let calls = 0
    const run = async () => {
      calls += 1
      return Response.json({ ok: true, effect: calls })
    }

    await withIdempotentReplay(requestWithKey(key), USER, run, root)

    // Backdate the stored record past the TTL by writing an old `storedAtMs`
    // directly, rather than waiting out the real TTL in a test.
    const file = path.join(root, `${key}.json`)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...stored, storedAtMs: 0 }))

    const second = await withIdempotentReplay(requestWithKey(key), USER, run, root)
    expect(calls).toBe(2)
    expect(await second.json()).toEqual({ ok: true, effect: 2 })
  })

  // Security review F4: a record answers only the user, method and path it
  // was recorded for. Anything else is a miss that runs the route, and its
  // answer is not recorded over the original owner's.
  describe('a record is bound to its user, method and path', () => {
    async function recordFor(key: string): Promise<void> {
      await withIdempotentReplay(requestWithKey(key, { method: 'POST' }), USER, async () => Response.json({ who: 'owner' }), root)
    }

    it("another user with the same key gets a fresh run, not the owner's response", async () => {
      const key = crypto.randomUUID()
      await recordFor(key)
      let calls = 0
      const res = await withIdempotentReplay(requestWithKey(key, { method: 'POST' }), 'user-2', async () => {
        calls += 1
        return Response.json({ who: 'intruder' })
      }, root)
      expect(calls).toBe(1)
      expect(await res.json()).toEqual({ who: 'intruder' })

      // The owner's record survived.
      const replay = await withIdempotentReplay(requestWithKey(key, { method: 'POST' }), USER, async () => Response.json({ who: 'rerun' }), root)
      expect(await replay.json()).toEqual({ who: 'owner' })
    })

    it('the same key on another method or path is a miss', async () => {
      const key = crypto.randomUUID()
      await recordFor(key)
      let calls = 0
      const run = async () => {
        calls += 1
        return Response.json({ who: 'rerun' })
      }
      await withIdempotentReplay(requestWithKey(key, { method: 'DELETE' }), USER, run, root)
      const otherPath = new Request('http://localhost/admin/api/studio/save', {
        method: 'POST',
        headers: { 'x-studio-idempotency-key': key },
      })
      await withIdempotentReplay(otherPath, USER, run, root)
      expect(calls).toBe(2)
    })
  })

  it('prunes an orphaned staging file once it is older than a record could live (F6)', async () => {
    const orphan = path.join(root, `${crypto.randomUUID()}.json.${crypto.randomUUID()}.tmp`)
    fs.writeFileSync(orphan, '{')
    const old = new Date(Date.now() - 60 * 60 * 1000)
    fs.utimesSync(orphan, old, old)
    await withIdempotentReplay(requestWithKey(crypto.randomUUID()), USER, async () => Response.json({ ok: true }), root)
    expect(fs.existsSync(orphan)).toBe(false)
  })
})
