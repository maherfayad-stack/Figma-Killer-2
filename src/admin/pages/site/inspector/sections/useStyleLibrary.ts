/**
 * useStyleLibrary - CT-5: what the Text and Effects sections need to offer
 * styles for the selected layer.
 *
 * The "library" is not an object Studio owns. It is the project's own classes
 * whose declarations are one typography or effect bundle (`discoverStyles`),
 * read from the registry the board already loaded; applying one is adding its
 * class to the element in the user's source. A single selection only: giving
 * N layers one class is a different, bigger blast radius than the picker's
 * "this layer" gesture, and no section pretends otherwise.
 */
import { selectSelectedNode, useEditorStore } from '@site/store/store'
import { getStudioStyledRuleSources } from '../../studio/styledRuleSources'
import { commitRestyle } from '../../studio/textStyleCommit'
import {
  appliedStyle,
  discoverStyles,
  type DiscoveredStyle,
  type DiscoveredStyles,
  type StyleFamily,
} from '../../studio/textStyleDiscovery'
import {
  createStyleBlocker,
  planApplyStyle,
  planCreateStyle,
  planDetachStyle,
  type RestyleInput,
} from '../../studio/textStylePlan'
import { lockedStyleProperties } from '../commitApi'

export interface StyleLibrary {
  family: StyleFamily
  styles: DiscoveredStyles
  /** The family's style the layer carries, if any. */
  applied: DiscoveredStyle | null
  /** Why "create style" is unavailable (nothing set to save), or `null`. */
  createBlocker: string | null
  apply(style: DiscoveredStyle): void
  detach(style: DiscoveredStyle): void
  /** Plans and posts a create; resolves to the sentence to show next to the name field, or `null` once posted. */
  create(name: string): Promise<string | null>
}

export function useStyleLibrary(family: StyleFamily): StyleLibrary | null {
  const node = useEditorStore(selectSelectedNode)
  const selectionSize = useEditorStore((s) => s.selectedNodeIds.length)
  const styleRules = useEditorStore((s) => s.site?.styleRules)

  if (!node || selectionSize !== 1 || !styleRules) return null

  const styles = discoverStyles(styleRules, { excludedRuleIds: new Set(Object.keys(getStudioStyledRuleSources())) })
  const input: RestyleInput = { node, styleRules, styles, lockedStyleProps: lockedStyleProperties(node) }

  return {
    family,
    styles,
    applied: appliedStyle(styles, family, node.classIds),
    createBlocker: createStyleBlocker(input, family),
    apply: (style) => void commitRestyle(planApplyStyle(input, style)),
    detach: (style) => void commitRestyle(planDetachStyle(input, style)),
    create: async (name) => {
      const plan = planCreateStyle(input, family, name)
      if (!plan.ok) return plan.message
      await commitRestyle(plan)
      return null
    },
  }
}
