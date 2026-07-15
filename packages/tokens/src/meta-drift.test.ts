import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseComponentMeta } from './parse-component-meta.js';
import { extractDestructuredProps } from './jsx-props.js';

/**
 * ADR-0021 drift test: every authored `design-system/src/components/
 * *.meta.ts`'s `props` keys must be a SUBSET of the actual component's
 * destructured `.jsx` props — catches a meta.ts drifting out of sync with
 * a future prop rename/removal. Runs against the REAL 39 authored files
 * (not a fixture) — this IS the acceptance gate ADR-0021/ADR-0022 call for.
 */

const COMPONENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'design-system',
  'src',
  'components',
);

function metaFiles(): string[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((f) => f.endsWith('.meta.ts'))
    .sort();
}

describe('meta.ts drift — props subset of the real .jsx destructured props', () => {
  const files = metaFiles();

  it('found all 39 authored meta.ts files', () => {
    expect(files.length).toBe(39);
  });

  it.each(files)('%s', (metaFile) => {
    const metaText = readFileSync(join(COMPONENTS_DIR, metaFile), 'utf8');
    const meta = parseComponentMeta(metaText, metaFile);

    const jsxFile = metaFile.replace(/\.meta\.ts$/, '.jsx');
    const jsxText = readFileSync(join(COMPONENTS_DIR, jsxFile), 'utf8');
    const actualProps = new Set(extractDestructuredProps(jsxText, meta.name));

    const metaPropNames = Object.keys(meta.props);
    const drifted = metaPropNames.filter((p) => !actualProps.has(p));

    expect(
      drifted,
      `meta.ts declares props not found in ${jsxFile}'s "${meta.name}" destructure: ${drifted.join(', ')} ` +
        `(actual: ${[...actualProps].sort().join(', ')})`,
    ).toEqual([]);
  });
});
