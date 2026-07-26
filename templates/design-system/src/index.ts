/**
 * templates/design-system — scaffold copied for a new project's
 * design-system/ folder (playbook §4/P0).
 *
 * CHANGE-REQUEST (ADR-0006 compliance): the playbook's generic §4/P0 text
 * asks for `tokens.json` in W3C DTCG format. The REAL Almosafer DS at
 * `./design-system/` does not use DTCG — it ships CSS custom properties
 * (`src/tokens/*.css`) plus a plain JS mirror object (`src/tokens/
 * tokens.js`: colors/colorsDark/spacing/rounded/elevation/typography), dark
 * mode via `@media (prefers-color-scheme: dark)` + a `[data-theme]`
 * override, and NO "sets"/"themes" JSON structure or per-component
 * `meta.ts` at all (components are `Name.jsx` + `Name.css` pairs). Per
 * ADR-0006 ("MUST mirror the Almosafer DS's token/component format so the
 * real one drops in cleanly") this scaffold mirrors THAT shape —
 * `tokens/tokens.css` + `tokens/tokens.ts`, `components/Button/
 * {Button.tsx,Button.css,index.ts}` — instead of DTCG. `meta.ts` is a
 * genuine P0 addition on top (see that file's own CHANGE-REQUEST comment)
 * for P4's ComponentsPanel; it has no counterpart in the real DS.
 */
export * from './tokens/tokens.js';
export { Button, buildButtonClassName, meta as buttonMeta } from './components/Button/index.js';
export type { ButtonProps, ButtonVariant, ButtonSize, ComponentMeta } from './components/Button/index.js';
