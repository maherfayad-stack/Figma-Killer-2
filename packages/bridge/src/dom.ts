import type { Rect } from './protocol.js';

export const DATA_UID_ATTR = 'data-uid';
export const DATA_DYNAMIC_ATTR = 'data-dynamic';
export const DATA_COMPONENT_ATTR = 'data-component';

export function rectToPlain(rect: DOMRect | DOMRectReadOnly): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Find the element carrying a given `data-uid`. Deliberately scans +
 * compares via `getAttribute` rather than building a dynamic
 * `[data-uid="${uid}"]` CSS attribute-selector string — a uid embeds `:`,
 * `.`, and `/` characters that are legal inside a quoted CSS attribute
 * value, but this sidesteps ever having to think about escaping if the
 * uid's character set changes later (e.g. quotes) and keeps this immune to
 * selector-injection entirely, at negligible cost (a handful of uids per
 * bridge call, a document with at most a few hundred tagged nodes).
 */
export function findByUid(root: ParentNode, uid: string): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(`[${DATA_UID_ATTR}]`);
  for (const el of candidates) {
    if (el.getAttribute(DATA_UID_ATTR) === uid) return el;
  }
  return null;
}

/** Nearest ancestor (inclusive) of `el` carrying `data-uid`, or null. */
export function nearestUidAncestor(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(`[${DATA_UID_ATTR}]`);
}
