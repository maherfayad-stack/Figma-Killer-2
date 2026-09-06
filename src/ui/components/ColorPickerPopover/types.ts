/** A single entry in the project's colour token catalogue — the generic
 * shape `ColorPickerPopover`'s Tokens tab renders. A `src/ui/` primitive
 * must not know what a `FrameworkColorToken` is; the caller (today,
 * `TokenizedColorField`) reshapes its own token model into this. */
export interface ColorPickerToken {
  /** Stable React key — does not need to be the CSS custom property name. */
  id: string
  /** Bare custom-property name, e.g. `--brand-500`. `onChange` receives `var(${name})`. */
  name: string
  /** Resolved CSS colour for the swatch — never a `var()` reference. */
  value: string
  /** Secondary text under the name (a variant label, a category). */
  meta?: string
}
