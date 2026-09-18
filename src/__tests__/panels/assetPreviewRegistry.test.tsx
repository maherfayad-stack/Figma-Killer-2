/**
 * Every palette-visible module must produce a preview without throwing.
 *
 * This is the gate that catches the failure mode DS-5 introduces: a card is a
 * LIVE render of a real component with its real seeded props, so a component
 * whose defaults are wrong now fails visibly — as a blank or errored tile that
 * a human has to notice. This notices first.
 *
 * It also pins the containment rule: after a whole panel of cards has mounted,
 * the admin document must still carry no design-system rule. That sheet uses
 * unprefixed class names (`.btn`, `.card`); if it ever reached the document it
 * would restyle the editor around it.
 *
 * One honest limitation: happy-dom has `attachShadow` but no constructable
 * `CSSStyleSheet`, so `designSystemPreviewSheet()` degrades to `null` here and
 * there is no sheet to leak in the first place. What this file DOES prove is
 * that every component renders, and that mounting the panel injects nothing
 * into `document.styleSheets` — the two ways the containment could break from
 * this side. Whether the adopted sheet itself is correctly scoped is the
 * `assetPreviewCss` unit test's job, plus the human dogfood.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { registry } from '@core/module-engine'
import type { AnyModuleDefinition } from '@core/module-engine'
import { AssetPreview } from '@site/panels/AssetsPanel/AssetPreview'
import { getVisibleModuleItems } from '@site/panels/AssetsPanel/assetsModel'
import { AssetsPanel } from '@site/panels/AssetsPanel'
import { useEditorStore } from '@site/store/store'
import { __resetAssetFavoritesForTests } from '@site/panels/AssetsPanel/assetsPrefs'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'
import '@modules/alm/register'

const originalFetch = globalThis.fetch

const PAGE_CONTEXT = {
  isVCMode: false,
  activeVcId: null,
  isTemplate: false,
  hasOutlet: false,
} as const

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  localStorage.clear()
  __resetAssetFavoritesForTests()
  globalThis.fetch = mock(async () => jsonResponse({ value: null })) as typeof fetch
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

function visibleModules(): AnyModuleDefinition[] {
  return getVisibleModuleItems(registry.list(), PAGE_CONTEXT).map((item) => item.module)
}

describe('asset previews — every palette-visible module', () => {
  it('has something to preview at all', () => {
    // A guard on the guard: if `moduleAvailability` ever hid everything, the
    // per-module loop below would silently assert nothing.
    expect(visibleModules().length).toBeGreaterThan(0)
  })

  for (const mod of visibleModules()) {
    it(`renders ${mod.id} without throwing`, () => {
      const [item] = getVisibleModuleItems([mod], PAGE_CONTEXT)
      expect(item).toBeTruthy()

      const { container } = render(<AssetPreview item={item} />)

      // Rendered SOMETHING — an empty container would mean the card is blank.
      expect(container.firstElementChild).toBeTruthy()
      // …and it is not the error boundary's fallback.
      expect(container.textContent).not.toBe(`${mod.name} (render error)`)
    })
  }
})

describe('asset previews — containment', () => {
  it('never lets a design-system rule into the admin document', () => {
    const before = countDocumentRules()

    useEditorStore.setState({
      site: makeSite({
        pages: [
          makePage({
            id: 'page-home',
            rootNodeId: 'root-home',
            nodes: { 'root-home': makeNode({ id: 'root-home', moduleId: 'base.body' }) },
          }),
        ],
        files: [],
        visualComponents: [],
      }),
      activePageId: 'page-home',
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<AssetsPanel />)

    // The design system's own class names are unprefixed — if its sheet had
    // been adopted by the document instead of by each card's shadow root,
    // rules like `.btn` would now be in `document.styleSheets`.
    const documentCss = readDocumentCss()
    expect(documentCss).not.toMatch(/(^|[\s,{])\.btn\b/)
    expect(documentCss).not.toContain(':root{--color-')
    expect(countDocumentRules()).toBe(before)
  })
})

/** Every rule text the admin document currently carries, concatenated. */
function readDocumentCss(): string {
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      // A cross-origin sheet cannot be read; it also cannot be one of ours.
      continue
    }
    for (const rule of Array.from(rules)) parts.push(rule.cssText)
  }
  return parts.join('\n')
}

function countDocumentRules(): number {
  return readDocumentCss().split('\n').length
}
