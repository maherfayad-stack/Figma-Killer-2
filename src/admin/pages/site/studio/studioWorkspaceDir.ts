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
 * Persisted (sticky) via localStorage: a refresh keeps browsing the same
 * project instead of reverting to the first one.
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

/**
 * Whatever the last `loadSite` reported as the dir it actually read — the
 * fallback for a session with no explicit selection (the server picked the
 * first project on disk, and every later write must target the SAME one).
 * Module state rather than a store slice because it is ephemeral,
 * server-derived, per-load state, not part of the persisted `SiteDocument`.
 */
let loadedDir: string | null = null

export function setStudioLoadedDir(dir: string | null): void {
  loadedDir = dir
}

/**
 * The dir every studio call targets: the explicitly-selected project when
 * there is one, otherwise whatever the last load reported. Every client call
 * resolves it the same way, so a save, a catalog read, or a targeted reload
 * can never land in a different project than the canvas is showing.
 *
 * Lives here rather than beside the save requests it was extracted from: this
 * module already owns "which project directory is active", and half a dozen
 * unrelated clients (icon/component/translation catalogs, page requests, the
 * board resync) were importing the save module purely to ask this question.
 */
export function studioWriteDir(): string | null {
  return getStudioWorkspaceDir() ?? loadedDir
}
