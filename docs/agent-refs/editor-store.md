# Editor store

Zustand + Mutative, composed from slices. Source:
`src/admin/pages/site/store/`.

---

## Non-negotiables

1. **Draft-mutation style.** `set((s) => { s.x = … })`. A recipe that returns a
   partial object must wrap it in `rawReturn(...)` or Mutative emits a perf
   warning. `immer` is banned.
2. **All tree mutations go through `mutateActiveTree`.** Never mutate
   `page.nodes` directly from a component or another slice.
3. **Never scan every node of every page inside a selector.** Selectors run on
   every store change. Precompute an index in the slice instead.
4. **Selectors must return stable references** or a primitive. Returning a fresh
   object/array literal re-renders on every store change.

---

## Slices

| Slice | Owns |
|---|---|
| `siteSlice.ts` | The site document, `loadSite`, `saveSite`, the 11 named tree actions |
| `site/helpers.ts` | `resolveActiveTreeTarget`, `mutateActiveTree` — **the only place that knows which tree is active** |
| `boardSlice.ts` | Boards, frames, `addFrame`, `setFramePosition`, `setFrameSize`, `seedFramesForActiveBoard` |
| `selectionSlice.ts` | `selectedNodeId`, `selectedNodeIds`, multi-select, focus target |
| `canvasSlice.ts` | `canvasView` ('design' \| 'live'), zoom/pan, `activeBreakpointId`, `runScripts` |
| `inlineEditSlice.ts` | `activeInlineEdit` — one session globally |
| `styleRuleSlice.ts` | The CSS class registry |
| `uiSlice.ts` | `activeDocument`, panel open/closed, right sidebar expanded |
| `sitePanelSlice.ts` | Panel-specific UI state |
| `clipboardSlice.ts` | Copy/paste of subtrees |
| `filesSlice.ts` | Site files / code assets |
| `saveTrackingSlice.ts` | Dirty tracking, autosave cadence |
| `visualComponentsSlice.ts`, `vcTreeOps.ts`, `vcSlotReconcile.ts` | Visual Components |
| `layoutsSlice.ts`, `settingsSlice.ts` | Layouts, editor settings |

---

## The mutation API

Every mutation in `src/core/page-tree/mutations.ts` takes a `NodeTree<TNode>` and
is **tree-agnostic** — it knows nothing about pages vs Visual Components.

The 11 named store actions are one-liners over `mutateActiveTree`:

```
insertNode · deleteNode · updateNodeProps · setBreakpointOverride ·
clearBreakpointOverride · renameNode · toggleNodeLocked · toggleNodeHidden ·
moveNode · duplicateNode · wrapNode
```

**They must not contain a `kind === 'visualComponent'` branch.**
Gate: `no-vc-mode-branches-in-mutations.test.ts`.

Plugins reach the same engine via `applyTreeOperation(tree, op)` from
`@core/page-tree`, dispatched on `op.kind`.

---

## Studio-specific store behaviour

**`updateNodeProps` and `setNodeInlineStyles` refuse a patch if *any* key is
code-valued** — all-or-nothing, because a half-applied patch is a canvas that
disagrees with the file it mirrors. Both refuse **silently**: they are also
called by agents and plugins, where a toast would be noise. The one announced
refusal is canvas double-click on a code-valued text prop, because the user just
double-clicked real copy and nothing happened.

**`loadSite` keeps the currently-open page** when the incoming site still
contains its id. Resetting to home is right when opening a different project and
wrong when re-syncing the open one.

**`saveSite`** collects dirty nodes into a `StudioEdit[]` batch:
- `tag`/`customTag` collapse into one `effectiveTag`, diffed against the load
  baseline, emitted as `kind: 'tag'`;
- resolved text with a `textOrigin` is emitted as `kind: 'literal'` with the
  **origin's** `rel:line:col` as its `nodeId` — and that path runs **before** the
  `hasWritableSourceLocation` guard, because that guard is about JSX locations
  and a literal edit has nothing to do with the node's own id.

---

## Undo / redo

Patch-based, via Mutative `create({ enablePatches })`. Details:
[`docs/reference/editor-history.md`](../reference/editor-history.md).

**Coalescing:** single-field patches coalesce under a key like
`props:<nodeId>:<prop>`, so a burst of keystrokes is ONE undo entry.
`startInlineEdit`/`endInlineEdit` reset `_historyCoalesceKey` so an inline-edit
burst never folds into a Properties-panel burst for the same prop.

If you add a mutation, decide its coalesce key deliberately. Wrong key = either
one undo wipes unrelated work, or every keystroke is its own entry.

---

## Adding state — checklist

- [ ] Does it belong in an existing slice? Prefer that over a new one.
- [ ] Is it derivable? Derive it in a selector instead of storing it.
- [ ] Does it need to survive a reload? If so it belongs in `.studio/` on disk
      (project data) or in editor preferences — not in transient store state.
- [ ] Is the selector O(1)? If it walks the tree, precompute an index.
- [ ] Does a tree mutation need a history entry and a coalesce key?
- [ ] Does a new action need to consult `isPropWritableToSource`?
