import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureComponentCatalog,
  configureTokenSource,
  getPropSchema,
  listComponents,
  resetCatalogCache,
  tokensForProperty,
} from './catalog.js';

/**
 * FIX-W3: this describe block used to assert against a HAND-WRITTEN 39-
 * component fixture (ADR-0021's authored `.meta.ts`, including invented
 * components like `Accordion`/`Dialog` that were never committed to this
 * checkout's junctioned `design-system/` — see the FIX-W3 report). That
 * fixture never actually existed on disk here: `listComponents()` returned
 * `[]` and every one of these assertions failed. Rewritten to assert
 * against the REAL 28 `.meta.ts` files `packages/tokens/scripts/generate-
 * component-meta.ts` generates straight from the real `.jsx` (+ sibling
 * `.css`) — see `generate-meta.test.ts` for the generator's own unit tests.
 */
describe('listComponents / getPropSchema — real design-system/src/components/*.meta.ts', () => {
  afterEach(() => resetCatalogCache());

  it('lists the generated core-set components with name/category/description', () => {
    const components = listComponents();
    expect(components.length).toBeGreaterThanOrEqual(28);
    const badge = components.find((c) => c.name === 'Badge');
    expect(badge).toEqual({ name: 'Badge', category: 'Feedback', description: expect.any(String) });
  });

  it("getPropSchema('Badge') returns the CSS-derived `type` enum + count/max with defaults", () => {
    const { props } = getPropSchema('Badge');
    expect(props.type).toEqual({
      type: 'enum',
      enum: ['alert', 'buttercap', 'neutral', 'new'],
      default: 'alert',
      control: 'enum',
      required: true,
    });
    expect(props.count).toMatchObject({ type: 'string' });
    expect(props.max).toMatchObject({ type: 'number', default: 99, control: 'number' });
  });

  it('getPropSchema works for a component WITHOUT Code Connect (Checkbox)', () => {
    const { props } = getPropSchema('Checkbox');
    expect(props.label).toMatchObject({ type: 'string', default: 'Label' });
    expect(props.state).toMatchObject({ type: 'enum', default: 'active', required: true });
  });

  it('getPropSchema works for another Code-Connect-less component (Toggle)', () => {
    const { props } = getPropSchema('Toggle');
    expect(props.state).toMatchObject({ type: 'enum', enum: expect.arrayContaining(['active', 'checked']), default: 'active' });
    expect(props.checked).toMatchObject({ type: 'boolean', default: false });
  });

  it('throws for an unknown component name', () => {
    expect(() => getPropSchema('NotAComponent')).toThrow(/unknown component/);
  });

  it('resolves ListItem (authored in List.meta.ts, next to the source List.jsx)', () => {
    const names = listComponents().map((c) => c.name);
    expect(names).toContain('ListItem');
    const { props } = getPropSchema('ListItem');
    // `type`/`state` share an identical CSS prefix (ambiguous) — the
    // generator deliberately falls back to plain strings rather than
    // guessing a blended enum (see generate-meta.test.ts).
    expect(props.type).toMatchObject({ type: 'string', default: 'icon' });
  });
});

describe('listComponents / getPropSchema — fixture dir (isolation + cache invalidation)', () => {
  // FIX-W3: `new URL(...).pathname` on Windows yields a leading-slash path
  // (`/C:/Users/...`) that every fs call below then mis-resolves as
  // `C:\C:\Users\...` (ENOENT) — pre-existing bug, unrelated to the catalog-
  // data fix, hit while touching this file. `fileURLToPath` is the correct,
  // platform-aware conversion (used everywhere else in this package, e.g.
  // `catalog.ts`'s own `defaultComponentsDir`).
  const FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/components', import.meta.url));

  beforeEach(async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
    await writeFile(
      `${FIXTURE_DIR}/Widget.meta.ts`,
      `export default {
        name: 'Widget',
        description: 'A test widget.',
        category: 'Test',
        props: { size: { type: 'enum', enum: ['sm', 'lg'], default: 'sm', control: 'enum' } },
      };\n`,
    );
    configureComponentCatalog(FIXTURE_DIR);
  });

  afterEach(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    configureComponentCatalog(undefined);
  });

  it('reads from the configured override directory instead of the real design-system', () => {
    expect(listComponents()).toEqual([{ name: 'Widget', category: 'Test', description: 'A test widget.' }]);
  });

  it('re-configuring clears the cache and picks up new content', async () => {
    expect(listComponents()).toHaveLength(1);
    await writeFile(
      `${FIXTURE_DIR}/Second.meta.ts`,
      `export default { name: 'Second', description: '', category: 'Test', props: {} };\n`,
    );
    // still cached until re-configured/reset
    expect(listComponents()).toHaveLength(1);
    configureComponentCatalog(FIXTURE_DIR);
    expect(listComponents()).toHaveLength(2);
  });
});

describe('tokensForProperty — real design-system/src/tokens/tokens.js', () => {
  afterEach(() => resetCatalogCache());

  it('returns color tokens for a color-ish CSS property', () => {
    const refs = tokensForProperty('background-color');
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.token === 'aqua100')).toBe(true);
  });

  it('returns spacing tokens for padding/margin/gap', () => {
    const refs = tokensForProperty('padding');
    expect(refs.some((r) => r.token === 'md')).toBe(true);
  });

  it('returns an empty array for an unrecognized CSS property', () => {
    expect(tokensForProperty('transform')).toEqual([]);
  });

  it('honors configureTokenSource for isolation', async () => {
    const fixture = `export const colors = { special: '#ABCDEF' }\nexport const colorsDark = {}\nexport const spacing = {}\nexport const rounded = {}\nexport const elevation = {}\nexport const typography = {}\n`;
    const dir = fileURLToPath(new URL('./__fixtures__', import.meta.url));
    const path = `${dir}/tokens.fixture.js`;
    await mkdir(dir, { recursive: true });
    await writeFile(path, fixture);
    configureTokenSource(path);
    expect(tokensForProperty('color').find((r) => r.token === 'special')?.value).toBe('#ABCDEF');
    configureTokenSource(undefined);
    await rm(path, { force: true });
  });
});
