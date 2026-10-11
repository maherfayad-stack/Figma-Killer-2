/**
 * styleLandings — where the last style edits LANDED (G-5), kept for the
 * inspector's chip ("Saved in Card.module.css" / "as an override" / "inline").
 *
 * A style edit never refuses: it takes the first honest rung of a ladder, and
 * the SERVER knows which one it took (`StudioEditBatchResult.styleLandings`) —
 * whether a shorthand stood in the way, whether the value sat behind a
 * `${…}`. The client cannot know that before the write (it holds no stylesheet
 * text: postcss stays out of the editor bundle), so the chip reports AFTER the
 * save, which is also when "saved" is true.
 *
 * ## Subjects
 *
 * A landing is filed under what the inspector can ask about:
 *   - `rule:<StyleRule.id>` for a `css`/`styled` edit, joined back through the
 *     save plan's `ruleIdsByNodeId` (a `css` edit's id is synthetic, a styled
 *     edit's is its template tag, which every rule of that template shares);
 *   - `node:<node id>` for an inline `style` edit.
 * `styleLandingSubjects(nodeId, classIds)` is the question for a selection, and
 * the newest answer among them wins.
 *
 * ## Undo
 *
 * A landing that a plain "write the previous value back" cannot undo byte for
 * byte (`expanded`, `override`) carries the batch's undo-journal token. The
 * chip's Undo posts the `restore` and re-reads the board; a stylesheet written
 * since then makes the server refuse `restore-stale`, which is said, not forced.
 *
 * A tiny external store, for the reason `studioRawCssStores.ts` is one: the
 * chip reads it with `useSyncExternalStore` instead of subscribing to a
 * document whose reference changes on every unrelated edit.
 */
import { styleLandingNeedsJournal, type StyleLanding, type StyleLandingRung } from '@core/page-tree'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { pushToast } from '@ui/components/Toast'
import { restoreEdit } from './structuralUndoPlan'
import { postEdits } from './studioSaveRequests'

export interface RecordedStyleLanding {
  rung: StyleLandingRung
  /** Workspace-relative path of the file the value went into. */
  file: string
  /** The undo-journal token that puts every byte back, when this landing needs one. */
  undoToken: string | null
  /** Strictly increasing — the newest of several subjects wins. */
  sequence: number
}

const landings = new Map<string, RecordedStyleLanding>()
const listeners = new Set<() => void>()
let version = 0
let sequence = 0

function changed(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeStyleLandings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Changes whenever a landing is recorded or cleared — the `useSyncExternalStore` snapshot. */
export function styleLandingsVersion(): number {
  return version
}

export const ruleLandingSubject = (ruleId: string): string => `rule:${ruleId}`
export const nodeLandingSubject = (nodeId: string): string => `node:${nodeId}`

/** What to ask about for a selected node: its own inline layer, then each class it carries. */
export function styleLandingSubjects(nodeId: string | null, classIds: readonly string[]): string[] {
  return [...(nodeId === null ? [] : [nodeLandingSubject(nodeId)]), ...classIds.map(ruleLandingSubject)]
}

/**
 * Record one save response's landings. `ruleIdsByNodeId` is the save plan's join
 * from an edit's id to the rules that edit wrote; a landing with no rule (an
 * inline edit) is filed under its node.
 */
export function recordStyleLandings(
  reported: readonly StyleLanding[],
  ruleIdsByNodeId: Readonly<Record<string, readonly string[]>>,
  undoToken: string | undefined,
): void {
  if (reported.length === 0) return
  for (const landing of reported) {
    const recorded: RecordedStyleLanding = {
      rung: landing.rung,
      file: landing.file,
      undoToken: undoToken !== undefined && styleLandingNeedsJournal(landing.rung) ? undoToken : null,
      sequence: (sequence += 1),
    }
    const ruleIds = ruleIdsByNodeId[landing.nodeId]
    const subjects = ruleIds && ruleIds.length > 0 ? ruleIds.map(ruleLandingSubject) : [nodeLandingSubject(landing.nodeId)]
    for (const subject of subjects) landings.set(subject, recorded)
  }
  changed()
}

/** The newest landing among `subjects`, or `null` when none was reported this session. */
export function latestStyleLanding(subjects: readonly string[]): RecordedStyleLanding | null {
  let newest: RecordedStyleLanding | null = null
  for (const subject of subjects) {
    const landing = landings.get(subject)
    if (landing && (newest === null || landing.sequence > newest.sequence)) newest = landing
  }
  return newest
}

/** Cleared by `loadSite` — a fresh document has no "last write" to talk about. */
export function resetStyleLandings(): void {
  if (landings.size === 0) return
  landings.clear()
  changed()
}

/**
 * Take back the batch behind `token` byte for byte, then re-read the board. The
 * server refuses by name when a file has changed since (`restore-stale`) — that
 * sentence is shown, and nothing is written.
 */
export async function undoStyleLanding(token: string): Promise<void> {
  try {
    const result = await postEdits([restoreEdit(token)])
    const refusal = (result.refusals ?? [])[0]
    if (refusal) {
      pushToast({ kind: 'warning', title: 'That style change could not be undone', body: refusal.message })
      return
    }
    resetStyleLandings()
    await requestCmsSiteReload()
  } catch (err) {
    console.error('[styleLandings] undo failed:', err)
    pushToast({ kind: 'warning', title: 'That style change could not be undone', body: 'Studio could not reach the server. Nothing was changed.' })
  }
}
