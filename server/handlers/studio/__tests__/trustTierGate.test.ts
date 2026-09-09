/**
 * trustGate — `requireTrustTier`, extracted out of `deploy.ts`'s inline
 * check. Unit-tested directly here; its two real consumers (`deploy.ts`,
 * `devServer.ts`) each exercise it again through their own routes.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { requireTrustTier } from '../trustGate'
import { writeStudioMeta } from '../studioMeta'

function makeTmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-trustgate-')))
}

describe('requireTrustTier', () => {
  it('answers ok:true when the project is already at the required tier', () => {
    const dir = makeTmpDir()
    writeStudioMeta(dir, { trust: 'run-project' })

    const result = requireTrustTier(dir, 'run-project', 'nope')

    expect(result.ok).toBe(true)
    expect(result.ok && result.trust).toBe('run-project')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses with a 409 carrying the given message and code:trust-tier-required when the tier does not match', async () => {
    const dir = makeTmpDir()
    writeStudioMeta(dir, { trust: 'render-packages' })

    const result = requireTrustTier(dir, 'run-project', 'You need to promote this project first.')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(409)
      const body = (await result.response.json()) as { error: string; code: string }
      expect(body.error).toBe('You need to promote this project first.')
      expect(body.code).toBe('trust-tier-required')
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('defaults an unset trust field to Tier 0 (static), refusing anything higher', () => {
    const dir = makeTmpDir()
    // No `.studio/meta.json` written at all — the untouched default.

    const result = requireTrustTier(dir, 'run-project', 'nope')

    expect(result.ok).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
