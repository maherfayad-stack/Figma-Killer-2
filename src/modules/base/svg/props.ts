import { Type, type Static } from '@core/utils/typeboxHelpers'

export const SvgPropsSchema = Type.Object({
  svg: Type.String({ default: '' }),
  title: Type.String({ default: '' }),
  /**
   * The authored element wrapping this markup in the user's source
   * (`<span className={styles.icon} dangerouslySetInnerHTML=… />`), or `''`
   * when the source wrote a bare `<svg>` and there is no wrapper. Synthesized
   * by `parsedPageToSitePage` from the element's own tag name, never read off
   * an attribute — see `resolveSvgHostTag`. Deliberately absent from
   * `SvgModule.schema`: it is a faithful record of the source, not a setting.
   */
  tag: Type.String({ default: '' }),
})

export type SvgStoredProps = Static<typeof SvgPropsSchema>
