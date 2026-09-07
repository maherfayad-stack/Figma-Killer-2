import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readPassingCompare, recordPassingCompare } from './pageVerificationStore'

/** The store is per ACCOUNT within a project (W10) — a colleague's passing compare must never satisfy this account's Stop gate. */
const USER = 'a1b2c3d4e5f60718'
const OTHER_USER = '00112233445566ff'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-page-verification-store-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pageVerificationStore', () => {
  it('reports null for a page that has never passed', () => {
    expect(readPassingCompare(dir, USER, 'onboarding')).toBeNull()
  })

  it('records and reads back a passing compare', () => {
    recordPassingCompare(dir, USER, 'onboarding', 'ref-1', 'balanced', 12345)
    expect(readPassingCompare(dir, USER, 'onboarding')).toEqual({ passedAtMs: 12345, referenceId: 'ref-1', fidelityMode: 'balanced' })
  })

  it('records for one page without disturbing another', () => {
    recordPassingCompare(dir, USER, 'onboarding', 'ref-1', 'balanced', 1000)
    recordPassingCompare(dir, USER, 'checkout', 'ref-2', 'balanced', 2000)
    expect(readPassingCompare(dir, USER, 'onboarding')).toEqual({ passedAtMs: 1000, referenceId: 'ref-1', fidelityMode: 'balanced' })
    expect(readPassingCompare(dir, USER, 'checkout')).toEqual({ passedAtMs: 2000, referenceId: 'ref-2', fidelityMode: 'balanced' })
  })

  it('a later record for the same page overwrites the earlier one', () => {
    recordPassingCompare(dir, USER, 'onboarding', 'ref-1', 'balanced', 1000)
    recordPassingCompare(dir, USER, 'onboarding', 'ref-2', 'balanced', 2000)
    expect(readPassingCompare(dir, USER, 'onboarding')).toEqual({ passedAtMs: 2000, referenceId: 'ref-2', fidelityMode: 'balanced' })
  })

  it("one account's passing compare does not satisfy another's gate", () => {
    recordPassingCompare(dir, OTHER_USER, 'onboarding', 'ref-1', 'balanced', 1000)

    expect(readPassingCompare(dir, USER, 'onboarding')).toBeNull()
    expect(readPassingCompare(dir, OTHER_USER, 'onboarding')).toEqual({
      passedAtMs: 1000,
      referenceId: 'ref-1',
      fidelityMode: 'balanced',
    })
  })
})
