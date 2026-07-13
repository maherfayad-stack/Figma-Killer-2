/**
 * packages/bridge — script injected into file-app iframes in studio dev
 * mode: hit-test (postMessage `{type:'hit-test', x, y}` -> uid/rect/dynamic/
 * component/breadcrumb), report-rects, hover-highlight. Scope: Phase 2
 * (playbook §4/P2).
 */
export const BRIDGE_PACKAGE_PHASE = 'P2' as const;

export function notImplementedYet(feature: string): never {
  throw new Error(`@ccs/bridge: "${feature}" is P2 scope, not implemented in P0`);
}
