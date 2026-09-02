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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Where a PREPARED seed lives, when one exists. `.data/` is already the
 * private, git-ignored home for local runtime state (the Claude CLI config dir
 * sits beside it). When this directory is absent — the normal case, since
 * nothing populates it automatically — {@link applyProjectSeed} falls back to
 * copying the design system out of Studio's own `node_modules`.
 */
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
  if (!existsSync(seedDir) || !statSync(seedDir).isDirectory()) {
    return seedFromAppInstall(projectDir, result)
  }

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

/** The design system every Studio project is expected to build with. */
const SEED_PACKAGE = '@alm-design/design-system'

/**
 * The fallback when no seed directory has been prepared: copy the design
 * system straight out of **Studio's own `node_modules`**.
 *
 * `.data/studio-seed` is opt-in and, in practice, nobody populates it — so
 * every "New project" came out with no `package.json` and no design system at
 * all, which is the exact failure this module's own doc comment describes.
 * Studio itself depends on `@alm-design/design-system`, so a correct copy is
 * already sitting on disk on any machine that can run the server. Using it
 * needs no setup step, no registry, and no install — the same copied-bytes,
 * Tier-0-safe property the configured seed has.
 *
 * A prepared seed directory still wins when one exists: it is the way to seed
 * something *other* than Studio's own dependency set.
 *
 * The `package.json` is written to match — declaring the dependency at the
 * version actually copied — because `componentPackages` (and therefore the
 * whole design-system half of the generated project guide) is read from the
 * manifest, not from what happens to be in `node_modules`. Copying the
 * package without declaring it would produce a project whose design system is
 * present but invisible to every detector.
 */
function seedFromAppInstall(projectDir: string, result: ProjectSeedResult): ProjectSeedResult {
  const source = join(process.cwd(), 'node_modules', ...SEED_PACKAGE.split('/'))
  if (!existsSync(source)) return result

  try {
    const target = join(projectDir, 'node_modules', ...SEED_PACKAGE.split('/'))
    if (existsSync(target)) {
      result.skipped.push('node_modules')
    } else {
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true, dereference: true })
      result.copied.push('node_modules')
    }

    const manifestPath = join(projectDir, 'package.json')
    if (existsSync(manifestPath)) {
      result.skipped.push('package.json')
    } else {
      writeFileSync(manifestPath, `${JSON.stringify(seedManifest(source), null, 2)}\n`)
      result.copied.push('package.json')
    }
  } catch (err) {
    // Same posture as the configured-seed path: a project that could not be
    // seeded is exactly the project it would have been before this existed.
    console.error('[studio/projectSeed] failed to seed from Studio\'s own install:', err)
  }

  return result
}

/** A minimal project manifest declaring the copied package at the version actually on disk. */
function seedManifest(packageDir: string): Record<string, unknown> {
  return {
    name: 'studio-project',
    private: true,
    type: 'module',
    dependencies: { [SEED_PACKAGE]: `^${readPackageVersion(packageDir) ?? '1.0.0'}` },
  }
}

/** The copied package's own `version`, or `undefined` if its manifest is missing or unreadable — never a guessed one. */
function readPackageVersion(packageDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}
