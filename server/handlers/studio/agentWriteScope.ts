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
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  hostExecutedWorkspaceFile,
  isSecretBearingFileName,
  realpathAllowingMissing,
  studioShellWorkspaceFile,
  unwritableWorkspaceSegment,
} from '@core/page-parser'
import { hostConfigImportedBy, tailwindLoadDirectives } from './hostConfigImports'

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
  // Key material and credential stores (`credentials.json`, `*.key`, `id_rsa`,
  // `.pgpass`, `*.tfvars`, `.dev.vars`, …). The HTTP file tools refused these
  // through their own read/write rule while the CLI hook did not, so the two
  // paths disagreed (review of #251, F2). Checked after `needs-user`, so an env
  // file keeps that answer. Real path too: a link named `x.ts` onto a key is a key.
  for (const [base, candidate] of pairs) {
    const rel = relativeInside(base, candidate)
    const name = rel?.split(sep).at(-1)
    if (!name || !isSecretBearingFileName(name)) continue
    return {
      code: 'protected-path',
      message:
        `Refused: "${filePath}" is a credential file (key material or a credential store), which no agent may read or write. `
        + 'Tell the user what it should contain and let them write it.',
    }
  }
  return null
}

/**
 * The CONTENT half of the one agent write gate: why this change to
 * `filePath` must be refused, or `null`. `before` is what the file holds now
 * (`null` for a new file), `after` what it would hold.
 *
 * A stylesheet is the agent's to write — but in a Tailwind project an
 * `@plugin "./x.js"` or `@config "./x.js"` directive makes the next build load
 * that module in Node, and both the stylesheet and a `.js` file beside it are
 * ordinary agent writes. Two of them would be the zero-click host execution
 * the path half exists to close (security re-review of #233, R1). So a write
 * that ADDS such a directive — relative or a package name — needs the user;
 * one that keeps the directives a file already has, and edits the rest, does
 * not. What an existing directive loads is protected by the path half
 * (`hostConfigImports.ts`).
 *
 * Every agent text write is judged, not only `.css`: a `<style>` block in
 * `index.html`, a `.vue` or a `.svelte` file reaches Tailwind through Vite
 * just the same. And a directive is recognised the way Tailwind reads it —
 * any wrapping around the path, comments dropped (`parseTailwindLoadDirectives`,
 * security review of #256, B1) — never only in its quoted spelling.
 *
 * Both write paths ask it: the HTTP tools before every write
 * (`agentWriteSupport.ts`' `checkContent`), and the CLI's `PreToolUse` hook
 * with the Write or Edit tool's own input ({@link agentToolInputContentRefusal}).
 */
export function agentContentRefusal(filePath: string, before: string | null, after: string): AgentWriteRefusal | null {
  const had = tailwindLoadDirectives(before ?? '')
  const added = tailwindLoadDirectives(after).filter((directive) => {
    const index = had.indexOf(directive)
    if (index === -1) return true
    had.splice(index, 1)
    return false
  })
  if (added.length === 0) return null
  return {
    code: 'needs-user',
    message:
      `Not written: this change to "${filePath}" adds ${added.join(', ')}, which makes the next Tailwind build load that module in Node on the user's machine. `
      + 'Show the user the exact change and ask them to make or approve it, then carry on — the rest of the file stays yours to write.',
  }
}

/** The Write/Edit tool input the CLI hands a `PreToolUse` hook — only the fields the content gate reads. */
export interface AgentToolWriteInput {
  readonly content?: string
  readonly old_string?: string
  readonly new_string?: string
}

/**
 * {@link agentContentRefusal} for the CLI hook: a `Write` compares its whole
 * `content` with the file on disk, an `Edit` its `new_string` with its
 * `old_string`.
 */
export function agentToolInputContentRefusal(filePath: string, cwd: string, input: AgentToolWriteInput | undefined): AgentWriteRefusal | null {
  if (!input) return null
  if (typeof input.content === 'string') {
    return agentContentRefusal(filePath, currentTextOrNull(isAbsolute(filePath) ? filePath : resolve(cwd, filePath)), input.content)
  }
  if (typeof input.new_string === 'string') return agentContentRefusal(filePath, input.old_string ?? '', input.new_string)
  return null
}

/** The file's text, or `null` when there is none to read (a new file). */
function currentTextOrNull(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}
