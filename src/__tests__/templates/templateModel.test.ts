import { beforeEach, describe, expect, it } from 'bun:test'
import { makeSite } from '../fixtures'
import { validateSite, validatePages } from '@core/persistence/validate'
import { useEditorStore } from '@site/store/store'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('dynamic template model', () => {
  beforeEach(resetStore)

  it('preserves page template metadata and structured dynamic bindings', () => {
    const site = makeSite()
    const page = site.pages[0]
    const root = page.nodes[page.rootNodeId]
    page.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 100 }
    root.props = { text: 'Static fallback' }
    root.dynamicBindings = {
      text: { source: 'currentEntry', field: 'title', format: 'plain', fallback: 'static' },
    }

    const shell = validateSite(site)
    const pages = validatePages(shell, site.pages)

    // Template metadata round-trips unchanged.
    expect(pages[0].template).toEqual(page.template)
    const migrated = pages[0].nodes[page.rootNodeId]
    expect(migrated.dynamicBindings?.text).toEqual({
      source: 'currentEntry',
      field: 'title',
      format: 'plain',
      fallback: 'static',
    })
    expect(migrated.props.text).toBe('Static fallback')
  })

  it('converts a template back to a page by removing template metadata and all bindings', () => {
    const site = makeSite()
    const page = site.pages[0]
    const root = page.nodes[page.rootNodeId]
    page.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 100 }
    root.dynamicBindings = {
      text: { source: 'currentEntry', field: 'title' },
    }

    useEditorStore.setState({
      site,
      activePageId: page.id,
      activeDocument: { kind: 'page', pageId: page.id },
      hasUnsavedChanges: false,
    })
    useEditorStore.getState().convertTemplateToPage(page.id)

    const nextPage = useEditorStore.getState().site?.pages[0]
    expect(nextPage?.template).toBeUndefined()
    expect(nextPage?.nodes[page.rootNodeId].dynamicBindings).toBeUndefined()
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(true)
  })

  // The store actions that CREATED a binding (`setNodeDynamicBinding` /
  // `clearNodeDynamicBinding`) were removed with the rest of the "Bind to data
  // field" authoring surface — see `board-12` in STATE.md. The cases above stay
  // because they cover the other half, which is deliberately kept: a page tree
  // that ALREADY holds `dynamicBindings` still round-trips through validation
  // and still has them dropped when a template is converted back to a page.
})
