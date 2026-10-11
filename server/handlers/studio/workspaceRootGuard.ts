/**
 * workspaceRootGuard — refuses to boot on a workspace root (or private data
 * root) that overlaps something Studio must never expose as a "project".
 *
 * Every immediate subfolder of the workspace root IS a project, and every
 * project is readable and writable through the `dir`-taking routes and MCP
 * tools. So the root's location is a security boundary, and it is
 * operator-configured (`STUDIO_WORKSPACE_DIR`). Setting it to the mount root
 * of the single-volume layout (`/app/storage`, which also holds `data/cms.db`
 * and `uploads/`) turns the database directory into a project: password
 * hashes, sessions and encrypted secrets become readable, writable and
 * "deletable" (the trash moves `data/` out from under the open SQLite
 * handle). `/app` does the same to Studio's own code, and `/` voids every
 * containment guard. The P1-H security review reproduced the first case.
 *
 * The rule, checked on REAL paths (symlinks resolved, missing tails kept):
 *
 *   - The root must not equal or contain Studio's working directory (its
 *     code), the SQLite database's directory, the uploads directory, the
 *     built admin SPA (`STATIC_DIR`), or any private-data root (`.data`,
 *     `STUDIO_DATA_DIR`, and each store's own override).
 *   - The root must also not sit INSIDE uploads, the static dir, Studio's
 *     `server/`, `src/` or `node_modules/`, or a private-data root: the first
 *     two are served over HTTP, the rest are code or secrets.
 *   - The private-data root, in turn, must not overlap uploads or the static
 *     dir (both served over HTTP).
 *
 * Sitting inside the working directory is the NORMAL layout
 * (`<cwd>/studio-workspace`), and sitting inside the database's directory is
 * harmless (the e2e stack keeps both under `.tmp/`), so those two are
 * "must not contain" only.
 *
 * A violation is fatal: `server/index.ts` logs the message and exits. Unlike
 * the persistence warning (`workspacePersistence.ts`), no one chooses this
 * layout on purpose, and starting anyway would serve the database as a
 * project.
 */
import { dirname, join, resolve } from 'node:path'
import { isSqliteUrl, parseSqlitePath } from '../../db'
import { DATA_DIR_ENV, DirSettingError, resolveStudioDataRoot, WORKSPACE_DIR_ENV } from '../../runtimeDirs'
import { resolveMcpServerSecretsRoot } from '../../ai/credentials/mcpServerSecretStore'
import { projectsRootDir } from '../studioProjects'
import { resolveClaudeCliDataRoot } from './claudeCliEnv'
import { resolveIdempotencyRoot } from './idempotentReplay'
import { resolveProjectSeedDir } from './projectSeed'
import { realpathAllowingMissing } from './workspacePackageResolve'

/** Thrown when the configured layout is unsafe or unreadable. `server/index.ts` turns it into a logged exit. */
export class WorkspaceRootRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceRootRefusal'
  }
}

/**
 * `must-not-contain`: the subject may sit inside it, but may not be it or an
 * ancestor of it. `must-not-overlap`: neither may be, or contain, the other.
 */
export type GuardRule = 'must-not-contain' | 'must-not-overlap'

export interface GuardedDir {
  /** How the operator knows it, e.g. "the uploads directory (UPLOADS_DIR)". */
  label: string
  path: string
  rule: GuardRule
}

/** The server-config values the guard needs; a subset of `ServerConfig`. */
export interface WorkspaceLayoutConfig {
  databaseUrl: string
  uploadsDir: string
  staticDir: string
}

export interface WorkspaceLayoutInput {
  config: WorkspaceLayoutConfig
  env?: Record<string, string | undefined>
  cwd?: string
}

export interface WorkspaceLayout {
  workspaceRoot: string
  dataRoot: string
}

/** Separator-agnostic, trailing-separator-free form, so the comparison is on whole segments on every OS. */
function normalize(path: string): string {
  const forward = path.replaceAll('\\', '/')
  return forward.length > 1 && forward.endsWith('/') ? forward.slice(0, -1) : forward
}

function isAtOrInside(path: string, dir: string): boolean {
  const p = normalize(path)
  const d = normalize(dir)
  if (d === '/' || /^[A-Za-z]:$/.test(d)) return true
  return p === d || p.startsWith(`${d}/`)
}

/**
 * The decision, pure over already-resolved paths: one message per guarded
 * directory that `subjectPath` collides with, empty when it is safe.
 */
export function dirConflicts(subjectLabel: string, subjectPath: string, guarded: readonly GuardedDir[]): string[] {
  const conflicts: string[] = []
  for (const dir of guarded) {
    if (isAtOrInside(dir.path, subjectPath)) {
      const relation = normalize(dir.path) === normalize(subjectPath) ? 'is' : 'contains'
      conflicts.push(`${subjectLabel} (${subjectPath}) ${relation} ${dir.label} (${dir.path}).`)
    } else if (dir.rule === 'must-not-overlap' && isAtOrInside(subjectPath, dir.path)) {
      conflicts.push(`${subjectLabel} (${subjectPath}) is inside ${dir.label} (${dir.path}).`)
    }
  }
  return conflicts
}

function readRoot(read: () => string): string {
  try {
    return read()
  } catch (err) {
    if (err instanceof DirSettingError) throw new WorkspaceRootRefusal(err.message)
    throw err
  }
}

/**
 * Resolves the workspace and private-data roots, and throws
 * {@link WorkspaceRootRefusal} if either setting is malformed (blank,
 * whitespace-padded, relative) or the layout collides as the module doc
 * describes. Reads nothing but paths; creates nothing.
 */
export function assertWorkspaceLayoutSafe(input: WorkspaceLayoutInput): WorkspaceLayout {
  const env = input.env ?? process.env
  const cwd = resolve(input.cwd ?? process.cwd())
  const workspaceRoot = readRoot(() => projectsRootDir(env, cwd))
  const dataRoot = readRoot(() => resolveStudioDataRoot(env, cwd))

  const real = (path: string) => realpathAllowingMissing(resolve(cwd, path))
  const uploads: GuardedDir = { label: 'the uploads directory (UPLOADS_DIR)', path: real(input.config.uploadsDir), rule: 'must-not-overlap' }
  const staticDir: GuardedDir = { label: 'the built admin app (STATIC_DIR)', path: real(input.config.staticDir), rule: 'must-not-overlap' }
  const code: GuardedDir[] = [
    { label: "Studio's working directory (its own code)", path: real(cwd), rule: 'must-not-contain' },
    ...['server', 'src', 'node_modules'].map((name): GuardedDir => ({
      label: `Studio's ${name}/`,
      path: real(join(cwd, name)),
      rule: 'must-not-overlap',
    })),
  ]
  const database: GuardedDir[] = isSqliteUrl(input.config.databaseUrl)
    ? [{ label: "the SQLite database's directory (DATABASE_URL)", path: real(dirname(parseSqlitePath(input.config.databaseUrl))), rule: 'must-not-contain' }]
    : []
  const privateData: GuardedDir[] = [
    { label: `Studio's private data (${DATA_DIR_ENV})`, path: real(dataRoot), rule: 'must-not-overlap' },
    { label: 'the MCP server secret store', path: real(readRoot(() => resolveMcpServerSecretsRoot(env))), rule: 'must-not-overlap' },
    { label: 'the Claude CLI config store', path: real(readRoot(() => resolveClaudeCliDataRoot(env))), rule: 'must-not-overlap' },
    { label: 'the idempotency record store', path: real(readRoot(() => resolveIdempotencyRoot(env))), rule: 'must-not-overlap' },
    { label: 'the project seed directory', path: real(readRoot(() => resolveProjectSeedDir(env))), rule: 'must-not-overlap' },
  ]

  const realWorkspace = real(workspaceRoot)
  const realData = real(dataRoot)
  const conflicts = [
    ...dirConflicts(`The workspace root (${WORKSPACE_DIR_ENV})`, realWorkspace, [...code, uploads, staticDir, ...database, ...privateData]),
    // Workspace-vs-data overlap is already caught, both ways, by the check above.
    ...dirConflicts(`The private data root (${DATA_DIR_ENV})`, realData, [uploads, staticDir]),
  ]
  if (conflicts.length > 0) {
    throw new WorkspaceRootRefusal(
      `Refusing to start: ${conflicts.join(' ')} Every folder under the workspace root is served as an editable project, ` +
        `so it must be a DEDICATED directory: for example /app/studio-workspace on its own volume, or ` +
        `/app/storage/studio-workspace next to the database and uploads, never the volume's mount root. ` +
        'See docs/deployment/README.md, "Persistence Rules".',
    )
  }
  return { workspaceRoot, dataRoot }
}
