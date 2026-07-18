import * as React from 'react';
import type { TreeNode } from '@ccs/protocol';
import { Panel, Button } from '@ccs/ui';
import type { ComputedStyleRow, StudioCanvasHandle } from '@ccs/canvas';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useNodeOps } from './use-node-ops.js';

/**
 * InspectPanel — FP-INS-b (`.orchestrator/FEATURE-PARITY-PLAN.md` "Inspect /
 * code tab", human dogfood ask: "an Inspect tab like Penpot where I can take
 * the page, component, or code of anything"). Mounted as the "Inspect" side
 * of the Design | Inspect `Tabs` toggle in `WorkspaceShell.tsx`'s right dock
 * (`Inspector.tsx` is the "Design" side, unchanged) — READ-ONLY, with copy
 * buttons, at every granularity the brief asks for:
 *   - the selected node's JSX ("component" — a component-instance's slice IS
 *     its `<Component .../>` usage code, satisfying "component" with zero
 *     special-casing);
 *   - the WHOLE FRAME's JSX ("page");
 *   - the selected node's computed CSS ("code" — Penpot's dev-mode CSS
 *     view).
 * Plus the existing "Open in IDE" affordance (`useNodeOps().openInIde`,
 * unchanged — reused verbatim, not reimplemented).
 *
 * PENPOT FIDELITY (cited per the orchestrator directive — `penpot/frontend/
 * src/app/main/ui/inspect/`):
 *  - `code.cljs` / `components/code_block.cljs`: a labeled code block
 *    (`<pre>`, dark background, monospace) with an adjacent "Copy" button
 *    per section — `CodeBlock` below is that shape, adapted to this
 *    project's `--ccs-*` tokens (`--ccs-bg-deepest` for the dark code
 *    surface, `--ccs-font-mono`) instead of Penpot's own SCSS/highlight.js.
 *    Penpot's real syntax highlighting (`app.util.code-highlight`, a
 *    dynamically-loaded module) is NOT reproduced here — plain monospace
 *    text, a disclosed simplification (no syntax-highlighter dependency
 *    added for this one view).
 *  - `attributes/layout.cljs` + `geometry.cljs` + `text.cljs` +
 *    `attributes/common.cljs`'s `color-row`: a CSS attribute is a
 *    label/value row (`:global/attr-label` / `:global/attr-value`) — `CssRows`
 *    below reproduces that row shape, grouped exactly like those files split
 *    their own sections (layout / geometry / typography / fill=color —
 *    `@ccs/bridge`'s `computed-style.ts` groups its curated property list
 *    the same way). Penpot gives EVERY row its own `copy-button*`; this pass
 *    ships ONE "Copy CSS" button for the whole curated block (the task's
 *    literal acceptance ask: "COMPUTED CSS ... with a Copy button") rather
 *    than N per-row buttons — a disclosed, minor scope trim, not a fidelity
 *    gap in what's shown.
 */

export interface InspectPanelProps {
  /** `null` until `StudioCanvas`'s `onReady` fires — mirrors how
   * `RightHeader`/`ZoomWidget` already accept this. `requestComputedStyle`
   * is a no-op-safe method on the handle itself (resolves `{ok:false,
   * reason:'not-found'}` when no bridge connection is live), so this
   * component never needs to special-case a `null` handle beyond disabling
   * nothing extra. */
  canvasHandle: StudioCanvasHandle | null;
  /** FP-INS-b (AUDIT-FPINSb major fix): bumped by `WorkspaceShell` every time
   * the edit-mode frame's bridge (re)connects (`StudioCanvas.
   * onBridgeConnectionChange`). The computed-CSS effect depends on it so it
   * re-fetches once the bridge is actually live — see `InspectContent`'s CSS
   * effect for the full "why a one-shot fetch loses the race" rationale. */
  bridgeGeneration: number;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Penpot `code_block.cljs` + `copy-button*`, adapted: a labeled `<pre>`
 * code surface with a "Copy" button. `code: null` means "still loading /
 * unavailable" (e.g. the daemon isn't connected yet, or the read was
 * rejected) — rendered as a muted placeholder, Copy disabled, never a blank
 * flash of empty content that could be mistaken for "this node has no
 * code". The code surface itself is always LTR content (source code), even
 * though this component's own chrome (labels/buttons) is logical-property
 * RTL-aware, per this task's hard constraint. */
function CodeBlock({ label, code, testId }: { label: string; code: string | null; testId: string }): React.ReactElement {
  const [justCopied, setJustCopied] = React.useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minInlineSize: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minInlineSize: 0 }}>
        {/* FIX-W7 (R3-2): the last offender found by dogfooding at the new
            narrow min-width — `label` is often a path with no spaces
            (`Frame — src/frames/Frame4.tsx`), an unbreakable run with
            no natural wrap point. As a flex item with `overflow: visible`
            (the default), its automatic min-width was that whole run's
            width, forcing this row (and everything up to the dock) wider
            than the pane at small sizes. Same ellipsis treatment as the
            CSS-row values above: `minInlineSize: 0` lets it actually
            shrink, `overflow/textOverflow/whiteSpace` clip it instead. */}
        <span
          style={{
            fontSize: 'var(--ccs-font-size-xs)',
            fontWeight: 600,
            color: 'var(--ccs-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minInlineSize: 0,
          }}
          title={label}
        >
          {label}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!code}
          data-testid={`${testId}-copy`}
          onClick={async () => {
            if (!code) return;
            const ok = await copyToClipboard(code);
            if (ok) {
              setJustCopied(true);
              setTimeout(() => setJustCopied(false), 1200);
            }
          }}
        >
          {justCopied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        data-testid={testId}
        dir="ltr"
        style={{
          margin: 0,
          maxBlockSize: 240,
          minInlineSize: 0,
          overflow: 'auto',
          paddingInline: 'var(--ccs-space-2)',
          paddingBlock: 'var(--ccs-space-2)',
          background: 'var(--ccs-bg-deepest)',
          border: '1px solid var(--ccs-border)',
          borderRadius: 'var(--ccs-radius-sm)',
          fontFamily: 'var(--ccs-font-mono)',
          fontSize: 'var(--ccs-font-size-xs)',
          lineHeight: 1.5,
          color: code ? 'var(--ccs-text-accent)' : 'var(--ccs-text-subtle)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {code ?? 'Loading…'}
      </pre>
    </div>
  );
}

const GROUP_LABEL: Record<ComputedStyleRow['group'], string> = {
  layout: 'Layout',
  geometry: 'Size & position',
  typography: 'Typography',
  color: 'Color',
};

/** Penpot's `attributes/*.cljs` grouped attribute rows, adapted: label/value
 * pairs grouped by section, monospace value column. */
function CssRows({ rows }: { rows: ComputedStyleRow[] | null }): React.ReactElement {
  if (!rows) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-subtle)' }}>Loading…</p>
    );
  }
  if (rows.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-subtle)' }}>
        No computed style available for this node.
      </p>
    );
  }

  const byGroup = new Map<ComputedStyleRow['group'], ComputedStyleRow[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group) ?? [];
    list.push(row);
    byGroup.set(row.group, list);
  }

  return (
    <div
      data-testid="inspect-css-rows"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, minInlineSize: 0 }}
    >
      {[...byGroup.entries()].map(([group, groupRows]) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 4, minInlineSize: 0 }}>
          <span
            style={{
              fontSize: 'var(--ccs-font-size-xs)',
              color: 'var(--ccs-text-subtle)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {GROUP_LABEL[group]}
          </span>
          {groupRows.map((row) => (
            <div
              key={row.prop}
              data-testid={`inspect-css-row-${row.prop}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 'var(--ccs-font-size-xs)',
                paddingBlock: 2,
                minInlineSize: 0,
              }}
            >
              <span
                style={{
                  color: 'var(--ccs-text-muted)',
                  fontFamily: 'var(--ccs-font-mono)',
                  flexShrink: 0,
                }}
              >
                {row.prop}
              </span>
              {/* FIX-W7 (R3-2): this is the row that was overflowing the whole
                  right dock — a long comma-separated `font-family` stack is
                  `nowrap` + ellipsis, but a flex child's default
                  `min-inline-size: auto` refuses to shrink below its OWN
                  content width no matter what `maxInlineSize` says, so the
                  ellipsis never actually triggered; it just pushed this row
                  (and everything above it up to the dock) wider. Explicit
                  `minInlineSize: 0` overrides that default so the `60%` cap
                  + `overflow:hidden` + `textOverflow:ellipsis` combination
                  can actually clip, instead of only being reachable in
                  theory. */}
              <span
                style={{
                  color: 'var(--ccs-text)',
                  fontFamily: 'var(--ccs-font-mono)',
                  textAlign: 'end',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxInlineSize: '60%',
                  minInlineSize: 0,
                }}
                title={row.value}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function InspectPanel({ canvasHandle, bridgeGeneration }: InspectPanelProps): React.ReactElement {
  // NOTE (same fix `Inspector.tsx` documents): call `selectedNode()`
  // INSIDE the zustand selector so this subscribes to the COMPUTED value,
  // not the stable function reference.
  const node = useWorkspaceStore((s) => s.selectedNode());
  const fileFolder = useWorkspaceStore((s) => s.fileFolder);
  const framePath = useWorkspaceStore((s) => s.framePath);

  if (!node || !fileFolder || !framePath) {
    return (
      <Panel title="Inspect" id="inspect-empty">
        <p style={{ margin: 0, fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-subtle)', textAlign: 'center' }}>
          Select a layer to inspect its code.
        </p>
      </Panel>
    );
  }

  // Keyed by `node.uid` — the SAME `react-hooks/set-state-in-effect`-safe
  // pattern `Inspector.tsx`'s module doc documents (its own "adjust state
  // when a prop changes" escape hatch): a NEW selection remounts
  // `InspectContent` fresh (clean `useState(null)` initializers), so its own
  // effect below never needs to reset state synchronously at the top of the
  // effect body — a genuinely different uid is a different component
  // instance, not a re-run of the same one. A tree-snapshot broadcast that
  // only changes `node`'s OBJECT IDENTITY (same uid, e.g. after an
  // unrelated edit elsewhere in the frame) does NOT remount — the effect
  // below depends on `node.uid` (a primitive), not the whole `node` object,
  // so it doesn't needlessly re-fetch either.
  return (
    <InspectContent
      key={node.uid}
      node={node}
      fileFolder={fileFolder}
      framePath={framePath}
      canvasHandle={canvasHandle}
      bridgeGeneration={bridgeGeneration}
    />
  );
}

function InspectContent({
  node,
  fileFolder,
  framePath,
  canvasHandle,
  bridgeGeneration,
}: {
  node: TreeNode;
  fileFolder: string;
  framePath: string;
  canvasHandle: StudioCanvasHandle | null;
  bridgeGeneration: number;
}): React.ReactElement {
  const { requestReadSource } = useDaemonConnection();
  const nodeOps = useNodeOps();

  const [nodeSource, setNodeSource] = React.useState<string | null>(null);
  const [frameSource, setFrameSource] = React.useState<string | null>(null);
  const [cssRows, setCssRows] = React.useState<ComputedStyleRow[] | null>(null);

  // Source reads go through the daemon control-ws, which is connected
  // independently of any frame's bridge — so a plain mount-time fetch (keyed
  // on the node/frame via this component's `key={node.uid}` remount) is
  // correct and never needs the bridge-generation retry the CSS fetch below
  // does.
  React.useEffect(() => {
    let cancelled = false;
    void requestReadSource(fileFolder, framePath, node.uid).then((result) => {
      if (!cancelled) setNodeSource(result.ok ? result.source : null);
    });
    void requestReadSource(fileFolder, framePath).then((result) => {
      if (!cancelled) setFrameSource(result.ok ? result.source : null);
    });
    return () => {
      cancelled = true;
    };
    // `node.uid` (not the whole `node` object) — see `InspectPanel`'s doc
    // above for why this must stay a primitive dependency.
  }, [node.uid, fileFolder, framePath, requestReadSource]);

  // Computed CSS goes through the CANVAS bridge, which only exists for a
  // LIVE frame. `StudioCanvasHandle.requestComputedStyle` resolves
  // `{ok:false}` while no bridge is connected, and selecting a node via the
  // Layers panel only brings its (possibly off-screen, screenshot-mode)
  // frame live AFTER the selection (`frame-shape.tsx`'s edit-mode force-live)
  // — so a one-shot mount-time fetch loses that race (AUDIT-FPINSb major).
  // Depending on `bridgeGeneration` (bumped by `WorkspaceShell` on every
  // bridge (re)connect) re-runs this the moment the bridge is actually up.
  // Only ever OVERWRITE `cssRows` on success: a transient `{ok:false}` (e.g.
  // the frame briefly going screenshot-mode on a zoom-out, bumping the
  // generation with no live bridge) keeps the last-known-good values rather
  // than flashing back to "Loading…" — within one selected node the CSS is
  // stable anyway (it's the node's own resolved style), and a genuinely new
  // selection remounts this component fresh via `key={node.uid}`.
  React.useEffect(() => {
    let cancelled = false;
    void canvasHandle?.requestComputedStyle(node.uid).then((result) => {
      if (!cancelled && result.ok) setCssRows(result.info.rows);
    });
    return () => {
      cancelled = true;
    };
  }, [node.uid, canvasHandle, bridgeGeneration]);

  const nodeLabel =
    node.kind === 'component-instance'
      ? `Component — <${node.component?.replace(/^ds:/, '') ?? node.tag}>`
      : `Node — <${node.tag ?? 'text'}>`;
  const frameLabel = `Frame — ${framePath}`;

  return (
    <>
      <Panel title="Code" id="inspect-code">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minInlineSize: 0 }}>
          <CodeBlock label={nodeLabel} code={nodeSource} testId="inspect-node-code" />
          <CodeBlock label={frameLabel} code={frameSource} testId="inspect-frame-code" />
        </div>
      </Panel>

      <Panel title="CSS" id="inspect-css">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minInlineSize: 0 }}>
          <CssRows rows={cssRows} />
          <Button
            variant="secondary"
            size="sm"
            disabled={!cssRows || cssRows.length === 0}
            data-testid="inspect-css-copy"
            onClick={() => {
              if (!cssRows) return;
              const text = cssRows.map((row) => `${row.prop}: ${row.value};`).join('\n');
              void copyToClipboard(text);
            }}
          >
            Copy CSS
          </Button>
        </div>
      </Panel>

      <Panel title="Code file" id="inspect-open-ide" defaultCollapsed>
        <Button variant="secondary" size="sm" onClick={() => nodeOps.openInIde(node)}>
          Open in IDE
        </Button>
      </Panel>
    </>
  );
}
