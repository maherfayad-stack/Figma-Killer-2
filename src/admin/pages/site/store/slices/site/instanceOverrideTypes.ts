/**
 * instanceOverrideTypes — the store surface of OD-19's "editing a value inside
 * a shared component changes ONLY that instance" (`instanceOverrideActions.ts`),
 * in its own module for the reason `instanceDetachTypes.ts` is: `SiteSlice`
 * (`types.ts`) is at its size ceiling.
 */
export interface InstanceOverrideSlice {
  /**
   * The component the user chose to edit as a WHOLE ("Edit main component"),
   * or `null`. While it names a component, a value edited inside any instance
   * of it is written to the component's own markup and changes every instance
   * — the explicit all-instances mode OD-19 keeps beside the instance-only
   * default. Compared with `PageNode.fromComponent`.
   */
  mainEditComponent: string | null
  setMainEditComponent: (componentName: string | null) => void
  /**
   * Which variant prop a style edit made inside a component is aimed at, when
   * several props style the selected element (`variant` and `size`): the
   * variant edit context (CV-4, `variantStyleContext.ts`) picks the first with a
   * rule until the person chooses. A prop name, `null` for "the default".
   */
  variantEditAxis: string | null
  setVariantEditAxis: (prop: string | null) => void
}
