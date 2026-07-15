/**
 * Core TokenModel types (playbook §4/P4, ADR-0010, ADR-0022).
 *
 * ADR-0010: the Almosafer DS token FORMAT (CSS custom properties + a JS
 * mirror, `design-system/src/tokens/tokens.js`) is the PRIMARY parse/emit
 * target — not W3C DTCG. DTCG is layered on top as an interop format
 * (`dtcg.ts`), converting to/from this same `TokenModel`.
 *
 * `tokens.js` exports six groups, three of which are theme-dependent
 * (`colors` = light, `colorsDark` = dark) and three of which are
 * theme-independent (`spacing`, `rounded`, `elevation`); `typography` is
 * theme-independent but nested one level (each scale is its own
 * sub-object of fields). Every token this package produces is normalized
 * into the flat `Token` shape below regardless of source nesting — the
 * dot-path `name` preserves the original structure (e.g.
 * `"typography.display.fontSize"`).
 */

export type ThemeName = 'light' | 'dark';

export const THEME_NAMES: readonly ThemeName[] = ['light', 'dark'];

/**
 * Token "type" — a coarse classification used by token-aware inspector
 * inputs (P5) to pick the right control, and by `tokensForProperty` here
 * to filter candidates for a given CSS property. Intentionally small and
 * closed (not the full DTCG `$type` enum) — DTCG import maps its richer
 * `$type` vocabulary down onto this set (`dtcg.ts`), and export re-expands
 * it using per-group defaults.
 */
export type TokenType =
  | 'color'
  | 'dimension'
  | 'shadow'
  | 'fontFamily'
  | 'fontWeight'
  | 'number'
  | 'string';

export type TokenGroup = 'color' | 'spacing' | 'rounded' | 'elevation' | 'typography';

/**
 * A single resolved token. `value` always carries BOTH theme slots —
 * theme-independent tokens (spacing/rounded/elevation/typography) simply
 * repeat the same value under `light` and `dark`, so every consumer can
 * treat every token uniformly ("does this token vary by theme?" becomes
 * `value.light !== value.dark`, no separate theme-independent code path
 * needed downstream).
 *
 * `alias` is populated only for tokens imported from DTCG that used a
 * `{group.key}` reference (`dtcg.ts`) — the Almosafer JS source has no
 * alias syntax of its own (every value there is already a literal).
 */
export interface Token {
  /** Dot-path identifying this token within its group, e.g. "aqua100",
   * "md", "display.fontSize". Stable, source-order-independent. */
  name: string;
  group: TokenGroup;
  type: TokenType;
  value: Record<ThemeName, string | number>;
  /** Computed CSS custom-property name, e.g. "--color-aqua-100". */
  cssVar: string;
  /** Present when this token's value(s) were resolved from a DTCG alias
   * reference rather than authored as a literal (round-trip metadata). */
  alias?: string | undefined;
}

export interface TokenModel {
  tokens: Token[];
  themes: readonly ThemeName[];
}

export function findToken(model: TokenModel, group: TokenGroup, name: string): Token | undefined {
  return model.tokens.find((t) => t.group === group && t.name === name);
}

export function tokensByGroup(model: TokenModel, group: TokenGroup): Token[] {
  return model.tokens.filter((t) => t.group === group);
}
