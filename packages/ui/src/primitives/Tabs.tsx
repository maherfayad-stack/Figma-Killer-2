import * as React from 'react';

/**
 * Tabs — used by the left dock (Pages/Layers/Assets/Tokens, playbook §2.2)
 * and the right dock (Design/Interactions/Inspect, §2.3). Full roving
 * tabindex + arrow-key nav per WAI-ARIA tabs pattern — logical-direction
 * aware so ArrowRight/ArrowLeft feel natural in both `dir="ltr"` and
 * `dir="rtl"` (flipped based on computed `dir`, not hardcoded).
 */
export interface TabItem {
  id: string;
  label: string;
  content: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  onValueChange?: (id: string) => void;
  ariaLabel: string;
}

export function Tabs({ items, value, onValueChange, ariaLabel }: TabsProps): React.ReactElement {
  const [internal, setInternal] = React.useState(items[0]?.id ?? '');
  const active = value ?? internal;
  const listRef = React.useRef<HTMLDivElement>(null);

  function select(id: string) {
    setInternal(id);
    onValueChange?.(id);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const idx = items.findIndex((t) => t.id === active);
    if (idx === -1) return;
    // Resolve writing direction from the nearest `dir` attribute rather than
    // `getComputedStyle` — deterministic under jsdom (no UA stylesheet
    // mapping `[dir]` -> CSS `direction`) and in real browsers alike.
    const dirAttr = (e.currentTarget.closest('[dir]') as HTMLElement | null)?.dir || document.dir || 'ltr';
    const dir = dirAttr === 'rtl' ? -1 : 1;
    let next: number;
    if (e.key === 'ArrowRight') next = (idx + dir + items.length) % items.length;
    else if (e.key === 'ArrowLeft') next = (idx - dir + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    const nextItem = items[next];
    if (!nextItem) return;
    select(nextItem.id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  const activeItem = items.find((t) => t.id === active);

  return (
    <div className="ccs-tabs" style={{ display: 'flex', flexDirection: 'column', minBlockSize: 0, flex: 1 }}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        style={{ display: 'flex', borderBlockEnd: '1px solid var(--ccs-border)', flexShrink: 0 }}
      >
        {items.map((item) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              role="tab"
              type="button"
              id={`tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`tabpanel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(item.id)}
              style={{
                all: 'unset',
                flex: 1,
                textAlign: 'center',
                paddingBlock: 8,
                fontSize: 'var(--ccs-font-size-xs)',
                fontWeight: 600,
                color: selected ? 'var(--ccs-text)' : 'var(--ccs-text-muted)',
                borderBlockEnd: selected ? '2px solid var(--ccs-accent)' : '2px solid transparent',
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {activeItem && (
        <div
          role="tabpanel"
          id={`tabpanel-${activeItem.id}`}
          aria-labelledby={`tab-${activeItem.id}`}
          style={{ flex: 1, minBlockSize: 0, overflow: 'auto' }}
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
}
