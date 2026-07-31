import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * `studio.instance` (WS-4.2) — the fields `ParsedNode.instanceOf` mirrors
 * onto `PageNode.props` (`src/core/studio-sync/parsedPageToSitePage.ts`).
 * `callSiteProps` is intentionally `Type.Unknown()`: its shape is whatever
 * the target component's own signature accepts (`ParsedPropValue`, JSON-
 * shaped), which this schema has no way to know per-instance — the
 * Properties panel classifies it at render time via the component's own
 * TS signature (WS-3.1's `PropKind`, not this schema).
 */
export const InstancePropsSchema = Type.Object({
  componentName: Type.String({ default: '' }),
  source: Type.Union([Type.Literal('local'), Type.Literal('package')], { default: 'local' }),
  sourceFile: Type.String({ default: '' }),
  callSiteProps: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
})

export type InstanceStoredProps = Static<typeof InstancePropsSchema>
