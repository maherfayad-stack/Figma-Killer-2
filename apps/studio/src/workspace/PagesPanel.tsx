import * as React from 'react';
import { Panel, Button, Tooltip, Icon } from '@ccs/ui';

/**
 * PagesSection (playbook §2.2 `sitemap.cljs`; spec §5.2/§5.3) — the top
 * strip of the combined "Layers" tab (see `LayersPanel.tsx`, which stacks
 * this ABOVE the boards+elements tree).
 *
 * ADR-0024 D3: a "page" is a whole canvas SURFACE (a `tldraw` page,
 * eventually persisted in `.studio/canvas.json`). Our current model has
 * exactly ONE such surface per file, so this renders a single, static
 * "Page 1" row — always selected (it's the only one). The frames that used
 * to be listed HERE as "pages" are now BOARDS inside the Layers tree below
 * (`LayersPanel.tsx`'s `useDaemonConnection().frames`), per D3.
 *
 * Multi-page CRUD (add/rename/delete additional surfaces) is DEFERRED to a
 * later workstream (no `.studio/canvas.json` page persistence is invented
 * here) — the "Add page" button is rendered disabled with an explanatory
 * tooltip rather than faking a working control.
 */
export function PagesSection(): React.ReactElement {
  return (
    <Panel
      title="Pages"
      id="pages"
      actions={
        <Tooltip label="Multiple pages coming soon">
          <Button variant="icon" size="sm" disabled aria-label="Add page">
            <Icon name="add" size={12} />
          </Button>
        </Tooltip>
      }
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <li>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingInline: 8,
              paddingBlock: 5,
              borderRadius: 'var(--ccs-radius-sm)',
              fontSize: 'var(--ccs-font-size-sm)',
              background: 'var(--ccs-bg-selected)',
              color: 'var(--ccs-accent)',
            }}
          >
            <Icon name="document" size={16} />
            Page 1
          </span>
        </li>
      </ul>
    </Panel>
  );
}
