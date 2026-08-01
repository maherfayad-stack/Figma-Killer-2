import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { listModels, type CredentialView } from '@admin/ai/api'
import {
  AI_USER_IMAGE_MAX_PER_MESSAGE,
  type AiUserContentBlock,
} from '@core/ai'
import { Button } from '@ui/components/Button'
import { FileUpload } from '@ui/components/FileUpload'
import { Textarea } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { ContextMeter } from './ContextMeter'
import { ModelEffortPicker } from './ModelEffortPicker'
import { AgentSessionControls } from './AgentSessionControls'
import {
  type AgentPreviewImage,
  type OpenAgentImageMenu,
} from './agentImageTypes'
import { PendingImageAttachmentGrid } from './PendingImageAttachmentGrid'
import { usePendingImageAttachments } from './usePendingImageAttachments'
import styles from './AgentPanel.module.css'

export type ComposerLockReason = 'setup' | 'chooseModel'

interface AgentComposerProps {
  composerLocked: boolean
  lockReason: ComposerLockReason | null
  credentials: CredentialView[]
  credentialsLoaded: boolean
  onRefreshCredentials(): void
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}

export function AgentComposer({
  composerLocked,
  lockReason,
  credentials,
  credentialsLoaded,
  onRefreshCredentials,
  onOpenImage,
  onOpenImageMenu,
}: AgentComposerProps) {
  const isStreaming = useAgentStore((state) => state.isAgentStreaming)
  const conversationPending = useAgentStore((state) => state.isAgentConversationPending)
  const providerPending = useAgentStore((state) => state.isAgentProviderPending)
  const isOpen = useAgentStore((state) => state.isAgentOpen)
  const sendAgentMessage = useAgentStore((state) => state.sendAgentMessage)
  const abortAgent = useAgentStore((state) => state.abortAgent)
  const queueAgentMessage = useAgentStore((state) => state.queueAgentMessage)
  const queuedMessage = useAgentStore((state) => state.agentQueuedMessage)
  const cancelQueuedAgentMessage = useAgentStore((state) => state.cancelQueuedAgentMessage)
  const activeCredentialId = useAgentStore((state) => state.agentActiveCredentialId)
  const activeModelId = useAgentStore((state) => state.agentActiveModelId)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const attachments = usePendingImageAttachments()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const id = setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      const panel = input.closest('[data-panel]')
      // A header or composer control may have received an explicit click
      // while this deferred autofocus was waiting.
      if (panel?.contains(document.activeElement)) return
      input.focus()
    }, 50)
    return () => clearTimeout(id)
  }, [isOpen])

  const activeProviderId =
    credentials.find((credential) => credential.id === activeCredentialId)?.providerId ?? null
  const activeModelResource = useAsyncResource(
    async () => {
      if (!activeProviderId || !activeCredentialId || !activeModelId) return null
      const models = await listModels(activeProviderId, activeCredentialId)
      return {
        credentialId: activeCredentialId,
        modelId: activeModelId,
        model: models.find((model) => model.id === activeModelId) ?? null,
      }
    },
    [activeProviderId, activeCredentialId, activeModelId],
    { fallbackError: 'Could not load details for this model.' },
  )
  const resolvedSelection = activeModelResource.data
  const activeModel =
    resolvedSelection?.credentialId === activeCredentialId
    && resolvedSelection.modelId === activeModelId
      ? resolvedSelection.model
      : null
  const modelCannotRunAgent = activeModel?.capabilities.toolCalling === false

  const hasAttachments = attachments.pending.length > 0
  const imageStatus = !hasAttachments
    ? 'none'
    : attachments.pending.some((entry) => entry.status === 'error')
      ? 'error'
      : attachments.pending.some((entry) => entry.status === 'processing')
        ? 'processing'
        : activeModelResource.loading
          ? 'checking-model'
          : activeModelResource.error || !resolvedSelection
            ? 'model-error'
          : activeModel?.capabilities.visionInput
            ? 'ready'
            : 'unsupported-model'

  async function submit(): Promise<void> {
    if (
      conversationPending
      || providerPending
      || submitting
      || modelCannotRunAgent
    ) return
    const text = draft.trim()
    const pending = attachments.current()
    if (!text && pending.length === 0) return
    if (pending.some((entry) => entry.status === 'processing')) {
      pushToast({ kind: 'error', title: 'Images are still processing', body: 'Wait a moment, then send again.' })
      return
    }
    if (pending.some((entry) => entry.status === 'error' || !entry.block)) return
    if (pending.length > 0 && imageStatus !== 'ready') return

    const content: AiUserContentBlock[] = []
    if (text) content.push({ kind: 'text', text })
    for (const entry of pending) {
      if (entry.block) content.push(entry.block)
    }

    // Mid-turn: park it instead of dropping it. The server permits one stream
    // per conversation, so sending now would just 409 — the slice sends this
    // the moment the running turn finishes.
    if (isStreaming) {
      queueAgentMessage(content)
      setDraft('')
      attachments.clear()
      return
    }

    setSubmitting(true)
    const result = await sendAgentMessage(content).finally(() => setSubmitting(false))
    if (result.accepted) {
      setDraft('')
      attachments.clear()
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    )
    if (imageFiles.length === 0) return
    event.preventDefault()
    attachments.queueFiles(imageFiles, AI_USER_IMAGE_MAX_PER_MESSAGE)
  }

  function handleImageSelection(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.currentTarget.files ?? [])
    // Let the same local file fire change again after it is removed.
    event.currentTarget.value = ''
    attachments.queueFiles(files, AI_USER_IMAGE_MAX_PER_MESSAGE)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void submit()
  }

  const imageBlocksSend = imageStatus !== 'none' && imageStatus !== 'ready'
  // Nothing to send is a disabled Send, not a no-op click — mid-turn the
  // button queues, so it must only be live when there IS something to queue.
  const hasDraftToSend = draft.trim().length > 0 || hasAttachments
  const sendDisabled =
    composerLocked
    || conversationPending
    || providerPending
    || submitting
    || imageBlocksSend
    || modelCannotRunAgent
  let sendTooltip = 'Send'
  if (lockReason === 'setup') sendTooltip = 'Add AI credentials first'
  else if (lockReason === 'chooseModel') sendTooltip = 'Choose a model first'
  else if (modelCannotRunAgent) sendTooltip = 'Choose an agent-capable model'
  else if (imageStatus === 'processing') sendTooltip = 'Preparing image'
  else if (imageStatus === 'checking-model') sendTooltip = 'Checking image support'
  else if (imageStatus === 'model-error') sendTooltip = 'Could not verify image support'
  else if (imageStatus === 'unsupported-model') sendTooltip = 'Choose a vision-capable model'
  else if (imageStatus === 'error') sendTooltip = 'Remove the failed image'
  else if (isStreaming) sendTooltip = 'Send when the current turn finishes'

  return (
    <div className={styles.inputBar}>
      {hasAttachments && (
        <PendingImageAttachmentGrid
          entries={attachments.pending}
          actionsDisabled={submitting || isStreaming}
          onRemove={attachments.remove}
          onOpenImage={onOpenImage}
          onOpenImageMenu={onOpenImageMenu}
        />
      )}
      {hasAttachments && imageStatus === 'checking-model' && (
        <p role="status" className={styles.attachmentNotice}>Checking whether this model accepts images…</p>
      )}
      {hasAttachments && imageStatus === 'unsupported-model' && (
        <p role="alert" className={styles.attachmentWarning}>
          Choose a vision-capable model or remove the image.
        </p>
      )}
      {hasAttachments && imageStatus === 'model-error' && (
        <p role="alert" className={styles.attachmentWarning}>
          Could not verify image support for this model. Choose another model or remove the image.
        </p>
      )}
      {modelCannotRunAgent && (
        <p role="alert" className={styles.attachmentWarning}>
          Choose an agent-capable model that supports tool calling.
        </p>
      )}
      {queuedMessage && (
        <div className={styles.queuedMessage} role="status">
          <span className={styles.queuedText}>
            Queued: {queuedPreview(queuedMessage)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={cancelQueuedAgentMessage}
            aria-label="Cancel queued message"
          >
            Cancel
          </Button>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className={styles.inputForm}
      >
        <Textarea
            ref={inputRef}
            value={draft}
            placeholder={lockReason === 'setup'
              ? 'Add AI credentials to start chatting'
              : lockReason === 'chooseModel'
                ? 'Choose a model below to start'
                : isStreaming
                  ? 'Type your next message — it sends when this turn finishes'
                  : 'Tell me what to build… (attach images or press Enter to send)'}
            aria-label="Message to AI assistant"
            rows={2}
            resize="none"
            disabled={composerLocked || conversationPending || providerPending || submitting}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            onChange={(event) => {
              setDraft(event.target.value)
              event.target.style.height = 'auto'
              event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`
            }}
          />
        <div className={styles.inputControls}>
          <AgentSessionControls hasCredentials={credentials.length > 0} />
          <div className={styles.inputControlActions}>
            <ModelEffortPicker
              credentials={credentials}
              credentialsLoaded={credentialsLoaded}
              onRefreshCredentials={onRefreshCredentials}
              disabled={isStreaming || conversationPending || providerPending || submitting}
            />
            <ContextMeter
              credentialId={activeCredentialId}
              modelId={activeModel?.id ?? activeModelId}
              windowTokens={activeModel?.contextWindow ?? null}
              pricing={activeModel?.pricing ?? null}
            />
            <FileUpload
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={handleImageSelection}
              buttonProps={{
                variant: 'ghost',
                size: 'sm',
                iconOnly: true,
                disabled: composerLocked
                  || isStreaming
                  || conversationPending
                  || providerPending
                  || submitting
                  || attachments.pending.length >= AI_USER_IMAGE_MAX_PER_MESSAGE,
                tooltip: attachments.pending.length >= AI_USER_IMAGE_MAX_PER_MESSAGE
                  ? `Maximum ${AI_USER_IMAGE_MAX_PER_MESSAGE} images per message`
                  : 'Attach images',
                'aria-label': 'Attach images',
              }}
            >
              <ImageSolidIcon size={14} aria-hidden="true" />
            </FileUpload>
            {/* Send stays available DURING a turn — it queues rather than
                sending. Previously it was swapped out for Stop, so a message
                typed mid-turn had no button at all and only Enter could
                submit it, which nothing told the user. */}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              iconOnly
              disabled={sendDisabled || !hasDraftToSend}
              tooltip={sendTooltip}
              aria-label={isStreaming ? 'Queue message' : 'Send'}
            >
              <SendSolidIcon size={14} />
            </Button>
            {isStreaming && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                iconOnly
                onClick={abortAgent}
                tooltip="Stop"
                aria-label="Stop"
              >
                <SquareSolidIcon size={14} />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

/** A one-line preview of what is waiting, so the chip says WHICH message is queued rather than just that one is. */
function queuedPreview(content: AiUserContentBlock[]): string {
  const text = content.find((block) => block.kind === 'text')
  const label = text && 'text' in text ? text.text.trim() : ''
  const images = content.filter((block) => block.kind === 'image').length
  if (!label) return images > 0 ? `${images} image${images === 1 ? '' : 's'}` : 'message'
  const trimmed = label.length > 60 ? `${label.slice(0, 60)}…` : label
  return images > 0 ? `${trimmed} (+${images})` : trimmed
}
