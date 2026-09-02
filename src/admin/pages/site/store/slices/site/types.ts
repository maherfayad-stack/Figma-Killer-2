/**
 * Internal types for the siteSlice modules.
 *
 * `SiteSlice` is the public store-action surface; the helpers contract is the
 * private collaborator object passed from the slice creator into each action
 * factory in this directory.
 */

import type { StoreApi } from 'zustand'
import type { Draft, Patches } from 'mutative'
import type { FrameworkColorToken, FrameworkColorUtilityType, FrameworkPreferencesSettings, FrameworkScaleManualSize, FrameworkScaleMode, FrameworkSettings, FrameworkSpacingClassGenerator, FrameworkSpacingGroup, FrameworkTypographyClassGenerator, FrameworkTypographyGroup } from '@core/framework-schema'
import type {
  DecorativeSiteExplorerSectionId,
  ExplorerPathChangePlan,
  Page,
  PageNode,
  NodeTree,
  Breakpoint,
  SiteDocument,
  SiteExplorerSectionId,
  SiteSettings,
  PageTemplateConfig,
  ConditionDef,
  StyleRule,
  StructuralExplorerRowOrder,
  StructuralSiteExplorerSectionId,
} from '@core/page-tree'
import type { FontEntry, FontToken } from '@core/fonts'
import type { ImportFragment } from '@core/htmlImport'
import type { NewStyleRule, SiteImportTransaction } from '@core/siteImport'
import type { FrameworkChangeImpact, FrameworkPreset } from '@core/framework'
import type { EditorStore } from '@site/store/types'


// ---------------------------------------------------------------------------
// Public action surface — every method below appears as a top-level entry on
// the EditorStore.
// ---------------------------------------------------------------------------

/** Input to `SiteSlice.patchPages` — see that method's doc for the full contract. */
export interface PatchPagesInput {
  /** Freshly re-parsed pages that still exist — upserted by id, appended if new. */
  pages: Page[]
  /** Ids that were part of the touched set but no longer resolve to a page. */
  removedPageIds?: string[]
  /**
   * The project-wide style registry the same reload recomputed.
   *
   * NOT optional-because-nice-to-have: a re-parsed page's `classIds` name
   * rules from the registry that was computed WITH it, and rendering it
   * against the previous one resolves those nodes to no class at all — an
   * unstyled, collapsed page that looks broken until a manual refresh.
   * Omitted only by a caller that genuinely has no fresher registry (a test,
   * or a patch that never re-read the project), in which case the current one
   * stands.
   */
  styleRules?: Record<string, StyleRule>
  /** The project-wide condition set from the same reload — same contract as `styleRules`. */
  conditions?: ConditionDef[]
}

export type ColorVariantOptions = { enabled: boolean; count: number }

export interface CreateFrameworkColorTokenInput {
  category?: string
  slug: string
  lightValue: string
  darkValue?: string
  darkModeEnabled?: boolean
  generateUtilities?: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent?: boolean
  generateShades?: Partial<ColorVariantOptions>
  generateTints?: Partial<ColorVariantOptions>
}

export type UpdateFrameworkColorTokenPatch = Partial<{
  category: string
  slug: string
  lightValue: string
  darkValue: string
  darkModeEnabled: boolean
  generateUtilities: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent: boolean
  generateShades: Partial<ColorVariantOptions>
  generateTints: Partial<ColorVariantOptions>
  order: number
}>

export type UpdateFrameworkTypographyGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  /** Patch into the `min` breakpoint config — fields are merged, untouched fields preserved. */
  min: Partial<FrameworkTypographyGroup['min']>
  max: Partial<FrameworkTypographyGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export type UpdateFrameworkSpacingGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  min: Partial<FrameworkSpacingGroup['min']>
  max: Partial<FrameworkSpacingGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

interface CreateFontTokenInput {
  name: string
  variable?: string
  familyId?: string | null
  fallback?: string
}

type UpdateFontTokenPatch = Partial<{
  name: string
  variable: string
  familyId: string | null
  fallback: string
  order: number
}>

/**
 * One undoable transaction, stored as Mutative patch pairs scoped to the
 * SiteDocument (paths are relative to `site`, e.g. `['pages', 0, 'nodes', …]`).
 *
 * - `inverse` reverts the transaction (applied on undo).
 * - `forward` re-applies it (applied on redo).
 * - `coalesceKey` carries the in-progress input-burst identity so consecutive
 *   per-keystroke edits fold into a single entry (see `commitHistory`).
 */
export interface HistoryEntry {
  inverse: Patches
  forward: Patches
  coalesceKey: string | null
}

export interface SiteSlice {
  site: SiteDocument | null

  // SiteDocument lifecycle
  createSite: (name: string) => SiteDocument
  loadSite: (site: SiteDocument) => void
  clearSite: () => void
  updateSiteName: (name: string) => void
  /**
   * Merge a freshly-re-parsed subset of pages into `site.pages`, WITHOUT
   * marking the store dirty and WITHOUT touching undo history — the
   * agent-write live-reload path (a `execution: 'server'` tool wrote `.tsx`
   * to disk; only the files it touched get re-parsed and patched in here).
   * Untouched pages keep the user's own unsaved edits and undo history
   * completely alone.
   *
   * `input.pages` — existing ids are upserted in place (preserving position);
   * an id not currently in `site.pages` is appended (how `studio_create_page`
   * reaches the open canvas). `input.removedPageIds` — ids that were part of
   * the touched set but no longer resolve to a page (deleted on disk); each
   * is dropped from `site.pages`, any board frame referencing it, and
   * `selectedFrameIds`/`selectedNodeIds` if they pointed at it.
   *
   * If a page being upserted had local (unsaved) edits, those edits are
   * discarded by the incoming disk content — surfaced via a toast, per
   * policy ("merge: reload only touched pages" — the agent's write wins for
   * a page it also touched).
   *
   * See `docs/agent-refs/editor-store.md` for the full contract this
   * implements.
   */
  patchPages: (input: PatchPagesInput) => void

  // Page mutations
  addPage: (title: string, slug?: string) => Page
  deletePage: (pageId: string) => void
  renamePage: (pageId: string, title: string, slug?: string) => void
  duplicatePage: (sourcePageId: string, title: string, slug?: string) => Page
  reorderPages: (fromIndex: number, toIndex: number) => void
  convertPageToTemplate: (pageId: string, config: PageTemplateConfig) => void
  convertTemplateToPage: (pageId: string) => void
  createExplorerFolder: (sectionId: SiteExplorerSectionId, name: string, parentPath?: string) => string
  renameExplorerFolder: (sectionId: DecorativeSiteExplorerSectionId, folderId: string, name: string) => void
  deleteExplorerFolder: (sectionId: DecorativeSiteExplorerSectionId, folderId: string) => void
  moveExplorerFolder: (sectionId: DecorativeSiteExplorerSectionId, folderId: string, nextIndex: number) => void
  moveExplorerItem: (
    sectionId: DecorativeSiteExplorerSectionId,
    itemId: string,
    parentFolderId: string | null,
    nextIndex: number,
  ) => void
  moveExplorerItems: (
    sectionId: DecorativeSiteExplorerSectionId,
    itemIds: string[],
    parentFolderId: string | null,
    nextIndex: number,
  ) => void
  wrapExplorerItemsInFolder: (sectionId: DecorativeSiteExplorerSectionId, itemIds: string[], name: string) => string | null
  previewRenameExplorerFolder: (
    sectionId: StructuralSiteExplorerSectionId,
    folderPath: string,
    nextFolderPath: string,
  ) => ExplorerPathChangePlan
  previewMoveExplorerFolder: (
    sectionId: StructuralSiteExplorerSectionId,
    folderPath: string,
    nextParentPath: string | undefined,
  ) => ExplorerPathChangePlan
  previewMoveExplorerItem: (
    sectionId: StructuralSiteExplorerSectionId,
    itemId: string,
    nextParentPath: string | undefined,
  ) => ExplorerPathChangePlan
  previewDeleteExplorerFolder: (
    sectionId: StructuralSiteExplorerSectionId,
    folderPath: string,
  ) => ExplorerPathChangePlan
  commitExplorerPathChange: (plan: ExplorerPathChangePlan) => void
  toggleStructuralExplorerFolder: (sectionId: StructuralSiteExplorerSectionId, folderPath: string) => void
  moveStructuralExplorerRow: (
    sectionId: StructuralSiteExplorerSectionId,
    row: Omit<StructuralExplorerRowOrder, 'order'>,
    nextIndex: number,
  ) => void
  setPageAsHomepage: (pageId: string) => void

  // Node mutations (operate on the active page)
  insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string, index?: number) => string

  /**
   * Insert a fragment of imported HTML nodes into the active tree under `parentId`.
   * Merges all `fragment.nodes` into the tree and wires `fragment.rootIds` as children
   * of `parentId` at `opts.index` (appended when omitted). One undo step.
   * Returns the inserted root IDs, or an empty array when the parent does not accept children.
   *
   * `opts.styleRules` / `opts.conditions` are rules parsed from `<style>` blocks
   * in the imported HTML (via `cssToStyleRules`); they are committed into the
   * registry (Selectors panel) and bound to matching `class=` tokens in the
   * same undo step.
   */
  insertImportedNodes: (
    parentId: string,
    fragment: ImportFragment,
    opts?: { index?: number; styleRules?: NewStyleRule[]; conditions?: ConditionDef[] },
  ) => string[]

  /**
   * Insert a `base.visual-component-ref` node into the active document.
   *
   * - In VC mode: inserts via `mutateActiveTree` and guards against cyclic references.
   *   Returns `null` if the insertion would create a cycle.
   * - In page mode: inserts via `insertNode`. Returns `null` if `componentId` is empty.
   * - Auto-materializes `base.slot-instance` children after insertion via `syncSlotInstances`.
   * - `index` is forwarded to `insertNode` so callers can drop the new ref at a
   *   specific sibling position (used by the resolveInsertLocation flow when
   *   pasting / right-clicking a leaf target).
   * - Returns the new node's id on success, or `null` on no-op / cycle prevented.
   */
  insertComponentRef: (parentId: string, componentId: string, index?: number) => string | null
  deleteNode: (nodeId: string) => void
  /** Multi-delete: removes every id and its descendants in one undo step. */
  deleteNodes: (nodeIds: string[]) => void
  updateNodeProps: (nodeId: string, patch: Record<string, unknown>) => void
  /**
   * instance-ui-01 — write ONE call-site prop on a `studio.instance` node
   * (`props.callSiteProps.<propName>`), the WS-4.2/4.3 instance model's
   * nested prop bag. Silently refuses (no-op, same convention as
   * `updateNodeProps`) when `callSiteProps:<propName>` is code-valued —
   * checked per-FIELD, unlike routing this through `updateNodeProps` itself
   * would give (that action's own guard is keyed on the literal patch key
   * `"callSiteProps"`, which can't see a per-field lock).
   */
  updateInstanceCallSiteProp: (nodeId: string, propName: string, value: unknown) => void
  /**
   * Patch a node's inline styles (`node.inlineStyles`) — the per-node `style=""`
   * layer emitted by the publisher. A `null`/`undefined`/`''` value in the patch
   * removes that property; an empty resulting bag clears the field entirely.
   * Inline styles are BASE-ONLY (no breakpoint/condition axis), mirroring real
   * HTML inline styles.
   */
  setNodeInlineStyles: (nodeId: string, patch: Record<string, string | number | null | undefined>) => void
  /** Remove a single property from a node's inline styles. */
  removeNodeInlineStyleProperty: (nodeId: string, propKey: string) => void
  /** Remove ALL inline styles from a node (clears the `inlineStyles` field). */
  clearNodeInlineStyles: (nodeId: string) => void
  setBreakpointOverride: (nodeId: string, breakpointId: string, patch: Record<string, unknown>) => void
  clearBreakpointOverride: (nodeId: string, breakpointId: string) => void
  renameNode: (nodeId: string, label: string) => void
  toggleNodeLocked: (nodeId: string) => void
  toggleNodeHidden: (nodeId: string) => void
  moveNode: (nodeId: string, newParentId: string, newIndex: number) => void
  /** Multi-move: moves every top-level id into newParent at newIndex (single undo step). */
  moveNodes: (nodeIds: string[], newParentId: string, newIndex: number) => void
  duplicateNode: (nodeId: string) => string
  /** Multi-duplicate: duplicates every id in place (single undo step). Returns the new ids. */
  duplicateNodes: (nodeIds: string[]) => string[]
  wrapNode: (nodeId: string, containerModuleId: string, defaults?: Record<string, unknown>) => string
  /**
   * Wrap a multi-selection inside one new container with closest-common-ancestor
   * semantics. Returns the new wrapper id, or `null` when the selection is empty.
   */
  wrapNodes: (nodeIds: string[], containerModuleId: string, defaults?: Record<string, unknown>) => string | null

  // Breakpoint mutations
  addBreakpoint: (bp: Omit<Breakpoint, 'id'>) => Breakpoint
  updateBreakpoint: (id: string, patch: Partial<Omit<Breakpoint, 'id'>>) => void
  removeBreakpoint: (id: string) => void
  reorderBreakpoints: (fromIndex: number, toIndex: number) => void

  // SiteDocument settings mutations
  updateSiteSettings: (patch: Partial<SiteSettings>) => void

  // Framework color mutations
  createFrameworkColorToken: (input: CreateFrameworkColorTokenInput) => FrameworkColorToken
  updateFrameworkColorToken: (tokenId: string, patch: UpdateFrameworkColorTokenPatch) => void
  duplicateFrameworkColorToken: (tokenId: string) => FrameworkColorToken | null
  reorderFrameworkColorToken: (tokenId: string, direction: 'up' | 'down') => void
  deleteFrameworkColorToken: (tokenId: string) => void

  // Framework preferences
  updateFrameworkPreferences: (patch: Partial<FrameworkPreferencesSettings>) => void

  // Framework typography mutations
  toggleFrameworkTypographyDisabled: () => void
  createFrameworkTypographyGroup: () => FrameworkTypographyGroup
  updateFrameworkTypographyGroup: (groupId: string, patch: UpdateFrameworkTypographyGroupPatch) => void
  duplicateFrameworkTypographyGroup: (groupId: string) => FrameworkTypographyGroup | null
  resetFrameworkTypographyGroup: (groupId: string) => void
  deleteFrameworkTypographyGroup: (groupId: string) => void
  upsertFrameworkTypographyManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<FrameworkScaleManualSize>,
  ) => void
  setFrameworkTypographyClassGenerators: (classes: FrameworkTypographyClassGenerator[]) => void

  // Framework spacing mutations
  toggleFrameworkSpacingDisabled: () => void
  createFrameworkSpacingGroup: () => FrameworkSpacingGroup
  updateFrameworkSpacingGroup: (groupId: string, patch: UpdateFrameworkSpacingGroupPatch) => void
  duplicateFrameworkSpacingGroup: (groupId: string) => FrameworkSpacingGroup | null
  resetFrameworkSpacingGroup: (groupId: string) => void
  deleteFrameworkSpacingGroup: (groupId: string) => void
  upsertFrameworkSpacingManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<FrameworkScaleManualSize>,
  ) => void
  setFrameworkSpacingClassGenerators: (classes: FrameworkSpacingClassGenerator[]) => void

  // ─── Core Framework lifecycle (Manage Framework dialog) ──────────────────
  /**
   * Reconcile the framework to a declarative target state:
   *   • 'full'      — merge the preset (add-missing) and enable utility classes
   *   • 'variables' — merge the preset (add-missing) and strip utility classes
   *   • 'none'      — clear settings.framework entirely
   * Reconcile then strips every stale framework classId from nodes.
   */
  setFrameworkPreset: (target: FrameworkPreset) => void

  /**
   * `tokens-01` — lands a server-derived token extraction result (see
   * `server/handlers/studio/tokenExtract.ts`) into the live document. The
   * server has already done the "never clobber existing values" merge and
   * persisted it to `.studio/framework.json`; this just applies that SAME,
   * already-merged result to `site.settings.framework` so the panel reflects
   * it without waiting for a full reload. Studio-only — no-op wiring elsewhere.
   */
  applyExtractedFrameworkTokens: (framework: FrameworkSettings) => void

  // ─── Site fonts library ─────────────────────────────────────────────────
  /**
   * Add a font to the library. The caller (UI) is responsible for first calling
   * the server install endpoint, which downloads the woff2 files; the resulting
   * `FontEntry` returned by the server is what gets passed here. The action
   * itself is purely client-side — it only mutates `settings.fonts.items`.
   * Duplicate `family` (case-insensitive) on the same `source` is a no-op.
   */
  addFont: (entry: FontEntry) => FontEntry
  /**
   * Remove an installed font by id. Server file cleanup is the caller's job.
   * Returns false when no entry was removed, including when a font token still
   * references the family.
   */
  removeFont: (fontId: string) => boolean
  createFontToken: (input: CreateFontTokenInput) => FontToken
  updateFontToken: (tokenId: string, patch: UpdateFontTokenPatch) => void
  deleteFontToken: (tokenId: string) => boolean

  /**
   * Preview the destructive impact of a framework-related change without
   * committing it. Returns the list of framework classes that would be
   * removed and every place those classes are still assigned, or `null`
   * if the change removes nothing-in-use (silent commit is fine).
   *
   * The caller writes a small mutation function that mirrors what the
   * actual store action would do at the framework-settings level. This
   * function clones the current site, applies the mutation to the clone,
   * runs every framework reconciler, then diffs.
   */
  previewFrameworkChange: (
    applyChange: (site: SiteDocument) => void,
  ) => FrameworkChangeImpact | null

  // ─── Super Import ─────────────────────────────────────────────────────────
  /**
   * Mutate the entire site — all pages and style rules — in ONE undoable
   * history snapshot. The recipe receives a SiteDocument draft and helpers
   * that mint new pages / style rules or overwrite existing ones.
   *
   * Used by the Super Import wizard so Cmd+Z reverts the whole import in a
   * single press. Returns `true` when the recipe produced at least one real
   * mutation; `false` for explicit no-ops.
   */
  mutateAllPagesAndSite(fn: (site: SiteDocument, helpers: SiteImportTransaction) => SiteMutationResult): boolean

  // ─── Undo / Redo ──────────────────────────────────────────────────────────
  /**
   * Per-transaction Mutative patch pairs — most recent last. Each entry stores
   * `inverse` (applied on undo) + `forward` (applied on redo) patches scoped to
   * the SiteDocument, so a step costs O(change) memory instead of a full-site
   * clone. See `HistoryEntry`.
   */
  _historyPast: HistoryEntry[]
  /** Entries popped by undo, available for redo — most recent last */
  _historyFuture: HistoryEntry[]
  /** True if there's at least one state to undo to */
  canUndo: boolean
  /** True if there's at least one state to redo to */
  canRedo: boolean
  /**
   * Identity key of the in-progress history-coalescing burst, or `null`.
   *
   * Continuous-input mutations (per-keystroke text/number edits) pass a stable
   * key derived from their target (`props:<nodeId>:<prop>`, etc.). While the
   * incoming key matches this one, the mutation folds into the existing
   * top-of-stack snapshot instead of cloning the whole site again — so typing a
   * word is ONE undo step, not one per character. Any non-coalescing mutation,
   * `undo`/`redo`, or a site (re)load resets it to `null`, ending the burst.
   */
  _historyCoalesceKey: string | null
  undo: () => void
  redo: () => void

  // ─── Node-lookup indexes (WS-5.2) ────────────────────────────────────────
  /**
   * Every page id a node id currently appears on — many-valued because a
   * composed Next.js `layout.tsx` node shares one id across every route
   * beneath it (see `nodeIndex.ts` doc comment, `STATE.md` → `meta-05`).
   * Built at load, maintained incrementally by every mutation. Read through
   * `applyNodeIndexPatch`/`rebuildNodeIndexes` — never mutate directly.
   */
  _nodeIdToPageIds: Map<string, string[]>
  /** How many nodes across the site resolve text from the same source literal. */
  _textOriginKeyToCount: Map<string, number>
  /** How many nodes across the site were inlined from the same local-component call site. */
  _inlineTailToCount: Map<string, number>
}

// ---------------------------------------------------------------------------
// Internal helpers contract — passed from the slice creator into each action
// factory. Centralises the closure-bound mutation helpers so action files do
// not need to re-implement history snapshotting or active-tree routing.
// ---------------------------------------------------------------------------

/**
 * Recipe accepted by `set` / the `mutate*` helpers. Mirrors the
 * `zustand-mutative` middleware signature: a recipe receives a Mutative draft
 * and mutates it in place (returning `void`); returning a replacement value is
 * also tolerated for full-state replacement.
 */
export type SiteSliceRecipe = (state: Draft<EditorStore>) => void | EditorStore

/**
 * Mutation recipes return `false` when they intentionally did not change the
 * SiteDocument. `void` and `true` both mean the recipe performed a mutation.
 */
export type SiteMutationResult = void | boolean

export interface SiteSliceHelpers {
  /** Raw set/get from the slice creator. Use only when no helper covers the case. */
  set: (recipe: SiteSliceRecipe) => void
  get: StoreApi<EditorStore>['getState']

  /**
   * Mutate the active node tree — commits undo history only on real changes.
   *
   * Routes to the correct tree based on `activeDocument`:
   *   - Page mode (null or kind === 'page'): passes the active Page directly —
   *     Page IS NodeTree<PageNode> so no conversion needed.
   *   - VC mode (kind === 'visualComponent'): passes vc.tree directly —
   *     VCNode (= BaseNode) is structurally compatible with PageNode, so the
   *     cast is safe for tree mutations that operate on BaseNode-level fields.
   *     After the mutation, propagates any change in the VC's slot-outlet set
   *     to every consumer VC ref across all pages via `syncSlotInstances`.
   */
  mutateActiveTree: (
    fn: (tree: NodeTree<PageNode>) => SiteMutationResult,
    opts?: { coalesceKey?: string },
  ) => boolean

  /**
   * Mutate the active node tree AND the surrounding site — auto-snapshots
   * undo history only on real changes. Same active-document routing as `mutateActiveTree`, plus
   * a `SiteDocument` draft so callers can also mutate site-level state
   * (e.g. `site.styleRules` for scoped-class cloning) in one atomic recipe.
   */
  mutateActiveTreeAndSite: (
    fn: (tree: NodeTree<PageNode>, site: SiteDocument) => SiteMutationResult,
  ) => boolean

  /** Mutate the site — commits undo history only on real changes. */
  mutateSite: (
    fn: (site: SiteDocument) => SiteMutationResult,
    opts?: { coalesceKey?: string },
  ) => boolean

  /** Mutate the site and reconcile Site Explorer organization after a real change. */
  mutateSiteWithExplorerReconcile: (fn: (site: SiteDocument) => SiteMutationResult) => boolean

  /**
   * Mutate the full editor state and site document in one undoable transaction.
   * Use only when a site mutation must also update editor-local state such as
   * the active document or selection.
   */
  mutateSiteState: (
    fn: (state: Draft<EditorStore>, site: SiteDocument) => SiteMutationResult,
  ) => boolean

  /**
   * Mutate all pages and style rules in one undoable history snapshot.
   * See `SiteSlice.mutateAllPagesAndSite` for the full contract.
   */
  mutateAllPagesAndSite: (
    fn: (site: SiteDocument, helpers: SiteImportTransaction) => SiteMutationResult,
  ) => boolean

  /**
   * WS-7.3 — mutate every page tree that contains at least one of `nodeIds`,
   * running `fn` once per distinct page with just that page's own matching
   * ids. Falls back to the plain single-tree `mutateActiveTree` path when
   * every id resolves to (at most) one page, or in VC mode. See the
   * implementation in `site/helpers.ts` for the full contract.
   */
  mutateTreesForNodeIds: (
    nodeIds: string[],
    fn: (tree: NodeTree<PageNode>, idsOnThisTree: string[]) => SiteMutationResult,
  ) => boolean
}
