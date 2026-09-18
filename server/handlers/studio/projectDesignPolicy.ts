/**
 * The disk half of `resolveDesignPolicy` — the tier that comes from a project
 * directory rather than from a call.
 *
 * Its own module for exactly the reason `projectFidelityMode.ts` is: `studioMeta.ts`
 * imports `designPolicy.ts` for the vocabulary (`DesignPolicySchema` is built
 * from `DESIGN_POLICIES` at module-init time), so a resolver that read meta
 * from inside that module would close a cycle whose bottom half runs at load.
 * Pure precedence in one file, I/O in this one.
 *
 * Two callers, and the difference between them is the whole reason this is
 * shared: `chat.ts` resolves the policy for a turn (it also holds the per-turn
 * value), and `studio_quality_check` resolves it per call with only a `dir`
 * and an account key. Both must reach the same answer, or the tool would grade
 * against a policy the prompt never told the agent it was working under.
 */
import { resolveDesignPolicy, type DesignPolicy } from './designPolicy'
import { readAgentSessionDesignPolicy, readStudioMeta } from './studioMeta'

/**
 * This project's design policy for `userKey`, given an optional per-turn
 * value. Tiers 2-4 of the chain; the one above them (an explicit tool
 * argument) is per-call and is applied where it is known.
 *
 * Never throws — an unreadable `.studio/` degrades to the default tier
 * (`balanced`), which is what a project that has never chosen gets anyway.
 */
export function resolveProjectDesignPolicy(
  dir: string,
  userKey: string,
  turn?: DesignPolicy,
): DesignPolicy {
  let project: DesignPolicy | undefined
  try {
    project = readAgentSessionDesignPolicy(readStudioMeta(dir), userKey) ?? undefined
  } catch (err) {
    console.error('[studio/projectDesignPolicy] could not read the persisted default:', err)
  }
  return resolveDesignPolicy({ turn, project }).policy
}
