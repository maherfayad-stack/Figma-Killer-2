/**
 * agentWriteScope — the one predicate deciding whether the CLI driver's
 * NATIVE `Write`/`Edit` may land on a given path.
 *
 * ## Why this has to exist (sec-12, found reviewing A10)
 *
 * `claudeCliToolSurface.ts` grants `Write`/`Edit` whenever a real project is
 * open, and states — correctly — that what bounds a native write is the
 * PROCESS: the subprocess's `cwd` is the containment-checked project
 * directory, so nothing outside the one project can be written. That is the
 * right boundary for the user's SOURCE. It is the wrong boundary for the
 * three directories inside that same project which are not source at all:
 *
 *   - **`.studio/`** is Studio's consent record. `meta.json` holds the
 *     project's `trust` tier — the Tier-2 gate every `run-project` route and
 *     `studio_render_reference` (A10) read through `checkTrustTier` — plus
 *     `approvedRegisteredMcpServers` and the `registeredMcpServers`
 *     definitions those approvals name. An agent that can write this file can
 *     promote its own project to Tier 2 (`trust: "run-project"`), which is
 *     the exact consent click A10's second gate is built on, and can
 *     self-approve a `transport: "stdio"` MCP server whose `command` the CLI
 *     then spawns on the next turn — arbitrary local execution, from a
 *     process that was deliberately denied `Bash`.
 *   - **`.claude/`** holds the generated `settings.local.json` that wires
 *     this very hook, and `.studio-generated.json`, the manifest
 *     `generateStudioProjectGuide` consults before overwriting anything it
 *     owns. A hand-edited settings file is never regenerated (by design), so
 *     a write here is a write that disables the gate below.
 *   - **`.git/`** is executable by proxy: a `hooks/pre-commit` planted here
 *     runs the next time anyone commits, including the user from the Version
 *     control panel.
 *
 * None of the three is something an agent authoring a screen ever has a
 * reason to write, and every one of them is a way to acquire a permission
 * nobody granted. `EXCLUDED_WORKSPACE_DIR_NAMES` already names `.studio`,
 * `.git`, `node_modules` and the build-output directories as off-limits
 * everywhere else in Studio (the asset reader, the git path resolver, the
 * import extractor); this applies the same list to the one surface that did
 * not have it, plus `.claude`.
 *
 * ## What this is, and is not
 *
 * It is enforcement at the only surface that grants native writes — the
 * `claude` CLI driver — via a `PreToolUse` hook (`hooks/denyControlPlaneWrite.ts`,
 * wired by `projectGuide.ts`). Hooks are evaluated independently of
 * `--permission-mode`, which is what makes this hold under the Studio panel's
 * `bypassPermissions` default, exactly as the `Stop` gate already does.
 *
 * It is NOT a claim that a Tier-2 promotion is unforgeable in general: a user
 * (or anything running as that user outside Studio) can still edit
 * `.studio/meta.json` by hand, which is correct — it is their file. The
 * property being defended is narrower and is the one A10 relies on: *the
 * agent* cannot manufacture its own consent.
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'

/**
 * Directory names a native agent write may never touch, at any depth.
 *
 * `EXCLUDED_WORKSPACE_DIR_NAMES` (`.studio`, `.git`, `node_modules`, `dist`,
 * `.next`, `.turbo`) plus `.claude`. Reusing that set rather than hand-listing
 * three names is deliberate: it is already the answer to "which directories in
 * a user's project are not the user's source", and a future addition to it
 * should reach this gate without anyone remembering to come here.
 */
export const AGENT_UNWRITABLE_DIR_NAMES: ReadonlySet<string> = new Set<string>([
  ...EXCLUDED_WORKSPACE_DIR_NAMES,
  '.claude',
])

/**
 * `path`, with every symlink in its EXISTING prefix resolved and the
 * not-yet-existing tail re-appended.
 *
 * `realpathSync` throws on a path whose leaf does not exist yet, which is the
 * common case for a `Write` — so walking up to the deepest ancestor that does
 * exist is the only way to resolve a link at all. A repository arriving from
 * GitHub can carry a symlink (git stores them), so a purely textual check is
 * bypassable: `src/cfg -> ../.studio` makes `src/cfg/meta.json` look like
 * source and land in the control plane.
 */
function realResolve(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return [realpathSync(current), ...tail].join(sep)
    } catch {
      const parent = dirname(current)
      // Reached the filesystem root without finding anything real — nothing
      // to resolve, so the textual form is already the answer.
      if (parent === current) return resolve(path)
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * The forbidden segment in `candidate`, if it has one — measured RELATIVE to
 * `base`, never over the absolute path.
 *
 * Scanning the absolute path would be stricter and wrong: Studio's own
 * checkout lives under directories with these exact names (this repo's agent
 * worktrees are literally `.claude/worktrees/<id>/`), so an absolute scan
 * refuses every write in a project that merely SITS somewhere named `.claude`
 * or `.git`. The question is which directories the project owns, and that is
 * only answerable relative to the project.
 *
 * A candidate outside `base` is not this predicate's business — the CLI's own
 * `cwd` containment already refuses it, and there is no project root to
 * measure its segments against.
 */
function forbiddenSegment(base: string, candidate: string): string | null {
  const rel = relative(base, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  for (const segment of rel.split(/[\\/]+/)) {
    // Lowercased: the filesystem is case-insensitive on Windows and macOS, so
    // `.STUDIO` reaches `.studio`.
    if (AGENT_UNWRITABLE_DIR_NAMES.has(segment.toLowerCase())) return segment
  }
  return null
}

/**
 * The reason this write must be refused, or `null` when it may proceed.
 *
 * Checks the textual resolution AND the symlink-resolved real path (each
 * against the matching form of `cwd`): a link pointing INTO the control plane
 * is caught by the second, and a control-plane directory that is itself a link
 * pointing out — so its real path no longer carries the name — is caught by
 * the first. Either hit refuses.
 */
export function agentWriteRefusalReason(filePath: string, cwd: string): string | null {
  const textual = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [resolve(cwd), textual],
    [realResolve(cwd), realResolve(textual)],
  ]

  for (const [base, candidate] of pairs) {
    const segment = forbiddenSegment(base, candidate)
    if (segment === null) continue
    return (
      `Refused: "${filePath}" is inside "${segment}/", which Studio owns and no agent write may touch. `
      + 'Trust tiers, MCP-server approvals, generated hook settings and git internals all live there — '
      + 'changing any of them would be granting yourself a permission the user never gave. '
      + 'Write the project\'s own source instead, and ask the user for anything that needs their consent.'
    )
  }
  return null
}
