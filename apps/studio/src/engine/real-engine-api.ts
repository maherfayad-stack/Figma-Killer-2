import type { Json } from '@ccs/protocol';
import type {
  ComponentPropSchema,
  ComponentSummary,
  EngineApi,
  PropControl,
  Token,
  TokenModel,
  TokenRef,
  TokenType,
} from './engine-api.js';

/**
 * `loadRealEngineApi()` — the REAL P4 `@ccs/tokens` integration (ADR-0022),
 * replacing `createMockEngineApi()`. See `../../vite.config.ts`'s module
 * doc for WHY this talks to `/__ccs/catalog/*` HTTP endpoints instead of
 * `import`-ing `@ccs/tokens` directly into this (browser-bundled) module:
 * the real catalog reads are Node-fs/`ts-morph`-bound and cannot run in a
 * browser bundle, so `@ccs/tokens` is only ever imported (for its types,
 * here, and for its runtime in the Vite dev-server process) — never
 * bundled into the client.
 *
 * ============================================================================
 * CRs (real API vs. the ADR-0022 mock adapter shape — resolved here, not
 * silently): the real `@ccs/tokens` module structurally diverges from the
 * mock `EngineApi` in three ways this file adapts:
 *
 * 1. **`TokenModel` shape.** The mock modeled ADR-0022's prose ("TokenModel:
 *    sets, themes, tokens, alias resolve") as a literal sets/themes TREE
 *    with a `resolve()` method. The REAL `@ccs/tokens` `TokenModel` (P4,
 *    `packages/tokens/src/types.ts`) is FLAT: `{tokens: Token[], themes:
 *    readonly ('light'|'dark')[]}`, where each `Token` carries BOTH theme
 *    values (`value: {light, dark}`) rather than living in a per-theme
 *    token SET. There is no `sets` concept at all in the real Almosafer DS
 *    token source (ADR-0010) and no model-level `resolve()` — P4 exports a
 *    free `findToken(model, group, name)` instead. `sets`, in the mock's
 *    Penpot-inspired UX, don't exist upstream; the closest honest mapping
 *    is one SYNTHETIC set per real `TokenGroup` (color/spacing/rounded/
 *    elevation/typography), each token given its LIGHT value, plus one
 *    extra synthetic `dark-overrides` set (same convention the mock itself
 *    used) holding only the tokens whose dark value actually differs.
 * 2. **`getPropSchema` throws vs. returns null.** The real function throws
 *    `Error('@ccs/tokens: unknown component "X"')` for an unknown name; the
 *    mock/every UI call site (`Inspector.tsx`, `use-component-insert.ts`)
 *    expects a null-able return (`schema ?? null` / `if (!schema) return`).
 *    Adapted at the `/__ccs/catalog/prop-schema` bridge endpoint in
 *    `vite.config.ts` (catches the throw, replies `null`), not here.
 * 3. **`tokensForProperty`'s ref field name + `control` vocabulary.** Real
 *    `TokenRef` is `{token, value}`; the mock/studio-side `TokenRef` is
 *    `{name, value}` — renamed below. Real `PropSchema.control` is
 *    `'enum'|'string'|'boolean'|'number'|'node'|'json'` (mirrors `type` plus
 *    a JSON fallback); the studio's `PropControl` (Inspector's actual widget
 *    choice) is `'select'|'text'|'checkbox'|'number'|'json'` — translated
 *    via `CONTROL_MAP` below (`type` itself needs no translation: both
 *    vocabularies are `'enum'|'string'|'boolean'|'number'|'node'`).
 * ============================================================================
 */

interface RealPropSchemaEntry {
  type: 'enum' | 'string' | 'boolean' | 'number' | 'node';
  enum?: string[];
  default?: unknown;
  control: 'enum' | 'string' | 'boolean' | 'number' | 'node' | 'json';
  required?: boolean;
}
interface RealComponentPropSchema {
  props: Record<string, RealPropSchemaEntry>;
}
interface RealToken {
  name: string;
  group: 'color' | 'spacing' | 'rounded' | 'elevation' | 'typography';
  type: 'color' | 'dimension' | 'shadow' | 'fontFamily' | 'fontWeight' | 'number' | 'string';
  value: { light: string | number; dark: string | number };
  cssVar: string;
  alias?: string;
}
interface RealTokenModel {
  tokens: RealToken[];
  themes: readonly ('light' | 'dark')[];
}
interface RealTokenRef {
  token: string;
  value: string | number;
}

const CONTROL_MAP: Record<RealPropSchemaEntry['control'], PropControl> = {
  enum: 'select',
  string: 'text',
  boolean: 'checkbox',
  number: 'number',
  node: 'json',
  json: 'json',
};

/** Known token-consuming CSS properties, prefetched eagerly at boot so the
 * adapter's `tokensForProperty` can stay SYNCHRONOUS (every current + likely
 * near-term Inspector section) — mirrors `packages/tokens/src/catalog.ts`'s
 * own `CSS_PROPERTY_GROUPS` table (not exported, so not imported directly;
 * duplicated here at the property-NAME level only, not the group-mapping
 * logic itself, which stays server-side/real). */
const PREFETCH_CSS_PROPS = [
  'background-color',
  'color',
  'border-color',
  'border-radius',
  'font-size',
  'padding',
  'gap',
] as const;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`@ccs/studio real-engine-api: GET ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

function mapTokenType(real: RealToken): TokenType {
  if (real.group === 'rounded') return 'radius';
  if (real.type === 'fontWeight') return 'fontWeight';
  if (real.group === 'typography') {
    return /size/i.test(real.name) ? 'fontSize' : 'string';
  }
  if (real.type === 'color' || real.type === 'shadow' || real.type === 'dimension') return real.type;
  return 'string'; // real 'fontFamily'/'number' have no direct mock analogue
}

function adaptTokenModel(real: RealTokenModel): TokenModel {
  const groups = ['color', 'spacing', 'rounded', 'elevation', 'typography'] as const;
  const baseSets = groups.map((group) => ({
    name: group,
    tokens: real.tokens
      .filter((t) => t.group === group)
      .map((t): Token => ({ name: t.name, value: String(t.value.light), type: mapTokenType(t), group })),
  }));
  const darkOverrides = real.tokens.filter((t) => String(t.value.light) !== String(t.value.dark));
  const sets = [
    ...baseSets,
    {
      name: 'dark-overrides',
      tokens: darkOverrides.map((t): Token => ({ name: t.name, value: String(t.value.dark), type: mapTokenType(t), group: t.group })),
    },
  ];
  const baseSetNames = baseSets.map((s) => s.name);

  return {
    sets,
    themes: [
      { name: 'light', sets: baseSetNames },
      { name: 'dark', sets: [...baseSetNames, 'dark-overrides'] },
    ],
    resolve(tokenName: string): Token | null {
      for (const set of sets) {
        const found = set.tokens.find((t) => t.name === tokenName);
        if (found) return found;
      }
      return null;
    },
  };
}

function adaptPropSchema(real: RealComponentPropSchema): ComponentPropSchema {
  const props: ComponentPropSchema['props'] = {};
  for (const [name, entry] of Object.entries(real.props)) {
    // `exactOptionalPropertyTypes` is on: only assign optional keys when the
    // real entry actually has them, rather than spreading `undefined` in.
    props[name] = {
      type: entry.type,
      control: CONTROL_MAP[entry.control],
      ...(entry.enum !== undefined ? { enum: entry.enum } : {}),
      ...(entry.default !== undefined ? { default: entry.default as Json } : {}),
      ...(entry.required !== undefined ? { required: entry.required } : {}),
    };
  }
  return { props };
}

/** Boots the real `EngineApi`: fetches the token model, component list, and
 * every component's prop schema (39 real Almosafer DS components — small
 * enough to prefetch in full, keeping `getPropSchema` synchronous for
 * `Inspector.tsx`/`use-component-insert.ts`'s render/callback call sites)
 * plus a fixed set of commonly-bound CSS properties. Throws if the dev
 * bridge (`vite.config.ts`) isn't reachable — callers should fall back to
 * `createMockEngineApi()` (see `App.tsx`). */
export async function loadRealEngineApi(): Promise<EngineApi> {
  const [realTokenModel, components] = await Promise.all([
    fetchJson<RealTokenModel>('/__ccs/catalog/token-model'),
    fetchJson<ComponentSummary[]>('/__ccs/catalog/components'),
  ]);

  const schemaEntries = await Promise.all(
    components.map(async (c): Promise<[string, ComponentPropSchema | null]> => {
      const real = await fetchJson<RealComponentPropSchema | null>(
        `/__ccs/catalog/prop-schema?name=${encodeURIComponent(c.name)}`,
      );
      return [c.name, real ? adaptPropSchema(real) : null];
    }),
  );
  const schemaByName = new Map(schemaEntries);

  const tokenRefEntries = await Promise.all(
    PREFETCH_CSS_PROPS.map(async (cssProp): Promise<[string, TokenRef[]]> => {
      const refs = await fetchJson<RealTokenRef[]>(
        `/__ccs/catalog/tokens-for-property?cssProp=${encodeURIComponent(cssProp)}`,
      );
      return [cssProp, refs.map((r) => ({ name: r.token, value: String(r.value) }))];
    }),
  );
  const tokenRefsByCssProp = new Map(tokenRefEntries);

  const tokenModel = adaptTokenModel(realTokenModel);

  return {
    tokenModel,
    listComponents(): ComponentSummary[] {
      return components;
    },
    getPropSchema(name: string): ComponentPropSchema | null {
      return schemaByName.get(name) ?? null;
    },
    tokensForProperty(cssProp: string): TokenRef[] {
      return tokenRefsByCssProp.get(cssProp) ?? [];
    },
  };
}
