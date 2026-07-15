import type { Json } from '@ccs/protocol';

/**
 * FROZEN design-system engine API (ADR-0022 — the P4<->P5 seam). P4 owns
 * `packages/tokens` (or a future `@ccs/design-system`) and must export
 * something structurally IDENTICAL to `EngineApi` below. P5 (this package)
 * consumes ONLY this interface, never P4's real implementation — swapping
 * `createMockEngineApi()` for a real `@ccs/tokens` import is meant to be a
 * one-line change at integration (ADR-0022: "Token edits + component
 * inserts flow through EXISTING mechanisms ... no CanvasOp/protocol-frozen
 * change").
 *
 * Shape, quoted verbatim from ADR-0022:
 *   TokenModel (sets, themes, tokens {name,value,type,group}, alias resolve)
 *   listComponents(): {name,category,description}[]
 *   getPropSchema(name): {props: Record<name,{type,enum?,default?,control,required?}>}
 *   tokensForProperty(cssProp): TokenRef[]
 *
 * `PropSchemaEntry` also mirrors ADR-0021's authored `meta.ts` shape
 * exactly (`{type:'enum'|'string'|'boolean'|'number'|'node', enum?,
 * default?, control, required?}`) so `getPropSchema`'s real P4
 * implementation (reading hand-authored `design-system/components/<Name>/meta.ts`
 * files) needs zero reshaping to satisfy this interface.
 */

// --- TokenModel -----------------------------------------------------------

export type TokenType = 'color' | 'dimension' | 'fontSize' | 'fontWeight' | 'radius' | 'shadow' | 'string';

export interface Token {
  name: string;
  value: string;
  type: TokenType;
  /** Grouping used by the TokensPanel tree (playbook §2.4 "sets tree") and
   * by `tokensForProperty` to filter candidates for a given CSS property. */
  group: string;
}

export interface TokenSet {
  name: string;
  tokens: Token[];
}

export interface TokenTheme {
  name: string;
  /** Set names active for this theme, in override order (last wins on a
   * name collision) — mirrors Penpot's sets+themes model (playbook §2.4). */
  sets: string[];
}

export interface TokenModel {
  sets: TokenSet[];
  themes: TokenTheme[];
  /** Alias resolve: looks a token up by its dotted name across every set,
   * returning the first match (v1: no cross-token `{alias}` value chasing —
   * matches P3 ADR-0018 item 12's "minimal handling" scope for tokens). */
  resolve(tokenName: string): Token | null;
}

// --- Component catalog / prop schema ---------------------------------------

export type PropType = 'enum' | 'string' | 'boolean' | 'number' | 'node';
export type PropControl = 'select' | 'text' | 'checkbox' | 'number' | 'json';

export interface PropSchemaEntry {
  type: PropType;
  enum?: string[];
  default?: Json;
  control: PropControl;
  required?: boolean;
}

export interface ComponentPropSchema {
  props: Record<string, PropSchemaEntry>;
}

export interface ComponentSummary {
  name: string;
  category: string;
  description: string;
}

export interface TokenRef {
  name: string;
  value: string;
}

export interface EngineApi {
  tokenModel: TokenModel;
  listComponents(): ComponentSummary[];
  getPropSchema(name: string): ComponentPropSchema | null;
  /** Candidate tokens for a given CSS property (playbook §2.3 token-aware
   * inputs: "every color/size/typography input ... has a token-picker
   * toggle"). `cssProp` is a CSS custom-property-ish key, e.g.
   * `"background-color"`, `"border-radius"`, `"font-size"`. */
  tokensForProperty(cssProp: string): TokenRef[];
}
