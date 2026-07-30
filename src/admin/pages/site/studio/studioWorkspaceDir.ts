/**
 * studioWorkspaceDir — which on-disk project directory Studio mode is
 * currently pointed at.
 *
 * Every project is an immediate subfolder of `studio-workspace/` (see
 * `resolveProjectDir` in `server/handlers/studio.ts`). The Overview launcher
 * sets this to a concrete project dir whenever the user opens one. `undefined`
 * means "no explicit selection yet" — the server then falls back to the first
 * project on disk, so a fresh session still lands somewhere real.
 *
 * Set explicitly by the Overview launcher (and after a GitHub import): the
 * project's `dir` becomes the active workspace, so every subsequent
 * load/save/boards/download call targets the SAME directory, instead of
 * leaving some calls pointed at a different project — a real correctness risk,
 * since a stray `saveBoards()` call would otherwise overwrite the WRONG
 * project's `.studio/boards.json`.
 *
 * Persisted (sticky) the same way `studioMode`'s flag is: a refresh keeps
 * browsing the same project instead of reverting to the first one.
 */
const STUDIO_WORKSPACE_DIR_STORAGE_KEY = 'studio:studio:dir'

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
