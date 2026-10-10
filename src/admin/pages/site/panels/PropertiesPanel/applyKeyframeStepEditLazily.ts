/**
 * The one dynamic-import door to `keyframesStepEdit.ts` (the postcss-backed
 * keyframe writers — see that file for why they are not in the editor's static
 * graph). Its own plain function, not an inline `await import()` in the popover:
 * the React Compiler cannot lower an import expression, so inside a component
 * it silently stops memoising the whole component (`react-compiler-bailouts`).
 */
export async function applyKeyframeStepEditLazily(
  rawCss: string,
  name: string,
  keyText: string,
  property: string,
  value: string | undefined,
): Promise<string | null> {
  const { applyKeyframeStepEdit } = await import('./keyframesStepEdit')
  return applyKeyframeStepEdit(rawCss, name, keyText, property, value)
}
