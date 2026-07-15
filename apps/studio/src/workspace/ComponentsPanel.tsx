import * as React from 'react';
import { Panel, Button } from '@ccs/ui';
import { useEngineApi } from '../engine/engine-api-context.js';
import { useComponentInsert } from './use-component-insert.js';

/**
 * ComponentsPanel (playbook §2.2 `assets.cljs` / §4/P4-P5 seam, ADR-0022):
 * reads the mocked P4 catalog (`listComponents`/`getPropSchema`). "Insert"
 * emits `insert-node` (`ds-component`) then follow-up `set-prop` ops for
 * every REQUIRED prop that has a schema default — client-side defaulting,
 * exactly the ADR-0021 pattern real P4 data will also use.
 *
 * CR (uid prediction): the follow-up `set-prop`s need the NEW node's uid,
 * which no daemon reply currently hands back (the daemon's `uid-remap`
 * only covers SURVIVING existing nodes, ADR-0018 item 4). This computes it
 * from the frozen astPath encoding (ADR-0017: a child's path is
 * `<parentAstPath>.<siblingIndex>`) — correct for the common case
 * (appending as the last child), but can drift if ast-engine's real
 * sibling counting skips something this mock tree doesn't model (e.g.
 * whitespace-only JSXText nodes). Flagged, not silently assumed perfect.
 */
export function ComponentsPanel(): React.ReactElement {
  const engine = useEngineApi();
  const insertComponent = useComponentInsert();
  const components = engine.listComponents();

  return (
    <Panel title="Components" id="components">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {components.map((c) => (
          <div
            key={c.name}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/ccs-component', c.name)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              paddingInline: 8,
              paddingBlock: 6,
              borderRadius: 'var(--ccs-radius-sm)',
              border: '1px solid var(--ccs-border)',
              background: 'var(--ccs-bg-panel-raised)',
            }}
          >
            <span>
              <div style={{ fontSize: 'var(--ccs-font-size-sm)' }}>{c.name}</div>
              <div style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>{c.category}</div>
            </span>
            <Button variant="secondary" size="sm" onClick={() => insertComponent(c.name)}>
              Insert
            </Button>
          </div>
        ))}
      </div>
    </Panel>
  );
}
