/**
 * projectThumbnailQueue — the only thing that should call
 * `captureProjectThumbnail` in production, because a capture has three
 * properties a caller must respect and none of them are visible at the call
 * site.
 *
 * **It is serialised.** `browserPool.ts` keeps ONE warm Chromium and runs one
 * capture at a time by design; a launcher render of a fresh workspace would
 * otherwise ask it for twenty at once, and "two concurrent batches is exactly
 * the shape that turns a shared admin server into an OOM" is that module's own
 * warning. Every request here joins a single promise chain.
 *
 * **It never blocks its trigger.** Both callers are request handlers — the
 * launcher listing and the source-writeback batch — and neither is allowed to
 * get slower because a screenshot is due. Every entry point returns `void`
 * synchronously and the work happens on the chain behind it.
 *
 * **It remembers failures for the process lifetime.** A project that cannot be
 * photographed (no board frames, no Chromium on the host, an unwritable
 * sidecar) would otherwise be retried on every single launcher render — a
 * browser launch per render, forever, for a tile that is never going to
 * change. The memo is per process, so a restart is the retry: whatever a
 * failure was about, it is exactly the kind of thing a deploy or a restart
 * fixes.
 *
 * A SAVE clears that memo for the project it names. The memo exists to stop a
 * pointless retry loop on a passive read, and a save is not a passive read —
 * it is evidence the project changed, and the most likely cause of the earlier
 * `no-frame` failure (a project with no board frames yet) is exactly what a
 * save fixes.
 *
 * ## Why a factory rather than module state
 *
 * The default instance below is module state, and has to be — the debounce
 * window and the failure memo only mean anything if every trigger shares one.
 * But a queue whose serialisation and memo could only be exercised through a
 * real Chromium would not be tested at all, so the behaviour lives in
 * `createProjectThumbnailQueue`, which takes its capture function as an
 * option. Tests build their own instance; nothing mutates a global to fake one.
 */
import { captureProjectThumbnail, type CaptureProjectThumbnailResult } from './projectThumbnail'
import { readProjectThumbnailStat } from './projectThumbnailFile'

/**
 * How long after the last write in a project a thumbnail refresh fires.
 *
 * Trailing-edge: editing is a stream of saves, not an event, and capturing on
 * each one would spend a Chromium page per keystroke-driven writeback to
 * produce nineteen images nobody ever sees. Long enough to sit out an active
 * editing burst, short enough that a user who edits and then returns to the
 * launcher finds the tile already updated.
 */
const SAVE_DEBOUNCE_MS = 15_000

export interface ProjectThumbnailQueue {
  /**
   * Requests a capture only for a project that has no thumbnail on disk. The
   * launcher listing's lazy backfill — safe to call for every project on every
   * render, because a project that already has one is a single `stat`.
   */
  backfill(dir: string): void
  /**
   * Requests a debounced refresh after a batch of source edits landed in
   * `dir`. Cheap and idempotent — each call restarts the window.
   */
  refreshAfterSave(dir: string): void
  /** Resolves when nothing is running or queued. The seam that makes serialisation observable to a test. */
  idle(): Promise<void>
}

export interface ProjectThumbnailQueueOptions {
  /** Stands in for `captureProjectThumbnail`. Tests only. */
  capture?: (dir: string) => Promise<CaptureProjectThumbnailResult>
  /** Stands in for the on-disk check `backfill` gates on. Tests only. */
  hasThumbnail?: (dir: string) => boolean
  /** Overrides {@link SAVE_DEBOUNCE_MS}. Tests only. */
  saveDebounceMs?: number
}

export function createProjectThumbnailQueue(
  options: ProjectThumbnailQueueOptions = {},
): ProjectThumbnailQueue {
  const capture = options.capture ?? ((dir: string) => captureProjectThumbnail(dir))
  const hasThumbnail = options.hasThumbnail ?? ((dir: string) => readProjectThumbnailStat(dir) !== null)
  const debounceMs = options.saveDebounceMs ?? SAVE_DEBOUNCE_MS

  /** Projects whose capture failed. Never retried by `backfill` again this process — see the module doc. */
  const failed = new Set<string>()
  /** Projects already waiting their turn on the chain, so a second trigger does not queue a duplicate. */
  const queued = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The tail of the single promise chain every capture runs on. Never rejects — each link swallows its own failure. */
  let tail: Promise<void> = Promise.resolve()

  function enqueue(dir: string): void {
    if (failed.has(dir) || queued.has(dir)) return
    queued.add(dir)
    tail = tail.then(async () => {
      queued.delete(dir)
      try {
        const result = await capture(dir)
        if (!result.ok) {
          failed.add(dir)
          console.error(`[studio:thumbnail] ${dir}: ${result.error}`)
        }
      } catch (err) {
        // `captureProjectThumbnail` returns its failures rather than throwing,
        // so reaching here means something genuinely unexpected happened. It
        // still must not reject the shared chain, which every later capture
        // is chained onto.
        failed.add(dir)
        console.error('[studio:thumbnail]', err)
      }
    })
  }

  return {
    backfill(dir: string): void {
      if (hasThumbnail(dir)) return
      enqueue(dir)
    },

    refreshAfterSave(dir: string): void {
      const pending = timers.get(dir)
      if (pending) clearTimeout(pending)
      const timer = setTimeout(() => {
        timers.delete(dir)
        // A save is evidence the project changed — see the module doc on why
        // this trigger, and only this trigger, forgives an earlier failure.
        failed.delete(dir)
        enqueue(dir)
      }, debounceMs)
      // A pending thumbnail must never be the reason a process stays alive.
      timer.unref?.()
      timers.set(dir, timer)
    },

    async idle(): Promise<void> {
      // Awaiting `tail` once is not enough: a capture that is running can have
      // had another chained behind it in the meantime, and the caller means
      // "when everything settles".
      let previous: Promise<void> | null = null
      while (previous !== tail) {
        previous = tail
        await tail
      }
    },
  }
}

/** The process-wide queue. Both triggers share it — that is the point of the memo and the debounce window. */
export const projectThumbnailQueue = createProjectThumbnailQueue()
