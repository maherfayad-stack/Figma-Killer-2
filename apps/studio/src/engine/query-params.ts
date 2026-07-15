/**
 * Dev/e2e bootstrap query params, read once at module load — mirrors
 * `@ccs/canvas`'s own dev-harness convention (`?daemonPort=`).
 */
const DEFAULT_DAEMON_PORT = 4700;

export function readDaemonPort(): number {
  const fromQuery = new URLSearchParams(window.location.search).get('daemonPort');
  const parsed = fromQuery ? Number.parseInt(fromQuery, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT;
}

/** `?dir=rtl` — sets `<html dir>` before first paint so the e2e RTL
 * acceptance test (playbook §4/P5: "studio chrome renders correctly under
 * `dir='rtl'`") can drive the exact same build with no separate RTL entry
 * point. Every chrome layout in this package uses CSS LOGICAL properties
 * (padding-inline, inset-inline-*, etc. — see `packages/ui` primitives),
 * so setting `direction` on an ancestor is enough for the whole tree
 * (including the CSS Grid dock layout, which mirrors column order under
 * `direction:rtl` per spec) to flip correctly — no direction-specific
 * branch needed anywhere else. */
export function readDir(): 'ltr' | 'rtl' {
  const fromQuery = new URLSearchParams(window.location.search).get('dir');
  return fromQuery === 'rtl' ? 'rtl' : 'ltr';
}
