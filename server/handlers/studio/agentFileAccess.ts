/**
 * agentFileAccess — the ONE containment rule every agent file tool goes
 * through: `studio_read_file`, `studio_grep`, `studio_get_node_source`, and
 * the API-key path's `studio_write_file` / `studio_edit_file` /
 * `studio_edit_files` (P4-C, AI-2).
 *
 * ## Why one rule
 *
 * The `claude` CLI path authors files with its own native tools, bounded by
 * the subprocess `cwd` plus the `PreToolUse` deny hook (`agentWriteScope.ts`).
 * The HTTP drivers have no process to bound, so every path a model names
 * arrives here as a string, and this module decides where — if anywhere — it
 * lands. Before it, the two read tools each had their own check and they had
 * drifted: `studio_read_file` compared its excluded directories
 * case-sensitively (`.GIT/config` read git's config on Windows), and
 * `studio_get_node_source` joined a node id's file part onto the project with
 * no check at all (`../../x:1:1` read outside the project).
 *
 * ## What it refuses, in order
 *
 *   1. **Not a path inside the project, lexically.** Longer than
 *      `AGENT_PATH_MAX_CHARS` (or a segment over 255), empty, a NUL byte, a `..`
 *      segment, a `:` inside a segment (an NTFS alternate data stream), a
 *      Windows device name (`CON`, `NUL`, `COM1.tsx` — a read of one blocks on
 *      the console), or an absolute path that is not under the project. An
 *      absolute path INSIDE the project is accepted and made relative: models
 *      trained on native file tools send them, and refusing a correct target
 *      over its spelling only buys a wasted round. A write also refuses a
 *      name ending in a dot or a space (Windows tools cannot open it).
 *   2. **A protected directory**, compared the way the filesystem resolves a
 *      name (case-folded, trailing dots and NTFS stream suffixes dropped —
 *      `@core/page-parser`'s shared sets). Reads refuse the walk exclusions
 *      (`.studio`, `.git`, `node_modules`, build output); writes refuse those
 *      plus `.claude` — `agentWriteRefusal`, the SAME gate the CLI path's
 *      hook enforces.
 *   3. **A file that runs on the host** (`hostExecutedWorkspaceFile`: build
 *      config, `package.json`, env and package-manager config, git hooks,
 *      `.vscode/`, CI workflows, `CLAUDE.md`), for writes: `needs-user` — the
 *      agent shows the change and the user makes or approves it. Also part of
 *      `agentWriteRefusal`, so the CLI path asks too. This removes the
 *      zero-click path from one write to host execution; it is NOT a sandbox —
 *      anything such a config imports still runs in Node.
 *   4. **A secret-bearing file name** (`.env`, `.npmrc`, key material), for
 *      reads: a tool result is a transcript line a provider stores. Writes of
 *      the env and package-manager ones are `needs-user` (3), of key material
 *      `protected-path`.
 *   5. **Anything the REAL path says otherwise.** Symlinks and junctions are
 *      resolved (on-disk casing restored, 8.3 names expanded) and 2–4 are
 *      re-applied to where the access would actually land. A link that
 *      escapes the project, or that dangles (a write would follow it), is
 *      refused. Writes additionally pass `isWorkspaceWritablePath`, the
 *      predicate every other Studio writer uses, as the final word.
 *
 * `rel` in a success is the REAL project-relative path, POSIX-separated —
 * the spelling the turn-write log, the live-reload push and every page id
 * derivation already use. A model that wrote `Pages/home.tsx` on a
 * case-insensitive disk gets back `pages/Home.tsx`.
 *
 * What it does not defend against: a symlink swapped in between this check
 * and the write (the agent has no tool that makes links; anything that can is
 * already running as the user), and a hard link to a file outside the
 * project, which no path check can see — the write tools refuse a target with
 * more than one link themselves (`hasOtherHardLinks`).
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  excludedWorkspaceSegment,
  isSecretBearingFileName,
  isWorkspaceWritablePath,
  realWorkspaceRel,
  stripTrailingDotsAndSpaces,
} from '@core/page-parser'
import { agentContentRefusal, agentWriteRefusal } from './agentWriteScope'

/**
 * Longest path, and longest single segment, a model may name. Far above any
 * real project path (Windows' own MAX_PATH is 260) and small enough that no
 * per-path work can become a denial of service (security review of #233, F1).
 * The tool schemas carry the same number as `maxLength`.
 */
export const AGENT_PATH_MAX_CHARS = 1024
const AGENT_PATH_SEGMENT_MAX_CHARS = 255

export type AgentFileIntent = 'read' | 'write'

export interface AgentFileTarget {
  readonly ok: true
  /** Absolute path the access goes to — the textual join, which the real-path checks proved lands where `rel` says. */
  readonly abs: string
  /** The real project-relative path, POSIX-separated, on-disk casing. */
  readonly rel: string
}

export interface AgentFileRefusal {
  readonly ok: false
  readonly code: 'path-outside-project' | 'protected-path' | 'needs-user'
  readonly message: string
  readonly remedy: string
}

const OUTSIDE_REMEDY =
  'Pass a path inside the open project, relative to its root (e.g. "pages/Home.tsx"). ".." segments, other projects, and links that lead out of the project are refused.'

const PROTECTED_REMEDY =
  'Studio owns .studio/, .claude/ and .git/, node_modules/ and build output are not source, and credential files are never handed to a model. Work on the project\'s own source files instead.'

function outside(rawPath: string, why: string): AgentFileRefusal {
  return { ok: false, code: 'path-outside-project', message: `"${rawPath}" ${why}.`, remedy: OUTSIDE_REMEDY }
}

/**
 * The content half of the one agent write gate (`agentContentRefusal`) for
 * the HTTP file tools: `after` may not add what makes the host load a module.
 * `before` is the file's current text, `null` for a new file.
 */
export function agentWriteContentRefusal(rel: string, before: string | null, after: string): AgentFileRefusal | null {
  const refusal = agentContentRefusal(rel, before, after)
  return refusal === null ? null : needsUser(refusal.message)
}

/** A host-executed file: the agent shows the change and the user makes it (`hostExecutedWorkspaceFile`). */
function needsUser(message: string): AgentFileRefusal {
  return {
    ok: false,
    code: 'needs-user',
    message,
    remedy: 'Show the user the exact change (the file and the lines) in your reply and ask them to make or approve it; do not look for another way to write it.',
  }
}

function protectedPath(rawPath: string, why: string): AgentFileRefusal {
  return { ok: false, code: 'protected-path', message: `"${rawPath}" ${why}.`, remedy: PROTECTED_REMEDY }
}

/** `con`, `NUL.txt`, `com1.tsx`, `LPT9 ` — Windows reserved device names, whatever the extension. */
function isWindowsDeviceName(segment: string): boolean {
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i.test(stripTrailingDotsAndSpaces(segment))
}

/** The protected-directory or secret-file reason for a project-relative path, or `null`. Pure. */
function lexicalDenial(rel: string, intent: AgentFileIntent): string | null {
  const segments = rel.split('/')
  const dirHit = intent === 'read' ? excludedWorkspaceSegment(rel) : null
  if (dirHit !== null) return `is inside "${dirHit}/", which is not project source and is never read by an agent tool`
  const name = segments[segments.length - 1] ?? ''
  if (isSecretBearingFileName(name)) return 'is a credential file (an env file, an auth config or key material), which no agent tool reads or writes'
  return null
}

/**
 * Resolve a model-supplied path against the project at `dir` (already a
 * validated Studio project root). See the module doc for the rules.
 */
export function resolveAgentFilePath(
  dir: string,
  rawPath: string,
  intent: AgentFileIntent,
): AgentFileTarget | AgentFileRefusal {
  if (rawPath.length === 0 || rawPath.includes('\0')) return outside(rawPath, 'is not a usable path')
  // Before any other work: nothing below may ever see an unbounded string.
  if (rawPath.length > AGENT_PATH_MAX_CHARS) return outside(`${rawPath.slice(0, 80)}…`, `is longer than ${AGENT_PATH_MAX_CHARS} characters`)

  const root = resolve(dir)
  let relInput = rawPath
  if (isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath) || rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
    const fromRoot = relative(root, resolve(rawPath))
    if (fromRoot === '' || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      return outside(rawPath, 'is not inside the open project')
    }
    relInput = fromRoot
  }

  const segments = relInput.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return outside(rawPath, 'names the project root, not a file in it')
  if (segments.some((segment) => segment.length > AGENT_PATH_SEGMENT_MAX_CHARS)) {
    return outside(rawPath, `has a name longer than ${AGENT_PATH_SEGMENT_MAX_CHARS} characters`)
  }
  if (segments.some((segment) => segment === '..')) return outside(rawPath, 'climbs out of the project with ".."')
  // A colon inside a segment is an NTFS alternate data stream (or a drive) on
  // Windows — a hidden second body behind an innocent file name.
  if (segments.some((segment) => segment.includes(':'))) return outside(rawPath, 'names a data stream or a drive (":" inside a path segment)')
  // CON, NUL, COM1… are devices on Windows, with any extension: a read of
  // one blocks on the console, a write goes nowhere or to a port.
  if (process.platform === 'win32' && segments.some(isWindowsDeviceName)) return outside(rawPath, 'names a Windows device (CON, NUL, COM1…), not a file')
  // A name ending in a dot or a space, or made only of dots, is created
  // literally under Bun (it writes through the \\?\ prefix) and then cannot be
  // opened or deleted by Explorer, git for Windows or Node (review of #233, F4).
  if (intent === 'write' && segments.some((segment) => stripTrailingDotsAndSpaces(segment) !== segment)) {
    return outside(rawPath, 'has a name ending in a dot or a space, which Windows tools cannot open')
  }
  const lexicalRel = segments.join('/')

  // A read refuses protected directories and credential files by name first.
  // A write asks the one agent write gate below, which also knows which files
  // need the user — so an env file refuses as needs-user, not as unreadable.
  const lexical = intent === 'read' ? lexicalDenial(lexicalRel, intent) : null
  if (lexical !== null) return protectedPath(rawPath, lexical)

  const abs = join(root, ...segments)
  const realRel = realWorkspaceRel(root, abs)
  if (realRel === null) return outside(rawPath, 'resolves outside the project (through a symlink or junction), or through a link that points nowhere')

  // The CLI path's own write gate, on the textual AND the real path: one
  // predicate for both ways an agent can write. A dangling link cannot reach
  // this line, because `realWorkspaceRel` already refused it.
  if (intent === 'write') {
    const refusal = agentWriteRefusal(lexicalRel, root)
    if (refusal?.code === 'needs-user') return needsUser(refusal.message)
    if (refusal !== null) return { ok: false, code: 'protected-path', message: refusal.message, remedy: PROTECTED_REMEDY }
  }
  const real = lexicalDenial(realRel, intent)
  if (real !== null) return protectedPath(rawPath, `resolves to "${realRel}", which ${real}`)

  if (intent === 'write' && !isWorkspaceWritablePath(root, abs)) {
    return protectedPath(rawPath, 'is not a path Studio may write')
  }
  return { ok: true, abs, rel: realRel }
}

// ---------------------------------------------------------------------------
// Text content
// ---------------------------------------------------------------------------

/**
 * The version tag a read hands out and a write checks: the first 16 hex of
 * the sha256 of the file's bytes. Short on purpose — a model copies it back,
 * and it guards against staleness, not against an adversary.
 */
export function contentHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** Why a file's bytes cannot be handled as text, or `null` when they can. */
export function nonTextReason(bytes: Buffer): string | null {
  const probe = bytes.subarray(0, 8_000)
  if (probe.includes(0)) return 'is a binary file'
  // A round-trip mismatch means the bytes are not valid UTF-8: decoding would
  // replace them with U+FFFD, and writing the decoded text back would corrupt
  // the file silently.
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return 'is not valid UTF-8 text'
  return null
}

export type TextFileRead =
  | { readonly kind: 'text'; readonly content: string; readonly hash: string; readonly bytes: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'not-text'; readonly reason: string }

/** `statSync` that answers `undefined` for a path that is not there. */
export function statIfPresent(abs: string): Stats | undefined {
  try {
    return statSync(abs)
  } catch {
    return undefined
  }
}

/** Read a contained file as UTF-8 text, refusing anything it cannot hand back byte-faithfully. */
export function readTextFile(abs: string, maxBytes: number): TextFileRead {
  const stat = statIfPresent(abs)
  if (!stat) return { kind: 'missing' }
  if (!stat.isFile()) return { kind: 'not-a-file' }
  if (stat.size > maxBytes) return { kind: 'too-large', bytes: stat.size }
  const bytes = readFileSync(abs)
  const reason = nonTextReason(bytes)
  if (reason !== null) return { kind: 'not-text', reason }
  return { kind: 'text', content: bytes.toString('utf8'), hash: contentHash(bytes), bytes: bytes.length }
}

/**
 * A file with more than one directory entry is a hard link: a write through
 * this name changes every other name too, and one of them may be outside the
 * project. No path check can see that, so the writers ask the inode.
 */
export function hasOtherHardLinks(stat: Stats): boolean {
  return stat.nlink > 1
}
