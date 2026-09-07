/**
 * styleSectionOrder — which style section comes first, for THIS selection.
 *
 * `CLASS_STYLE_SECTIONS` is one fixed, Figma-shaped order (Position → Size →
 * Auto layout → Spacing → Appearance → Fill → Stroke → Effects → Typography →
 * Animations → Interaction) and stays that way: it is the panel's registry,
 * read by the category rail and the scroll order alike, and a registry that
 * reshuffles itself is a registry nobody can reason about.
 *
 * What changes per selection is the ORDER IT IS RENDERED IN, and exactly one
 * rule changes it: **select a text layer and Typography goes to the top.**
 * On a heading, every edit anyone makes is a type edit; making them scroll
 * past eight sections of box geometry to reach it is the panel failing at its
 * one job. Figma does the same thing by only HAVING a Text section on a text
 * layer.
 *
 * Nothing else moves. Typography is lifted out and the remaining sections
 * keep their relative order underneath it, so the rail and the scroll order
 * stay in lockstep with each other (both read the same returned list).
 */

import type { PageNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { ClassStyleSectionDefinition } from './classStyleSections'

const TYPOGRAPHY_SECTION_ID = 'typography'

/**
 * Host tags that render text directly. A parsed element keeps its real tag as
 * a `tag` prop (`parsedPageToSitePage.ts` synthesizes it so a module default
 * can never silently rewrite an `<h1>` into a `<div>`), which is why this can
 * ask the node rather than the DOM.
 *
 * Deliberately excludes the block containers (`div`, `section`, `article`) —
 * a wrapper that happens to contain text is not a text layer, and promoting
 * Typography on every `<div>` would promote it on everything.
 */
const TEXT_HOST_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'a',
  'label',
  'li',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'blockquote',
  'figcaption',
])

/**
 * Is this node a text layer?
 *
 * Two facts, and a node needs one of them plus a third:
 *
 *   1. its MODULE is text-bearing — it declares `inlineTextEdit`, the same
 *      registry fact the canvas's double-click editor asks before it starts
 *      a session (`inlineEditSlice.ts`). `base.text`, `base.link`,
 *      `base.button` are the three; a plugin module that declares one joins
 *      them automatically, which is why this asks the registry instead of
 *      listing module ids.
 *   2. or its host TAG renders text (`TEXT_HOST_TAGS`) — the case where the
 *      parse produced a `base.container` for a `<span>`/`<li>` because the
 *      element carried something a text module could not model.
 *
 * …AND it has no element children. That last clause is the same one the
 * inline editor uses: a node rendering children renders THEIR text, not its
 * own, and its dominant edit is layout rather than type. It is what keeps a
 * `<a>` wrapping a card, or an `<li>` wrapping a row of controls, out of
 * this.
 */
export function isTextNode(node: PageNode): boolean {
  if (node.children.length > 0) return false
  if (registry.get(node.moduleId)?.inlineTextEdit) return true
  const tag = node.props.tag
  return typeof tag === 'string' && TEXT_HOST_TAGS.has(tag.toLowerCase())
}

/**
 * Does this selection read as text? True only when there is at least one node
 * and EVERY node in it is a text layer — a mixed selection of a heading and
 * its wrapper has no single dominant edit, so it keeps the default order.
 */
export function isTextSelection(nodes: ReadonlyArray<PageNode>): boolean {
  return nodes.length > 0 && nodes.every(isTextNode)
}

/**
 * The section list to render, in order. `textFirst` moves Typography to the
 * front and leaves everything else exactly where it was.
 */
export function orderStyleSections<T extends Pick<ClassStyleSectionDefinition, 'id'>>(
  sections: ReadonlyArray<T>,
  textFirst: boolean,
): ReadonlyArray<T> {
  if (!textFirst) return sections
  const typography = sections.find((section) => section.id === TYPOGRAPHY_SECTION_ID)
  if (!typography) return sections
  return [typography, ...sections.filter((section) => section !== typography)]
}
