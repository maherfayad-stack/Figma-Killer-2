import { describe, expect, it } from 'vitest';
import { dtcgToTokenModel, tokenModelToDtcg, type DtcgDocument } from './dtcg.js';
import { parseAlmosaferTokensJs } from './parse-almosafer.js';
import { findToken } from './types.js';

const FIXTURE = `
export const colors = { aqua100: '#0C9AB0', metal: '#1C1C1C', brandLabel: 'علامة تجارية' }
export const colorsDark = { aqua100: '#07ACC5', metal: '#F8F9F9' }
export const spacing = { base: 16, md: 12 }
export const rounded = { base: '12px' }
export const elevation = { floating: '0px -4px 16px rgba(0, 0, 0, 0.08)' }
export const typography = {
  display: { fontFamily: "'Open Sans', system-ui", fontSize: '34px', fontWeight: 600, lineHeight: '52px', letterSpacing: '-1px' },
}
`;

describe('DTCG interop — TokenModel <-> DTCG round-trip', () => {
  it('round-trips every token (name, group, cssVar, both theme values) through toDtcg -> fromDtcg', () => {
    const original = parseAlmosaferTokensJs(FIXTURE);
    const doc = tokenModelToDtcg(original);
    const roundTripped = dtcgToTokenModel(doc);

    const byKey = (t: { group: string; name: string }) => `${t.group}:${t.name}`;
    const originalSorted = [...original.tokens].sort((a, b) => byKey(a).localeCompare(byKey(b)));
    const roundTrippedSorted = [...roundTripped.tokens].sort((a, b) => byKey(a).localeCompare(byKey(b)));

    expect(roundTrippedSorted.map(byKey)).toEqual(originalSorted.map(byKey));
    for (let i = 0; i < originalSorted.length; i++) {
      expect(roundTrippedSorted[i]?.value).toEqual(originalSorted[i]?.value);
      expect(roundTrippedSorted[i]?.cssVar).toEqual(originalSorted[i]?.cssVar);
    }
  });

  it('produces a nested DTCG tree with $value/$type leaves per group', () => {
    const model = parseAlmosaferTokensJs(FIXTURE);
    const doc = tokenModelToDtcg(model);
    expect(doc.light.color).toBeDefined();
    const colorTree = doc.light.color as Record<string, { $value: unknown; $type: string }>;
    expect(colorTree.aqua100?.$value).toBe('#0C9AB0');
    expect(colorTree.aqua100?.$type).toBe('color');
    // nested typography path
    const typographyTree = doc.light.typography as Record<string, Record<string, { $value: unknown }>>;
    expect(typographyTree.display?.fontSize?.$value).toBe('34px');
  });

  it('round-trips an Arabic token value through DTCG byte-exact', () => {
    const model = parseAlmosaferTokensJs(FIXTURE);
    const doc = tokenModelToDtcg(model);
    const roundTripped = dtcgToTokenModel(doc);
    const brandLabel = findToken(roundTripped, 'color', 'brandLabel');
    expect(brandLabel?.value.light).toBe('علامة تجارية');
  });

  it('resolves a within-group DTCG alias reference and preserves it round-trip', () => {
    const doc: DtcgDocument = {
      light: {
        color: {
          aqua100: { $value: '#0C9AB0', $type: 'color' },
          primary: { $value: '{aqua100}', $type: 'color' },
        },
      },
      dark: {
        color: {
          aqua100: { $value: '#07ACC5', $type: 'color' },
          primary: { $value: '{aqua100}', $type: 'color' },
        },
      },
    };

    const model = dtcgToTokenModel(doc);
    const primary = findToken(model, 'color', 'primary');
    expect(primary?.value.light).toBe('#0C9AB0'); // resolved
    expect(primary?.value.dark).toBe('#07ACC5');
    expect(primary?.alias).toBe('aqua100');

    // export again — the alias TEXT round-trips, not just the resolved value
    const reExported = tokenModelToDtcg(model);
    const colorTree = reExported.light.color as Record<string, { $value: unknown }>;
    expect(colorTree.primary?.$value).toBe('{aqua100}');
  });
});
