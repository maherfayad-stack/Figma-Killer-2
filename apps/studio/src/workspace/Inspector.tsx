import * as React from 'react';
import type { TreeNode } from '@ccs/protocol';
import type { StudioCanvasHandle } from '@ccs/canvas';
import { Panel, Input, Select, Checkbox, Button, Icon, type IconName, type SelectOption } from '@ccs/ui';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useEngineApi } from '../engine/engine-api-context.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useNodeOps, type NodeOps } from './use-node-ops.js';
import { findParent } from '../engine/tree-nav.js';
import type { PropSchemaEntry } from '../engine/engine-api.js';
import { getClassHint, setClassHint } from './inspector-class-hints.js';
import { isTextFocused } from './inspector-node-kind.js';
import { useComputedStyle } from './use-computed-style.js';
import {
  buildComputedLookup,
  formatCurrentValue,
  resolveCurrentValue,
  type ComputedLookup,
} from './inspector-computed-values.js';
import {
  ALIGN_ITEMS_GROUP,
  arbitraryInsetEdit,
  arbitrarySizeEdit,
  BORDER_WIDTH_GROUP,
  type ClassEdit,
  type ClassPresetGroup,
  colorGroup,
  DIRECTION_GROUP,
  FONT_WEIGHT_GROUP,
  GAP_GROUP,
  GROW_GROUP,
  HEIGHT_GROUP,
  JUSTIFY_GROUP,
  LEADING_GROUP,
  OPACITY_GROUP,
  ORDER_GROUP,
  PADDING_BOTTOM_GROUP,
  PADDING_END_GROUP,
  PADDING_GROUP,
  PADDING_START_GROUP,
  PADDING_TOP_GROUP,
  POSITION_GROUP,
  POSITION_REMOVE_EXTRA,
  RADIUS_GROUP,
  resolveClassEdit,
  SELF_ALIGN_GROUP,
  SHADOW_GROUP,
  TEXT_ALIGN_GROUP,
  TEXT_SIZE_GROUP,
  TRACKING_GROUP,
  WIDTH_GROUP,
  WRAP_GROUP,
} from './inspector-presets.js';

/**
 * Inspector (right sidebar, playbook §2.3 / PENPOT-FIDELITY-SPEC §5.5,
 * originally FP-INS-a, reworked FIX-W4 for a second, more literally
 * Penpot-faithful pass — every structural decision below is cited against
 * the real Penpot source cloned at `../penpot`, specifically
 * `frontend/src/app/main/ui/workspace/sidebar/options/`):
 *
 * ## Section stack & ordering
 * A fixed, ordered stack of independently-collapsible `Panel` sections.
 * `options/shapes/rect.cljs` and `options/shapes/text.cljs` both render, in
 * this exact order: `layer-menu*` → `measures-menu*` → `layout-container-
 * menu*` → (`grid-cell`) → `layout-item-menu*` → `constraints-menu*` →
 * [`text-menu*` for text shapes only] → `fill-menu*` → `stroke-menu*` →
 * `shadow-menu*` → `blur-menu*` → `exports-menu*`. This file's stack mirrors
 * that: `Layer` → `Content` (this tool's own text-edit affordance, no
 * Penpot equivalent — Penpot edits text in-canvas, not via a menu) →
 * `Size & position` (`measures.cljs`) → `Layout container`
 * (`layout_container.cljs`) → `Layout item` (`layout_item.cljs`) →
 * `Typography` (`text.cljs`'s `text-menu*`, text-capable nodes only) →
 * `Fill` (`fill.cljs`) → `Stroke` (`stroke.cljs`) → `Shadow`
 * (`shadow.cljs`) → `Code` (this tool's own Inspect/dev-mode affordance,
 * any node). DROPPED as vector-only/out of scope per this task's brief:
 * `blur.cljs`, `bool.cljs`, `constraints.cljs`, `svg_attrs.cljs`,
 * `frame_grid.cljs`, `color_selection.cljs`, `grid_cell.cljs`,
 * `interactions.cljs`, `exports.cljs`, and `measures.cljs`'s rotation field
 * (no vector rotation on a DOM element in this tool).
 *
 * ## Two structural consolidations vs. the prior (FP-INS-a) pass, both
 * fixing a literal fidelity gap found by re-reading the real source this
 * time round:
 * - **Opacity moved INTO `Layer`, no longer its own bottom-of-stack Panel.**
 *   `options/menus/layer.cljs` itself owns `:opacity`/`:blend-mode` (see
 *   its `layer-attrs` def and `handle-opacity-change`) — in real Penpot,
 *   opacity is a Layer-row control, not a separate menu. `LayerSection`
 *   below renders it (gated off for component instances, see below).
 * - **Radius moved INTO `Size & position`, out of the old "Border & radius"
 *   Panel; that Panel is renamed `Stroke`.** `options/menus/measures.cljs`
 *   literally `:require`s and renders `border-radius-menu*` INSIDE itself
 *   (`[:> border-radius-menu* {...}]` inside `measures-menu*`'s own body) —
 *   corner radius is part of the Size panel in real Penpot, never its own
 *   section. Border WIDTH/COLOR is a wholly separate real section,
 *   `stroke.cljs` (`stroke-menu*`), rendered after `Fill` — this file's old
 *   combined "Border & radius" Panel conflated the two; they're now split
 *   to match.
 *
 * ## Component instance = props only (item 7d)
 * When the selected node is a component instance (`node.kind ===
 * 'component-instance'`, e.g. an inserted `<Badge/>` surfaced as
 * `ds:Badge`), every CSS section (`Size & position` through `Shadow`,
 * `Content`, `Opacity`) is suppressed — ONLY `Layer` (bare identity, no
 * opacity control), `ComponentPropsSection` (`component.cljs`'s own prop-
 * pill panel, adapted), and `Code` render. This is a DELIBERATE divergence
 * from real Penpot, where a component *copy* still gets the full geometry/
 * fill/stroke stack as shape-level overrides (`component.cljs`'s own
 * `main-instance?`/copy distinction is about detach/swap, not about hiding
 * the rest of the option stack). It diverges because this tool is
 * code-first: an instance here is literally a `<Badge .../>` JSX call, and
 * this file's controls can only write `className`/prop attributes onto
 * that ONE call site — there is no shape-level style-override layer sitting
 * between the instance and the component's own internal render the way
 * Penpot's vector shape model provides, so offering Fill/Stroke/etc. controls
 * on an instance would silently no-op or hit the wrong element. Confirmed
 * against `component.cljs`'s header (`i/component`/`i/component-copy`) for
 * this section's icon.
 *
 * Every control still emits ONLY the existing, frozen `set-classes`/
 * `set-prop`/`set-text` `CanvasOp`s (via `useDaemonConnection().sendOp`,
 * exactly as before) — nothing here is a new op. See `inspector-presets.ts`
 * for the Penpot-menu -> Tailwind-class tables and `inspector-class-hints.ts`
 * for the documented, disclosed limit on how "current value" is shown (no
 * existing protocol/bridge channel exposes a node's live Tailwind classes to
 * `apps/studio` — see that file's module doc for the full CR).
 *
 * A `data-dynamic` node: the FULL (non-instance) section stack still
 * renders (so "shows values" is genuinely true — Penpot itself always shows
 * a locked shape's real properties, just non-editable), but every control is
 * `disabled` and never calls `sendOp` — `readOnly` is threaded down from the
 * top-level branch below into every section.
 *
 * ## Icons
 * `@ccs/ui`'s vendored Penpot icon set (`packages/ui/src/icons/registry.ts`)
 * is deliberately small (~30 icons, not Penpot's full sprite) — no new icon
 * assets were added here (hard constraint: reuse the existing set). Each
 * section below is given the CLOSEST existing icon with a real semantic
 * match; sections with no reasonable match (`Stroke`, `Shadow`) render
 * without one rather than force a wrong icon. `Layer`'s icon is the node's
 * own type icon (`iconForNode`, shown in its body, matching how Penpot's
 * layer row icon IS the shape-type icon — no separate generic glyph).
 *
 * ## FIX-W4b-1 — context-aware sections + real current values
 * Two additions on top of the FIX-W4 stack above (closing the human's own
 * dogfood gaps: "every non-instance node shows the SAME full stack" and
 * "every control shows neutral defaults, never the real current value"):
 *
 * **(a) Per-node-kind section subsets** — Penpot's `options.cljs` +
 * `options/shapes/*.cljs` compose a DIFFERENT ordered subset per shape type.
 * The non-instance branch below now forks four ways (cited inline):
 *   - FRAME/board (`options/shapes/frame.cljs`) — was the EMPTY state (a
 *     board selection sets `selectedUid:null`); now inspects the board's
 *     ROOT `TreeNode` (`currentTree()`) with Layer + Size&position + Layout
 *     container + Fill + Code, plus a frame-context banner. See
 *     `FrameInspector` below.
 *   - fragment/group (`options/shapes/group.cljs`) — Layer + Size&position +
 *     Layout item + Code only (no Fill/Stroke/Shadow/Typography: a `<>`
 *     fragment has no single DOM element to style — `@ccs/ast-engine` refuses
 *     `set-classes`/`set-prop` on a fragment outright).
 *   - text-focused (`options/shapes/text.cljs`) — Layer + Content +
 *     Size&position + Typography + Fill + Stroke + Shadow + Code; NO
 *     Layout-container/-item (kept lean/text-focused per this task's brief).
 *     "text-focused" is `isTextFocused(node)` — see `inspector-node-kind.ts`'s
 *     doc for why it can't be a literal `kind === 'text'` check yet.
 *   - generic element (`options/shapes/rect.cljs`) — the full FIX-W4 stack,
 *     UNCHANGED.
 *
 * **(b) Real current values** — reuses the EXISTING, ADDITIVE FP-INS-b bridge
 * round-trip (`report-computed-style` -> `computed-style-result`) that
 * `InspectPanel.tsx` already consumes; ZERO new protocol/bridge surface.
 * `useComputedStyle` (`use-computed-style.ts`) fetches the selected node's
 * real computed CSS; `ComputedStyleContext` makes that lookup available to
 * every control without threading it through eight section prop lists; each
 * control whose Tailwind group maps to a curated computed property (see
 * `@ccs/bridge`'s `computed-style.ts` for the curated list) renders a
 * `CurrentValueLine` under it. The readout is ALWAYS the element's REAL
 * computed value (or an honest "not set"/"loading…") — never a fabricated
 * token; the exact honesty rule (incl. why numeric scales like `36px` are
 * shown raw, never guessed back to `text-4xl`) lives in
 * `inspector-computed-values.ts`'s module doc.
 */
export interface InspectorProps {
  /** `null` until `StudioCanvas`'s `onReady` fires (mirrors `InspectPanel`'s
   * own prop) — threaded from `WorkspaceShell` so `useComputedStyle` can
   * fetch the selected node's real computed CSS via the same bridge handle
   * `InspectPanel` already uses. */
  canvasHandle: StudioCanvasHandle | null;
  /** Bumped by `WorkspaceShell` on every edit-mode bridge (re)connect — the
   * computed-style fetch depends on it (same race `InspectPanel.tsx`
   * documents: `requestComputedStyle` resolves `{ok:false}` until the frame's
   * bridge is live). */
  bridgeGeneration: number;
}

/** Makes the selected node's REAL computed-style lookup available to every
 * control (via `CurrentValueLine`) without threading a prop through all eight
 * sections. `null` = "not fetched yet / bridge not connected" (rendered as
 * "loading…"), an empty-ish `Map` = "fetched, but this prop isn't set". */
const ComputedStyleContext = React.createContext<ComputedLookup | null>(null);

export function Inspector({ canvasHandle, bridgeGeneration }: InspectorProps): React.ReactElement {
  // NOTE (bug found via this phase's own e2e acceptance run): the selector
  // must CALL `selectedNode()` INSIDE the zustand selector callback, not
  // outside it. `useWorkspaceStore((s) => s.selectedNode)` subscribes to the
  // FUNCTION reference (stable forever — zustand's default `Object.is`
  // equality never sees it change), so the Inspector never re-rendered on
  // selection changes; invoking it as `(s) => s.selectedNode()` subscribes
  // to the COMPUTED NODE, whose reference genuinely changes when the
  // selected uid changes, giving zustand a real diff to react to.
  const node = useWorkspaceStore((s) => s.selectedNode());
  const currentTree = useWorkspaceStore((s) => s.currentTree());
  const framePath = useWorkspaceStore((s) => s.framePath);
  const nodeOps = useNodeOps();

  // FIX-W4b-1 Part A (frame/board selection): a Layers-panel board row (or a
  // canvas frame click) calls `selectFrame`, which sets `selectedUid:null` —
  // so `node` is null while a BOARD is focused. Its root `TreeNode`
  // (`currentTree()`) IS the board's root element: real, uid-addressable, and
  // writable via the existing `set-classes` op — so we inspect THAT as the
  // frame node (see `FrameInspector`) instead of the old empty state.
  const frameRootNode = !node && framePath ? currentTree : null;

  // FIX-W4b-1 Part B: fetch the active node's (or board root's) REAL computed
  // CSS via the existing FP-INS-b bridge round-trip — hook is called
  // unconditionally (before any early return) per the Rules of Hooks;
  // `useComputedStyle` no-ops safely for an `undefined` uid.
  const activeUid = node?.uid ?? frameRootNode?.uid;
  const computed = buildComputedLookup(useComputedStyle(activeUid, canvasHandle, bridgeGeneration));

  if (!node) {
    if (frameRootNode && framePath) {
      return <FrameInspector node={frameRootNode} framePath={framePath} computed={computed} />;
    }
    return (
      <Panel title="Design" id="inspector">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            paddingBlock: 'var(--ccs-space-4)',
            textAlign: 'center',
          }}
        >
          <Icon name="move" size={32} style={{ color: 'var(--ccs-text-subtle)' }} />
          <p style={{ color: 'var(--ccs-text-subtle)', fontSize: 'var(--ccs-font-size-sm)', margin: 0 }}>
            Select a layer to inspect it.
          </p>
        </div>
      </Panel>
    );
  }

  const readOnly = node.dynamic;
  // Item 7d: a component instance gets ONLY its identity (no opacity) +
  // props + code — see this file's module doc for the full rationale. Every
  // other gate below (`canHoldText`/`canBeContainer`/`hasParent`) is now
  // irrelevant for an instance since the render below short-circuits past
  // them entirely, but they're left un-narrowed (still computed from
  // `node.kind` alone) since they're equally used by the non-instance branch.
  const isInstance = node.kind === 'component-instance';
  const canHoldText = node.kind === 'element' || node.kind === 'text';
  // Layout-container: `rect.cljs`/`frame.cljs` render `layout-container-menu*`
  // unconditionally, and `text.cljs` does too (real Penpot lets a text shape
  // become a flex/grid container) — so this gate is "any node with a real DOM
  // element to apply `display` to", i.e. everything except a `fragment`
  // (no single element to attach the class to) — matching that unconditional
  // real-source behavior rather than the previous, narrower `element`-only
  // gate. Penpot additionally offers an explicit "+ Add flex layout"
  // shape-menu action for shapes that AREN'T yet containers (confirmed via
  // `layout_container.cljs`'s "workspace.shape.menu.add-layout" string), so
  // this section is a "configure/add layout" affordance, not gated on
  // already-being one (this Inspector has no live read of the node's current
  // `display`, see `inspector-class-hints.ts`'s module doc).
  const canBeContainer = node.kind === 'element' || node.kind === 'text';
  // Layout-item: shown whenever the node has an addressable parent (i.e.
  // isn't the tree root) — real Penpot gates this on "is a flex/grid CHILD",
  // which likewise isn't live-readable here (same disclosed gap).
  const hasParent = currentTree ? findParent(currentTree, node.uid) !== null : false;
  // FIX-W4b-1 Part A section-subset forks (see this file's module doc for the
  // per-kind Penpot citation). `isFragment` -> group-level subset
  // (`group.cljs`); `textFocused` -> lean text subset (`text.cljs`); neither
  // -> the full generic-element stack (`rect.cljs`, unchanged).
  const isFragment = node.kind === 'fragment';
  const textFocused = isTextFocused(node);

  // Every class-hint-backed section below is keyed `<section-id>-${node.uid}`:
  // React's documented "adjust state when a prop changes" escape hatch is to
  // key the component so it remounts (fresh `useState` lazy-initializer)
  // rather than reset-via-`useEffect` (which `eslint-plugin-react-hooks`'s
  // `set-state-in-effect` rule — active in this repo — flags as a
  // cascading-render smell). A remount here is cheap (a few form controls)
  // and correct: switching selection SHOULD present that node's own hint
  // state, never a stale value left over from the previous one.
  //
  // BUG FOUND VIA THIS PHASE'S OWN PLAYWRIGHT ACCEPTANCE RUN (fixed here): an
  // earlier version keyed every section with the SAME bare `node.uid` — since
  // React requires keys to be unique only among a node's own CHILDREN, not
  // globally, but several of these sections are each other's SIBLINGS here
  // (direct children of this one `<>` fragment), sharing one key across
  // multiple siblings broke React's reconciliation: the moment the daemon's
  // post-edit `tree-snapshot` broadcast produced a new (same-uid, new
  // object-identity) `node` and this component re-rendered, React duplicated
  // a whole contiguous run of the ambiguously-keyed siblings in the live DOM
  // (confirmed empirically: selecting the Hero `<h1>` and changing its
  // Typography size left TWO `[data-panel="inspector-typography"]` sections
  // mounted, plus a duplicated `Content`/`Size & position`/`Layout
  // container`/`Layout item`/`Fill`/`Border & radius`/`Shadow` run — every
  // OTHER keyed section between `Content` and `Shadow`, i.e. exactly the set
  // sharing the collided key). Fixed by making each section's key include
  // its own stable id, so it's unique among its siblings again.
  return (
    <ComputedStyleContext.Provider value={computed}>
      <LayerSection node={node} showOpacity={!isInstance} readOnly={readOnly} />
      {readOnly && <DynamicBanner node={node} nodeOps={nodeOps} />}
      {isInstance ? (
        // Item 7d (FIX-W4, PRESERVED): ONLY the props panel — every CSS
        // section is suppressed entirely (not just disabled) for a component
        // instance.
        <ComponentPropsSection key={`component-props-${node.uid}`} node={node} readOnly={readOnly} />
      ) : isFragment ? (
        // fragment/group (`options/shapes/group.cljs`) — group-level only:
        // Size&position + Layout item. No Fill/Stroke/Shadow/Typography (a
        // `<>` fragment has no single element to style; ast-engine refuses
        // set-classes/set-prop on it).
        <>
          <SizePositionSection key={`size-position-${node.uid}`} node={node} readOnly={readOnly} />
          {hasParent && <LayoutItemSection key={`layout-item-${node.uid}`} node={node} readOnly={readOnly} />}
        </>
      ) : textFocused ? (
        // text-focused (`options/shapes/text.cljs`) — lean text subset:
        // Content + Size&position + Typography + Fill + Stroke + Shadow. NO
        // Layout-container/-item (kept text-focused per this task's brief).
        <>
          <ContentSection key={`content-${node.uid}`} node={node} readOnly={readOnly} />
          <SizePositionSection key={`size-position-${node.uid}`} node={node} readOnly={readOnly} />
          <TypographySection key={`typography-${node.uid}`} node={node} readOnly={readOnly} />
          <FillSection key={`fill-${node.uid}`} node={node} readOnly={readOnly} />
          <StrokeSection key={`stroke-${node.uid}`} node={node} readOnly={readOnly} />
          <ShadowSection key={`shadow-${node.uid}`} node={node} readOnly={readOnly} />
        </>
      ) : (
        // generic element (`options/shapes/rect.cljs`) — the full FIX-W4
        // stack, UNCHANGED.
        <>
          {canHoldText && <ContentSection key={`content-${node.uid}`} node={node} readOnly={readOnly} />}
          <SizePositionSection key={`size-position-${node.uid}`} node={node} readOnly={readOnly} />
          {canBeContainer && (
            <LayoutContainerSection key={`layout-container-${node.uid}`} node={node} readOnly={readOnly} />
          )}
          {hasParent && <LayoutItemSection key={`layout-item-${node.uid}`} node={node} readOnly={readOnly} />}
          {canHoldText && <TypographySection key={`typography-${node.uid}`} node={node} readOnly={readOnly} />}
          <FillSection key={`fill-${node.uid}`} node={node} readOnly={readOnly} />
          <StrokeSection key={`stroke-${node.uid}`} node={node} readOnly={readOnly} />
          <ShadowSection key={`shadow-${node.uid}`} node={node} readOnly={readOnly} />
        </>
      )}
      <CodeSection node={node} nodeOps={nodeOps} />
    </ComputedStyleContext.Provider>
  );
}

/** FIX-W4b-1 Part A — the FRAME/board inspector (`options/shapes/frame.cljs`
 * subset: `layer-menu*` + `measures-menu*` + `layout-container-menu*` +
 * `fill-menu*`, plus this tool's own `Code` affordance). Shown when a board
 * is selected (`selectedUid:null`) instead of the former empty state — it
 * inspects the board's ROOT `TreeNode`, which is a real, uid-addressable
 * element (writable via `set-classes`). Dropped vs. `frame.cljs`:
 * `component-menu*`/`constraints`/`color-selection`/`stroke`/`shadow`/`blur`/
 * `frame-grid`/`exports` (out of this task's DOM-first scope, same drops the
 * element stack's module doc lists). A frame root can occasionally itself be
 * a JSX fragment (default export returns `<>…</>`); its geometry/fill
 * controls will then no-op via an `op-rejected` (ast-engine refuses fragment
 * attribute writes) — an acceptable edge, most frames root in a real element. */
function FrameInspector({
  node,
  framePath,
  computed,
}: {
  node: TreeNode;
  framePath: string;
  computed: ComputedLookup | null;
}): React.ReactElement {
  const nodeOps = useNodeOps();
  const readOnly = node.dynamic;
  return (
    <ComputedStyleContext.Provider value={computed}>
      <FrameContextBanner framePath={framePath} />
      <LayerSection node={node} showOpacity readOnly={readOnly} />
      <SizePositionSection key={`size-position-${node.uid}`} node={node} readOnly={readOnly} />
      <LayoutContainerSection key={`layout-container-${node.uid}`} node={node} readOnly={readOnly} />
      <FillSection key={`fill-${node.uid}`} node={node} readOnly={readOnly} />
      <CodeSection node={node} nodeOps={nodeOps} />
    </ComputedStyleContext.Provider>
  );
}

/** A small informational banner atop the frame inspector so it's visually
 * unambiguous that a BOARD (not a leaf element) is selected and these are
 * frame-LEVEL controls (Penpot's own frame options are headed by the board's
 * own layer row; this is the closest lean equivalent). */
function FrameContextBanner({ framePath }: { framePath: string }): React.ReactElement {
  const name = framePath.split(/[\\/]/).pop() ?? framePath;
  return (
    <div
      data-testid="frame-context-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: 'var(--ccs-space-3)',
        borderBlockEnd: '1px solid var(--ccs-border)',
        background: 'var(--ccs-bg-subtle, var(--ccs-bg-panel))',
      }}
    >
      <Icon name="board" size={16} style={{ color: 'var(--ccs-accent)', flexShrink: 0 }} />
      <span style={{ fontSize: 'var(--ccs-font-size-sm)', fontWeight: 600, color: 'var(--ccs-text)' }}>
        Board — frame-level controls
      </span>
      <span
        style={{
          fontSize: 'var(--ccs-font-size-xs)',
          color: 'var(--ccs-text-subtle)',
          fontFamily: 'var(--ccs-font-mono)',
          marginInlineStart: 'auto',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={framePath}
      >
        {name}
      </span>
    </div>
  );
}

/** FIX-W4b-1 Part B — renders the selected element's REAL current value for
 * one CSS property under a control. Reads the shared `ComputedStyleContext`
 * (populated from the existing FP-INS-b bridge round-trip). Shows an honest
 * "loading…"/"not set" rather than any fabricated token — the resolution +
 * honesty rules live in `inspector-computed-values.ts`. */
function CurrentValueLine({ cssProp, group }: { cssProp: string; group?: ClassPresetGroup }): React.ReactElement {
  const computed = React.useContext(ComputedStyleContext);
  const value = resolveCurrentValue(computed, cssProp, group);
  return (
    <span
      data-testid={`inspector-current-${cssProp}`}
      style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}
    >
      {formatCurrentValue(value)}
    </span>
  );
}

/** Mirrors `LayersPanel`'s `iconForNode` (kept as a small local duplicate —
 * this file is scoped to `Inspector.tsx` only, no shared-helper extraction). */
function iconForNode(node: TreeNode): IconName {
  if (node.kind === 'component-instance') return 'component';
  if (node.kind === 'text') return 'text';
  if (node.kind === 'fragment') return 'group';
  if (node.tag === 'img') return 'img';
  if (node.tag === 'svg' || node.tag === 'path') return 'path';
  return 'group';
}

/** Layer — read-only identity block (name/tag + uid + a type icon), Penpot's
 * `layer.cljs` section adapted: no vector geometry, just AST identity. Its
 * own Panel header carries no separate static icon — the body's per-node
 * `iconForNode` icon IS the section's icon here, matching how Penpot's own
 * layer row icon is always the shape-type icon, never a generic glyph.
 *
 * `showOpacity` (false for a component instance, item 7d): `layer.cljs`
 * itself owns the opacity/blend-mode control (see this file's module doc),
 * so it's rendered here, in `Layer`, rather than a separate bottom-of-stack
 * Panel — but suppressed for an instance since opacity is a CSS override
 * this tool can't safely apply to a component's internals either. */
function LayerSection({
  node,
  showOpacity,
  readOnly,
}: {
  node: TreeNode;
  showOpacity: boolean;
  readOnly: boolean;
}): React.ReactElement {
  const label = node.component ?? node.tag ?? '(text)';
  const color = node.kind === 'component-instance' ? 'var(--ccs-accent-component)' : 'var(--ccs-text)';

  return (
    <Panel title="Layer" id="inspector-layer">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minInlineSize: 0 }}>
          <Icon name={iconForNode(node)} size={16} style={{ color, flexShrink: 0 }} />
          <span
            style={{
              fontSize: 'var(--ccs-font-size-sm)',
              fontWeight: 500,
              color,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
        </div>
        <span
          style={{
            fontSize: 'var(--ccs-font-size-xs)',
            color: 'var(--ccs-text-subtle)',
            fontFamily: 'var(--ccs-font-mono)',
            wordBreak: 'break-all',
          }}
        >
          {node.uid}
        </span>
        {showOpacity && (
          <GroupSelect node={node} group={OPACITY_GROUP} label="Opacity" fallback="100" readOnly={readOnly} cssProp="opacity" />
        )}
      </div>
    </Panel>
  );
}

/** Standalone (non-`Panel`) banner shown above the section stack for a
 * `dynamic` node — same message/affordance the prior pass showed instead of
 * the whole stack, kept verbatim, just relocated now that the sections
 * beneath it also render (disabled) rather than being suppressed. */
function DynamicBanner({ node, nodeOps }: { node: TreeNode; nodeOps: NodeOps }): React.ReactElement {
  return (
    <div
      data-testid="dynamic-readonly"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 'var(--ccs-space-3)',
        borderBlockEnd: '1px solid var(--ccs-border)',
        background: 'var(--ccs-warning-bg)',
      }}
    >
      <p style={{ fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-muted)', margin: 0 }}>
        <strong style={{ color: 'var(--ccs-locked)' }}>Dynamic node</strong> — generated in code
        (<code>.map()</code>/conditional). Every section below shows its values read-only; edit its logic
        in the source file.
      </p>
      <Button variant="secondary" size="sm" onClick={() => nodeOps.openInIde(node)}>
        Open in IDE
      </Button>
    </div>
  );
}

/** Code — Penpot's Inspect/dev-mode affordance, adapted: any node (not just
 * `dynamic`) can jump to its real source location. */
function CodeSection({ node, nodeOps }: { node: TreeNode; nodeOps: NodeOps }): React.ReactElement {
  return (
    <Panel title="Code" id="inspector-code" icon="document" defaultCollapsed>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <dl style={{ margin: 0, fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>
          <dt>uid</dt>
          <dd style={{ marginInlineStart: 0, fontFamily: 'var(--ccs-font-mono)', wordBreak: 'break-all' }}>
            {node.uid}
          </dd>
        </dl>
        <Button variant="secondary" size="sm" onClick={() => nodeOps.openInIde(node)}>
          Open in IDE
        </Button>
      </div>
    </Panel>
  );
}

function ContentSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const [text, setText] = React.useState('');

  return (
    <Panel title="Content" id="inspector-content" icon="text">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (readOnly) return;
          sendOp({ t: 'set-text', uid: node.uid, text });
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <Input
          label="Text"
          value={text}
          disabled={readOnly}
          onChange={(e) => setText(e.target.value)}
          placeholder={`New text for <${node.tag ?? 'node'}>`}
        />
        <Button type="submit" variant="primary" size="sm" disabled={readOnly}>
          Apply
        </Button>
      </form>
    </Panel>
  );
}

// --- shared row-level control helpers ---------------------------------

function optionsFor(group: ClassPresetGroup): SelectOption[] {
  return group.presets.map((p) => ({ value: p.value, label: p.label }));
}

/** A labeled `<Select>` bound to a `ClassPresetGroup`: reads the session
 * hint (see `inspector-class-hints.ts`), falls back to `fallback`, and on
 * change writes BOTH the hint cache and the real `set-classes` op. Every
 * group-backed dropdown in this file goes through this one helper so the
 * hint-read/hint-write/sendOp wiring is written exactly once. */
function GroupSelect({
  node,
  group,
  label,
  fallback,
  readOnly,
  onEdit,
  cssProp,
}: {
  node: TreeNode;
  group: ClassPresetGroup;
  label: string;
  fallback: string;
  readOnly: boolean;
  /** Overrides the plain `resolveClassEdit(group, value)` when the section
   * needs to merge in extra remove-candidates (e.g. `Position`'s
   * `relative`/`fixed`/`sticky`). */
  onEdit?: (value: string) => ClassEdit;
  /** FIX-W4b-1 Part B: the curated computed-style property this control maps
   * to (`@ccs/bridge`'s `computed-style.ts` list). When set, a
   * `CurrentValueLine` renders under the control showing the element's REAL
   * value. Omitted for controls with no curated computed property (padding,
   * flex-grow, align-self, order, border-width) — those get no readout rather
   * than a misleading one. */
  cssProp?: string;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Lazy initializer only — the section this control lives in is always
  // rendered with a unique `key` (`<section-id>-${node.uid}`) by `Inspector`
  // (see its own doc), so a selection change remounts this component fresh
  // rather than needing a
  // reset-effect (which `react-hooks/set-state-in-effect` — active in this
  // repo's eslint config — flags as a cascading-render smell).
  const [value, setValue] = React.useState(() => getClassHint(node.uid, group.key) ?? fallback);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Select
        label={label}
        value={value}
        disabled={readOnly}
        options={optionsFor(group)}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (readOnly) return;
          const edit = onEdit ? onEdit(next) : resolveClassEdit(group, next);
          setClassHint(node.uid, group.key, next);
          sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
        }}
      />
      {cssProp && <CurrentValueLine cssProp={cssProp} group={group} />}
    </div>
  );
}

/** A row of segmented `Button`s bound to a `ClassPresetGroup` — Penpot's
 * `radio-buttons` icon-toggle pattern (`layout_container.cljs`'s direction/
 * align/justify rows), reproduced with the existing `Button` primitive's
 * `active` state rather than a new primitive. */
function GroupButtons({
  node,
  group,
  label,
  fallback,
  readOnly,
  cssProp,
}: {
  node: TreeNode;
  group: ClassPresetGroup;
  label: string;
  fallback: string;
  readOnly: boolean;
  /** See `GroupSelect`'s `cssProp` — same FIX-W4b-1 Part B real-value
   * readout, for the segmented-button controls. */
  cssProp?: string;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Lazy initializer only — see `GroupSelect`'s matching comment: the
  // enclosing section is always uniquely `key`-ed by `Inspector`.
  const [value, setValue] = React.useState(() => getClassHint(node.uid, group.key) ?? fallback);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-muted)' }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {group.presets.map((preset) => (
          <Button
            key={preset.value}
            type="button"
            size="sm"
            variant="secondary"
            active={value === preset.value}
            disabled={readOnly}
            onClick={() => {
              setValue(preset.value);
              if (readOnly) return;
              const edit = resolveClassEdit(group, preset.value);
              setClassHint(node.uid, group.key, preset.value);
              sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      {cssProp && <CurrentValueLine cssProp={cssProp} group={group} />}
    </div>
  );
}

/** A numeric px `Input` for an arbitrary-value class (`w-[Npx]`,
 * `start-[Npx]`, ...) — the open-ended counterpart to `GroupSelect`/
 * `GroupButtons` for controls with no fixed enum. */
function ArbitraryPxInput({
  node,
  hintKey,
  label,
  buildEdit,
}: {
  node: TreeNode;
  hintKey: string;
  label: string;
  readOnly: boolean;
  buildEdit: (px: number, previous: string | null) => ClassEdit;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const [text, setText] = React.useState('');

  return (
    <Input
      label={label}
      type="number"
      placeholder="px"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const px = Number(text);
        if (!Number.isFinite(px)) return;
        const previous = getClassHint(node.uid, hintKey) ?? null;
        const edit = buildEdit(px, previous);
        const written = edit.add[0];
        if (written) setClassHint(node.uid, hintKey, written);
        sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
      }}
    />
  );
}

// --- Size & position (measures.cljs, radius included — see module doc) --

function SizePositionSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Lazy initializer only — this section is always uniquely `key`-ed by
  // `Inspector` (see its own doc), same reasoning as `GroupSelect`.
  const [position, setPosition] = React.useState(() => getClassHint(node.uid, POSITION_GROUP.key) ?? 'static');

  return (
    <Panel title="Size & position" id="inspector-size-position" icon="expand">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={WIDTH_GROUP} label="Width" fallback="auto" readOnly={readOnly} cssProp="width" />
          </div>
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="size-w-custom"
              label="Custom W"
              readOnly={readOnly}
              buildEdit={(px, previous) => arbitrarySizeEdit('w', px, previous)}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={HEIGHT_GROUP} label="Height" fallback="auto" readOnly={readOnly} cssProp="height" />
          </div>
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="size-h-custom"
              label="Custom H"
              readOnly={readOnly}
              buildEdit={(px, previous) => arbitrarySizeEdit('h', px, previous)}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Select
            label="Position"
            value={position}
            disabled={readOnly}
            options={optionsFor(POSITION_GROUP)}
            onChange={(e) => {
              const next = e.target.value;
              setPosition(next);
              if (readOnly) return;
              const edit = resolveClassEdit(POSITION_GROUP, next);
              edit.remove = [...edit.remove, ...POSITION_REMOVE_EXTRA];
              setClassHint(node.uid, POSITION_GROUP.key, next);
              sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
            }}
          />
          <CurrentValueLine cssProp="position" group={POSITION_GROUP} />
        </div>
        {position === 'absolute' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <ArbitraryPxInput
                node={node}
                hintKey="inset-start"
                label="X (start)"
                readOnly={readOnly}
                buildEdit={(px, previous) => arbitraryInsetEdit('start', px, previous)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <ArbitraryPxInput
                node={node}
                hintKey="inset-top"
                label="Y (top)"
                readOnly={readOnly}
                buildEdit={(px, previous) => arbitraryInsetEdit('top', px, previous)}
              />
            </div>
          </div>
        )}
        {/* Radius (`border_radius.cljs`'s `border-radius-menu*`, embedded
         * directly inside `measures-menu*` in real Penpot — see this file's
         * module doc for the citation — hence living here, not in the old
         * "Border & radius" Panel (now just `Stroke`, below). */}
        <GroupSelect node={node} group={RADIUS_GROUP} label="Radius" fallback="none" readOnly={readOnly} cssProp="border-radius" />
      </div>
    </Panel>
  );
}

// --- Layout container (layout_container.cljs) ---------------------------

function LayoutContainerSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  return (
    <Panel title="Layout container" id="inspector-layout-container" icon="board">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupButtons node={node} group={DIRECTION_GROUP} label="Direction" fallback="row" readOnly={readOnly} cssProp="flex-direction" />
        <GroupButtons node={node} group={WRAP_GROUP} label="Wrap" fallback="nowrap" readOnly={readOnly} cssProp="flex-wrap" />
        <GroupSelect node={node} group={JUSTIFY_GROUP} label="Justify" fallback="start" readOnly={readOnly} cssProp="justify-content" />
        <GroupSelect
          node={node}
          group={ALIGN_ITEMS_GROUP}
          label="Align items"
          fallback="stretch"
          readOnly={readOnly}
          cssProp="align-items"
        />
        <GroupSelect node={node} group={GAP_GROUP} label="Gap" fallback="0" readOnly={readOnly} cssProp="gap" />
        <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>Padding</span>
        <GroupSelect node={node} group={PADDING_GROUP} label="All sides" fallback="0" readOnly={readOnly} />
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={PADDING_START_GROUP} label="Start" fallback="0" readOnly={readOnly} />
          </div>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={PADDING_END_GROUP} label="End" fallback="0" readOnly={readOnly} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={PADDING_TOP_GROUP} label="Top" fallback="0" readOnly={readOnly} />
          </div>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={PADDING_BOTTOM_GROUP} label="Bottom" fallback="0" readOnly={readOnly} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

// --- Layout item (layout_item.cljs) --------------------------------------

function LayoutItemSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  return (
    <Panel title="Layout item" id="inspector-layout-item" icon="arrow">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupSelect node={node} group={GROW_GROUP} label="Flex" fallback="none" readOnly={readOnly} />
        <GroupButtons
          node={node}
          group={SELF_ALIGN_GROUP}
          label="Align self"
          fallback="auto"
          readOnly={readOnly}
        />
        <GroupSelect node={node} group={ORDER_GROUP} label="Order" fallback="none" readOnly={readOnly} />
      </div>
    </Panel>
  );
}

// --- Typography (typography.cljs) ----------------------------------------

function TypographySection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const textColorGroup = React.useMemo(() => colorGroup('text'), []);
  return (
    <Panel title="Typography" id="inspector-typography" icon="text-typography">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={TEXT_SIZE_GROUP} label="Size" fallback="base" readOnly={readOnly} cssProp="font-size" />
          </div>
          <div style={{ flex: 1 }}>
            <GroupSelect
              node={node}
              group={FONT_WEIGHT_GROUP}
              label="Weight"
              fallback="normal"
              readOnly={readOnly}
              cssProp="font-weight"
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect
              node={node}
              group={LEADING_GROUP}
              label="Line height"
              fallback="normal"
              readOnly={readOnly}
              cssProp="line-height"
            />
          </div>
          <div style={{ flex: 1 }}>
            <GroupSelect
              node={node}
              group={TRACKING_GROUP}
              label="Letter spacing"
              fallback="normal"
              readOnly={readOnly}
              cssProp="letter-spacing"
            />
          </div>
        </div>
        <GroupButtons node={node} group={TEXT_ALIGN_GROUP} label="Align" fallback="start" readOnly={readOnly} cssProp="text-align" />
        <GroupSelect node={node} group={textColorGroup} label="Color" fallback="none" readOnly={readOnly} cssProp="color" />
      </div>
    </Panel>
  );
}

// --- Fill (fill.cljs) — background color + the existing token-bind ------

function FillSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const engine = useEngineApi();
  const [tokenName, setTokenName] = React.useState('');
  const tokens = engine.tokensForProperty('background-color');
  const bgColorGroup = React.useMemo(() => colorGroup('bg'), []);

  return (
    <Panel title="Fill" id="inspector-fill" icon="swatches">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <GroupSelect node={node} group={bgColorGroup} label="Background" fallback="none" readOnly={readOnly} cssProp="background-color" />
        <Select
          label="Bind token"
          value={tokenName}
          disabled={readOnly}
          onChange={(e) => setTokenName(e.target.value)}
          options={[{ value: '', label: 'Choose a token…' }, ...tokens.map((t) => ({ value: t.name, label: t.name }))]}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!tokenName || readOnly}
          onClick={() => {
            // CR (mock-adapter wire shape, see engine-api.ts's module doc):
            // the real token->class/var mapping is P4 scope (ADR-0019
            // decision 6: `{token}` set-prop is P3-"unsupported" until
            // then). This proves the CLIENT emits the correct op shape;
            // the daemon may legitimately answer `op-rejected`.
            sendOp({ t: 'set-prop', uid: node.uid, name: 'data-token-fill', value: { token: tokenName } });
          }}
        >
          Bind
        </Button>
      </div>
    </Panel>
  );
}

// --- Stroke (stroke.cljs) — border width/color; radius lives in
// Size & position now, matching real Penpot's `measures.cljs` embedding
// (see this file's module doc) -----------------------------------------

function StrokeSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const borderColorGroup = React.useMemo(() => colorGroup('border'), []);
  // Lazy initializer only — this section is always uniquely `key`-ed by
  // `Inspector` (see its own doc), same reasoning as `GroupSelect`.
  const [hasBorder, setHasBorder] = React.useState(() => getClassHint(node.uid, 'border-enabled') === 'on');

  return (
    <Panel title="Stroke" id="inspector-stroke">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Checkbox
          label="Border"
          checked={hasBorder}
          disabled={readOnly}
          onChange={(e) => {
            const checked = e.target.checked;
            setHasBorder(checked);
            if (readOnly) return;
            setClassHint(node.uid, 'border-enabled', checked ? 'on' : 'off');
            if (checked) {
              sendOp({ t: 'set-classes', uid: node.uid, add: ['border'], remove: [] });
            } else {
              const widthClasses = BORDER_WIDTH_GROUP.presets.flatMap((p) => p.add);
              sendOp({ t: 'set-classes', uid: node.uid, add: [], remove: widthClasses });
            }
          }}
        />
        {hasBorder && (
          <>
            <GroupSelect node={node} group={BORDER_WIDTH_GROUP} label="Width" fallback="1" readOnly={readOnly} />
            <GroupSelect
              node={node}
              group={borderColorGroup}
              label="Color"
              fallback="none"
              readOnly={readOnly}
              cssProp="border-color"
            />
          </>
        )}
      </div>
    </Panel>
  );
}

// --- Shadow (shadow.cljs) --------------------------------------------------

function ShadowSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  return (
    <Panel title="Shadow" id="inspector-shadow">
      <GroupSelect node={node} group={SHADOW_GROUP} label="Shadow" fallback="none" readOnly={readOnly} cssProp="box-shadow" />
    </Panel>
  );
}

// --- Component props (component.cljs) — "just a list of its props" ------

function controlFor(
  propName: string,
  entry: PropSchemaEntry,
  value: unknown,
  readOnly: boolean,
  onChange: (v: string | number | boolean) => void,
): React.ReactElement {
  if (entry.control === 'select' && entry.enum) {
    return (
      <Select
        key={propName}
        label={propName}
        value={String(value ?? entry.default ?? '')}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        options={entry.enum.map((v) => ({ value: v, label: v }))}
      />
    );
  }
  if (entry.control === 'checkbox') {
    return (
      <Checkbox
        key={propName}
        label={propName}
        checked={Boolean(value ?? entry.default ?? false)}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (entry.control === 'number') {
    return (
      <Input
        key={propName}
        label={propName}
        type="number"
        disabled={readOnly}
        defaultValue={String(value ?? entry.default ?? '')}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    );
  }
  return (
    <Input
      key={propName}
      label={propName}
      disabled={readOnly}
      defaultValue={String(value ?? entry.default ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ComponentPropsSection({
  node,
  readOnly,
}: {
  node: TreeNode;
  readOnly: boolean;
}): React.ReactElement | null {
  const { sendOp } = useDaemonConnection();
  const engine = useEngineApi();
  const componentName = (node.component ?? '').replace(/^ds:/, '');
  const schema = engine.getPropSchema(componentName);
  if (!schema) return null;

  const entries = Object.entries(schema.props);

  return (
    <Panel title={`${componentName} props`} id="inspector-component-props" icon="component">
      {/* A clean, ordered LIST of the instance's props (the human's own
       * ask — see this task's module doc): one row per prop, its name as
       * the row label, required props flagged, divided like Penpot's own
       * dense `component.cljs` rows rather than a free-form form. */}
      <ul
        data-testid="component-props-list"
        style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}
      >
        {entries.map(([propName, entry]) => (
          <li
            key={propName}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingBlockEnd: 8,
              borderBlockEnd: '1px solid var(--ccs-border)',
            }}
          >
            {controlFor(propName, entry, undefined, readOnly, (value) => {
              sendOp({ t: 'set-prop', uid: node.uid, name: propName, value });
            })}
            <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>
              {entry.type}
              {entry.required ? ' · required' : ''}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
