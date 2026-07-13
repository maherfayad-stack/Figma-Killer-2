/**
 * Screenshot cache, keyed per frame id + "generation" (playbook §4/P1 Perf
 * requirements: "cached per HMR generation"). A frame's generation bumps
 * every time an `hmr-update`/`file-changed` event arrives for it; a cached
 * screenshot from an older generation is `stale` — still served (better a
 * slightly-out-of-date screenshot than a blank frame while panned away)
 * but flagged so a caller knows to recapture next time that frame goes
 * live. Pure in-memory data structure, no DOM/canvas/html-to-image here —
 * kept separate so the cache's invalidation *policy* is unit-testable
 * without a browser (the actual pixel capture is `screenshot-capture.ts`).
 */

export interface ScreenshotCacheEntry {
  dataUrl: string;
  /** The generation this screenshot was captured at. */
  generation: number;
}

export interface ScreenshotCache {
  /** Bump and return a frame's generation counter (call on every
   * hmr-update/file-changed for that frame's source). */
  bumpGeneration(id: string): number;
  currentGeneration(id: string): number;
  /** Store a freshly-captured screenshot, stamped with the frame's
   * *current* generation at capture time. */
  set(id: string, dataUrl: string): void;
  get(id: string): ScreenshotCacheEntry | undefined;
  /** True if there's no entry, or the entry predates the current
   * generation (a fresher capture should be taken opportunistically). */
  isStale(id: string): boolean;
  delete(id: string): void;
  clear(): void;
}

export function createScreenshotCache(): ScreenshotCache {
  const entries = new Map<string, ScreenshotCacheEntry>();
  const generations = new Map<string, number>();

  return {
    bumpGeneration(id) {
      const next = (generations.get(id) ?? 0) + 1;
      generations.set(id, next);
      return next;
    },
    currentGeneration(id) {
      return generations.get(id) ?? 0;
    },
    set(id, dataUrl) {
      entries.set(id, { dataUrl, generation: generations.get(id) ?? 0 });
    },
    get(id) {
      return entries.get(id);
    },
    isStale(id) {
      const entry = entries.get(id);
      if (!entry) return true;
      return entry.generation !== (generations.get(id) ?? 0);
    },
    delete(id) {
      entries.delete(id);
      generations.delete(id);
    },
    clear() {
      entries.clear();
      generations.clear();
    },
  };
}
