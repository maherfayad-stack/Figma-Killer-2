/**
 * studioWorkspaceDir — which on-disk workspace directory Studio mode is
 * currently pointed at.
 *
 * `undefined` (the default) means "the server's default workspace"
 * (`studio-workspace/`, see `defaultWorkspaceDir()` in
 * `server/handlers/studio.ts`) — every studio client call that accepts an
 * optional `dir` already treats an omitted value this way.
 *
 * Set explicitly after a GitHub import (`ImportGithubDialog`): the `dir` the
 * import returned becomes the active workspace, so every subsequent
 * load/save/boards/download call targets the SAME directory the import wrote
 * to, instead of leaving some calls pointed at the previous workspace — a
 * real correctness risk, since a stray `saveBoards()` call would otherwise
 * overwrite the WRONG workspace's `.studio/boards.json`.
 *
 * Persisted (sticky) the same way `studioMode`'s flag is: a refresh keeps
 * browsing the imported project instead of silently reverting to the default
 * workspace.
 */
const STUDIO_WORKSPACE_DIR_STORAGE_KEY = 'instatic:studio:dir'

/** The active workspace dir override, or `undefined` for the server default. */
export function getStudioWorkspaceDir(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage.getItem(STUDIO_WORKSPACE_DIR_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Sets the active workspace dir override; pass `null` to return to the server default. */
export function setStudioWorkspaceDir(dir: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (dir) window.localStorage.setItem(STUDIO_WORKSPACE_DIR_STORAGE_KEY, dir)
    else window.localStorage.removeItem(STUDIO_WORKSPACE_DIR_STORAGE_KEY)
  } catch {
    // localStorage unavailable (private mode / disabled) — the override
    // can't be recorded, so subsequent reads fall back to the server default.
  }
}
