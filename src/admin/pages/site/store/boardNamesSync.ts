/**
 * boardNamesSync - a page's title and a node's label, derived from the board.
 *
 * `renamePageOnBoard` / `renameLayerOnBoard` (`slices/boardNameActions.ts`)
 * write a name into `boards` (`pageNames`, `layerNames`) and nowhere else. The
 * site document is what the panels and the canvas read, though, and it is
 * replaced wholesale by every load and re-read (a page comes back from the
 * server with its file name as its title and no labels). This module is the one
 * place the two meet: whenever the pages or the boards change it makes the
 * titles and labels agree with the names the board holds.
 *
 * It owns ONLY what it put there. A label some other path set (a fresh
 * Frame or Group the editor named) is left alone, and a name that is taken away
 * (an undo, an emptied rename) is taken off by putting back exactly what was
 * under it. The writes are plain `setState`s - not history entries, not dirty
 * marks - because they are not edits: the edit was the board change that
 * caused them, and it already has its undo entry and its autosave.
 *
 * Cost: nothing while no name exists and none has been applied; otherwise one
 * pass over the named entries (O(entries), each an O(1) id check unless an
 * edit has moved the element and the structural path is walked).
 */
import { resolveLayerNameTarget } from '@core/studio-board'
import type { EditorStore } from './types'

interface StoreApi {
  getState: () => EditorStore
  setState: (recipe: (draft: EditorStore) => void) => void
  subscribe: (listener: (state: EditorStore, previous: EditorStore) => void) => unknown
}

/** pageId -> (nodeId -> the label this module put there). */
let appliedLabels = new Map<string, Map<string, string>>()
/** pageId -> the title it replaced and the one it put there. */
let appliedTitles = new Map<string, { original: string; applied: string }>()

/** Forget everything applied - test isolation only, paired with the store reset. */
export function resetBoardNamesSync(): void {
  appliedLabels = new Map()
  appliedTitles = new Map()
}

interface PagePatch {
  pageIndex: number
  title?: string
  labels: Array<{ nodeId: string; label: string | undefined }>
}

function sync(api: StoreApi): void {
  const { site, boards } = api.getState()
  if (!site) return
  const { pageNames, layerNames } = boards
  if (!pageNames && !layerNames && appliedLabels.size === 0 && appliedTitles.size === 0) return

  const patches: PagePatch[] = []
  site.pages.forEach((page, pageIndex) => {
    const patch: PagePatch = { pageIndex, labels: [] }

    const desiredTitle = pageNames?.[page.id]
    const tracked = appliedTitles.get(page.id)
    if (desiredTitle !== undefined) {
      if (page.title !== desiredTitle) {
        appliedTitles.set(page.id, { original: page.title, applied: desiredTitle })
        patch.title = desiredTitle
      }
    } else if (tracked) {
      appliedTitles.delete(page.id)
      if (page.title === tracked.applied) patch.title = tracked.original
    }

    const wanted = new Map<string, string>()
    for (const entry of layerNames ?? []) {
      if (entry.pageId !== page.id) continue
      const nodeId = resolveLayerNameTarget(page, entry.hint)
      if (nodeId !== null) wanted.set(nodeId, entry.name)
    }
    const previous = appliedLabels.get(page.id)
    for (const [nodeId, name] of wanted) {
      if (page.nodes[nodeId]?.label !== name) patch.labels.push({ nodeId, label: name })
    }
    for (const [nodeId, name] of previous ?? []) {
      if (!wanted.has(nodeId) && page.nodes[nodeId]?.label === name) patch.labels.push({ nodeId, label: undefined })
    }
    if (wanted.size > 0) appliedLabels.set(page.id, wanted)
    else appliedLabels.delete(page.id)

    if (patch.title !== undefined || patch.labels.length > 0) patches.push(patch)
  })
  if (patches.length === 0) return

  api.setState((draft) => {
    for (const { pageIndex, title, labels } of patches) {
      const page = draft.site?.pages[pageIndex]
      if (!page) continue
      if (title !== undefined) page.title = title
      for (const { nodeId, label } of labels) {
        const node = page.nodes[nodeId]
        if (!node) continue
        if (label === undefined) delete node.label
        else node.label = label
      }
    }
  })
}

/** Keep titles and labels in step with the board's names. Call once, after the store exists. */
export function bindBoardNamesSync(api: StoreApi): void {
  api.subscribe((state, previous) => {
    if (state.site?.pages !== previous.site?.pages || state.boards !== previous.boards) sync(api)
  })
}
