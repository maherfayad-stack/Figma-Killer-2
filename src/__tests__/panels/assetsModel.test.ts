import { beforeEach, describe, expect, it } from 'bun:test'
import {
  DEFAULT_ASSET_FAVORITES,
  composeLayoutsSection,
  dedupeAssetRefs,
  getSavedLayoutItems,
  getVisibleModuleItems,
  layoutPluginId,
  moduleAvailability,
  resolveAssetRefs,
  type ModuleInsertionContext,
  type RegistryModuleForAssets,
} from '@site/panels/AssetsPanel/assetsModel'
import type { SavedLayout } from '@core/layouts'
import { findCanvasViewportAtPoint } from '@site/canvas/canvasInsertionDrop'
import {
  ASSET_PREFS_STORAGE_KEY,
  readAssetPrefs,
  trackAssetInsert,
} from '@site/panels/AssetsPanel/assetsPrefs'

function mod(id: string, category: string, name = id): RegistryModuleForAssets {
  return { id, category, name, description: `${name} description` }
}

/**
 * A module that HAS an intrinsic spelling in a user's source — `base.container`
 * is a `<div>`, `base.text` a `<p>`. Only the field's presence is read by
 * `moduleAvailability`, so the stub returns a plausible tag and nothing more.
 */
function intrinsicMod(id: string, category: string, name = id): RegistryModuleForAssets {
  return { ...mod(id, category, name), sourceIntrinsic: () => ({ tag: 'div' }) }
}

/**
 * A module spelled in a user's source as an IMPORT — every design-system and
 * package component. Only the field's presence is read by `moduleAvailability`.
 * It used to be inferred from `category === 'Design System'`; design-system
 * modules now carry their purpose group as their category (Navigation,
 * Actions, …) and the spelling is asked for directly.
 */
function importedMod(id: string, category: string, name = id): RegistryModuleForInserter {
  return { ...mod(id, category, name), sourceImport: { name } }
}

const PAGE_CTX: ModuleInsertionContext = { isVCMode: false, activeVcId: null, isTemplate: false, hasOutlet: false }
const TEMPLATE_CTX: ModuleInsertionContext = { isVCMode: false, activeVcId: null, isTemplate: true, hasOutlet: false }
const VC_CTX: ModuleInsertionContext = { isVCMode: true, activeVcId: 'vc-1', isTemplate: false, hasOutlet: false }

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})

describe('assets model', () => {
  // The rule is "does this have an honest spelling in the user's source?",
  // not "is this a design-system component". A component answers yes by
  // being imported; `base.container` and `base.text` answer yes by being
  // intrinsic elements (`sourceIntrinsic`) — a `<div>` and a `<p>` need no
  // import, which is exactly what `insertJsxElement` writes when
  // `importSpecifier` is omitted. Everything else really is an editor
  // construct with no JSX to write, and stays hidden rather than offering an
  // insert that could only be refused. This rule is unconditional — Studio is
  // the only editor mode.
  it('shows design-system components AND intrinsic elements, hides editor-only blocks', () => {
    const modules = [
      mod('base.body', 'Layout'),
      intrinsicMod('base.container', 'Layout', 'Container'),
      mod('base.visual-component-ref', 'Components'),
      mod('base.slot-instance', 'Components'),
      intrinsicMod('base.text', 'Typography', 'Text'),
      mod('base.button', 'Interactive', 'Button'),
      mod('base.loop', 'Layout', 'Loop'),
      importedMod('alm.Button', 'Actions', 'Button'),
      importedMod('alm.Chip', 'Selection', 'Chip'),
    ]

    const pageModeIds = getVisibleModuleItems(modules, PAGE_CTX).map((item) => item.id)
    expect(pageModeIds).toEqual(['base.container', 'base.text', 'alm.Button', 'alm.Chip'])
  })

  // `base.slot-outlet` has no `sourceIntrinsic` of its own (it's an editor
  // construct, not a real JSX element), so the intrinsic-element gate above
  // hides it before its VC-mode-specific rule ever runs — even in VC mode.
  // Current, real production behavior; not something this test invents.
  it('hides base.slot-outlet even in VC mode — it has no honest source spelling', () => {
    const modules = [mod('base.slot-outlet', 'Components', 'Slot')]
    expect(getVisibleModuleItems(modules, VC_CTX)).toHaveLength(0)
  })

  it('keeps the content outlet visible but disabled outside an insertable template context', () => {
    // `base.outlet` itself has no `sourceIntrinsic` either, so it would be
    // fully hidden before ever reaching its own rule below (real production
    // behavior — content outlets are a CMS/template concept Studio doesn't
    // currently expose a picker entry for). Stub it as intrinsic here to
    // isolate and test the outlet-specific rule on its own terms.
    const outlet = intrinsicMod('base.outlet', 'CMS', 'Content Outlet')

    // Regular page: visible, disabled, reason explains the template requirement.
    const onPage = moduleAvailability(outlet, PAGE_CTX)
    expect(onPage.kind).toBe('disabled')

    // VC definition tree: disabled too — no matched content inside a component.
    const inVC = moduleAvailability(outlet, VC_CTX)
    expect(inVC.kind).toBe('disabled')

    // Template without an outlet: insertable.
    expect(moduleAvailability(outlet, TEMPLATE_CTX)).toEqual({ kind: 'insertable' })

    // Template that already has its outlet: disabled (one per document).
    const alreadyPlaced = moduleAvailability(outlet, { ...TEMPLATE_CTX, hasOutlet: true })
    expect(alreadyPlaced.kind).toBe('disabled')

    // Disabled items still appear in the item list, carrying the reason.
    const items = getVisibleModuleItems([outlet], PAGE_CTX)
    expect(items).toHaveLength(1)
    expect(items[0].disabledReason).toBeTruthy()

    // …and insertable contexts produce no disabledReason at all.
    expect(getVisibleModuleItems([outlet], TEMPLATE_CTX)[0].disabledReason).toBeUndefined()
  })

  it('deduplicates asset refs by kind and id while preserving first order', () => {
    expect(dedupeAssetRefs([
      { kind: 'module', id: 'base.text' },
      { kind: 'module', id: 'base.text' },
      { kind: 'savedLayout', id: 'user-layout-1' },
      { kind: 'module', id: 'base.image' },
      { kind: 'savedLayout', id: 'user-layout-1' },
    ])).toEqual([
      { kind: 'module', id: 'base.text' },
      { kind: 'savedLayout', id: 'user-layout-1' },
      { kind: 'module', id: 'base.image' },
    ])
  })

  it('resolves favorite refs against insertable items and skips missing refs', () => {
    const items = getVisibleModuleItems([
      intrinsicMod('base.container', 'Layout', 'Container'),
      intrinsicMod('base.text', 'Typography', 'Text'),
      intrinsicMod('base.image', 'Media', 'Image'),
    ], PAGE_CTX)

    const resolved = resolveAssetRefs([
      ...DEFAULT_ASSET_FAVORITES,
      { kind: 'module', id: 'base.missing' },
    ], items)

    expect(resolved.map((item) => item.id)).toEqual([
      'base.container',
      'base.text',
      'base.image',
    ])
  })
})

describe('asset preferences', () => {
  it('falls back to empty recents for corrupted localStorage', () => {
    localStorage.setItem(ASSET_PREFS_STORAGE_KEY, '{not valid json')

    expect(readAssetPrefs()).toEqual({ recent: [] })
  })

  it('records inserts most-recent-first and de-duplicates them', () => {
    trackAssetInsert({ kind: 'module', id: 'base.text' })
    trackAssetInsert({ kind: 'savedLayout', id: 'user-layout-1' })
    trackAssetInsert({ kind: 'module', id: 'base.text' })

    expect(readAssetPrefs()).toEqual({
      recent: [
        { kind: 'module', id: 'base.text' },
        { kind: 'savedLayout', id: 'user-layout-1' },
      ],
    })
  })
})

describe('canvas drop targeting', () => {
  it('finds the breakpoint viewport under the pointer instead of assuming the active frame', () => {
    const desktop = document.createElement('div')
    desktop.dataset.breakpointId = 'desktop'
    const mobile = document.createElement('div')
    mobile.dataset.breakpointId = 'mobile'

    desktop.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 300,
      width: 200,
      height: 300,
      toJSON: () => ({}),
    })
    mobile.getBoundingClientRect = () => ({
      x: 240,
      y: 0,
      left: 240,
      top: 0,
      right: 360,
      bottom: 300,
      width: 120,
      height: 300,
      toJSON: () => ({}),
    })

    document.body.append(desktop, mobile)

    expect(findCanvasViewportAtPoint(260, 100)).toBe(mobile)
    expect(findCanvasViewportAtPoint(120, 100)).toBe(desktop)
    expect(findCanvasViewportAtPoint(220, 100)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Layouts section composition (Saved · per-plugin) — every layout is a
// SavedLayout row; there are no code-defined presets.
// ---------------------------------------------------------------------------

function savedLayout(id: string, name: string): SavedLayout {
  return {
    id,
    name,
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.container',
        props: {},
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
    classes: {},
    createdAt: 0,
  }
}

describe('layouts section composition', () => {
  it('detects the owning plugin from the namespaced id', () => {
    expect(layoutPluginId(savedLayout('V1StGXR8_Z5jdHi6B-myT', 'Mine'))).toBeNull()
    expect(layoutPluginId(savedLayout('acme.kit/hero', 'Hero'))).toBe('acme.kit')
  })

  it('orders user layouts, then per-plugin groups (by display name) — with labels', () => {
    const saved = getSavedLayoutItems(
      [
        savedLayout('zzz.kit/footer', 'Footer'),
        savedLayout('user-layout-id1', 'My hero'),
        savedLayout('acme.kit/hero', 'Hero'),
      ],
      PAGE_CTX,
      [],
    )

    const { items, labelByKey } = composeLayoutsSection(saved, (pluginId) =>
      pluginId === 'acme.kit' ? 'Acme UI Kit' : null,
    )

    expect(items.map((i) => i.name)).toEqual(['My hero', 'Hero', 'Footer'])
    expect(labelByKey.get(items[0].key)).toBe('Saved')
    expect(labelByKey.get(items[1].key)).toBe('Acme UI Kit')
    // No display name registered → falls back to the plugin id.
    expect(labelByKey.get(items[2].key)).toBe('zzz.kit')
  })

  it('renders no labels when only the user group is present', () => {
    const saved = getSavedLayoutItems([savedLayout('user-layout-id1', 'My hero')], PAGE_CTX, [])
    const { items, labelByKey } = composeLayoutsSection(saved, () => null)
    expect(items).toHaveLength(1)
    expect(labelByKey.size).toBe(0)
  })

  it('yields an empty Layouts section on a fresh site (no presets leak in)', () => {
    const { items, labelByKey } = composeLayoutsSection([], () => null)
    expect(items).toHaveLength(0)
    expect(labelByKey.size).toBe(0)
  })
})
