import type { ParentLayoutResult } from './protocol.js';
import { DATA_DYNAMIC_ATTR, DATA_UID_ATTR, findByUid, rectToPlain } from './dom.js';

/**
 * `report-parent-layout` (FP-4b, `.orchestrator/FEATURE-PARITY-PLAN.md` §2
 * FP-4 third bullet, D-EDIT decision §0/§5) — runs INSIDE the file-app
 * iframe, like every other module in this package. Given a `uid`, reports
 * whether its REAL DOM `.parentElement` is a flex/grid container (LIVE,
 * from computed style — Tailwind classes are only a hint the browser has
 * already resolved into `display`/`flex-direction`/`grid-auto-flow`, so
 * reading computed style is strictly more correct than re-parsing class
 * names) so the caller can pick reorder-vs-free-drag.
 *
 * ## Why the real DOM parent, not `nearestUidAncestor`
 * Layout mode is a property of the actual CSS containing block relationship
 * — the element's genuine `.parentElement` — not of the nearest ANCESTOR
 * that happens to carry `data-uid`. Those usually coincide (every JSXElement
 * in a file gets tagged unconditionally by `vite-plugin-source-uid`), but
 * two real gaps exist where they don't: a JSX **fragment** ancestor renders
 * no DOM node of its own (so `.parentElement` skips straight past it to
 * whatever real element is further up), and a **component-instance
 * boundary** (e.g. `<Frame />`) only carries its uid as a React PROP, not a
 * DOM attribute, unless that component's own implementation forwards it —
 * so the rendered root's real `.parentElement` can belong to a totally
 * different, untagged part of the tree. This function always reads the
 * TRUE `.parentElement`'s computed style (correct for the flex/grid
 * question), but only reports `parentUid` when that real parent ALSO
 * happens to carry `data-uid` (required for `move-node`'s `newParentUid` —
 * see `ParentLayoutInfo`'s doc: a `null` parentUid means the reorder branch
 * has nothing addressable to write `move-node` against, a disclosed
 * carry-forward rather than a silent wrong-parent write).
 *
 * ## Sibling ordering
 * `siblingUids` is every DIRECT CHILD of the parent carrying `data-uid`, in
 * real DOM order — NOT a deep `querySelectorAll` (which would also catch
 * grandchildren). This is what the caller needs to compute a drop index via
 * `report-rects` (existing, reused verbatim) without a new rect primitive.
 */

function axisFromFlexDirection(direction: string): 'row' | 'column' {
  return direction.startsWith('column') ? 'column' : 'row';
}

function axisFromGridAutoFlow(autoFlow: string): 'row' | 'column' {
  return autoFlow.startsWith('column') ? 'column' : 'row';
}

export function computeParentLayout(uid: string, doc: Document = document): ParentLayoutResult {
  const win = doc.defaultView;
  const el = findByUid(doc, uid);
  if (!el) return { ok: false, reason: 'not-found' };
  if (el.getAttribute(DATA_DYNAMIC_ATTR) === 'true') return { ok: false, reason: 'dynamic-locked' };

  const parentEl = el.parentElement;
  if (!parentEl || !win) return { ok: false, reason: 'no-parent' };

  const parentStyle = win.getComputedStyle(parentEl);
  const display = parentStyle.display;

  let mode: 'flex' | 'grid' | 'none' = 'none';
  let axis: 'row' | 'column' = 'row';
  if (display === 'flex' || display === 'inline-flex') {
    mode = 'flex';
    axis = axisFromFlexDirection(parentStyle.flexDirection);
  } else if (display === 'grid' || display === 'inline-grid') {
    mode = 'grid';
    axis = axisFromGridAutoFlow(parentStyle.gridAutoFlow);
  }

  const siblingUids: string[] = [];
  for (const child of Array.from(parentEl.children)) {
    const childUid = child.getAttribute(DATA_UID_ATTR);
    if (childUid) siblingUids.push(childUid);
  }
  const index = Math.max(0, siblingUids.indexOf(uid));

  return {
    ok: true,
    info: {
      mode,
      axis,
      parentUid: parentEl.getAttribute(DATA_UID_ATTR),
      parentPositioned: parentStyle.position !== 'static',
      parentRect: rectToPlain(parentEl.getBoundingClientRect()),
      index,
      siblingUids,
    },
  };
}
