import * as React from 'react';
import type { TreeNode } from '@ccs/protocol';
import { Panel, Input, Select, Checkbox, Button, Icon, type IconName, type SelectOption } from '@ccs/ui';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useEngineApi } from '../engine/engine-api-context.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useNodeOps, type NodeOps } from './use-node-ops.js';
import { findParent } from '../engine/tree-nav.js';
import type { PropSchemaEntry } from '../engine/engine-api.js';
import { getClassHint, setClassHint } from './inspector-class-hints.js';
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
 * expanded FP-INS-a `.orchestrator/FEATURE-PARITY-PLAN.md`): a fixed,
 * ordered stack of independently-collapsible `Panel` sections mirroring
 * Penpot's real Design-tab option-menu order (`penpot/frontend/src/app/
 * main/ui/workspace/sidebar/options/menus/`) — `Layer` (identity) →
 * `Content` (text) → `Size & position` (`measures.cljs`) → `Layout
 * container` (`layout_container.cljs`) → `Layout item` (`layout_item.cljs`)
 * → `Typography` (`typography.cljs`) → `Fill` (`fill.cljs`) → `Border &
 * radius` (`border_radius.cljs` + border) → `Shadow` (`shadow.cljs`) →
 * `Opacity` → `Component props` (`component.cljs`, instances only) → `Code`
 * (Open in IDE, any node). DROPPED as vector-only/out of scope per this
 * task's brief: `stroke.cljs`, `blur.cljs`, `bool.cljs`, `constraints.cljs`,
 * `svg_attrs.cljs`, `frame_grid.cljs`, `color_selection.cljs`,
 * `grid_cell.cljs`, `interactions.cljs`, and `measures.cljs`'s rotation
 * field (no vector rotation on a DOM element in this tool).
 *
 * Every control still emits ONLY the existing, frozen `set-classes`/
 * `set-prop`/`set-text` `CanvasOp`s (via `useDaemonConnection().sendOp`,
 * exactly as before) — nothing here is a new op. See `inspector-presets.ts`
 * for the Penpot-menu -> Tailwind-class tables and `inspector-class-hints.ts`
 * for the documented, disclosed limit on how "current value" is shown (no
 * existing protocol/bridge channel exposes a node's live Tailwind classes to
 * `apps/studio` — see that file's module doc for the full CR).
 *
 * A `data-dynamic` node (this phase's behavior CHANGE from the prior P5
 * pass, per this task's brief): the FULL section stack still renders (so
 * "shows values" is genuinely true — Penpot itself always shows a locked
 * shape's real properties, just non-editable), but every control is
 * `disabled` and never calls `sendOp` — `readOnly` is threaded down from the
 * top-level branch below into every section.
 */
export function Inspector(): React.ReactElement {
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
  const nodeOps = useNodeOps();

  if (!node) {
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
  const canHoldText = node.kind === 'element' || node.kind === 'text';
  // Layout-container: any non-text, non-fragment node can become (or
  // already be) a flex/grid container — Penpot itself offers an explicit
  // "+ Add flex layout" shape-menu action for shapes that AREN'T yet
  // containers (confirmed via `layout_container.cljs`'s
  // "workspace.shape.menu.add-layout" string), so this section is a
  // "configure/add layout" affordance, not gated on already-being one (this
  // Inspector has no live read of the node's current `display`, see
  // `inspector-class-hints.ts`'s module doc).
  const canBeContainer = node.kind === 'element' || node.kind === 'component-instance';
  // Layout-item: shown whenever the node has an addressable parent (i.e.
  // isn't the tree root) — real Penpot gates this on "is a flex/grid CHILD",
  // which likewise isn't live-readable here (same disclosed gap).
  const hasParent = currentTree ? findParent(currentTree, node.uid) !== null : false;

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
    <>
      <LayerSection node={node} />
      {readOnly && <DynamicBanner node={node} nodeOps={nodeOps} />}
      {canHoldText && <ContentSection key={`content-${node.uid}`} node={node} readOnly={readOnly} />}
      <SizePositionSection key={`size-position-${node.uid}`} node={node} readOnly={readOnly} />
      {canBeContainer && (
        <LayoutContainerSection key={`layout-container-${node.uid}`} node={node} readOnly={readOnly} />
      )}
      {hasParent && <LayoutItemSection key={`layout-item-${node.uid}`} node={node} readOnly={readOnly} />}
      {canHoldText && <TypographySection key={`typography-${node.uid}`} node={node} readOnly={readOnly} />}
      <FillSection key={`fill-${node.uid}`} node={node} readOnly={readOnly} />
      <BorderRadiusSection key={`border-radius-${node.uid}`} node={node} readOnly={readOnly} />
      <ShadowSection key={`shadow-${node.uid}`} node={node} readOnly={readOnly} />
      <OpacitySection key={`opacity-${node.uid}`} node={node} readOnly={readOnly} />
      {node.kind === 'component-instance' && (
        <ComponentPropsSection key={`component-props-${node.uid}`} node={node} readOnly={readOnly} />
      )}
      <CodeSection node={node} nodeOps={nodeOps} />
    </>
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
 * `layer.cljs` section adapted: no vector geometry, just AST identity. */
function LayerSection({ node }: { node: TreeNode }): React.ReactElement {
  const label = node.component ?? node.tag ?? '(text)';
  const color = node.kind === 'component-instance' ? 'var(--ccs-accent-component)' : 'var(--ccs-text)';

  return (
    <Panel title="Layer" id="inspector-layer">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
    <Panel title="Code" id="inspector-code" defaultCollapsed>
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
    <Panel title="Content" id="inspector-content">
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
}: {
  node: TreeNode;
  group: ClassPresetGroup;
  label: string;
  fallback: string;
  readOnly: boolean;
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

// --- Size & position (measures.cljs) ------------------------------------

function SizePositionSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  // Lazy initializer only — this section is always uniquely `key`-ed by
  // `Inspector` (see its own doc), same reasoning as `GroupSelect`.
  const [position, setPosition] = React.useState(() => getClassHint(node.uid, POSITION_GROUP.key) ?? 'static');

  return (
    <Panel title="Size & position" id="inspector-size-position">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={WIDTH_GROUP} label="Width" fallback="auto" readOnly={readOnly} />
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
            <GroupSelect node={node} group={HEIGHT_GROUP} label="Height" fallback="auto" readOnly={readOnly} />
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
      </div>
    </Panel>
  );
}

// --- Layout container (layout_container.cljs) ---------------------------

function LayoutContainerSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  return (
    <Panel title="Layout container" id="inspector-layout-container">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupButtons node={node} group={DIRECTION_GROUP} label="Direction" fallback="row" readOnly={readOnly} />
        <GroupButtons node={node} group={WRAP_GROUP} label="Wrap" fallback="nowrap" readOnly={readOnly} />
        <GroupSelect node={node} group={JUSTIFY_GROUP} label="Justify" fallback="start" readOnly={readOnly} />
        <GroupSelect
          node={node}
          group={ALIGN_ITEMS_GROUP}
          label="Align items"
          fallback="stretch"
          readOnly={readOnly}
        />
        <GroupSelect node={node} group={GAP_GROUP} label="Gap" fallback="0" readOnly={readOnly} />
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
    <Panel title="Typography" id="inspector-typography">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GroupSelect node={node} group={TEXT_SIZE_GROUP} label="Size" fallback="base" readOnly={readOnly} />
          </div>
          <div style={{ flex: 1 }}>
            <GroupSelect
              node={node}
              group={FONT_WEIGHT_GROUP}
              label="Weight"
              fallback="normal"
              readOnly={readOnly}
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
            />
          </div>
          <div style={{ flex: 1 }}>
            <GroupSelect
              node={node}
              group={TRACKING_GROUP}
              label="Letter spacing"
              fallback="normal"
              readOnly={readOnly}
            />
          </div>
        </div>
        <GroupButtons node={node} group={TEXT_ALIGN_GROUP} label="Align" fallback="start" readOnly={readOnly} />
        <GroupSelect node={node} group={textColorGroup} label="Color" fallback="none" readOnly={readOnly} />
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
    <Panel title="Fill" id="inspector-fill">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <GroupSelect node={node} group={bgColorGroup} label="Background" fallback="none" readOnly={readOnly} />
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

// --- Border & radius (border_radius.cljs + border) -----------------------

function BorderRadiusSection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const borderColorGroup = React.useMemo(() => colorGroup('border'), []);
  // Lazy initializer only — this section is always uniquely `key`-ed by
  // `Inspector` (see its own doc), same reasoning as `GroupSelect`.
  const [hasBorder, setHasBorder] = React.useState(() => getClassHint(node.uid, 'border-enabled') === 'on');

  return (
    <Panel title="Border & radius" id="inspector-border-radius">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <GroupSelect node={node} group={RADIUS_GROUP} label="Radius" fallback="none" readOnly={readOnly} />
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
      <GroupSelect node={node} group={SHADOW_GROUP} label="Shadow" fallback="none" readOnly={readOnly} />
    </Panel>
  );
}

// --- Opacity ---------------------------------------------------------------

function OpacitySection({ node, readOnly }: { node: TreeNode; readOnly: boolean }): React.ReactElement {
  return (
    <Panel title="Opacity" id="inspector-opacity">
      <GroupSelect node={node} group={OPACITY_GROUP} label="Opacity" fallback="100" readOnly={readOnly} />
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
    <Panel title={`${componentName} props`} id="inspector-component-props">
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
