import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureComponentCatalog,
  configureTokenSource,
  getPropSchema,
  listComponents,
  resetCatalogCache,
  tokensForProperty,
} from './catalog.js';

describe('listComponents / getPropSchema — real design-system/src/components/*.meta.ts', () => {
  afterEach(() => resetCatalogCache());

  it('lists all 39 authored components with name/category/description', () => {
    const components = listComponents();
    expect(components.length).toBe(39);
    const badge = components.find((c) => c.name === 'Badge');
    expect(badge).toEqual({ name: 'Badge', category: 'Feedback', description: expect.any(String) });
  });

  it("getPropSchema('Badge') returns the variant enum {alert,new} + count/max with defaults (ADR-0022 acceptance)", () => {
    const { props } = getPropSchema('Badge');
    expect(props.variant).toEqual({ type: 'enum', enum: ['alert', 'new'], default: 'alert', control: 'enum' });
    expect(props.count).toMatchObject({ type: 'number', control: 'number' });
    expect(props.max).toMatchObject({ type: 'number', default: 99, control: 'number' });
  });

  it('getPropSchema works for a component WITHOUT Code Connect (Accordion)', () => {
    const { props } = getPropSchema('Accordion');
    expect(props.title).toMatchObject({ type: 'string', required: true });
    expect(props.expanded).toMatchObject({ type: 'boolean', default: false });
  });

  it('getPropSchema works for another Code-Connect-less component (Dialog)', () => {
    const { props } = getPropSchema('Dialog');
    expect(props.platform).toMatchObject({ type: 'enum', enum: ['ios', 'android'], default: 'ios' });
    expect(props.primaryAction).toMatchObject({ control: 'json' });
  });

  it('throws for an unknown component name', () => {
    expect(() => getPropSchema('NotAComponent')).toThrow(/unknown component/);
  });

  it('resolves ListItem (authored in List.meta.ts, next to the source List.jsx)', () => {
    const names = listComponents().map((c) => c.name);
    expect(names).toContain('ListItem');
    const { props } = getPropSchema('ListItem');
    expect(props.type).toMatchObject({ type: 'enum', enum: ['icon', 'radio', 'checkbox'] });
  });
});

describe('listComponents / getPropSchema — fixture dir (isolation + cache invalidation)', () => {
  const FIXTURE_DIR = new URL('./__fixtures__/components', import.meta.url).pathname;

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
    expect(refs.find((r) => r.token === 'aqua100')?.value).toBe('#0C9AB0');
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
    const path = new URL('./__fixtures__/tokens.fixture.js', import.meta.url).pathname;
    await mkdir(new URL('./__fixtures__', import.meta.url).pathname, { recursive: true });
    await writeFile(path, fixture);
    configureTokenSource(path);
    expect(tokensForProperty('color').find((r) => r.token === 'special')?.value).toBe('#ABCDEF');
    configureTokenSource(undefined);
    await rm(path, { force: true });
  });
});
