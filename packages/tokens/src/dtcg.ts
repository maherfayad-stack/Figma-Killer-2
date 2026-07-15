import { cssVarForFlatToken, cssVarForTypographyField } from './css-var.js';
import { kebabCase } from './kebab.js';
import type { Token, TokenGroup, TokenModel, TokenType } from './types.js';

/**
 * DTCG (W3C Design Tokens Community Group format) — INTEROP ONLY (ADR-0010:
 * the Almosafer `tokens.js` JS-export shape is the PRIMARY format; DTCG is
 * layered on top so `TokenModel` can still import/export the more common
 * industry interchange format). Converts to/from the SAME `TokenModel` that
 * `parseAlmosaferTokensJs` produces.
 *
 * Document shape: `{ light: DtcgTree, dark: DtcgTree }` — one DTCG tree per
 * theme (DTCG itself doesn't mandate a multi-theme container; this is a
 * documented, minimal choice, not a spec claim). Each tree nests
 * `group -> ...path -> {$value,$type}` exactly like a standard DTCG
 * document (`color.aqua100.$value`, `typography.display.fontSize.$value`).
 *
 * Alias support (`$value: "{aqua100}"`) is scoped to WITHIN THE SAME GROUP
 * for v1 (a documented limitation, not a full DTCG resolver — cross-group
 * aliases are rare in this token set and the flat within-group case covers
 * the realistic "this token IS that token" pattern). A resolved alias's
 * original reference text is preserved on `Token.alias` for round-tripping
 * back to `{ref}` syntax on export, rather than being permanently baked
 * into a plain value.
 */

export interface DtcgTokenNode {
  $value: string | number;
  $type: string;
  $description?: string;
}
export type DtcgTree = { [key: string]: DtcgTokenNode | DtcgTree };
export interface DtcgDocument {
  light: DtcgTree;
  dark: DtcgTree;
}

const GROUP_ORDER: TokenGroup[] = ['color', 'spacing', 'rounded', 'elevation', 'typography'];

export function tokenModelToDtcg(model: TokenModel): DtcgDocument {
  const light: DtcgTree = {};
  const dark: DtcgTree = {};
  for (const group of GROUP_ORDER) {
    const groupLight: DtcgTree = {};
    const groupDark: DtcgTree = {};
    for (const t of model.tokens.filter((tok) => tok.group === group)) {
      const path = t.name.split('.');
      const valueLight = t.alias ? `{${t.alias}}` : t.value.light;
      const valueDark = t.alias ? `{${t.alias}}` : t.value.dark;
      setNested(groupLight, path, { $value: valueLight, $type: t.type });
      setNested(groupDark, path, { $value: valueDark, $type: t.type });
    }
    if (Object.keys(groupLight).length > 0) light[group] = groupLight;
    if (Object.keys(groupDark).length > 0) dark[group] = groupDark;
  }
  return { light, dark };
}

export function dtcgToTokenModel(doc: DtcgDocument): TokenModel {
  const tokens: Token[] = [];
  for (const group of GROUP_ORDER) {
    const lightTree = doc.light[group];
    const darkTree = doc.dark[group];
    const lightTreeSub = isTree(lightTree) ? lightTree : undefined;
    const darkTreeSub = isTree(darkTree) ? darkTree : undefined;

    const names = new Set<string>();
    if (lightTreeSub) collectLeafPaths(lightTreeSub, [], names);
    if (darkTreeSub) collectLeafPaths(darkTreeSub, [], names);

    for (const name of names) {
      const path = name.split('.');
      const lightLeaf = lightTreeSub ? getNestedLeaf(lightTreeSub, path) : undefined;
      const darkLeaf = darkTreeSub ? getNestedLeaf(darkTreeSub, path) : undefined;
      const sourceLeaf = lightLeaf ?? darkLeaf;
      if (!sourceLeaf) continue;

      const rawLight = lightLeaf?.$value ?? darkLeaf?.$value;
      const rawDark = darkLeaf?.$value ?? lightLeaf?.$value;
      const light = resolveAliasValue(rawLight, lightTreeSub);
      const dark = resolveAliasValue(rawDark, darkTreeSub);

      const aliasRef = typeof sourceLeaf.$value === 'string' ? aliasReference(sourceLeaf.$value) : undefined;

      const cssVar =
        group === 'typography'
          ? (() => {
              const [scale, field] = name.split('.');
              return field ? cssVarForTypographyField(scale ?? '', field) : `--type-${kebabCase(name)}`;
            })()
          : cssVarForFlatToken(group, name);

      tokens.push({
        name,
        group,
        type: (sourceLeaf.$type as TokenType) ?? 'string',
        value: { light, dark },
        cssVar,
        alias: aliasRef,
      });
    }
  }
  return { tokens, themes: ['light', 'dark'] };
}

function isTree(node: DtcgTokenNode | DtcgTree | undefined): node is DtcgTree {
  return node !== undefined && !isLeaf(node);
}

function isLeaf(node: DtcgTokenNode | DtcgTree): node is DtcgTokenNode {
  return typeof (node as DtcgTokenNode).$value !== 'undefined';
}

function setNested(tree: DtcgTree, path: string[], leaf: DtcgTokenNode): void {
  let node = tree;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    const existing = node[segment];
    if (!existing || isLeaf(existing)) node[segment] = {};
    node = node[segment] as DtcgTree;
  }
  const last = path[path.length - 1];
  if (last !== undefined) node[last] = leaf;
}

function collectLeafPaths(tree: DtcgTree, prefix: string[], out: Set<string>): void {
  for (const [key, val] of Object.entries(tree)) {
    if (isLeaf(val)) out.add([...prefix, key].join('.'));
    else collectLeafPaths(val, [...prefix, key], out);
  }
}

function getNestedLeaf(tree: DtcgTree, path: string[]): DtcgTokenNode | undefined {
  let node: DtcgTree | DtcgTokenNode = tree;
  for (const segment of path) {
    if (isLeaf(node)) return undefined;
    const next: DtcgTokenNode | DtcgTree | undefined = (node as DtcgTree)[segment];
    if (!next) return undefined;
    node = next;
  }
  return isLeaf(node) ? node : undefined;
}

function aliasReference(value: string): string | undefined {
  return value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : undefined;
}

function resolveAliasValue(
  raw: string | number | undefined,
  tree: DtcgTree | undefined,
  seen: Set<string> = new Set(),
): string | number {
  if (raw === undefined) return '';
  if (typeof raw !== 'string' || !tree) return raw;
  const ref = aliasReference(raw);
  if (ref === undefined) return raw;
  if (seen.has(ref)) return raw; // cycle guard — bail out to the raw reference text
  seen.add(ref);
  const target = getNestedLeaf(tree, ref.split('.'));
  if (!target) return raw;
  return resolveAliasValue(target.$value, tree, seen);
}
