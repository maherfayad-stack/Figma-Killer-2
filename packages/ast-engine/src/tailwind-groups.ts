/**
 * Tailwind conflict-group semantics for `set-classes` (ADR-0018 item 8,
 * playbook §4/P3 pitfall #2 area): "setting `bg-red-500` removes other
 * `bg-*`". We model this as a table mapping a utility class to a GROUP KEY;
 * adding a class whose group key matches an existing class's group key
 * evicts the existing one first.
 *
 * Scope decision (flagged, not silently guessed): groups are FLAT, not a
 * full Tailwind cascade hierarchy. E.g. `p`, `px`, `py`, `pt`, `pr`, `pb`,
 * `pl`, `ps`, `pe` are each their OWN group — setting `px-4` does not evict
 * an existing `p-2` (in real Tailwind/tailwind-merge, `px` and `p` interact
 * because CSS `padding-left`/`padding-right` are a subset of `padding`'s
 * effect; a "which one wins depends on source order" hierarchy is
 * considerably more complex than the playbook's one worked example —
 * "`bg-red-500` removes other `bg-*`" — implies). Every group covered here
 * is golden-tested. Variant prefixes (`hover:`, `md:`, `dark:`, arbitrary
 * stacks like `md:hover:`) are preserved and scope the group independently
 * — `hover:bg-red-500` does not evict a base `bg-blue-500`.
 */

export interface ClassGroupResult {
  /** Stable group id (already includes any variant-prefix scoping), or
   * `null` if this class isn't tracked in the conflict table — untracked
   * classes are still added/removed exactly as requested, just never
   * evict anything else. */
  group: string | null;
}

const KEYWORD_GROUPS: Array<{ group: string; members: readonly string[] }> = [
  {
    group: 'display',
    members: [
      'block',
      'inline-block',
      'inline',
      'flex',
      'inline-flex',
      'table',
      'inline-table',
      'table-caption',
      'table-cell',
      'table-column',
      'table-column-group',
      'table-footer-group',
      'table-header-group',
      'table-row-group',
      'table-row',
      'flow-root',
      'grid',
      'inline-grid',
      'contents',
      'list-item',
      'hidden',
    ],
  },
  { group: 'position', members: ['static', 'fixed', 'absolute', 'relative', 'sticky'] },
  {
    group: 'flex-direction',
    members: ['flex-row', 'flex-row-reverse', 'flex-col', 'flex-col-reverse'],
  },
  { group: 'flex-wrap', members: ['flex-wrap', 'flex-wrap-reverse', 'flex-nowrap'] },
  { group: 'flex', members: ['flex-auto', 'flex-initial', 'flex-none'] },
  {
    group: 'justify-content',
    members: [
      'justify-start',
      'justify-end',
      'justify-center',
      'justify-between',
      'justify-around',
      'justify-evenly',
      'justify-normal',
      'justify-stretch',
    ],
  },
  {
    group: 'align-items',
    members: ['items-start', 'items-end', 'items-center', 'items-baseline', 'items-stretch'],
  },
  {
    group: 'align-content',
    members: [
      'content-start',
      'content-end',
      'content-center',
      'content-between',
      'content-around',
      'content-evenly',
      'content-normal',
    ],
  },
  {
    group: 'text-align',
    members: ['text-left', 'text-center', 'text-right', 'text-justify', 'text-start', 'text-end'],
  },
  { group: 'text-transform', members: ['uppercase', 'lowercase', 'capitalize', 'normal-case'] },
  {
    group: 'text-decoration-line',
    members: ['underline', 'overline', 'line-through', 'no-underline'],
  },
  { group: 'text-overflow', members: ['truncate', 'text-ellipsis', 'text-clip'] },
  {
    group: 'border-style',
    members: [
      'border-solid',
      'border-dashed',
      'border-dotted',
      'border-double',
      'border-hidden',
      'border-none',
    ],
  },
  { group: 'rounded', members: ['rounded-full', 'rounded-none'] },
  { group: 'border-collapse', members: ['border-collapse', 'border-separate'] },
];

const KEYWORD_GROUP_BY_MEMBER = new Map<string, string>();
for (const { group, members } of KEYWORD_GROUPS) {
  for (const member of members) KEYWORD_GROUP_BY_MEMBER.set(member, group);
}

// Ordered [regex, group-template] rules. `group-template` may reference
// regex capture group 1 (e.g. a side like `t`/`r`/`b`/`l`) via `$1`. Tried
// in order — more specific patterns (e.g. `border-t-...` width/color) must
// precede their generic counterparts (`border-...`).
const REGEX_RULES: Array<{ re: RegExp; group: string }> = [
  // NOTE: spacing (p/px/py/.../m/mx/my/...) is handled by `spacingAxisGroup`
  // BEFORE this table is consulted (see `classGroupKey`) — no entry needed
  // here.
  // sizing
  { re: /^w-.+$/, group: 'w' },
  { re: /^h-.+$/, group: 'h' },
  { re: /^min-w-.+$/, group: 'min-w' },
  { re: /^max-w-.+$/, group: 'max-w' },
  { re: /^min-h-.+$/, group: 'min-h' },
  { re: /^max-h-.+$/, group: 'max-h' },
  // gap
  { re: /^gap-x-.+$/, group: 'gap-x' },
  { re: /^gap-y-.+$/, group: 'gap-y' },
  { re: /^gap-.+$/, group: 'gap' },
  // grid
  { re: /^grid-cols-.+$/, group: 'grid-cols' },
  { re: /^grid-rows-.+$/, group: 'grid-rows' },
  { re: /^flex-\d+$/, group: 'flex' },
  // rounded sides (must precede the bare `rounded-...` fallback)
  { re: /^rounded-(tl|tr|bl|br|ss|se|es|ee)-.+$/, group: 'rounded-$1' },
  { re: /^rounded-(t|r|b|l|s|e)-.+$/, group: 'rounded-$1' },
  { re: /^rounded-(tl|tr|bl|br|ss|se|es|ee)$/, group: 'rounded-$1' },
  { re: /^rounded-(t|r|b|l|s|e)$/, group: 'rounded-$1' },
  { re: /^rounded-.+$/, group: 'rounded' },
  { re: /^rounded$/, group: 'rounded' },
  // border width (side-specific, then bare)
  { re: /^border-(t|r|b|l)-\d+$/, group: 'border-$1-width' },
  { re: /^border-(t|r|b|l)$/, group: 'border-$1-width' },
  { re: /^border-\d+$/, group: 'border-width' },
  // border color (side-specific, then bare) — anything left after width is
  // consumed above is a color/opacity value like `border-red-500` or
  // `border-t-red-500`.
  { re: /^border-(t|r|b|l)-.+$/, group: 'border-$1-color' },
  { re: /^border$/, group: 'border-width' },
  { re: /^border-.+$/, group: 'border-color' },
  // background
  {
    re: /^bg-(none|top|bottom|left|right|center|repeat|no-repeat|repeat-x|repeat-y|cover|contain|fixed|local|scroll|auto)$/,
    group: 'bg-$1',
  },
  { re: /^bg-(clip|origin|blend)-.+$/, group: 'bg-$1' },
  { re: /^bg-opacity-.+$/, group: 'bg-opacity' },
  { re: /^bg-gradient-to-.+$/, group: 'bg-gradient-direction' },
  { re: /^bg-.+$/, group: 'bg-color' },
  // text (size / color — align/transform/decoration handled as keywords)
  { re: /^text-(xs|sm|base|lg|[2-9]xl)$/, group: 'text-size' },
  { re: /^text-opacity-.+$/, group: 'text-opacity' },
  { re: /^text-.+$/, group: 'text-color' },
  { re: /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, group: 'font-weight' },
  // inset / offsets
  { re: /^inset-x-.+$/, group: 'inset-x' },
  { re: /^inset-y-.+$/, group: 'inset-y' },
  { re: /^inset-.+$/, group: 'inset' },
  { re: /^top-.+$/, group: 'top' },
  { re: /^right-.+$/, group: 'right' },
  { re: /^bottom-.+$/, group: 'bottom' },
  { re: /^left-.+$/, group: 'left' },
  // overflow
  { re: /^overflow-x-.+$/, group: 'overflow-x' },
  { re: /^overflow-y-.+$/, group: 'overflow-y' },
  { re: /^overflow-.+$/, group: 'overflow' },
  // whitespace / z / opacity(bare) / cursor
  { re: /^whitespace-.+$/, group: 'whitespace' },
  { re: /^z-.+$/, group: 'z' },
  { re: /^opacity-.+$/, group: 'opacity' },
  { re: /^cursor-.+$/, group: 'cursor' },
  { re: /^shadow(-.+)?$/, group: 'shadow' },
];

// Tailwind spacing values: the plain scale (`4`, `2.5`), `px`, keyword
// sizes (`full`, `auto`, `screen`, `min`, `max`, `fit`), fractions (`1/2`),
// and arbitrary bracket values (`[10px]`). Deliberately NOT a bare `.+` —
// `p`/`m` + a single axis letter is a two-character prefix that collides
// with ordinary English words (`my-custom-class`, `ms-modal`); requiring
// the value to look like a real Tailwind spacing token avoids misclassifying
// those as margin/padding utilities.
const SPACING_VALUE_RE = /^(?:\d+(?:\.\d+)?|\d+\/\d+|px|full|auto|screen|min|max|fit|\[[^\]]+\])$/;

// The two placeholder "axis" rules above need real per-prefix group ids
// (p vs px vs py vs pt vs pr vs pb vs pl vs ps vs pe), computed from the
// class string itself rather than a fixed template — expanded here instead
// of a fixed regex substitution.
function spacingAxisGroup(cls: string, base: 'p' | 'm'): string | null {
  const match = new RegExp(`^${base}([xytrbles])?-(.+)$`).exec(cls);
  if (!match) return null;
  const [, axis, value] = match;
  if (value === undefined || !SPACING_VALUE_RE.test(value)) return null;
  return axis ? `${base}${axis}` : base;
}

function stripVariants(cls: string): { variantPrefix: string; base: string } {
  const lastColon = cls.lastIndexOf(':');
  if (lastColon === -1) return { variantPrefix: '', base: cls };
  return { variantPrefix: cls.slice(0, lastColon + 1), base: cls.slice(lastColon + 1) };
}

/**
 * Compute the conflict-group key for a single Tailwind class token
 * (variant-scoped: `hover:bg-red-500` and `bg-red-500` never conflict).
 * Returns `null` for anything not in the table — those classes never evict
 * siblings, they're purely additive/removable by exact string match.
 */
export function classGroupKey(cls: string): string | null {
  const { variantPrefix, base } = stripVariants(cls.trim());
  if (base.length === 0) return null;

  const keywordGroup = KEYWORD_GROUP_BY_MEMBER.get(base);
  if (keywordGroup) return `${variantPrefix}${keywordGroup}`;

  const spacing = spacingAxisGroup(base, 'p') ?? spacingAxisGroup(base, 'm');
  if (spacing) return `${variantPrefix}${spacing}`;

  for (const { re, group } of REGEX_RULES) {
    const match = re.exec(base);
    if (match) {
      const resolved = group.replace(/\$(\d)/g, (_, i: string) => match[Number(i)] ?? '');
      return `${variantPrefix}${resolved}`;
    }
  }

  return null;
}

/**
 * Merge `add`/`remove` into an existing whitespace-separated className
 * value, applying Tailwind conflict-group eviction (ADR-0018 item 8):
 * for each class being added that has a known group, any existing class
 * sharing that group is evicted first. Order: explicit `remove` list
 * first, then `add` (processed left-to-right; within `add`, a later class
 * evicts an earlier one sharing a group). Exact-duplicate classes are not
 * re-appended (keeps original position, no diff noise).
 */
export function mergeClassNames(existing: string, add: readonly string[], remove: readonly string[]): string {
  let classes = existing.split(/\s+/).filter(Boolean);

  const removeSet = new Set(remove);
  classes = classes.filter((cls) => !removeSet.has(cls));

  for (const toAdd of add) {
    // Exact-duplicate short-circuit BEFORE eviction: if `toAdd` is already
    // present verbatim, it is by definition already the sole occupant of
    // its own conflict group (this function never leaves two same-group
    // classes behind), so this is a true no-op — no reordering, no diff.
    if (classes.includes(toAdd)) continue;

    const group = classGroupKey(toAdd);
    if (group) {
      classes = classes.filter((cls) => classGroupKey(cls) !== group);
    }
    classes.push(toAdd);
  }

  return classes.join(' ');
}
