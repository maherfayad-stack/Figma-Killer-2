/**
 * packages/ui — the studio application's OWN chrome design system
 * (workspace shell, sidebars, inspector, toolbar, dashboard). Per ADR-0007
 * this mirrors Penpot's UI/UX — it is explicitly NOT themed by the
 * Almosafer DS (that DS is for user file-app content, see ADR-0006).
 * Scope: Phase 5 (playbook §4/P5).
 *
 * Import `@ccs/ui/tokens.css` once (e.g. in `apps/studio/src/main.tsx`) and
 * wrap chrome UI in a container with `className="ccs-root"` (and set
 * `dir="ltr"`/`dir="rtl"` on that same container, or an ancestor) to pick
 * up the tokens + logical-property base styles.
 */
export const UI_PACKAGE_PHASE = 'P5' as const;

export * from './primitives/index.js';
export { Icon, type IconProps, type IconName } from './icons/Icon.js';
