import type { Rect } from './protocol.js';
import { findByUid, rectToPlain } from './dom.js';

/** `report-rects` — `getBoundingClientRect` per requested uid; `null` for
 * any uid not currently present in the DOM (detached/removed node — the
 * studio side is expected to treat this the same as an HMR uid-remap
 * miss). */
export function reportRects(uids: string[], doc: Document = document): Record<string, Rect | null> {
  const result: Record<string, Rect | null> = {};
  for (const uid of uids) {
    const el = findByUid(doc, uid);
    result[uid] = el ? rectToPlain(el.getBoundingClientRect()) : null;
  }
  return result;
}
