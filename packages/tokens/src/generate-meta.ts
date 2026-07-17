import { extractDestructuredPropDefaults, type DestructuredPropDefault } from './jsx-props.js';
import type { ComponentMeta, PropSchema, PropType, ControlKind } from './component-meta.js';
import type { JsonValue } from './parse-literal.js';

/**
 * FIX-W3 `.meta.ts` GENERATOR (build-time tool, `scripts/generate-component-
 * meta.ts` is its thin fs/CLI wrapper) — this module is the PURE, testable
 * core: given a component's raw `.jsx` source text (+ its sibling `.css`,
 * best-effort) it derives a `ComponentMeta` the exact shape `parseComponent
 * Meta`/`catalog.ts` already expect, WITHOUT executing the component.
 *
 * Root cause this exists for: this DS checkout (junctioned `design-system/`)
 * ships 117 raw `.jsx`/`.css` files and ZERO hand-authored `.meta.ts` /
 * Code-Connect `.figma.tsx` (ADR-0021's 39 authored files were never
 * committed here) — `catalog.ts` only reads `*.meta.ts`, so `listComponents()`
 * returns `[]`. Rather than hand-writing meta by hand (explicitly out of
 * scope) or teaching the frozen `catalog.ts` to derive-on-the-fly (a much
 * larger, riskier change to the P4 engine surface), this generates real
 * `.meta.ts` files ONCE from the real `.jsx`, checked by the SAME
 * `parseComponentMeta`/meta-drift discipline as hand-authored ones.
 *
 * Inference rules (deliberately conservative — a prop this can't confidently
 * type just degrades to a plain string/json fallback, never blocks the
 * whole component):
 *   - `children` and event-handler-shaped props (`/^on[A-Z]/`) are DROPPED
 *     from the schema entirely: neither is a literal `set-prop`-able value
 *     (`applySetPropOp` only accepts string/number/boolean literals), so
 *     including them would just be dead weight the Inspector can't act on.
 *   - boolean/number JS default -> `type:'boolean'|'number'`, literal default.
 *   - string JS default -> looked up against the sibling `.css` for a
 *     `<prefix>--<value>` family of classnames whose prefix matches how the
 *     `.jsx` interpolates this prop into a `className` template literal
 *     (e.g. `` `badge--${type}` `` + `.badge--alert`/`.badge--new` in
 *     `Badge.css` -> `type:'enum', enum:['alert','new',...]`). No match (or
 *     fewer than 2 distinct values) -> falls back to a plain `'string'`.
 *   - no default at all -> `'string'`, no `default`, never `required`
 *     (nothing here can prove the component NEEDS it to render).
 *   - a CSS-detected enum prop is marked `required: true` — its own
 *     `default` is always present (came from the JS default parameter), so
 *     `use-component-insert.ts`'s existing `required && default` client-side
 *     defaulting writes it explicitly into the inserted JSX (the human-
 *     visible "sensible default props" the FIX-W3 brief asks for), rather
 *     than relying invisibly on the JS-level default parameter.
 */

export interface GenerateMetaInput {
  /** The exported component name (e.g. `'Badge'`, `'ListItem'`). */
  name: string;
  /** `design-system/src/components/<File>.jsx` source text. */
  jsxText: string;
  /** Sibling `.css` text, or `''` if none exists. */
  cssText?: string;
  category: string;
  description: string;
}

export interface GenerateMetaResult {
  meta: ComponentMeta;
  /** Props this couldn't confidently type — degraded to a safe fallback,
   * not blocking generation of the rest of the component's schema. */
  warnings: string[];
}

const DROPPED_PROP_NAMES = new Set(['children']);

function isEventHandlerName(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

/** Finds, for a given prop name, the static text immediately preceding its
 * `${name}` interpolation inside a template literal in the `.jsx` source —
 * e.g. for `` `badge--${type}` `` and propName `'type'`, returns `'badge--'`.
 * Only handles the single-placeholder, no-suffix shape actually used across
 * this DS's components; anything fancier (nested ternaries, multiple
 * placeholders) yields `undefined` (safe "don't know" — falls back to
 * plain string typing, never a wrong guess). */
function findTemplatePrefix(jsxText: string, propName: string): string | undefined {
  const re = new RegExp('`([a-zA-Z0-9_-]*)\\$\\{\\s*' + propName + '\\s*\\}`', 'g');
  const match = re.exec(jsxText);
  return match?.[1];
}

/** Collects every `.<prefix><value>` classname in `cssText` (prefix matched
 * literally, value = the following class-name-safe run of characters) —
 * the enum "value space" for a CSS-driven variant prop. `siblingPrefixes`
 * are every OTHER string-default prop's own detected prefix in this same
 * component — a suffix is dropped if `prefix + suffix` is also claimed by a
 * MORE SPECIFIC (longer) sibling prefix, e.g. `Button`'s `variant` prop
 * interpolates as `` `btn--${variant}` `` (prefix `"btn--"`) while `size`
 * interpolates as `` `btn--size-${size}` `` (prefix `"btn--size-"`) — both
 * prefix-match `.btn--size-default`, but it's `size`'s value, not a
 * `variant` called `"size-default"`. Without this, the shorter/less-
 * specific prefix's enum swallows every longer sibling's classnames too. */
function collectCssSuffixes(cssText: string, prefix: string, siblingPrefixes: string[]): string[] {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\.' + escaped + '([a-zA-Z0-9_-]+)', 'g');
  const longerSiblings = siblingPrefixes.filter((p) => p !== prefix && p.length > prefix.length && p.startsWith(prefix));
  const values = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(cssText))) {
    const suffix = match[1]!;
    const full = prefix + suffix;
    if (longerSiblings.some((sibling) => full.startsWith(sibling))) continue;
    values.add(suffix);
  }
  return [...values];
}

function inferProp(
  prop: DestructuredPropDefault,
  jsxText: string,
  cssText: string,
  siblingPrefixes: string[],
  prefixCounts: Map<string, number>,
  warnings: string[],
): PropSchema | undefined {
  const { name, hasDefault, defaultValue } = prop;

  if (typeof defaultValue === 'boolean') {
    return { type: 'boolean', control: 'boolean', default: defaultValue };
  }
  if (typeof defaultValue === 'number') {
    return { type: 'number', control: 'number', default: defaultValue };
  }
  if (typeof defaultValue === 'string') {
    const prefix = findTemplatePrefix(jsxText, name);
    // Two sibling props sharing the EXACT SAME prefix (e.g. `ListItem`'s
    // `type` and `state` both interpolate as `` `list-item--${x}` ``) can't
    // be disambiguated by prefix alone — enum detection would silently
    // blend one prop's CSS-derived values into the other's. Safe fallback:
    // treat both as plain strings rather than guess.
    if (prefix && (prefixCounts.get(prefix) ?? 0) > 1) {
      warnings.push(`"${name}": prefix "${prefix}" shared with another prop — CSS enum detection skipped (ambiguous)`);
    } else if (prefix && cssText) {
      const values = collectCssSuffixes(cssText, prefix, siblingPrefixes);
      if (!values.includes(defaultValue)) values.push(defaultValue);
      if (values.length >= 2) {
        return {
          type: 'enum',
          enum: values.sort(),
          default: defaultValue,
          control: 'enum',
          required: true,
        };
      }
    }
    return { type: 'string', control: 'string', default: defaultValue };
  }

  if (Array.isArray(defaultValue) || (typeof defaultValue === 'object' && defaultValue !== null)) {
    warnings.push(`"${name}": array/object default — typed as 'node'/'json' fallback`);
    return { type: 'node', control: 'json' };
  }

  // No literal default (no initializer, `null`, an identifier reference, a
  // function call, ...) — safe fallback. `hasDefault && defaultValue ===
  // undefined` means there WAS a default but this walker couldn't evaluate
  // it (e.g. `icon = <SomeIcon />`) — flagged, typed as a non-literal 'node'
  // so nothing tries to `set-prop` a JSX expression as a string.
  if (hasDefault && defaultValue === undefined) {
    warnings.push(`"${name}": non-literal default — typed as 'node'/'json' fallback`);
    return { type: 'node', control: 'json' };
  }
  if (defaultValue === null) {
    return { type: 'node', control: 'node' };
  }
  return { type: 'string', control: 'string' };
}

export function generateComponentMeta(input: GenerateMetaInput): GenerateMetaResult {
  const { name, jsxText, category, description } = input;
  const cssText = input.cssText ?? '';
  const warnings: string[] = [];

  const rawProps = extractDestructuredPropDefaults(jsxText, name).filter(
    (p) => !DROPPED_PROP_NAMES.has(p.name) && !isEventHandlerName(p.name),
  );

  // Precompute every string-default prop's template-literal prefix up front
  // so a shorter prefix's enum collection can exclude classnames actually
  // owned by a longer sibling prefix (see `collectCssSuffixes`'s doc), and
  // so two props sharing the exact same prefix can both be flagged ambiguous
  // (see `inferProp`'s doc — `ListItem`'s `type`/`state` real-world case).
  const allPrefixes = rawProps
    .map((p) => (typeof p.defaultValue === 'string' ? findTemplatePrefix(jsxText, p.name) : undefined))
    .filter((p): p is string => p !== undefined);
  const prefixCounts = new Map<string, number>();
  for (const p of allPrefixes) prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);

  const props: Record<string, PropSchema> = {};
  for (const prop of rawProps) {
    const schema = inferProp(prop, jsxText, cssText, allPrefixes, prefixCounts, warnings);
    if (schema) props[prop.name] = schema;
  }

  return { meta: { name, description, category, props }, warnings };
}

/** Renders a `ComponentMeta` back to the `export default {...};` source text
 * `parseComponentMeta` reads — same literal vocabulary (string/number/
 * boolean/array/object), single-quoted strings, 2-space indent, trailing
 * semicolon; deterministic key order (`name, description, category, props`,
 * then `props` in extraction order) so re-running the generator on
 * unchanged input produces a byte-identical file (no perpetual git diff). */
export function serializeComponentMeta(meta: ComponentMeta, opts: { sourceJsxFile: string }): string {
  const lines: string[] = [];
  lines.push(
    `// AUTO-GENERATED by packages/tokens/scripts/generate-component-meta.ts — do not hand-edit.`,
    `// Source: design-system/src/components/${opts.sourceJsxFile}`,
    `// FIX-W3: this DS checkout ships raw .jsx only (no Code Connect) — enum values are`,
    `// best-effort, inferred from this component's sibling .css classnames.`,
    `export default {`,
    `  name: ${quote(meta.name)},`,
    `  description: ${quote(meta.description)},`,
    `  category: ${quote(meta.category)},`,
    `  props: {`,
  );
  for (const [propName, schema] of Object.entries(meta.props)) {
    lines.push(`    ${propKey(propName)}: ${serializePropSchema(schema)},`);
  }
  lines.push(`  },`, `};`, ``);
  return lines.join('\n');
}

function serializePropSchema(schema: PropSchema): string {
  const parts: string[] = [`type: ${quote(schema.type)}`];
  if (schema.enum) parts.push(`enum: [${schema.enum.map(quote).join(', ')}]`);
  if (schema.default !== undefined) parts.push(`default: ${serializeJson(schema.default as JsonValue)}`);
  parts.push(`control: ${quote(schema.control)}`);
  if (schema.required) parts.push(`required: true`);
  return `{ ${parts.join(', ')} }`;
}

function serializeJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(serializeJson).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${propKey(k)}: ${serializeJson(v)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return 'undefined';
}

function propKey(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : quote(name);
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export type { PropType, ControlKind };
