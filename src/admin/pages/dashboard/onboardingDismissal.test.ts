/**
 * onboardingDismissal — the one thing the launcher remembers about the
 * checklist.
 *
 * The property with teeth is the per-user key. `localStorage` is per browser,
 * so a single boolean would mean the second account on a shared machine never
 * sees the checklist at all — and there is no un-dismiss, so they would never
 * see it again either. The rest is soft-failure: a browser with storage
 * disabled must render the launcher, not throw on the way to it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  ONBOARDING_DISMISSAL_STORAGE_KEY,
  dismissOnboarding,
  isOnboardingDismissed,
} from './onboardingDismissal'

const realLocalStorage = globalThis.localStorage

/** A minimal in-memory `localStorage`, so these tests do not need a DOM. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
}

beforeEach(() => {
  installStorage(memoryStorage())
})

afterEach(() => {
  installStorage(realLocalStorage)
})

describe('onboardingDismissal', () => {
  it('remembers a dismissal', () => {
    expect(isOnboardingDismissed('user-1')).toBe(false)

    dismissOnboarding('user-1')

    expect(isOnboardingDismissed('user-1')).toBe(true)
  })

  it('is per user — a second account on the same browser still gets the checklist', () => {
    dismissOnboarding('user-1')

    expect(isOnboardingDismissed('user-2')).toBe(false)

    dismissOnboarding('user-2')

    // …and dismissing for the second account does not undo the first.
    expect(isOnboardingDismissed('user-1')).toBe(true)
    expect(isOnboardingDismissed('user-2')).toBe(true)
  })

  it('is idempotent — dismissing twice records one id, not two', () => {
    dismissOnboarding('user-1')
    dismissOnboarding('user-1')

    const raw: unknown = JSON.parse(localStorage.getItem(ONBOARDING_DISMISSAL_STORAGE_KEY) ?? '{}')
    expect((raw as { userIds: string[] }).userIds).toEqual(['user-1'])
  })

  it('reads a corrupted entry as "not dismissed" rather than throwing', () => {
    localStorage.setItem(ONBOARDING_DISMISSAL_STORAGE_KEY, 'not json {{{')
    expect(isOnboardingDismissed('user-1')).toBe(false)

    // A well-formed JSON value of the wrong shape is the same story.
    localStorage.setItem(ONBOARDING_DISMISSAL_STORAGE_KEY, JSON.stringify({ userIds: 'user-1' }))
    expect(isOnboardingDismissed('user-1')).toBe(false)
  })

  it('survives a browser that refuses storage entirely', () => {
    installStorage({
      get length() {
        return 0
      },
      clear: () => {},
      getItem: () => {
        throw new Error('storage is disabled')
      },
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error('storage is disabled')
      },
    })

    // Neither call throws; the user just keeps seeing the checklist, which is
    // the honest outcome when nothing can be remembered.
    expect(isOnboardingDismissed('user-1')).toBe(false)
    expect(() => dismissOnboarding('user-1')).not.toThrow()
  })
})
