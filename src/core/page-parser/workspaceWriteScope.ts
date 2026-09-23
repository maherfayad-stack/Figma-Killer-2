/**
 * workspaceWriteScope — the ONE answer to "may Studio write this path inside a
 * user's project?", for every writer: the writeback codemods, the CSS
 * writeback, asset landing, the component-copy codemods, and the agent's
 * native `Write`/`Edit` hook.
 *
 * ## Why one predicate
 *
 * `EXCLUDED_WORKSPACE_DIR_NAMES` already said which directories in a project
 * are not the user's source, but each writer re-implemented the check with
 * its own `segments.some(...)`, and they drifted: the node-id writeback
 * (`isWritableSourceRel`) never consulted the list at all, so
 * `.studio/anything.tsx:1:1` was a valid write target; the CSS and asset
 * writers checked it only on the TEXTUAL path, so a symlink named like source
 * (`src/theme -> ../.studio`) carried a write straight into Studio's control
 * plane; and every one of them compared case-sensitively on filesystems that
 * are not.
 *
 * ## What it refuses
 *
 * {@link UNWRITABLE_WORKSPACE_DIR_NAMES}: every walk exclusion plus `.claude`.
 * `.studio` is Studio's consent record (the `trust` tier, MCP-server
 * approvals), `.claude` holds the generated hook settings that enforce the
 * agent's own write gate, `.git` is executable by proxy (`hooks/`), and
 * `node_modules`/build output is not source. A segment is compared the way
 * the filesystem will resolve it: case-folded (Windows, default macOS), with
 * trailing dots/spaces dropped and an NTFS stream suffix cut off — `.STUDIO`,
 * `.studio.` and `.git::$INDEX_ALLOCATION` all open the directory they
 * spell.
 *
 * ## Lexical AND real
 *
 * {@link unwritableWorkspaceSegment} is the pure half, for callers that must
 * stay pure (`isWritableSourceRel`). {@link isWorkspaceWritablePath} adds the
 * real-path half: it resolves symlinks and junctions (git stores symlinks, so
 * an imported repository can carry one) and re-applies the same segment rule
 * to where the write would actually land. Either hit refuses.
 *
 * A path that passes through a DANGLING symlink has no real path, and is
 * refused rather than treated as "not created yet": `writeFileSync` follows
 * the link, so a new-file writer checking the link's own spelling would
 * create the file wherever the link points — outside the project included.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES, PROTOTYPE_SHELL_DIR } from './workspaceFiles'

/**
 * Directory names no Studio write may land in, at any depth: the walk
 * exclusions plus `.claude`. Derived from `EXCLUDED_WORKSPACE_DIR_NAMES`, so a
 * future exclusion reaches every writer without anyone remembering to come
 * here. `.claude` is not a walk exclusion — the parser may read it — only a
 * write exclusion.
 */
export const UNWRITABLE_WORKSPACE_DIR_NAMES: ReadonlySet<string> = new Set<string>([
  ...EXCLUDED_WORKSPACE_DIR_NAMES,
  '.claude',
])

/** A path segment as the filesystem will resolve it, for comparison only. */
function comparableSegment(segment: string): string {
  const withoutStream = segment.split(':')[0] ?? segment
  return stripTrailingDotsAndSpaces(withoutStream).toLowerCase()
}

/**
 * `segment` without its trailing dots and spaces — the characters Windows
 * drops when it resolves a name. A plain index walk, deliberately: the regex
 * `/[. ]+$/` it replaces backtracks quadratically on a long run of dots or
 * spaces followed by anything else, and a 40,000-character path segment from
 * a model froze the whole server for seconds (security review of #233, F1).
 */
export function stripTrailingDotsAndSpaces(segment: string): string {
  let end = segment.length
  while (end > 0) {
    const char = segment.charCodeAt(end - 1)
    if (char !== 0x2e && char !== 0x20) break
    end -= 1
  }
  return end === segment.length ? segment : segment.slice(0, end)
}

/**
 * The first segment of a project-relative path (either separator) that names
 * an unwritable directory, or `null`. Pure: no filesystem access, so it can
 * sit inside a lexical guard. The last segment counts too — a FILE named
 * `.git` is a gitdir pointer, and rewriting it re-targets the repository.
 */
export function unwritableWorkspaceSegment(rel: string): string | null {
  return firstSegmentNamedIn(rel, UNWRITABLE_WORKSPACE_DIR_NAMES)
}

/**
 * The READ-side twin of {@link unwritableWorkspaceSegment}: the first segment
 * naming a directory no Studio walk or agent read enters
 * (`EXCLUDED_WORKSPACE_DIR_NAMES` — `.studio`, `.git`, `node_modules`, build
 * output), compared the same filesystem way. `.claude` is deliberately
 * readable: it holds the design-system reference files the agent is told to
 * read. Pure, like its twin.
 */
export function excludedWorkspaceSegment(rel: string): string | null {
  return firstSegmentNamedIn(rel, EXCLUDED_WORKSPACE_DIR_NAMES)
}

function firstSegmentNamedIn(rel: string, names: ReadonlySet<string>): string | null {
  for (const segment of rel.split(/[\\/]+/)) {
    if (names.has(comparableSegment(segment))) return segment
  }
  return null
}

/**
 * Whether a file NAME (the last segment) is one that conventionally holds a
 * credential: `.env` and its variants (but not the committed `.example` /
 * `.sample` / `.template` shapes), package-manager and network auth files, and
 * private-key material. Compared the filesystem way, like the directory sets.
 *
 * No agent file tool reads or writes one. A tool result is a transcript line a
 * provider stores; a key in it has left the machine.
 */
export function isSecretBearingFileName(name: string): boolean {
  const comparable = comparableSegment(name)
  if (comparable === '.env') return true
  if (comparable.startsWith('.env.')) return !PUBLIC_ENV_SUFFIXES.has(comparable.slice('.env.'.length))
  if (SECRET_FILE_NAMES.has(comparable)) return true
  if (SECRET_FILE_STEMS.some((stem) => comparable.startsWith(stem))) return true
  return SECRET_FILE_EXTENSIONS.some((ext) => comparable.endsWith(ext))
}

const PUBLIC_ENV_SUFFIXES: ReadonlySet<string> = new Set(['example', 'sample', 'template', 'defaults'])
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  '.envrc',
  '.dev.vars',
  '.npmrc',
  '.yarnrc.yml',
  '.netrc',
  '.pgpass',
  '.pypirc',
  '.git-credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])
const SECRET_FILE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.tfvars']
const SECRET_FILE_STEMS: readonly string[] = ['secrets.']

// ---------------------------------------------------------------------------
// Files that run on the host, outside the page sandbox
// ---------------------------------------------------------------------------

/**
 * Why an AGENT may not write `rel` without the user, or `null` when it may.
 *
 * ## The line this draws (security review of #233, F3)
 *
 * The screens an agent writes — `.tsx`, `.ts`, `.css`, assets — run in the
 * preview browser, and writing them is the whole job. The files below run on
 * the user's MACHINE instead, in Node or a shell, as the user, with no click
 * in between: Vite restarts itself and re-evaluates its config the moment the
 * file changes, `npm run dev` runs a `predev` script, a git hook runs on the
 * next commit, VS Code runs a task, a CI workflow runs on push. Every project
 * defaults to Tier 2 and the dev server starts as soon as a board opens, so a
 * prompt-injected instruction planted in anything the agent reads could turn
 * one ordinary-looking write into code execution with nobody asked. CLAUDE.md
 * states the rule: Tier 2 is a product default, not a consent boundary, and
 * anything that needs a human to have agreed must ask at the point of use.
 * `CLAUDE.md` itself is in the list for the same reason one level up: it is
 * not executed, but it is standing instruction for every later turn.
 *
 * So the agent asks. The refusal (`needs-user`) tells it to show the user the
 * exact change and let them make or approve it.
 *
 * ## What it is not
 *
 * Not a sandbox. Any module a config file imports still runs in Node, and a
 * dependency can do anything once installed. This removes the ZERO-click path
 * from a single write; it does not make a project's code safe to run.
 *
 * Consulted by `agentWriteRefusal` (`server/handlers/studio/agentWriteScope.ts`)
 * — the ONE agent write gate, which both the `claude` CLI's `PreToolUse` hook
 * and the HTTP drivers' file tools call. Never by Studio's own writers: the
 * prototype shell writes `vite.config.js` and dependency installs write
 * `package.json`, on the user's behalf and in code Studio ships.
 */
export function hostExecutedWorkspaceFile(rel: string): string | null {
  const segments = rel.split(/[\\/]+/).filter((segment) => segment.length > 0).map(comparableSegment)
  const name = segments[segments.length - 1] ?? ''
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) break
    if (segment === '.husky') return 'a git hook (.husky/), which runs on the next commit'
    if (segment === '.vscode') return 'editor configuration (.vscode/), whose tasks and launch configs run commands'
    if (segment === '.github' && segments[index + 1] === 'workflows') return 'a CI workflow (.github/workflows/), which runs on push'
    if (segment === '.devcontainer') return 'a dev-container definition (.devcontainer/), which runs commands when the container builds'
    if (segment === '.circleci') return 'a CI definition (.circleci/), which runs on push'
  }
  if (name === '.gitlab-ci.yml') return 'a CI definition, which runs on push'
  if (name.startsWith('.lintstagedrc') || name === 'lefthook.yml' || name === 'lefthook.yaml' || name === '.lefthook.yml' || name === '.pre-commit-config.yaml') {
    return 'a commit-hook configuration, whose commands run on the next commit'
  }
  if (name === 'package.json') return 'the package manifest, whose scripts run on install and on every dev-server start (dependencies go through studio_install_deps)'
  if (name === 'claude.md' || name === 'claude.local.md') return 'standing instructions for every later agent turn'
  if (name === '.npmrc' || name.startsWith('.yarnrc') || name === 'bunfig.toml' || name === '.gitmodules' || name === '.mcp.json') {
    return 'package-manager, git or tool configuration the host reads and acts on'
  }
  if (name === '.env' || name.startsWith('.env.') || name === '.envrc') return 'environment configuration the host loads'
  if (isHostConfigFileName(name) || name === 'babel.config.json') return 'build-tool configuration, which runs in Node the moment the dev server or a build loads it'
  return null
}

/**
 * Whether a file NAME is a build-tool config a tool imports and runs in Node
 * (`vite.config.ts`, `postcss.config.cjs`, `.babelrc.js`). Exported for the
 * import-closure half of the agent write gate
 * (`server/handlers/studio/hostConfigImports.ts`), which scans exactly these
 * files for the local modules they load.
 */
export function isHostConfigFileName(name: string): boolean {
  const comparable = comparableSegment(name)
  return HOST_CONFIG_FILE.test(comparable) || HOST_RC_FILE.test(comparable)
}

/**
 * Whether `rel` is inside Studio's generated preview shell (`prototype/`,
 * `PROTOTYPE_SHELL_DIR`) — every file the shell templates emit except the two
 * root bootstrap files (`vite.config.js`, a host config and `needs-user`;
 * `index.html`, which only the browser runs). Studio writes and rewrites
 * these on every open, and the scaffolded `vite.config.js` imports one of
 * them (`prototype/studioRuntime.generated.js`), so an agent write there
 * runs in Node when Vite restarts. No agent writes them: `protected-path`.
 * `prototypeShell.test.ts` holds every template path to this predicate, so a
 * new shell file cannot land outside it unnoticed.
 */
export function studioShellWorkspaceFile(rel: string): boolean {
  const first = rel.split(/[\\/]+/).find((segment) => segment.length > 0)
  return first !== undefined && comparableSegment(first) === PROTOTYPE_SHELL_DIR
}

/** A project-relative path in the form the filesystem compares it: separators unified, each segment case-folded with trailing dots and stream suffixes dropped. */
export function comparableWorkspaceRel(rel: string): string {
  return rel.split(/[\\/]+/).filter((segment) => segment.length > 0).map(comparableSegment).join('/')
}

/** `vite.config.ts`, `vite.prod.config.mjs`, `tailwind.config.cjs`, `eslint.config.js` — anything named as a tool config that a tool imports and runs. */
const HOST_CONFIG_FILE = /^[a-z0-9_.-]+\.config\.[cm]?[jt]s$/
/** `.babelrc`, `.postcssrc.js`, `.eslintrc.cjs` — the rc-file family those tools also load. */
const HOST_RC_FILE = /^\.(?:babel|postcss|eslint|prettier|swc|stylelint)rc(?:\.[a-z]+)?$/

/**
 * The real path of `path` — symlinks and junctions resolved, on-disk casing
 * restored — through the DEEPEST ancestor that exists, with the missing tail
 * re-appended. `null` when a component exists but cannot be resolved: a
 * dangling symlink (which a write would follow) or an unreadable entry.
 *
 * `realpathSync.native` is the OS call, which returns the on-disk casing and
 * expands 8.3 short names; the JS implementation does neither.
 */
export function realpathAllowingMissing(path: string): string | null {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      if (pathEntryExists(current)) return null
      const parent = dirname(current)
      // The filesystem root always exists; reaching it without a hit means
      // nothing along the path could be resolved — fail closed.
      if (parent === current) return null
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Whether ANY directory entry exists at `path`, links not followed — true for
 * a dangling symlink, which `existsSync` (links followed) reports as absent.
 * The question a new-file writer must ask: an exclusive create (`wx`) is not
 * enough on its own, because on Windows it follows a dangling link and
 * creates the file at the link's target.
 */
export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * `target`'s real path relative to `root`'s real path, POSIX-separated, or
 * `null` when it is not strictly inside `root` (escapes through `..`, is on
 * another drive, is `root` itself) or cannot be resolved at all.
 */
export function realWorkspaceRel(root: string, target: string): string | null {
  const realRoot = realpathAllowingMissing(root)
  const realTarget = realpathAllowingMissing(target)
  if (realRoot === null || realTarget === null) return null
  const rel = relative(realRoot, realTarget)
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

/**
 * Whether `target` (absolute) is a path Studio may write inside the project at
 * `root`: strictly inside it both textually and on the real path, with no
 * unwritable directory on either. The one predicate every writer that builds
 * its own absolute path consults; see this module's doc.
 */
export function isWorkspaceWritablePath(root: string, target: string): boolean {
  const lexical = relative(resolve(root), resolve(target))
  if (lexical === '' || isAbsolute(lexical) || lexical === '..' || lexical.startsWith(`..${sep}`)) return false
  if (unwritableWorkspaceSegment(lexical) !== null) return false
  const real = realWorkspaceRel(root, target)
  return real !== null && unwritableWorkspaceSegment(real) === null
}
