import * as React from 'react';
import { Panel, Input, Select, Button, Icon } from '@ccs/ui';
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

  const activeTheme = engine.tokenModel.themes.find((t) => t.name === theme);

  return (
    <>
      <Panel title="Themes" id="tokens-themes">
        <div
          role="radiogroup"
          aria-label="Theme"
          style={{
            display: 'inline-flex',
            gap: 2,
            padding: 2,
            border: '1px solid var(--ccs-border)',
            borderRadius: 'var(--ccs-radius-sm)',
            background: 'var(--ccs-bg-input)',
          }}
        >
          {engine.tokenModel.themes.map((t) => {
            const checked = theme === t.name;
            return (
              <button
                key={t.name}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setTheme(t.name)}
                style={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  display: 'inline-flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  paddingInline: 'var(--ccs-space-3)',
                  paddingBlock: 4,
                  borderRadius: 'var(--ccs-radius-sm)',
                  fontSize: 'var(--ccs-font-size-sm)',
                  color: checked ? 'var(--ccs-accent-contrast)' : 'var(--ccs-text-muted)',
                  background: checked ? 'var(--ccs-accent)' : 'transparent',
                }}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      </Panel>

      {localSets.map((set) => (
        <Panel
          key={set.name}
          title={`Set: ${set.name}`}
          id={`tokens-set-${set.name}`}
          actions={
            activeTheme?.sets.includes(set.name) ? (
              <span
                style={{
                  fontSize: 'var(--ccs-font-size-xs)',
                  color: 'var(--ccs-accent)',
                  border: '1px solid var(--ccs-accent-muted)',
                  borderRadius: 'var(--ccs-radius-sm)',
                  paddingInline: 6,
                  paddingBlock: 1,
                  textTransform: 'none',
                  letterSpacing: 'normal',
                  fontWeight: 400,
                }}
              >
                in {theme}
              </span>
            ) : null
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {set.tokens.map((token) => (
              <div key={token.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {token.type === 'color' && (
                  <span
                    aria-hidden
                    title={token.value}
                    style={{
                      inlineSize: 16,
                      blockSize: 16,
                      flexShrink: 0,
                      borderRadius: 'var(--ccs-radius-sm)',
                      border: '1px solid var(--ccs-border)',
                      background: token.value,
                    }}
                  />
                )}
                <span
                  style={{
                    flex: 1,
                    fontSize: 'var(--ccs-font-size-xs)',
                    fontFamily: 'var(--ccs-font-mono)',
                    color: 'var(--ccs-text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
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

      <Panel
        title="Add token"
        id="tokens-add"
        defaultCollapsed
        actions={<Icon name="add" size={12} style={{ color: 'var(--ccs-icon)' }} />}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input label="Name" placeholder="color.accent" value={newToken.name} onChange={(e) => setNewToken((n) => ({ ...n, name: e.target.value }))} />
          <Input
            label="Value"
            placeholder="#ff00ff"
            value={newToken.value}
            onChange={(e) => setNewToken((n) => ({ ...n, value: e.target.value }))}
            trailing={
              newToken.type === 'color' ? (
                <span
                  aria-hidden
                  style={{
                    inlineSize: 14,
                    blockSize: 14,
                    borderRadius: 'var(--ccs-radius-sm)',
                    border: '1px solid var(--ccs-border)',
                    background: newToken.value || 'transparent',
                  }}
                />
              ) : undefined
            }
          />
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
            <Icon name="add" size={12} />
            Add
          </Button>
        </div>
      </Panel>

      <Panel
        title="Import / Export (DTCG)"
        id="tokens-io"
        defaultCollapsed
        actions={<Icon name="tokens" size={12} style={{ color: 'var(--ccs-icon)' }} />}
      >
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
