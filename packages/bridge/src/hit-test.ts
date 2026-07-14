import type { BreadcrumbEntry, HitInfo } from './protocol.js';
import {
  DATA_COMPONENT_ATTR,
  DATA_DYNAMIC_ATTR,
  DATA_UID_ATTR,
  nearestUidAncestor,
  rectToPlain,
} from './dom.js';

/**
 * `hit-test` — playbook §4/P2 + ADR-0016: `document.elementFromPoint(x, y)`
 * inside the iframe, walk up to the nearest `data-uid` ancestor,
 * report `{uid, rect, dynamic, component, breadcrumb}`.
 *
 * `doc` is injectable (defaults to the real `document`) so tests can pass a
 * jsdom document without needing a real browser painter for
 * `elementFromPoint` (jsdom's `elementFromPoint` always returns `null`
 * unless stubbed — tests stub it directly; see `hit-test.test.ts`).
 */
export function performHitTest(x: number, y: number, doc: Document = document): HitInfo | null {
  const el = doc.elementFromPoint(x, y);
  if (!el) return null;

  const uidEl = nearestUidAncestor(el);
  if (!uidEl) return null;

  const uid = uidEl.getAttribute(DATA_UID_ATTR);
  if (!uid) return null;

  return {
    uid,
    rect: rectToPlain(uidEl.getBoundingClientRect()),
    dynamic: uidEl.getAttribute(DATA_DYNAMIC_ATTR) === 'true',
    component: uidEl.getAttribute(DATA_COMPONENT_ATTR),
    breadcrumb: buildBreadcrumb(uidEl),
  };
}

/**
 * Breadcrumb order: OUTERMOST -> INNERMOST, with the LAST entry being the
 * hit node itself (same uid as `HitInfo.uid`). `name` prefers
 * `data-component` (so e.g. "ds:Button" reads recognizably in a breadcrumb
 * bar) and falls back to the lowercase tag name for plain host elements.
 */
export function buildBreadcrumb(el: Element): BreadcrumbEntry[] {
  const chain: BreadcrumbEntry[] = [];
  let current: Element | null = el;

  while (current) {
    if (current.hasAttribute(DATA_UID_ATTR)) {
      const uid = current.getAttribute(DATA_UID_ATTR);
      if (uid) {
        const name = current.getAttribute(DATA_COMPONENT_ATTR) ?? current.tagName.toLowerCase();
        chain.push({ uid, name });
      }
    }
    current = current.parentElement;
  }

  return chain.reverse();
}
