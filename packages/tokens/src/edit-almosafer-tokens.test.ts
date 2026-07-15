import { describe, expect, it } from 'vitest';
import { createToken, deleteToken, resolveExportName, setTokenValue, TokenEditError } from './edit-almosafer-tokens.js';
import { parseAlmosaferTokensJs } from './parse-almosafer.js';
import { findToken } from './types.js';

const FIXTURE = `export const colors = {
  // Neutral
  metal:     '#1C1C1C',
  aqua100:   '#0C9AB0',
}

export const colorsDark = {
  metal: '#F8F9F9',
}

export const spacing = {
  unit: 8,
  md:   12,
  '2xl': 40,
}

export const rounded = {
  base: '12px',
}

export const elevation = {
  floating: '0px -4px 16px rgba(0, 0, 0, 0.08)',
}
`;

describe('resolveExportName', () => {
  it('maps color+theme to colors/colorsDark', () => {
    expect(resolveExportName('color', 'light')).toBe('colors');
    expect(resolveExportName('color', 'dark')).toBe('colorsDark');
  });
  it('maps theme-independent groups regardless of theme', () => {
    expect(resolveExportName('spacing', 'light')).toBe('spacing');
    expect(resolveExportName('spacing', 'dark')).toBe('spacing');
    expect(resolveExportName('rounded', 'light')).toBe('rounded');
    expect(resolveExportName('elevation', 'dark')).toBe('elevation');
  });
  it('returns undefined for typography (v1 CRUD scope, see module doc)', () => {
    expect(resolveExportName('typography', 'light')).toBeUndefined();
  });
});

describe('setTokenValue', () => {
  it('updates an existing color value, preserving the rest of the file byte-for-byte', () => {
    const updated = setTokenValue(FIXTURE, { exportName: 'colors', key: 'aqua100' }, '#123456');
    // AUDIT-7 minor close-out: the written literal now reuses the FIXTURE's
    // own single-quote convention instead of always flipping to double
    // quotes (JSON.stringify) — see the dedicated
    // "quote-style preservation" describe block below for full coverage.
    expect(updated).toContain("aqua100:   '#123456'");
    expect(updated).toContain("metal:     '#1C1C1C'"); // untouched sibling, formatting preserved

    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'color', 'aqua100')?.value.light).toBe('#123456');
  });

  it('updates a numeric spacing value', () => {
    const updated = setTokenValue(FIXTURE, { exportName: 'spacing', key: 'md' }, 20);
    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'spacing', 'md')?.value.light).toBe(20);
  });

  it('round-trips an Arabic value', () => {
    const updated = setTokenValue(FIXTURE, { exportName: 'colors', key: 'metal' }, 'علامة');
    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'color', 'metal')?.value.light).toBe('علامة');
  });

  it('throws TokenEditError for a missing token', () => {
    expect(() => setTokenValue(FIXTURE, { exportName: 'colors', key: 'nope' }, '#000')).toThrow(TokenEditError);
  });

  it('updates a digit-leading key that is quoted in source ("2xl") — regression for property-name.ts', () => {
    // ts-morph's `getProperty('2xl')` (unquoted) does NOT find a `'2xl':`
    // declaration (exact source-text match); `getPropertyByLogicalName`
    // must be used instead. Without that fix this throws TokenEditError
    // "token \"2xl\" not found" even though the key visibly exists.
    const updated = setTokenValue(FIXTURE, { exportName: 'spacing', key: '2xl' }, 48);
    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'spacing', '2xl')?.value.light).toBe(48);
    expect(findToken(reparsed, 'spacing', '2xl')?.cssVar).toBe('--space-2xl');
  });
});

describe('createToken', () => {
  it('adds a new token to an existing export', () => {
    const updated = createToken(FIXTURE, { exportName: 'colors', key: 'coral100' }, '#EF4550');
    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'color', 'coral100')?.value.light).toBe('#EF4550');
    // existing tokens still present
    expect(findToken(reparsed, 'color', 'aqua100')?.value.light).toBe('#0C9AB0');
  });

  it('throws TokenEditError if the token already exists', () => {
    expect(() => createToken(FIXTURE, { exportName: 'colors', key: 'aqua100' }, '#000')).toThrow(TokenEditError);
  });

  it('throws TokenEditError when the "already exists" check must match a quoted digit-leading key', () => {
    expect(() => createToken(FIXTURE, { exportName: 'spacing', key: '2xl' }, 999)).toThrow(TokenEditError);
  });
});

describe('deleteToken', () => {
  it('removes an existing token', () => {
    const updated = deleteToken(FIXTURE, { exportName: 'colors', key: 'aqua100' });
    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'color', 'aqua100')).toBeUndefined();
    expect(findToken(reparsed, 'color', 'metal')?.value.light).toBe('#1C1C1C');
  });

  it('throws TokenEditError for a missing token', () => {
    expect(() => deleteToken(FIXTURE, { exportName: 'colors', key: 'nope' })).toThrow(TokenEditError);
  });

  it('removes a quoted digit-leading key ("2xl")', () => {
    const updated = deleteToken(FIXTURE, { exportName: 'spacing', key: '2xl' });
    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'spacing', '2xl')).toBeUndefined();
    expect(findToken(reparsed, 'spacing', 'md')?.value.light).toBe(12); // untouched sibling
  });
});

describe('CRUD composition — create then update then delete round-trips cleanly', () => {
  it('supports the full lifecycle of one token', () => {
    let text = createToken(FIXTURE, { exportName: 'spacing', key: 'xxl' }, 80);
    expect(findToken(parseAlmosaferTokensJs(text), 'spacing', 'xxl')?.value.light).toBe(80);

    text = setTokenValue(text, { exportName: 'spacing', key: 'xxl' }, 96);
    expect(findToken(parseAlmosaferTokensJs(text), 'spacing', 'xxl')?.value.light).toBe(96);

    text = deleteToken(text, { exportName: 'spacing', key: 'xxl' });
    expect(findToken(parseAlmosaferTokensJs(text), 'spacing', 'xxl')).toBeUndefined();
  });
});

// ---- AUDIT-7 minor — quote-style preservation (real DS repo diff noise) --

describe('quote-style preservation (AUDIT-7 minor)', () => {
  it('setTokenValue on a single-quoted tokens.js keeps single quotes (does not flip to double)', () => {
    const updated = setTokenValue(FIXTURE, { exportName: 'colors', key: 'aqua100' }, '#123456');
    expect(updated).toContain("aqua100:   '#123456'");
    expect(updated).not.toContain('"#123456"');
  });

  it('createToken on a single-quoted tokens.js adds a single-quoted literal', () => {
    const updated = createToken(FIXTURE, { exportName: 'colors', key: 'coral100' }, '#EF4550');
    expect(updated).toContain("coral100: '#EF4550'");
    expect(updated).not.toMatch(/coral100:\s*"#EF4550"/);
  });

  it('setTokenValue on a double-quoted tokens.js keeps double quotes', () => {
    const doubleQuotedFixture = `export const colors = {\n  aqua100: "#0C9AB0",\n}\n`;
    const updated = setTokenValue(doubleQuotedFixture, { exportName: 'colors', key: 'aqua100' }, '#123456');
    expect(updated).toContain('aqua100: "#123456"');
    expect(updated).not.toContain("'#123456'");
  });

  it('createToken on a double-quoted tokens.js adds a double-quoted literal (sibling-style inference)', () => {
    const doubleQuotedFixture = `export const colors = {\n  aqua100: "#0C9AB0",\n}\n`;
    const updated = createToken(doubleQuotedFixture, { exportName: 'colors', key: 'coral100' }, '#EF4550');
    expect(updated).toContain('coral100: "#EF4550"');
  });

  it('a set→revert round-trip leaves the file byte-identical', () => {
    const changed = setTokenValue(FIXTURE, { exportName: 'colors', key: 'aqua100' }, '#DEADBEEF'.slice(0, 7));
    const reverted = setTokenValue(changed, { exportName: 'colors', key: 'aqua100' }, '#0C9AB0');
    expect(reverted).toBe(FIXTURE);
  });

  it('escapes an embedded quote character matching the chosen delimiter', () => {
    const updated = setTokenValue(FIXTURE, { exportName: 'colors', key: 'aqua100' }, "it's fine");
    const reparsed = parseAlmosaferTokensJs(updated);
    expect(findToken(reparsed, 'color', 'aqua100')?.value.light).toBe("it's fine");
    expect(updated).toContain("aqua100:   'it\\'s fine'");
  });
});
