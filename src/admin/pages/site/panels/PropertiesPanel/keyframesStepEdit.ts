/**
 * keyframesStepEdit — computing the new `@keyframes` text for one edited step.
 *
 * Its own module, reached only through the dynamic `import()` in
 * `applyKeyframeStepEditLazily.ts`, because it is the one place the editor runs the
 * postcss-based writers in `@core/css-codemods` (the SAME functions the server
 * runs against the real `.css` file — so the canvas preview and the disk write
 * cannot disagree about what an edit means; the client is performing the
 * write against a copy of the text, not modelling it). A static import would
 * put postcss — and its `path`/`fs`/`url`/`source-map-js` shims, each a
 * console warning in the browser — into the editor's load graph for a gesture
 * most sessions never make. Gate: `postcss-not-in-admin-bundle.test.ts`.
 */
import { removeDeclarationAtKeyframe, setDeclarationAtKeyframe } from '@core/css-codemods'

/**
 * The new `rawCss` for one step declaration being set or cleared, or `null`
 * when nothing changed (an already-correct value, or a step/block the text
 * does not contain).
 *
 * `value: undefined` clears. Property names are CSS kebab-case here, not the
 * editor's camelCase: a keyframes body is CSS text, and `readKeyframeSteps`
 * hands its declarations back exactly as authored.
 */
export function applyKeyframeStepEdit(
  rawCss: string,
  name: string,
  keyText: string,
  property: string,
  value: string | undefined,
): string | null {
  const result =
    value === undefined
      ? removeDeclarationAtKeyframe(rawCss, name, keyText, property)
      : setDeclarationAtKeyframe(rawCss, name, keyText, property, value)
  return result.changed ? result.css : null
}
