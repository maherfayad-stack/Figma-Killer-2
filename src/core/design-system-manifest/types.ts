/**
 * The manifest shape for the BUILT-IN design system.
 *
 * `ComponentSpec` (`@core/component-manifest`) is the generic shape every
 * component source produces — a third-party package's `.d.ts` extraction, a
 * local component's parse. It carries prop truth and nothing else, because
 * prop truth is all those sources have: nobody can honestly describe an
 * arbitrary npm component in one sentence or file it under "Navigation".
 *
 * Studio's own vendored design system CAN be described, because Studio ships
 * its docs and curates its grouping. That extra truth is required here rather
 * than optional on `ComponentSpec` — a built-in component with no description,
 * no keywords or no group is a bug, and `assets-search-coverage.test.ts` fails
 * on it — while every generic `ComponentSpec` consumer keeps working
 * unchanged, since this is a strict subtype.
 */
import type { ComponentSpec } from '../component-manifest/types'

export interface DesignSystemComponentSpec extends ComponentSpec {
  /** One sentence, from `design.md` — see `componentCuration.ts`. */
  description: string
  /** Search synonyms, purposes and variant names; lower-cased, de-duplicated, sorted. */
  keywords: string[]
  /** The Assets-panel section this component belongs to, from `studio/groups.json`. */
  group: string
}

export interface DesignSystemManifest {
  components: DesignSystemComponentSpec[]
}
