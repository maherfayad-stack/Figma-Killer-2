/**
 * variantStoryUses — the Storybook stories that PASS a variant value as an arg.
 *
 * Remove variant is refused while a call site uses the value
 * (`callSitesPassingVariant`, `variant-in-use`). A story's `args` are call
 * sites too: `export const Ghost = { args: { variant: 'ghost' } }` renders
 * `<Button variant="ghost" />` on the Stories board, and removing `ghost` would
 * leave that story passing a value the type no longer allows. There is no JSX
 * for the JSX call-site scan to find in an args-only story, so this reads the
 * stories the way the board does (`discoverStories`, merged `meta.args` and
 * `story.args`, literals only) and reports the story's own export.
 *
 * A story counts when its `meta.component` resolves to the component's FILE: a
 * file with two components that both take the prop is over-counted rather than
 * missed, because over-refusing a remove is the safe direction. Parse, never
 * execute: nothing here runs a story.
 */
import type { Project } from 'ts-morph'
import type { VariantUse } from '@core/ast-codemods'
import { discoverStories, storyFilesIn } from './storyDiscovery'

export function storiesPassingVariant(
  dir: string,
  project: Project,
  componentRel: string,
  prop: string,
  member: string,
): VariantUse[] {
  const files = storyFilesIn(dir)
  if (files.length === 0) return []
  const uses: VariantUse[] = []
  for (const story of discoverStories(dir, project, files).stories) {
    const { body } = story
    if (body.kind !== 'args' || body.componentSource.kind !== 'local' || body.componentSource.file !== componentRel) continue
    if (body.args[prop] === member) uses.push({ file: story.relFile, line: story.line, col: story.col })
  }
  return uses
}
