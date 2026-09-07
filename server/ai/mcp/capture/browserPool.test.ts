/**
 * W9-5 lever 3 — `prewarmCaptureBrowser`, the one thing about the pool that a
 * caller outside a capture can trigger.
 *
 * The saving it exists for (~300-600 ms of cold Chromium launch off the first
 * capture) is a benchmark number, not a test. What is pinned here is the
 * behaviour that makes it SAFE to call it from an HTTP handler on every
 * project open: it launches at most one browser, it reuses that browser for
 * the capture that follows, and it never surfaces a failure — a host with no
 * Chromium must keep loading the board exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearLaunchFailureMemo,
  closeWarmCaptureBrowser,
  prewarmCaptureBrowser,
  rememberedLaunchFailure,
  withCapturePage,
  type CapturePage,
  type PlaywrightLikeBrowser,
} from './browserPool'

function fakeBrowser(): PlaywrightLikeBrowser<CapturePage> {
  return {
    newPage: async () => ({
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      screenshot: async () => Buffer.from(''),
      close: async () => undefined,
      waitForFunction: async () => undefined,
      evaluate: async () => undefined,
      $: async () => null,
    }),
    close: async () => undefined,
    isConnected: () => true,
  }
}

/** Let the fire-and-forget prewarm's microtask + `.finally` chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  clearLaunchFailureMemo()
  await closeWarmCaptureBrowser()
})

afterEach(async () => {
  clearLaunchFailureMemo()
  await closeWarmCaptureBrowser()
})

describe('prewarmCaptureBrowser', () => {
  it('launches exactly one browser however many times it is called', async () => {
    let launches = 0
    const launch = async () => { launches++; return fakeBrowser() }

    // Two tabs opening the same project in the same tick — the in-flight guard.
    prewarmCaptureBrowser(launch)
    prewarmCaptureBrowser(launch)
    await settle()
    expect(launches).toBe(1)

    // And once warm, a third open is a no-op rather than a relaunch.
    prewarmCaptureBrowser(launch)
    await settle()
    expect(launches).toBe(1)
  })

  it('hands the prewarmed browser to the capture that follows — the whole point', async () => {
    let launches = 0
    const launch = async () => { launches++; return fakeBrowser() }

    prewarmCaptureBrowser(launch)
    await settle()
    expect(launches).toBe(1)

    await withCapturePage({ viewport: { width: 100, height: 100 }, launchBrowser: launch }, async () => 'done')
    expect(launches).toBe(1)
  })

  it('swallows a launch failure and records it, so a host with no Chromium loads the board unchanged', async () => {
    let launches = 0
    const launch = async () => {
      launches++
      throw new Error('Executable does not exist')
    }

    // No await, no catch at the call site — exactly how the load handler calls it.
    prewarmCaptureBrowser(launch)
    await settle()

    expect(launches).toBe(1)
    expect(rememberedLaunchFailure()).toContain('Executable does not exist')

    // The memo then suppresses the next open's prewarm rather than paying a
    // second doomed launch — the same discipline the capture path applies.
    prewarmCaptureBrowser(launch)
    await settle()
    expect(launches).toBe(1)
  })
})
