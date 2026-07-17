import type { ComputedStyleResult, ComputedStyleRow, ComputedStyleGroup } from './protocol.js';
import { findByUid } from './dom.js';

/**
 * `report-computed-style` (FP-INS-b, `.orchestrator/FEATURE-PARITY-PLAN.md`
 * "Inspect / code tab") — runs INSIDE the file-app iframe, like every other
 * module in this package (mirrors `parent-layout.ts`'s structure exactly:
 * `findByUid` -> `getComputedStyle` -> shape the result). Reports a CURATED
 * set of computed CSS values for `uid`, grouped like Penpot's own dev-mode
 * Inspect attribute sections (`inspect/attributes/layout.cljs` — layout;
 * `geometry.cljs` — box/position; `text.cljs` — typography; `fill.cljs` —
 * color) — never the full ~300-entry `CSSStyleDeclaration` dump the task
 * brief explicitly warns against.
 *
 * Read-only: this never mutates the DOM, and (unlike `parent-layout.ts`'s
 * `dynamic-locked` refusal, which exists because THAT result feeds a
 * DRAG decision) there's no reason to refuse a `dynamic`-locked node here —
 * Penpot's own Inspect/dev-mode CSS view shows computed styles for any
 * shape, editable or not.
 */

const LAYOUT_PROPS = [
  'display',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
] as const;

const GEOMETRY_PROPS = [
  'width',
  'height',
  'position',
  'top',
  'left',
  'border-radius',
  'box-shadow',
  'opacity',
  'z-index',
] as const;

const TYPOGRAPHY_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'text-transform',
] as const;

const COLOR_PROPS = ['color', 'background-color', 'border-color'] as const;

const GROUPED_PROPS: ReadonlyArray<{ group: ComputedStyleGroup; props: readonly string[] }> = [
  { group: 'layout', props: LAYOUT_PROPS },
  { group: 'geometry', props: GEOMETRY_PROPS },
  { group: 'typography', props: TYPOGRAPHY_PROPS },
  { group: 'color', props: COLOR_PROPS },
];

export function computeComputedStyle(uid: string, doc: Document = document): ComputedStyleResult {
  const win = doc.defaultView;
  const el = findByUid(doc, uid);
  if (!el || !win) return { ok: false, reason: 'not-found' };

  const style = win.getComputedStyle(el);
  const rows: ComputedStyleRow[] = [];
  for (const { group, props } of GROUPED_PROPS) {
    for (const prop of props) {
      const value = style.getPropertyValue(prop);
      if (value !== '') rows.push({ group, prop, value });
    }
  }

  return { ok: true, info: { rows } };
}
