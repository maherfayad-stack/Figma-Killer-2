import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  createToken,
  deleteToken,
  resolveExportName,
  setTokenValue,
  TokenEditError,
  type FlatExportName,
} from '@ccs/tokens';
import type { TokenGroup, TokenTheme } from '@ccs/protocol';
import { tokensJsPath } from './token-rebuild.js';
import type { SelfWriteTracker } from './self-write-tracker.js';

/**
 * The write-through path for the P4 token-CRUD control messages
 * (`packages/protocol/src/control-messages.ts`: `set-token`/`create-
 * token`/`delete-token`) — the ONLY place the daemon writes into
 * `design-system/src/tokens/tokens.js` (One Rule: daemon = sole
 * fs-writer). Mirrors `op-apply.ts`'s discipline: read -> pure compute
 * (`@ccs/tokens`'s format-preserving `setTokenValue`/`createToken`/
 * `deleteToken`) -> atomic write, marking the self-write tracker so
 * `watchDesignSystem`'s rediscovery of this exact change doesn't double
 * -broadcast `tokens-changed` (the caller in `daemon.ts` broadcasts it
 * once, explicitly, after this succeeds AND the rebuild pipeline runs).
 */

export type TokenCrudKind = 'set-token' | 'create-token' | 'delete-token';

export interface TokenCrudRequest {
  kind: TokenCrudKind;
  group: TokenGroup;
  theme: TokenTheme;
  key: string;
  /** Required for set-token/create-token; ignored for delete-token. */
  value?: string | number;
}

export type TokenCrudResult = { ok: true } | { ok: false; reason: string };

/**
 * AUDIT-7 blocker close-out — the AUTHORITATIVE validation gate for
 * token-CRUD `key`/`value`. `packages/protocol/src/control-messages.ts`
 * narrows the wire schema too (cheap, superset-compatible early filter),
 * but THIS is the check that actually decides whether a request may reach
 * `setTokenValue`/`createToken`/`deleteToken` and, from there, the CSS
 * emission sink (`@ccs/tokens`'s `emitCss`/`css-var.ts`, which also
 * sanitize/reject independently as defense-in-depth — see their module
 * docs). PROVEN LIVE exploit this closes: a `create-token` with
 * `key: "x: red; } body { display:none } /* pwned"` (or the equivalent via
 * `value`) previously flowed unescaped into `--${cssVar}: ${value};` in the
 * emitted `tokens.css`, which every file-folder's daemon-driven HMR then
 * picked up.
 *
 * `key` is restricted to the same CSS-custom-property-safe identifier
 * charset the wire schema now also asserts (letters/digits/`_`/`-`,
 * 1-64 chars) — this is what ultimately gets kebab-cased and spliced into
 * a `--group-key` custom-property name (`css-var.ts`), so it must never
 * contain whitespace, `;`, `{`, `}`, or comment delimiters. `value` is
 * validated PER GROUP: `color` must look like an actual color (hex or
 * `rgb()`/`rgba()`); `spacing`/`rounded` (dimension-shaped groups) must be
 * a bare number or a `<number><unit>` string; `elevation` (free-text,
 * e.g. multi-part `box-shadow` values) is checked only for the sequences
 * that could terminate a CSS declaration/rule or open a comment. Applies
 * to both `set-token` and `create-token`; `delete-token` only needs the
 * key check (no value is written).
 */
const TOKEN_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const CSS_BREAKING_VALUE_PATTERN = /[;{}]|\/\*|\*\/|[\r\n]/;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const RGB_COLOR_PATTERN =
  /^rgba?\(\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;

const DIMENSION_PATTERN = /^-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|vmin|vmax)?$/;

export function validateTokenKey(key: string): string | undefined {
  if (!TOKEN_KEY_PATTERN.test(key)) {
    return `invalid token key "${key}": must be 1-64 chars of letters, digits, "_", or "-"`;
  }
  return undefined;
}

export function validateTokenValue(group: TokenGroup, value: string | number): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : `invalid token value: ${value} is not a finite number`;
  }
  if (value.length === 0) return 'invalid token value: must not be empty';
  if (value.length > 300) return 'invalid token value: exceeds maximum length (300)';
  if (CSS_BREAKING_VALUE_PATTERN.test(value)) {
    return `invalid token value "${value}": must not contain ";", "{", "}", "/*", "*/", or a newline`;
  }
  if (group === 'color') {
    if (!HEX_COLOR_PATTERN.test(value) && !RGB_COLOR_PATTERN.test(value)) {
      return `invalid color value "${value}": expected a hex color or rgb()/rgba()`;
    }
  } else if (group === 'spacing' || group === 'rounded') {
    if (!DIMENSION_PATTERN.test(value)) {
      return `invalid dimension value "${value}": expected a number optionally suffixed with px/rem/em/%/vh/vw`;
    }
  }
  // elevation (and any other free-text group) — already checked above for
  // declaration/rule-breaking sequences; no further per-group shape.
  return undefined;
}

async function atomicWriteFile(absPath: string, content: string, selfWriteTracker: SelfWriteTracker): Promise<void> {
  const dir = dirname(absPath);
  const tmp = join(
    dir,
    `.${basename(absPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(tmp, content, 'utf8');
  selfWriteTracker.markWritten(absPath);
  await rename(tmp, absPath);
}

export async function applyTokenCrud(
  projectRoot: string,
  request: TokenCrudRequest,
  selfWriteTracker: SelfWriteTracker,
): Promise<TokenCrudResult> {
  // AUTHORITATIVE gate (AUDIT-7 blocker) — reject before any read/AST-edit
  // is attempted, let alone before a bad key/value could reach the CSS
  // emission sink. Runs for every kind, including delete-token (key only).
  const keyError = validateTokenKey(request.key);
  if (keyError) return { ok: false, reason: keyError };

  const exportName: FlatExportName | undefined = resolveExportName(request.group, request.theme);
  if (!exportName) {
    return { ok: false, reason: `token CRUD for group "${request.group}" is not supported (v1 scope)` };
  }

  const path = tokensJsPath(projectRoot);
  let sourceText: string;
  try {
    sourceText = await readFile(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `tokens.js not readable: ${err instanceof Error ? err.message : String(err)}` };
  }

  let newText: string;
  try {
    if (request.kind === 'set-token') {
      if (request.value === undefined) return { ok: false, reason: '"value" is required for set-token' };
      const valueError = validateTokenValue(request.group, request.value);
      if (valueError) return { ok: false, reason: valueError };
      newText = setTokenValue(sourceText, { exportName, key: request.key }, request.value);
    } else if (request.kind === 'create-token') {
      if (request.value === undefined) return { ok: false, reason: '"value" is required for create-token' };
      const valueError = validateTokenValue(request.group, request.value);
      if (valueError) return { ok: false, reason: valueError };
      newText = createToken(sourceText, { exportName, key: request.key }, request.value);
    } else {
      newText = deleteToken(sourceText, { exportName, key: request.key });
    }
  } catch (err) {
    if (err instanceof TokenEditError) return { ok: false, reason: err.message };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    await atomicWriteFile(path, newText, selfWriteTracker);
  } catch (err) {
    return { ok: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}
