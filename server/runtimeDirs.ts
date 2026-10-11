/**
 * runtimeDirs — the two operator-configurable directories that hold state
 * with no other copy, and the one rule for reading their settings.
 *
 *   - `STUDIO_WORKSPACE_DIR`: the workspace root, every user's projects
 *     (read by `projectsRootDir()` in `handlers/studioProjects.ts`).
 *   - `STUDIO_DATA_DIR`: Studio's private runtime state (`<cwd>/.data` when
 *     unset): encrypted MCP server secrets, the Claude CLI's per-user config
 *     and login, idempotency records, the prepared project seed. Each of
 *     those stores keeps its own narrower override (`MCP_SERVER_SECRETS_DATA_DIR`,
 *     `CLAUDE_CLI_DATA_DIR`, `STUDIO_IDEMPOTENCY_DATA_DIR`,
 *     `STUDIO_PROJECT_SEED_DIR`); this is the shared default they sit under,
 *     so a deployment persists all four with one variable and one volume.
 *
 * Both are read per call (tests set them for the duration of one file), and
 * both are validated at boot by `handlers/studio/workspaceRootGuard.ts`, which refuses
 * to start on a bad value rather than letting a typo put user data on the
 * container's writable layer.
 */
import { isAbsolute, resolve } from 'node:path'

export const WORKSPACE_DIR_ENV = 'STUDIO_WORKSPACE_DIR'
export const DATA_DIR_ENV = 'STUDIO_DATA_DIR'

/** A directory setting that is present but unusable. `message` names the variable and the rule, never the process's own paths. */
export class DirSettingError extends Error {
  readonly variable: string

  constructor(variable: string, message: string) {
    super(message)
    this.name = 'DirSettingError'
    this.variable = variable
  }
}

/**
 * The value of an absolute-directory setting: `undefined` when unset or empty
 * (the caller's default applies), the resolved path when it is absolute.
 * Whitespace-only and relative values THROW: a stray space in a platform
 * variable would otherwise resolve to `<cwd>/ ` and silently put the data
 * outside the mounted volume.
 */
export function readAbsoluteDirSetting(
  variable: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[variable]
  if (raw === undefined || raw === '') return undefined
  const value = raw.trim()
  if (value === '') {
    throw new DirSettingError(variable, `${variable} is set but blank. Unset it, or set it to an absolute directory path.`)
  }
  if (value !== raw) {
    throw new DirSettingError(variable, `${variable} has leading or trailing whitespace. Remove it; the value must be an absolute directory path.`)
  }
  if (!isAbsolute(value)) {
    throw new DirSettingError(variable, `${variable} must be an absolute directory path, not a relative one.`)
  }
  return resolve(value)
}

/** Studio's private runtime-state root: `STUDIO_DATA_DIR`, else `<cwd>/.data`. */
export function resolveStudioDataRoot(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  return readAbsoluteDirSetting(DATA_DIR_ENV, env) ?? resolve(cwd, '.data')
}
