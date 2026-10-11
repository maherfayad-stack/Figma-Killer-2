/**
 * Tool-argument progress while a tool call is still streaming (AI-26).
 *
 * A whole-screen `Write` (CLI) or `studio_write_file` (HTTP) is one tool call
 * whose arguments ARE the file. The provider streams those arguments for tens
 * of seconds before the call is complete — and until it is, the panel had
 * nothing to show but "Working out the next step". Every driver already sees
 * the fragments (`input_json_delta`, `tool_calls[].function.arguments`); this
 * turns them into a quiet `toolInputProgress` event: which tool, how many
 * bytes so far, and — once its `path` has streamed in — which file.
 *
 * Display only, like `retrying`: never persisted, never fed back to a model.
 * Throttled to one event per {@link TOOL_INPUT_PROGRESS_STEP_BYTES} of
 * arguments (plus one the moment the target file is known), so a 60 KB write
 * costs the wire ~60 small lines, not one per token.
 *
 * It keeps only the first {@link HEAD_CHARS} characters of each call's
 * arguments — enough to find `"path": "…"`, which every file tool names
 * first — never a second copy of the whole argument string the translator is
 * already accumulating.
 */
import type { AiStreamEvent } from '../runtime/types'

export const TOOL_INPUT_PROGRESS_STEP_BYTES = 1024
const HEAD_CHARS = 4096
/** The argument names a file tool uses for its target: Studio's (`path`) and the CLI's (`file_path`). */
const TARGET_RE = /"(?:path|file_path)"\s*:\s*("(?:[^"\\]|\\.){1,1024}")/

interface CallProgress {
  name: string
  bytes: number
  head: string
  reportedStep: number
  target: string | null
}

export class ToolInputProgress {
  private readonly calls = new Map<string, CallProgress>()

  /**
   * Feed one argument fragment of call `id`. Returns the event to emit now,
   * or `null` when nothing worth a line has changed since the last one.
   */
  append(id: string, name: string, fragment: string): Extract<AiStreamEvent, { type: 'toolInputProgress' }> | null {
    if (fragment.length === 0) return null
    let call = this.calls.get(id)
    if (!call) {
      call = { name, bytes: 0, head: '', reportedStep: -1, target: null }
      this.calls.set(id, call)
    }
    if (!call.name && name) call.name = name
    call.bytes += Buffer.byteLength(fragment, 'utf8')
    let foundTarget = false
    if (call.target === null && call.head.length < HEAD_CHARS) {
      call.head += fragment.slice(0, HEAD_CHARS - call.head.length)
      const match = TARGET_RE.exec(call.head)
      if (match) {
        try {
          call.target = JSON.parse(match[1]!) as string
          foundTarget = true
        } catch {
          // A half-streamed escape: the next fragment completes it.
        }
      }
    }
    const step = Math.floor(call.bytes / TOOL_INPUT_PROGRESS_STEP_BYTES)
    if (!foundTarget && step === call.reportedStep) return null
    call.reportedStep = step
    return {
      type: 'toolInputProgress',
      toolCallId: id,
      toolName: call.name,
      bytes: call.bytes,
      ...(call.target !== null ? { target: call.target } : {}),
    }
  }
}
