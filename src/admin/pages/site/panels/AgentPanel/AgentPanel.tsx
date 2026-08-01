/**
 * AgentPanel — self-contained floating AI assistant panel (Guideline #410).
 *
 * This component renders its own floating overlay container — positioned at
 * bottom-right of the canvas area. Visibility is controlled by `isAgentOpen`
 * in the agentSlice. Always-mounted (CSS display:none when closed) to preserve
 * Zustand conversation state across open/close cycles.
 *
 * Runtime model:
 * - Agent calls stream through `/admin/api/ai/chat`.
 * - The Bun server selects the configured provider credential and model.
 * - Drivers call provider REST/SSE endpoints directly; no provider SDK runs.
 *
 * Accessibility (WCAG 2.1 AA):
 * - role="complementary" + aria-label="AI Assistant" on the panel landmark
 * - role="log" + aria-live="polite" on the message thread
 * - role="alert" for error messages
 * - role="status" for tool call status badges
 * - keyboard: Escape closes the panel
 *
 * @see Guideline #410 — 3 Self-Contained Independent Panels
 */

import { useRef, useEffect, useState } from 'react'
import { useAgentStore, useAgentStoreApi } from '@admin/ai/useAgentStore'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { getClaudeCliStatus, listCredentials, type ClaudeCliStatus } from '@admin/ai/api'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { useDraggablePanel } from '@admin/shared/FloatingWindow'
import { cn } from '@ui/cn'
import { ConversationHistory } from './ConversationHistory'
import { AgentComposer, type ComposerLockReason } from './AgentComposer'
import { AgentImageContextMenu } from './AgentImageContextMenu'
import { AgentImagePreview } from './AgentImagePreview'
import type { AgentImageMenuRequest, AgentPreviewImage } from './agentImageTypes'
import { MessageBubble } from './MessageBubble'
import { AgentActivity } from './AgentActivity'
import { groupConsecutiveMessages } from './conversationGroups'
import styles from './AgentPanel.module.css'

const PANEL_WIDTH = 320
const PANEL_HEIGHT = 480
const AI_SETTINGS_ROUTE = '/admin/ai'
type PanelVariant = 'floating' | 'docked'

// ---------------------------------------------------------------------------
// AgentPanel
// ---------------------------------------------------------------------------

/**
 * AgentPanel — all store subscriptions, refs, effects, and render logic.
 *
 * Always-mounted by EditorLayout — visibility is controlled via CSS display:none
 * (`.floatPanelClosed`) to preserve Zustand conversation state across open/close cycles.
 * Agent routes via Vite proxy `/admin/api/agent` → local Bun server → Claude SDK.
 */
export function AgentPanel({ variant = 'floating' }: { variant?: PanelVariant }) {
  const agentStore = useAgentStoreApi()
  const isOpen = useAgentStore((s) => s.isAgentOpen)
  const isStreaming = useAgentStore((s) => s.isAgentStreaming)
  const conversationPending = useAgentStore((s) => s.isAgentConversationPending)
  const providerPending = useAgentStore((s) => s.isAgentProviderPending)
  const messages = useAgentStore((s) => s.agentMessages)
  const agentError = useAgentStore((s) => s.agentError)
  const closeAgent = useAgentStore((s) => s.closeAgent)
  const startNewAgentConversation = useAgentStore((s) => s.startNewAgentConversation)
  const loadStudioDefault = useAgentStore((s) => s.loadStudioDefault)
  const composerEpoch = useAgentStore((s) => s.agentComposerEpoch)
  const activeCredentialId = useAgentStore((s) => s.agentActiveCredentialId)
  const activeModelId = useAgentStore((s) => s.agentActiveModelId)
  const [previewImage, setPreviewImage] = useState<AgentPreviewImage | null>(null)
  const [imageMenu, setImageMenu] = useState<AgentImageMenuRequest | null>(null)
  const credentialsResource = useAsyncResource(
    (signal) => listCredentials(signal),
    [],
    { swallowErrors: true },
  )
  const credentials = credentialsResource.data ?? []
  const credentialsLoaded = credentialsResource.data !== null || !credentialsResource.loading
  const noCredentials = credentialsLoaded && credentials.length === 0
  const noProviderError = agentError?.startsWith('No AI provider configured') ?? false

  // "Is there a usable provider?", not "does a credential row exist?" — a
  // `claudeCli` host that's logged in (WS-11 §3 P2: the terminal "Log in
  // with Claude" flow stores no row at all, by design) is a real, almost-
  // ready provider, not nothing. Zero-cost, no-model-call probe
  // (`claude auth status --json` via the same endpoint `ProvidersTab.tsx`
  // polls) — swallowed on failure, same as the credentials fetch above.
  // This refines the EMPTY-STATE MESSAGING (a genuinely dead "no provider
  // configured" screen vs. a specific, one-step-away next action); it does
  // NOT unlock sending — `chat.ts` still resolves a turn's provider through
  // a stored `ai_provider_credentials` row (`conversation.credentialId`),
  // and `ModelPicker` has no credential-less option to pick. Wiring an
  // actual ambient-claudeCli send path is a separate, larger change (a new
  // dispatch shape in `chat.ts` + a synthetic picker entry), not attempted
  // here.
  const [claudeCliStatus, setClaudeCliStatus] = useState<ClaudeCliStatus | null>(null)
  useEffect(() => {
    if (!noCredentials) return
    let cancelled = false
    void getClaudeCliStatus()
      .then((status) => {
        if (!cancelled) setClaudeCliStatus(status)
      })
      .catch(() => {
        /* swallow — empty state falls back to the generic copy */
      })
    return () => {
      cancelled = true
    }
  }, [noCredentials])
  const claudeCliLoggedIn = claudeCliStatus?.availability === 'logged-in'
  // The composer can't run a turn without an active (credential, model) — one
  // is either preloaded from Studio's default or picked in the model picker.
  // Locking off `hasActiveProvider` (not a sticky error string) is what keeps
  // the composer usable the instant the user picks a model.
  const hasActiveProvider = Boolean(activeCredentialId && activeModelId)
  const composerLocked = !hasActiveProvider
  // Why the composer is locked, used for the empty-state + placeholder copy:
  //   'setup'       → no credentials exist at all → add one in AI settings.
  //   'chooseModel' → credentials exist but no default / pick yet →
  //                   choose a model below, or set a default in AI settings.
  // While credentials are still loading we keep messaging neutral (null) so
  // the panel doesn't flash a setup prompt before the default preload lands.
  const lockReason: ComposerLockReason | null = !composerLocked
    ? null
    : noCredentials
      ? 'setup'
      : credentialsLoaded
        ? 'chooseModel'
        : null

  const threadRef = useRef<HTMLDivElement>(null)

  // ── Draggable panel position ───────────────────────────────────────────────
  // Default to bottom-right corner.
  const { setPanelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    'agent',
    () => ({
      x: typeof window !== 'undefined' ? window.innerWidth - PANEL_WIDTH - 16 : 16,
      y: typeof window !== 'undefined'
        ? window.innerHeight - PANEL_HEIGHT - 16
        : 200,
    }),
  )

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Preload Studio's default credential + model when the panel opens, so the
  // picker shows the configured default immediately and the first send uses
  // it. The action no-ops if a conversation or explicit pick already exists,
  // so re-opens are cheap.
  useEffect(() => {
    if (isOpen) void loadStudioDefault()
  }, [isOpen, loadStudioDefault])

  useEffect(() => agentStore.subscribe((state, previous) => {
    if (
      (previous.isAgentOpen && !state.isAgentOpen)
      || previous.agentComposerEpoch !== state.agentComposerEpoch
    ) {
      setPreviewImage(null)
      setImageMenu(null)
    }
  }), [agentStore])

  function openImageMenu(request: AgentImageMenuRequest): void {
    setImageMenu(request)
  }

  function openImagePreview(image: AgentPreviewImage): void {
    setImageMenu(null)
    setPreviewImage(image)
  }

  function closeImageMenu(): void {
    const returnFocus = imageMenu?.returnFocus
    setImageMenu(null)
    if (returnFocus?.isConnected) {
      requestAnimationFrame(() => returnFocus.focus())
    }
  }

  function closeImagePreview(): void {
    setPreviewImage(null)
    setImageMenu(null)
  }

  // Escape key — close the AI panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || imageMenu !== null) return
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault()
        closeAgent()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, imageMenu, closeAgent])

  // Always-mounted: CSS display:none when closed (via .floatPanelClosed) preserves
  // Zustand state across open/close cycles without conditional rendering.
  return (
    <aside
      ref={setPanelRef}
      role="complementary"
      aria-label="AI Assistant"
      data-panel=""
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      // Panel position is drag-driven — CSS var injection from useDraggablePanel
      style={variant === 'floating' ? panelPositionStyle : undefined}
      className={cn(
        styles.floatPanel,
        variant === 'docked' && styles.floatPanelDocked,
        !isOpen && styles.floatPanelClosed,
      )}
    >
    <div
      data-testid="agent-panel"
      className={styles.panel}
    >
      {/* ── Shared Panel Header — drag handle + close + clear actions ──────── */}
      <PanelHeader
        panelId="agent"
        title="AI Assistant"
        onClose={closeAgent}
        dragHandleProps={variant === 'floating' ? headerDragProps : undefined}
      >
        {/* History popover — list past chats, start a new one, delete. */}
        <ConversationHistory />
        {/* "New chat" — start a fresh conversation directly from the header. */}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          disabled={isStreaming || conversationPending || providerPending}
          onClick={startNewAgentConversation}
          tooltip="New chat"
          aria-label="New chat"
          data-testid="agent-new-chat-header-button"
        >
          <EditSolidIcon size={14} />
        </Button>
        {/* "AI settings" — always available; routes to /admin/ai. */}
        <AgentSettingsButton
          variant="header"
          label="AI settings"
          data-testid="agent-settings-header-button"
        />
      </PanelHeader>

      {/* ── Message thread ──────────────────────────────────────────────────── */}
      <div
        ref={threadRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions text"
        aria-label="Conversation"
        aria-busy={isStreaming}
        className={styles.thread}
      >
        {messages.length === 0 ? (
          <AgentEmptyState mode={lockReason ?? 'prompt'} claudeCliLoggedIn={claudeCliLoggedIn} />
        ) : (
          <>
            {lockReason && <AgentCredentialAlert mode={lockReason} claudeCliLoggedIn={claudeCliLoggedIn} />}
            {groupConsecutiveMessages(messages).map((group) => (
              <MessageBubble
                key={group.id}
                group={group}
                onOpenImage={openImagePreview}
                onOpenImageMenu={openImageMenu}
              />
            ))}
            {/* Live "what am I doing" strip, under the turn it describes. The
                streaming turn is always the last message — the store pushes
                the assistant placeholder with the user's message and fills it
                in as events arrive. */}
            {isStreaming && <AgentActivity message={messages.at(-1) ?? null} />}
          </>
        )}

        {/* Generic error banner — only show when it's NOT the dedicated
            no-credential message (which renders via the setup empty state). */}
        {agentError && !noProviderError && (
          <div role="alert" className={styles.errorBanner}>
            {agentError}
          </div>
        )}
      </div>

      <AgentComposer
        key={composerEpoch}
        composerLocked={composerLocked}
        lockReason={lockReason}
        credentials={credentials}
        credentialsLoaded={credentialsLoaded}
        onRefreshCredentials={credentialsResource.refresh}
        onOpenImage={openImagePreview}
        onOpenImageMenu={openImageMenu}
      />
    </div>
      <AgentImagePreview
        image={isOpen ? previewImage : null}
        imageMenuOpen={imageMenu !== null}
        onOpenImageMenu={openImageMenu}
        onClose={closeImagePreview}
      />
      {isOpen && imageMenu && (
        <AgentImageContextMenu request={imageMenu} onClose={closeImageMenu} />
      )}
    </aside>
  )
}


// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function AgentEmptyState({
  mode,
  claudeCliLoggedIn = false,
}: {
  mode: ComposerLockReason | 'prompt'
  /** Claude Code is logged in on this host but has no stored credential yet — a specific, one-step-away state, not a dead end. See `AgentPanel`'s own doc comment on the `claudeCliStatus` fetch. */
  claudeCliLoggedIn?: boolean
}) {
  if (mode === 'setup') {
    return (
      <EmptyState
        variant="centered"
        size="large"
        role="alert"
        icon={<AiSettingsSolidIcon size={34} />}
        title={claudeCliLoggedIn ? 'Finish setting up Claude Code' : 'Connect an AI provider'}
        description={claudeCliLoggedIn
          ? 'Claude Code is logged in on this device. Add it as a credential in AI settings to start chatting.'
          : 'Add a provider credential, then choose a default model before starting a chat.'}
        action={<AgentSettingsButton variant="emptyState" label="Open AI settings" />}
      />
    )
  }

  if (mode === 'chooseModel') {
    return (
      <EmptyState
        variant="centered"
        size="large"
        role="alert"
        icon={<AiSettingsSolidIcon size={34} />}
        title="Choose a model to get started"
        description="Pick a model below, or set a default in AI settings so it's ready every time you open this chat."
        action={<AgentSettingsButton variant="emptyState" label="Set a default in AI settings" />}
      />
    )
  }

  return (
    <EmptyState
      variant="centered"
      size="large"
      icon={<AiBoxSolidIcon size={28} color="var(--text-disabled)" />}
      title="Describe what you want to build and I'll do it for you."
      description={'Try: "Add a hero section with a heading and button"'}
    />
  )
}

function AgentCredentialAlert({
  mode,
  claudeCliLoggedIn = false,
}: {
  mode: ComposerLockReason
  claudeCliLoggedIn?: boolean
}) {
  return (
    <div role="alert" className={styles.credentialAlert}>
      <p className={styles.credentialAlertText}>
        {mode === 'setup'
          ? claudeCliLoggedIn
            ? 'Claude Code is logged in on this device — add it as a credential in AI settings.'
            : 'No AI provider credentials are configured yet.'
          : 'Choose a model below, or set a default in AI settings.'}
      </p>
      <AgentSettingsButton
        variant="inline"
        label={mode === 'setup' ? 'Open AI settings' : 'Set a default'}
      />
    </div>
  )
}

function AgentSettingsButton({
  variant,
  label,
  'data-testid': testId,
}: {
  variant: 'header' | 'emptyState' | 'inline'
  label: string
  'data-testid'?: string
}) {
  const navigate = useAdminNavigate()

  function openAiSettings() {
    navigate(AI_SETTINGS_ROUTE)
  }

  if (variant === 'header') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        onClick={openAiSettings}
        tooltip={label}
        aria-label={label}
        data-testid={testId}
        className={styles.credentialSettingsButtonHeader}
      >
        <AiSettingsSolidIcon size={14} aria-hidden="true" />
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size={variant === 'emptyState' ? 'md' : 'sm'}
      onClick={openAiSettings}
      aria-label={label}
      data-testid={testId}
      className={cn(
        styles.credentialSettingsButton,
        variant === 'emptyState' && styles.credentialSettingsButtonEmptyState,
        variant === 'inline' && styles.credentialSettingsButtonInline,
      )}
    >
      <AiSettingsSolidIcon size={14} aria-hidden="true" />
      <span>{label}</span>
      <ArrowRightIcon size={12} aria-hidden="true" />
    </Button>
  )
}
