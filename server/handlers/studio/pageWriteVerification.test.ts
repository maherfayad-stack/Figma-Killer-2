/**
 * pageWriteVerification — the shared computation the digest (component 1)
 * and the Stop-hook gate (component 2) both consume. Exercised against a
 * REAL scaffolded page + a real registered design reference, never a hand-
 * built `Page` fixture, so this proves the function against the same shapes
 * `loadStudioPages`/`designReferenceStore`/`pageVerificationStore` actually
 * produce.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadStudioPages } from '../studioPageLoad'
import { createScaffoldedPage } from './pageScaffold'
import { resolvePageSourceFile } from './pageSourceFile'
import { CHAT_ATTACHMENT_REFERENCE_SOURCE } from './designReferenceSchema'
import { registerDesignReference } from './designReferenceStore'
import { recordPassingCompare } from './pageVerificationStore'
import { appendTurnWrite, resetTurnWriteLog } from './turnWriteLog'
import {
  computePageWriteVerification,
  describePageForDigest,
  describeUnverifiedPage,
  WRITE_THRASH_THRESHOLD,
} from './pageWriteVerification'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-page-write-verification-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function scaffold(name: string) {
  const result = createScaffoldedPage(dir, name)
  if (!result.ok) throw new Error(result.conflict)
  const { pages } = await loadStudioPages(dir)
  const page = pages.find((p) => p.id === result.pageId)!
  const rel = resolvePageSourceFile(page)!
  return { page, rel }
}

describe('computePageWriteVerification', () => {
  it('returns nothing when the turn write log is empty', async () => {
    const { page } = await scaffold('Onboarding')
    expect(computePageWriteVerification(dir, [page])).toEqual([])
  })

  it('flags a page written this turn with no design reference registered', async () => {
    const { page, rel } = await scaffold('Onboarding')
    appendTurnWrite(dir, path.join(dir, rel))

    const [entry] = computePageWriteVerification(dir, [page])
    expect(entry).toBeDefined()
    expect(entry!.hasReference).toBe(false)
    expect(entry!.verifiedSinceWrite).toBe(false)
    expect(entry!.writeCount).toBe(1)
  })

  it('flags a page written AFTER its last passing compare', async () => {
    const { page, rel } = await scaffold('Onboarding')
    const registered = await registerDesignReference(dir, ONE_PIXEL_PNG, { pageId: page.id })
    if (!registered.ok) throw new Error(registered.error)

    const t0 = Date.now()
    recordPassingCompare(dir, page.id, registered.reference.id, t0)
    appendTurnWrite(dir, path.join(dir, rel), t0 + 1000)

    const [entry] = computePageWriteVerification(dir, [page])
    expect(entry!.hasReference).toBe(true)
    expect(entry!.verifiedSinceWrite).toBe(false)
  })

  it('does NOT flag a page whose passing compare postdates the write — the silent, armed-and-passing case', async () => {
    const { page, rel } = await scaffold('Onboarding')
    const registered = await registerDesignReference(dir, ONE_PIXEL_PNG, { pageId: page.id })
    if (!registered.ok) throw new Error(registered.error)

    const t0 = Date.now()
    appendTurnWrite(dir, path.join(dir, rel), t0)
    recordPassingCompare(dir, page.id, registered.reference.id, t0 + 1000)

    const [entry] = computePageWriteVerification(dir, [page])
    expect(entry!.hasReference).toBe(true)
    expect(entry!.verifiedSinceWrite).toBe(true)
  })

  it('reports an ambiguous page as ambiguous rather than as unarmed', async () => {
    // Two equally-ranked specs on one page: `resolveDesignReference` refuses to
    // pick, so `hasReference` is false — but the gate must NOT then tell the
    // agent to register a design, which is what the unarmed branch says and
    // what would add a third candidate to a set it already cannot choose from.
    const { page, rel } = await scaffold('Onboarding')
    for (const label of ['v1', 'v2']) {
      const registered = await registerDesignReference(dir, ONE_PIXEL_PNG, { pageId: page.id, label, role: 'spec' })
      if (!registered.ok) throw new Error(registered.error)
    }
    appendTurnWrite(dir, path.join(dir, rel))

    const [entry] = computePageWriteVerification(dir, [page])
    expect(entry!.hasReference).toBe(false)
    expect(entry!.referenceAmbiguity).toBeDefined()
    expect(entry!.referenceAmbiguity).toContain('referenceId')

    const message = describeUnverifiedPage(entry!, false)
    expect(message).toContain('referenceId')
    expect(message).not.toContain('has NO design reference registered')
  })

  it('a page armed with one spec and one chat attachment is NOT ambiguous — the spec simply wins', async () => {
    const { page, rel } = await scaffold('Onboarding')
    const spec = await registerDesignReference(dir, ONE_PIXEL_PNG, { pageId: page.id, role: 'spec' })
    if (!spec.ok) throw new Error(spec.error)
    const pasted = await registerDesignReference(dir, ONE_PIXEL_PNG, {
      pageId: page.id,
      role: 'context',
      source: CHAT_ATTACHMENT_REFERENCE_SOURCE,
    })
    if (!pasted.ok) throw new Error(pasted.error)
    appendTurnWrite(dir, path.join(dir, rel))

    const [entry] = computePageWriteVerification(dir, [page])
    expect(entry!.hasReference).toBe(true)
    expect(entry!.referenceId).toBe(spec.reference.id)
    expect(entry!.referenceAmbiguity).toBeUndefined()
  })

  it('counts every write to the same file, and never flags a page nothing wrote to', async () => {
    const onboarding = await scaffold('Onboarding')
    const checkout = await scaffold('Checkout')
    appendTurnWrite(dir, path.join(dir, onboarding.rel))
    appendTurnWrite(dir, path.join(dir, onboarding.rel))
    appendTurnWrite(dir, path.join(dir, onboarding.rel))

    const entries = computePageWriteVerification(dir, [onboarding.page, checkout.page])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.pageId).toBe(onboarding.page.id)
    expect(entries[0]!.writeCount).toBe(3)
  })

  it('resetTurnWriteLog clears the log for a fresh turn', async () => {
    const { page, rel } = await scaffold('Onboarding')
    appendTurnWrite(dir, path.join(dir, rel))
    expect(computePageWriteVerification(dir, [page])).toHaveLength(1)

    resetTurnWriteLog(dir)
    expect(computePageWriteVerification(dir, [page])).toEqual([])
  })
})

describe('describeUnverifiedPage / describePageForDigest', () => {
  const base = {
    pageId: 'onboarding',
    title: 'Onboarding',
    writeCount: 1,
    lastWrittenAtMs: Date.now(),
    hasReference: false,
    verifiedSinceWrite: false,
  }

  it('names studio_register_design_reference for an unarmed page, with the Figma export step only when a connector is configured', () => {
    expect(describeUnverifiedPage(base, false)).toContain('studio_register_design_reference')
    expect(describeUnverifiedPage(base, false)).toContain('studio_quality_check')
    expect(describeUnverifiedPage(base, true)).toContain('Figma connector')
  })

  it('names studio_compare for an armed-but-unverified page', () => {
    const armed = { ...base, hasReference: true, referenceId: 'ref-1' }
    const message = describeUnverifiedPage(armed, false)
    expect(message).toContain('studio_compare')
    expect(message).not.toContain('studio_register_design_reference')
  })

  it('tells an ambiguous page to PICK a reference, never to register another one', () => {
    // The instruction the gate owes a model it just blocked. "Register a design
    // reference" is the opposite of the right move here, so its absence is the
    // assertion that matters.
    const ambiguous = {
      ...base,
      referenceAmbiguity: '"onboarding" has 2 registered designs ... Pass referenceId to name the one to measure against.',
    }
    const message = describeUnverifiedPage(ambiguous, true)
    expect(message).toContain('2 registered designs')
    expect(message).toContain('studio_compare')
    expect(message).toContain('referenceId')
    expect(message).not.toContain('studio_register_design_reference')
    expect(message).not.toContain('Figma connector')
  })

  it('names the write count as thrash only at or above the threshold', () => {
    const under = describeUnverifiedPage({ ...base, writeCount: WRITE_THRASH_THRESHOLD - 1 }, false)
    const at = describeUnverifiedPage({ ...base, writeCount: WRITE_THRASH_THRESHOLD }, false)
    expect(under).not.toContain('compose the whole screen and write once')
    expect(at).toContain('compose the whole screen and write once')
  })

  it('digest line is a single word for an armed, passing, non-thrashing page — the gate stays silent', () => {
    const verified = { ...base, hasReference: true, referenceId: 'ref-1', verifiedSinceWrite: true }
    expect(describePageForDigest(verified, false)).toBe('"Onboarding": verified.')
  })

  it('digest line still names thrash for an otherwise-verified page', () => {
    const verified = { ...base, hasReference: true, verifiedSinceWrite: true, writeCount: WRITE_THRASH_THRESHOLD }
    expect(describePageForDigest(verified, false)).toContain('verified')
    expect(describePageForDigest(verified, false)).toContain('compose the whole screen and write once')
  })

  it('digest line is the full actionable message for an unverified page', () => {
    expect(describePageForDigest(base, false)).toBe(describeUnverifiedPage(base, false))
  })
})
