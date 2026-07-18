/**
 * Inspector Tailwind preset tables (FP-INS-a, `.orchestrator/
 * FEATURE-PARITY-PLAN.md`) — pure, dependency-free data + one pure helper
 * function backing every new Inspector.tsx section. Split out of
 * `Inspector.tsx` for exactly one reason: this repo has no
 * `@testing-library/react` dependency, so React-wired panels are only ever
 * verified by real-browser Playwright dogfood (see `use-tool-actions.test.ts`'s
 * module doc for the established precedent) — the PURE parts (which classes
 * a control choice maps to, and the add/remove pair `set-classes` needs) are
 * what this file makes independently unit-testable.
 *
 * ## Why a self-contained remove-candidate list per group (not
 * `@ccs/ast-engine`'s `tailwind-groups.ts` conflict table)
 * `set-classes.add` already gets Tailwind conflict-group eviction for free
 * server-side (`mergeClassNames`/`classGroupKey` — adding `text-lg` evicts an
 * existing `text-sm` automatically). This file does NOT rely on that,
 * deliberately: several controls here (`self-*` align-self, `order-*`,
 * `leading-*`, `tracking-*`) are NOT in that table (untracked classes are
 * only added/removed by exact string match, never evicted), so leaving
 * `remove: []` for those would accumulate stale classes (e.g. selecting
 * `self-center` then `self-end` would leave BOTH on the node). Every group
 * below instead lists every candidate class it could ever emit and computes
 * `remove` as "every candidate except the one being added" — correct for
 * BOTH tracked and untracked groups, with zero dependency on `@ccs/ast-engine`
 * internals (this package doesn't import it; `apps/studio` never has).
 *
 * ## RTL choice (playbook §5.9/ADR-0022 logical-props-first)
 * Horizontal spacing/position uses Tailwind's LOGICAL utilities exclusively:
 * `ps-*`/`pe-*` (padding-inline-start/end) instead of `pl-*`/`pr-*`,
 * `start-[Npx]`/`end-[Npx]` (inset-inline-start/end) instead of
 * `left-[Npx]`/`right-[Npx]`, `text-start`/`text-end` instead of
 * `text-left`/`text-right` — exactly mirroring the convention
 * `packages/bridge/src/free-drop.ts` already established for FP-4b's
 * free-drag commit. Vertical spacing (`pt-*`/`pb-*`, `top-[Npx]`) stays
 * PHYSICAL on purpose: the block axis never flips under `dir="rtl"`, only
 * the inline/horizontal one does (same reasoning `free-drop.ts`'s module doc
 * gives for why `top` has no logical counterpart). Flex/grid `justify-*`/
 * `items-*`/`self-*` need no special-casing at all — CSS's `flex-start`/
 * `flex-end` (which is what those utilities compile to) are ALREADY
 * writing-mode-relative, not physical left/right.
 */

export interface ClassPreset {
  value: string;
  label: string;
  /** Classes this preset ADDS. Usually one; `direction`'s row/col presets
   * also assert `flex` itself (the `display` utility) since a bare
   * `flex-row`/`flex-col` has no visual effect without it. */
  add: string[];
}

export interface ClassPresetGroup {
  /** Stable key — used as the session-local hint-cache key
   * (`inspector-class-hints.ts`), not sent over the wire. */
  key: string;
  presets: ClassPreset[];
}

export interface ClassEdit {
  add: string[];
  remove: string[];
}

/** The `set-classes` add/remove pair for choosing `nextValue` out of
 * `group` — see the module doc for why `remove` is every OTHER candidate
 * class in the group, not a `tailwind-groups.ts` lookup. */
export function resolveClassEdit(group: ClassPresetGroup, nextValue: string): ClassEdit {
  const chosen = group.presets.find((p) => p.value === nextValue);
  const add = chosen?.add ?? [];
  const allCandidates = group.presets.flatMap((p) => p.add);
  const remove = allCandidates.filter((cls) => !add.includes(cls));
  return { add, remove };
}

function scale(prefix: string, values: readonly (string | number)[]): ClassPreset[] {
  return values.map((v) => ({ value: String(v), label: String(v), add: [`${prefix}-${v}`] }));
}

// --- Size & position (measures.cljs: width/height/x/y; rotation dropped —
// vector-only, out of this task's scope) --------------------------------

export const WIDTH_GROUP: ClassPresetGroup = {
  key: 'size-w',
  presets: [
    { value: 'auto', label: 'Auto', add: ['w-auto'] },
    { value: 'full', label: 'Full (100%)', add: ['w-full'] },
    { value: 'screen', label: 'Screen', add: ['w-screen'] },
    { value: 'fit', label: 'Fit content', add: ['w-fit'] },
    { value: 'min', label: 'Min content', add: ['w-min'] },
    { value: 'max', label: 'Max content', add: ['w-max'] },
  ],
};

export const HEIGHT_GROUP: ClassPresetGroup = {
  key: 'size-h',
  presets: [
    { value: 'auto', label: 'Auto', add: ['h-auto'] },
    { value: 'full', label: 'Full (100%)', add: ['h-full'] },
    { value: 'screen', label: 'Screen', add: ['h-screen'] },
    { value: 'fit', label: 'Fit content', add: ['h-fit'] },
    { value: 'min', label: 'Min content', add: ['h-min'] },
    { value: 'max', label: 'Max content', add: ['h-max'] },
  ],
};

/** Custom pixel width/height — an open-ended arbitrary-value control, not a
 * fixed enum, so it's a function rather than a `ClassPresetGroup` entry.
 * `previousArbitrary` (the hint-cache's last-written arbitrary class for
 * this uid, if any) is included in `remove` alongside every named preset so
 * re-entering a custom value doesn't accumulate a stale `w-[240px]` next to
 * a new `w-[300px]`. */
export function arbitrarySizeEdit(
  axis: 'w' | 'h',
  px: number,
  previousArbitrary: string | null,
): ClassEdit {
  const group = axis === 'w' ? WIDTH_GROUP : HEIGHT_GROUP;
  const cls = `${axis}-[${Math.round(px)}px]`;
  const namedCandidates = group.presets.flatMap((p) => p.add);
  const remove = [...namedCandidates, ...(previousArbitrary ? [previousArbitrary] : [])].filter(
    (c) => c !== cls,
  );
  return { add: [cls], remove };
}

/** Position toggle (adapts Penpot's `layout_item.cljs` `:layout-item-absolute`
 * static/absolute radio, consolidated here alongside width/height/x/y since
 * for a DOM-first tool "become absolutely positioned" and "has an x/y" are
 * the same concept — see this task's report for why that consolidation was
 * made instead of duplicating a second toggle in the Layout-item section). */
export const POSITION_GROUP: ClassPresetGroup = {
  key: 'position',
  presets: [
    { value: 'static', label: 'In flow', add: [] },
    { value: 'absolute', label: 'Absolute', add: ['absolute'] },
  ],
};
// `remove` must also cover `relative`/`fixed`/`sticky` even though no preset
// here ever ADDS them — a node could already be `relative` (e.g. FP-4b wrote
// it as a free-drop drag-parent) and toggling this control to "In flow"
// should still be able to clear an errant `absolute`. `resolveClassEdit`
// only removes candidates that appear in SOME preset's `add`, so those three
// are added as a zero-effect preset-less candidate list via this export.
export const POSITION_REMOVE_EXTRA = ['relative', 'fixed', 'sticky'] as const;

export function arbitraryInsetEdit(
  axis: 'start' | 'top',
  px: number,
  previousArbitrary: string | null,
): ClassEdit {
  const cls = `${axis}-[${Math.round(px)}px]`;
  const remove = previousArbitrary && previousArbitrary !== cls ? [previousArbitrary] : [];
  return { add: [cls], remove };
}

/** FIX-W4b-3a — extracts the bracketed number out of an arbitrary-value
 * class this file itself wrote (`w-[240px]` -> `240`, `rotate-[45deg]` ->
 * `45`) so a numeric `<input>` can be re-seeded with the SESSION HINT's own
 * last-written value (same "own last write wins" precedence
 * `inspector-class-hints.ts`'s module doc already establishes for every
 * other control) rather than starting blank on every remount. Returns `null`
 * for a class this pattern doesn't match (e.g. a stale non-arbitrary preset
 * class somehow left in the hint cache). */
const ARBITRARY_VALUE_RE = /\[(-?\d+(?:\.\d+)?)(?:px|deg)\]/;
export function parseArbitraryValue(cls: string): number | null {
  const match = ARBITRARY_VALUE_RE.exec(cls);
  return match ? Number(match[1]) : null;
}

/** FIX-W4b-3a item 2 — rotation, newly added (FIX-W4's module doc dropped it
 * as "no vector rotation on a DOM element in this tool"; re-reading the human
 * ask, a DOM element's `transform: rotate()` is a real, settable CSS
 * property, so this reverses that drop). `measures.cljs`'s rotation field is
 * a free numeric degrees input — mirrored here as an arbitrary
 * `rotate-[Ndeg]` class, same shape as `arbitraryInsetEdit`. */
export function arbitraryRotateEdit(deg: number, previousArbitrary: string | null): ClassEdit {
  const cls = `rotate-[${Math.round(deg)}deg]`;
  const remove = previousArbitrary && previousArbitrary !== cls ? [previousArbitrary] : [];
  return { add: [cls], remove };
}

/** FIX-W4b-3a item 2 — corner radius, reworked from `RADIUS_GROUP`'s preset-
 * only `<Select>` to a direct numeric field: real Penpot's `border_radius.
 * cljs` is a free numeric px input (plus a 4-corner toggle this pass defers,
 * see the worker report's carry-forward section), not a fixed enum. Kept
 * alongside (not replacing) `RADIUS_GROUP` so its preset `add` classes still
 * populate this edit's `remove` list — re-entering a numeric radius must
 * still evict a previously-chosen NAMED preset (`rounded-lg`, etc.), exactly
 * how `arbitrarySizeEdit` already treats `WIDTH_GROUP`/`HEIGHT_GROUP`. */
export function arbitraryRadiusEdit(px: number, previousArbitrary: string | null): ClassEdit {
  const cls = `rounded-[${Math.round(px)}px]`;
  const namedCandidates = RADIUS_GROUP.presets.flatMap((p) => p.add);
  const remove = [...namedCandidates, ...(previousArbitrary ? [previousArbitrary] : [])].filter(
    (c) => c !== cls,
  );
  return { add: [cls], remove };
}

// --- Layout container (layout_container.cljs: direction, wrap, justify,
// align, gap, padding) ----------------------------------------------------

export const DIRECTION_GROUP: ClassPresetGroup = {
  key: 'direction',
  presets: [
    { value: 'row', label: 'Row', add: ['flex', 'flex-row'] },
    { value: 'col', label: 'Column', add: ['flex', 'flex-col'] },
    { value: 'row-reverse', label: 'Row reverse', add: ['flex', 'flex-row-reverse'] },
    { value: 'col-reverse', label: 'Column reverse', add: ['flex', 'flex-col-reverse'] },
  ],
};

export const WRAP_GROUP: ClassPresetGroup = {
  key: 'wrap',
  presets: [
    { value: 'nowrap', label: 'No wrap', add: ['flex-nowrap'] },
    { value: 'wrap', label: 'Wrap', add: ['flex-wrap'] },
    { value: 'wrap-reverse', label: 'Wrap reverse', add: ['flex-wrap-reverse'] },
  ],
};

export const JUSTIFY_GROUP: ClassPresetGroup = {
  key: 'justify',
  presets: [
    { value: 'start', label: 'Start', add: ['justify-start'] },
    { value: 'center', label: 'Center', add: ['justify-center'] },
    { value: 'end', label: 'End', add: ['justify-end'] },
    { value: 'between', label: 'Space between', add: ['justify-between'] },
    { value: 'around', label: 'Space around', add: ['justify-around'] },
    { value: 'evenly', label: 'Space evenly', add: ['justify-evenly'] },
  ],
};

export const ALIGN_ITEMS_GROUP: ClassPresetGroup = {
  key: 'align-items',
  presets: [
    { value: 'start', label: 'Start', add: ['items-start'] },
    { value: 'center', label: 'Center', add: ['items-center'] },
    { value: 'end', label: 'End', add: ['items-end'] },
    { value: 'baseline', label: 'Baseline', add: ['items-baseline'] },
    { value: 'stretch', label: 'Stretch', add: ['items-stretch'] },
  ],
};

const SPACING_SCALE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24] as const;

export const GAP_GROUP: ClassPresetGroup = { key: 'gap', presets: scale('gap', SPACING_SCALE) };
export const PADDING_GROUP: ClassPresetGroup = { key: 'padding', presets: scale('p', SPACING_SCALE) };
export const PADDING_START_GROUP: ClassPresetGroup = {
  key: 'padding-start',
  presets: scale('ps', SPACING_SCALE),
};
export const PADDING_END_GROUP: ClassPresetGroup = { key: 'padding-end', presets: scale('pe', SPACING_SCALE) };
export const PADDING_TOP_GROUP: ClassPresetGroup = { key: 'padding-top', presets: scale('pt', SPACING_SCALE) };
export const PADDING_BOTTOM_GROUP: ClassPresetGroup = {
  key: 'padding-bottom',
  presets: scale('pb', SPACING_SCALE),
};

/** `layout_container.cljs`'s `align-content-row`/`align-content-row` —
 * Tailwind's `content-*` utilities (cross-axis alignment of wrapped flex
 * lines). Real Penpot only shows this row when the container is wrapping
 * (`(= :wrap wrap-type)`) — `LayoutContainerSection` reproduces that gate. */
export const ALIGN_CONTENT_GROUP: ClassPresetGroup = {
  key: 'align-content',
  presets: [
    { value: 'start', label: 'Start', add: ['content-start'] },
    { value: 'center', label: 'Center', add: ['content-center'] },
    { value: 'end', label: 'End', add: ['content-end'] },
    { value: 'between', label: 'Space between', add: ['content-between'] },
    { value: 'around', label: 'Space around', add: ['content-around'] },
    { value: 'evenly', label: 'Space evenly', add: ['content-evenly'] },
  ],
};

/** FIX-W4b-3b — Gap as a direct numeric field (Penpot's own free-numeric
 * `gap-section*`), mirroring `arbitrarySizeEdit`'s pattern: `GAP_GROUP`'s
 * named scale presets still exist, purely as this edit's remove-candidate
 * list (so entering a number still evicts a stale `gap-4`, etc). Penpot
 * itself splits this into TWO fields (row-gap/column-gap, each its own CSS
 * property) — this tool keeps ONE combined field writing Tailwind's plain
 * `gap-*` (which sets both axes at once), per this workstream's brief; a
 * split row/column-gap pair would need `gap-x-*`/`gap-y-*` and is a
 * disclosed carry-forward, not built this pass. */
export function arbitraryGapEdit(px: number, previousArbitrary: string | null): ClassEdit {
  const cls = `gap-[${clampNonNegativePx(px)}px]`;
  const namedCandidates = GAP_GROUP.presets.flatMap((p) => p.add);
  const remove = [...namedCandidates, ...(previousArbitrary ? [previousArbitrary] : [])].filter(
    (c) => c !== cls,
  );
  return { add: [cls], remove };
}

/** FIX-W4b-3b remediation — Penpot's own gap/padding numeric fields are
 * `:min 0` (`gap-section*`/`padding-section*`, re-read for this fix): a
 * negative value is not a smaller gap/padding, it's invalid CSS-adjacent
 * nonsense (`gap-[-50px]` compiles but never matches Penpot's own clamped
 * behavior). Rounds AND floors at 0; non-finite input (a stray `NaN` from a
 * blank/garbage numeric field slipping past its caller's own `Number.
 * isFinite` guard) collapses to `0` rather than emitting `gap-[NaNpx]`. */
function clampNonNegativePx(px: number): number {
  if (!Number.isFinite(px)) return 0;
  return Math.max(0, Math.round(px));
}

/** FIX-W4b-3b — Padding as direct numeric fields (Penpot's own free-numeric
 * `padding-section*`), reworked from the old 3-tier all/start-end/top-bottom
 * `<Select>` stack to match Penpot's REAL 2-mode model exactly: a "simple"
 * (linked) mode with 2 fields — vertical (top+bottom, always equal) and
 * horizontal (start+end, always equal) — and a "multiple" (per-side) mode
 * with 4 independent fields, toggled by one button
 * (`layout_container.cljs`'s `padding-toggle`/`i/padding-extended`).
 *
 * `PaddingSide` covers all 4 physical/logical directions this tool ever
 * writes. Horizontal uses the LOGICAL `ps-*`/`pe-*` prefixes (not Penpot's
 * own physical left/right numbering, `p2`/`p4`) — this file's own module doc
 * already establishes `ps-*`/`pe-*` as the ONLY horizontal-spacing prefix
 * this codebase writes (RTL-first, ADR-0022); vertical stays PHYSICAL
 * (`pt-*`/`pb-*`), same as every other control here. */
export type PaddingSide = 'top' | 'bottom' | 'start' | 'end';

const PADDING_SIDE_PREFIX: Record<PaddingSide, string> = {
  top: 'pt',
  bottom: 'pb',
  start: 'ps',
  end: 'pe',
};

/** Every named padding preset this file has EVER offered (including the
 * dropped "all sides" `PADDING_GROUP` — kept only as a remove-candidate
 * source now, no longer surfaced as its own control, see
 * `LayoutContainerSection`'s doc) — the full remove-candidate baseline for
 * every padding write below, since `p-*`/`ps-*`/`pe-*`/`pt-*`/`pb-*` are all
 * untracked by `@ccs/ast-engine`'s conflict-group table (this file's own
 * module doc). */
const PADDING_NAMED_CANDIDATES = [
  PADDING_GROUP,
  PADDING_START_GROUP,
  PADDING_END_GROUP,
  PADDING_TOP_GROUP,
  PADDING_BOTTOM_GROUP,
].flatMap((g) => g.presets.flatMap((p) => p.add));

/** One independent side ("multiple"/per-side mode). `previousArbitraries`
 * must include every OTHER padding hint this section currently has cached
 * for THIS side (its own prior value, plus — since switching from "simple"
 * mode can leave a linked class on this same side — the linked edit's own
 * prior class) so toggling Penpot's simple/multiple mode never leaves two
 * classes stacked on the same box side. */
export function arbitraryPaddingSideEdit(
  side: PaddingSide,
  px: number,
  previousArbitraries: readonly (string | null)[],
): ClassEdit {
  const cls = `${PADDING_SIDE_PREFIX[side]}-[${Math.round(px)}px]`;
  const remove = [
    ...PADDING_NAMED_CANDIDATES,
    ...previousArbitraries.filter((c): c is string => !!c),
  ].filter((c) => c !== cls);
  return { add: [cls], remove };
}

/** Linked axis ("simple" mode) — mirrors `layout_container.cljs`'s own
 * `simple-padding-selection*`, which fires its `on-p1-change`/`on-p2-change`
 * against BOTH sides of that axis (`#{:p1 :p3}`/`#{:p2 :p4}`) in one write,
 * not a single shorthand class — reproduced here as TWO arbitrary classes
 * added together (`pt-[Npx]` + `pb-[Npx]`, or `ps-[Npx]` + `pe-[Npx]`)
 * rather than Tailwind's `py-*`/`px-*` shorthand, so the logical `ps-*`/
 * `pe-*` convention holds for the horizontal case even in linked mode (a
 * bare `px-[Npx]` would be physical — see `PaddingSide`'s own doc). */
export function arbitraryPaddingLinkedEdit(
  axis: 'vertical' | 'horizontal',
  px: number,
  previousArbitraries: readonly (string | null)[],
): ClassEdit {
  const sides: PaddingSide[] = axis === 'vertical' ? ['top', 'bottom'] : ['start', 'end'];
  const add = sides.map((s) => `${PADDING_SIDE_PREFIX[s]}-[${Math.round(px)}px]`);
  const remove = [
    ...PADDING_NAMED_CANDIDATES,
    ...previousArbitraries.filter((c): c is string => !!c),
  ].filter((c) => !add.includes(c));
  return { add, remove };
}

// --- Layout item (layout_item.cljs: grow, align-self, order) ------------

export const GROW_GROUP: ClassPresetGroup = {
  key: 'grow',
  presets: [
    { value: 'none', label: 'Fixed', add: ['flex-none'] },
    { value: 'auto', label: 'Auto', add: ['flex-auto'] },
    { value: 'initial', label: 'Initial', add: ['flex-initial'] },
    { value: 'fill', label: 'Fill (grow)', add: ['flex-1'] },
  ],
};

export const SELF_ALIGN_GROUP: ClassPresetGroup = {
  key: 'self-align',
  presets: [
    { value: 'auto', label: 'Auto', add: ['self-auto'] },
    { value: 'start', label: 'Start', add: ['self-start'] },
    { value: 'center', label: 'Center', add: ['self-center'] },
    { value: 'end', label: 'End', add: ['self-end'] },
    { value: 'stretch', label: 'Stretch', add: ['self-stretch'] },
    { value: 'baseline', label: 'Baseline', add: ['self-baseline'] },
  ],
};

export const ORDER_GROUP: ClassPresetGroup = {
  key: 'order',
  presets: [
    { value: 'first', label: 'First', add: ['order-first'] },
    { value: 'none', label: 'Source order', add: ['order-none'] },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n), add: [`order-${n}`] })),
    { value: 'last', label: 'Last', add: ['order-last'] },
  ],
};

// --- Typography (typography.cljs + the text menu: size, weight, line
// height, letter spacing, align; color reuses the shared color palette) --

export const TEXT_SIZE_GROUP: ClassPresetGroup = {
  key: 'text-size',
  presets: [
    'xs',
    'sm',
    'base',
    'lg',
    'xl',
    '2xl',
    '3xl',
    '4xl',
    '5xl',
    '6xl',
  ].map((v) => ({ value: v, label: v, add: [`text-${v}`] })),
};

export const FONT_WEIGHT_GROUP: ClassPresetGroup = {
  key: 'font-weight',
  presets: [
    'thin',
    'extralight',
    'light',
    'normal',
    'medium',
    'semibold',
    'bold',
    'extrabold',
    'black',
  ].map((v) => ({ value: v, label: v, add: [`font-${v}`] })),
};

export const LEADING_GROUP: ClassPresetGroup = {
  key: 'leading',
  presets: ['none', 'tight', 'snug', 'normal', 'relaxed', 'loose'].map((v) => ({
    value: v,
    label: v,
    add: [`leading-${v}`],
  })),
};

export const TRACKING_GROUP: ClassPresetGroup = {
  key: 'tracking',
  presets: ['tighter', 'tight', 'normal', 'wide', 'wider', 'widest'].map((v) => ({
    value: v,
    label: v,
    add: [`tracking-${v}`],
  })),
};

/** Logical text-align (`text-start`/`text-end`, not `text-left`/`text-right`
 * — RTL choice, see module doc). */
export const TEXT_ALIGN_GROUP: ClassPresetGroup = {
  key: 'text-align',
  presets: [
    { value: 'start', label: 'Start', add: ['text-start'] },
    { value: 'center', label: 'Center', add: ['text-center'] },
    { value: 'end', label: 'End', add: ['text-end'] },
    { value: 'justify', label: 'Justify', add: ['text-justify'] },
  ],
};

// --- Shared color palette (Fill's background, Typography's text color,
// Border's border color) --------------------------------------------------

const COLOR_NAMES = [
  'slate',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'pink',
  'rose',
] as const;

export function colorGroup(prefix: 'bg' | 'text' | 'border'): ClassPresetGroup {
  return {
    key: `${prefix}-color`,
    presets: [
      { value: 'none', label: 'None', add: [`${prefix}-transparent`] },
      { value: 'white', label: 'White', add: [`${prefix}-white`] },
      { value: 'black', label: 'Black', add: [`${prefix}-black`] },
      ...COLOR_NAMES.map((name) => ({
        value: `${name}-500`,
        label: name,
        add: [`${prefix}-${name}-500`],
      })),
    ],
  };
}

/** FIX-W4b-2 — Penpot's `fill.cljs`/`stroke.cljs`/typography color rows all
 * pair a `color_bullet` swatch chip + the hex value next to the picker
 * (never a bare dropdown). This tool has no live color-picker (a
 * Tailwind-class-preset `<Select>` stands in for it, an already-disclosed
 * FIX-W4/FP-INS-a adaptation — see this module's own doc), but the swatch +
 * hex ROW ANATOMY is still reproducible: Tailwind's default palette is a
 * fixed, known set of hex values, so every `colorGroup()` preset value maps
 * to a real, correct swatch color, not a guess. Shade `-500` matches what
 * `colorGroup` always emits. */
const TAILWIND_500_HEX: Record<(typeof COLOR_NAMES)[number], string> = {
  slate: '#64748b',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  sky: '#0ea5e9',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  pink: '#ec4899',
  rose: '#f43f5e',
};

/** Resolves a `colorGroup()` preset `value` ('none' | 'white' | 'black' |
 * `${name}-500`) to a real CSS color for a swatch chip, or `undefined` for
 * 'none' (rendered as an empty/checkerboard chip by the caller). */
export function hexForColorValue(value: string): string | undefined {
  if (value === 'none') return undefined;
  if (value === 'white') return '#ffffff';
  if (value === 'black') return '#000000';
  const name = value.replace(/-500$/, '') as (typeof COLOR_NAMES)[number];
  return TAILWIND_500_HEX[name];
}

// --- Border & radius (border_radius.cljs + border) -----------------------

export const RADIUS_GROUP: ClassPresetGroup = {
  key: 'radius',
  presets: [
    { value: 'none', label: 'None', add: ['rounded-none'] },
    { value: 'sm', label: 'SM', add: ['rounded-sm'] },
    { value: 'default', label: 'Default', add: ['rounded'] },
    { value: 'md', label: 'MD', add: ['rounded-md'] },
    { value: 'lg', label: 'LG', add: ['rounded-lg'] },
    { value: 'xl', label: 'XL', add: ['rounded-xl'] },
    { value: '2xl', label: '2XL', add: ['rounded-2xl'] },
    { value: '3xl', label: '3XL', add: ['rounded-3xl'] },
    { value: 'full', label: 'Full', add: ['rounded-full'] },
  ],
};

export const BORDER_WIDTH_GROUP: ClassPresetGroup = {
  key: 'border-width',
  presets: [
    { value: '0', label: 'None', add: ['border-0'] },
    { value: '1', label: '1px', add: ['border'] },
    { value: '2', label: '2px', add: ['border-2'] },
    { value: '4', label: '4px', add: ['border-4'] },
    { value: '8', label: '8px', add: ['border-8'] },
  ],
};

// --- Board size presets (FIX-W4b-3a item 3, frames/boards only) -----------
//
// Cited verbatim (name + width + height) against real Penpot's own board
// size-preset catalog, `app.main.constants/size-presets` (`../penpot/
// frontend/src/app/main/constants.cljs`) — the exact list `measures.cljs`'s
// "Size presets" dropdown searches/renders (`filter-size-presets`,
// `on-preset-selected` -> `update-dimensions` on BOTH width and height at
// once, same as selecting one of these does here). This is a CURATED SUBSET
// of Penpot's full ~60-entry catalog (which also spans PRINT/SOCIAL MEDIA
// sizes, out of this task's "device" scope) — kept to the same vendor
// categories Penpot itself groups by (APPLE/ANDROID/WEB/MIXED), one or two
// representative entries each.
//
// No device-type ICONS: Penpot's own preset list renders `:preset-name`/
// `:preset-size` text spans only (`measures.cljs`'s `on-preset-selected`
// `:li` markup, re-read for this task) — there is no phone/tablet/desktop
// GLYPH anywhere in real Penpot to vend, so `DEVICE_QUICK_PRESETS` below
// render as plain labeled buttons, the same "no icon beats a wrong one"
// honesty policy `Inspector.tsx`'s icon-lookup functions already document.
export interface DevicePreset {
  value: string;
  label: string;
  w: number;
  h: number;
  category: 'phone' | 'tablet' | 'desktop';
}

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  // APPLE
  { value: 'iphone-16', label: 'iPhone 16', w: 393, h: 852, category: 'phone' },
  { value: 'iphone-13-14', label: 'iPhone 13/14', w: 390, h: 844, category: 'phone' },
  { value: 'iphone-se', label: 'iPhone SE', w: 320, h: 568, category: 'phone' },
  { value: 'ipad', label: 'iPad', w: 768, h: 1024, category: 'tablet' },
  { value: 'ipad-pro-11', label: 'iPad Pro 11in', w: 834, h: 1194, category: 'tablet' },
  { value: 'macbook-pro-14', label: 'MacBook Pro 14in', w: 1512, h: 982, category: 'desktop' },
  // ANDROID
  { value: 'android-mobile', label: 'Android Mobile', w: 360, h: 640, category: 'phone' },
  { value: 'pixel-7-pro', label: 'Google Pixel 7 Pro', w: 412, h: 892, category: 'phone' },
  { value: 'android-tablet', label: 'Android Tablet', w: 768, h: 1024, category: 'tablet' },
  // WEB / MIXED
  { value: 'web-1280', label: 'Web 1280', w: 1280, h: 800, category: 'desktop' },
  { value: 'web-1920', label: 'Web 1920', w: 1920, h: 1080, category: 'desktop' },
  { value: 'desktop-wireframe', label: 'Desktop/Wireframe', w: 1440, h: 1024, category: 'desktop' },
];

/** One representative preset per device-TYPE quick-select button — the
 * closest thing this tool has to Penpot's own phone/tablet/desktop grouping,
 * without fabricating icons for a distinction Penpot itself doesn't
 * illustrate (see this section's own module doc). Looked up by `value`
 * (not array index) so reordering `DEVICE_PRESETS` above can never silently
 * point this at the wrong entry. */
export const DEVICE_QUICK_PRESETS: readonly DevicePreset[] = (
  ['iphone-13-14', 'ipad', 'desktop-wireframe'] as const
).map((value) => {
  const preset = DEVICE_PRESETS.find((p) => p.value === value);
  if (!preset) throw new Error(`@ccs/studio: DEVICE_PRESETS is missing quick-preset "${value}"`);
  return preset;
});

// --- Shadow (shadow.cljs: nearest Tailwind preset, not arbitrary vector) --

export const SHADOW_GROUP: ClassPresetGroup = {
  key: 'shadow',
  presets: [
    { value: 'none', label: 'None', add: ['shadow-none'] },
    { value: 'sm', label: 'SM', add: ['shadow-sm'] },
    { value: 'default', label: 'Default', add: ['shadow'] },
    { value: 'md', label: 'MD', add: ['shadow-md'] },
    { value: 'lg', label: 'LG', add: ['shadow-lg'] },
    { value: 'xl', label: 'XL', add: ['shadow-xl'] },
    { value: '2xl', label: '2XL', add: ['shadow-2xl'] },
    { value: 'inner', label: 'Inner', add: ['shadow-inner'] },
  ],
};

// --- Opacity ---------------------------------------------------------------

export const OPACITY_GROUP: ClassPresetGroup = {
  key: 'opacity',
  presets: [0, 25, 50, 75, 100].map((v) => ({ value: String(v), label: `${v}%`, add: [`opacity-${v}`] })),
};
