/**
 * projectSeed — the content every newly-created Studio project starts with,
 * beyond its own starter page.
 *
 * ## Why this exists
 *
 * "New project" scaffolded `pages/Home.tsx`, its stylesheet, and
 * `.studio/meta.json` — nothing else. No `package.json` and no design system.
 * The consequences only surfaced once an agent tried to build in one of those
 * projects: there was no design-system component to reach for,
 * `.claude/design-system.md` generated with nothing to index, and the
 * fallback the agent took was re-implementing the design system by hand in
 * inline styles with raw hex — which is both wrong and what made a generated
 * screen not match its Figma source.
 *
 * ## A folder in the project, not a dependency
 *
 * The design system arrives as `<project>/design-system/`, written from
 * Studio's own vendored copy by `./designSystemFiles.ts`. Nothing is fetched,
 * nothing is installed and nothing is executed, so this is Tier-0-safe by
 * construction (a new project is `DEFAULT_TRUST_TIER`, where running the
 * project's own package manager is refused — see `installDeps.ts`) and needs
 * no registry to be reachable.
 *
 * It used to be a copy of `@alm-design/design-system` into the project's own
 * `node_modules`, plus a `package.json` entry declaring it. That produced a
 * project whose "Download the code" zip named a dependency the registry has
 * never heard of — `node_modules/` is excluded from the download — so the
 * unzipped copy could not `bun install`. The folder is the fix; see
 * `./designSystemFiles.ts` for the full contract.
 *
 * ## The prepared seed
 *
 * `.data/studio-seed` stays, and is now the ONLY thing this module copies. It
 * is the way to start every new project in this installation with something
 * of your own — a house `tsconfig.json`, a `styles/` folder, an `AGENTS.md` —
 * and it is opt-in: absent (the normal case) simply means nothing extra.
 * Whatever top-level entries it holds are copied in as-is, so adding to it
 * later needs no change here.
 *
 * Seeding is BEST-EFFORT and never fatal: an absent or unreadable seed leaves
 * the project exactly as it would have been before this existed. Creating a
 * project must not fail because an optional convenience is missing.
 */
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveStudioDataRoot } from '../../runtimeDirs'
import { PROJECT_DESIGN_SYSTEM_DIR } from './builtinDesignSystem'
import { ensureDesignSystemFiles } from './designSystemFiles'
import { mergeShellPackageJson } from './prototypeShell'
import { mergeStudioMeta } from './studioMeta'

/**
 * Where a PREPARED seed lives, when one exists. `.data/` is already the
 * private, git-ignored home for local runtime state (the Claude CLI config dir
 * sits beside it). When this directory is absent — the normal case — a new
 * project still gets its manifest and its design-system folder; there is just
 * nothing extra to copy.
 */
export function resolveProjectSeedDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.STUDIO_PROJECT_SEED_DIR
  return configured ? resolve(configured) : join(resolveStudioDataRoot(env), 'studio-seed')
}

export interface ProjectSeedResult {
  /** Top-level entries actually written, in the order they were applied. */
  copied: string[]
  /** Entries skipped because the new project already had them — the scaffolder's own files always win. */
  skipped: string[]
}

/**
 * Give `projectDir` its manifest, its design system, and whatever the prepared
 * seed carries.
 *
 * Order is load-bearing in one direction only: the prepared seed is copied
 * FIRST and an entry the project already has is skipped rather than
 * overwritten, because the project scaffolder writes `pages/` and `.studio/`
 * before calling this and those are the authoritative ones. `package.json` is
 * then MERGED (never clobbered — an existing value always wins), which is the
 * same rule, expressed by the one function that already owns that manifest.
 */
export interface ProjectSeedOptions {
  /** Where the prepared seed lives. Defaults to {@link resolveProjectSeedDir}. */
  seedDir?: string
  /** Studio's vendored design-system package root. Overridden only by tests, which build a small fake one. */
  designSystemSourceDir?: string
}

export function applyProjectSeed(
  projectDir: string,
  options: ProjectSeedOptions = {},
): ProjectSeedResult {
  const seedDir = options.seedDir ?? resolveProjectSeedDir()
  const result: ProjectSeedResult = { copied: [], skipped: [] }

  if (existsSync(seedDir) && statSync(seedDir).isDirectory()) {
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
  }

  try {
    // react + react-dom + vite + @vitejs/plugin-react and the three scripts —
    // and deliberately NO design-system dependency. The design system is a
    // folder in the project now, so an unzipped copy installs only what npm
    // can actually serve.
    if (mergeShellPackageJson(projectDir)) result.copied.push('package.json')
    else result.skipped.push('package.json')

    // The write-side authority for "Studio maintains this project's
    // design-system folder". Set before the folder is written, because
    // `ensureDesignSystemFiles` reads it as its own gate.
    mergeStudioMeta(projectDir, { designSystem: 'alm' })
    const designSystem = ensureDesignSystemFiles(
      projectDir,
      options.designSystemSourceDir ? { sourceDir: options.designSystemSourceDir } : {},
    )
    if (designSystem.written.length > 0) result.copied.push(PROJECT_DESIGN_SYSTEM_DIR)
    else result.skipped.push(PROJECT_DESIGN_SYSTEM_DIR)
  } catch (err) {
    // Same posture as the prepared-seed path: a project that could not be
    // seeded is exactly the project it would have been before this existed.
    console.error('[studio/projectSeed] failed to seed the design system:', err)
  }

  return result
}
