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
 * nobody granted. `UNWRITABLE_WORKSPACE_DIR_NAMES` (`@core/page-parser`) names
 * all of them — the walk exclusions plus `.claude` — and is the one list every
 * Studio writer consults (P1-G: the writeback, CSS and asset writers use the
 * same predicate); this applies it to the native-write surface.
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
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  hostExecutedWorkspaceFile,
  realpathAllowingMissing,
  studioShellWorkspaceFile,
  unwritableWorkspaceSegment,
} from '@core/page-parser'
import { hostConfigImportedBy } from './hostConfigImports'

/**
 * The forbidden segment in `candidate`, if it has one — measured RELATIVE to
 * `base`, never over the absolute path.
 *
 * Which names are forbidden is not decided here: it is
 * `UNWRITABLE_WORKSPACE_DIR_NAMES` (`@core/page-parser`'s shared write scope
 * — the walk exclusions `.studio`, `.git`, `node_modules`, build output, plus
 * `.claude`), the same predicate every Studio writer consults, compared the
 * way the filesystem resolves a name (case-folded, trailing dots and NTFS
 * stream suffixes dropped). A future exclusion reaches this gate without
 * anyone remembering to come here.
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
  const rel = relativeInside(base, candidate)
  return rel === null ? null : unwritableWorkspaceSegment(rel)
}

/**
 * `candidate` relative to `base`, or `null` when it is not inside it. A
 * segment that merely STARTS with two dots (`..foo/`) is inside: only `..`
 * itself climbs out (security review of #233, F9).
 */
function relativeInside(base: string, candidate: string): string | null {
  const rel = relative(base, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

/**
 * Why an agent write is refused. `protected-path`: Studio's control plane or
 * a non-source directory, never writable by an agent. `needs-user`: a file
 * that runs on the host (`hostExecutedWorkspaceFile`) — the user makes or
 * approves the change. `path-outside-project`: where the write would land is
 * unknown (a dangling link).
 */
export interface AgentWriteRefusal {
  readonly code: 'protected-path' | 'needs-user' | 'path-outside-project'
  readonly message: string
}

/**
 * Why this agent write must be refused, or `null` when it may proceed. The
 * ONE agent write gate: the `claude` CLI's `PreToolUse` hook
 * (`hooks/denyControlPlaneWrite.ts`) and the HTTP drivers' file tools
 * (`agentFileAccess.ts`) both ask it, so the two paths cannot disagree about
 * what an agent may write.
 *
 * Checks the textual resolution AND the symlink-resolved real path (each
 * against the matching form of `cwd`): a link pointing INTO the control plane
 * is caught by the second, and a control-plane directory that is itself a link
 * pointing out — so its real path no longer carries the name — is caught by
 * the first. Either hit refuses. A path through a DANGLING link has no real
 * path to judge, and a write would follow the link wherever it points — so it
 * is refused too.
 */
export function agentWriteRefusal(filePath: string, cwd: string): AgentWriteRefusal | null {
  const textual = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
  const realCwd = realpathAllowingMissing(cwd)
  const realTarget = realpathAllowingMissing(textual)
  if (realCwd === null || realTarget === null) {
    return {
      code: 'path-outside-project',
      message:
        `Refused: "${filePath}" runs through a link Studio cannot resolve, so where the write would land is unknown. `
        + 'Write the project\'s own source through a path that exists.',
    }
  }
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [resolve(cwd), textual],
    [realCwd, realTarget],
  ]

  for (const [base, candidate] of pairs) {
    const segment = forbiddenSegment(base, candidate)
    if (segment === null) continue
    return {
      code: 'protected-path',
      message:
        `Refused: "${filePath}" is inside "${segment}/", which Studio owns and no agent write may touch. `
        + 'Trust tiers, MCP-server approvals, generated hook settings and git internals all live there — '
        + 'changing any of them would be granting yourself a permission the user never gave. '
        + 'Write the project\'s own source instead, and ask the user for anything that needs their consent.',
    }
  }
  for (const [base, candidate] of pairs) {
    const rel = relativeInside(base, candidate)
    if (rel === null || !studioShellWorkspaceFile(rel)) continue
    return {
      code: 'protected-path',
      message:
        `Refused: "${filePath}" is part of Studio's preview shell (prototype/), which Studio generates and rewrites on every open — `
        + 'and vite.config.js loads it in Node, so a change there would run on the user\'s machine. '
        + 'Write the project\'s own source instead.',
    }
  }
  for (const [base, candidate] of pairs) {
    const rel = relativeInside(base, candidate)
    if (rel === null) continue
    const byName = hostExecutedWorkspaceFile(rel)
    const importer = byName === null ? hostConfigImportedBy(base, rel) : null
    const why = byName ?? (importer === null ? null : `imported by ${importer}, so it runs in Node whenever that config is loaded`)
    if (why === null) continue
    return {
      code: 'needs-user',
      message:
        `Not written: "${filePath}" is ${why}. It runs on the user's machine outside the page, so a change to it needs the user. `
        + 'Show the user the exact change and ask them to make or approve it, then carry on with the screen files — '
        + '.tsx, .ts, .css and assets stay yours to write.',
    }
  }
  return null
}
