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
