/**
 * ConversationHistory — popover triggered by the chat-history button in
 * the AgentPanel header. Lists this user's conversations and exposes load,
 * delete, and "+ New" actions.
 *
 * Built on the shared `ContextMenu` primitive so positioning, dismiss
 * handling, and styling match the rest of the admin.
 *
 * ## Scoped to the open project (W10)
 *
 * A conversation belongs to one (account, project). The listing is asked for
 * with the open project's dir, so the server returns that project's threads
 * plus the ones that belong to NO project — every thread started before
 * project scoping existed, and every thread started with no project open.
 * Another project's threads are not returned at all: continuing one here is
 * precisely what the server refuses (409), so offering it would be offering
 * an action that cannot work.
 *
 * Those unscoped threads are still reachable — collapsed under "Not in this
 * project", not deleted from view — because they are as much this project's
 * history as anything else until their next turn adopts them. Opening one and
 * sending stamps it with the project it was continued in.
 *
 * With NO project open the list is flat: every thread comes back, and there is
 * no "this project" to group them against.
 */

import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import type { ConversationView } from '@admin/ai/api'
import { useAdminUi } from '@admin/state/adminUi'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { formatRelativeTime } from './relativeTime'
import styles from './AgentPanel.module.css'

export function ConversationHistory() {
  const conversations = useAgentStore((s) => s.agentConversations)
  const activeId = useAgentStore((s) => s.agentConversationId)
  const loadAgentConversations = useAgentStore((s) => s.loadAgentConversations)
  const loadAgentConversation = useAgentStore((s) => s.loadAgentConversation)
  const startNewAgentConversation = useAgentStore((s) => s.startNewAgentConversation)
  const deleteAgentConversation = useAgentStore((s) => s.deleteAgentConversation)
  const isStreaming = useAgentStore((s) => s.isAgentStreaming)
  const conversationPending = useAgentStore((s) => s.isAgentConversationPending)
  const providerPending = useAgentStore((s) => s.isAgentProviderPending)
  const controlsDisabled = isStreaming || conversationPending || providerPending
  const projectOpen = useAdminUi((s) => s.studioProject !== null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [otherExpanded, setOtherExpanded] = useState(false)

  // Refresh the list every time the popover opens. Cheap query.
  useEffect(() => {
    if (!open) return
    void loadAgentConversations()
  }, [open, loadAgentConversations])

  // In a scoped listing a non-null key can only ever be THIS project's — the
  // server never returns another project's rows — so the split needs no
  // knowledge of the key itself. With no project open there is nothing to
  // split against, and everything renders as one list.
  const projectThreads = projectOpen ? conversations.filter((c) => c.projectKey !== null) : conversations
  const otherThreads = projectOpen ? conversations.filter((c) => c.projectKey === null) : []

  function openConversation(id: string): void {
    if (id !== activeId) void loadAgentConversation(id)
    setOpen(false)
  }

  function renderRow(conv: ConversationView) {
    return (
      <ConversationRow
        key={conv.id}
        conversation={conv}
        active={conv.id === activeId}
        disabled={controlsDisabled}
        onOpen={() => openConversation(conv.id)}
        onDelete={() => void deleteAgentConversation(conv.id)}
      />
    )
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        disabled={controlsDisabled}
        onClick={() => setOpen((v) => !v)}
        tooltip="Chat history"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Conversation history"
      >
        <BulletlistSolidIcon size={14} />
      </Button>
      {open && (
        <ContextMenu
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="start"
          side="auto"
          offset={6}
          minWidth={260}
          maxHeight={360}
          ariaLabel="Conversation history"
          onClose={() => setOpen(false)}
        >
          <ContextMenuItem
            disabled={controlsDisabled}
            onClick={() => {
              startNewAgentConversation()
              setOpen(false)
            }}
          >
            <PlusIcon size={12} aria-hidden="true" />
            <span>New chat</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {projectThreads.length === 0 ? (
            <ContextMenuItem disabled>
              <span>{projectOpen ? 'No chats in this project yet.' : 'No chats yet.'}</span>
            </ContextMenuItem>
          ) : (
            projectThreads.map(renderRow)
          )}
          {otherThreads.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                aria-expanded={otherExpanded}
                onClick={() => setOtherExpanded((v) => !v)}
              >
                {otherExpanded
                  ? <ChevronDownIcon size={12} aria-hidden="true" />
                  : <ChevronRightIcon size={12} aria-hidden="true" />}
                <span className={styles.historyItemTitle}>Not in this project</span>
                <span className={styles.historyGroupCount}>{otherThreads.length}</span>
              </ContextMenuItem>
              {otherExpanded && otherThreads.map(renderRow)}
            </>
          )}
        </ContextMenu>
      )}
    </>
  )
}

interface ConversationRowProps {
  conversation: ConversationView
  active: boolean
  disabled: boolean
  onOpen: () => void
  onDelete: () => void
}

function ConversationRow({ conversation, active, disabled, onOpen, onDelete }: ConversationRowProps) {
  return (
    <ContextMenuItem
      role="menuitemradio"
      aria-checked={active}
      active={active}
      disabled={disabled}
      onClick={onOpen}
    >
      <span className={styles.historyItemTitle}>{conversation.title}</span>
      <span className={styles.historyItemMeta}>
        <span className={styles.historyItemTime}>
          {formatRelativeTime(Date.parse(conversation.updatedAt))}
        </span>
        {/* Span (not a native button) so it doesn't nest inside the
            ContextMenuItem's Button — nested interactive elements are
            invalid HTML + would trip BTN-3. */}
        <span
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          className={styles.historyItemDelete}
          aria-label={`Delete chat "${conversation.title}"`}
          onClick={(e) => {
            e.stopPropagation()
            if (disabled) return
            onDelete()
          }}
          onKeyDown={(e) => {
            if (disabled) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onDelete()
            }
          }}
        >
          <TrashSolidIcon size={12} aria-hidden="true" />
        </span>
      </span>
    </ContextMenuItem>
  )
}
