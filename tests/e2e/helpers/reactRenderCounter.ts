/**
 * Counts React component renders in a real browser, by component name.
 *
 * A render count is the honest number for "a structural write re-renders only
 * what changed" (audit `01-perf.md` §3 item 8, PERF-6): time alone cannot
 * tell 2 re-rendered `NodeRenderer`s from 2,800 on a fast machine, and a
 * happy-dom test (`nodeRendererPostWriteRerender.test.tsx`) cannot tell what
 * the real canvas — portals into forty iframes, the real store, the real
 * reparse — actually does.
 *
 * It needs no product code. React reports every commit to
 * `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` when one exists before React loads
 * (that is how the DevTools extension works), so an init script installs a
 * minimal hook and walks each committed tree the way DevTools' own
 * `didFiberRender` does:
 *
 *   - a fiber with no `alternate` MOUNTED in this commit;
 *   - a function/memo fiber whose flags carry `PerformedWork` (bit 0) RENDERED
 *     in this commit — React sets it only when the component function ran,
 *     and a fiber cloned for a bailout starts with it cleared;
 *   - a fiber whose `child` is its alternate's `child` bailed out with its
 *     whole subtree, which is therefore not walked.
 *
 * Vite's React Refresh runtime finds this hook already present and wraps it
 * rather than replacing it, so both keep working.
 */
import type { Page } from '@playwright/test'

export interface RenderCounts {
  /** Component name → times its function ran on an update (not a mount). */
  renders: Record<string, number>
  /** Component name → fibers mounted. */
  mounts: Record<string, number>
  commits: number
}

declare global {
  interface Window {
    __studioRenderCounter?: { read: () => RenderCounts; reset: () => void }
  }
}

/** Install before the first `page.goto` — React binds the hook when it loads. */
export async function installReactRenderCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Only the editor document runs React; canvas iframes are portal targets.
    if (window.top !== window) return
    const PERFORMED_WORK = 1
    // FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent.
    const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
    interface FiberLike {
      tag: number
      type: unknown
      elementType: unknown
      flags: number
      child: FiberLike | null
      sibling: FiberLike | null
      alternate: FiberLike | null
    }
    const nameOf = (value: unknown): string | null => {
      if (typeof value === 'function') return (value as { displayName?: string; name?: string }).displayName ?? (value as { name?: string }).name ?? null
      if (value && typeof value === 'object') {
        const inner = (value as { type?: unknown; render?: unknown }).type ?? (value as { render?: unknown }).render
        return inner ? nameOf(inner) : null
      }
      return null
    }
    let renders = new Map<string, number>()
    let mounts = new Map<string, number>()
    let commits = 0
    const walk = (root: FiberLike) => {
      const stack: FiberLike[] = [root]
      while (stack.length > 0) {
        const fiber = stack.pop()!
        const previous = fiber.alternate
        if (COMPONENT_TAGS.has(fiber.tag)) {
          const name = nameOf(fiber.type) ?? nameOf(fiber.elementType)
          if (name) {
            if (!previous) mounts.set(name, (mounts.get(name) ?? 0) + 1)
            else if ((fiber.flags & PERFORMED_WORK) === PERFORMED_WORK) renders.set(name, (renders.get(name) ?? 0) + 1)
          }
        }
        if (previous && fiber.child === previous.child) continue
        for (let child = fiber.child; child; child = child.sibling) stack.push(child)
      }
    }
    const renderers = new Map<number, unknown>()
    ;(window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers,
      supportsFiber: true,
      isDisabled: false,
      inject(renderer: unknown) {
        const id = renderers.size + 1
        renderers.set(id, renderer)
        return id
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: FiberLike }) {
        commits += 1
        walk(root.current)
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    }
    window.__studioRenderCounter = {
      read: () => ({ renders: Object.fromEntries(renders), mounts: Object.fromEntries(mounts), commits }),
      reset: () => {
        renders = new Map()
        mounts = new Map()
        commits = 0
      },
    }
  })
}

export async function resetRenderCounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!window.__studioRenderCounter) throw new Error('installReactRenderCounter was not called before the page loaded')
    window.__studioRenderCounter.reset()
  })
}

export async function readRenderCounts(page: Page): Promise<RenderCounts> {
  return page.evaluate(() => {
    if (!window.__studioRenderCounter) throw new Error('installReactRenderCounter was not called before the page loaded')
    return window.__studioRenderCounter.read()
  })
}

/** The `n` components that rendered most, as `Name xN` — for an annotation that names a regression. */
export function topRenders(counts: RenderCounts, n = 8): string {
  return Object.entries(counts.renders)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => `${name} x${count}`)
    .join(', ')
}
