/**
 * The CMS site prompt must not tell the model to build with a tool that
 * refuses on the page it is looking at.
 *
 * `store-13` shipped the refusal: `site_insert_html` / `site_replace_node_html`
 * on a studio-imported tree return `HTML_IMPORT_ON_SOURCE_REFUSAL`, because an
 * HTML fragment has no honest single source form in the user's `.tsx`. The
 * prompt's opening instruction was still "Insert structure as semantic HTML
 * with site_insert_html", so the model's first tool call on such a page was
 * guaranteed to fail and no tool that COULD work was named anywhere.
 *
 * `buildSiteSystemPrompt` now picks its building block from the snapshot's own
 * node ids. These tests pin both branches and the one thing that makes the
 * split worth having: the studio branch names `studio_apply_edits`.
 */
import { describe, expect, it } from 'bun:test'
import { buildSiteSystemPrompt } from '../../../server/ai/tools/site/systemPrompt'
import type { SiteAgentSnapshot } from '../../../server/ai/tools/site/snapshot'

/**
 * The smallest snapshot the prompt builder reads. Only `page.rootNodeId`,
 * `page.nodes` and the `site`/document fields the dynamic suffix renders are
 * load-bearing here, so the rest is the same empty shape
 * `chatSystemPrompt.ts`'s own fallback uses.
 */
function snapshot(rootNodeId: string, nodeIds: string[]): SiteAgentSnapshot {
  const nodes: Record<string, unknown> = {}
  for (const id of nodeIds) nodes[id] = { id, moduleId: 'base.container', props: {}, children: [] }
  return {
    page: { id: 'p1', title: 'Home', slug: 'index', rootNodeId, nodes },
    currentDocument: { type: 'page', id: 'p1' },
    site: {
      pages: [],
      breakpoints: [],
      styleRules: {},
      visualComponents: [],
      settings: { shortcuts: {} },
    },
    selectedNodeId: null,
    activeBreakpointId: '',
  } as unknown as SiteAgentSnapshot
}

/** The static (cacheable) half — element 0 of the 3-element prompt. */
const staticPrefix = (snap: SiteAgentSnapshot): string => buildSiteSystemPrompt(snap)[0]!

describe('buildSiteSystemPrompt — the building block follows the page source of truth', () => {
  it('a CMS page keeps the site_insert_html building block', () => {
    const prefix = staticPrefix(snapshot('nanoidRoot', ['nanoidRoot', 'nanoidChild']))
    expect(prefix).toContain('Insert structure as semantic HTML with site_insert_html')
    expect(prefix).not.toContain('studio_apply_edits')
  })

  it('a studio-imported page (synthetic :body root) names studio_apply_edits and not site_insert_html as the way to build', () => {
    const prefix = staticPrefix(snapshot('p1:body', ['p1:body']))
    expect(prefix).toContain('studio_apply_edits')
    expect(prefix).not.toContain('Insert structure as semantic HTML with site_insert_html')
  })

  it('a studio-imported page is detected from a source-derived node id even when the root is not the synthetic one', () => {
    const prefix = staticPrefix(
      snapshot('src/pages/Home.tsx:4:3', ['src/pages/Home.tsx:4:3', 'src/pages/Home.tsx:9:7']),
    )
    expect(prefix).toContain('studio_apply_edits')
  })

  it('the studio block says the HTML write tools refuse, rather than leaving the model to discover it', () => {
    const prefix = staticPrefix(snapshot('p1:body', ['p1:body']))
    expect(prefix).toContain('site_insert_html and site_replace_node_html REFUSE')
    // …and still points at the reads, which do work and carry the source ids.
    expect(prefix).toContain('site_read_document')
  })

  it('both branches keep the rest of the prompt intact — only the building block differs', () => {
    const cms = staticPrefix(snapshot('nanoidRoot', ['nanoidRoot']))
    const studio = staticPrefix(snapshot('p1:body', ['p1:body']))
    for (const shared of [
      'You build/edit websites inside a visual site editor by calling tools.',
      'Design system first:',
      'site_apply_css is the ONE tool for CSS on its own.',
      'Reply: 1-2 sentences after acting.',
    ]) {
      expect(cms).toContain(shared)
      expect(studio).toContain(shared)
    }
  })

  it('each branch is a whole, stable prefix — the same snapshot always yields the same cacheable string', () => {
    // The split exists so a driver can still put `cache_control` on element 0.
    const a = staticPrefix(snapshot('p1:body', ['p1:body']))
    const b = staticPrefix(snapshot('p2:body', ['p2:body']))
    expect(a).toBe(b)
  })
})
