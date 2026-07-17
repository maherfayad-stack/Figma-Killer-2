import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateComponentMeta, serializeComponentMeta } from './generate-meta.js';
import { parseComponentMeta } from './parse-component-meta.js';

/**
 * FIX-W3 — tests the generator's PURE prop-extraction/inference logic
 * against the REAL `design-system/src/components/*.jsx` in this checkout
 * (not fixtures): this checkout ships zero hand-authored `.meta.ts`, so
 * these are the acceptance gate for "the generator correctly re-derives a
 * usable ComponentMeta straight from the raw .jsx" (FIX-W3 brief item 1).
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

function readComponent(file: string): { jsxText: string; cssText: string } {
  const jsxText = readFileSync(join(COMPONENTS_DIR, `${file}.jsx`), 'utf8');
  let cssText = '';
  try {
    cssText = readFileSync(join(COMPONENTS_DIR, `${file}.css`), 'utf8');
  } catch {
    // no sibling stylesheet — fine, enum detection just won't fire.
  }
  return { jsxText, cssText };
}

describe('generateComponentMeta — CSS-driven enum inference on the real .jsx/.css', () => {
  it('Badge: `type` becomes an enum (alert/neutral/buttercap/new) defaulting to "alert", required', () => {
    const { jsxText, cssText } = readComponent('Badge');
    const { meta, warnings } = generateComponentMeta({
      name: 'Badge',
      jsxText,
      cssText,
      category: 'Feedback',
      description: 'Badge',
    });
    expect(meta.props.type).toEqual({
      type: 'enum',
      enum: ['alert', 'buttercap', 'neutral', 'new'],
      default: 'alert',
      control: 'enum',
      required: true,
    });
    expect(meta.props.max).toEqual({ type: 'number', control: 'number', default: 99 });
    expect(meta.props.count).toEqual({ type: 'string', control: 'string' });
    expect(meta.props.children).toBeUndefined(); // dropped: not literal set-prop-able
    expect(warnings).toEqual([]);
  });

  it('Button: `variant` and `size` both become required CSS-driven enums', () => {
    const { jsxText, cssText } = readComponent('Button');
    const { meta } = generateComponentMeta({
      name: 'Button',
      jsxText,
      cssText,
      category: 'Actions',
      description: 'Button',
    });
    expect(meta.props.variant?.type).toBe('enum');
    expect(meta.props.variant?.default).toBe('primary');
    expect(meta.props.variant?.enum).toEqual(
      expect.arrayContaining(['primary', 'secondary', 'destructive', 'payment', 'skeleton', 'apple-pay']),
    );
    expect(meta.props.variant?.required).toBe(true);
    expect(meta.props.size?.type).toBe('enum');
    expect(meta.props.size?.default).toBe('default');
    expect(meta.props.onClick).toBeUndefined(); // event handler — dropped
  });

  it('Accolade: boolean/string defaults typed correctly; no CSS match falls back to plain string', () => {
    const { jsxText, cssText } = readComponent('Accolade');
    const { meta } = generateComponentMeta({
      name: 'Accolade',
      jsxText,
      cssText,
      category: 'Content',
      description: 'Accolade',
    });
    expect(meta.props.background).toEqual({ type: 'boolean', control: 'boolean', default: false });
    expect(meta.props.dir).toMatchObject({ type: 'string', default: 'ltr' });
  });

  it('ListItem (List.jsx): resolves via the exported name even though the file is List.jsx', () => {
    const { jsxText, cssText } = readComponent('List');
    const { meta } = generateComponentMeta({
      name: 'ListItem',
      jsxText,
      cssText,
      category: 'Layout',
      description: 'ListItem',
    });
    expect(meta.props.selected).toEqual({ type: 'boolean', control: 'boolean', default: false });
    expect(meta.props.label).toMatchObject({ type: 'string', default: 'Label' });
  });

  it('ListItem: `type` and `state` share the identical "list-item--" CSS prefix — ambiguous, both fall back to plain string (not a blended/wrong enum)', () => {
    const { jsxText, cssText } = readComponent('List');
    const { meta, warnings } = generateComponentMeta({
      name: 'ListItem',
      jsxText,
      cssText,
      category: 'Layout',
      description: 'ListItem',
    });
    expect(meta.props.type).toEqual({ type: 'string', control: 'string', default: 'icon' });
    expect(meta.props.state).toEqual({ type: 'string', control: 'string', default: 'active' });
    expect(warnings.some((w) => w.includes('"type"') && w.includes('ambiguous'))).toBe(true);
    expect(warnings.some((w) => w.includes('"state"') && w.includes('ambiguous'))).toBe(true);
  });

  it('every generated meta round-trips through the real parseComponentMeta/ComponentMetaSchema', () => {
    for (const [name, file, category] of [
      ['Badge', 'Badge', 'Feedback'],
      ['Button', 'Button', 'Actions'],
      ['Accolade', 'Accolade', 'Content'],
      ['Banner', 'Banner', 'Feedback'],
      ['ListItem', 'List', 'Layout'],
      ['IconButton', 'IconButton', 'Actions'],
      ['FilterChip', 'FilterChip', 'Forms'],
    ] as const) {
      const { jsxText, cssText } = readComponent(file);
      const { meta } = generateComponentMeta({ name, jsxText, cssText, category, description: name });
      const serialized = serializeComponentMeta(meta, { sourceJsxFile: `${file}.jsx` });
      const reparsed = parseComponentMeta(serialized, `${name}.meta.ts`);
      expect(reparsed).toEqual(meta);
    }
  });
});

describe('generateComponentMeta — non-literal / unusual defaults degrade safely', () => {
  it('a JSX-expression default (not a literal) is flagged and typed as a json/node fallback', () => {
    const jsxText = `export function Weird({ icon = <svg />, size = 4, label }) { return null }`;
    const { meta, warnings } = generateComponentMeta({
      name: 'Weird',
      jsxText,
      category: 'Test',
      description: 'Weird',
    });
    expect(meta.props.icon).toEqual({ type: 'node', control: 'json' });
    expect(meta.props.size).toEqual({ type: 'number', control: 'number', default: 4 });
    expect(meta.props.label).toEqual({ type: 'string', control: 'string' });
    expect(warnings.some((w) => w.includes('icon'))).toBe(true);
  });

  it('a `null` default (slot prop) is typed as a plain node control, no default emitted', () => {
    const jsxText = `export function Weird({ icon = null }) { return null }`;
    const { meta } = generateComponentMeta({ name: 'Weird', jsxText, category: 'Test', description: 'Weird' });
    expect(meta.props.icon).toEqual({ type: 'node', control: 'node' });
  });
});
