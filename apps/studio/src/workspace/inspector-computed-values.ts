import type { ComputedStyleRow } from '@ccs/canvas';
import type { ClassPresetGroup } from './inspector-presets.js';

/**
 * FIX-W4b-1 Part B — turns a `report-computed-style` reply (the EXISTING
 * FP-INS-b bridge round-trip; see `packages/bridge/src/computed-style.ts`
 * and `use-computed-style.ts`'s own doc for the plumbing) into per-control
 * "what does this element ACTUALLY have right now" readouts, closing the gap
 * `inspector-class-hints.ts`'s module doc disclosed: every control used to
 * show only a neutral default or a same-session hint, never the node's real
 * pre-existing value.
 *
 * ## The honesty rule this file exists to satisfy
 * A control must show the element's REAL current value or an honest
 * "not set" / "loading" state — NEVER a fabricated token. Concretely:
 *  - `resolveCurrentValue` ALWAYS returns the literal computed CSS value
 *    (`raw`) when the bridge has one — that part is never a guess.
 *  - It ALSO returns a matching `ClassPresetGroup` preset's `label` — but
 *    ONLY when `raw` (or one of the `KEYWORD_ALIASES` below) is EXACTLY
 *    equal to that preset's own `value`. Every alias in `KEYWORD_ALIASES` is
 *    a hard, deterministic CSS-keyword equivalence (e.g. Tailwind's
 *    `flex-col` utility compiles to LITERALLY `flex-direction: column` — so
 *    reading `column` back as `col` is not an inference, it is what the
 *    utility IS). Nothing here ever reverse-maps a NUMERIC scale (e.g. a
 *    `36px` font-size back to `text-4xl`) — Tailwind's font-size/spacing
 *    scales are themeable per-project, so a px->token guess could easily be
 *    WRONG for a customized theme. Callers that want a size/color readout get
 *    the raw computed string only, exactly per this task's own fallback
 *    instruction ("if reverse-mapping is unreliable, show the raw computed
 *    value").
 */

export type ComputedLookup = ReadonlyMap<string, string>;

/** `null` input (no reply yet / bridge not connected) -> `null` output
 * ("loading", per `resolveCurrentValue`'s own doc) — never an empty Map,
 * which would be indistinguishable from "fetched successfully, every
 * curated prop happened to be empty". */
export function buildComputedLookup(rows: ComputedStyleRow[] | null): ComputedLookup | null {
  if (!rows) return null;
  return new Map(rows.map((row) => [row.prop, row.value] as const));
}

/** One-directional, exact CSS-keyword -> Tailwind-group-value aliases — see
 * this file's module doc for why each entry here is a hard equivalence, not
 * a guess. Only covers keyword-valued properties (flex-direction/-wrap,
 * justify-content, align-items) — never a numeric scale. */
const KEYWORD_ALIASES: Readonly<Record<string, string>> = {
  column: 'col',
  'column-reverse': 'col-reverse',
  'flex-start': 'start',
  'flex-end': 'end',
  'space-between': 'between',
  'space-around': 'around',
  'space-evenly': 'evenly',
};

export type CurrentValue = { raw: string; label: string | null } | 'loading' | 'unset';

/**
 * Resolves the CURRENT, real value for `prop` out of a `report-computed-
 * style` reply, optionally relabeled against `group`'s own preset labels
 * (see module doc for the exact-match-only rule).
 *  - `lookup === null` (bridge hasn't answered / isn't connected yet) ->
 *    `'loading'`.
 *  - Bridge answered but this exact CSS property carries no value for this
 *    node -> `'unset'` (honestly "not set", never fabricated).
 *  - Otherwise -> `{ raw, label }`.
 */
export function resolveCurrentValue(
  lookup: ComputedLookup | null,
  prop: string,
  group?: ClassPresetGroup,
): CurrentValue {
  if (lookup === null) return 'loading';
  const raw = lookup.get(prop);
  if (raw === undefined || raw === '') return 'unset';
  if (!group) return { raw, label: null };
  const aliased = KEYWORD_ALIASES[raw] ?? raw;
  const match = group.presets.find((p) => p.value === raw || p.value === aliased);
  return { raw, label: match?.label ?? null };
}

/** Renders a `CurrentValue` as the short line every control shows under it
 * (`Inspector.tsx`'s `CurrentValueLine`) — split out as a pure function so
 * the display text itself is unit-testable without React. */
export function formatCurrentValue(value: CurrentValue): string {
  if (value === 'loading') return 'Current: loading…';
  if (value === 'unset') return 'Current: not set';
  return value.label ? `Current: ${value.label} (${value.raw})` : `Current: ${value.raw}`;
}
