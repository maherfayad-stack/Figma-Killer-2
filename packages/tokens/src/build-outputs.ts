import { emitCss } from './emit-css.js';
import { emitTailwindPreset, serializePresetModule, type TailwindPreset } from './emit-tailwind-preset.js';
import { parseAlmosaferTokensJs } from './parse-almosafer.js';
import type { TokenModel } from './types.js';

export interface TokenOutputs {
  model: TokenModel;
  css: { light: string; dark: string };
  preset: TailwindPreset;
  presetModule: string;
}

/**
 * Convenience aggregate the sync-daemon's rebuild pipeline calls once per
 * `design-system/**` change: parse tokens.js source text -> TokenModel ->
 * every emitted artifact. STILL PURE (text in, data/text out) — the daemon
 * does the one `readFile` and N `writeFile`s around this call.
 */
export function buildTokenOutputs(tokensJsSourceText: string): TokenOutputs {
  const model = parseAlmosaferTokensJs(tokensJsSourceText);
  const preset = emitTailwindPreset(model);
  return {
    model,
    css: { light: emitCss(model, 'light'), dark: emitCss(model, 'dark') },
    preset,
    presetModule: serializePresetModule(preset),
  };
}
