/**
 * instanceOverrideTypes — the store surface of OD-19's "editing a value inside
 * a shared component changes ONLY that instance" (`instanceOverrideActions.ts`),
 * in its own module for the reason `instanceDetachTypes.ts` is: `SiteSlice`
 * (`types.ts`) is at its size ceiling.
 */
/** A class write the inspector made to one element: the rule's id, the new values, and the context (breakpoint or condition) they were made in. */
export interface ClassOverrideRequest {
  nodeId: string
  classId: string
  patch: Readonly<Record<string, string | number | null>>
  contextId: string | null
}

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
   * G-2b - a class edit made inside a shared component's instance. True when
   * the store took it over (it is an `expose-class` for this one instance, and
   * the caller must NOT also write the class); false when the ordinary class
   * write stands - after saying why in a notice when it changes every instance.
   */
  overrideClassOnInstance: (request: ClassOverrideRequest) => boolean
  /** Would a class edit on this element be an instance-only edit, so a live preview must not paint the shared class? */
  instanceClassEditIsLocal: (nodeId: string, classId: string) => boolean
}
