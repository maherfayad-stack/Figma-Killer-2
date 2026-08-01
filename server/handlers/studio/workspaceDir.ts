/**
 * workspaceDir — `client-supplied dir -> a safe, contained studio project
 * directory, or null`. Extracted from `claudeCliEnv.ts`'s
 * `resolveClaudeCliWorkspaceCwd` (WS-11 step 2) because the exact same
 * validation is needed by a second, unrelated caller: WS-12's chat handler
 * uses it to decide whether a turn is "editing a Studio project" (real
 * Studio tools + prompt) or "editing a CMS site" (the existing tools/prompt),
 * from the SAME `workspaceDir` field on the chat request body — nothing about
 * the check itself is specific to spawning a CLI subprocess.
 *
 * `resolveClaudeCliWorkspaceCwd` stays as the name every existing caller
 * (`claudeCli.ts`, its tests, `docs/features/agent.md`) already imports —
 * it is now a thin alias over this function, not a second copy of the check.
 *
 * Containment mirrors `appRoot.ts`'s discipline: resolve symlinks on BOTH
 * sides before the containment check, never on the textual path alone — a
 * project pulled from GitHub can contain symlinks, and a prefix check on an
 * un-resolved path is bypassable. Returns `null` (never throws) for anything
 * that doesn't check out — a missing/invalid workspace is a legitimate
 * client-side state (e.g. no project open), not a bug worth crashing on.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'
import { projectsRootDir } from '../studioProjects'

export function resolveValidatedWorkspaceDir(
  requestedDir: string | null | undefined,
  projectsRoot: string = projectsRootDir(),
): string | null {
  if (!requestedDir) return null
  const resolved = resolve(requestedDir)
  if (!existsSync(resolved)) return null
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(resolved)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null

  let realResolved: string
  let realRoot: string
  try {
    realResolved = realpathSync(resolved)
    realRoot = realpathSync(projectsRoot)
  } catch {
    return null
  }
  try {
    assertPathWithin(realRoot, realResolved)
  } catch {
    return null
  }
  // Return the caller's own resolved (non-realpath'd) path — callers should
  // see the project at the path the browser knows it by, not a symlink target
  // that may not match what `.studio/meta.json` and the rest of Studio use.
  return resolved
}
