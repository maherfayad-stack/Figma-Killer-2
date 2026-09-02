/**
 * studioEditPayload — the wire shape of ONE studio source edit.
 *
 * Extracted from `fsCodemodAdapter.ts`, which owns a different question
 * ("what changed in this tree, and which edits does that imply") and had
 * grown past the module-size ceiling. This is a type and nothing else: the
 * contract between the browser half of the writeback and the server half.
 *
 * It mirrors the discriminated union `server/handlers/studio.ts`
 * validates (`SaveBodySchema`/`StudioEdit`). Kept as a local mirror rather than
 * a shared import: this file runs in the browser, the server file runs in
 * Node/ts-morph, and the two sides only need to agree on the JSON wire shape.
 *
 * Track B1 — the `css` variant is now three ops (`studioCssWriteback.ts`'s
 * `CssEditSchema`): `set`, `insert` (one editable stylesheet exists),
 * `create` (none do, but the server can invent a co-located one). Widened
 * here only because `collectStyleRuleEdits`'s return type includes all
 * three. `create`'s "which file was created" surfacing is wired: `saveSite`
 * calls `notifyCreatedStylesheets` (`studioSaveRequests.ts`) once the save
 * response arrives, alongside the `unexplainedSkips` handling.
 *
 * Track B2 — `class` (`server/handlers/studioEditSchemas.ts`'s
 * `ClassEditSchema`, matching `classNameWriteback.ts`'s `ClassNameEditPayload`)
 * replaces Phase 0 item 0.6's honesty-only stopgap: a `node.classIds` add/
 * remove now reaches disk via `setJsxClassName` instead of only ever warning
 * that it couldn't.
 */
export type StudioEditPayload =
  | { kind: 'prop'; nodeId: string; prop: string; value: string | number | boolean }
  | { kind: 'text'; nodeId: string; text: string }
  | { kind: 'style'; nodeId: string; style: Record<string, string | number> }
  | { kind: 'class'; nodeId: string; add: string[]; remove: string[] }
  | { kind: 'literal'; nodeId: string; text: string }
  | { kind: 'tag'; nodeId: string; tag: string }
  | { kind: 'asset'; nodeId: string; assetPath: string }
  | { kind: 'css'; op: 'set'; nodeId: string; file: string; selector: string; property: string; value: string }
  | { kind: 'css'; op: 'insert'; nodeId: string; file: string; selector: string; declarations: Record<string, string>; atMedia?: string }
  | { kind: 'css'; op: 'create'; nodeId: string; pageFile: string; selector: string; declarations: Record<string, string>; atMedia?: string }
