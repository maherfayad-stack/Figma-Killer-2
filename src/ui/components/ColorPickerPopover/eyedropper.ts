/**
 * EyeDropper feature detection — no ambient DOM lib type for the API yet in
 * this project's TypeScript target, so the shape is declared locally and the
 * lookup is a plain feature check, never an assumption that it exists.
 * `ColorPickerPopover` hides its eyedropper button entirely when this
 * returns `undefined`, rather than rendering one that would throw.
 */

export interface EyeDropperResult {
  sRGBHex: string
}

export interface EyeDropperInstance {
  open: (options?: { signal?: AbortSignal }) => Promise<EyeDropperResult>
}

export interface EyeDropperConstructor {
  new (): EyeDropperInstance
}

export function getEyeDropperConstructor(): EyeDropperConstructor | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper
}
