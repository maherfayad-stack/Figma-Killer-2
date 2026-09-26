/**
 * listRowRemap — where a `.map` row went after a `list-item` write (OD-8).
 *
 * A row's id is `<template>#<index>`: a POSITION in its list, not an
 * identity. When a write reorders, removes or copies array elements, the row
 * a user was pointing at comes back under a different index — and the old id
 * now names a DIFFERENT row. The P1-A identity table cannot help (every row
 * of one template shares one fingerprint), so a gesture queued behind the
 * write (`structuralCommitQueue.ts` — ⌥↓ pressed twice quickly) would act on
 * whichever row slid into the old index.
 *
 * Each landed list write records old-row-id → new-row-id for its whole list
 * here, under a generation number. A queued gesture remembers the generation
 * it was queued at and maps its ids through every remap recorded since.
 */

interface RecordedRemap {
  generation: number
  remap: ReadonlyMap<string, string>
}

/** Enough to cover a burst of queued presses; older remaps can no longer be asked for. */
const MAX_REMAPS = 32

let generation = 0
const recorded: RecordedRemap[] = []

/** The generation a gesture being queued now should remember. */
export function listRowRemapGeneration(): number {
  return generation
}

/** A list write landed: `remap` takes every row id of its list from before the write to after it. */
export function recordListRowRemap(remap: ReadonlyMap<string, string>): void {
  generation += 1
  recorded.push({ generation, remap })
  if (recorded.length > MAX_REMAPS) recorded.shift()
}

/** `nodeId` as it is now, having been captured at generation `since`. Unchanged when no remap since names it. */
export function remapListRowId(nodeId: string, since: number): string {
  let id = nodeId
  for (const entry of recorded) {
    if (entry.generation <= since) continue
    id = entry.remap.get(id) ?? id
  }
  return id
}

/** Test seam: forget every recorded remap. */
export function resetListRowRemaps(): void {
  recorded.length = 0
  generation = 0
}
