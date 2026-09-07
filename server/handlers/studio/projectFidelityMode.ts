/**
 * The disk half of `resolveFidelityMode` — the tiers that come from a project
 * directory rather than from a call.
 *
 * Its own module, and not a function inside `./fidelityMode.ts`, because
 * `studioMeta.ts` imports `fidelityMode.ts` for the vocabulary: a resolver
 * that reads meta from inside that module would close a cycle whose bottom
 * half runs at module-init time (`FidelityModeSchema` is built from
 * `FIDELITY_MODES` at load). Keeping the pure precedence in one file and the
 * I/O in this one keeps that graph one-directional, the same way
 * `@core/framework-schema` sits under `@core/framework`.
 *
 * Two callers, and the difference between them is the whole reason this is
 * shared: `chat.ts` resolves the mode for a turn (it also holds the per-turn
 * value), and `hooks/stopGateCheck.ts` resolves it from a standalone `bun`
 * subprocess with nothing but a `cwd` — no turn, no request, no memory of the
 * server. Both must reach the same answer, or the gate would enforce a mode
 * the prompt never told the agent it was working under.
 */
import { resolveFidelityMode, type FidelityMode } from './fidelityMode'
import { readAgentSessionFidelityMode, readStudioMeta } from './studioMeta'
import { projectHasDesignReference } from './designReferenceStore'

/**
 * This project's fidelity mode for `userKey`, given an optional per-turn
 * value. Tiers 3-5 of the chain; the two above them (an explicit tool
 * argument, and the resolved design reference's own `mode`) are per-call and
 * per-page and are applied where they are known, in `studio_compare`.
 *
 * Never throws — an unreadable `.studio/` degrades to the derived tier, which
 * is what a project with nothing registered gets anyway.
 */
export function resolveProjectFidelityMode(
  dir: string,
  userKey: string,
  turn?: FidelityMode,
): FidelityMode {
  let project: FidelityMode | undefined
  try {
    project = readAgentSessionFidelityMode(readStudioMeta(dir), userKey) ?? undefined
  } catch (err) {
    console.error('[studio/projectFidelityMode] could not read the persisted default:', err)
  }
  return resolveFidelityMode({
    turn,
    project,
    referenceArmed: projectHasDesignReference(dir),
  }).mode
}
