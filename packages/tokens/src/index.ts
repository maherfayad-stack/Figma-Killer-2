/**
 * packages/tokens — token parse/validate, CSS custom property + Tailwind
 * preset emitters. Scope: Phase 4 (playbook §4/P4). Per ADR-0006 the real
 * Almosafer DS is the imported design system; this package's real-world
 * input format is the Almosafer DS shape (CSS custom properties + a JS
 * mirror object — see `templates/design-system` and the CHANGE-REQUEST
 * recorded there), NOT raw W3C DTCG as the playbook's generic §4/P4 text
 * assumes.
 */
export const TOKENS_PACKAGE_PHASE = 'P4' as const;

export function notImplementedYet(feature: string): never {
  throw new Error(`@ccs/tokens: "${feature}" is P4 scope, not implemented in P0`);
}
