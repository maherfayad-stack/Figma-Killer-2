/**
 * perf-17 — the token extraction re-runs only when something it reads changed
 * (`tokenExtractMemo.ts`). Before, every project open re-ran it in full.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearLoadedProjects } from './loadedProjects'
import { clearTokenExtractMemo, clearTokenExtractMemoFor, memoizedTokenExtraction } from './tokenExtractMemo'

describe('memoizedTokenExtraction', () => {
  let dir: string
  let extractions: number
  const extract = async () => {
    extractions += 1
    return `extraction-${extractions}`
  }
  const run = () => memoizedTokenExtraction(dir, () => dir, extract)

  beforeEach(() => {
    clearTokenExtractMemo()
    extractions = 0
    dir = mkdtempSync(join(tmpdir(), 'studio-token-memo-'))
    mkdirSync(join(dir, 'styles'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }))
    writeFileSync(join(dir, 'styles', 'tokens.css'), ':root { --brand: #3366ff; }\n')
  })

  afterEach(() => {
    clearLoadedProjects()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a repeat with nothing changed does not extract again', async () => {
    expect(await run()).toBe('extraction-1')
    expect(await run()).toBe('extraction-1')
    expect(extractions).toBe(1)
  })

  it('an install (a lockfile appears, node_modules gains an entry) extracts again', async () => {
    await run()
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    expect(await run()).toBe('extraction-2')
    mkdirSync(join(dir, 'node_modules', 'some-design-system'), { recursive: true })
    expect(await run()).toBe('extraction-3')
    expect(await run()).toBe('extraction-3')
  })

  it('a `.studio/meta.json` change (the trust tier lives there) extracts again', async () => {
    await run()
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ trust: 'render-packages' }))
    expect(await run()).toBe('extraction-2')
  })

  it('an edited stylesheet extracts again once the project watcher has reported it', async () => {
    await run()
    writeFileSync(join(dir, 'styles', 'tokens.css'), ':root { --brand: #ff0055; --accent: #00ff00; }\n')
    // The watcher reports within milliseconds; poll rather than sleep a fixed time.
    const deadline = Date.now() + 5000
    let result = await run()
    while (result === 'extraction-1' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      result = await run()
    }
    expect(result).toBe('extraction-2')
  })

  it('a rescan (forgetting the entry) extracts again', async () => {
    await run()
    clearTokenExtractMemoFor(dir)
    expect(await run()).toBe('extraction-2')
  })
})
