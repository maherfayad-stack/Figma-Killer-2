/**
 * projectGuideManifest — perf-06: the regeneration fingerprint + manifest
 * mechanics for `projectGuide.ts`'s generated-file writer, split out into
 * its own module to keep that file under the 700-line module-size ceiling
 * (`module-size-budgets.test.ts`) — this module has its own reason to change
 * (the gate mechanics) distinct from `projectGuide.ts`'s (the roster/
 * reference-file DEFINITIONS), so the split is a real seam, not a dodge.
 *
 * ## The gate, in one paragraph
 *
 * `generateStudioProjectGuide` used to rebuild every generated file's markdown,
 * hash and compare each target against
 * the on-disk manifest, and rewrite the manifest — on EVERY real chat turn,
 * even when nothing had changed. Measured on a real 46-file design-system
 * corpus: ~19ms warm. This module gates that whole rebuild behind two cheap,
 * INDEPENDENT checks, both required:
 *
 * 1. {@link computeProjectGuideFingerprint} — a hash of everything the roster's
 *    OUTPUT depends on (the resolved `ProjectProfile`, the design-system
 *    CSS stat key, the ALM package docs' stat witness, a roster-definition
 *    version). A matching fingerprint proves the content `projectGuide.ts`
 *    would produce is byte-identical to what it produced last time — no
 *    content build, no reads, no hashing needed to know that.
 * 2. {@link allOwnedFilesUnchangedSince} — a cheap `statSync` per target
 *    file, comparing size+mtime against what was recorded at the last write.
 *    This is the clobber-protection half: the fingerprint only covers
 *    INPUTS, so it cannot see a user hand-editing an OUTPUT file
 *    (`CLAUDE.md`) with nothing else having changed. A
 *    stat mismatch forces the full rebuild, which is what lets the existing
 *    hash-comparison loop in `projectGuide.ts` detect and report the edit —
 *    exactly the never-clobber contract `projectGuide.test.ts` already
 *    covers, extended (not weakened) by this gate.
 *
 * Measured warm-path result: ~19ms → ~2-3ms (`bun run bench:agent-turn`).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { joinAppRoot } from './appRoot'
import { readTextCapped } from './cappedFileRead'
import { computeDesignSystemCacheKey } from './designSystemDigest'
import { mcpServerFingerprintWitness } from './projectMcpApprovals'
import type { ProjectProfile } from './projectProfileSchema'

export const MANIFEST_PATH = join('.claude', '.studio-generated.json')

/** The design-system package whose own docs the guide embeds — shared here so the fingerprint's stat witness and `projectGuide.ts`'s own `installed` check never drift apart. */
export const ALM_PACKAGE = '@alm-design/design-system'

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Bump whenever the roster definitions themselves change — a new/removed
 * agent, a different tool allowlist, a rewritten prompt body, a changed
 * static reference file. Folded into {@link computeProjectGuideFingerprint} so a
 * Studio UPGRADE (not a project change) still forces one full regeneration
 * rather than the fast path silently serving whatever an older version last
 * wrote.
 *
 * `2` — mcp-tooling's fix added the project-conditional `figma-asset-scout`
 * agent and `figma.md` reference file, and a subagent can now hold a vetted
 * `mcp__<server>__<tool>` name (`projectMcpApprovals.ts`).
 *
 * `3` — added the project-conditional `design-system.md` reference file.
 * Missing this bump is exactly the failure this constant exists to prevent,
 * and it bit: every project carrying a v2 manifest kept taking the fast path,
 * so `design-system.md` was never written, while the regenerated prompt told
 * the agent to read it. The agent then burned turns on a file that could not
 * appear. **Adding or removing a generated file means bumping this.**
 *
 * `4` — the subagent roster was replaced by the project's own generated
 * `CLAUDE.md` plus `.claude/design-system-components.md` (`projectGuide.ts`).
 * Eleven agent definitions and six reference files stopped being targets and
 * two new ones started; without this bump every existing project would keep
 * serving a roster describing tools the agent no longer holds.
 *
 * `5` — added `.claude/design-system-icons.md`. The guide previously told
 * the agent "the package ships a real icon set; import from it" while naming
 * no export and no path — an instruction that cannot be followed, so it
 * hand-drew SVG path data for icons the package already exports by name.
 *
 * `7` — `.claude/design-system-icons.md`'s CONTENT changed: it emitted the
 * packaged-URL import (`<img src={u}/>`), which resolves to nothing in Studio
 * and drew an empty box for all 376 of the ALM package's SVGs, and now emits
 * the `?raw` form that actually renders. This is a content-only change with
 * no file added or removed, which is precisely the case that looks like it
 * does not need a bump and does: without it every existing project keeps
 * taking the fast path and keeps serving the broken snippet. Same bump also
 * covers the one-time legacy sweep ({@link LEGACY_GUIDE_ARTEFACTS}).
 */
export const GUIDE_DEFINITION_VERSION = 7

export interface ManifestFileEntry {
  /** Content hash of what Studio itself last wrote (or last observed) here. */
  hash: string
  /** `statSync(...).size` at the moment `hash` was recorded. */
  size: number
  /** `statSync(...).mtimeMs` at the moment `hash` was recorded. */
  mtimeMs: number
}

export interface GeneratedManifest {
  /** {@link computeProjectGuideFingerprint} at the last FULL regeneration, or `undefined` for a pre-perf-06 manifest (treated as "always stale" — one full regen, then this is populated). */
  fingerprint?: string
  files: Record<string, ManifestFileEntry>
  /**
   * Legacy artefacts already swept from this project — see
   * {@link LEGACY_GUIDE_ARTEFACTS}. Recorded so the sweep runs EXACTLY ONCE
   * per path per project: a user who later writes their own
   * `.claude/figma.md` must keep it, and a delete-by-name that ran every
   * turn would silently eat it forever.
   */
  prunedLegacyArtefacts?: string[]
}

/**
 * A FRESH empty manifest per call, never one shared constant.
 *
 * `readManifest` returns this for a project with no manifest yet, and callers
 * MUTATE what it returns (`pruneLegacyGuideArtefacts` records its sweep on
 * it). A single shared object meant the first project handled in a server
 * process wrote its state into the value every later project received — so
 * project #2 onward would read "already swept" and never be swept at all,
 * with nothing on disk to explain why. Caught by three sequential
 * generations against three fresh temp dirs.
 */
function emptyManifest(): GeneratedManifest {
  return { files: {} }
}

/**
 * Files a PREVIOUS version of the guide generator wrote and this one does
 * not — deleted once per project, then never touched again.
 *
 * `agent-04` replaced the subagent roster with the generated `CLAUDE.md` +
 * design-system references, and recorded the decision this fixes: "Files the
 * old roster wrote simply stop being targets; they are deliberately not
 * deleted." Not deleting them left them on disk — and **the CLI loads every
 * file under `.claude/` from its cwd**, so they never stopped being read.
 *
 * Measured on a real project: 12 orphans, ~40 KB, describing a subsystem that
 * no longer exists. `figma.md` opens "An approved Figma-capable MCP server
 * ('figma') is connected for this project" and walks through a six-step
 * node-id workflow — which is what sent the agent to `get_design_context`
 * for node ids it could not resolve — and closes by handing the result to
 * `screen-builder`, one of eleven subagents in `.claude/agents/` that were
 * deleted a version ago. Stale instructions do not go quiet; they compete
 * with the current ones and they win whenever they are more specific.
 *
 * Deleted by NAME, because the manifest records only what the CURRENT
 * generator owns — the hash records for these were dropped when they stopped
 * being targets, so there is nothing left to hash-verify against. That is
 * the trade this list makes explicit: a hand-edited copy of a file
 * describing a removed subsystem is still describing a removed subsystem, so
 * keeping it is not the safe option. The once-per-project record above is
 * what keeps the sweep from becoming a recurring delete.
 */
export const LEGACY_GUIDE_ARTEFACTS: readonly string[] = [
  join('.claude', 'figma.md'),
  join('.claude', 'studio-tools.md'),
  join('.claude', 'studio-design-principles.md'),
  join('.claude', 'studio-invariants.md'),
  join('.claude', 'canonical-jsx.md'),
  join('.claude', 'node-ids-and-writeback.md'),
  join('.claude', 'project-conventions.md'),
  join('.claude', 'agents', 'agent-creator.md'),
  join('.claude', 'agents', 'almosafer-ds-expert.md'),
  join('.claude', 'agents', 'arabic-ux-writer.md'),
  join('.claude', 'agents', 'design-critic.md'),
  join('.claude', 'agents', 'fidelity-auditor.md'),
  join('.claude', 'agents', 'figma-asset-scout.md'),
  join('.claude', 'agents', 'screen-builder.md'),
  join('.claude', 'agents', 'screen-scout.md'),
  join('.claude', 'agents', 'style-surgeon.md'),
  join('.claude', 'agents', 'synthesizer.md'),
  join('.claude', 'agents', 'system-prompt-expert.md'),
]

export interface PruneLegacyArtefactsResult {
  /** Paths deleted by this call. */
  readonly removed: string[]
  /** True when the manifest needs writing back — i.e. this call swept anything it had not swept before. */
  readonly manifestChanged: boolean
}

/**
 * Delete any {@link LEGACY_GUIDE_ARTEFACTS} not yet swept from this project,
 * and mark every one of them swept.
 *
 * Marks paths swept whether or not a file was actually there, so a project
 * that never had them costs one manifest write and then nothing. Mutates
 * `manifest.prunedLegacyArtefacts` in place; the caller owns persisting it.
 *
 * Never throws — a guide sweep must not be able to fail a chat turn.
 */
export function pruneLegacyGuideArtefacts(dir: string, manifest: GeneratedManifest): PruneLegacyArtefactsResult {
  const alreadyPruned = new Set(manifest.prunedLegacyArtefacts ?? [])
  const outstanding = LEGACY_GUIDE_ARTEFACTS.filter((rel) => !alreadyPruned.has(rel))
  if (outstanding.length === 0) return { removed: [], manifestChanged: false }

  const removed: string[] = []
  for (const rel of outstanding) {
    const abs = join(dir, rel)
    try {
      // Existence is checked BEFORE the delete because `force: true` does not
      // throw for a missing path — without this, every project would report
      // all 18 artefacts "removed" on its first sweep, including the ones it
      // never had.
      if (existsSync(abs)) {
        rmSync(abs, { force: true })
        removed.push(rel)
      }
    } catch (err) {
      console.error('[projectGuideManifest] could not prune legacy artefact', rel, err)
    }
    alreadyPruned.add(rel)
  }

  manifest.prunedLegacyArtefacts = [...alreadyPruned].sort()
  return { removed, manifestChanged: true }
}

export function readManifest(dir: string): GeneratedManifest {
  const path = join(dir, MANIFEST_PATH)
  const text = readTextCapped(path, 1_000_000)
  if (text === undefined) return emptyManifest()
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyManifest()
    const { fingerprint, files, prunedLegacyArtefacts } = parsed as {
      fingerprint?: unknown
      files?: unknown
      prunedLegacyArtefacts?: unknown
    }
    if (!files || typeof files !== 'object' || Array.isArray(files)) return emptyManifest()
    return {
      ...(typeof fingerprint === 'string' ? { fingerprint } : {}),
      files: files as Record<string, ManifestFileEntry>,
      // Dropping this on read would re-run the sweep every turn, which is
      // exactly the recurring delete the once-per-project record exists to
      // prevent.
      ...(Array.isArray(prunedLegacyArtefacts)
        ? { prunedLegacyArtefacts: prunedLegacyArtefacts.filter((v): v is string => typeof v === 'string') }
        : {}),
    }
  } catch {
    return emptyManifest()
  }
}

export function writeManifest(dir: string, manifest: GeneratedManifest): void {
  const path = join(dir, MANIFEST_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(manifest, null, 2))
}

/**
 * Cheap stat-based witness for the two package doc files
 * `designSystemGuide.ts` reads to build the component reference —
 * their CONTENT is never hashed here (that would mean reading them just to
 * decide whether to skip reading them), only whether either file's
 * size/mtime moved since the last fingerprint. `'none'` when the package
 * isn't installed, matching `projectGuide.ts`'s own `installed` check.
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
 * guaranteed to produce byte-identical `buildGuideFiles`
 * output, so a matching fingerprint means the expensive parts (building every
 * generated file's markdown, hashing each, reading each existing file to
 * compare) can be skipped entirely — see `generateStudioProjectGuide`'s own
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
 * `mcpServerFingerprintWitness` (`projectMcpApprovals.ts`) folds in every
 * approved MCP server's name/approved/summary — without it, approving or
 * revoking a project MCP server (which changes both which subagents get an
 * `mcp__*` grant AND whether `figma-asset-scout`/`figma.md` exist at all)
 * would go silently stale behind the fast path until something ELSE in the
 * profile happened to change too.
 */
export function computeProjectGuideFingerprint(dir: string, profile: ProjectProfile): string {
  const hash = createHash('sha1')
  hash.update(`v${GUIDE_DEFINITION_VERSION}`)
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
