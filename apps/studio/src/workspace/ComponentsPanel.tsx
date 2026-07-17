import * as React from 'react';
import { Panel, Button, Input, Icon } from '@ccs/ui';
import { useEngineApi } from '../engine/engine-api-context.js';
import { useComponentInsert } from './use-component-insert.js';
import type { ComponentSummary, Token } from '../engine/engine-api.js';

type ViewMode = 'grid' | 'list';

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
 *
 * Structure (Penpot fidelity, spec §5.6): a non-collapsible header (title +
 * search + grid/list toggle), then a "Components" group of collapsible
 * per-`category` sections (Penpot's library -> asset-type -> folder
 * grouping, collapsed to one local library + one folder level since we
 * have a single DS catalog), followed by "Colors" and "Typographies"
 * sections read from `engine.tokenModel` (the engine has no dedicated
 * colors/typographies endpoint — §5.6: "Colors + Typographies = read from
 * token model" — so these are real token data, not fabricated).
 */
export function ComponentsPanel(): React.ReactElement {
  const engine = useEngineApi();
  const insertComponent = useComponentInsert();
  const [query, setQuery] = React.useState('');
  const [view, setView] = React.useState<ViewMode>('grid');

  const components = engine.listComponents();
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return components;
    return components.filter((c) => c.name.toLowerCase().includes(q));
  }, [components, query]);

  const groups = React.useMemo(() => groupByCategory(filtered), [filtered]);
  const { colors, typographies } = React.useMemo(() => tokenAssets(engine.tokenModel.sets), [engine.tokenModel.sets]);

  return (
    <div data-panel="assets">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--ccs-space-2)',
          paddingInline: 'var(--ccs-space-3)',
          paddingBlock: 'var(--ccs-space-2)',
          borderBlockEnd: '1px solid var(--ccs-border)',
        }}
      >
        <span
          style={{
            fontSize: 'var(--ccs-font-size-xs)',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--ccs-text-muted)',
            flex: 1,
          }}
        >
          Assets
        </span>
        <Input
          aria-label="Search components"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          trailing={<Icon name="search" size={12} />}
          style={{ maxInlineSize: 140 }}
        />
        <Button
          variant="icon"
          size="sm"
          active={view === 'grid'}
          aria-pressed={view === 'grid'}
          aria-label="Grid view"
          onClick={() => setView('grid')}
        >
          <Icon name="view-as-icons" size={16} />
        </Button>
        <Button
          variant="icon"
          size="sm"
          active={view === 'list'}
          aria-pressed={view === 'list'}
          aria-label="List view"
          onClick={() => setView('list')}
        >
          <Icon name="view-as-list" size={16} />
        </Button>
      </div>

      {groups.length > 0 && (
        <Panel title="Components" id="assets-components">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ccs-space-2)' }}>
            {groups.map(([category, items]) => (
              <CategoryGroup
                key={category}
                category={category}
                items={items}
                view={view}
                onInsert={insertComponent}
              />
            ))}
          </div>
        </Panel>
      )}
      {groups.length === 0 && (
        <Panel title="Components" id="assets-components">
          <p style={{ fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-subtle)' }}>
            {query.trim() ? (
              <>No components match &ldquo;{query}&rdquo;.</>
            ) : (
              // Empty query with an EMPTY catalog (no `.meta.ts` reachable) —
              // distinct from "your search matched nothing" (FIX-W3): never
              // show `No components match ""` for a query the user didn't
              // type. A non-empty catalog always takes the `groups.length >
              // 0` branch above once the query is empty (no filtering
              // applied), so this only renders when `listComponents()`
              // itself returned nothing.
              <>No components available.</>
            )}
          </p>
        </Panel>
      )}

      <Panel title="Colors" id="assets-colors" defaultCollapsed>
        {colors.length === 0 ? (
          <p style={{ fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-subtle)' }}>
            No color tokens in the current token model.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {colors.map((token) => (
              <div key={token.name} style={{ display: 'flex', alignItems: 'center', gap: 8, blockSize: 'var(--ccs-row-height-compact)' }}>
                <span
                  aria-hidden
                  style={{
                    inlineSize: 14,
                    blockSize: 14,
                    borderRadius: 'var(--ccs-radius-sm)',
                    border: '1px solid var(--ccs-border)',
                    background: token.value,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 'var(--ccs-font-size-sm)', flex: 1 }}>{token.name}</span>
                <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)', fontFamily: 'var(--ccs-font-mono)' }}>
                  {token.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Typographies" id="assets-typographies" defaultCollapsed>
        {typographies.length === 0 ? (
          <p style={{ fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-subtle)' }}>
            No typography tokens in the current token model.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {typographies.map((token) => (
              <div key={token.name} style={{ display: 'flex', alignItems: 'center', gap: 8, blockSize: 'var(--ccs-row-height-compact)' }}>
                <Icon name="text-typography" size={12} style={{ color: 'var(--ccs-icon)', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--ccs-font-size-sm)', flex: 1 }}>{token.name}</span>
                <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)', fontFamily: 'var(--ccs-font-mono)' }}>
                  {token.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function groupByCategory(components: ComponentSummary[]): Array<[string, ComponentSummary[]]> {
  const map = new Map<string, ComponentSummary[]>();
  for (const c of components) {
    const list = map.get(c.category);
    if (list) list.push(c);
    else map.set(c.category, [c]);
  }
  return Array.from(map.entries());
}

/** Colors/Typographies read straight from the engine's `tokenModel` (§5.6) —
 * flattened across sets, de-duped by name keeping the FIRST occurrence (the
 * base/"core" set), matching the same "which value wins" convention the
 * engine's own `tokensForProperty` uses. */
function tokenAssets(sets: { tokens: Token[] }[]): { colors: Token[]; typographies: Token[] } {
  const all = sets.flatMap((s) => s.tokens);
  const seen = new Set<string>();
  const deduped = all.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
  return {
    colors: deduped.filter((t) => t.type === 'color'),
    typographies: deduped.filter((t) => t.type === 'fontSize' || t.type === 'fontWeight' || t.group === 'typography'),
  };
}

function CategoryGroup({
  category,
  items,
  view,
  onInsert,
}: {
  category: string;
  items: ComponentSummary[];
  view: ViewMode;
  onInsert: (name: string) => void;
}): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState(false);
  const bodyId = React.useId();

  return (
    <div>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => setCollapsed((c) => !c)}
        style={{
          all: 'unset',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          fontSize: 'var(--ccs-font-size-xs)',
          color: 'var(--ccs-text-muted)',
          paddingBlock: 4,
          inlineSize: '100%',
        }}
      >
        <span
          aria-hidden
          style={{ display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 120ms ease' }}
        >
          ▾
        </span>
        {category}
        <span style={{ color: 'var(--ccs-text-subtle)' }}>{items.length}</span>
      </button>
      {!collapsed && (
        <div id={bodyId}>
          {view === 'grid' ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
                gap: 'var(--ccs-space-2)',
              }}
            >
              {items.map((c) => (
                <ComponentCard key={c.name} component={c} onInsert={onInsert} />
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {items.map((c) => (
                <ComponentRow key={c.name} component={c} onInsert={onInsert} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ComponentCard({ component, onInsert }: { component: ComponentSummary; onInsert: (name: string) => void }): React.ReactElement {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      title={component.description}
      onDragStart={(e) => e.dataTransfer.setData('text/ccs-component', component.name)}
      onClick={() => onInsert(component.name)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onInsert(component.name);
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: 'var(--ccs-space-2)',
        borderRadius: 'var(--ccs-radius-sm)',
        border: '1px solid var(--ccs-border)',
        background: 'var(--ccs-bg-panel-raised)',
        cursor: 'grab',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          inlineSize: '100%',
          blockSize: 48,
          borderRadius: 'var(--ccs-radius-sm)',
          background: 'var(--ccs-bg-canvas)',
          color: 'var(--ccs-icon)',
        }}
      >
        <Icon name="component" size={16} />
      </span>
      <span
        style={{
          fontSize: 'var(--ccs-font-size-xs)',
          color: 'var(--ccs-text)',
          textAlign: 'center',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxInlineSize: '100%',
        }}
      >
        {component.name}
      </span>
    </div>
  );
}

function ComponentRow({ component, onInsert }: { component: ComponentSummary; onInsert: (name: string) => void }): React.ReactElement {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      title={component.description}
      onDragStart={(e) => e.dataTransfer.setData('text/ccs-component', component.name)}
      onClick={() => onInsert(component.name)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onInsert(component.name);
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        blockSize: 'var(--ccs-row-height)',
        paddingInline: 'var(--ccs-space-1)',
        borderRadius: 'var(--ccs-radius-sm)',
        cursor: 'grab',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ccs-bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon name="component" size={16} style={{ color: 'var(--ccs-icon)', flexShrink: 0 }} />
      <span style={{ fontSize: 'var(--ccs-font-size-sm)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {component.name}
      </span>
      <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>{component.category}</span>
    </div>
  );
}
