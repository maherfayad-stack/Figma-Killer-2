import type { FreeDropResult } from './protocol.js';
import { DATA_DYNAMIC_ATTR, DATA_UID_ATTR, findByUid } from './dom.js';

/**
 * `resolve-free-drop` (FP-4b, D-EDIT decision §0/§5, FREE-DRAG branch) —
 * runs INSIDE the file-app iframe. The studio already knows WHERE the
 * element should land (its own camera/geometry math converts the drag
 * gesture's screen delta to an iframe-space target top-left — no new
 * geometry primitive on the canvas side); what only the bridge can resolve
 * is the RTL-correct, computed-style-dependent part: which CSS logical
 * position the target point represents, and which class strings to
 * add/remove on the real DOM node.
 *
 * ## RTL choice (playbook §5.9/ADR-0022 logical-props-first)
 * Written back as Tailwind's LOGICAL inset utilities — `start-[Npx]` (maps
 * to `inset-inline-start`) instead of `left-[Npx]` — plus `top-[Npx]`
 * (block-start; the vertical axis never flips under `dir="rtl"`, only the
 * inline/horizontal one does, so `top` needs no logical counterpart here).
 * `start`/`end` are resolved from the dragged element's own computed CSS
 * `direction` (`ltr` -> start=left, `rtl` -> start=right): the browser
 * itself then does the visual mirroring for `inset-inline-start` — this
 * function only has to pick the right NUMBER (distance from the parent's
 * true start edge), not swap `left`/`right` by hand, which is the failure
 * mode a naive "same code for every direction" implementation would hit.
 *
 * ## Idempotent re-drag
 * The dragged node's CURRENT `class` attribute is scanned for any class
 * this feature itself could have written on an EARLIER drop
 * (`isManagedPositionClass`) and those are reported in `removeClasses` —
 * so re-dragging an already-free-positioned element doesn't accumulate
 * stale `top-[..]`/`start-[..]` classes. Never touches any OTHER class.
 *
 * ## Containing block
 * If the parent's OWN computed `position` is still `static`, `absolute`
 * would position against a FURTHER ancestor (the frame root, typically) —
 * visually "escaping" its intended container. `parentAddClasses` reports
 * `['relative']` for that case (only when the parent is itself addressable
 * — `parentUid` non-null) so the caller can emit a second `set-classes` op
 * containing the drop, matching Penpot's "an element's canvas ends up
 * exactly where you dropped it" feel even though this is a real DOM/CSS
 * layout, not a free vector canvas.
 */

const MANAGED_POSITION_CLASS_RE = /^(?:absolute|(?:start|end|top|bottom|left|right)-\[.*\])$/;

function isManagedPositionClass(className: string): boolean {
  return MANAGED_POSITION_CLASS_RE.test(className);
}

export function resolveFreeDrop(
  uid: string,
  targetX: number,
  targetY: number,
  doc: Document = document,
): FreeDropResult {
  const win = doc.defaultView;
  const el = findByUid(doc, uid);
  if (!el) return { ok: false, reason: 'not-found' };
  if (el.getAttribute(DATA_DYNAMIC_ATTR) === 'true') return { ok: false, reason: 'dynamic-locked' };

  const parentEl = el.parentElement;
  if (!parentEl || !win) return { ok: false, reason: 'no-parent' };

  const parentRect = parentEl.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const rtl = win.getComputedStyle(el).direction === 'rtl';

  const insetBlockStart = Math.max(0, Math.round(targetY - parentRect.top));
  const insetInlineStart = Math.max(
    0,
    Math.round(rtl ? parentRect.right - (targetX + elRect.width) : targetX - parentRect.left),
  );

  const existingClasses = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const removeClasses = existingClasses.filter(isManagedPositionClass);
  const addClasses = ['absolute', `start-[${insetInlineStart}px]`, `top-[${insetBlockStart}px]`];

  const parentUid = parentEl.getAttribute(DATA_UID_ATTR);
  const parentStyle = win.getComputedStyle(parentEl);
  const parentAddClasses = parentUid && parentStyle.position === 'static' ? ['relative'] : [];

  return {
    ok: true,
    info: { addClasses, removeClasses, parentUid, parentAddClasses },
  };
}
