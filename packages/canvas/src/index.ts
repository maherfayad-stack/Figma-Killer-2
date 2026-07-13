/**
 * packages/canvas — tldraw integration, custom FrameShape, selection overlay.
 * Scope: Phase 1 (playbook §4/P1). This P0 stub only establishes the
 * package boundary + the `packages/canvas` abstraction layer that keeps a
 * custom-camera fallback cheap if tldraw licensing forces it (ADR-0005,
 * playbook §5.4).
 */
export const CANVAS_PACKAGE_PHASE = 'P1' as const;

export function notImplementedYet(feature: string): never {
  throw new Error(`@ccs/canvas: "${feature}" is P1 scope, not implemented in P0`);
}
