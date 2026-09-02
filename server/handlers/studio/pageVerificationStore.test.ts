import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readPassingCompare, recordPassingCompare } from './pageVerificationStore'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-page-verification-store-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pageVerificationStore', () => {
  it('reports null for a page that has never passed', () => {
    expect(readPassingCompare(dir, 'onboarding')).toBeNull()
  })

  it('records and reads back a passing compare', () => {
    recordPassingCompare(dir, 'onboarding', 'ref-1', 12345)
    expect(readPassingCompare(dir, 'onboarding')).toEqual({ passedAtMs: 12345, referenceId: 'ref-1' })
  })

  it('records for one page without disturbing another', () => {
    recordPassingCompare(dir, 'onboarding', 'ref-1', 1000)
    recordPassingCompare(dir, 'checkout', 'ref-2', 2000)
    expect(readPassingCompare(dir, 'onboarding')).toEqual({ passedAtMs: 1000, referenceId: 'ref-1' })
    expect(readPassingCompare(dir, 'checkout')).toEqual({ passedAtMs: 2000, referenceId: 'ref-2' })
  })

  it('a later record for the same page overwrites the earlier one', () => {
    recordPassingCompare(dir, 'onboarding', 'ref-1', 1000)
    recordPassingCompare(dir, 'onboarding', 'ref-2', 2000)
    expect(readPassingCompare(dir, 'onboarding')).toEqual({ passedAtMs: 2000, referenceId: 'ref-2' })
  })
})
