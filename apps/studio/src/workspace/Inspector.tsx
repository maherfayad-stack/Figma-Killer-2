import * as React from 'react';
import type { TreeNode } from '@ccs/protocol';
import { Panel, Input, Select, Checkbox, Button } from '@ccs/ui';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useEngineApi } from '../engine/engine-api-context.js';
import { useWorkspaceStore } from './workspace-store.js';
import { useNodeOps } from './use-node-ops.js';
import type { PropSchemaEntry } from '../engine/engine-api.js';

/**
 * Inspector (right sidebar, playbook §2.3): sections shown/hidden by node
 * kind; every control emits a P3 `CanvasOp`; a `data-dynamic` node renders
 * READ-ONLY + "Open in IDE" (playbook §0 editable-surface contract, this
 * task's acceptance bullet 3).
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
  const nodeOps = useNodeOps();

  if (!node) {
    return (
      <Panel title="Design" id="inspector">
        <p style={{ color: 'var(--ccs-text-subtle)', fontSize: 'var(--ccs-font-size-sm)' }}>
          Select a layer to inspect it.
        </p>
      </Panel>
    );
  }

  if (node.dynamic) {
    return (
      <Panel title="Design" id="inspector">
        <div data-testid="dynamic-readonly" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-muted)' }}>
            <strong style={{ color: 'var(--ccs-locked)' }}>Dynamic node</strong> — generated in code
            (<code>.map()</code>/conditional). This is real code, not a limitation: edit its logic in the
            source file.
          </p>
          <dl style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>
            <dt>uid</dt>
            <dd style={{ marginInlineStart: 0, fontFamily: 'var(--ccs-font-mono)', wordBreak: 'break-all' }}>
              {node.uid}
            </dd>
          </dl>
          <Button variant="secondary" onClick={() => nodeOps.openInIde(node)}>
            Open in IDE
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <>
      <ContentSection node={node} />
      <LayoutSection node={node} />
      <FillSection node={node} />
      {node.kind === 'component-instance' && <ComponentPropsSection node={node} />}
    </>
  );
}

function ContentSection({ node }: { node: TreeNode }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const [text, setText] = React.useState('');

  return (
    <Panel title="Content" id="inspector-content">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendOp({ t: 'set-text', uid: node.uid, text });
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <Input
          label="Text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`New text for <${node.tag ?? 'node'}>`}
        />
        <Button type="submit" variant="primary" size="sm">
          Apply
        </Button>
      </form>
    </Panel>
  );
}

const LAYOUT_PRESETS: { id: string; label: string; add: string[] }[] = [
  { id: 'flex-row', label: 'Flex row', add: ['flex', 'flex-row'] },
  { id: 'flex-col', label: 'Flex col', add: ['flex', 'flex-col'] },
  { id: 'gap-2', label: 'Gap 2', add: ['gap-2'] },
  { id: 'items-center', label: 'Items center', add: ['items-center'] },
  { id: 'justify-center', label: 'Justify center', add: ['justify-center'] },
  { id: 'p-4', label: 'Padding 4', add: ['p-4'] },
];

function LayoutSection({ node }: { node: TreeNode }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  return (
    <Panel title="Layout" id="inspector-layout">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {LAYOUT_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant="secondary"
            size="sm"
            onClick={() => sendOp({ t: 'set-classes', uid: node.uid, add: preset.add, remove: [] })}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </Panel>
  );
}

function FillSection({ node }: { node: TreeNode }): React.ReactElement {
  const { sendOp } = useDaemonConnection();
  const engine = useEngineApi();
  const [tokenName, setTokenName] = React.useState('');
  const tokens = engine.tokensForProperty('background-color');

  return (
    <Panel title="Fill" id="inspector-fill">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Select
          label="Bind token"
          value={tokenName}
          onChange={(e) => setTokenName(e.target.value)}
          options={[{ value: '', label: 'Choose a token…' }, ...tokens.map((t) => ({ value: t.name, label: t.name }))]}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!tokenName}
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

function controlFor(
  propName: string,
  entry: PropSchemaEntry,
  value: unknown,
  onChange: (v: string | number | boolean) => void,
): React.ReactElement {
  if (entry.control === 'select' && entry.enum) {
    return (
      <Select
        key={propName}
        label={propName}
        value={String(value ?? entry.default ?? '')}
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
        defaultValue={String(value ?? entry.default ?? '')}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    );
  }
  return (
    <Input
      key={propName}
      label={propName}
      defaultValue={String(value ?? entry.default ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ComponentPropsSection({ node }: { node: TreeNode }): React.ReactElement | null {
  const { sendOp } = useDaemonConnection();
  const engine = useEngineApi();
  const componentName = (node.component ?? '').replace(/^ds:/, '');
  const schema = engine.getPropSchema(componentName);
  if (!schema) return null;

  return (
    <Panel title={`${componentName} props`} id="inspector-component-props">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Object.entries(schema.props).map(([propName, entry]) =>
          controlFor(propName, entry, undefined, (value) => {
            sendOp({ t: 'set-prop', uid: node.uid, name: propName, value });
          }),
        )}
      </div>
    </Panel>
  );
}
