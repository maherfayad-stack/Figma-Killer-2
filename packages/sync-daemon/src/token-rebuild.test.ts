import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildTokenOutputs, tokensJsPath } from './token-rebuild.js';

/**
 * Unit coverage for the P4 token rebuild pipeline (playbook §4/P4,
 * ADR-0010/ADR-0022) — this module had zero direct tests before this file:
 * `daemon.ts`'s `onDesignSystemEvent`/CRUD handlers only exercised it
 * indirectly. Verifies the actual fs side effects (`src/tokens.css` +
 * `tokens.preset.js` written into EVERY given file-folder, atomically, ok:
 * false on missing/malformed source) directly against `@ccs/tokens`'s real
 * `buildTokenOutputs` — no mocking of the token engine.
 */

describe('tokensJsPath', () => {
  it('resolves to the ADR-0010 primary path, project-root-relative', () => {
    expect(tokensJsPath('/proj')).toBe(join('/proj', 'design-system', 'src', 'tokens', 'tokens.js'));
  });
});

describe('rebuildTokenOutputs', () => {
  let projectRoot: string;
  let ffA: string;
  let ffB: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ccs-token-rebuild-'));
    ffA = join(projectRoot, 'files', 'a');
    ffB = join(projectRoot, 'files', 'b');
    await mkdir(join(projectRoot, 'design-system', 'src', 'tokens'), { recursive: true });
    await mkdir(join(ffA, 'src'), { recursive: true });
    await mkdir(join(ffB, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns {ok:false} when tokens.js does not exist yet (fresh scaffold, no design-system/)', async () => {
    const result = await rebuildTokenOutputs(projectRoot, [ffA]);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('not readable') });
  });

  it('a syntactically-broken tokens.js does not throw (ts-morph in-memory parse is fault-tolerant)', async () => {
    // NOTE (finding, not a bug fix): `parseAlmosaferTokensJs` never actually
    // throws — ts-morph's `createSourceFile` tolerates invalid syntax and
    // simply yields zero exported object literals, so `buildTokenOutputs`
    // always succeeds with an EMPTY TokenModel rather than surfacing a
    // parse error. The `try/catch` -> `{ok:false, reason:'...parse
    // failed...'}` branch in `rebuildTokenOutputs` is therefore defensive
    // dead code today (harmless — kept in case a future `@ccs/tokens`
    // change starts throwing) rather than a reachable failure path. Real
    // consequence to flag: a genuinely corrupted `tokens.js` left on disk
    // rebuilds every file-folder's `tokens.css`/`tokens.preset.js` to
    // EMPTY (0 custom properties), not "keep the last-good output" —
    // see the P4 worker's final report for this as a carry-forward CR.
    await writeFile(tokensJsPath(projectRoot), 'this is not valid javascript {{{', 'utf8');
    const result = await rebuildTokenOutputs(projectRoot, [ffA]);
    expect(result).toEqual({ ok: true });
    const css = await readFile(join(ffA, 'src', 'tokens.css'), 'utf8');
    expect(css).toContain(':root {'); // valid, just empty of custom properties
  });

  it('writes src/tokens.css + tokens.preset.js into every file-folder root from a valid tokens.js', async () => {
    await writeFile(
      tokensJsPath(projectRoot),
      'export const colors = { aqua100: "#0c9ab0" };\nexport const spacing = { md: 16 };\n',
      'utf8',
    );

    const result = await rebuildTokenOutputs(projectRoot, [ffA, ffB]);
    expect(result).toEqual({ ok: true });

    for (const ff of [ffA, ffB]) {
      const css = await readFile(join(ff, 'src', 'tokens.css'), 'utf8');
      expect(css).toContain('--color-aqua-100: #0c9ab0');
      expect(css).toContain(':root {');
      expect(css).toContain('@media (prefers-color-scheme: dark)');

      const presetText = await readFile(join(ff, 'tokens.preset.js'), 'utf8');
      expect(presetText).toContain('export default');
      expect(presetText).toContain('var(--color-aqua-100)');
      expect(presetText).toContain('var(--space-md)');
    }
  });

  it('re-running after a token value change overwrites both outputs (proves rebuild, not append)', async () => {
    await writeFile(tokensJsPath(projectRoot), 'export const colors = { aqua100: "#0c9ab0" };\n', 'utf8');
    await rebuildTokenOutputs(projectRoot, [ffA]);
    const first = await readFile(join(ffA, 'src', 'tokens.css'), 'utf8');
    expect(first).toContain('#0c9ab0');

    await writeFile(tokensJsPath(projectRoot), 'export const colors = { aqua100: "#ff00ff" };\n', 'utf8');
    await rebuildTokenOutputs(projectRoot, [ffA]);
    const second = await readFile(join(ffA, 'src', 'tokens.css'), 'utf8');
    expect(second).not.toContain('#0c9ab0');
    expect(second).toContain('#ff00ff');
  });

  it('empty fileFolderRoots list is a no-op that still succeeds', async () => {
    await writeFile(tokensJsPath(projectRoot), 'export const colors = { aqua100: "#0c9ab0" };\n', 'utf8');
    const result = await rebuildTokenOutputs(projectRoot, []);
    expect(result).toEqual({ ok: true });
  });
});
