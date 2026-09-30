/**
 * The editor state the Agent panel's context chips read (AI-28): the page on
 * screen, the selection and its display name, and the open review comments.
 *
 * Read from the site editor's store directly — the panel only ever mounts
 * there (`LeftSidebar.tsx`) — through selectors that each return a primitive,
 * so a hover, a pan or an unrelated edit re-renders nothing here (the
 * selection travels as one joined string for the same reason).
 */
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { EditorStore } from '@site/store/types'
import type { AgentLiveContext } from './agentContext'

/** Joins the selection into one primitive a selector can return; ids never contain NUL. */
const SEPARATOR = String.fromCharCode(0)

function selectActivePageTitle(state: EditorStore): string | null {
  const pages = state.site?.pages
  if (!pages || !state.activePageId) return null
  for (const page of pages) {
    if (page.id === state.activePageId) return page.title
  }
  return null
}

function selectPrimaryLabel(state: EditorStore): string | null {
  const primary = state.selectedNodeIds.at(-1) ?? state.selectedNodeId
  const pages = state.site?.pages
  if (!primary || !pages) return null
  for (const page of pages) {
    const node = page.nodes[primary]
    if (node) return getNodeDisplayName(node, registry.get(node.moduleId), state.site?.visualComponents)
  }
  return null
}

function selectOpenCommentCount(state: EditorStore): number {
  let open = 0
  for (const thread of state.comments.threads) if (!thread.resolved) open += 1
  return open
}

function selectSelectionJoined(state: EditorStore): string {
  if (state.selectedNodeIds.length > 0) return state.selectedNodeIds.join(SEPARATOR)
  return state.selectedNodeId ?? ''
}

export function useAgentLiveContext(): AgentLiveContext {
  const activePageTitle = useEditorStore(selectActivePageTitle)
  const primaryLabel = useEditorStore(selectPrimaryLabel)
  const openCommentCount = useEditorStore(selectOpenCommentCount)
  const joined = useEditorStore(selectSelectionJoined)
  const selectedNodeIds = joined.length > 0 ? joined.split(SEPARATOR) : []
  return { activePageTitle, selectedNodeIds, primaryLabel, openCommentCount }
}
