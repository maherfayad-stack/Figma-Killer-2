/**
 * projectSeed — the content every newly-created Studio project starts with,
 * beyond its own starter page.
 *
 * ## Why this exists
 *
 * "New project" scaffolded `pages/Home.tsx`, its stylesheet, and
 * `.studio/meta.json` — nothing else. No `package.json`, no `node_modules`, no
 * design system. The consequences only surfaced once an agent tried to build
 * in one of those projects:
 *
 *   - `componentPackages` resolves to `[]`, so there is no design-system
 *     COMPONENT to reach for and `studio_list_components` is empty.
 *   - `.claude/design-system.md` generates with nothing to index, so the
 *     agent's main discovery route is blank.
 *   - Reaching for the design system anyway means writing an import for a
 *     package that is not installed, which resolves to nothing and breaks the
 *     user's build — observed exactly that way.
 *
 * The alternative the agent falls back to is re-implementing the design system
 * by hand in inline styles with raw hex, which is both wrong and what made a
 * generated screen not match its Figma source.
 *
 * ## A copied cache, not an install
 *
 * The seed is COPIED from a local directory, never fetched and never executed.
 * That matters for two reasons:
 *
 *   1. **Trust tier.** A new project is Tier 0 (`DEFAULT_TRUST_TIER`), where
 *      running the project's own toolchain — including a package manager — is
 *      refused (`installDeps.ts`). Copying bytes runs nothing, so it is
 *      Tier-0-safe by construction and needs no promotion.
 *   2. **Determinism and offline.** Project creation is a UI click that must
 *      not depend on a registry being reachable, or take the 30s–3min a real
 *      install does.
 *
 * A symlink to one shared copy would be cheaper on disk and is deliberately
 * NOT used: Studio's own path guards containment-check the REAL path after
 * resolving symlinks (`isRealpathContained`, `resolveSafeWorkspaceFile`), so a
 * link pointing outside the project is rejected by the very rules that keep a
 * malicious import from escaping the workspace. Weakening those to save disk
 * would be a bad trade.
 *
 * ## Layout
 *
 * The seed directory is just a partial project — whatever top-level entries it
 * holds are copied in as-is (`node_modules/`, `styles/imported/`,
 * `package.json`, …). Adding to the seed later needs no change here.
 *
 * Seeding is BEST-EFFORT and never fatal: an absent or unreadable seed leaves
 * the project exactly as it would have been before this existed. Creating a
 * project must not fail because an optional convenience is missing.
 */
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Where the seed lives. `.data/` is already the private, git-ignored home for local runtime state (the Claude CLI config dir sits beside it). */
export function resolveProjectSeedDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.STUDIO_PROJECT_SEED_DIR
  return configured ? resolve(configured) : resolve(process.cwd(), '.data', 'studio-seed')
}

export interface ProjectSeedResult {
  /** Top-level entries actually copied, in the order they were applied. */
  copied: string[]
  /** Entries skipped because the new project already had them — the scaffolder's own files always win. */
  skipped: string[]
}

/**
 * Copy the seed into `projectDir`.
 *
 * An entry the project ALREADY has is skipped rather than overwritten: the
 * project scaffolder writes `pages/` and `.studio/` first, and those are the
 * authoritative ones. This ordering is what lets the seed carry a `pages/`
 * directory in future without clobbering the starter page.
 */
export function applyProjectSeed(
  projectDir: string,
  seedDir: string = resolveProjectSeedDir(),
): ProjectSeedResult {
  const result: ProjectSeedResult = { copied: [], skipped: [] }
  if (!existsSync(seedDir) || !statSync(seedDir).isDirectory()) return result

  for (const entry of readdirSync(seedDir)) {
    const target = join(projectDir, entry)
    if (existsSync(target)) {
      result.skipped.push(entry)
      continue
    }
    try {
      cpSync(join(seedDir, entry), target, { recursive: true, dereference: true })
      result.copied.push(entry)
    } catch (err) {
      // One unreadable entry must not abort the rest of the seed, and must
      // never fail the project creation that called this.
      console.error(`[studio/projectSeed] failed to copy "${entry}":`, err)
    }
  }

  return result
}
