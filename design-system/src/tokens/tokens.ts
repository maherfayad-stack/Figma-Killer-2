/**
 * JS mirror of tokens.css, for inline styles/animations/tests — same role
 * as the real Almosafer DS's `src/tokens/tokens.js` (see CLAUDE.md: "JS
 * mirrors are exported from tokens.js for use in inline styles, animations,
 * or tests").
 *
 * `tokenSets`/`themes` below is a thin bridging layer, not part of the
 * Almosafer shape itself: it groups these same values under the "one set
 * 'core' + light/dark themes" vocabulary this task's brief asked for,
 * without inventing a DTCG JSON file that the real DS doesn't have.
 */

export const colors = {
  metal: '#1C1C1C',
  light: '#FFFFFF',
  aqua100: '#0C9AB0',
  aqua200: '#008296',
  coral100: '#EF4550',
  border: '#D8DCE0',
} as const;

export const colorsDark = {
  metal: '#F8F9F9',
  light: '#1C1C1C',
  aqua100: '#07ACC5',
  aqua200: '#0394AA',
  coral100: '#E9666F',
  border: '#3C4244',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 24,
} as const;

export const rounded = {
  sm: '8px',
  base: '12px',
  full: '100px',
} as const;

export const elevation = {
  raised: '0px 8px 24px rgba(0, 0, 0, 0.12)',
} as const;

export const typography = {
  bodyRegular: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: '20px',
  },
  bodySemibold: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize: '14px',
    fontWeight: 600,
    lineHeight: '20px',
  },
} as const;

export const tokenSets = {
  core: { colors, spacing, rounded, elevation, typography },
} as const;

export const themes = {
  light: colors,
  dark: colorsDark,
} as const;

export type CoreColorToken = keyof typeof colors;
export type ThemeName = keyof typeof themes;
