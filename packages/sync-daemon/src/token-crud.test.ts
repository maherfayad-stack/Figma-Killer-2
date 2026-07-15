import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTokenOutputs } from '@ccs/tokens';
import { applyTokenCrud, validateTokenKey, validateTokenValue, type TokenCrudRequest } from './token-crud.js';
import { tokensJsPath } from './token-rebuild.js';
import { SelfWriteTracker } from './self-write-tracker.js';

/**
 * Unit coverage for the P4 token-CRUD write-through path (playbook §4/P4,
 * ADR-0022 — `set-token`/`create-token`/`delete-token` control messages).
 * Zero direct tests existed before this file: the control-message SCHEMAS
 * were tested in `@ccs/protocol`, and `daemon.ts`'s handlers were wired
 * (`ws-server.test.ts`) with no-op stubs, but `applyTokenCrud`'s actual
 * read -> format-preserving-edit -> atomic-write behavior against a real
 * `tokens.js` on disk was never exercised. Also proves the self-write
 * tracker is actually marked (so `watchDesignSystem`'s independent
 * rediscovery of this exact write can be suppressed, per `watcher.ts`).
 */

describe('applyTokenCrud', () => {
  let projectRoot: string;
  let tracker: SelfWriteTracker;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ccs-token-crud-'));
    await mkdir(join(projectRoot, 'design-system', 'src', 'tokens'), { recursive: true });
    await writeFile(
      tokensJsPath(projectRoot),
      'export const colors = { aqua100: "#0c9ab0" };\nexport const spacing = { md: 16 };\n',
      'utf8',
    );
    tracker = new SelfWriteTracker();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('set-token updates an existing color token in place and marks the self-write tracker', async () => {
    const req: TokenCrudRequest = { kind: 'set-token', group: 'color', theme: 'light', key: 'aqua100', value: '#123456' };
    const result = await applyTokenCrud(projectRoot, req, tracker);
    expect(result).toEqual({ ok: true });

    const text = await readFile(tokensJsPath(projectRoot), 'utf8');
    expect(text).toContain('"#123456"');
    expect(text).not.toContain('#0c9ab0');

    // The write path marks the tracker BEFORE the rename lands, so by the
    // time the caller (daemon.ts) awaits applyTokenCrud, the mark is
    // already there for the watcher to consume.
    expect(tracker.consume(tokensJsPath(projectRoot))).toBe(true);
  });

  it('set-token on an unknown key fails without writing (TokenEditError surfaced as {ok:false})', async () => {
    const req: TokenCrudRequest = { kind: 'set-token', group: 'color', theme: 'light', key: 'doesNotExist', value: '#000000' };
    const result = await applyTokenCrud(projectRoot, req, tracker);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('doesNotExist');

    const text = await readFile(tokensJsPath(projectRoot), 'utf8');
    expect(text).toContain('#0c9ab0'); // unchanged
  });

  it('create-token adds a new key to the resolved export', async () => {
    const req: TokenCrudRequest = { kind: 'create-token', group: 'spacing', theme: 'light', key: 'xl', value: 32 };
    const result = await applyTokenCrud(projectRoot, req, tracker);
    expect(result).toEqual({ ok: true });

    const text = await readFile(tokensJsPath(projectRoot), 'utf8');
    expect(text).toContain('xl: 32');
  });

  it('create-token on an already-existing key fails', async () => {
    const req: TokenCrudRequest = { kind: 'create-token', group: 'spacing', theme: 'light', key: 'md', value: 99 };
    const result = await applyTokenCrud(projectRoot, req, tracker);
    expect(result.ok).toBe(false);
  });

  it('delete-token removes an existing key', async () => {
    const req: TokenCrudRequest = { kind: 'delete-token', group: 'color', theme: 'light', key: 'aqua100' };
    const result = await applyTokenCrud(projectRoot, req, tracker);
    expect(result).toEqual({ ok: true });

    const text = await readFile(tokensJsPath(projectRoot), 'utf8');
    expect(text).not.toContain('aqua100');
  });

  it('set-token/create-token missing "value" fails with a clear reason', async () => {
    const req = { kind: 'set-token', group: 'color', theme: 'light', key: 'aqua100' } as TokenCrudRequest;
    const result = await applyTokenCrud(projectRoot, req, tracker);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('value');
  });

  it('fails cleanly when tokens.js does not exist', async () => {
    await rm(tokensJsPath(projectRoot));
    const req: TokenCrudRequest = { kind: 'set-token', group: 'color', theme: 'light', key: 'aqua100', value: '#000' };
    const result = await applyTokenCrud(projectRoot, req, tracker);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not readable');
  });

  // ---- AUDIT-7 blocker — CSS injection via unvalidated key/value ---------

  describe('CSS-injection regression (AUDIT-7 blocker)', () => {
    const INJECTION_KEY = 'x: red; } body { display:none } /* pwned';

    it('rejects the exact AUDIT-7 create-token injection payload via `key`, and does not write', async () => {
      const req: TokenCrudRequest = {
        kind: 'create-token',
        group: 'color',
        theme: 'light',
        key: INJECTION_KEY,
        value: '#000',
      };
      const result = await applyTokenCrud(projectRoot, req, tracker);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/invalid token key/);

      const text = await readFile(tokensJsPath(projectRoot), 'utf8');
      expect(text).not.toContain('pwned');
      expect(text).not.toContain('display:none');

      // The emitted CSS the daemon would rebuild from this file also
      // carries no injected rule, since nothing was ever written.
      const outputs = buildTokenOutputs(text);
      expect(outputs.css.light).not.toContain('pwned');
      expect(outputs.css.light).not.toMatch(/display:\s*none/);
    });

    it('rejects the equivalent injection payload delivered via `value` on set-token, and does not write', async () => {
      const req: TokenCrudRequest = {
        kind: 'set-token',
        group: 'color',
        theme: 'light',
        key: 'aqua100',
        value: 'red; } body { display:none } /* pwned */',
      };
      const result = await applyTokenCrud(projectRoot, req, tracker);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/invalid token value/i);

      const text = await readFile(tokensJsPath(projectRoot), 'utf8');
      expect(text).not.toContain('pwned');
      expect(text).toContain('#0c9ab0'); // unchanged

      const outputs = buildTokenOutputs(text);
      expect(outputs.css.light).not.toContain('pwned');
      expect(outputs.css.light).not.toMatch(/display:\s*none/);
    });

    it('rejects an injection payload delivered via `value` on create-token', async () => {
      const req: TokenCrudRequest = {
        kind: 'create-token',
        group: 'color',
        theme: 'light',
        key: 'legitname',
        value: '#000; } body { display:none } /* pwned */',
      };
      const result = await applyTokenCrud(projectRoot, req, tracker);
      expect(result.ok).toBe(false);

      const text = await readFile(tokensJsPath(projectRoot), 'utf8');
      expect(text).not.toContain('pwned');
      expect(text).not.toContain('legitname');
    });

    it('still accepts legitimate keys/values after the hardening (no false-positive regression)', async () => {
      const req: TokenCrudRequest = { kind: 'set-token', group: 'color', theme: 'light', key: 'aqua100', value: '#123456' };
      const result = await applyTokenCrud(projectRoot, req, tracker);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('validateTokenKey', () => {
    it('accepts letters/digits/underscore/hyphen keys, including digit-leading ones', () => {
      expect(validateTokenKey('aqua100')).toBeUndefined();
      expect(validateTokenKey('2xl')).toBeUndefined();
      expect(validateTokenKey('white_static-2')).toBeUndefined();
    });

    it('rejects keys containing CSS-breaking characters', () => {
      expect(validateTokenKey('x: red; } body { display:none } /* pwned')).toBeDefined();
      expect(validateTokenKey('has space')).toBeDefined();
      expect(validateTokenKey('semi;colon')).toBeDefined();
      expect(validateTokenKey('')).toBeDefined();
    });

    it('rejects a key exceeding the max length', () => {
      expect(validateTokenKey('a'.repeat(65))).toBeDefined();
      expect(validateTokenKey('a'.repeat(64))).toBeUndefined();
    });
  });

  describe('validateTokenValue', () => {
    it('accepts valid hex and rgb/rgba color values', () => {
      expect(validateTokenValue('color', '#fff')).toBeUndefined();
      expect(validateTokenValue('color', '#1C1C1C')).toBeUndefined();
      expect(validateTokenValue('color', 'rgba(0, 0, 0, 0.5)')).toBeUndefined();
      expect(validateTokenValue('color', 'rgb(255, 255, 255)')).toBeUndefined();
    });

    it('rejects a color value that is not an actual color, even with no breaking chars', () => {
      expect(validateTokenValue('color', 'notacolor')).toBeDefined();
    });

    it('rejects color/dimension values containing CSS-breaking sequences', () => {
      expect(validateTokenValue('color', 'red; } body { display:none } /* pwned */')).toBeDefined();
      expect(validateTokenValue('spacing', '16px; } body {} /*')).toBeDefined();
    });

    it('accepts numeric and unit-suffixed dimension values for spacing/rounded', () => {
      expect(validateTokenValue('spacing', 16)).toBeUndefined();
      expect(validateTokenValue('spacing', '16px')).toBeUndefined();
      expect(validateTokenValue('rounded', '12px')).toBeUndefined();
    });

    it('rejects a non-finite number', () => {
      expect(validateTokenValue('spacing', Number.POSITIVE_INFINITY)).toBeDefined();
      expect(validateTokenValue('spacing', Number.NaN)).toBeDefined();
    });

    it('allows free-text elevation values (e.g. multi-part box-shadow) as long as they are not CSS-breaking', () => {
      expect(validateTokenValue('elevation', '0px -4px 16px rgba(0, 0, 0, 0.08)')).toBeUndefined();
    });
  });
});
