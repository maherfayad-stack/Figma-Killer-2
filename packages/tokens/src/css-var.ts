import { kebabCase } from './kebab.js';
import type { TokenGroup } from './types.js';

/**
 * AUDIT-7 blocker close-out (CSS injection via unvalidated token-CRUD
 * `key`) — defense-in-depth sink-side sanitizer. `packages/sync-daemon/
 * src/token-crud.ts`'s `validateTokenKey` is the authoritative gate that
 * rejects an unsafe key before it's ever written to `tokens.js`, but this
 * module is also a standalone part of the FROZEN `@ccs/tokens` engine API
 * (ADR-0022) — it must not assume every caller/every key on disk went
 * through that gate (e.g. a token written before this fix existed, or a
 * future caller of this package that isn't the daemon). `kebabCase` only
 * inserts hyphens and lowercases; it does not remove characters, so a key
 * containing `;`, `{`, whitespace, etc. would otherwise pass straight
 * through into a `--`-prefixed custom-property name. Stripping anything
 * outside the CSS-custom-property-safe charset here is a no-op for every
 * legitimate key (which only ever contains letters/digits/`-`/`_` to begin
 * with) and closes the hole for anything that isn't.
 */
function sanitizeIdentSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, '');
}

const GROUP_PREFIX: Record<TokenGroup, string> = {
  color: 'color',
  spacing: 'space',
  rounded: 'rounded',
  elevation: 'elevation',
  typography: 'type',
};

/** Groups where the literal source key `"base"` maps to the BARE group
 * variable (`--space`, `--rounded`) instead of `--space-base` /
 * `--rounded-base` — matches the hand-written `design-system/src/tokens/
 * {spacing,rounded}.css` convention (`base: 16` -> `--space`, `base:
 * '12px'` -> `--rounded`). */
const BARE_BASE_GROUPS = new Set<TokenGroup>(['spacing', 'rounded']);

/** CSS custom-property name for a flat (non-nested) token group
 * (color/spacing/rounded/elevation). */
export function cssVarForFlatToken(group: Exclude<TokenGroup, 'typography'>, key: string): string {
  const prefix = GROUP_PREFIX[group];
  if (BARE_BASE_GROUPS.has(group) && key === 'base') return `--${prefix}`;
  return `--${prefix}-${sanitizeIdentSegment(kebabCase(key))}`;
}

const TYPOGRAPHY_FIELD_SUFFIX: Record<string, string> = {
  fontFamily: 'family',
  fontSize: 'size',
  fontWeight: 'weight',
  lineHeight: 'lh',
  letterSpacing: 'ls',
};

/** CSS custom-property name for a `typography.<scale>.<field>` token,
 * matching `design-system/src/tokens/typography.css`'s `--type-{scale}-
 * {family|size|weight|lh|ls}` convention. */
export function cssVarForTypographyField(scale: string, field: string): string {
  const suffix = sanitizeIdentSegment(TYPOGRAPHY_FIELD_SUFFIX[field] ?? kebabCase(field));
  return `--type-${sanitizeIdentSegment(kebabCase(scale))}-${suffix}`;
}
