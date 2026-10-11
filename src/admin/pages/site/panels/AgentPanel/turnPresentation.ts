/**
 * How one assistant turn reads in the panel — pure, React-free, testable.
 *
 * Three questions the transcript used to answer badly (AI-26, AI-28):
 *
 *   - **Was that failure a problem?** A refusal the agent read, adjusted to and
 *     got past is how a careful agent works, not an error; painting it red is
 *     the "visible error" the owner bar forbids. {@link toolCallRecoveries}
 *     says which failed calls were recovered from (muted, "adjusted") and which
 *     the agent may still be recovering from (muted, "adjusting"). Red is left
 *     for a failure the turn ENDED on.
 *   - **What is it doing during a long write?** {@link inputProgressHeadline}
 *     turns the streaming-arguments event into "Writing Checkout.tsx · 3.2 KB".
 *   - **What did the variants look like?** {@link variantTiles} pairs the
 *     pages a `studio_plan_variants` call planned with the screenshots the same
 *     turn took of them.
 */
import type { AgentMessage, AgentToolCall, AgentToolInputProgress } from '@site/agent'
import { getToolCallDisplay } from './toolCallDisplay'

export type ToolCallRecovery = 'recovered' | 'working'

function toolCallsOf(messages: readonly AgentMessage[]): AgentToolCall[] {
  const calls: AgentToolCall[] = []
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === 'toolCall') calls.push(block.toolCall)
    }
  }
  return calls
}

/**
 * For each FAILED tool call of one assistant turn (its messages, in order):
 * `recovered` when a later call of the same tool succeeded; `working` when
 * nothing has succeeded it yet but the turn is still running, so the agent
 * may yet. A failed call absent from the map is one the turn ended on — the
 * only kind the panel shows as an error.
 */
export function toolCallRecoveries(messages: readonly AgentMessage[], turnActive: boolean): Map<string, ToolCallRecovery> {
  const calls = toolCallsOf(messages)
  const out = new Map<string, ToolCallRecovery>()
  calls.forEach((call, index) => {
    if (call.status !== 'error') return
    const recovered = calls.slice(index + 1).some((later) => later.actionType === call.actionType && later.status === 'success')
    if (recovered) out.set(call.id, 'recovered')
    else if (turnActive) out.set(call.id, 'working')
  })
  return out
}

/** `812 B`, `3.2 KB`, `1.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The last path segment, whichever separator the tool used. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/**
 * The activity headline while a call's arguments stream: the file when the
 * call has named one, the tool otherwise, and the bytes so far either way.
 */
export function inputProgressHeadline(progress: AgentToolInputProgress): string {
  const size = formatBytes(progress.bytes)
  if (progress.target) return `Writing ${baseName(progress.target)} · ${size}`
  return `Preparing ${getToolCallDisplay(progress.toolName, {}).title.toLowerCase()} · ${size}`
}

export interface VariantTile {
  /** The page the variant owns, e.g. `HomeB`. */
  readonly pageName: string
  /** Its letter, `A`…, for the label. */
  readonly letter: string
  /** The latest screenshot of that page this turn took, as a data URL — `null` when none was taken. */
  readonly image: string | null
}

const VARIANT_LETTERS = 'ABCDEFGH'

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * The variant set a turn planned (its last successful `studio_plan_variants`
 * call), each page paired with the newest screenshot of it in the same turn.
 * A screenshot counts only when it can be attributed without guessing: one
 * page and at least one image, or as many images as pages (in order). Empty
 * when the turn planned no variants.
 */
export function variantTiles(messages: readonly AgentMessage[]): VariantTile[] {
  const calls = toolCallsOf(messages)
  const plan = calls.findLast((call) => call.actionType === 'studio_plan_variants' && call.status === 'success')
  if (!plan) return []
  const baseName = typeof plan.params.baseName === 'string' ? plan.params.baseName : null
  if (!baseName) return []
  const count = typeof plan.params.count === 'number' ? Math.min(Math.max(2, Math.floor(plan.params.count)), VARIANT_LETTERS.length) : 3

  const latestImage = new Map<string, string>()
  for (const call of calls) {
    if (call.actionType !== 'studio_screenshot' || call.status !== 'success' || !call.previewImages?.length) continue
    const pages = stringArray(call.params.pages)
    if (pages.length === 1) latestImage.set(pages[0]!, call.previewImages[0]!)
    else if (pages.length > 1 && pages.length === call.previewImages.length) {
      pages.forEach((page, index) => latestImage.set(page, call.previewImages![index]!))
    }
  }

  return Array.from({ length: count }, (_, index) => {
    const letter = VARIANT_LETTERS[index]!
    const pageName = `${baseName}${letter}`
    return { pageName, letter, image: latestImage.get(pageName) ?? null }
  })
}
