/**
 * The per-turn setup a Studio turn on an HTTP driver needs, which the
 * `claude` CLI driver does for itself right before its spawn (`claudeCli.ts`).
 *
 * Two things, both best-effort and both the CLI path's own:
 *
 *   - **The project guide.** `CLAUDE.md` plus the `.claude/` design-system
 *     references (`projectGuide.ts`). The CLI loads `CLAUDE.md` from its cwd
 *     for free; an HTTP turn reads it with `studio_read_file`, and the prompt
 *     tells it to — so it has to exist, and be current, for a project that has
 *     only ever been driven through an API key. Manifest-gated: a turn where
 *     nothing changed writes nothing.
 *   - **A fresh turn-write log.** The boundary the Studio file tools append to
 *     (`fileWriteTools.ts`), drawn AFTER the prompt reported what the last turn
 *     wrote, exactly where `claudeCli.ts` draws it.
 *   - **The turn's file checkpoint** (AI-7, `agentCheckpoints.ts`) — opened at
 *     the same boundary, so every write the file tools make this turn is
 *     bracketed by a pre- and a post-image the user can revert to.
 *
 * Lives beside `chatSystemPrompt.ts` rather than inside `handlers/chat.ts` for
 * the same reason that module does: it never touches a `Request`.
 */
import { generateStudioProjectGuide } from '../handlers/studio/projectGuide'
import { resetTurnWriteLog } from '../handlers/studio/turnWriteLog'
import { studioAgentUserKey } from '../handlers/studio/agentUserScope'
import { beginAgentCheckpointTurn } from '../handlers/studio/agentCheckpoints'

export interface StudioHttpTurn {
  readonly userId: string
  readonly conversationId: string
  /** The persisted user message id — see `ToolContextBase.turnId`. */
  readonly turnId: string
}

export function prepareStudioHttpTurn(dir: string, turn: StudioHttpTurn): void {
  try {
    generateStudioProjectGuide(dir)
  } catch (err) {
    console.error('[ai/chat] failed to generate the project guide — continuing without one:', err)
  }
  const userKey = studioAgentUserKey(turn.userId)
  resetTurnWriteLog(dir, userKey)
  beginAgentCheckpointTurn(dir, userKey, { conversationId: turn.conversationId, turnId: turn.turnId })
}
