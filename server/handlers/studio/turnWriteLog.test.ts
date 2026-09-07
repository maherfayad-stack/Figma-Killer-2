import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { appendTurnWrite, readAllTurnWrites, readTurnWriteLog, resetTurnWriteLog } from './turnWriteLog'

/** The log is per ACCOUNT within a project (W10) — every call carries the account's `studioAgentUserKey`. */
const USER = 'a1b2c3d4e5f60718'
const OTHER_USER = '00112233445566ff'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-turn-write-log-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('turnWriteLog', () => {
  it('is empty before anything is recorded', () => {
    expect(readTurnWriteLog(dir, USER)).toEqual([])
  })

  it('records a write, normalised to a workspace-relative POSIX path', () => {
    appendTurnWrite(dir, USER, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    expect(readTurnWriteLog(dir, USER)).toEqual([{ file: 'pages/Onboarding.tsx', atMs: 1000 }])
  })

  it('appends across multiple calls rather than overwriting', () => {
    appendTurnWrite(dir, USER, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    appendTurnWrite(dir, USER, path.join(dir, 'pages', 'Onboarding.tsx'), 2000)
    expect(readTurnWriteLog(dir, USER)).toHaveLength(2)
  })

  it('drops a path that resolves outside the project directory', () => {
    appendTurnWrite(dir, USER, path.join(dir, '..', 'outside.tsx'), 1000)
    expect(readTurnWriteLog(dir, USER)).toEqual([])
  })

  it('resetTurnWriteLog clears whatever was recorded', () => {
    appendTurnWrite(dir, USER, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    resetTurnWriteLog(dir, USER)
    expect(readTurnWriteLog(dir, USER)).toEqual([])
  })

  it('resetTurnWriteLog is safe to call before anything else has touched the project', () => {
    resetTurnWriteLog(dir, USER)
    expect(readTurnWriteLog(dir, USER)).toEqual([])
  })

  it("one account's writes are invisible to another's log", () => {
    appendTurnWrite(dir, USER, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    appendTurnWrite(dir, OTHER_USER, path.join(dir, 'pages', 'Checkout.tsx'), 1000)

    expect(readTurnWriteLog(dir, USER)).toEqual([{ file: 'pages/Onboarding.tsx', atMs: 1000 }])
    expect(readTurnWriteLog(dir, OTHER_USER)).toEqual([{ file: 'pages/Checkout.tsx', atMs: 1000 }])
  })

  it('readAllTurnWrites unions every account — the git panel asks about the FILE, not the session', () => {
    appendTurnWrite(dir, USER, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    appendTurnWrite(dir, OTHER_USER, path.join(dir, 'pages', 'Checkout.tsx'), 1000)

    expect(readAllTurnWrites(dir).map((e) => e.file).sort()).toEqual([
      'pages/Checkout.tsx',
      'pages/Onboarding.tsx',
    ])
  })

  it('readAllTurnWrites is empty for a project no account has run a turn against', () => {
    expect(readAllTurnWrites(dir)).toEqual([])
  })
})
