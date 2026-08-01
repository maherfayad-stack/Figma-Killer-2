/**
 * previewAxes — WS-10 Phase 1: the board's render-time preview dimensions.
 *
 * Today's canvas renders a project in exactly one configuration: LTR, light.
 * `PreviewAxes` turns that into a named, switchable, persisted triple so the
 * board can preview a project's own RTL/dark-mode support instead of always
 * flattening it to the default.
 *
 * ## Why three fields when Phase 1 only implements two
 *
 * `direction` and `colorScheme` are RENDER-TIME (an attribute on the frame's
 * `<html>`, applied without a re-parse — see `IframeFrameSurface.tsx`).
 * `locale` is PARSE-TIME (it changes which dictionary branch the evaluator
 * resolves, so it needs a project re-parse) and is Phase 2 work — see
 * `STUDIO-NEXT-WORKSTREAMS.md`'s WS-10 §1 for the full architectural
 * reasoning. The type carries `locale` now, already optional and inert, so
 * Phase 2 does not have to reshape this leaf or the `BoardFrame.axes?:
 * Partial<PreviewAxes>` override WS-10 §4.4 adds later — it only has to
 * start reading/writing a field that already exists. Nothing in Phase 1
 * reads or writes `locale` through this module; the project's existing
 * `previewLocale` mechanism (`.studio/meta.json`) is untouched.
 *
 * ## Dependency-free by design
 *
 * This leaf imports nothing beyond the TypeBox helper, so the server
 * (`studioMeta.ts`, `projectPreviewAxes.ts`), the editor store
 * (`canvasSlice.ts`), and the canvas (`IframeFrameSurface.tsx`) can all
 * import it without pulling in anything else — same posture as
 * `@core/framework-schema` for persisted framework settings.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const PreviewAxesSchema = Type.Object({
  direction: Type.Union([Type.Literal('ltr'), Type.Literal('rtl')]),
  /**
   * A key of the project's own locale dictionary, or `undefined` for "use
   * the project's default". Phase 2 (WS-10 §4) — not read or written by
   * anything in Phase 1. Kept in the type now so the triple never needs to
   * reshape (see module doc).
   */
  locale: Type.Optional(Type.String({ minLength: 1 })),
  colorScheme: Type.Union([Type.Literal('light'), Type.Literal('dark')]),
})
export type PreviewAxes = Static<typeof PreviewAxesSchema>

export const DEFAULT_PREVIEW_AXES: PreviewAxes = {
  direction: 'ltr',
  colorScheme: 'light',
}
