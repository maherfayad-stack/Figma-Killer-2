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
  arbitraryRadiusEdit,
  arbitraryRotateEdit,
  arbitrarySizeEdit,
  BORDER_WIDTH_GROUP,
  type ClassEdit,
  type ClassPresetGroup,
  colorGroup,
  DEVICE_PRESETS,
  DEVICE_QUICK_PRESETS,
  type DevicePreset,
  DIRECTION_GROUP,
  FONT_WEIGHT_GROUP,
  GAP_GROUP,
  GROW_GROUP,
  hexForColorValue,
  JUSTIFY_GROUP,
  LEADING_GROUP,
  OPACITY_GROUP,
  ORDER_GROUP,
  PADDING_BOTTOM_GROUP,
  PADDING_END_GROUP,
  PADDING_GROUP,
  PADDING_START_GROUP,
  PADDING_TOP_GROUP,
  parseArbitraryValue,
  POSITION_GROUP,
  POSITION_REMOVE_EXTRA,
  resolveClassEdit,
  SELF_ALIGN_GROUP,
  SHADOW_GROUP,
  TEXT_ALIGN_GROUP,
  TEXT_SIZE_GROUP,
  TRACKING_GROUP,
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
 * `interactions.cljs`, `exports.cljs`. `measures.cljs`'s rotation field —
 * previously dropped here too ("no vector rotation on a DOM element in this
 * tool") — is REINSTATED by FIX-W4b-3a: a DOM element's `transform:
 * rotate()` is a real, settable CSS property, so the earlier drop was
 * overly conservative; see `SizePositionSection`'s own doc.
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
 * ## Icons (FIX-W4b-2 rework — see that workstream's own report for the full
 * before/after)
 * `@ccs/ui`'s vendored Penpot icon set (`packages/ui/src/icons/registry.ts`)
 * grew from ~30 to ~74 genuine Penpot SVGs this pass (still copied verbatim
 * from `../penpot/frontend/resources/images/icons/*.svg`, MPL-2.0, see
 * `packages/ui/src/icons/NOTICE`). Two corrections from FIX-W4's assumption
 * that every Penpot options-menu section carries a leading header icon —
 * re-reading the real source (`app.main.ui.components.title-bar`'s
 * `title-bar*`) shows it does NOT: the ONLY icon its collapsible header ever
 * renders is the disclosure chevron itself (`arrow-right`/`arrow-down`,
 * swapped by `collapsed` state — `packages/ui/src/primitives/Panel.tsx` now
 * reproduces that exactly, replacing its prior hardcoded "▾" text glyph).
 * So: (a) `Panel`'s optional `icon` prop is now used ONLY where a genuine
 * Penpot glyph exists for that section's own header slot (`Fill`=`swatches`,
 * `Typography`=`text-typography`, `Stroke`=`stroke-size`, `Shadow`=
 * `drop-shadow` — all real Penpot artwork correctly depicting that section's
 * CONCEPT, even where upstream itself renders them in a different chrome
 * location, e.g. the Assets-panel group header rather than this title-bar;
 * disclosed, not silently invented); (b) FIX-W4's `expand`/`board`/`arrow`
 * header icons on `Size & position`/`Layout container`/`Layout item` are
 * DROPPED (no genuine Penpot equivalent — `board` and `arrow` were the
 * "closest existing glyph" this file's own prior doc admitted to; per this
 * file's own honesty policy for `Stroke`/`Shadow`, applied consistently:
 * no icon beats a wrong one), except `Layout container` which gets
 * `flex` (Penpot's own flex/grid-layout glyph — a real conceptual match this
 * pass newly vendored). `Layer`'s icon is still the node's own type icon
 * (`iconForNode`, shown in its body, matching how Penpot's layer row icon IS
 * the shape-type icon — no separate generic glyph). The CONTROL-level icons
 * (flex-direction/align/justify/align-self/text-align icon-button groups,
 * W/H/X/Y/radius leading glyphs, fill/stroke/typography color swatches) are
 * where the bulk of this pass's genuine Penpot iconography now lives — see
 * `GroupButtons`, `ArbitraryPxInput`, and `GroupSelect`'s `swatchHex` prop
 * below, each cited against its real Penpot source file.
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
 *
 * ## FIX-W4b-3a — Size & position: direct numeric fields + frame geometry +
 * device presets
 * Reworks `Size & position` alone (LAYOUT/COLOR untouched, per this
 * workstream's own brief) against `measures.cljs`/`measures.scss`:
 *  - **W/H/X/Y/Radius/Rotation are now direct numeric `<input>`s**, not the
 *    old Auto/Custom two-step `<Select>` + arbitrary-input pair (W/H/radius)
 *    or a class-only, unseeded pair (X/Y) — matching Penpot's own plain
 *    editable-number fields. Every one is SEEDED from the real computed
 *    value (item 4's honesty ask, extending FIX-W4b-1 Part B to this
 *    section specifically) via `ArbitraryPxInput`'s "uncontrolled until
 *    touched" pattern (see that function's own doc for why this isn't a
 *    `useEffect` reset). Rotation is NEW (see the module doc's "dropped"
 *    list above for why the old drop was reversed) and has NO curated
 *    computed source (`@ccs/bridge`'s `GEOMETRY_PROPS` has no `transform`
 *    entry — a disclosed, out-of-scope-for-this-pass gap, flagged in the
 *    worker report rather than silently adding a bridge prop), so it always
 *    shows an honest "Current: not tracked" instead of a fabricated readout.
 *  - **X/Y are ALWAYS rendered now** (previously hidden entirely unless
 *    already `absolute`) — disabled + honestly seeded (never a silent no-op
 *    write) when the node is in-flow `static`, editable once `absolute`,
 *    per this task's own "disabled + honest value beats a no-op" directive.
 *    Written as Tailwind's LOGICAL `start-[Npx]`/physical `top-[Npx]`
 *    (unchanged RTL convention, see `inspector-presets.ts`'s module doc) —
 *    NOTE the seed itself reads the CURATED `left`/`top` computed props
 *    (physical; `@ccs/bridge` has no logical-inset curated prop), a
 *    disclosed mismatch for an RTL document (the shown seed can read
 *    mirrored vs. the logical class actually written) carried forward from
 *    FIX-W4b-1's own bridge curation, not new to this pass.
 *  - **Radius** keeps `RADIUS_GROUP`'s named presets ONLY as `arbitrary
 *    RadiusEdit`'s remove-candidate list (so entering a number still evicts
 *    a stale `rounded-lg`, etc.) — the control itself is now Penpot's own
 *    free-numeric field. Penpot's INDEPENDENT-CORNERS toggle
 *    (`border_radius.cljs`'s per-corner mode) is CARRY-FORWARD, not built
 *    this pass — see the worker report.
 *  - **FRAME/board W/H** (item 1's other half) now genuinely WRITES the
 *    board's `.studio/canvas.json` geometry, via a NEW, ADDITIVE
 *    `StudioCanvasHandle.setFrameGeometry` method (see that method's own doc
 *    in `@ccs/canvas`'s `StudioCanvas.tsx` for the full citation + why this
 *    was flagged, not silently added, as a change outside this workstream's
 *    strict `apps/studio/src/workspace/` file scope) — reusing the EXISTING
 *    `set-geometry` daemon wire message the canvas's own drag/resize commit
 *    already sends (ADR-0013), zero `@ccs/protocol` diff, zero new
 *    control-message. `FrameSizeSection` (frame-only; the element-facing
 *    `SizePositionSection` above is UNCHANGED for this write path) is a
 *    deliberately SEPARATE component from `SizePositionSection` — a board's
 *    W/H writes through a wholly different mechanism (daemon geometry, not
 *    `set-classes`), so branching one shared component per-field would cost
 *    more clarity than the two components' modest field-list overlap saves.
 *    Frame X/Y (the board's canvas position) is OUT of this pass's scope —
 *    see the worker report's own note on why (no DOM-observable seed for it
 *    exists the way W/H's iframe-identity trick gives for free).
 *  - **Size presets + device-type quick-selects** (item 3, `FrameSizeSection`
 *    only) — `inspector-presets.ts`'s `DEVICE_PRESETS`/`DEVICE_QUICK_PRESETS`,
 *    cited verbatim against Penpot's own `app.main.constants/size-presets`
 *    catalog. NO device-type icons: Penpot's own preset list is text-only
 *    (confirmed against `measures.cljs`'s `on-preset-selected` markup, no
 *    icon element at all) — so `DEVICE_QUICK_PRESETS` render as plain
 *    labeled buttons ("Phone"/"Tablet"/"Desktop"), the same "no icon beats a
 *    wrong one" honesty policy this file's icon-lookup functions (`justify
 *    Icon`, etc.) already apply.
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
  // FIX-W4b-3a: threaded through to `FrameInspector` -> `FrameSizeSection` so
  // a board's W/H/device-preset writes can address it via
  // `StudioCanvasHandle.setFrameGeometry(fileFolder, framePath, ...)` — the
  // same `(fileFolder, framePath)` pair every other by-frame handle method
  // (`selectFrame`/`zoomToFrame`) already takes.
  const fileFolder = useWorkspaceStore((s) => s.fileFolder);
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
      return (
        <FrameInspector
          node={frameRootNode}
          framePath={framePath}
          fileFolder={fileFolder}
          canvasHandle={canvasHandle}
          computed={computed}
        />
      );
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
  fileFolder,
  canvasHandle,
  computed,
}: {
  node: TreeNode;
  framePath: string;
  fileFolder: string | null;
  canvasHandle: StudioCanvasHandle | null;
  computed: ComputedLookup | null;
}): React.ReactElement {
  const nodeOps = useNodeOps();
  const readOnly = node.dynamic;
  return (
    <ComputedStyleContext.Provider value={computed}>
      <FrameContextBanner framePath={framePath} />
      <LayerSection node={node} showOpacity readOnly={readOnly} />
      <FrameSizeSection
        key={`size-position-${node.uid}`}
        fileFolder={fileFolder}
        framePath={framePath}
        canvasHandle={canvasHandle}
        readOnly={readOnly}
      />
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
  leadingIcon,
  swatchHex,
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
  /** FIX-W4b-2: a leading glyph INSIDE the `<Select>` (Penpot's
   * `measures.cljs` numeric-input-wrapper icon, e.g. `corner-radius` for
   * Radius — this tool's Radius control is a Tailwind-preset dropdown, not
   * Penpot's free-numeric field, but still carries the same property glyph). */
  leadingIcon?: IconName | undefined;
  /** FIX-W4b-2: renders a Penpot `color_bullet`-style swatch chip + hex value
   * ABOVE the select (Fill/Stroke/Typography-color rows — see
   * `inspector-presets.ts`'s `hexForColorValue`). Only passed by
   * color-backed groups. */
  swatchHex?: (value: string) => string | undefined;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Lazy initializer only — the section this control lives in is always
  // rendered with a unique `key` (`<section-id>-${node.uid}`) by `Inspector`
  // (see its own doc), so a selection change remounts this component fresh
  // rather than needing a
  // reset-effect (which `react-hooks/set-state-in-effect` — active in this
  // repo's eslint config — flags as a cascading-render smell).
  const [value, setValue] = React.useState(() => getClassHint(node.uid, group.key) ?? fallback);
  const hex = swatchHex?.(value);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {swatchHex && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            aria-hidden
            title={hex ?? 'none'}
            style={{
              inlineSize: 18,
              blockSize: 18,
              borderRadius: 'var(--ccs-radius-sm)',
              border: '1px solid var(--ccs-border)',
              background:
                hex ??
                'repeating-conic-gradient(var(--ccs-bg-input) 0% 25%, var(--ccs-bg-panel-raised) 0% 50%) 0 0/8px 8px',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 'var(--ccs-font-size-xs)',
              color: 'var(--ccs-text-subtle)',
              fontFamily: 'var(--ccs-font-mono)',
            }}
          >
            {hex ?? 'none'}
          </span>
        </div>
      )}
      <Select
        label={label}
        value={value}
        disabled={readOnly}
        options={optionsFor(group)}
        leadingIcon={leadingIcon}
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
 * align/justify rows, `layout_item.cljs`'s align-self row, `typography.cljs`'s
 * text-align row), reproduced with the existing `Button` primitive's `active`
 * state rather than a new primitive.
 *
 * FIX-W4b-2: real Penpot renders these buttons ICON-ONLY (no visible text,
 * just a tooltip) — `get-layout-flex-icon`/`get-layout-grid-icon` in
 * `layout_container.cljs` pick the glyph. `iconFor` reproduces that: when it
 * returns an `IconName` for a preset, the button renders that icon (+
 * `title`/`aria-label` = the preset's label, for the same tooltip/a11y
 * Penpot's own `radio-button`'s `:title` gives it) instead of the text label.
 * Presets `iconFor` returns `undefined` for (no genuine Penpot glyph exists,
 * e.g. `align-items`'s `baseline`/`stretch` — Penpot's own `align-row` only
 * ever offers start/center/end) fall back to the plain text button, same
 * honesty policy as this file's section-header icons. */
function GroupButtons({
  node,
  group,
  label,
  fallback,
  readOnly,
  cssProp,
  iconFor,
  onValueChange,
}: {
  node: TreeNode;
  group: ClassPresetGroup;
  label: string;
  fallback: string;
  readOnly: boolean;
  /** See `GroupSelect`'s `cssProp` — same FIX-W4b-1 Part B real-value
   * readout, for the segmented-button controls. */
  cssProp?: string;
  /** See this function's own doc. */
  iconFor?: (value: string) => IconName | undefined;
  /** Fires on every choice (including the initial one is NOT replayed — this
   * mirrors `useState`'s own initializer semantics) — lets a PARENT section
   * mirror the live value without making this component controlled (every
   * other prop stays exactly as before). Used by `LayoutContainerSection` to
   * track `Direction` so its sibling `Justify`/`Align items` rows can pick
   * the matching row/column Penpot icon set (`justifyIcon`/`alignItemsIcon`
   * both take an `isColumn` flag — see their own doc). */
  onValueChange?: (value: string) => void;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Lazy initializer only — see `GroupSelect`'s matching comment: the
  // enclosing section is always uniquely `key`-ed by `Inspector`.
  const [value, setValue] = React.useState(() => getClassHint(node.uid, group.key) ?? fallback);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-muted)' }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {group.presets.map((preset) => {
          const icon = iconFor?.(preset.value);
          return (
            <Button
              key={preset.value}
              type="button"
              size="sm"
              variant="secondary"
              active={value === preset.value}
              disabled={readOnly}
              title={preset.label}
              aria-label={icon ? preset.label : undefined}
              onClick={() => {
                setValue(preset.value);
                onValueChange?.(preset.value);
                if (readOnly) return;
                const edit = resolveClassEdit(group, preset.value);
                setClassHint(node.uid, group.key, preset.value);
                sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
              }}
            >
              {icon ? <Icon name={icon} size={12} /> : preset.label}
            </Button>
          );
        })}
      </div>
      {cssProp && <CurrentValueLine cssProp={cssProp} group={group} />}
    </div>
  );
}

// --- FIX-W4b-2 icon lookups — one per `GroupButtons`/`GroupSelect` consumer
// below, each cited against the real Penpot source function/component that
// picks that exact glyph set, so every mapping here is traceable rather than
// invented. All row/column switching is driven by the CONTAINER's own live
// `Direction` choice (`isColumn`, computed once in `LayoutContainerSection`
// and threaded to its own Justify/Align-items rows) — the one case with a
// real column variant available AND a live value to switch on. -------------

/** `layout_container.cljs`'s `dir-icons-refactor` — note real Penpot reuses
 * its own `grid-row` glyph for flex-direction `:row` (not a dedicated
 * "flex-row" icon); reproduced as-is rather than substituting a "nicer" icon
 * that wouldn't actually be what Penpot renders. */
function directionIcon(value: string): IconName | undefined {
  switch (value) {
    case 'row':
      return 'grid-row';
    case 'row-reverse':
      return 'row-reverse';
    case 'col':
      return 'column';
    case 'col-reverse':
      return 'column-reverse';
    default:
      return undefined;
  }
}

/** `layout_container.cljs`'s `wrap-row` — Penpot only toggles two states
 * (wrap/nowrap) with one `wrap` glyph; this tool's `WRAP_GROUP` additionally
 * offers `wrap-reverse` (a real Tailwind utility Penpot's own control doesn't
 * expose), which reuses the same glyph — the tooltip (`title`) is what
 * disambiguates it, same as `nowrap` getting no icon at all (Penpot's toggle
 * has no distinct "nowrap" glyph either). */
function wrapIcon(value: string): IconName | undefined {
  return value === 'wrap' || value === 'wrap-reverse' ? 'wrap' : undefined;
}

/** `layout_container.cljs`'s `get-layout-flex-icon` for `:justify-content` —
 * `JUSTIFY_GROUP`'s 6 values (start/center/end/between/around/evenly) match
 * Penpot's row/column icon sets 1:1. */
function justifyIcon(value: string, isColumn: boolean): IconName | undefined {
  const suffix = isColumn ? 'column' : 'row';
  switch (value) {
    case 'start':
    case 'center':
    case 'end':
      return `justify-content-${suffix}-${value}` as IconName;
    case 'between':
      return `justify-content-${suffix}-between` as IconName;
    case 'around':
      return `justify-content-${suffix}-around` as IconName;
    case 'evenly':
      return `justify-content-${suffix}-evenly` as IconName;
    default:
      return undefined;
  }
}

/** `layout_container.cljs`'s `get-layout-flex-icon` for `:align-items` —
 * Penpot's own `align-row` only ever offers start/center/end (3 buttons, no
 * baseline/stretch glyph exists upstream); `ALIGN_ITEMS_GROUP`'s extra
 * `baseline`/`stretch` values (real Tailwind utilities Penpot's flex
 * align-row doesn't surface) fall back to a plain text button rather than a
 * fabricated icon. */
function alignItemsIcon(value: string, isColumn: boolean): IconName | undefined {
  if (value !== 'start' && value !== 'center' && value !== 'end') return undefined;
  return `align-items-${isColumn ? 'column' : 'row'}-${value}` as IconName;
}

/** `layout_container.cljs`'s `get-layout-flex-icon` for `:align-self` —
 * ALWAYS the ROW-variant glyph set (`align-self-row-left/-center/-right`,
 * `auto`->`remove`). Real Penpot switches to the COLUMN set
 * (`align-self-column-top/-center/-bottom`) when the shape's PARENT is a
 * column-direction flex container; this section (`LayoutItemSection`) has no
 * live read of its parent's direction (a disclosed pre-existing gap, same
 * root cause `inspector-class-hints.ts`'s module doc gives for why this file
 * can't read a node's current classes at all) — row is the common-case
 * default. `stretch`/`baseline` have no Penpot align-self glyph either, same
 * as `align-items` above. */
function alignSelfIcon(value: string): IconName | undefined {
  switch (value) {
    case 'auto':
      return 'remove';
    case 'start':
      return 'align-self-row-left';
    case 'center':
      return 'align-self-row-center';
    case 'end':
      return 'align-self-row-right';
    default:
      return undefined;
  }
}

/** `typography.cljs`'s text-align row (`text-align-left`/`-center`/`-right`/
 * `text-justify`). `TEXT_ALIGN_GROUP`'s values are LOGICAL (`start`/`end`,
 * this file's own RTL convention — see `inspector-presets.ts`'s module doc)
 * but Penpot's icons are PHYSICAL left/right glyphs, so `isRtl` swaps which
 * physical glyph represents `start`/`end` — otherwise a `dir="rtl"` document
 * would show a "left-aligned lines" glyph for a control that's actually
 * right-aligning the text. */
function textAlignIcon(value: string, isRtl: boolean): IconName | undefined {
  switch (value) {
    case 'start':
      return isRtl ? 'text-align-right' : 'text-align-left';
    case 'end':
      return isRtl ? 'text-align-left' : 'text-align-right';
    case 'center':
      return 'text-align-center';
    case 'justify':
      return 'text-justify';
    default:
      return undefined;
  }
}

/** A numeric field for an arbitrary-value class (`w-[Npx]`, `start-[Npx]`,
 * `rotate-[Ndeg]`, ...) — the open-ended counterpart to `GroupSelect`/
 * `GroupButtons` for controls with no fixed enum. Rewritten FIX-W4b-3a to
 * close two gaps the original (FIX-W4b-2) version had:
 *  - **`readOnly` is now actually WIRED.** The original destructured it into
 *    its own prop TYPE but never READ it in the function body, so a
 *    `dynamic`-locked node's W/H/X/Y fields were silently never disabled —
 *    caught while implementing this task's own honesty requirement (item 4)
 *    below, fixed here rather than left in place now that it's noticed.
 *  - **The field now SEEDS from the node's real current value** (`cssProp`,
 *    FIX-W4b-1 Part B) instead of always starting blank. "Uncontrolled until
 *    touched": while this field has never been edited THIS session (no
 *    `hintKey` hint recorded yet), its displayed value is DERIVED live from
 *    `ComputedStyleContext` on every render — so it naturally corrects
 *    itself the moment the async computed-style fetch resolves, with no
 *    `useEffect` needed (a synchronous "reset on prop change" effect is what
 *    this repo's `react-hooks/set-state-in-effect` lint rule forbids as a
 *    cascading-render smell — this sidesteps that by never resetting
 *    anything: the seed is just what renders when `dirtyText` is `null`).
 *    The FIRST keystroke latches `dirtyText`, and from then on the field
 *    behaves exactly as the original did (its own last write wins, matching
 *    every other control's `getClassHint(...) ?? fallback` precedence).
 *
 * FIX-W4b-2 `icon`: Penpot's `measures.cljs` numeric-input-wrapper carries a
 * leading property glyph on every one of these (`i/character-w`/`-h`/`-x`/
 * `-y`/`i/corner-radius`, and FIX-W4b-3a's own `i/rotation`) — forwarded to
 * `Input`'s own `leadingIcon` (see that primitive's doc). */
function ArbitraryPxInput({
  node,
  hintKey,
  label,
  buildEdit,
  icon,
  readOnly,
  cssProp,
  unit = 'px',
  untrackedCaption,
}: {
  node: TreeNode;
  hintKey: string;
  label: string;
  readOnly: boolean;
  buildEdit: (value: number, previous: string | null) => ClassEdit;
  icon?: IconName | undefined;
  /** FIX-W4b-3a: the curated computed-style property this field mirrors/
   * seeds from (see `CurrentValueLine`'s own doc) — `undefined` when no
   * curated prop exists for this control (rotation: `@ccs/bridge`'s curated
   * `GEOMETRY_PROPS` list has no `transform` entry, a disclosed gap, see the
   * worker report). */
  cssProp?: string | undefined;
  unit?: 'px' | 'deg';
  /** Shown instead of a `CurrentValueLine` when `cssProp` is `undefined` —
   * an honest "this control has no live readout" caption (rotation only),
   * never silence and never a fabricated value. */
  untrackedCaption?: string | undefined;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const computed = React.useContext(ComputedStyleContext);
  const seed = cssProp ? resolveCurrentValue(computed, cssProp) : ('unset' as const);
  const hinted = getClassHint(node.uid, hintKey) ?? null;
  const hintedValue = hinted ? parseArbitraryValue(hinted) : null;
  const seededText = React.useMemo(() => {
    if (hintedValue !== null) return String(hintedValue);
    if (seed !== 'loading' && seed !== 'unset') {
      const n = Math.round(parseFloat(seed.raw));
      if (Number.isFinite(n)) return String(n);
    }
    return '';
  }, [hintedValue, seed]);
  // "Uncontrolled until touched" — see this function's own doc.
  const [dirtyText, setDirtyText] = React.useState<string | null>(null);
  const text = dirtyText ?? seededText;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Input
        label={label}
        type="number"
        placeholder={unit}
        leadingIcon={icon}
        disabled={readOnly}
        value={text}
        onChange={(e) => setDirtyText(e.target.value)}
        onBlur={() => {
          if (readOnly || text.trim() === '') return;
          const value = Number(text);
          if (!Number.isFinite(value)) return;
          const previous = getClassHint(node.uid, hintKey) ?? null;
          const edit = buildEdit(value, previous);
          const written = edit.add[0];
          if (written) setClassHint(node.uid, hintKey, written);
          sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
        }}
      />
      {cssProp ? (
        <CurrentValueLine cssProp={cssProp} />
      ) : (
        untrackedCaption && (
          <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>
            {untrackedCaption}
          </span>
        )
      )}
    </div>
  );
}

// --- Size & position (measures.cljs, radius + rotation included — see
// module doc's FIX-W4b-3a section) ---------------------------------------

function SizePositionSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Lazy initializer only — this section is always uniquely `key`-ed by
  // `Inspector` (see its own doc), same reasoning as `GroupSelect`.
  const [position, setPosition] = React.useState(() => getClassHint(node.uid, POSITION_GROUP.key) ?? 'static');
  const canPositionXY = position === 'absolute';

  return (
    <Panel title="Size & position" id="inspector-size-position">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* W/H — FIX-W4b-3a: direct numeric fields (Penpot's own plain
         * editable number), replacing the old Auto/Custom two-step
         * `<Select>` + arbitrary-input pair. `WIDTH_GROUP`/`HEIGHT_GROUP`'s
         * named presets (`w-auto`/`w-full`/...) still exist as
         * `arbitrarySizeEdit`'s remove-candidate list (`inspector-
         * presets.ts`) — entering a number here still evicts a stale
         * `w-full` etc. — they're just no longer a separate control. */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="size-w-custom"
              label="W"
              readOnly={readOnly}
              icon="character-w"
              cssProp="width"
              buildEdit={(px, previous) => arbitrarySizeEdit('w', px, previous)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="size-h-custom"
              label="H"
              readOnly={readOnly}
              icon="character-h"
              cssProp="height"
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
        {/* X/Y — FIX-W4b-3a: ALWAYS rendered now (previously hidden entirely
         * unless already `absolute`) — Penpot always shows a shape's x/y.
         * Disabled (but still honestly seeded, never a silent no-op write)
         * while the node is in-flow `static`: its real `left`/`top` computed
         * values exist, but a plain inset write wouldn't meaningfully move a
         * normal-flow element, so this follows the task's own "disabled +
         * honest value beats a no-op" directive rather than writing anyway.
         * NOTE: the seed reads the CURATED `left`/`top` computed props
         * (physical) while the write is Tailwind's LOGICAL `start-[Npx]`
         * (RTL convention, `inspector-presets.ts`'s module doc) — a disclosed
         * mismatch under `dir="rtl"` inherited from `@ccs/bridge`'s existing
         * curated prop list (no logical-inset computed prop exists there),
         * not new to this pass. */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="inset-start"
              label="X"
              readOnly={readOnly || !canPositionXY}
              icon="character-x"
              cssProp="left"
              buildEdit={(px, previous) => arbitraryInsetEdit('start', px, previous)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="inset-top"
              label="Y"
              readOnly={readOnly || !canPositionXY}
              icon="character-y"
              cssProp="top"
              buildEdit={(px, previous) => arbitraryInsetEdit('top', px, previous)}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Rotation — FIX-W4b-3a, NEW (see module doc for why FIX-W4's
           * drop of this field is reversed). No curated computed source
           * exists yet (disclosed gap, see `ArbitraryPxInput`'s own doc), so
           * this always shows an honest "not tracked" rather than a
           * fabricated current value. */}
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="rotate-custom"
              label="Rotation"
              readOnly={readOnly}
              icon="rotation"
              unit="deg"
              untrackedCaption="Current: not tracked"
              buildEdit={(deg, previous) => arbitraryRotateEdit(deg, previous)}
            />
          </div>
          {/* Radius (`border_radius.cljs`'s `border-radius-menu*`, embedded
           * directly inside `measures-menu*` in real Penpot — see this
           * file's module doc for the citation — hence living here, not in
           * the old "Border & radius" Panel (now just `Stroke`, below).
           * FIX-W4b-3a: reworked from a preset-only `<Select>` to a direct
           * numeric field, matching Penpot's own free-numeric radius input.
           * Penpot's INDEPENDENT-CORNERS toggle (`border_radius.cljs`'s
           * per-corner mode) is CARRY-FORWARD — see the worker report. */}
          <div style={{ flex: 1 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="radius-custom"
              label="Radius"
              readOnly={readOnly}
              icon="corner-radius"
              cssProp="border-radius"
              buildEdit={(px, previous) => arbitraryRadiusEdit(px, previous)}
            />
          </div>
        </div>
      </div>
    </Panel>
  );
}

const DEVICE_CATEGORY_LABEL: Record<DevicePreset['category'], string> = {
  phone: 'Phone',
  tablet: 'Tablet',
  desktop: 'Desktop',
};

/** FIX-W4b-3a item 1 (frame/board branch) — writes the BOARD's geometry via
 * `StudioCanvasHandle.setFrameGeometry` (see that method's own doc for the
 * write path: the SAME `set-geometry` daemon message the drag/resize commit
 * already sends), NOT `set-classes` — a board's W/H is `.studio/canvas.json`
 * geometry (`FrameEntry.w/h`), not a Tailwind class on its root element, so
 * this is deliberately a SEPARATE component from the element-facing
 * `SizePositionSection` above rather than one component branching per field
 * on every single control.
 *
 * Seed values: the board's `<iframe>` is sized to EXACTLY its `w`×`h`
 * (`@ccs/canvas`'s `geometry.ts` module doc: "iframe space and frame space
 * are identical, no internal CSS scaling") — so the root element's OWN
 * computed `width`/`height` (the same curated FIX-W4b-1 Part B bridge round
 * trip every other control uses) is a reliable, honest read of the board's
 * real current size, with zero new plumbing. Frame X/Y (the board's
 * position on the infinite canvas) has no such DOM-observable equivalent and
 * is OUT of this section's scope — see the worker report's own note. */
function FrameSizeSection({
  fileFolder,
  framePath,
  canvasHandle,
  readOnly,
}: {
  fileFolder: string | null;
  framePath: string;
  canvasHandle: StudioCanvasHandle | null;
  readOnly: boolean;
}): React.ReactElement {
  const canWrite = !readOnly && canvasHandle !== null && fileFolder !== null;
  // FIX-W4b-3a (bug found via this task's own dogfood run): a geometry write
  // (either field commits below, or a size-preset/device-quick-preset pick)
  // does NOT change `activeUid`/`bridgeGeneration`, so `useComputedStyle`
  // never re-fetches — `FrameGeometryInput`'s own `ComputedStyleContext`
  // seed would otherwise go STALE the instant a write commits (confirmed
  // live: after clicking "Phone", the W/H fields kept showing the board's
  // PREVIOUS size until manually reselecting it), directly violating this
  // task's own item-4 honesty rule. `override` is the "own last write wins"
  // fix, lifted HERE (not per-`FrameGeometryInput`) so a PRESET click (which
  // writes BOTH axes from a single button, outside either field's own local
  // state) also updates both fields' displayed value, not just the one a
  // user might have typed into directly.
  const [override, setOverride] = React.useState<{ w: number | null; h: number | null }>({ w: null, h: null });

  const applyGeometry = React.useCallback(
    (patch: { w?: number; h?: number }) => {
      if (!canWrite || !fileFolder || !canvasHandle) return;
      canvasHandle.setFrameGeometry(fileFolder, framePath, patch);
      setOverride((prev) => ({ w: patch.w ?? prev.w, h: patch.h ?? prev.h }));
    },
    [canWrite, fileFolder, framePath, canvasHandle],
  );

  return (
    <Panel title="Size & position" id="inspector-size-position">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <FrameGeometryInput
              label="W"
              icon="character-w"
              cssProp="width"
              disabled={!canWrite}
              valueOverride={override.w}
              onCommit={(w) => applyGeometry({ w })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <FrameGeometryInput
              label="H"
              icon="character-h"
              cssProp="height"
              disabled={!canWrite}
              valueOverride={override.h}
              onCommit={(h) => applyGeometry({ h })}
            />
          </div>
        </div>
        {/* Size presets + device-type quick-selects (item 3) — cited against
         * Penpot's own `app.main.constants/size-presets` catalog, see
         * `inspector-presets.ts`'s own module doc for the full citation +
         * why there are no device-type ICONS (Penpot's own list is
         * text-only). */}
        <Select
          label="Size presets"
          value=""
          disabled={!canWrite}
          options={[
            { value: '', label: 'Choose a device…' },
            ...DEVICE_PRESETS.map((p) => ({ value: p.value, label: `${p.label} — ${p.w}×${p.h}` })),
          ]}
          onChange={(e) => {
            const preset = DEVICE_PRESETS.find((p) => p.value === e.target.value);
            if (preset) applyGeometry({ w: preset.w, h: preset.h });
          }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {DEVICE_QUICK_PRESETS.map((preset) => (
            <Button
              key={preset.value}
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canWrite}
              title={`${preset.label} — ${preset.w}×${preset.h}`}
              onClick={() => applyGeometry({ w: preset.w, h: preset.h })}
            >
              {DEVICE_CATEGORY_LABEL[preset.category]}
            </Button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/** A numeric W/H field for `FrameSizeSection`, seeded from the board root's
 * REAL current computed size (see that section's own doc). No session-hint
 * cache needed here (unlike `ArbitraryPxInput`): this component is always
 * freshly mounted per board selection (`FrameSizeSection`'s own `key`, set
 * by its caller, `FrameInspector`), so plain "uncontrolled until touched"
 * local state is enough — there's no cross-remount session state to
 * preserve since a board write isn't a `set-classes` class hint.
 * `valueOverride` (FIX-W4b-3a bug fix, see `FrameSizeSection`'s own doc)
 * takes precedence over the (potentially stale) computed-style seed once
 * EITHER this field or its sibling (via a size preset) has committed a
 * write this session — still never a fabricated value, just this
 * component's own most recent real write standing in for a re-fetch the
 * bridge round trip doesn't automatically provide. */
function FrameGeometryInput({
  label,
  icon,
  cssProp,
  disabled,
  valueOverride,
  onCommit,
}: {
  label: string;
  icon: IconName;
  cssProp: string;
  disabled: boolean;
  valueOverride: number | null;
  onCommit: (px: number) => void;
}): React.ReactElement {
  const computed = React.useContext(ComputedStyleContext);
  const seed = resolveCurrentValue(computed, cssProp);
  const seededText = React.useMemo(() => {
    if (valueOverride !== null) return String(valueOverride);
    if (seed === 'loading' || seed === 'unset') return '';
    const n = Math.round(parseFloat(seed.raw));
    return Number.isFinite(n) ? String(n) : '';
  }, [valueOverride, seed]);
  const [dirtyText, setDirtyText] = React.useState<string | null>(null);
  const text = dirtyText ?? seededText;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Input
        label={label}
        type="number"
        placeholder="px"
        leadingIcon={icon}
        disabled={disabled}
        value={text}
        onChange={(e) => setDirtyText(e.target.value)}
        onBlur={() => {
          if (disabled || text.trim() === '') return;
          const value = Number(text);
          if (!Number.isFinite(value)) return;
          onCommit(value);
        }}
      />
      {/* FIX-W4b-3a bug fix (see this function's own doc): NOT the generic
       * `CurrentValueLine` (it reads `ComputedStyleContext` directly, which
       * goes stale the instant a geometry write commits, with no re-fetch
       * trigger to correct it — confirmed live: it kept showing the board's
       * PREVIOUS size after a preset click). This caption instead mirrors
       * the SAME override-aware value the input itself displays, so the two
       * can never visibly disagree. */}
      <span
        data-testid={`inspector-current-${cssProp}`}
        style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}
      >
        {valueOverride !== null ? `Current: ${valueOverride}px` : formatCurrentValue(seed)}
      </span>
    </div>
  );
}

// --- Layout container (layout_container.cljs) ---------------------------

function LayoutContainerSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  // FIX-W4b-2: mirrors the live `Direction` choice (see `GroupButtons`'
  // `onValueChange` doc) purely so `Justify`/`Align items` below can pick
  // Penpot's matching row/column icon set — `layout_container.cljs`'s own
  // `get-layout-flex-icon` takes the same `is-column` flag from this exact
  // container's `layout-flex-dir`. Lazy initializer mirrors `GroupButtons`'
  // own (reads the SAME hint key, so both start in sync).
  const [direction, setDirection] = React.useState(() => getClassHint(node.uid, DIRECTION_GROUP.key) ?? 'row');
  const isColumn = direction === 'col' || direction === 'col-reverse';

  return (
    <Panel title="Layout container" id="inspector-layout-container" icon="flex">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupButtons
          node={node}
          group={DIRECTION_GROUP}
          label="Direction"
          fallback="row"
          readOnly={readOnly}
          cssProp="flex-direction"
          iconFor={directionIcon}
          onValueChange={setDirection}
        />
        <GroupButtons
          node={node}
          group={WRAP_GROUP}
          label="Wrap"
          fallback="nowrap"
          readOnly={readOnly}
          cssProp="flex-wrap"
          iconFor={wrapIcon}
        />
        <GroupButtons
          node={node}
          group={JUSTIFY_GROUP}
          label="Justify"
          fallback="start"
          readOnly={readOnly}
          cssProp="justify-content"
          iconFor={(v) => justifyIcon(v, isColumn)}
        />
        <GroupButtons
          node={node}
          group={ALIGN_ITEMS_GROUP}
          label="Align items"
          fallback="stretch"
          readOnly={readOnly}
          cssProp="align-items"
          iconFor={(v) => alignItemsIcon(v, isColumn)}
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
    <Panel title="Layout item" id="inspector-layout-item">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupSelect node={node} group={GROW_GROUP} label="Flex" fallback="none" readOnly={readOnly} />
        <GroupButtons
          node={node}
          group={SELF_ALIGN_GROUP}
          label="Align self"
          fallback="auto"
          readOnly={readOnly}
          iconFor={alignSelfIcon}
        />
        <GroupSelect node={node} group={ORDER_GROUP} label="Order" fallback="none" readOnly={readOnly} />
      </div>
    </Panel>
  );
}

// --- Typography (typography.cljs) ----------------------------------------

function TypographySection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const textColorGroup = React.useMemo(() => colorGroup('text'), []);
  // FIX-W4b-2: this app's own `dir` (playbook §5.9/ADR-0022 RTL-first) — read
  // once per render (no listener: the document's writing direction doesn't
  // flip mid-session in this tool) so `textAlignIcon` shows the physically
  // correct Penpot glyph for the logical `start`/`end` values — see that
  // function's own doc.
  const isRtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
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
        <GroupButtons
          node={node}
          group={TEXT_ALIGN_GROUP}
          label="Align"
          fallback="start"
          readOnly={readOnly}
          cssProp="text-align"
          iconFor={(v) => textAlignIcon(v, isRtl)}
        />
        <GroupSelect
          node={node}
          group={textColorGroup}
          label="Color"
          fallback="none"
          readOnly={readOnly}
          cssProp="color"
          swatchHex={hexForColorValue}
        />
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
        <GroupSelect
          node={node}
          group={bgColorGroup}
          label="Background"
          fallback="none"
          readOnly={readOnly}
          cssProp="background-color"
          swatchHex={hexForColorValue}
        />
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
    <Panel title="Stroke" id="inspector-stroke" icon="stroke-size">
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
            <GroupSelect
              node={node}
              group={BORDER_WIDTH_GROUP}
              label="Width"
              fallback="1"
              readOnly={readOnly}
              leadingIcon="stroke-size"
            />
            <GroupSelect
              node={node}
              group={borderColorGroup}
              label="Color"
              fallback="none"
              readOnly={readOnly}
              cssProp="border-color"
              swatchHex={hexForColorValue}
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
    <Panel title="Shadow" id="inspector-shadow" icon="drop-shadow">
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
