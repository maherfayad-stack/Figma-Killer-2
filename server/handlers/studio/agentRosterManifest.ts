/**
 * agentRosterManifest — perf-06: the regeneration fingerprint + manifest
 * mechanics for `agentRoster.ts`'s subagent roster generator, split out into
 * its own module to keep that file under the 700-line module-size ceiling
 * (`module-size-budgets.test.ts`) — this module has its own reason to change
 * (the gate mechanics) distinct from `agentRoster.ts`'s (the roster/
 * reference-file DEFINITIONS), so the split is a real seam, not a dodge.
 *
 * ## The gate, in one paragraph
 *
 * `generateStudioAgentRoster` used to rebuild ten agents' worth of markdown
 * plus 7 reference files, hash and compare each of the 17 targets against
 * the on-disk manifest, and rewrite the manifest — on EVERY real chat turn,
 * even when nothing had changed. Measured on a real 46-file design-system
 * corpus: ~19ms warm. This module gates that whole rebuild behind two cheap,
 * INDEPENDENT checks, both required:
 *
 * 1. {@link computeRosterFingerprint} — a hash of everything the roster's
 *    OUTPUT depends on (the resolved `ProjectProfile`, the design-system
 *    CSS stat key, the ALM package docs' stat witness, a roster-definition
 *    version). A matching fingerprint proves the content `agentRoster.ts`
 *    would produce is byte-identical to what it produced last time — no
 *    content build, no reads, no hashing needed to know that.
 * 2. {@link allOwnedFilesUnchangedSince} — a cheap `statSync` per target
 *    file, comparing size+mtime against what was recorded at the last write.
 *    This is the clobber-protection half: the fingerprint only covers
 *    INPUTS, so it cannot see a user hand-editing an OUTPUT file
 *    (`.claude/agents/screen-scout.md`) with nothing else having changed. A
 *    stat mismatch forces the full rebuild, which is what lets the existing
 *    hash-comparison loop in `agentRoster.ts` detect and report the edit —
 *    exactly the never-clobber contract `agentRoster.test.ts` already
 *    covers, extended (not weakened) by this gate.
 *
 * Measured warm-path result: ~19ms → ~2-3ms (`bun run bench:agent-turn`).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { joinAppRoot } from './appRoot'
import { readTextCapped } from './cappedFileRead'
import { computeDesignSystemCacheKey } from './designSystemDigest'
import { mcpServerFingerprintWitness } from './agentRosterMcpTools'
import type { ProjectProfile } from './projectProfileSchema'

export const MANIFEST_PATH = join('.claude', '.studio-generated.json')

/** The one component package `agentRoster.ts`'s `almosafer-ds-expert` embeds docs from — shared here so the fingerprint's ALM stat witness and `agentRoster.ts`'s own `installed` check never drift apart. */
export const ALM_PACKAGE = '@alm-design/design-system'

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Bump whenever the roster definitions themselves change — a new/removed
 * agent, a different tool allowlist, a rewritten prompt body, a changed
 * static reference file. Folded into {@link computeRosterFingerprint} so a
 * Studio UPGRADE (not a project change) still forces one full regeneration
 * rather than the fast path silently serving whatever an older version last
 * wrote.
 *
 * `2` — mcp-tooling's fix added the project-conditional `figma-asset-scout`
 * agent and `figma.md` reference file, and a subagent can now hold a vetted
 * `mcp__<server>__<tool>` name (`agentRosterMcpTools.ts`).
 *
 * `3` — `agent-01` added the project-conditional `design-system.md` reference
 * file and rewrote `almosafer-ds-expert`'s prompt to point at it. Missing this
 * bump is exactly the failure this constant exists to prevent, and it bit:
 * every project carrying a v2 manifest kept taking the fast path, so
 * `design-system.md` was never written, while the regenerated prompt told the
 * agent to read it. The agent then burned turns on a file that could not
 * appear — `studio_read_file` correctly reporting "does not exist" over and
 * over. **Adding or removing a generated file means bumping this.**
 */
export const ROSTER_DEFINITION_VERSION = 3

export interface ManifestFileEntry {
  /** Content hash of what Studio itself last wrote (or last observed) here. */
  hash: string
  /** `statSync(...).size` at the moment `hash` was recorded. */
  size: number
  /** `statSync(...).mtimeMs` at the moment `hash` was recorded. */
  mtimeMs: number
}

export interface GeneratedManifest {
  /** {@link computeRosterFingerprint} at the last FULL regeneration, or `undefined` for a pre-perf-06 manifest (treated as "always stale" — one full regen, then this is populated). */
  fingerprint?: string
  files: Record<string, ManifestFileEntry>
}

const EMPTY_MANIFEST: GeneratedManifest = { files: {} }

export function readManifest(dir: string): GeneratedManifest {
  const path = join(dir, MANIFEST_PATH)
  const text = readTextCapped(path, 1_000_000)
  if (text === undefined) return EMPTY_MANIFEST
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_MANIFEST
    const { fingerprint, files } = parsed as { fingerprint?: unknown; files?: unknown }
    if (!files || typeof files !== 'object' || Array.isArray(files)) return EMPTY_MANIFEST
    return {
      ...(typeof fingerprint === 'string' ? { fingerprint } : {}),
      files: files as Record<string, ManifestFileEntry>,
    }
  } catch {
    return EMPTY_MANIFEST
  }
}

export function writeManifest(dir: string, manifest: GeneratedManifest): void {
  const path = join(dir, MANIFEST_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(manifest, null, 2))
}

/**
 * Cheap stat-based witness for the two package doc files
 * `almosafer-ds-expert` (`agentRoster.ts`) embeds verbatim into its prompt —
 * their CONTENT is never hashed here (that would mean reading them just to
 * decide whether to skip reading them), only whether either file's
 * size/mtime moved since the last fingerprint. `'none'` when the package
 * isn't installed, matching `almosafer-ds-expert`'s own `installed` check.
 */
function almPackageDocsStatWitness(dir: string, profile: ProjectProfile): string {
  if (!profile.componentPackages.includes(ALM_PACKAGE)) return 'none'
  const appRoot = joinAppRoot(dir, profile.appRoot)
  const pkgDir = join(appRoot, 'node_modules', '@alm-design', 'design-system')
  const stat = (relFile: string): string => {
    try {
      const s = statSync(join(pkgDir, relFile))
      return `${s.size}:${s.mtimeMs}`
    } catch {
      return 'absent'
    }
  }
  return `${stat('CLAUDE.md')}|${stat('design.md')}`
}

/**
 * A cheap fingerprint of everything the roster generator's OUTPUT depends on
 * — never the output content itself. Two runs with the same fingerprint are
 * guaranteed to produce byte-identical `buildRoster`/`buildReferenceFiles`
 * output, so a matching fingerprint means the expensive parts (building 17
 * files' worth of markdown, hashing each, reading each existing file to
 * compare) can be skipped entirely — see `generateStudioAgentRoster`'s own
 * comment for why a matching fingerprint alone is NOT sufficient to skip (a
 * hand-edited output file must still be caught by {@link allOwnedFilesUnchangedSince}).
 *
 * `JSON.stringify(profile)` stands in for "every field `buildRoster`/
 * `buildReferenceFiles` reads from the profile" rather than naming each one
 * — profile is already a small, fully-resolved in-memory object at this
 * point (no extra I/O), and this way a future field this generator starts
 * reading is automatically covered without a matching edit here.
 * `computeDesignSystemCacheKey` reuses the exact stat-based CSS fingerprint
 * `getOrBuildDesignSystemDigest` already computes for its own cache, so this
 * costs nothing beyond what that call already pays when it does run.
 * `mcpServerFingerprintWitness` (`agentRosterMcpTools.ts`) folds in every
 * approved MCP server's name/approved/summary — without it, approving or
 * revoking a project MCP server (which changes both which subagents get an
 * `mcp__*` grant AND whether `figma-asset-scout`/`figma.md` exist at all)
 * would go silently stale behind the fast path until something ELSE in the
 * profile happened to change too.
 */
export function computeRosterFingerprint(dir: string, profile: ProjectProfile): string {
  const hash = createHash('sha1')
  hash.update(`v${ROSTER_DEFINITION_VERSION}`)
  hash.update(JSON.stringify(profile))
  hash.update(computeDesignSystemCacheKey(dir, profile.designSystems ?? []))
  hash.update(almPackageDocsStatWitness(dir, profile))
  hash.update(mcpServerFingerprintWitness(dir))
  return hash.digest('hex').slice(0, 16)
}

/**
 * The clobber-protection half of the gate (independent of the fingerprint
 * above): does every file the manifest believes Studio owns still have the
 * exact size + mtime it had when that hash was recorded? A single stat
 * mismatch — hand-edited, deleted, touched by something else — means "we
 * cannot trust the fast path," never a silent false negative: an empty
 * manifest (first run, or a manifest that failed to parse) returns `false`
 * unconditionally, forcing the full path.
 */
export function allOwnedFilesUnchangedSince(dir: string, files: Record<string, ManifestFileEntry>): boolean {
  const entries = Object.entries(files)
  if (entries.length === 0) return false
  for (const [relPath, entry] of entries) {
    try {
      const stat = statSync(join(dir, relPath))
      if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) return false
    } catch {
      return false
    }
  }
  return true
}
