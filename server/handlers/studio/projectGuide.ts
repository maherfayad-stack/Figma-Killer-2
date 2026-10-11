/**
 * projectGuide — what Studio writes into a user's project so the agent knows
 * how to work in it before it makes its first move.
 *
 * Three files, regenerated on every real chat turn:
 *
 *   - **`CLAUDE.md`** at the project root. The CLI loads this for free from
 *     its cwd (`claudeCli.ts` spawns in the validated project directory), so
 *     everything in it is context the agent has BEFORE its first tool call —
 *     zero round trips, and cached across turns.
 *   - **`.claude/design-system-components.md`** — the installed design
 *     system's real component API. Extracted from the package's own docs
 *     (`designSystemGuide.ts`) when it ships them; otherwise built directly
 *     from its real `.d.ts`/`.tsx` type declarations
 *     (`resolveCatalogDesignSystemGuide`, below) — see `resolveDesignSystemGuide`
 *     for which tier a given package gets and why neither is ALM-specific.
 *   - **`.claude/design-system.md`** — the token/BEM-class digest generated
 *     from the project's own CSS (`designSystemDigest.ts`), for projects
 *     whose design system arrived as plain CSS with no package docs.
 *
 * ## What this replaced, and why
 *
 * Studio used to generate eleven subagent definitions into `.claude/agents/`
 * plus six reference files, and the main prompt spent a long paragraph
 * warning the model not to invent a subagent name. That whole apparatus was
 * load-bearing only because the agent had no filesystem: a "screen-builder"
 * existed to batch `studio_apply_edits` calls, a "screen-scout" to work
 * around not having `Grep`. Both are now native tools.
 *
 * It also actively misfired. The CLI does not error on an unknown
 * `subagent_type` — it silently falls back to its own `general-purpose` agent
 * and returns as if the work had happened, so a delegation to an invented
 * name produced a confident report of ten files written, none of which
 * existed. The roster is gone; `Task` survives with a single permitted
 * `subagent_type`, stated in the system prompt's "Parallel work" contract
 * (`claudeCliToolSurface.ts`).
 *
 * ## Facts here, policy in the prompt
 *
 * `CLAUDE.md` describes the PROJECT. How to work in it — the workflow, the
 * definition of done, and the session's fidelity mode and design policy — is
 * the system prompt's, which reaches the CLI on every turn
 * (`claudeCliSystemPrompt.ts`). See `buildGuide` for why the two must never
 * both state policy.
 *
 * ## Never clobber (trap #12 — studio-workspace/* is user data)
 *
 * Unchanged from the roster generator, and the reason this module keeps its
 * manifest: a generated file is only overwritten while its on-disk content
 * still matches the hash Studio itself last wrote (recorded in
 * `.claude/.studio-generated.json`). A file the user has hand-edited — very
 * much including `CLAUDE.md`, which a user has every reason to make their own
 * — is left alone and reported as `skipped`, never silently rewritten. Files
 * the old roster wrote are simply no longer targets; they stop being tracked
 * on the next regeneration and are deliberately not deleted, since proving
 * "Studio still owns this" is exactly the discipline that would have to be
 * satisfied first.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isUnlinkedWorkspacePath } from '@core/page-parser'
import { joinAppRoot } from './appRoot'
import { reprobeProjectProfile, resolveProjectProfilePersisting } from './projectProbe'
import type { ProjectProfile } from './projectProfileSchema'
import { readTextCapped } from './cappedFileRead'
import { getOrBuildDesignSystemDigest } from './designSystemDigest'
import { buildDesignSystemGuide, renderComponentReference, renderIconReference, type ComponentApi, type DesignSystemGuide } from './designSystemGuide'
import { BUILTIN_DESIGN_SYSTEM_DIR, PROJECT_DESIGN_SYSTEM_DIR, isDesignSystemBacked } from './builtinDesignSystem'

/** What the generated guides call Studio's built-in design system. Mirrors `designSystemDetect.ts`'s `DesignSystemRef.name` for the `'builtin'` source, so an agent reading the guide and an agent reading `studio_list_components` hear the same name. */
const BUILTIN_DESIGN_SYSTEM_NAME = 'alm'
import { buildPackageManifest } from './packageManifest'
import type { PropKind, PropSpec } from './packageManifestSchema'
import { detectPageFileExtension } from './pageScaffold'
import { applyProjectSeed } from './projectSeed'
import { projectPagesDir } from '../studioProjects'
import {
  allOwnedFilesUnchangedSince,
  computeProjectGuideFingerprint,
  pruneLegacyGuideArtefacts,
  readManifest,
  sha256,
  writeManifest,
  type ManifestFileEntry,
} from './projectGuideManifest'

const CLAUDE_DIR = '.claude'
const GUIDE_PATH = 'CLAUDE.md'
const COMPONENTS_PATH = `${CLAUDE_DIR}/design-system-components.md`
const ICONS_PATH = `${CLAUDE_DIR}/design-system-icons.md`
const TOKENS_PATH = `${CLAUDE_DIR}/design-system.md`
/**
 * `.claude/settings.local.json`, never `.claude/settings.json` — the SAME
 * "not committed" project-personal tier Claude Code's own docs describe
 * (`.claude/settings.local.json` — "Local project settings (not committed)").
 * `.claude/settings.json` is the project's own, more likely to be
 * intentionally authored and shared by the user; Studio owns a `local`
 * file the same way it owns `CLAUDE.md`, generated fresh and skipped the
 * moment it is hand-edited (see `generateStudioProjectGuide`'s manifest).
 */
const HOOKS_SETTINGS_PATH = `${CLAUDE_DIR}/settings.local.json`

interface GuideFile {
  readonly relPath: string
  readonly content: string
}

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

/** The project's own styling mechanism, named the way the agent must match it. */
function styleMechanism(profile: ProjectProfile): string {
  if (profile.styleToolchain.tailwind !== null) return 'Tailwind utility classes'
  if (profile.styleToolchain.cssModules) return 'CSS Modules (`Screen.module.css` next to `Screen.tsx`, imported as `styles`)'
  if (profile.styleToolchain.sass) return 'Sass'
  return 'plain CSS'
}

/**
 * The project's `CLAUDE.md`: FACTS about this project, and nothing else.
 *
 * It used to carry policy too — "Use `<ds>` — always", "There is no third
 * option", "Never hardcode a colour", the build-look-fix loop, the definition
 * of done. That was written when this file was the only guidance the CLI agent
 * received. It is not any more: Studio's whole system prompt, with this turn's
 * fidelity-mode and design-policy blocks, reaches the CLI on every turn
 * (`claudeCliSystemPrompt.ts`). Policy stated here as well was at best a
 * duplicate and at worst a contradiction — the user picks a FREE design policy
 * and this file, loaded on the same turn, says the design system is
 * mandatory (audit 06, AI-1). How to work is the prompt's job; this file
 * answers "what is true about THIS project": where screens live, how they are
 * styled, what the design system is called, how it is imported, which
 * component answers which need, and where the generated references are.
 */
function buildGuide(dir: string, profile: ProjectProfile, ds: DesignSystemGuide | undefined, hasTokenDigest: boolean): string {
  // The same detector `studio_create_page` used, so the guide names the
  // extension the project actually writes rather than guessing from a profile
  // field that is empty on a project nothing has scanned yet.
  const ext = detectPageFileExtension(projectPagesDir(dir))
  const lines: string[] = [
    '# This project',
    '',
    'Generated by Studio on every chat turn — hand-edit it and Studio stops',
    'overwriting it, so your changes are safe but no longer refreshed.',
    '',
    'This file holds facts about this project. How to work — the workflow, what',
    'done means, and this session\'s fidelity mode and design policy — arrives',
    'with Studio\'s system prompt on every turn.',
    '',
    '## Facts',
    '',
    `- Screens live in \`${profile.pagesDir}/\` — one component file per screen, default-exported.`,
    `- New screens are \`${ext}\` files, named in PascalCase (\`Checkout${ext}\`).`,
    `- Styling: ${styleMechanism(profile)} — the mechanism the existing screens use.`,
    `- Framework: ${profile.framework} · package manager: ${profile.packageManager}`,
    `- Component packages: ${profile.componentPackages.length > 0 ? profile.componentPackages.map((p) => `\`${p}\``).join(', ') : '(none installed)'}`,
    '',
  ]

  if (ds) {
    lines.push(
      `## The design system: \`${ds.packageName}\``,
      '',
      `This project's components come from \`${ds.packageName}\`. Every component's`,
      `full props are in \`${COMPONENTS_PATH}\`, generated once per turn.`,
      '',
      '`studio_list_components` (browse) and `studio_find_component` (search by',
      'name/prop) return the live catalog, including a component only reachable',
      'through a Figma Code Connect binding rather than a real prop type — so the',
      'file above is not exhaustive.',
      '',
      'Only the packages listed under "Component packages" are installed. An import',
      'from any other package resolves to nothing and breaks the build.',
      '',
    )
    if (ds.icons) {
      const named = ds.icons.components
      const catalogTotal = ds.icons.catalogs.reduce((sum, c) => sum + c.names.length, 0)
      lines.push(
        '### Icons',
        '',
        ...(named.length > 0
          ? [
              `${named.length} icon components import by name straight from the package:`,
              '',
              '```jsx',
              `import { ${named.slice(0, 4).join(', ')} } from '${ds.packageName}'`,
              '```',
              '',
              named.map((n) => `\`${n}\``).join(' · '),
              '',
            ]
          : []),
        ...(catalogTotal > 0
          ? [`Another ${catalogTotal} SVGs ship as files under \`${ds.packageName}/src/icons/\`.`, '']
          : []),
        `Every one of them, with its exact import, is listed in \`${ICONS_PATH}\`.`,
        '',
      )
    }
    if (ds.importContract) {
      lines.push('### How to import it', '', ds.importContract, '')
    }
    if (ds.decisionMap) {
      lines.push('### Which component', '', ds.decisionMap, '')
    } else if (ds.components.length > 0) {
      lines.push(
        '### What exists',
        '',
        ds.components.map((c) => `\`${c.name}\``).join(' · '),
        '',
      )
    }
  } else if (hasTokenDigest) {
    lines.push(
      '## The design system',
      '',
      `This project's design system arrived as CSS, with no package docs.`,
      `\`${TOKENS_PATH}\` indexes every design token and every component class`,
      'with its variants, generated from the project\'s own stylesheets.',
      '',
      'Design-system classes are GLOBAL and apply as plain strings,',
      '`className="btn btn--primary"`. A class from a screen\'s own',
      '`.module.css` is SCOPED and applies only through the imported binding,',
      '`className={styles.row}` — a plain string naming a local module class',
      'matches nothing.',
      '',
    )
  } else if (profile.componentPackages.length > 0) {
    // A component package IS installed, but neither its own docs
    // (`CLAUDE.md`/`design.md`) nor a readable `.d.ts`/`.tsx` entry produced
    // anything static to show — see `resolveDesignSystemGuide`. Saying nothing
    // here would read as "no design system", which is false: real, importable
    // components exist. `studio_list_components` reaches further (it also
    // tries Figma Code Connect), so it may still answer what this file cannot.
    lines.push(
      `## This project has a design system, but its API could not be generated`,
      '',
      `\`${profile.componentPackages.join('`, `')}\` ${profile.componentPackages.length > 1 ? 'are' : 'is'} installed,`,
      'but neither ships agent docs nor a `.d.ts`/`.tsx` entry this generator',
      'could read, so no component/prop reference was written for it.',
      '`studio_list_components` also checks Figma Code Connect bindings, which',
      'this file does not, and may list components this generator could not.',
      '',
    )
  }

  if (hasTokenDigest && ds) {
    lines.push(
      '## Design tokens',
      '',
      `\`${TOKENS_PATH}\` lists every colour, type, spacing, radius and elevation`,
      'token this project has, generated from its own CSS.',
      '',
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// .claude/settings.local.json — the Stop-hook write-verification gate
// ---------------------------------------------------------------------------

/**
 * Wraps `value` in single quotes for a POSIX shell command string, escaping
 * any embedded `'`. Every value passed through this is a filesystem path
 * this SERVER computed (`import.meta.dir`/`process.execPath`), never
 * caller-supplied input — this exists for correctness on a path containing a
 * space (this repo's own checkout does: "Figma Killer 2"), not for defending
 * against adversarial content.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The three hooks the CLI itself enforces for a Studio turn.
 *
 * `PostToolUse`(`Write|Edit`) + `Stop` make "a screen written this turn with
 * no passing compare" a gate, instead of a rule living only in prose the
 * model can talk its way past under pressure (that feature's whole reason for
 * existing — see `hooks/stopGateCheck.ts`'s own doc for the verified hook
 * contract and `hooks/recordToolWrite.ts` for what feeds it).
 *
 * `PreToolUse`(`Write|Edit`) is a different kind of gate and the only one
 * here that is load-bearing for SECURITY: it refuses a native write into
 * `.studio/`, `.claude/` or `.git/` — the control plane that happens to live
 * inside the same directory `cwd` containment allows the subprocess to write.
 * See `hooks/denyControlPlaneWrite.ts` and `agentWriteScope.ts` for the
 * escalation it closes (an agent promoting its own project to Tier 2, or
 * self-approving an MCP server whose command the next turn spawns). Hooks are
 * evaluated independently of `--permission-mode`, which is what makes it hold
 * under the panel's `bypassPermissions` default.
 *
 * Every hook body is invoked as `<bun> <absolute-script-path>` — the exact
 * `[process.execPath, WORKER_SCRIPT_PATH]` shape `styleCompileTier1.ts`
 * already spawns a sibling Studio-internal script with, proven to resolve
 * `@core/*`/`@ai/*` path aliases correctly regardless of the process's own
 * `cwd` (which here is the USER's project, not this repo). No secret of any
 * kind is embedded — the hooks read purely from the project's own filesystem
 * (`.studio/cache/*`) or from their own stdin, so unlike `--mcp-config` this
 * file carries nothing that would matter if the user later committed it by
 * hand.
 */
function buildHooksSettings(): string {
  const bun = shellQuote(process.execPath)
  const denyScript = shellQuote(join(import.meta.dir, 'hooks', 'denyControlPlaneWrite.ts'))
  const recordScript = shellQuote(join(import.meta.dir, 'hooks', 'recordToolWrite.ts'))
  const gateScript = shellQuote(join(import.meta.dir, 'hooks', 'stopGateCheck.ts'))
  return `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          { matcher: 'Write|Edit', hooks: [{ type: 'command', command: `${bun} ${denyScript}` }] },
        ],
        PostToolUse: [
          { matcher: 'Write|Edit', hooks: [{ type: 'command', command: `${bun} ${recordScript}` }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: `${bun} ${gateScript}` }] }],
      },
    },
    null,
    2,
  )}\n`
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** A `PropKind` spelled out as the short, honest text the guide can print inline — `enum ('primary' | 'ghost')`, `string`, `unknown`. Never a fabricated TypeScript type: this is exactly `classifyPropType`'s own classification, in words. */
function renderPropKind(kind: PropKind): string {
  return kind.kind === 'enum' ? `enum (${kind.values.map((v) => `'${v}'`).join(' | ')})` : kind.kind
}

/** One component's real prop signature from real type declarations, one bullet per prop — the catalog fallback's answer to a docs-based guide's hand-written fenced example. `undefined` for a component with no readable props (an untyped JS entry, or a component that genuinely takes none) — no fabricated shape either way. */
function renderCatalogProps(props: readonly PropSpec[]): string | undefined {
  if (props.length === 0) return undefined
  return props.map((p) => `- \`${p.name}${p.required ? '' : '?'}\` — ${renderPropKind(p.kind)}`).join('\n')
}

/**
 * The generic half of design-system knowledge (Track A5): for a component
 * package with no agent-authored docs — `buildDesignSystemGuide` returns
 * `undefined` for it, true of every real design system except one that ships
 * a `CLAUDE.md`/`design.md` written for exactly this purpose — build the same
 * `DesignSystemGuide` shape from the package's own real `.d.ts`/`.tsx` type
 * declarations instead: `buildPackageManifest`, the identical syntactic
 * extraction `studio_list_components` already exposes at runtime (Track E1's
 * shared `componentSpecExtract.ts` classifier, including its K3 named-union
 * enum resolution — so `variant?: ButtonVariant`, the shape MUI/Chakra/
 * Mantine/shadcn all use, renders as a real enum here too). This is what
 * makes the "## Use `<pkg>` — always" section and the component-prop
 * reference file appear for ANY typed design system, not only one Studio
 * happens to have shipped docs for.
 *
 * Deliberately does NOT also try Figma Code Connect the way
 * `studio_list_components` does — reproducing that tool's enum-reduction
 * logic here would be a second, harder-to-keep-in-sync copy of it for a
 * generation-time file that is regenerated at most once per turn anyway. A
 * package with neither `.d.ts` nor agent docs gets no generated section here
 * (honest: nothing static was readable) — `buildGuide` tells the agent to
 * call `studio_list_components` itself for that case, which still checks
 * Code Connect.
 *
 * No `decisionMap` (there is no semantic "which component for this intent"
 * data to derive from bare type declarations — that is genuinely
 * docs-only knowledge) and no `icons` (an icon directory convention is a
 * per-package layout guess, not something a `.d.ts` states). `buildGuide`
 * already renders a plain "### What exists" name list when `decisionMap` is
 * absent, and skips the icons section entirely when `icons` is absent — both
 * the honest degradation this generator is required to produce, not an
 * invented substitute.
 */
function resolveCatalogDesignSystemGuide(appRootAbs: string, pkg: string): DesignSystemGuide | undefined {
  const { components: specs } = buildPackageManifest(appRootAbs, pkg)
  if (specs.length === 0) return undefined

  const components: ComponentApi[] = specs.map((spec) => {
    const props = renderCatalogProps(spec.props)
    return { name: spec.name, ...(props ? { props } : {}) }
  })
  const sample = components.slice(0, 8).map((c) => c.name).join(', ')
  const importContract = [
    '```jsx',
    `import { ${sample} } from '${pkg}'`,
    '```',
    '',
    `\`${pkg}\` is the exact specifier — import components by name from the package root; never deep-import a component file.`,
  ].join('\n')
  return { packageName: pkg, importStyle: { kind: 'package', specifier: pkg }, components, importContract }
}

/**
 * The installed design system's own knowledge, generalized across every
 * component package this project declares (Track A5) — never hardcoded to
 * one package name. Two tiers per package, most-specific first:
 *
 *   1. The package's OWN agent-authored docs (`buildDesignSystemGuide`) — a
 *      genuine intent-level decision map no static extraction can
 *      synthesize. Nothing here checks the package's NAME; a package earns
 *      this tier by shipping the convention, not by being a particular one.
 *   2. A catalog built from the package's own real type declarations
 *      (`resolveCatalogDesignSystemGuide`) — real component names and real
 *      props, generically, for a package with no docs but a readable
 *      `.d.ts`/`.tsx` (MUI, Chakra, Mantine, shadcn, a private kit).
 *
 * Returns the FIRST package that produces either tier's content — a project
 * naming more than one component package still gets exactly one `ds` here
 * (the one `buildGuide` has always rendered a single "## Use X" section
 * for); every declared package, including ones this pass didn't pick, is
 * still fully queryable at runtime via `studio_list_components`/
 * `studio_find_component` (see the note `buildGuide` prints next to it).
 *
 * Exported because `studio_quality_check`'s component-coverage rule
 * (`design-system-coverage-low`, W9-3) has to grade a screen against exactly
 * what the generated decision table OFFERED it — resolving the catalog a
 * second way there would let the finding name components the project's own
 * `CLAUDE.md` never mentioned, which is worse than no finding.
 */
export function resolveDesignSystemGuide(
  dir: string,
  profile: ProjectProfile,
  builtinDir: string = BUILTIN_DESIGN_SYSTEM_DIR,
): DesignSystemGuide | undefined {
  // DS-3 — Studio's BUILT-IN design system comes first, and its docs come from
  // Studio's own vendored copy rather than from anything in the project: the
  // `design-system/` folder Studio writes carries source only. A DS-backed
  // project's pages import that folder, so this IS its design system, whatever
  // else `package.json` happens to still declare.
  if (isDesignSystemBacked(dir)) {
    const builtin = buildDesignSystemGuide(builtinDir, BUILTIN_DESIGN_SYSTEM_NAME, {
      kind: 'folder',
      dirName: PROJECT_DESIGN_SYSTEM_DIR,
    })
    if (builtin) return builtin
  }
  const appRootAbs = joinAppRoot(dir, profile.appRoot)
  for (const pkg of profile.componentPackages) {
    const pkgDir = join(appRootAbs, 'node_modules', ...pkg.split('/'))
    const docsGuide = buildDesignSystemGuide(pkgDir, pkg)
    if (docsGuide) return docsGuide
    const catalogGuide = resolveCatalogDesignSystemGuide(appRootAbs, pkg)
    if (catalogGuide) return catalogGuide
  }
  return undefined
}

function buildGuideFiles(dir: string, profile: ProjectProfile): GuideFile[] {
  const ds = resolveDesignSystemGuide(dir, profile)
  const tokenDigest = getOrBuildDesignSystemDigest(dir, profile.designSystems ?? [])
  const iconReference = ds ? renderIconReference(ds) : undefined
  return [
    { relPath: GUIDE_PATH, content: buildGuide(dir, profile, ds, tokenDigest !== undefined) },
    ...(ds ? [{ relPath: COMPONENTS_PATH, content: renderComponentReference(ds) }] : []),
    ...(iconReference !== undefined ? [{ relPath: ICONS_PATH, content: iconReference }] : []),
    ...(tokenDigest !== undefined ? [{ relPath: TOKENS_PATH, content: tokenDigest }] : []),
    { relPath: HOOKS_SETTINGS_PATH, content: buildHooksSettings() },
  ]
}

export interface GenerateGuideResult {
  readonly written: string[]
  readonly skipped: string[]
  /** Legacy artefacts deleted by this call — see {@link LEGACY_GUIDE_ARTEFACTS}. Non-empty at most once per project. */
  readonly pruned: string[]
}

/**
 * Give a project with NO manifest at all the design system, before describing
 * a project that does not have one.
 *
 * `POST /admin/api/studio/create` seeds at creation, but that only ever helps
 * projects created after the seed existed. Every project made before it — and
 * any project whose contents were cleared — stays permanently empty:
 * `componentPackages` is `[]`, so `design-system-components.md` never
 * generates, and the agent is told to read a reference file that cannot
 * appear. Observed exactly that way, twice.
 *
 * The gate is deliberately "no `package.json` whatsoever", not "no design
 * system". A project carrying its OWN manifest is the user's, and copying a
 * package into it that its manifest does not declare would be Studio deciding
 * a dependency on their behalf. A Studio-scaffolded project with no manifest
 * at all has made no such statement, so completing it is a repair rather than
 * an opinion.
 *
 * A successful heal re-probes immediately: {@link isProfileStale} only
 * reconsiders a cached profile that carries a dependencies-not-installed
 * warning, which a project that never had a manifest does not, so the cache
 * would otherwise keep reporting the pre-seed emptiness.
 */
function healMissingDesignSystem(dir: string): void {
  if (existsSync(join(dir, 'package.json'))) return
  const seeded = applyProjectSeed(dir)
  if (seeded.copied.length > 0) reprobeProjectProfile(dir)
}

/**
 * Write the project's generated guide files, skipping (never overwriting)
 * anything the user has changed since Studio last wrote it. Never throws — a
 * probe failure degrades to `{ written: [], skipped: [] }`, and the caller
 * (`claudeCli.ts`) treats a missing guide as "no guide this turn", not a
 * broken chat.
 *
 * Called once per real chat turn, on the critical path before the `claude`
 * subprocess spawns, so the warm-and-unchanged path must be nearly free: it
 * recomputes {@link computeProjectGuideFingerprint} and stats the already-written
 * files, and does nothing else. Only a changed input (a new design token, a
 * different profile, an upgraded Studio) or a changed OUTPUT file (the user
 * hand-edited `CLAUDE.md`) forces the full build — the two checks catch
 * different things and both are required.
 */
export function generateStudioProjectGuide(dir: string): GenerateGuideResult {
  try {
    healMissingDesignSystem(dir)
    const profile = resolveProjectProfilePersisting(dir)
    const manifest = readManifest(dir)
    const fingerprint = computeProjectGuideFingerprint(dir, profile)

    // Sweep what a PREVIOUS generator version wrote and this one does not.
    // Deliberately BEFORE the fast path: an already-warm project would
    // otherwise never be swept, which is exactly the state every existing
    // project is in. Once-per-path-per-project, so afterwards this is a set
    // lookup per entry and no filesystem work at all.
    const pruned = pruneLegacyGuideArtefacts(dir, manifest)

    if (manifest.fingerprint === fingerprint && allOwnedFilesUnchangedSince(dir, manifest.files)) {
      // The sweep still has to be recorded, or it repeats every warm turn.
      if (pruned.manifestChanged) writeManifest(dir, manifest)
      return { written: [], skipped: [], pruned: pruned.removed }
    }

    const nextFiles: Record<string, ManifestFileEntry> = {}
    const written: string[] = []
    const skipped: string[] = []

    for (const target of buildGuideFiles(dir, profile)) {
      const absPath = join(dir, target.relPath)
      // Never read or written through a link (security review of #233, F7):
      // a `.claude` junction pointing out of the project would otherwise put
      // `settings.local.json` and every guide file wherever it points. Such a
      // target is skipped and not recorded — nothing of Studio's is there.
      if (!isUnlinkedWorkspacePath(dir, absPath)) {
        skipped.push(target.relPath)
        continue
      }
      const contentHash = sha256(target.content)
      const existing = readTextCapped(absPath, 1_000_000)

      if (existing !== undefined) {
        const lastWrittenHash = manifest.files[target.relPath]?.hash
        if (lastWrittenHash !== sha256(existing)) {
          // Either Studio never wrote this file, or the user edited it since
          // — either way, not ours to overwrite. Record its CURRENT stat so
          // the fast path above recognises "still exactly this hand-edit,
          // nothing new" next turn instead of re-detecting it forever.
          skipped.push(target.relPath)
          const stat = statSync(absPath)
          nextFiles[target.relPath] = { hash: lastWrittenHash ?? sha256(existing), size: stat.size, mtimeMs: stat.mtimeMs }
          continue
        }
        if (existing === target.content) {
          const stat = statSync(absPath)
          nextFiles[target.relPath] = { hash: contentHash, size: stat.size, mtimeMs: stat.mtimeMs }
          continue
        }
      }

      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, target.content)
      const stat = statSync(absPath)
      nextFiles[target.relPath] = { hash: contentHash, size: stat.size, mtimeMs: stat.mtimeMs }
      written.push(target.relPath)
    }

    writeManifest(dir, {
      fingerprint,
      files: nextFiles,
      // Carried through, not recomputed — dropping it here would re-arm the
      // sweep on the next full regeneration.
      ...(manifest.prunedLegacyArtefacts ? { prunedLegacyArtefacts: manifest.prunedLegacyArtefacts } : {}),
    })
    return { written, skipped, pruned: pruned.removed }
  } catch (err) {
    console.error('[projectGuide] failed to generate the project guide — continuing without one:', err)
    return { written: [], skipped: [], pruned: [] }
  }
}
