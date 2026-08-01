/**
 * MessageBubble — one conversational turn in the AgentPanel transcript.
 *
 * Split out of `AgentPanel.tsx` (which owns the panel shell, streaming
 * lifecycle, and empty/error states) because rendering a turn is a separate,
 * self-contained job: collapse the flat message list into turns, flatten each
 * turn's blocks back into emission order, and render text / reasoning / image
 * / tool-call runs. Nothing here reaches into panel state — everything arrives
 * as props.
 */

import { memo } from 'react'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { renderMarkdownToHtml, type AgentToolCall } from '@site/agent'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { cn } from '@ui/cn'
import { AgentImageGallery } from './AgentImageGallery'
import type { AgentPreviewImage, OpenAgentImageMenu } from './agentImageTypes'
import { groupRenderItems, type ConversationGroup } from './conversationGroups'
import { ToolCallRow } from './ToolCallRow'
import { ReasoningRow } from './ReasoningRow'
import { formatRelativeTime } from './relativeTime'
import styles from './AgentPanel.module.css'

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

export function MessageBubble({
  group,
  onOpenImage,
  onOpenImageMenu,
}: {
  group: ConversationGroup
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}) {
  const isUser = group.role === 'user'
  const user = useAuthenticatedAdminUser()
  const startedAt = group.messages[0]?.timestamp
  const relativeTime = startedAt ? formatRelativeTime(startedAt) : ''

  return (
    <div className={styles.messageTurn}>
      {/* Role marker — avatar + name + relative time, once per turn. The user
          reuses their Gravatar; the agent gets the robot glyph. */}
      <div className={styles.roleLabel}>
        {isUser ? (
          <UserAvatar user={user} size={16} alt={null} />
        ) : (
          <span className={styles.roleAvatarAi} aria-hidden="true">
            <AiBoxSolidIcon size={11} />
          </span>
        )}
        <span className={styles.roleName}>{isUser ? 'You' : 'Assistant'}</span>
        {relativeTime && <span className={styles.roleTime}>· {relativeTime}</span>}
      </div>

      {/* Chronological blocks — text and tool calls render in the order
          Claude actually emitted them, so a "text → tool → text" sequence
          shows two separate text bubbles around the tool badges. Text is
          rendered as markdown (bold, lists, inline code, links, …) via a
          DOMPurify-sanitised HTML pipeline. */}
      {groupRenderItems(group.messages).map((item) =>
        item.kind === 'text' ? (
          <MarkdownTextBubble key={item.key} text={item.text} isUser={isUser} />
        ) : item.kind === 'reasoning' ? (
          <ReasoningRow key={item.key} text={item.text} />
        ) : item.kind === 'images' ? (
          <MessageImageGallery
            key={item.key}
            images={item.images}
            isUser={isUser}
            onOpenImage={onOpenImage}
            onOpenImageMenu={onOpenImageMenu}
          />
        ) : (
          // A run of consecutive tool calls shares one container so the rows
          // stack tightly; text blocks around them stay separate bubbles.
          <div key={item.key} className={styles.toolCallsContainer}>
            {item.toolCalls.map((toolCall) => (
              <ToolCallRow key={toolCall.id} toolCall={toolCall} />
            ))}
            <ToolPreviewGallery
              toolCalls={item.toolCalls}
              onOpenImage={onOpenImage}
              onOpenImageMenu={onOpenImageMenu}
            />
          </div>
        ),
      )}
    </div>
  )
}

function MessageImageGallery({
  images,
  isUser,
  onOpenImage,
  onOpenImageMenu,
}: {
  images: Array<{ key: string; src: string }>
  isUser: boolean
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}) {
  const galleryImages = images.map((image, index): AgentPreviewImage => ({
    id: image.key,
    src: image.src,
    alt: images.length === 1
      ? isUser ? 'Attachment from you' : 'Image from assistant'
      : isUser
        ? `Attachment ${index + 1} of ${images.length} from you`
        : `Image ${index + 1} of ${images.length} from assistant`,
    title: isUser ? 'Your attachment' : 'Assistant image',
    filename: isUser
      ? `your-attachment-${index + 1}`
      : `assistant-image-${index + 1}`,
  }))

  return (
    <AgentImageGallery
      images={galleryImages}
      label={isUser ? 'Images from you' : 'Images from assistant'}
      onOpenImage={onOpenImage}
      onOpenImageMenu={onOpenImageMenu}
    />
  )
}

function ToolPreviewGallery({
  toolCalls,
  onOpenImage,
  onOpenImageMenu,
}: {
  toolCalls: AgentToolCall[]
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}) {
  const images = toolCalls.flatMap((toolCall) =>
    (toolCall.previewImages ?? []).map((src, index): AgentPreviewImage => ({
      id: `${toolCall.id}-preview-${index}`,
      src,
      alt: `Image ${index + 1} captured while running ${toolCall.actionType}`,
      title: 'Tool result image',
      filename: `${toolCall.actionType}-${index + 1}`,
    })),
  )
  return (
    <AgentImageGallery
      images={images}
      label="Images captured by assistant tools"
      onOpenImage={onOpenImage}
      onOpenImageMenu={onOpenImageMenu}
    />
  )
}

// ---------------------------------------------------------------------------
// MarkdownTextBubble — parses + sanitises the block text and injects it via
// dangerouslySetInnerHTML. Memoised render so streaming deltas don't re-parse
// markdown for unchanged blocks.
// ---------------------------------------------------------------------------

interface MarkdownTextBubbleProps {
  text: string
  isUser: boolean
}

// Exception #2: React.memo re-render bailout on a hot, list-rendered component
// (one per text block, re-rendered on every streaming delta).
const MarkdownTextBubble = memo(function MarkdownTextBubble({
  text,
  isUser,
}: MarkdownTextBubbleProps) {
  const html = renderMarkdownToHtml(text)
  // Empty/whitespace-only blocks don't render at all (avoids stray bubbles
  // around stripped-out tool blocks during streaming).
  if (!html) return null
  return (
    <div
      className={cn(
        styles.messageText,
        isUser ? styles.messageTextUser : styles.messageTextAssistant,
        styles.markdownText,
      )}
      // Safe: sanitised by DOMPurify (via sanitizeRichtext) before reaching here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})
