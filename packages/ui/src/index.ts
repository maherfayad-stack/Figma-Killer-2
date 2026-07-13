/**
 * packages/ui — the studio application's OWN chrome design system
 * (workspace shell, sidebars, inspector, toolbar, dashboard). Per ADR-0007
 * this mirrors Penpot's UI/UX, built on Radix/shadcn — it is explicitly NOT
 * themed by the Almosafer DS (that DS is for user file-app content, see
 * ADR-0006). Scope: Phase 5 (playbook §4/P5).
 */
export const UI_PACKAGE_PHASE = 'P5' as const;

export function notImplementedYet(feature: string): never {
  throw new Error(`@ccs/ui: "${feature}" is P5 scope, not implemented in P0`);
}
