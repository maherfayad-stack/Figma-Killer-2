/**
 * The `--input-format stream-json` stdin wire protocol — VERIFIED (W4-2B).
 *
 * ## This module exists because the shape is no longer a guess
 *
 * Every previous version of this driver recorded the same deferral: the CLI
 * advertises `--input-format stream-json` ("realtime streaming input") and
 * `--replay-user-messages` for exactly that mode, but "its stdin JSON message
 * shape is NOT verified against the binary", so the driver used
 * `--session-id`/`--resume` and paid a whole cold spawn — every MCP server
 * re-handshaked from scratch — on every single turn.
 *
 * That shape has now been established by hand-driving the installed binary
 * (`claude 2.1.263`) outside the repo, feeding it NDJSON on stdin and reading
 * what came back. Everything below is a MEASURED fact from that spike, not an
 * inference from `--help`. Re-run the spike before changing any of it.
 *
 * ### 1. The user-message envelope
 *
 * ```json
 * {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"parent_tool_use_id":null}
 * ```
 *
 * One line, terminated by `\n`. `session_id` MAY be present and is IGNORED —
 * the CLI stamps its own session id on everything it emits, including the
 * replay of the message you just sent. Unknown extra top-level fields are
 * accepted and silently dropped (an `effort` field was tried; it changed
 * nothing and broke nothing).
 *
 * ### 2. Turn boundaries
 *
 * Writing one such line starts a turn. The CLI answers with a fresh
 * `system/init` line, then the usual `assistant` / `stream_event` / tool lines,
 * then exactly one `result` line — which is the ONLY turn terminator. The
 * process stays alive and immediately accepts the next user line on the same
 * stdin, with full conversational context carried in memory (verified: turn 1
 * "remember 8241", turn 2 "what number?" → "8241").
 *
 * ### 3. MCP servers are initialized ONCE — the entire point
 *
 * A stdio MCP server wired into the spike logged exactly one process spawn,
 * one `initialize`, and one `tools/list` across THREE turns. Measured
 * time-to-first-output-line on that run, one trivial MCP server attached:
 *
 * | turn | first stdout line |
 * |------|-------------------|
 * | 1 (cold) | 956 ms |
 * | 2 (warm) | 3 ms |
 * | 3 (warm) | 0 ms |
 *
 * Studio attaches its own HTTP server plus every approved project/registered
 * server, so the cold number here is a floor, not an estimate.
 *
 * ### 4. Malformed stdin is FATAL — the one hard safety rule
 *
 * A single line that is not valid JSON kills the process outright:
 * `Error parsing streaming input line (type=unknown, 16 chars): SyntaxError`
 * on stderr, then exit 1, mid-conversation, with no recovery. This is why
 * every line this module emits goes through {@link encodeStdinLine}, which
 * asserts the serialized form contains no embedded newline before it is
 * allowed anywhere near a real pipe. `JSON.stringify` already escapes control
 * characters, so the assertion can only fire on a genuine bug in this file —
 * which is exactly when you want it to fire, since the alternative failure is
 * a dead conversation.
 *
 * An unrecognised CONTROL request, by contrast, is safe: the CLI answers
 * `{"subtype":"error","error":"Unsupported control request subtype: …"}` and
 * carries on. Only malformed JSON is lethal.
 *
 * ### 5. Control requests — what exists, and what does not
 *
 * Extracted from the binary and each confirmed live: `interrupt`,
 * `set_model`, `set_permission_mode`, `set_cwd`, `set_max_thinking_tokens`,
 * `set_mcp_permission_mode_override`, `set_in_progress_tool_use_ids`,
 * plus the CLI→host directions (`can_use_tool`, `hook_callback`,
 * `mcp_message`).
 *
 * **There is no `set_effort`** — probed directly, answered "Unsupported
 * control request subtype: set_effort". `--effort` is argv-only, which is why
 * effort is part of the pool's reuse key and a changed effort respawns
 * (`claudeCliSessionPool.ts`).
 *
 * `interrupt` is the abort path and it is clean: sent mid-generation it
 * answered in ~1 ms, the running turn terminated with a normal `result` line
 * carrying `subtype: "error_during_execution"`, and the very next user message
 * on the same stdin was answered normally. Aborting a turn therefore does NOT
 * have to kill the session.
 */

/**
 * The one shape the CLI accepts on stdin for a user turn (§1 above).
 *
 * Deliberately NOT a TypeBox schema: nothing here parses an untrusted value,
 * this is a serializer for a wire format this process owns both ends of. The
 * boundary that DOES need validation is the CLI's stdout, and that already has
 * one (`ClaudeCliLineSchema`, `claudeCliEvents.ts`).
 */
export interface ClaudeCliUserMessageLine {
  readonly type: 'user'
  readonly message: {
    readonly role: 'user'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }
  /**
   * Always `null` for a top-level user turn. The field exists so a message can
   * be attributed to an in-flight tool use; Studio never sends one of those,
   * but the CLI's own replay echoes the field back, so sending it explicitly
   * keeps what goes in identical to what comes out.
   */
  readonly parent_tool_use_id: null
}

/** The control-request subtypes this driver sends. See §5 — `set_effort` is deliberately absent because it does not exist. */
export type ClaudeCliControlRequest =
  | { readonly subtype: 'interrupt' }
  | { readonly subtype: 'set_model'; readonly model: string }
  | { readonly subtype: 'set_permission_mode'; readonly mode: string }

export interface ClaudeCliControlRequestLine {
  readonly type: 'control_request'
  readonly request_id: string
  readonly request: ClaudeCliControlRequest
}

/**
 * Serialize one protocol object to the exact bytes that go down the pipe:
 * compact JSON, one trailing newline, UTF-8.
 *
 * The newline assertion is the guard described in §4 — a malformed or
 * multi-line stdin write kills the CLI process outright and takes the
 * conversation with it, so this refuses to produce such bytes at all rather
 * than letting them reach a live session. `JSON.stringify` escapes `\n` inside
 * strings, so reaching the throw means a genuine defect in this file.
 */
export function encodeStdinLine(value: ClaudeCliUserMessageLine | ClaudeCliControlRequestLine): Uint8Array {
  const json = JSON.stringify(value)
  if (json.includes('\n')) {
    throw new Error('[ai/claudeCli] refusing to write a multi-line stdin frame — the CLI treats malformed stdin as fatal')
  }
  return new TextEncoder().encode(`${json}\n`)
}

/** Build the user-turn line for `text` (§1). Text is passed through verbatim; newlines in it are escaped by `JSON.stringify`, which is why a multi-line prompt is safe here and was never safe on argv. */
export function buildUserMessageLine(text: string): ClaudeCliUserMessageLine {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }
}

/** Build a control-request line (§5). `requestId` is echoed back on the matching `control_response`. */
export function buildControlRequestLine(requestId: string, request: ClaudeCliControlRequest): ClaudeCliControlRequestLine {
  return { type: 'control_request', request_id: requestId, request }
}
