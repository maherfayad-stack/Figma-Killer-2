import { Project } from 'ts-morph';
import { resolveAstPath } from './uid-path.js';

/**
 * `getNodeSource(sourceText, uid)` — FP-INS-b (`.orchestrator/
 * FEATURE-PARITY-PLAN.md` "Inspect / code tab"): the Inspect tab's "Code
 * (JSX)" section needs the selected node's EXACT original source slice.
 * Per the task brief's security directive ("prefer getting the node's source
 * SLICE by asking `@ccs/ast-engine` to print the node from the already-
 * parsed AST ... rather than substring-hacking the file"), this parses the
 * frame's current source with the SAME in-memory ts-morph `Project` +
 * `resolveAstPath` (`uid-path.ts`) that `build-tree.ts` (tree-snapshot) and
 * `apply-op.ts` (op resolution) already use — the identical, already-
 * conformance-tested uid <-> AST-node mapping (ADR-0017), so a uid clicked in
 * the Inspect tab resolves to the SAME node a `CanvasOp` targeting it would.
 *
 * `node.getText()` (ts-morph) returns the exact ORIGINAL source text of that
 * node's span (the real file bytes, not a re-printed/reformatted
 * reconstruction) — a component-instance uid's slice is naturally its
 * `<Component .../>` usage code, satisfying the "component" granularity of
 * "take the page, component, or code of anything" without any special-casing
 * for that node kind.
 *
 * Read-only, zero-IO (same discipline as `buildTree`/`applyOp`): this module
 * never touches the filesystem — callers (`sync-daemon`'s `read-source`
 * control-message handler) own the one fs read and pass the resulting text
 * in.
 */

export type NodeSourceResult = { ok: true; source: string } | { ok: false; reason: string };

/**
 * Splits a `NodeUid` wire string (`<relPath>.tsx:<astPath>`) into its two
 * halves. A small, deliberately-duplicated port of `apply-op.ts`'s private
 * `splitNodeUid` (not exported from that module) — kept local rather than
 * threading a new export through the op-application hot path for one extra
 * caller; both copies are tiny and share the same frozen wire format
 * (`packages/protocol/src/uid.ts`).
 */
function splitNodeUid(uid: string): { relPath: string; astPath: string } | null {
  const marker = '.tsx:';
  const idx = uid.indexOf(marker);
  if (idx === -1) return null;
  return { relPath: uid.slice(0, idx + 4), astPath: uid.slice(idx + marker.length) };
}

export function getNodeSource(sourceText: string, uid: string): NodeSourceResult {
  const split = splitNodeUid(uid);
  if (!split) {
    return { ok: false, reason: `malformed NodeUid (expected "<relPath>.tsx:<astPath>"): "${uid}"` };
  }

  // NOTE (AUDIT-FPINSb minor #4): `split.relPath` is intentionally DISCARDED
  // here — only `split.astPath` drives resolution, against the `sourceText`
  // the CALLER already read. This is NOT (and must not be mistaken for) a
  // security/containment check: containment is enforced upstream, in the
  // daemon's `read-source` handler, by `resolveContainedPath` (`safe-path.ts`)
  // against the request's own `framePath` BEFORE the file is ever read. A
  // crafted uid whose relPath half points elsewhere (e.g.
  // `../../../etc/passwd.tsx:d0`) cannot escape anything: this module never
  // touches the filesystem — it only reprints an AST node found by astPath
  // within the already-contained `sourceText`, so a bogus relPath simply
  // resolves that astPath against the SAME text (or returns "not found").
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.tsx', sourceText);
  const node = resolveAstPath(sourceFile, split.astPath);
  if (!node) {
    return { ok: false, reason: `no JSX node found for uid "${uid}"` };
  }
  return { ok: true, source: node.getText() };
}
