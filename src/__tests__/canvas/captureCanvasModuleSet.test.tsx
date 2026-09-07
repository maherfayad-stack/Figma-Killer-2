/**
 * The PNG-export defect: exporting a page whose source uses the design system
 * came back with every component drawn as the dashed
 * `Unknown module: alm.Button` placeholder, while the SAME page rendered its
 * buttons correctly on the editor canvas one tab over.
 *
 * The cause was not the renderer — it was the module SET. `NodeRenderer`
 * resolves every node through the global registry, and the headless capture
 * page (`src/admin/agentCapture/`) is a separate Vite entry that inherits
 * nothing from the editor's imports. It listed `@modules/base` and stopped;
 * the editor listed base + `@modules/alm/register` + `@core/loops/sources` and
 * additionally mounted `useRegisterProjectModules` for the project's own
 * `pkg.*` components. Two independently maintained lists, one of which was
 * short.
 *
 * So the assertion here is deliberately about the SHARED entry
 * (`canvasModuleSet.ts`) rather than about `CaptureApp` itself: this file
 * imports exactly what the capture entry imports — nothing else, and in
 * particular NOT `@modules/alm/register` — and then renders a real page
 * through the real `CanvasComposedTree`. If anyone ever removes a pack from
 * that file, or re-adds a second list next to it, this goes red.
 *
 * `data-studio-unknown-module` is `NodeRenderer`'s own stable marker for the
 * failure (see its unregistered-module branch); the test asserts on that
 * attribute rather than on the visible copy, which is chrome text and may be
 * reworded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { registry } from '@core/module-engine'
import { CanvasComposedTree } from '@site/canvas/CanvasComposedTree'
import { CanvasPageContext } from '@site/canvas/CanvasContexts'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

// THE import under test — the same one `src/admin/agentCapture/main.tsx`
// makes, and the only module-registering import in this file.
import '@site/studio/canvasModuleSet'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  cleanup()
  resetStore()
})

afterEach(() => {
  cleanup()
  resetStore()
})

/** A page shaped like the real `Onboarding.tsx`: a body with a design-system button in it. */
function makeDesignSystemPage() {
  return makePage({
    id: 'onboarding',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['btn'] }),
      btn: makeNode({ id: 'btn', moduleId: 'alm.Button', props: { label: 'Continue' } }),
    },
  })
}

describe('the capture page renders the same module set as the editor canvas', () => {
  it('registers the built-in design-system pack, not just base', () => {
    // The direct statement of the bug: `alm.*` was absent from the capture
    // bundle's registry entirely.
    expect(registry.get('base.text')).toBeDefined()
    expect(registry.get('alm.Button')).toBeDefined()
  })

  it('renders an alm.* node as the real component, not the unknown-module placeholder', () => {
    const page = makeDesignSystemPage()
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    const { container } = render(
      <CanvasPageContext.Provider value={page.id}>
        <CanvasComposedTree page={page} />
      </CanvasPageContext.Provider>,
    )

    expect(container.querySelector('[data-studio-unknown-module]')).toBeNull()
    // The node rendered SOMETHING of its own — `alm.Button` puts a real
    // `<button>` in the tree. A registered-but-erroring module would have been
    // caught by the pack's error boundary and produced no button either.
    expect(container.querySelector('[data-node-id="btn"] button, button[data-node-id="btn"]')).not.toBeNull()
  })
})
