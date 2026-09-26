/**
 * WB-33 — a 500 never hands the client an exception's own text.
 *
 * `err.message` from an unexpected failure can carry an absolute filesystem
 * path, a ts-morph internal or a stack line, and the editor shows the envelope
 * to a person ("Could not open this project: …"). Every such 500 goes through
 * `server/http.ts`'s `internalServerError(label, err)`: the raw error is logged
 * on the server, and the client gets one plain sentence.
 *
 * A failure the handler DID name (a typed error class with a user-facing
 * message and its own 4xx status) is not this gate's business — it keeps its
 * own envelope.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'
import { INTERNAL_SERVER_ERROR_MESSAGE, internalServerError } from '../../../server/http'

const SERVER_ROOT = join(import.meta.dir, '../../../server')

/** The shape the 48 sites had: an unnamed exception's message, straight into a 500 envelope. */
const RAW_500 = /jsonResponse\(\s*\{\s*error:\s*err instanceof Error \? err\.message : String\(err\)\s*\},\s*\{\s*status:\s*500\s*\}\s*\)/

describe('WB-33 — 500s hide exception text', () => {
  it('no server route answers a 500 with `err.message`', () => {
    const offenders = walkSourceTree(SERVER_ROOT)
      .filter((file) => !/[\\/]__tests__[\\/]|\.test\.ts$/.test(file))
      .filter((file) => RAW_500.test(readSource(file)))
      .map(toRepoRelativePosix)
    expect(offenders).toEqual([])
  })

  it('internalServerError logs the raw error and answers one plain sentence', async () => {
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    try {
      const response = internalServerError('[studio]', new Error('ENOENT: /home/me/studio-workspace/app/secret.tsx'))
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: string }
      expect(body.error).toBe(INTERNAL_SERVER_ERROR_MESSAGE)
      expect(body.error).not.toContain('/home/me')
      expect(logged).toHaveLength(1)
      expect(logged[0]![0]).toBe('[studio]')
    } finally {
      console.error = original
    }
  })
})
