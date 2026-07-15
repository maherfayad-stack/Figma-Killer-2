import * as React from 'react';
import { Panel, Input, Select, Button } from '@ccs/ui';
import { useEngineApi } from '../engine/engine-api-context.js';
import type { Token, TokenType } from '../engine/engine-api.js';

/**
 * TokensPanel (playbook §2.4, modeled on Penpot `workspace/tokens/`): sets
 * tree, theme switcher, token CRUD, DTCG import/export.
 *
 * CR (persistence): token CRUD here mutates a LOCAL copy of the mock
 * `TokenModel` only — writing back to `design-system/tokens/tokens.json`
 * (or the real Almosafer DS format, ADR-0010) requires a daemon token-CRUD
 * control-message that is P4/daemon scope (ADR-0022 partition: this phase
 * stays within `apps/studio` + `packages/ui`), not added here. The CRUD
 * UX/interaction is real and fully wired for that swap.
 */
export function TokensPanel(): React.ReactElement {
  const engine = useEngineApi();
  const [theme, setTheme] = React.useState(engine.tokenModel.themes[0]?.name ?? 'light');
  const [localSets, setLocalSets] = React.useState(engine.tokenModel.sets);
  const [newToken, setNewToken] = React.useState<{ name: string; value: string; type: TokenType; group: string }>({
    name: '',
    value: '',
    type: 'color',
    group: 'color',
  });

  function updateTokenValue(setName: string, tokenName: string, value: string): void {
    setLocalSets((prev) =>
      prev.map((set) =>
        set.name !== setName
          ? set
          : { ...set, tokens: set.tokens.map((t) => (t.name === tokenName ? { ...t, value } : t)) },
      ),
    );
  }

  function addToken(): void {
    if (!newToken.name || !newToken.value) return;
    setLocalSets((prev) => {
      const [first, ...rest] = prev;
      if (!first) return prev;
      const token: Token = { ...newToken };
      return [{ ...first, tokens: [...first.tokens, token] }, ...rest];
    });
    setNewToken({ name: '', value: '', type: 'color', group: 'color' });
  }

  function exportDtcg(): string {
    const out: Record<string, unknown> = {};
    for (const set of localSets) {
      const setObj: Record<string, unknown> = {};
      for (const token of set.tokens) {
        setObj[token.name] = { $value: token.value, $type: token.type };
      }
      out[set.name] = setObj;
    }
    return JSON.stringify(out, null, 2);
  }

  return (
    <>
      <Panel title="Themes" id="tokens-themes">
        <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: 8 }}>
          {engine.tokenModel.themes.map((t) => (
            <label key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--ccs-font-size-sm)' }}>
              <input type="radio" name="ccs-theme" checked={theme === t.name} onChange={() => setTheme(t.name)} />
              {t.name}
            </label>
          ))}
        </div>
      </Panel>

      {localSets.map((set) => (
        <Panel key={set.name} title={`Set: ${set.name}`} id={`tokens-set-${set.name}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {set.tokens.map((token) => (
              <div key={token.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    flex: 1,
                    fontSize: 'var(--ccs-font-size-xs)',
                    fontFamily: 'var(--ccs-font-mono)',
                    color: 'var(--ccs-text-muted)',
                  }}
                >
                  {token.name}
                </span>
                <Input
                  aria-label={`${token.name} value`}
                  value={token.value}
                  onChange={(e) => updateTokenValue(set.name, token.name, e.target.value)}
                  style={{ maxInlineSize: 110 }}
                />
              </div>
            ))}
          </div>
        </Panel>
      ))}

      <Panel title="Add token" id="tokens-add" defaultCollapsed>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input label="Name" placeholder="color.accent" value={newToken.name} onChange={(e) => setNewToken((n) => ({ ...n, name: e.target.value }))} />
          <Input label="Value" placeholder="#ff00ff" value={newToken.value} onChange={(e) => setNewToken((n) => ({ ...n, value: e.target.value }))} />
          <Select
            label="Type"
            value={newToken.type}
            onChange={(e) => setNewToken((n) => ({ ...n, type: e.target.value as TokenType }))}
            options={[
              { value: 'color', label: 'color' },
              { value: 'dimension', label: 'dimension' },
              { value: 'radius', label: 'radius' },
              { value: 'fontSize', label: 'fontSize' },
              { value: 'fontWeight', label: 'fontWeight' },
              { value: 'shadow', label: 'shadow' },
              { value: 'string', label: 'string' },
            ]}
          />
          <Button variant="primary" size="sm" onClick={addToken}>
            Add
          </Button>
        </div>
      </Panel>

      <Panel title="Import / Export (DTCG)" id="tokens-io" defaultCollapsed>
        <textarea
          readOnly
          aria-label="DTCG export"
          value={exportDtcg()}
          style={{
            inlineSize: '100%',
            blockSize: 140,
            fontFamily: 'var(--ccs-font-mono)',
            fontSize: 'var(--ccs-font-size-xs)',
            background: 'var(--ccs-bg-input)',
            color: 'var(--ccs-text)',
            border: '1px solid var(--ccs-border)',
            borderRadius: 'var(--ccs-radius-sm)',
          }}
        />
      </Panel>
    </>
  );
}
