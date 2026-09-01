import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { appendTurnWrite, readTurnWriteLog, resetTurnWriteLog } from './turnWriteLog'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-turn-write-log-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('turnWriteLog', () => {
  it('is empty before anything is recorded', () => {
    expect(readTurnWriteLog(dir)).toEqual([])
  })

  it('records a write, normalised to a workspace-relative POSIX path', () => {
    appendTurnWrite(dir, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    expect(readTurnWriteLog(dir)).toEqual([{ file: 'pages/Onboarding.tsx', atMs: 1000 }])
  })

  it('appends across multiple calls rather than overwriting', () => {
    appendTurnWrite(dir, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    appendTurnWrite(dir, path.join(dir, 'pages', 'Onboarding.tsx'), 2000)
    expect(readTurnWriteLog(dir)).toHaveLength(2)
  })

  it('drops a path that resolves outside the project directory', () => {
    appendTurnWrite(dir, path.join(dir, '..', 'outside.tsx'), 1000)
    expect(readTurnWriteLog(dir)).toEqual([])
  })

  it('resetTurnWriteLog clears whatever was recorded', () => {
    appendTurnWrite(dir, path.join(dir, 'pages', 'Onboarding.tsx'), 1000)
    resetTurnWriteLog(dir)
    expect(readTurnWriteLog(dir)).toEqual([])
  })

  it('resetTurnWriteLog is safe to call before anything else has touched the project', () => {
    resetTurnWriteLog(dir)
    expect(readTurnWriteLog(dir)).toEqual([])
  })
})
