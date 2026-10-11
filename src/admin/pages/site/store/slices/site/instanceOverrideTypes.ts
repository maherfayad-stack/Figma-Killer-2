/**
 * instanceOverrideTypes — the store surface of OD-19's "editing a value inside
 * a shared component changes ONLY that instance" (`instanceOverrideActions.ts`),
 * in its own module for the reason `instanceDetachTypes.ts` is: `SiteSlice`
 * (`types.ts`) is at its size ceiling.
 */
export interface InstanceOverrideSlice {
  /**
   * Which variant prop a style edit made inside a component is aimed at, when
   * several props style the selected element (`variant` and `size`): the
   * variant edit context (CV-4, `variantStyleContext.ts`) picks the first with a
   * rule until the person chooses. A prop name, `null` for "the default".
   */
  variantEditAxis: string | null
  setVariantEditAxis: (prop: string | null) => void
}
