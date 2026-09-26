/**
 * Toast de-duplication gate.
 *
 * The toast bus has 139 call sites and, before this gate, exactly three of
 * them passed a `dedupeKey`. So one root cause — a render loop, a failing
 * autosave, a refused gesture the user retries — produced N identical cards,
 * which is the "noisy errors" experience Track Z exists to remove.
 *
 * The rule: **collapsing is the default.** Two pushes that would render the
 * same card (same `kind` + `title` + `body`) are one notification; the second
 * bumps a `×N` counter on the card already on screen. A caller with genuinely
 * distinct events that share copy opts out with `dedupeKey: false`.
 *
 * Both halves are gated here — the behaviour (a keyless double push is one
 * toast with count 2) and the source shape (`resolveCollapseKey` derives from
 * kind/title/body, and the provider renders `repeatCount`). The source scan
 * matters because the behaviour could be satisfied by a special case while
 * the default quietly reverted to opt-in.
 *
 * @see src/ui/components/Toast/toastBus.ts
 * @see STUDIO-FIGMA-FEEL-PLAN.md — Z1
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  __resetToastBusForTests,
  pushToast,
  subscribeToasts,
  type Toast,
} from '@ui/components/Toast/toastBus'

const UI_ROOT = join(import.meta.dir, '../../ui/components/Toast')

function snapshot(): ReadonlyArray<Toast> {
  let captured: ReadonlyArray<Toast> = []
  subscribeToasts((next) => {
    captured = next
  })()
  return captured
}

afterEach(() => {
  __resetToastBusForTests()
})

describe('toasts de-duplicate by default', () => {
  it('collapses a repeat pushed without a dedupeKey into one toast with count 2', () => {
    const first = pushToast({
      kind: 'error',
      title: 'Could not write to your project source',
      body: 'The file is read-only.',
      durationMs: null,
    })
    const second = pushToast({
      kind: 'error',
      title: 'Could not write to your project source',
      body: 'The file is read-only.',
      durationMs: null,
    })

    const toasts = snapshot()
    expect(toasts).toHaveLength(1)
    expect(second).toBe(first)
    expect(toasts[0]?.repeatCount).toBe(2)
  })

  it('a burst of five keyless pushes is still one toast', () => {
    for (let i = 0; i < 5; i++) {
      pushToast({ kind: 'success', title: 'Duplicated', body: 'Written to your project source', durationMs: null })
    }
    const toasts = snapshot()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.repeatCount).toBe(5)
  })

  it('`dedupeKey: false` is the documented opt-out and still stacks', () => {
    pushToast({ kind: 'error', title: 'Upload failed', dedupeKey: false, durationMs: null })
    pushToast({ kind: 'error', title: 'Upload failed', dedupeKey: false, durationMs: null })
    expect(snapshot()).toHaveLength(2)
  })

  it('the bus derives the default key from kind + title + body', () => {
    const source = readFileSync(join(UI_ROOT, 'toastBus.ts'), 'utf8')
    const resolver = /function resolveCollapseKey[\s\S]*?\n}/.exec(source)?.[0]
    if (!resolver) {
      throw new Error(
        '[toast dedupe] toastBus.ts no longer declares resolveCollapseKey(). The default ' +
          'collapse identity must stay in one named function — see docs/reference/architecture-tests.md (toast-dedupe-default).',
      )
    }
    for (const part of ['input.kind', 'input.title', 'input.body']) {
      expect(resolver).toContain(part)
    }
    // `false` must remain the opt-out, not `undefined`: an opt-in default is
    // exactly the regression this gate exists to catch.
    expect(resolver).toContain('input.dedupeKey === false')
  })

  it('the provider renders the repeat counter so a collapsed repeat is visible', () => {
    const source = readFileSync(join(UI_ROOT, 'ToastProvider.tsx'), 'utf8')
    expect(source).toMatch(/toast\.repeatCount\s*>\s*1/)
    expect(source).toMatch(/×\{toast\.repeatCount\}/)
  })
})
