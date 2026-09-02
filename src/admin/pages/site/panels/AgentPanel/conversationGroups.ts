/**
 * Pure transcript grouping for the AgentPanel — no React, no styles.
 *
 * Two independent regroupings sit between the flat `AgentMessage[]` the store
 * keeps and what a reader should see:
 *
 *   1. `groupConsecutiveMessages` collapses same-role runs into TURNS, so a
 *      burst of tool activity doesn't render a stack of repeated "Assistant"
 *      labels.
 *   2. `groupRenderItems` flattens a turn's blocks back into emission order,
 *      coalescing consecutive tool calls into one item.
 *
 * They live here rather than in `MessageBubble.tsx` because that file only
 * exports components — `react-refresh/only-export-components` requires the
 * split, and it is the right one regardless: these are testable pure
 * functions with no rendering concerns.
 */

import type { AgentMessage, AgentToolCall } from '@site/agent'

export interface ConversationGroup {
  id: string
  role: AgentMessage['role']
  messages: AgentMessage[]
}

// Collapse the flat message list into conversational turns: consecutive
// messages of the same role become one group (one bubble, one role label).
// The agent emits each tool call as its own message, so without this a burst
// of tool activity would render as a stack of repeated "Assistant" labels.
export function groupConsecutiveMessages(messages: AgentMessage[]): ConversationGroup[] {
  const groups: ConversationGroup[] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (last && last.role === message.role) {
      last.messages.push(message)
      continue
    }
    groups.push({ id: message.id, role: message.role, messages: [message] })
  }
  return groups
}

// Flatten a turn's blocks (across its messages) in emission order, coalescing
// each run of consecutive tool-call blocks into one item so they render inside
// a single tight container; text blocks stay separate bubbles.
type MessageBlock = AgentMessage['blocks'][number]

type MessageRenderItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string }
  | {
      kind: 'images'
      key: string
      images: Array<{ key: string; src: string }>
    }
  | { kind: 'tools'; key: string; toolCalls: AgentToolCall[] }

export function groupRenderItems(messages: AgentMessage[]): MessageRenderItem[] {
  const items: MessageRenderItem[] = []
  for (const message of messages) {
    message.blocks.forEach((block: MessageBlock, index) => {
      if (block.kind === 'text') {
        // Position-based key, stable as streaming deltas append in place.
        items.push({ kind: 'text', key: `text-${message.id}-${index}`, text: block.text })
        return
      }
      if (block.kind === 'reasoning') {
        items.push({ kind: 'reasoning', key: `reasoning-${message.id}-${index}`, text: block.text })
        return
      }
      if (block.kind === 'image') {
        const image = {
          key: `image-${message.id}-${index}`,
          src: block.src,
        }
        const last = items.at(-1)
        if (last?.kind === 'images') last.images.push(image)
        else items.push({ kind: 'images', key: image.key, images: [image] })
        return
      }
      const last = items.at(-1)
      if (last && last.kind === 'tools') {
        last.toolCalls.push(block.toolCall)
        return
      }
      items.push({ kind: 'tools', key: `tools-${block.toolCall.id}`, toolCalls: [block.toolCall] })
    })
  }
  return items
}
