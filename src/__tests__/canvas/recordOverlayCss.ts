import type { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

/**
 * Remembers the CSS text each overlay was last given.
 *
 * An `incremental` overlay (`ClassStyleInjector`'s `mc-classes`) reaches the
 * document as rule edits and its `<style>` element holds no text, so a test
 * about WHAT an injector emits asks the adapter's input rather than the
 * element. What the sheet then contains is `PortalFrameAdapter.incremental.test.ts`.
 */
export function recordOverlayCss(adapter: PortalFrameAdapter): (id: string) => string {
  const last = new Map<string, string>()
  const apply = adapter.applyOverlay.bind(adapter)
  adapter.applyOverlay = (id, css, options) => {
    last.set(id, css)
    apply(id, css, options)
  }
  return (id) => last.get(id) ?? ''
}
