/**
 * elementResizeInlinePreview — how a PORTAL frame's resize previews the patch
 * it will commit (`useElementResizeDrag.ts`): straight onto the element's own
 * `style`, restorable to the exact inline values it found.
 *
 * The preview applies the SAME patch the commit writes (`resizeInlinePatch`,
 * `@core/studio-runtime`'s `elementResizeSizing.ts`), because a preview that
 * only moved `width` would lie for the whole drag on a flex item. It
 * snapshots every property it touches and restores the originals before the
 * store commit, so React's re-render is the last thing to write them — the
 * preview-then-commit contract `useElementResizeDrag` documents.
 *
 * A live frame cannot preview this way (its commit is an HMR round trip away,
 * and React will write the same inline value) — it previews through a
 * runtime-owned stylesheet instead (`resizeHandles.ts`).
 */
import { cssPropertyName, type ResizeInlinePatch } from '@core/studio-runtime'

export interface InlineStylePreview {
  /** Show `patch` on the element; a property a previous call touched and this one does not is restored. */
  apply(patch: ResizeInlinePatch): void
  /** Restore every touched property to what React last wrote. */
  clear(): void
}

/**
 * A preview written straight onto the element's own `style`, restorable to the
 * exact inline values it found. Clears run before sets, because clearing a
 * longhand (`flex-grow`) after setting its shorthand (`flex`) would unset
 * part of the value just written.
 */
export function createInlineStylePreview(element: HTMLElement): InlineStylePreview {
  const originals = new Map<string, { value: string; priority: string }>()

  const remember = (name: string) => {
    if (originals.has(name)) return
    originals.set(name, { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) })
  }
  const restore = (names: Iterable<string>) => {
    // The `flex` shorthand first, so a restored longhand is not reset by it.
    const ordered = [...names].sort((a, b) => Number(b === 'flex') - Number(a === 'flex'))
    for (const name of ordered) {
      const original = originals.get(name)
      if (!original) continue
      if (original.value === '') element.style.removeProperty(name)
      else element.style.setProperty(name, original.value, original.priority)
      originals.delete(name)
    }
  }

  return {
    apply(patch) {
      const entries = Object.entries(patch).map(([key, value]) => [cssPropertyName(key), value] as const)
      const touched = new Set(entries.map(([name]) => name))
      restore([...originals.keys()].filter((name) => !touched.has(name)))
      for (const [name, value] of entries) {
        remember(name)
        if (value === undefined) element.style.removeProperty(name)
      }
      for (const [name, value] of entries) {
        if (value !== undefined) element.style.setProperty(name, value)
      }
    },
    clear() {
      restore([...originals.keys()])
    },
  }
}
