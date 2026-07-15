import type { Options } from 'prettier';
import { formatSync } from './prettier-sync.js';

/**
 * Embedded prettier config — ADR-0018 item 7: "ast-engine embeds the root
 * `.prettierrc.json` options as a constant (a test MUST assert it matches
 * root `.prettierrc.json` so they never drift), applied to every output;
 * `opts.prettierConfig` may override." Reading `.prettierrc.json` at
 * runtime would break the zero-IO contract (§P3), so this is a hand-kept
 * copy, drift-tested by `prettier-config.test.ts` against the real file.
 *
 * KEEP IN SYNC with `/.prettierrc.json` at the repo root.
 */
export const EMBEDDED_PRETTIER_CONFIG = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
  bracketSpacing: true,
} as const satisfies Options;

export interface FormatOptions {
  prettierConfig?: unknown;
}

/**
 * Format `source` (a full .tsx file body) through prettier using the
 * embedded config, allowing a full override via `opts.prettierConfig`
 * (ADR-0018 item 7). Genuinely synchronous — see `prettier-sync.ts` — so
 * `applyOp`'s frozen non-Promise return type (matching the P0 stub and
 * `golden-runner.test.ts`, which never awaits `applyOp`) holds.
 */
export function formatWithEmbeddedConfig(source: string, opts?: FormatOptions): string {
  const config = (opts?.prettierConfig as Options | undefined) ?? EMBEDDED_PRETTIER_CONFIG;
  return formatSync(source, { ...config, parser: 'typescript' });
}
