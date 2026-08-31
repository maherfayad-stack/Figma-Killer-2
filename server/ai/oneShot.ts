/**
 * oneShot — run a single, tool-free completion and return its text.
 *
 * Every existing caller of a driver is the CHAT runner: a multi-turn tool
 * loop with a browser bridge, a conversation log and a live SSE stream to the
 * editor. That is the wrong shape for a job like "translate these forty
 * strings" — there is no conversation, no tool the model may call, and
 * nothing to stream to a user watching. This is the missing small entry: one
 * system prompt, one user message, text out.
 *
 * ## Why the bridge rejects instead of being optional
 *
 * `AiStreamRequest.bridge` is required by the interface, and with `tools: []`
 * no driver can legitimately reach it — a model cannot call a tool it was
 * never given. A bridge that THROWS therefore encodes the invariant rather
 * than pretending to satisfy it: if a driver ever does call it, that is a bug
 * to surface, not a silent hang waiting for a browser POST that will never
 * come.
 *
 * ## The instruction travels in the message, not in `systemPrompt`
 *
 * This looked wrong until it cost a real failure, so it is worth stating
 * plainly: **not every driver forwards `AiStreamRequest.systemPrompt`.**
 * `claudeCli` — the CLI-shaped driver — pipes only the LATEST USER MESSAGE to
 * the subprocess and lets the CLI supply its own operating instructions
 * (that is also why it never forwards `req.tools`). Send a one-shot's rules
 * as a system prompt through that driver and the model receives a bare blob
 * with no request attached. The observed reply was exactly that: *"You've
 * sent the same JSON again without a request. What would you like me to
 * do?"* — a correct answer to what it was actually given.
 *
 * For a SINGLE-turn completion there was never a reason to split the two
 * apart. There is no conversation for a system prompt to persist across and
 * no history for it to sit in front of; "the instruction" and "the input" are
 * one message, and composing them here is the shape that reaches every driver
 * identically instead of the shape that reaches most of them.
 *
 * (The chat runner is different and correctly keeps its system prompt where
 * it belongs — a multi-turn agent loop needs it to outlive each turn.)
 *
 * ## Tool-call events are ignored, not errors
 *
 * A model can still emit a malformed tool call against an empty tool list.
 * Those events are skipped and only `text` is accumulated, so a confused
 * response degrades to "no usable text" (which the caller reports) rather
 * than throwing from inside the stream.
 */
import { resolveModelCapabilities } from './drivers/modelCapabilities'
import type { AiProvider, AiResolvedCredential, ToolContextBase } from './drivers/types'
import type { AiBrowserBridge } from './runtime/types'

/** See the module doc — `tools: []` means no driver may legitimately call this. */
const NO_BRIDGE: AiBrowserBridge = {
  callBrowser() {
    return Promise.reject(new Error('[ai/oneShot] a tool-free completion cannot call the browser bridge'))
  },
}

export interface OneShotParams {
  driver: AiProvider
  credentials: AiResolvedCredential
  modelId: string
  /** What the model must do. Sent as the head of the single user message — see the module doc for why NOT as a system prompt. */
  instructions: string
  /** The input the instructions operate on. */
  userMessage: string
  signal: AbortSignal
  /**
   * Required by `AiStreamRequest` because a driver composes each tool call's
   * `ToolContext` from it. With `tools: []` nothing here is ever read — it is
   * passed to satisfy the interface honestly rather than cast away, and the
   * caller supplies its real `db`/`userId`/`capabilities` so a future driver
   * that does consult it gets the truth rather than a placeholder.
   */
  toolContextBase: ToolContextBase
}

/** Runs the completion and returns the concatenated assistant text (trimmed). Throws whatever the driver throws. */
export async function runOneShotCompletion(params: OneShotParams): Promise<string> {
  const capabilities = await resolveModelCapabilities(params.driver, params.credentials, params.modelId)

  let text = ''
  for await (const event of params.driver.stream({
    // Empty on purpose — see the module doc. Every driver here treats an
    // empty array as "no system turn", so nothing spurious is sent.
    systemPrompt: [],
    messages: [
      { role: 'user', content: [{ kind: 'text', text: `${params.instructions}\n\n${params.userMessage}` }] },
    ],
    tools: [],
    modelId: params.modelId,
    modelCapabilities: capabilities,
    credentials: params.credentials,
    signal: params.signal,
    bridge: NO_BRIDGE,
    toolContextBase: params.toolContextBase,
  })) {
    if (event.type === 'text') text += event.text
  }
  return text.trim()
}
