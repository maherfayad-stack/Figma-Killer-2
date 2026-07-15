import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComponentMeta } from './parse-component-meta.js';
import { parseAlmosaferTokensJs } from './parse-almosafer.js';
import type { ComponentMeta, PropSchema } from './component-meta.js';
import type { TokenGroup, TokenModel } from './types.js';

/**
 * The component/token CATALOG — the FROZEN, PARAMETERLESS engine API
 * surface (ADR-0022): `listComponents()`, `getPropSchema(name)`,
 * `tokensForProperty(cssProp)`. P5 imports these directly; no daemon round
 * -trip needed for reads (only WRITES go through the daemon — token CRUD
 * control messages, `packages/protocol/src/control-messages.ts`).
 *
 * These three ARE fs-touching (readdir/readFile), deliberately — the
 * ADR-0022 signatures take NO arguments, so there is no seam left for a
 * caller to inject already-loaded data. This is a considered exception to
 * "pure library, fs only at the daemon boundary" (that rule targets the
 * EMITTERS — `emitCss`/`emitTailwindPreset`/`parseAlmosaferTokensJs` — all
 * genuinely pure, text-in/text-out). The catalog is READ-ONLY (never
 * writes; the daemon remains the sole fs-writer) and memoizes after first
 * load; `configureComponentCatalog`/`configureTokenSource` +
 * `resetCatalogCache` exist so tests (and, later, the daemon after a
 * `components-changed`/`tokens-changed` event) can point it at a fixture
 * dir and force a reload without restarting the process.
 */

let componentsDirOverride: string | undefined;
let tokensJsPathOverride: string | undefined;
let cachedMetas: ComponentMeta[] | undefined;
let cachedTokenModel: TokenModel | undefined;

export function configureComponentCatalog(componentsDir: string | undefined): void {
  componentsDirOverride = componentsDir;
  cachedMetas = undefined;
}

export function configureTokenSource(tokensJsPath: string | undefined): void {
  tokensJsPathOverride = tokensJsPath;
  cachedTokenModel = undefined;
}

/** Clears both caches — call after a `tokens-changed`/`components-changed`
 * DaemonEvent (or in test teardown) so the next call re-reads from disk. */
export function resetCatalogCache(): void {
  cachedMetas = undefined;
  cachedTokenModel = undefined;
}

function defaultComponentsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'design-system', 'src', 'components');
}

function defaultTokensJsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'design-system', 'src', 'tokens', 'tokens.js');
}

function readTextFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function loadAllMetas(): ComponentMeta[] {
  if (cachedMetas) return cachedMetas;
  const dir = componentsDirOverride ?? defaultComponentsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.meta.ts'));
  } catch {
    files = [];
  }
  cachedMetas = files
    .sort()
    .map((f: string) => parseComponentMeta(readFileSync(join(dir, f), 'utf8'), f));
  return cachedMetas;
}

function loadDefaultTokenModel(): TokenModel {
  if (cachedTokenModel) return cachedTokenModel;
  const path = tokensJsPathOverride ?? defaultTokensJsPath();
  const text = readTextFileOrEmpty(path);
  cachedTokenModel = parseAlmosaferTokensJs(text);
  return cachedTokenModel;
}

export function listComponents(): Array<{ name: string; category: string; description: string }> {
  return loadAllMetas().map(({ name, category, description }) => ({ name, category, description }));
}

export function getPropSchema(name: string): { props: Record<string, PropSchema> } {
  const meta = loadAllMetas().find((m) => m.name === name);
  if (!meta) throw new Error(`@ccs/tokens: unknown component "${name}"`);
  return { props: meta.props };
}

export interface TokenRef {
  token: string;
  value: string | number;
}

/** Which token GROUPS are candidates for a given CSS property — drives
 * the token-aware inspector's picker (playbook §4/P4: "every color/size/
 * typography input in inspector has a token-picker toggle"). Deliberately
 * a small, explicit table rather than a heuristic guess. */
const CSS_PROPERTY_GROUPS: Record<string, TokenGroup[]> = {
  color: ['color'],
  'background-color': ['color'],
  'border-color': ['color'],
  'outline-color': ['color'],
  fill: ['color'],
  stroke: ['color'],
  padding: ['spacing'],
  'padding-top': ['spacing'],
  'padding-right': ['spacing'],
  'padding-bottom': ['spacing'],
  'padding-left': ['spacing'],
  margin: ['spacing'],
  gap: ['spacing'],
  'row-gap': ['spacing'],
  'column-gap': ['spacing'],
  'border-radius': ['rounded'],
  'box-shadow': ['elevation'],
  'font-size': ['typography'],
  'font-weight': ['typography'],
  'font-family': ['typography'],
  'line-height': ['typography'],
  'letter-spacing': ['typography'],
};

export function tokensForProperty(cssProp: string): TokenRef[] {
  const groups = CSS_PROPERTY_GROUPS[cssProp.toLowerCase()] ?? [];
  if (groups.length === 0) return [];
  const model = loadDefaultTokenModel();
  return model.tokens
    .filter((t) => groups.includes(t.group))
    .map((t) => ({ token: t.name, value: t.value.light }));
}
