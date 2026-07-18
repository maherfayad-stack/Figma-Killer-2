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
  resolveCurrentPresetValue,
  resolveCurrentValue,
  type ComputedLookup,
} from './inspector-computed-values.js';
import {
  ALIGN_CONTENT_GROUP,
  ALIGN_ITEMS_GROUP,
  arbitraryGapEdit,
  arbitraryInsetEdit,
  arbitraryPaddingLinkedEdit,
  arbitraryPaddingSideEdit,
  arbitraryRadiusEdit,
  arbitraryRotateEdit,
  arbitrarySizeEdit,
  BORDER_WIDTH_GROUP,
  buildColorPalette,
  clamp01,
  type ClassEdit,
  type ClassPresetGroup,
  type ColorControlValue,
  DEVICE_PRESETS,
  DEVICE_QUICK_PRESETS,
  type DevicePreset,
  DIRECTION_GROUP,
  filterColorPalette,
  FONT_WEIGHT_GROUP,
  GROW_GROUP,
  hexToRgb,
  hsvToRgb,
  JUSTIFY_GROUP,
  LEADING_GROUP,
  normalizeHex,
  OPACITY_GROUP,
  ORDER_GROUP,
  parseArbitraryValue,
  parseColorHint,
  POSITION_GROUP,
  POSITION_REMOVE_EXTRA,
  resolveClassEdit,
  resolveColorWrite,
  rgbToHex,
  rgbToHsv,
  SELF_ALIGN_GROUP,
  serializeColorHint,
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
 *
 * ## FIX-W4b-3c — real color control (Fill/Stroke/Typography color)
 * Replaces the plain `colorGroup()`-backed `GroupSelect` (+ its `swatchHex`
 * chip) on all three color rows with `ColorControl` — a Penpot `color_row.
 * cljs`/`color_bullet.cljs`-anatomy control (swatch bullet + editable hex +
 * opacity %), whose bullet opens a `colorpicker.cljs`-anatomy popover: a
 * hand-rolled SV+hue picker (`ColorSvHuePicker`, plain CSS gradients +
 * Pointer Events — no new npm dependency) plus a SEARCHABLE palette merging
 * real DS color tokens (`@ccs/tokens`, via the frozen `EngineApi.
 * tokensForProperty`) with this file's pre-existing named Tailwind palette,
 * every entry a real preview swatch. Directly answers the human's own
 * dogfood complaint verbatim: "I can't put custom colors just dropdown from
 * our tokens, and also there is no search in that and even no preview of the
 * colors." A custom/picked hex writes an ARBITRARY `${prefix}-[#rrggbb]`
 * class (`bg-`/`text-`/`border-`, mirroring FIX-W4b-3a's `w-[Npx]`
 * convention); a token pick writes `${prefix}-${tokenClassName}` (the SAME
 * Tailwind key `@ccs/tokens`' own `emitTailwindPreset` extends `theme.colors`
 * with); opacity is Tailwind's `/NN` alpha modifier on whichever class is
 * active. The bullet/hex seed from the element's REAL current computed color
 * (`ComputedStyleContext`, already curated by `@ccs/bridge`'s existing
 * `COLOR_PROPS` list — zero protocol/bridge diff) via `cssColorToHex`, which
 * normalizes ANY CSS-legal color string (`rgb()`/`oklch()`/`color(...)`/
 * named keywords) using the browser's own Canvas 2D color-serialization
 * (see that function's own doc) — honest, never fabricated. See
 * `ColorControl`'s own doc for the full "uncontrolled until touched"
 * precedence and `inspector-presets.ts`'s own module doc for every pure
 * helper backing this (`resolveColorWrite`, `buildColorPalette`,
 * `serializeColorHint`/`parseColorHint`, the hex<->rgb<->hsv conversions).
 * Size&Position, Layout, and every other control are UNTOUCHED by this pass.
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
   * ABOVE the select. UNUSED as of FIX-W4b-3c: Fill/Stroke/Typography-color
   * (this prop's only 3 callers) were replaced with the dedicated
   * `ColorControl` (custom hex + picker + searchable token palette — see
   * that function's own doc for why a plain `<Select>` could no longer
   * satisfy the human's own "no custom colors / no search / no preview"
   * complaint). Left on `GroupSelect` itself, still fully wired, in case a
   * future non-color swatch-backed group ever needs it — removing a shared
   * helper's still-functional optional prop merely because its callers
   * moved on isn't this workstream's scope (color controls only). */
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
  hideLabel,
  seedFromLive,
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
  /** FIX-W4b-3b — real Penpot's `radio-buttons` rows (`layout_container.
   * cljs`'s `direction-row-flex`/`align-row`/`justify-content-row`/etc.)
   * carry NO visible group label at all, only per-button tooltips (`title`)
   * — confirmed against that file's own markup, no label element anywhere
   * near them. This file's ORIGINAL (FIX-W4) row always rendered one for
   * every consumer (Typography's text-align, Layout-item's align-self),
   * which is fine there (each is the section's only row), but stacking FIVE
   * of these labelled rows in `LayoutContainerSection` is exactly the
   * "spread into tall, verbose... rows" the human's dogfood flagged — so
   * this pass adds an opt-in `hideLabel`, defaulting to `false` (every
   * EXISTING caller — Typography/Layout-item — is unchanged), and
   * `LayoutContainerSection` alone passes `true`, relying on each button's
   * own `title` tooltip for the same identification Penpot itself gives. */
  hideLabel?: boolean;
  /** FIX-W4b-3b — when true (and `cssProp` is set), the highlighted button
   * BEFORE the user clicks anything this session is seeded from the
   * element's REAL current computed value (`resolveCurrentPresetValue`)
   * instead of always starting at `fallback` — closes the exact "highlight
   * disagrees with the honest `CurrentValueLine` right below it" gap the
   * W4b-2 audit flagged (that highlight used to come from a session hint or
   * a hardcoded fallback ALONE, never the live value). Opt-in, defaulting to
   * unset/`false`, so every EXISTING caller (Typography's text-align,
   * Layout-item's align-self — neither touched by this pass) renders
   * byte-identically to before; `LayoutContainerSection` alone passes `true`
   * for its cssProp-backed rows (Align items/Direction/Wrap/Justify). */
  seedFromLive?: boolean;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const computed = React.useContext(ComputedStyleContext);
  // `touched`: this session's own click on THIS control, if any — ALWAYS
  // wins once set, mirroring the original component's sticky `useState`
  // exactly. Before any click, the active value is recomputed EVERY RENDER
  // (not baked into a one-shot lazy `useState` initializer) so it can react
  // to the computed-style bridge reply arriving ASYNCHRONOUSLY after mount —
  // the same "uncontrolled until touched" reasoning `ArbitraryPxInput`'s own
  // doc gives (a lazy initializer would race that fetch and freeze at
  // whatever was available at mount time — `null`/"loading" almost always,
  // since the bridge round-trip is never synchronous — which is exactly how
  // this bug shipped the first time).
  const [touched, setTouched] = React.useState<string | null>(null);
  const hinted = getClassHint(node.uid, group.key);
  const liveSeed = seedFromLive && cssProp ? resolveCurrentPresetValue(computed, cssProp, group) : null;
  const value = touched ?? hinted ?? liveSeed ?? fallback;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} title={hideLabel ? label : undefined}>
      {!hideLabel && (
        <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-muted)' }}>{label}</span>
      )}
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
                setTouched(preset.value);
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

/** FIX-W4b-3c — normalizes ANY CSS-legal color string (the bridge's REAL
 * computed `rgb()`/`rgba()`/`oklch()`/`color(...)`/named-keyword value, or a
 * DS token's raw catalog value) into a guaranteed hex + alpha% pair, using
 * the browser's OWN color engine instead of hand-parsing every CSS color
 * syntax — no new npm dependency (the constraint this workstream's brief
 * explicitly holds to), and honestly handles formats (`oklch()`,
 * `color(...)`) `inspector-presets.ts`'s dependency-free `normalizeHex`
 * cannot.
 *
 * CORRECTED mid-implementation by this pass's own real-browser dogfood: the
 * first version read `ctx.fillStyle` back as a STRING and regex-matched
 * `#rrggbb`/`rgba(...)`, on the (wrong, empirically disproven) assumption
 * that the HTML Canvas 2D "serialization of a color" always collapses to
 * one of those two forms. It does NOT on current Chromium (confirmed:
 * `ctx.fillStyle = 'oklch(0.588 0.158 241.966)'` then reading `ctx.
 * fillStyle` back yields THE SAME oklch() STRING verbatim, not a `#rrggbb`)
 * — so a `background-color: oklch(...)` node (a completely normal computed
 * value in a modern browser, and exactly what this dogfood run hit on
 * Hero.tsx's `bg-sky-600` button) silently failed to resolve, leaving the
 * hex field BLANK instead of `#0284c7`. Fixed by never re-parsing the
 * fillStyle STRING at all: instead, PAINT one pixel with it and read the
 * pixel back via `getImageData` — canvas pixel storage is always
 * un-premultiplied 8-bit sRGB regardless of the input color space (per the
 * same spec), so this works identically for `oklch()`, `lab()`, `color()`,
 * `hsl()`, hex, or a named keyword, with no format-specific parsing at all.
 * Still detects an INVALID input (the fillStyle setter silently keeps its
 * PRIOR value on parse failure) via a sentinel prime, returning `null`
 * rather than fabricating a color for it — same honesty policy as every
 * other parse function in this file. DOM-dependent (this is exactly why it
 * lives here, not in the dependency-free `inspector-presets.ts` — see that
 * file's own module doc). */
function cssColorToHex(raw: string): { hex: string; alphaPct: number } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const sentinel = '#010203';
  ctx.fillStyle = sentinel;
  ctx.fillStyle = raw;
  if (ctx.fillStyle === sentinel && raw.trim().toLowerCase() !== sentinel) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const pixel = ctx.getImageData(0, 0, 1, 1).data;
  const [r, g, b, a] = pixel;
  if (r === undefined || g === undefined || b === undefined || a === undefined) return null;
  return { hex: rgbToHex({ r, g, b }), alphaPct: Math.round((a / 255) * 100) };
}

/** FIX-W4b-3c — the hand-rolled visual picker (`colorpicker/hsva.cljs` +
 * `colorpicker/ramp.cljs`'s SV-area + hue-slider anatomy; NOT a new npm
 * dependency, per this workstream's hard constraint — plain CSS gradients +
 * Pointer Events). `hex` is the control's current color (drives both the
 * SV-square's own hue backdrop and the two thumbs' positions); `onChange`
 * fires with a new hex on every drag, letting the caller combine it with the
 * live opacity field exactly like every other color-source write. */
function ColorSvHuePicker({ hex, onChange }: { hex: string; onChange: (hex: string) => void }): React.ReactElement {
  const rgb = hexToRgb(hex) ?? { r: 59, g: 130, b: 246 };
  const hsv = rgbToHsv(rgb);

  function fromSv(e: React.PointerEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const s = clamp01((e.clientX - rect.left) / rect.width) * 100;
    const v = (1 - clamp01((e.clientY - rect.top) / rect.height)) * 100;
    onChange(rgbToHex(hsvToRgb({ h: hsv.h, s, v })));
  }

  function fromHue(e: React.PointerEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const h = clamp01((e.clientX - rect.left) / rect.width) * 360;
    onChange(rgbToHex(hsvToRgb({ h, s: hsv.s, v: hsv.v })));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        aria-label="Saturation and value"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromSv(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return;
          fromSv(e);
        }}
        style={{
          position: 'relative',
          inlineSize: '100%',
          blockSize: 120,
          borderRadius: 'var(--ccs-radius-sm)',
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`,
          border: '1px solid var(--ccs-border)',
          cursor: 'crosshair',
          touchAction: 'none',
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            insetInlineStart: `${hsv.s}%`,
            insetBlockStart: `${100 - hsv.v}%`,
            transform: 'translate(-50%, -50%)',
            inlineSize: 10,
            blockSize: 10,
            borderRadius: '50%',
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div
        aria-label="Hue"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromHue(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return;
          fromHue(e);
        }}
        style={{
          position: 'relative',
          inlineSize: '100%',
          blockSize: 14,
          borderRadius: 9999,
          background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
          border: '1px solid var(--ccs-border)',
          cursor: 'pointer',
          touchAction: 'none',
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            insetInlineStart: `${(hsv.h / 360) * 100}%`,
            insetBlockStart: '50%',
            transform: 'translate(-50%, -50%)',
            inlineSize: 14,
            blockSize: 14,
            borderRadius: '50%',
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
            background: hex,
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}

const COLOR_SWATCH_NONE_BG =
  'repeating-conic-gradient(var(--ccs-bg-input) 0% 25%, var(--ccs-bg-panel-raised) 0% 50%) 0 0/8px 8px';

/** FIX-W4b-3c — replaces the old `GroupSelect`+`swatchHex` plain `<Select>`
 * for Fill/Stroke/Typography color with a real Penpot `color_row.cljs`/
 * `color_bullet.cljs`-anatomy control: a swatch bullet (real current color,
 * never fabricated — see `cssColorToHex`) + an editable hex field (accepts
 * ANY custom hex, written as an arbitrary `${prefix}-[#rrggbb]` class) + an
 * opacity % field (Tailwind's `/NN` alpha modifier). Clicking the bullet
 * opens a `colorpicker.cljs`-anatomy popover: a hand-rolled SV+hue picker
 * (`ColorSvHuePicker`) plus a SEARCHABLE palette combining real DS color
 * tokens (`@ccs/tokens`, via the frozen `EngineApi.tokensForProperty` — see
 * `buildColorPalette`'s own doc) and this file's pre-existing named Tailwind
 * palette, each rendered as a real preview swatch — closing the human's own
 * three complaints verbatim ("can't put custom colors", "just dropdown from
 * our tokens", "no search... no preview of the colors").
 *
 * Same "uncontrolled until touched" precedence every other FIX-W4b-1/3a
 * control in this file uses (`touched ?? hinted ?? live-seed`): a session hint
 * (`serializeColorHint`/`parseColorHint`, THIS control's own last write) wins
 * once set, otherwise the element's REAL current computed color
 * (`ComputedStyleContext` + `cssColorToHex`) is shown, otherwise an honest
 * empty/"none" state — never a fabricated default. */
function ColorControl({
  node,
  prefix,
  cssProp,
  label,
  readOnly,
}: {
  node: TreeNode;
  prefix: 'bg' | 'text' | 'border';
  cssProp: 'background-color' | 'color' | 'border-color';
  label: string;
  readOnly: boolean;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const engine = useEngineApi();
  const computed = React.useContext(ComputedStyleContext);
  const hintKey = `${prefix}-color`;

  const [touched, setTouched] = React.useState<ColorControlValue | null>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [hexDraft, setHexDraft] = React.useState<string | null>(null);
  const [alphaDraft, setAlphaDraft] = React.useState<string | null>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const hintedRaw = getClassHint(node.uid, hintKey);
  const hinted = parseColorHint(hintedRaw);
  const liveSeed = resolveCurrentValue(computed, cssProp);
  const liveHex = liveSeed !== 'loading' && liveSeed !== 'unset' ? cssColorToHex(liveSeed.raw) : null;

  const active = touched ?? hinted;
  const displayHex = active?.hex ?? liveHex?.hex ?? null;
  const displayAlpha = active?.alphaPct ?? liveHex?.alphaPct ?? 100;
  const displayBaseClass = active?.baseClass ?? (displayHex ? `${prefix}-[${displayHex}]` : null);
  const previousWritten = active?.written ?? null;

  const tokens = engine.tokensForProperty(cssProp);
  const palette = React.useMemo(
    () => buildColorPalette(prefix, tokens, (value) => normalizeHex(value) ?? cssColorToHex(value)?.hex),
    [prefix, tokens],
  );
  const filtered = filterColorPalette(palette, query);

  function applyWrite(baseClass: string, hex: string, alphaPct: number): void {
    const edit = resolveColorWrite(baseClass, alphaPct, previousWritten);
    const written = edit.add[0];
    if (!written) return;
    const next: ColorControlValue = {
      hex,
      alphaPct: Math.max(0, Math.min(100, Math.round(alphaPct))),
      baseClass,
      written,
    };
    setTouched(next);
    setHexDraft(null);
    setAlphaDraft(null);
    if (readOnly) return;
    setClassHint(node.uid, hintKey, serializeColorHint(next));
    sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
  }

  const swatchBg = displayHex || COLOR_SWATCH_NONE_BG;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-muted)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
        <button
          type="button"
          aria-label={`${label} — open color picker`}
          aria-expanded={open}
          disabled={readOnly}
          onClick={() => setOpen((o) => !o)}
          title={displayHex ?? 'none'}
          style={{
            inlineSize: 22,
            blockSize: 22,
            borderRadius: 'var(--ccs-radius-sm)',
            border: '1px solid var(--ccs-border)',
            background: swatchBg,
            flexShrink: 0,
            padding: 0,
            cursor: readOnly ? 'default' : 'pointer',
          }}
        />
        <div style={{ flex: 1, minInlineSize: 0 }}>
          <Input
            value={hexDraft ?? displayHex ?? ''}
            disabled={readOnly}
            placeholder="none"
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={() => {
              if (hexDraft === null) return;
              const normalized = normalizeHex(hexDraft);
              setHexDraft(null);
              if (!normalized) return;
              applyWrite(`${prefix}-[${normalized}]`, normalized, displayAlpha);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </div>
        <div style={{ inlineSize: 56 }}>
          <Input
            type="number"
            min={0}
            max={100}
            disabled={readOnly || !displayHex}
            value={alphaDraft ?? String(displayAlpha)}
            onChange={(e) => setAlphaDraft(e.target.value)}
            onBlur={() => {
              if (alphaDraft === null) return;
              const n = Number(alphaDraft);
              setAlphaDraft(null);
              if (!Number.isFinite(n) || !displayBaseClass || !displayHex) return;
              applyWrite(displayBaseClass, displayHex, n);
            }}
          />
        </div>
        {open && (
          <div
            ref={popoverRef}
            style={{
              position: 'absolute',
              insetBlockStart: '100%',
              insetInlineStart: 0,
              zIndex: 1000,
              marginBlockStart: 4,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              inlineSize: 220,
              padding: 10,
              background: 'var(--ccs-bg-overlay)',
              border: '1px solid var(--ccs-border-strong)',
              borderRadius: 'var(--ccs-radius-md)',
              boxShadow: 'var(--ccs-shadow-overlay)',
            }}
          >
            <ColorSvHuePicker
              hex={displayHex ?? '#3b82f6'}
              onChange={(hex) => applyWrite(`${prefix}-[${hex}]`, hex, displayAlpha)}
            />
            <Input
              leadingIcon="search"
              placeholder="Search tokens…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, 1fr)',
                gap: 6,
                maxBlockSize: 140,
                overflowY: 'auto',
              }}
            >
              {filtered.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  title={entry.label}
                  aria-label={entry.label}
                  onClick={() => {
                    applyWrite(entry.baseClass, entry.hex ?? '', entry.hex === undefined ? 100 : displayAlpha);
                    setOpen(false);
                  }}
                  style={{
                    inlineSize: 24,
                    blockSize: 24,
                    padding: 0,
                    borderRadius: 'var(--ccs-radius-sm)',
                    border: '1px solid var(--ccs-border)',
                    background: entry.hex ?? COLOR_SWATCH_NONE_BG,
                    cursor: 'pointer',
                  }}
                />
              ))}
              {filtered.length === 0 && (
                <span
                  style={{
                    gridColumn: '1 / -1',
                    fontSize: 'var(--ccs-font-size-xs)',
                    color: 'var(--ccs-text-subtle)',
                  }}
                >
                  No matches
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      <CurrentValueLine cssProp={cssProp} />
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

/** FIX-W4b-3b — `layout_container.cljs`'s `get-layout-flex-icon` for
 * `:align-content` (the cross-axis-alignment-of-wrapped-lines row, only
 * shown while `Wrap` is active — see `LayoutContainerSection`'s own gate).
 * Unlike `align-items`, Penpot's `align-content-row`/`align-content-column`
 * genuinely offer all 6 `ALIGN_CONTENT_GROUP` values (start/center/end/
 * between/around/evenly) — no text-button fallback needed here. */
function alignContentIcon(value: string, isColumn: boolean): IconName | undefined {
  const suffix = isColumn ? 'column' : 'row';
  switch (value) {
    case 'start':
    case 'center':
    case 'end':
      return `align-content-${suffix}-${value}` as IconName;
    case 'between':
      return `align-content-${suffix}-between` as IconName;
    case 'around':
      return `align-content-${suffix}-around` as IconName;
    case 'evenly':
      return `align-content-${suffix}-evenly` as IconName;
    default:
      return undefined;
  }
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

// --- Layout container (layout_container.cljs) — FIX-W4b-3b compact rework
//
// Rebuilt against `layout_container.cljs`'s real `flex-layout-menu` structure
// (its four DOM rows, cited inline below) instead of the old FIX-W4 stack of
// six fully-labelled, one-control-per-row blocks — the "spread into tall,
// verbose... rows" the human's own Penpot-vs-ours dogfood flagged. No
// protocol/bridge change: every control still emits the SAME `set-classes`
// op, just via `arbitraryGapEdit`/`arbitraryPaddingSideEdit`/
// `arbitraryPaddingLinkedEdit` (new, `inspector-presets.ts`) for Gap/Padding
// specifically (numeric parity, mirroring how FIX-W4b-3a reworked Size &
// position's W/H from a preset `<Select>` to a direct field) and the
// existing `GAP_GROUP`/`PADDING_*_GROUP` tables purely as remove-candidate
// baselines now (see those exports' own doc). ------------------------------

function LayoutContainerSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  // FIX-W4b-3b: mirrors the live `Direction`/`Wrap` choice so `Justify`/
  // `Align items`/`Align content` below can pick Penpot's matching row/
  // column icon set (`layout_container.cljs`'s own `get-layout-flex-icon`
  // takes the same `is-column` flag from this exact container's
  // `layout-flex-dir`) and so `Align content` is gated correctly. This
  // computes the EXACT SAME `touched ?? hinted ?? liveSeed ?? fallback`
  // formula the `DIRECTION_GROUP`/`WRAP_GROUP` `GroupButtons` instances below
  // use internally (see that component's own `seedFromLive` doc) — kept as
  // an explicit local mirror (rather than reading the child's internal state)
  // so this section can pick an icon set BEFORE those children render.
  // Without this mirror ALSO reading the live value, a fresh node whose real
  // `flex-direction` is `column` would show the DIRECTION button correctly
  // highlighted "Column" (once `GroupButtons` itself is fixed) while
  // `Justify`/`Align items` still rendered ROW-variant icons — the exact
  // kind of disagreement this whole pass fixes, just one level up.
  const computed = React.useContext(ComputedStyleContext);
  const [directionTouched, setDirectionTouched] = React.useState<string | null>(null);
  const direction =
    directionTouched ??
    getClassHint(node.uid, DIRECTION_GROUP.key) ??
    resolveCurrentPresetValue(computed, 'flex-direction', DIRECTION_GROUP) ??
    'row';
  const isColumn = direction === 'col' || direction === 'col-reverse';
  const [wrapTouched, setWrapTouched] = React.useState<string | null>(null);
  const wrap =
    wrapTouched ??
    getClassHint(node.uid, WRAP_GROUP.key) ??
    resolveCurrentPresetValue(computed, 'flex-wrap', WRAP_GROUP) ??
    'nowrap';
  const isWrapping = wrap !== 'nowrap';
  // Penpot's own padding-mode toggle (`i/padding-extended`, simple/multiple)
  // — a transient UI choice, not a written value, so plain component state
  // is enough (no class-hint entry): switching NODES remounts this whole
  // section fresh (see the file's own per-uid `key` doc), so this always
  // restarts at Penpot's own default ("simple"/linked).
  const [paddingMode, setPaddingMode] = React.useState<'linked' | 'sides'>('linked');
  // FIX-W4b-2's `isRtl` pattern (see `TypographySection`/`textAlignIcon`),
  // reused here so the per-side Start/End padding fields show the physically
  // correct Penpot `padding-left`/`padding-right` glyph for the logical
  // `ps-*`/`pe-*` class they actually write.
  const isRtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  return (
    <Panel title="Layout container" id="inspector-layout-container" icon="flex">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Penpot's `first-row`: align-items(3) + direction(4) + wrap(1),
         * side by side, icon-only (see `GroupButtons`'s `hideLabel` doc). */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <GroupButtons
            node={node}
            group={ALIGN_ITEMS_GROUP}
            label="Align items"
            fallback="stretch"
            readOnly={readOnly}
            cssProp="align-items"
            iconFor={(v) => alignItemsIcon(v, isColumn)}
            hideLabel
            seedFromLive
          />
          <GroupButtons
            node={node}
            group={DIRECTION_GROUP}
            label="Direction"
            fallback="row"
            readOnly={readOnly}
            cssProp="flex-direction"
            iconFor={directionIcon}
            onValueChange={setDirectionTouched}
            hideLabel
            seedFromLive
          />
          <GroupButtons
            node={node}
            group={WRAP_GROUP}
            label="Wrap"
            fallback="nowrap"
            readOnly={readOnly}
            cssProp="flex-wrap"
            iconFor={wrapIcon}
            onValueChange={setWrapTouched}
            hideLabel
            seedFromLive
          />
        </div>
        {/* Penpot's `second-row`: justify-content, full width, icon-only. */}
        <GroupButtons
          node={node}
          group={JUSTIFY_GROUP}
          label="Justify content"
          fallback="start"
          readOnly={readOnly}
          cssProp="justify-content"
          iconFor={(v) => justifyIcon(v, isColumn)}
          hideLabel
          seedFromLive
        />
        {/* Penpot's `third-row`: align-content, ONLY while wrapping — no
         * curated computed-style prop exists for `align-content` (bridge/
         * protocol frozen, see this section's module doc), so no
         * `cssProp`/`CurrentValueLine` here, same honesty rule as rotation. */}
        {isWrapping && (
          <GroupButtons
            node={node}
            group={ALIGN_CONTENT_GROUP}
            label="Align content"
            fallback="start"
            readOnly={readOnly}
            iconFor={(v) => alignContentIcon(v, isColumn)}
            hideLabel
          />
        )}
        {/* Penpot's `forth-row`: gap + padding as compact icon numeric
         * fields, plus the padding simple/multiple toggle button. */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minInlineSize: 64 }}>
            <ArbitraryPxInput
              node={node}
              hintKey="gap"
              label="Gap"
              icon="gap-horizontal"
              readOnly={readOnly}
              cssProp="gap"
              buildEdit={(px, prev) => arbitraryGapEdit(px, prev)}
            />
          </div>
          {paddingMode === 'linked' && (
            <>
              <div style={{ flex: 1, minInlineSize: 64 }}>
                <PaddingField
                  node={node}
                  label="Vertical"
                  icon="padding-top-bottom"
                  readOnly={readOnly}
                  hintKeys={['padding-top', 'padding-bottom']}
                  buildEdit={(px) =>
                    arbitraryPaddingLinkedEdit('vertical', px, [
                      getClassHint(node.uid, 'padding-top') ?? null,
                      getClassHint(node.uid, 'padding-bottom') ?? null,
                    ])
                  }
                />
              </div>
              <div style={{ flex: 1, minInlineSize: 64 }}>
                <PaddingField
                  node={node}
                  label="Horizontal"
                  icon="padding-left-right"
                  readOnly={readOnly}
                  hintKeys={['padding-start', 'padding-end']}
                  buildEdit={(px) =>
                    arbitraryPaddingLinkedEdit('horizontal', px, [
                      getClassHint(node.uid, 'padding-start') ?? null,
                      getClassHint(node.uid, 'padding-end') ?? null,
                    ])
                  }
                />
              </div>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            active={paddingMode === 'sides'}
            disabled={readOnly}
            title={paddingMode === 'sides' ? 'Link padding (simple)' : 'Independent sides (multiple)'}
            aria-label="Toggle independent padding sides"
            onClick={() => setPaddingMode((m) => (m === 'sides' ? 'linked' : 'sides'))}
          >
            <Icon name="padding-extended" size={12} />
          </Button>
        </div>
        {paddingMode === 'sides' && (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <PaddingField
                  node={node}
                  label="Top"
                  icon="padding-top"
                  readOnly={readOnly}
                  hintKeys={['padding-top']}
                  buildEdit={(px) =>
                    arbitraryPaddingSideEdit('top', px, [getClassHint(node.uid, 'padding-bottom') ?? null])
                  }
                />
              </div>
              <div style={{ flex: 1 }}>
                <PaddingField
                  node={node}
                  label="Bottom"
                  icon="padding-bottom"
                  readOnly={readOnly}
                  hintKeys={['padding-bottom']}
                  buildEdit={(px) =>
                    arbitraryPaddingSideEdit('bottom', px, [getClassHint(node.uid, 'padding-top') ?? null])
                  }
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <PaddingField
                  node={node}
                  label="Start"
                  icon={isRtl ? 'padding-right' : 'padding-left'}
                  readOnly={readOnly}
                  hintKeys={['padding-start']}
                  buildEdit={(px) =>
                    arbitraryPaddingSideEdit('start', px, [getClassHint(node.uid, 'padding-end') ?? null])
                  }
                />
              </div>
              <div style={{ flex: 1 }}>
                <PaddingField
                  node={node}
                  label="End"
                  icon={isRtl ? 'padding-left' : 'padding-right'}
                  readOnly={readOnly}
                  hintKeys={['padding-end']}
                  buildEdit={(px) =>
                    arbitraryPaddingSideEdit('end', px, [getClassHint(node.uid, 'padding-start') ?? null])
                  }
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

/** FIX-W4b-3b — one padding numeric field (`layout_container.cljs`'s
 * `padding-section*` sub-fields). A bespoke lean sibling of
 * `ArbitraryPxInput` rather than a reuse of it: padding has NO curated
 * computed-style property at all (`@ccs/bridge`'s `computed-style.ts`
 * `LAYOUT_PROPS` list has no `padding-*` entry — a disclosed, protocol-
 * frozen gap this task's own HARD CONSTRAINTS forbid fixing here, see the
 * worker report), so every field is seeded ONLY from its own session
 * hint(s), never a fabricated live value — an honest static "Not tracked"
 * caption always shows instead of a `CurrentValueLine`, the same treatment
 * `ArbitraryPxInput` already gives Rotation. `hintKeys` is plural
 * specifically so Penpot's own simple/multiple padding-mode toggle can
 * SHARE hint keys across both representations of the same box side (linked
 * "Vertical" writes BOTH `padding-top` and `padding-bottom`; per-side "Top"/
 * "Bottom" each read/write their own one of those same two keys) — so
 * toggling modes mid-session never loses or desyncs a value the user
 * already entered, matching Penpot's own `(= p1 p3)` simple-mode-fold-back
 * behavior (`layout_item.cljs`'s `margin-simple*`/this file's
 * `simple-padding-selection*`, re-read for this task). */
function PaddingField({
  node,
  label,
  icon,
  hintKeys,
  buildEdit,
  readOnly,
}: {
  node: TreeNode;
  label: string;
  icon: IconName;
  hintKeys: readonly string[];
  /** Resolves this field's `set-classes` add/remove pair for a committed
   * pixel value. The caller closes over `node` to read whatever OTHER
   * padding hints it needs for eviction — see
   * `arbitraryPaddingSideEdit`/`arbitraryPaddingLinkedEdit`'s own docs. */
  buildEdit: (px: number) => ClassEdit;
  readOnly: boolean;
}): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Seed from the first of `hintKeys` that already has a value (see this
  // function's own doc on why there can be more than one) — no live
  // computed-style prop exists for padding, so this is the only seed source.
  let seededText = '';
  for (const key of hintKeys) {
    const hinted = getClassHint(node.uid, key);
    const n = hinted ? parseArbitraryValue(hinted) : null;
    if (n !== null) {
      seededText = String(n);
      break;
    }
  }
  // "Uncontrolled until touched" — see `ArbitraryPxInput`'s own doc for why
  // this isn't a `useEffect` reset.
  const [dirtyText, setDirtyText] = React.useState<string | null>(null);
  const text = dirtyText ?? seededText;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Input
        label={label}
        type="number"
        placeholder="px"
        leadingIcon={icon}
        disabled={readOnly}
        value={text}
        onChange={(e) => setDirtyText(e.target.value)}
        onBlur={() => {
          if (readOnly || text.trim() === '') return;
          const value = Number(text);
          if (!Number.isFinite(value)) return;
          const edit = buildEdit(value);
          hintKeys.forEach((key, i) => {
            const cls = edit.add[i] ?? edit.add[0];
            if (cls) setClassHint(node.uid, key, cls);
          });
          sendOp({ t: 'set-classes', uid: node.uid, add: edit.add, remove: edit.remove });
        }}
      />
      <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>Not tracked</span>
    </div>
  );
}

// --- Layout item (layout_item.cljs) --------------------------------------

function LayoutItemSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  return (
    <Panel title="Layout item" id="inspector-layout-item">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupSelect node={node} group={GROW_GROUP} label="Flex" fallback="none" readOnly={readOnly} />
        {/* FIX-W4b-3b: dropped the visible "Align self" label for the same
         * density reason `LayoutContainerSection`'s icon rows dropped
         * theirs — `layout_item.cljs`'s own `align-self-row` carries no
         * label either, just per-button tooltips (see `GroupButtons`'s
         * `hideLabel` doc). Penpot's fuller `layout_item.cljs` (fix/fill/
         * auto sizing behavior + margin simple/multiple) is a materially
         * larger rework with no Tailwind-preset equivalent in this file yet
         * (margin isn't modeled at all) — out of this pass's "declutter the
         * existing controls" scope, flagged as carry-forward in the worker
         * report rather than silently expanded here. */}
        <GroupButtons
          node={node}
          group={SELF_ALIGN_GROUP}
          label="Align self"
          fallback="auto"
          readOnly={readOnly}
          iconFor={alignSelfIcon}
          hideLabel
        />
        <GroupSelect node={node} group={ORDER_GROUP} label="Order" fallback="none" readOnly={readOnly} />
      </div>
    </Panel>
  );
}

// --- Typography (typography.cljs) ----------------------------------------

function TypographySection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
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
        <ColorControl node={node} prefix="text" cssProp="color" label="Color" readOnly={readOnly} />
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

  return (
    <Panel title="Fill" id="inspector-fill" icon="swatches">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ColorControl
          node={node}
          prefix="bg"
          cssProp="background-color"
          label="Background"
          readOnly={readOnly}
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
            <ColorControl node={node} prefix="border" cssProp="border-color" label="Color" readOnly={readOnly} />
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
