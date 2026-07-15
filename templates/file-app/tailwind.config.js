import tokensPreset from './tokens.preset.js';

/**
 * `tokens.preset.js` is regenerated in-place by the sync-daemon's
 * design-system watch (playbook §4/P4, ADR-0022) — every `bg-*`/`text-*`/
 * `rounded-*`/`shadow-*`/font utility it contributes resolves to a
 * `var(--css-var)` from the paired `src/tokens.css`, so a token VALUE edit
 * ripples through Tailwind's existing classes with no rebuild of this file
 * needed (only the preset's KEY SET — new/removed tokens — requires Vite to
 * pick up the new module, which its own dev-server watch already does).
 * Ships with a real seed copy (plain relative import — zero @ccs/* runtime
 * dep, P0 standalone contract) so a fresh scaffold looks correct before any
 * studio daemon ever boots.
 * @type {import('tailwindcss').Config}
 */
export default {
  presets: [tokensPreset],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
};
