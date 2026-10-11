/**
 * SB-7 — `applyOverlay(id, css, { incremental: true })` on a real (happy-dom)
 * document: the sheet is edited rule by rule, the `<style>` never gets text, and
 * every observer that used to learn "the page's style changed" from a text
 * rewrite still hears it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { OVERLAY_REVISION_ATTR, STYLE_CHANGE_OBSERVER_OPTIONS } from '@core/studio-runtime'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

// Top-level rules only: happy-dom's CSSOM cannot model `@layer`, and its
// grouping rules throw on `insertRule`. The nested diff is `overlayRuleDiff.test.ts`.

let adapters: PortalFrameAdapter[] = []

afterEach(() => {
  for (const adapter of adapters) adapter.dispose()
  adapters = []
  document.head.replaceChildren()
})

function mount(): PortalFrameAdapter {
  document.head.replaceChildren()
  const adapter = new PortalFrameAdapter(document)
  adapters.push(adapter)
  return adapter
}

function overlayStyle(id: string): HTMLStyleElement {
  return document.querySelector<HTMLStyleElement>(`[data-studio-overlay-id="${id}"]`)!
}

function layerRules(style: HTMLStyleElement): CSSRule[] {
  return Array.from(style.sheet!.cssRules)
}

describe('PortalFrameAdapter incremental overlays', () => {
  it('builds the sheet from rules and leaves the element without text', () => {
    const adapter = mount()
    adapter.applyOverlay('mc-classes', '.a { color: red }\n.b { color: blue }', { incremental: true })
    const style = overlayStyle('mc-classes')
    expect(style.textContent).toBe('')
    expect(layerRules(style).map((rule) => (rule as CSSStyleRule).selectorText)).toEqual(['.a', '.b'])
  })

  it('an edit replaces only the changed rule; every other rule object is the same one', () => {
    const adapter = mount()
    adapter.applyOverlay('mc-classes', '.a { color: red }\n.b { color: blue }\n.c { color: green }', { incremental: true })
    const style = overlayStyle('mc-classes')
    const [a, b, c] = layerRules(style)
    adapter.applyOverlay('mc-classes', '.a { color: red }\n.b { color: black }\n.c { color: green }', { incremental: true })
    const after = layerRules(style)
    expect(after).toHaveLength(3)
    expect(after[0]).toBe(a!)
    expect(after[1]).not.toBe(b!)
    expect(after[2]).toBe(c!)
    expect((after[1] as CSSStyleRule).style.getPropertyValue('color')).toBe('black')
    expect(style.textContent).toBe('')
  })

  it('identical CSS touches nothing, not even the revision', () => {
    const adapter = mount()
    const css = '.a { color: red }'
    adapter.applyOverlay('mc-classes', css, { incremental: true })
    const style = overlayStyle('mc-classes')
    const revision = style.getAttribute(OVERLAY_REVISION_ATTR)
    const rule = layerRules(style)[0]
    adapter.applyOverlay('mc-classes', css, { incremental: true })
    expect(style.getAttribute(OVERLAY_REVISION_ATTR)).toBe(revision)
    expect(layerRules(style)[0]).toBe(rule!)
  })

  it('each rule edit bumps the revision a head observer watches, and a text rewrite is still seen too', async () => {
    const adapter = mount()
    const records: MutationRecord[] = []
    const observer = new MutationObserver((batch) => records.push(...batch))
    observer.observe(document.head, STYLE_CHANGE_OBSERVER_OPTIONS)
    adapter.applyOverlay('mc-classes', '.a { color: red }', { incremental: true })
    adapter.applyOverlay('mc-classes', '.a { color: blue }', { incremental: true })
    adapter.applyOverlay('plain', '.x { top: 0 }')
    await new Promise((resolve) => setTimeout(resolve, 0))
    observer.disconnect()
    const revisions = records.filter((r) => r.type === 'attributes' && r.attributeName === OVERLAY_REVISION_ATTR)
    expect(revisions.length).toBeGreaterThanOrEqual(1)
    expect(records.some((r) => r.type === 'childList' || r.type === 'characterData')).toBe(true)
  })

  it('a non-incremental overlay still gets its text, and removeOverlay forgets a patched one', () => {
    const adapter = mount()
    adapter.applyOverlay('plain', '.x { top: 0 }')
    expect(overlayStyle('plain').textContent).toBe('.x { top: 0 }')
    adapter.applyOverlay('mc-classes', '.a { color: red }', { incremental: true })
    adapter.removeOverlay('mc-classes')
    expect(document.querySelector('[data-studio-overlay-id="mc-classes"]')).toBeNull()
    adapter.applyOverlay('mc-classes', '.b { color: red }', { incremental: true })
    expect(layerRules(overlayStyle('mc-classes')).map((rule) => (rule as CSSStyleRule).selectorText)).toEqual(['.b'])
  })

  it('rewrites the text, and says so, when the browser refuses a rule edit', () => {
    const adapter = mount()
    const probe = document.createElement('style')
    document.head.appendChild(probe)
    const proto = Object.getPrototypeOf(probe.sheet!) as { insertRule: (rule: string, index?: number) => number }
    const insertRule = proto.insertRule
    const warn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => void warnings.push(args)
    proto.insertRule = () => {
      throw new DOMException('refused', 'HierarchyRequestError')
    }
    try {
      adapter.applyOverlay('mc-classes', '.a { color: red }', { incremental: true })
    } finally {
      proto.insertRule = insertRule
      console.warn = warn
    }
    expect(overlayStyle('mc-classes').textContent).toBe('.a { color: red }')
    expect(warnings).toHaveLength(1)
    // Text mode is for good: the next edit is a plain rewrite, not another failed patch.
    adapter.applyOverlay('mc-classes', '.a { color: blue }', { incremental: true })
    expect(overlayStyle('mc-classes').textContent).toBe('.a { color: blue }')
  })

  it('an overlay that already has text stays in text mode', () => {
    const adapter = mount()
    adapter.applyOverlay('mc-classes', '.a { color: red }')
    adapter.applyOverlay('mc-classes', '.a { color: blue }', { incremental: true })
    expect(overlayStyle('mc-classes').textContent).toBe('.a { color: blue }')
  })

  it("a style engine that refuses every rule (no @layer) leaves the CSS as text, not as an empty sheet", () => {
    const adapter = mount()
    const css = '@layer user-authored { .a { color: red } }'
    adapter.applyOverlay('mc-classes', css, { incremental: true })
    expect(overlayStyle('mc-classes').textContent).toBe(css)
  })
})
