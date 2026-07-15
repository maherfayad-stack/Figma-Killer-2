import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBEDDED_PRETTIER_CONFIG, formatWithEmbeddedConfig } from './prettier-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Zero-IO only applies to shipped `src/` runtime code (per the worker
// brief); reading the root config here, in a TEST, to assert no drift is
// exactly what ADR-0018 item 7 asks for ("a test MUST assert it matches
// root `.prettierrc.json`").
const rootPrettierRcPath = join(__dirname, '..', '..', '..', '.prettierrc.json');

describe('EMBEDDED_PRETTIER_CONFIG', () => {
  it('matches the root .prettierrc.json exactly (no drift)', () => {
    const rootConfig = JSON.parse(readFileSync(rootPrettierRcPath, 'utf8'));
    expect(EMBEDDED_PRETTIER_CONFIG).toEqual(rootConfig);
  });
});

describe('formatWithEmbeddedConfig', () => {
  it('formats using the embedded config by default', () => {
    const out = formatWithEmbeddedConfig(`const x = {a:1,b:2}\n`);
    expect(out).toBe('const x = { a: 1, b: 2 };\n');
  });

  it('honors opts.prettierConfig override', () => {
    const out = formatWithEmbeddedConfig(`const x = {a:1,b:2}\n`, {
      prettierConfig: { ...EMBEDDED_PRETTIER_CONFIG, semi: false },
    });
    expect(out).toBe('const x = { a: 1, b: 2 }\n');
  });

  it('is idempotent (formatting formatted output produces no change)', () => {
    const once = formatWithEmbeddedConfig(`export function Foo(){return <div className="a b">hi</div>}`);
    const twice = formatWithEmbeddedConfig(once);
    expect(twice).toBe(once);
  });

  it('is genuinely synchronous (no Promise return)', () => {
    const out = formatWithEmbeddedConfig(`const x=1`);
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof out).toBe('string');
  });
});
