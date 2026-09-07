/**
 * projectScope — "which project is this conversation about", derived in ONE
 * place from a client-supplied dir.
 *
 * Two callers need the same answer and must never compute it differently:
 * the conversations route (listing and creating) and `chat.ts` (stamping a
 * turn, and refusing one that disagrees with the conversation's stamp). A
 * second derivation would be a second definition of "this project", which is
 * exactly the class of drift `registeredMcpServerProjectKey` was introduced
 * to end — conversations, MCP OAuth sessions, and registered-server secrets
 * all scope by that one key.
 *
 * The dir is validated before it is keyed, never after: an unvalidated path
 * would let a caller mint a project key for a directory it has no business
 * naming. `resolveValidatedWorkspaceDir` returns `null` for anything that is
 * not a real directory inside `studio-workspace/` (symlinks resolved on both
 * sides), and `null` here means the honest "no project" — not a guess.
 */
import { resolveValidatedWorkspaceDir } from '../../handlers/studio/workspaceDir'
import { registeredMcpServerProjectKey } from '../drivers/registeredMcpServers'

/** The project key for a client-supplied dir, or `null` when there is no project (absent dir, or one that fails containment). Never throws. */
export function conversationProjectKey(requestedDir: string | null | undefined): string | null {
  const validated = resolveValidatedWorkspaceDir(requestedDir)
  return validated ? registeredMcpServerProjectKey(validated) : null
}

/** The project key for an ALREADY-validated workspace dir (`chat.ts` validates once per turn and must not validate twice). */
export function projectKeyForValidatedDir(validatedDir: string): string {
  return registeredMcpServerProjectKey(validatedDir)
}
