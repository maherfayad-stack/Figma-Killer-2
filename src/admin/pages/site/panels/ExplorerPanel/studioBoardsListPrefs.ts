/**
 * studioBoardsListPrefs — sticky UI preferences for the Studio explorer's
 * "Boards" section: whether it's collapsed, and how tall the list renders.
 *
 * Local to this browser (localStorage), same pattern as `studioWorkspaceDir`
 * — this is layout chrome, not something that belongs in
 * `.studio/boards.json` (which is spatial board content: frames/notes/docs)
 * or the server-backed dashboard layout (which is a different panel
 * entirely). A fresh tab keeps the user's last collapse/height choice instead
 * of resetting every reload.
 */
const COLLAPSED_KEY = 'studio:studio:boardsListCollapsed'
const HEIGHT_KEY = 'studio:studio:boardsListHeight'

export const BOARDS_LIST_MIN_HEIGHT = 80
export const BOARDS_LIST_DEFAULT_HEIGHT = 160
export const BOARDS_LIST_MAX_HEIGHT = 360

export function getBoardsListCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function setBoardsListCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // localStorage unavailable (private mode / disabled) — the choice just
    // doesn't stick across reloads.
  }
}

function clampHeight(value: number): number {
  return Math.max(BOARDS_LIST_MIN_HEIGHT, Math.min(BOARDS_LIST_MAX_HEIGHT, value))
}

export function getBoardsListHeight(): number {
  if (typeof window === 'undefined') return BOARDS_LIST_DEFAULT_HEIGHT
  try {
    const raw = window.localStorage.getItem(HEIGHT_KEY)
    const parsed = raw === null ? NaN : Number.parseFloat(raw)
    return Number.isFinite(parsed) ? clampHeight(parsed) : BOARDS_LIST_DEFAULT_HEIGHT
  } catch {
    return BOARDS_LIST_DEFAULT_HEIGHT
  }
}

export function setBoardsListHeight(height: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(HEIGHT_KEY, String(clampHeight(height)))
  } catch {
    // localStorage unavailable — the size just doesn't stick across reloads.
  }
}
