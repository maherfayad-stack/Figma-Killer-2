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
 * existed. `Task` is gone from the tool surface entirely
 * (`claudeCliToolSurface.ts`), which makes that failure unreachable rather
 * than merely discouraged, and the knowledge those prompts carried moved here
 * — into a file the agent cannot fail to read.
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
import { joinAppRoot } from './appRoot'
import { reprobeProjectProfile, resolveProjectProfilePersisting } from './projectProbe'
import type { ProjectProfile } from './projectProfileSchema'
import { readTextCapped } from './cappedFileRead'
import { getOrBuildDesignSystemDigest } from './designSystemDigest'
import { buildDesignSystemGuide, renderComponentReference, renderIconReference, type ComponentApi, type DesignSystemGuide } from './designSystemGuide'
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

function buildGuide(dir: string, profile: ProjectProfile, ds: DesignSystemGuide | undefined, hasTokenDigest: boolean): string {
  // The same detector `studio_create_page` used, so the guide names the
  // extension the project actually writes rather than guessing from a profile
  // field that is empty on a project nothing has scanned yet.
  const ext = detectPageFileExtension(projectPagesDir(dir))
  const lines: string[] = [
    '# Working in this project',
    '',
    'Generated by Studio on every chat turn — hand-edit it and Studio stops',
    'overwriting it, so your changes are safe but no longer refreshed.',
    '',
    'This is a real React repository. You edit it with ordinary file tools:',
    '`Read`, `Write`, `Edit`, `Glob`, `Grep`. There is no build step to run and',
    'no code-generation layer — the files on disk ARE the design. A screen is a',
    'component file plus its stylesheet, written the way you would write them by',
    'hand.',
    '',
    '## Facts about this project',
    '',
    `- Screens live in \`${profile.pagesDir}/\` — one component file per screen, default-exported.`,
    `- New screens are \`${ext}\` files, named in PascalCase (\`Checkout${ext}\`).`,
    `- Styling: ${styleMechanism(profile)}. Use it. Never introduce a second styling system.`,
    `- Framework: ${profile.framework} · package manager: ${profile.packageManager}`,
    `- Component packages: ${profile.componentPackages.length > 0 ? profile.componentPackages.map((p) => `\`${p}\``).join(', ') : '(none installed)'}`,
    '',
    '## Building a screen',
    '',
    '1. `Read` one existing screen first. Match what it does — its imports, its',
    '   class naming, its file layout. You are joining a codebase, not starting one.',
    `2. \`Write\` the component file and its stylesheet. One \`Write\` each — a screen`,
    '   is one file, not twenty edits.',
    '3. `studio_screenshot` it and LOOK at the result. Fix what you see. Repeat',
    '   until it is right. This is the only step that tells you the truth.',
    '4. If there is a design to match, `studio_compare` it. That returns a',
    '   verdict and a list of the rectangles that are wrong — see "Verifying".',
    '',
    '**Do not ask before building.** A request for a screen is a request for a',
    'screen. Pick sensible defaults for anything unstated, build it, show it, and',
    'say what you assumed. A question is worth asking only when the answer would',
    'change the work and you genuinely cannot infer it — never as a preamble, and',
    'never for something a reference image or a sibling screen already answers.',
    '',
    '## Writing the component',
    '',
    '- **Real styling goes in the stylesheet, not in `style={{…}}`.** An inline',
    '  style object is for one dynamic value, not for a layout. A screen whose',
    '  every element carries a fifteen-property inline object is not a screen',
    '  anyone can edit afterward — including you, on the next turn.',
    '- **Never hardcode a colour, radius, font size, or spacing value** that a',
    '  design token already covers. Use `var(--token)`. A raw `#0C9AB0` is',
    '  re-implementing the design system by hand, and is wrong even when it looks',
    '  identical.',
    '- **Never put a fixed pixel width on a container.** A board frame shows one',
    '  device width — that is a preview, not the specification. `width: 100%`',
    '  with a `max-width`, and fluid values (`clamp`/`%`/`rem`) over breakpoints.',
    '- Keep the screen a static composition. State and data belong in components',
    '  the screen imports, or in the app around it.',
    '',
  ]

  if (ds) {
    lines.push(
      `## Use \`${ds.packageName}\` — always`,
      '',
      `Every screen in this project imports its components from \`${ds.packageName}\`.`,
      'This is not a preference to weigh against hand-rolling; it is what this',
      'project is built from.',
      '',
      '**The rule:** if the design system has a component for it, import that',
      'component. If it does not, write the smallest possible plain element and',
      'style it with the system\'s own tokens. There is no third option — in',
      'particular:',
      '',
      '- **Never draw an icon yourself.** Not as an emoji or text glyph (`✈`, `‹`,',
      '  `🗓`), and not as hand-written `<svg>` path data. Every icon you need',
      '  already exists in this package.',
      '- Never hand-roll a nav, a card, a list row, a divider, a chip, a badge, a',
      '  dialog, or a bottom sheet in CSS. Every one of those already exists.',
      '- Never write an import for a package that is not in the list above — it',
      '  resolves to nothing and breaks the build.',
      '',
      `Full props for every component: read \`${COMPONENTS_PATH}\`.`,
      '',
      `That file is generated once per turn. For the live catalog — every`,
      'component this project can see, including one only reachable through a',
      'Figma Code Connect binding rather than a real prop type — call',
      '`studio_list_components` (browse) or `studio_find_component` (search by',
      'name/prop) instead of assuming the file above is exhaustive.',
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
        `Every one of them, with its exact import, is listed in \`${ICONS_PATH}\` — read it before you render any icon.`,
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
      '## Use this project\'s design system',
      '',
      `This project's design system arrived as CSS, with no package docs. Read`,
      `\`${TOKENS_PATH}\` — it indexes every design token and every component class`,
      'with its variants, generated from the project\'s own stylesheets.',
      '',
      'Design-system classes are GLOBAL: write them as plain strings,',
      '`className="btn btn--primary"`. A class from this screen\'s own',
      '`.module.css` is SCOPED and only works through the imported binding,',
      '`className={styles.row}` — a plain string naming a local module class',
      'silently does nothing at all.',
      '',
    )
  } else if (profile.componentPackages.length > 0) {
    // A component package IS installed, but neither its own docs
    // (`CLAUDE.md`/`design.md`) nor a readable `.d.ts`/`.tsx` entry produced
    // anything static to show — see `resolveDesignSystemGuide`. Telling the
    // agent nothing here would read as "no design system", which is false:
    // real, importable components exist. `studio_list_components` reaches
    // further (it also tries Figma Code Connect), so it may still answer
    // what this generated file cannot.
    lines.push(
      `## This project has a design system, but its API could not be generated`,
      '',
      `\`${profile.componentPackages.join('`, `')}\` ${profile.componentPackages.length > 1 ? 'are' : 'is'} installed,`,
      'but neither ships agent docs nor a `.d.ts`/`.tsx` entry this generator',
      'could read — so no component/prop reference was written for it. Before',
      'hand-rolling anything, call `studio_list_components` (it also checks',
      'Figma Code Connect bindings, which this file does not) to confirm',
      'whether the component you need already exists.',
      '',
    )
  }

  if (hasTokenDigest && ds) {
    lines.push(
      '## Design tokens',
      '',
      `\`${TOKENS_PATH}\` lists every colour, type, spacing, radius and elevation`,
      'token this project has, generated from its own CSS. Read it before',
      'inventing a value.',
      '',
    )
  }

  lines.push(
    '## Verifying',
    '',
    '`studio_screenshot` is how you see your own work. Call it after writing,',
    'look at the image, and fix what is actually wrong rather than what you',
    'assume is. It places a board frame for any new screen automatically, so a',
    'file you just wrote is visible on the first call.',
    '',
    'Never report a screen as done without having looked at it.',
    '',
    '### When there is a design to match',
    '',
    'Looking is not enough — eyes have already passed screens here whose text',
    'overlapped and whose icons were specks. Measure instead:',
    '',
    '1. `studio_register_design_reference` once, with `pageId` set to the screen.',
    '2. `studio_compare` after every pass. It captures the screen, diffs it',
    '   against the design, and returns `pass` plus the exact rectangles that',
    '   differ and the node ids inside them.',
    '',
    '**A screen with a registered reference is done when `studio_compare`',
    'returns `pass: true`.** Not when it looks close to you. If it returns',
    'false, `regions[0]` is the biggest thing that is wrong — fix that, measure',
    'again, repeat. Never argue that the remaining difference is acceptable, and',
    'never claim a match you did not measure.',
    '',
    '`pass` is not pixel-identity: a browser rasterises text differently from a',
    'design tool, so it requires high overall similarity AND no single differing',
    'region big enough to be structural. A real defect always forms a region;',
    'antialiasing never does.',
    '',
    '## Assets you do not have',
    '',
    'You cannot invent an icon, a photo, a logo, or an illustration. Get the real',
    'file — an icon from the design system, an image through',
    '`studio_fetch_remote_asset` or `studio_upload_asset`, an export from a',
    'connected Figma MCP server if this project has one.',
    '',
    'If you genuinely cannot obtain it, leave a plain neutral placeholder and say',
    'so in your reply. Hand-written `<svg>` path data and photos shaped out of',
    'CSS gradients both come out looking broken. A gap the user can fill in one',
    'message beats a fake.',
    '',
    '## What you cannot do here',
    '',
    '- **No shell.** There is no `Bash` tool. Dependencies install through',
    '  `studio_install_deps`, which is gated by this project\'s trust tier — if a',
    '  task genuinely needs a tier promotion, say so and let the user do it. You',
    '  may never promote a project yourself.',
    '- **No files outside this project.** Everything you write lands under this',
    '  directory, which is the user\'s real project with no other copy.',
    '',
    'Reply in one or two sentences after acting. Never paste source, JSON, or',
    'diffs into the reply — the user can see the files and the canvas.',
    '',
  )
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
 * The `PostToolUse`(`Write|Edit`)/`Stop` hooks that make "a screen written
 * this turn with no passing compare" a gate the CLI itself enforces, instead
 * of a rule living only in prose the model can talk its way past under
 * pressure (this feature's whole reason for existing — see
 * `hooks/stopGateCheck.ts`'s own doc for the verified hook contract and
 * `hooks/recordToolWrite.ts` for what feeds it).
 *
 * Both hook bodies are invoked as `<bun> <absolute-script-path>` — the exact
 * `[process.execPath, WORKER_SCRIPT_PATH]` shape `styleCompileTier1.ts`
 * already spawns a sibling Studio-internal script with, proven to resolve
 * `@core/*`/`@ai/*` path aliases correctly regardless of the process's own
 * `cwd` (which here is the USER's project, not this repo). No secret of any
 * kind is embedded — both hooks read purely from the project's own
 * filesystem (`.studio/cache/*`), so unlike `--mcp-config` this file carries
 * nothing that would matter if the user later committed it by hand.
 */
function buildHooksSettings(): string {
  const bun = shellQuote(process.execPath)
  const recordScript = shellQuote(join(import.meta.dir, 'hooks', 'recordToolWrite.ts'))
  const gateScript = shellQuote(join(import.meta.dir, 'hooks', 'stopGateCheck.ts'))
  return `${JSON.stringify(
    {
      hooks: {
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
  return { packageName: pkg, components, importContract }
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
 */
function resolveDesignSystemGuide(dir: string, profile: ProjectProfile): DesignSystemGuide | undefined {
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
