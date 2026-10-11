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
  /**
   * CT-4 - the mode chosen on every OTHER axis the project's own CSS defines
   * (`theme`, `density`, ...), keyed by the token catalog's axis id
   * (`@core/studio-tokens`' `ModeAxis.id`). An axis absent here is on its
   * default mode. `direction`, `colorScheme` and `locale` above are the same
   * thing for the three axes with first-class behaviour (the toolbar, the
   * parse-time locale reload); {@link getAxisMode}/{@link withAxisMode} read
   * and write both through one door, so a caller never has to know which
   * storage an axis lives in.
   */
  modes: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.String({ minLength: 1, maxLength: 200 }))),
})
export type PreviewAxes = Static<typeof PreviewAxesSchema>

export const DEFAULT_PREVIEW_AXES: PreviewAxes = {
  direction: 'ltr',
  colorScheme: 'light',
}

/** The catalog axis ids that are stored in a named `PreviewAxes` field rather than in `modes`. */
export const COLOR_SCHEME_AXIS_ID = 'color-scheme'
export const DIRECTION_AXIS_ID = 'direction'
export const LOCALE_AXIS_ID = 'locale'

/** The mode `axes` selects on `axisId`, or `undefined` when that axis is on its default. */
export function getAxisMode(axes: Partial<PreviewAxes>, axisId: string): string | undefined {
  switch (axisId) {
    case COLOR_SCHEME_AXIS_ID:
      return axes.colorScheme
    case DIRECTION_AXIS_ID:
      return axes.direction
    case LOCALE_AXIS_ID:
      return axes.locale
    default:
      return axes.modes?.[axisId]
  }
}

/**
 * `axes` with `axisId` set to `modeId` (`undefined` puts the axis back on its
 * default). A value the three named fields cannot hold (`direction: 'sideways'`)
 * is refused by returning `axes` unchanged, so a stale chip can never write a
 * value the toolbar would not.
 */
export function withAxisMode<T extends Partial<PreviewAxes>>(axes: T, axisId: string, modeId: string | undefined): T {
  switch (axisId) {
    case COLOR_SCHEME_AXIS_ID:
      return modeId === 'light' || modeId === 'dark' ? { ...axes, colorScheme: modeId } : modeId === undefined ? omitKey(axes, 'colorScheme') : axes
    case DIRECTION_AXIS_ID:
      return modeId === 'ltr' || modeId === 'rtl' ? { ...axes, direction: modeId } : modeId === undefined ? omitKey(axes, 'direction') : axes
    case LOCALE_AXIS_ID:
      return modeId === undefined ? omitKey(axes, 'locale') : modeId.length > 0 ? { ...axes, locale: modeId } : axes
    default: {
      const { [axisId]: _previous, ...others } = axes.modes ?? {}
      const modes = modeId === undefined ? others : { ...others, [axisId]: modeId }
      return Object.keys(modes).length > 0 ? { ...axes, modes } : omitKey(axes, 'modes')
    }
  }
}

function omitKey<T extends Partial<PreviewAxes>>(axes: T, key: keyof PreviewAxes): T {
  const { [key]: _dropped, ...rest } = axes
  return rest as T
}

/**
 * The board default with a frame's own override laid on top, PER AXIS: a frame
 * that pins only `direction` still inherits the board's `colorScheme`, and one
 * that pins `modes.theme` keeps the board's other modes. The one place the
 * merge is defined - the frame effect, the frame header and the chip read it.
 */
export function mergePreviewAxes(board: PreviewAxes, override: Partial<PreviewAxes> | undefined): PreviewAxes {
  if (!override) return board
  const merged: PreviewAxes = { ...board, ...override }
  if (board.modes || override.modes) merged.modes = { ...board.modes, ...override.modes }
  return merged
}

/** Every axis `axes` selects a mode on, as the catalog's `axisId -> modeId` map (the three named axes always included except an unset locale). */
export function axisSelection(axes: PreviewAxes): Record<string, string> {
  return {
    ...axes.modes,
    [COLOR_SCHEME_AXIS_ID]: axes.colorScheme,
    [DIRECTION_AXIS_ID]: axes.direction,
    ...(axes.locale ? { [LOCALE_AXIS_ID]: axes.locale } : {}),
  }
}
