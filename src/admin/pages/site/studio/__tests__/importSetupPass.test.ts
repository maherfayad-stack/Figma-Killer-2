/**
 * The import setup pass's queue.
 *
 * The consume-once test is the one that matters: the pass starts an agent turn
 * that edits the user's files, so a queue that could be drained twice would
 * run two of them against the same project.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  clearImportSetupPass,
  consumeImportSetupPass,
  importSetupBrief,
  requestImportSetupPass,
} from '../importSetupPass'

beforeEach(() => {
  clearImportSetupPass()
})

describe('importSetupPass queue', () => {
  it('hands the queued dir to exactly one consumer', () => {
    requestImportSetupPass('/w/test4')

    expect(consumeImportSetupPass()).toBe('/w/test4')
    // The editor body mounts AND listens for the reload event, so the second
    // call is a real code path, not a hypothetical one.
    expect(consumeImportSetupPass()).toBeNull()
  })

  it('is empty until an import queues something', () => {
    expect(consumeImportSetupPass()).toBeNull()
  })

  it('keeps only the latest dir — a second import means a changed mind', () => {
    requestImportSetupPass('/w/first')
    requestImportSetupPass('/w/second')

    expect(consumeImportSetupPass()).toBe('/w/second')
    expect(consumeImportSetupPass()).toBeNull()
  })

  it('can be dropped without running', () => {
    requestImportSetupPass('/w/test4')
    clearImportSetupPass()

    expect(consumeImportSetupPass()).toBeNull()
  })
})

describe('importSetupBrief', () => {
  it('names the project, so the agent reports on the one that was imported', () => {
    expect(importSetupBrief('travel-essentials')).toContain('"travel-essentials"')
  })

  it('orders the steps by their real dependency, deps before the fidelity report', () => {
    const brief = importSetupBrief('test4')
    expect(brief.indexOf('studio_install_deps')).toBeLessThan(brief.indexOf('studio_fidelity_report'))
  })

  it('tells the agent to wire only the flows the source already has', () => {
    const brief = importSetupBrief('test4')
    expect(brief).toContain('studio_set_prototype_link')
    // The line that stops the pass inventing flows on a repo nobody has read
    // yet. A made-up link is indistinguishable, on the board, from a drawn one.
    expect(brief).toContain('Do not invent flows')
  })
})
