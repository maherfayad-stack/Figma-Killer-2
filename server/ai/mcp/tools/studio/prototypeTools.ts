/**
 * Studio prototype tools — the agent's half of the interaction layer.
 *
 * Three tools, which together let an agent author a flow end to end:
 *
 *   studio_list_prototype_links   → what flows exist, and whether they still point at something
 *   studio_set_prototype_link     → draw one, or repoint one
 *   studio_delete_prototype_link  → remove one
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE AGENT TAKES A NODE ID AND NOT A NodeHint
 * ─────────────────────────────────────────────────────────────────────────
 * A persisted link stores a `NodeHint` — `nodeId` plus `indexPath`, `moduleId`
 * and `textSnippet` — because a Studio node id is `relFile:line:col` and rots
 * on nearly every edit (`@core/studio-anchor`). None of that is knowledge the
 * agent has, or should have to fabricate: an `indexPath` it computed by hand
 * would be a guess written to disk as a fact.
 *
 * So these tools take the one thing the agent genuinely holds — a `nodeId`
 * from the page tree — and build the hint here with `captureNodeHint`, against
 * a freshly parsed tree. The agent cannot store a malformed anchor because it
 * never writes one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE REFUSALS — read this before loosening anything
 * ─────────────────────────────────────────────────────────────────────────
 * Same posture as `commentTools`' anchor gate and `refuseStructuralEdit`: when
 * there is not exactly one honest target, say so rather than guess.
 *
 *   - A `nodeId` that does not resolve in the page is REFUSED, with the page's
 *     real node count. A link stored against a node that was never there is a
 *     connector pointing at nothing, and the board draws it as broken.
 *   - A `targetPageId` that is not a page in this project is REFUSED. The
 *     player would navigate to a screen that cannot be rendered.
 *   - `navigate`/`overlay` REQUIRE a target; `back`/`close` refuse one. Both
 *     are defined entirely by the history stack (`@core/studio-prototype`).
 *   - A transition the action cannot wear is REFUSED rather than silently
 *     repaired. `serialize.ts` repairs a hand-edited FILE because the
 *     alternative there is losing the link; a tool call is a live caller that
 *     can be told, and telling it is how the agent learns the pairing.
 *
 * The list tool reports `anchorConfidence` on every link, so a well-behaved
 * agent repoints a `detached` link instead of leaving a dead one on the board.
 */
import { randomUUID } from 'node:crypto'
import { Type } from '@core/utils/typeboxHelpers'
import {
  ACTION_TRANSITIONS,
  actionTakesTarget,
  type PrototypeAction,
  type PrototypeLink,
  type PrototypeTransition,
} from '@core/studio-prototype'
import { captureNodeHint, resolveNodeAnchor, type AnchorConfidence } from '@core/studio-anchor'
import type { Page } from '@core/page-tree'
import type { AiTool, ToolContext } from '../../../runtime/types'
import {
  applyPrototypeOp,
  readPrototypeFile,
  writePrototypeFile,
} from '../../../../handlers/studio/prototypeStore'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { pushStudioLiveReload } from './liveReloadPush'

const DirField = Type.Optional(
  Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
)

const ACTIONS = ['navigate', 'overlay', 'back', 'close'] as const
const TRANSITIONS = [
  'instant',
  'dissolve',
  'slide-left',
  'slide-right',
  'push-left',
  'push-right',
  'popup',
  'sheet',
] as const

/** Every page in the project, by id. One parse per call. */
async function pagesById(dir: string): Promise<Map<string, Page>> {
  const loaded = await loadStudioPages(dir)
  return new Map(loaded.pages.map((page) => [page.id, page]))
}

/**
 * What a link points at now, not what it pointed at when it was drawn.
 *
 * `unanchored` is impossible for a prototype link — one is authored BY naming
 * an element — so it is reported as `detached`, which is what it means here.
 */
function confidenceFor(link: PrototypeLink, pages: Map<string, Page>): AnchorConfidence {
  // A `Page` IS the NodeTree — it carries `rootNodeId`/`nodes` directly, so it
  // is passed as the tree rather than reached into.
  const resolved = resolveNodeAnchor(link.source.node, pages.get(link.source.pageId) ?? null)
  return resolved.confidence === 'unanchored' ? 'detached' : resolved.confidence
}

function linkSummary(
  link: PrototypeLink,
  pages: Map<string, Page>,
  confidence: AnchorConfidence | null,
) {
  const sourcePage = pages.get(link.source.pageId)
  const targetPage = link.targetPageId ? pages.get(link.targetPageId) : undefined
  return {
    linkId: link.id,
    origin: link.origin,
    trigger: link.trigger,
    action: link.action,
    source: {
      pageId: link.source.pageId,
      pageTitle: sourcePage?.title ?? null,
      nodeId: link.source.node.nodeId,
      moduleId: link.source.node.moduleId,
      text: link.source.node.textSnippet,
    },
    targetPageId: link.targetPageId,
    targetPageTitle: targetPage?.title ?? null,
    ...(link.transition ? { transition: link.transition } : {}),
    ...(confidence ? { anchorConfidence: confidence } : {}),
  }
}

// ---------------------------------------------------------------------------
// studio_list_prototype_links
// ---------------------------------------------------------------------------

const ListInputSchema = Type.Object(
  {
    dir: DirField,
    pageId: Type.Optional(
      Type.String({ description: 'Only links whose SOURCE element is on this page. Omit for the whole project.' }),
    ),
    resolveAnchors: Type.Optional(
      Type.Boolean({
        description:
          'Recompute each link\'s anchorConfidence against the live source (default true). Costs a project parse; pass false when you only want the flow graph.',
      }),
    ),
  },
  { additionalProperties: false },
)

const studioListPrototypeLinksTool: AiTool = {
  name: 'studio_list_prototype_links',
  scope: 'shared',
  execution: 'server',
  // No `requiredCapabilities` — the read posture every other Studio read tool
  // takes. The two writes below are gated on `studio.write` like their siblings.
  description:
    'List the prototype interactions authored on this project (.studio/prototype.json) — the clickable flow between screens. Returns { ok, dir, links:[{ linkId, origin, trigger, action, source:{ pageId, pageTitle, nodeId, moduleId, text }, targetPageId, targetPageTitle, transition, anchorConfidence }] }. An interaction says "clicking THIS element does THAT": `navigate` replaces the screen, `overlay` presents on top with the screen still mounted underneath, `back` pops the history, `close` dismisses the top overlay. Interactions are a DESIGN layer — they are never written into the user\'s .tsx and the publisher never sees them, but they do play in the exported prototype app. `origin` is "design" (drawn in Studio, editable) or "code" (read out of a real onClick, READ-ONLY). CRITICAL: `anchorConfidence` says whether the source element still exists — "exact"/"moved" mean yes, "drifted" means it was edited since the link was drawn, "detached" means it is gone and the link is dead on the board. Repoint a detached link with studio_set_prototype_link rather than leaving it.',
  inputSchema: ListInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pageId, resolveAnchors = true } = input as {
      dir?: string
      pageId?: string
      resolveAnchors?: boolean
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const file = readPrototypeFile(dir)
    const links = pageId ? file.links.filter((link) => link.source.pageId === pageId) : file.links

    const pages = resolveAnchors ? await pagesById(dir) : new Map<string, Page>()

    return {
      ok: true,
      dir,
      links: links.map((link) =>
        linkSummary(link, pages, resolveAnchors ? confidenceFor(link, pages) : null),
      ),
    }
  },
}

// ---------------------------------------------------------------------------
// studio_set_prototype_link
// ---------------------------------------------------------------------------

const SetInputSchema = Type.Object(
  {
    dir: DirField,
    linkId: Type.Optional(
      Type.String({ description: 'Update an existing link. Omit to create a new one.' }),
    ),
    pageId: Type.String({ description: 'The page the clickable element is on, from studio_list_pages.' }),
    nodeId: Type.String({
      description:
        'The element that is clicked, as a Studio node id (relFile:line:col) from the page tree. The durable anchor is built here — do not try to supply an index path.',
    }),
    action: Type.Union(ACTIONS.map((value) => Type.Literal(value)), {
      description:
        'navigate = replace the screen (pushes history). overlay = present on top, base screen stays mounted. back = pop the history. close = dismiss the top overlay. back/close take no target and no transition.',
    }),
    targetPageId: Type.Optional(
      Type.String({ description: 'The destination page. Required for navigate/overlay, refused for back/close.' }),
    ),
    transition: Type.Optional(
      Type.Union(TRANSITIONS.map((value) => Type.Literal(value)), {
        description:
          'navigate accepts instant | dissolve | slide-left | slide-right | push-left | push-right. overlay accepts popup | sheet. back/close accept none. Defaults to the action\'s first legal transition.',
      }),
    ),
  },
  { additionalProperties: false },
)

const studioSetPrototypeLinkTool: AiTool = {
  name: 'studio_set_prototype_link',
  scope: 'shared',
  execution: 'server',
  requiredCapabilities: ['studio.write'],
  description:
    'Create or repoint a prototype interaction: "clicking this element goes to that screen, like this". Pass the source pageId + the element\'s nodeId (from the page tree) and the action; the durable anchor is captured here against a fresh parse, so you never construct an index path yourself. Omit linkId to create, pass one from studio_list_prototype_links to update. navigate/overlay require targetPageId; back/close refuse one. Transition defaults to the action\'s first legal value (navigate → instant, overlay → popup) and a transition the action cannot wear is refused, not silently repaired. Refuses with { ok:false, code } when the nodeId is not in that page ("no-such-node"), the target is not a page ("no-such-target"), or the action/target/transition combination is impossible — a link stored against nothing is a connector pointing at nothing. Interactions are a design layer: this writes .studio/prototype.json and never touches the user\'s .tsx.',
  inputSchema: SetInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, linkId, pageId, nodeId, action, targetPageId, transition } = input as {
      dir?: string
      linkId?: string
      pageId: string
      nodeId: string
      action: PrototypeAction
      targetPageId?: string
      transition?: PrototypeTransition
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const pages = await pagesById(dir)

    const page = pages.get(pageId)
    if (!page) {
      return {
        ok: false,
        code: 'no-such-page',
        error: `No page "${pageId}" in this project.`,
        availablePageIds: [...pages.keys()],
      }
    }

    // The hint is captured, never accepted. A null here means the id names
    // nothing in this tree — refuse rather than store a dead anchor.
    const hint = captureNodeHint(page, nodeId)
    if (!hint) {
      return {
        ok: false,
        code: 'no-such-node',
        error: `Node "${nodeId}" is not in page "${pageId}". Node ids are relFile:line:col and go stale on nearly every edit — re-read the page tree rather than reusing an id from earlier in this conversation.`,
      }
    }

    const takesTarget = actionTakesTarget(action)
    if (takesTarget && !targetPageId) {
      return { ok: false, code: 'target-required', error: `Action "${action}" needs a targetPageId.` }
    }
    if (!takesTarget && targetPageId) {
      return {
        ok: false,
        code: 'target-refused',
        error: `Action "${action}" is defined by the history stack and takes no target.`,
      }
    }
    if (targetPageId && !pages.has(targetPageId)) {
      return {
        ok: false,
        code: 'no-such-target',
        error: `No page "${targetPageId}" to navigate to.`,
        availablePageIds: [...pages.keys()],
      }
    }

    const legal = ACTION_TRANSITIONS[action]
    if (transition && !legal.includes(transition)) {
      return {
        ok: false,
        code: 'bad-transition',
        error: legal.length === 0
          ? `Action "${action}" reverses whatever brought you here, so it has no transition of its own.`
          : `Action "${action}" cannot use transition "${transition}".`,
        allowedTransitions: legal,
      }
    }

    const file = readPrototypeFile(dir)
    const existing = linkId ? file.links.find((link) => link.id === linkId) : undefined
    if (linkId && !existing) {
      return {
        ok: false,
        code: 'no-such-link',
        error: `No prototype link with id "${linkId}".`,
        availableLinkIds: file.links.map((link) => link.id),
      }
    }
    // A link Studio read out of the user's real onClick is a statement about
    // their code, not a drawing on the board. Editing it here would make the
    // board disagree with the source it was derived from.
    if (existing && existing.origin === 'code') {
      return {
        ok: false,
        code: 'code-link-readonly',
        error: `Link "${linkId}" was derived from a real onClick in the source and is read-only. Edit the code instead.`,
      }
    }

    const link: PrototypeLink = {
      id: existing?.id ?? randomUUID(),
      origin: 'design',
      source: { pageId, node: hint },
      trigger: 'click',
      action,
      targetPageId: takesTarget && targetPageId ? targetPageId : null,
      ...(legal.length > 0 ? { transition: transition ?? legal[0] } : {}),
    }

    const result = applyPrototypeOp(file, { kind: 'upsert', link })
    if (!result.ok) return { ok: false, code: 'rejected', error: result.error }
    if (result.changed) writePrototypeFile(dir, result.file)
    pushStudioLiveReload(ctx.userId, { dir, prototypeChanged: true })

    return { ok: true, dir, created: !existing, link: linkSummary(link, pages, 'exact') }
  },
}

// ---------------------------------------------------------------------------
// studio_delete_prototype_link
// ---------------------------------------------------------------------------

const DeleteInputSchema = Type.Object(
  {
    dir: DirField,
    linkId: Type.String({ description: 'From studio_list_prototype_links.' }),
  },
  { additionalProperties: false },
)

const studioDeletePrototypeLinkTool: AiTool = {
  name: 'studio_delete_prototype_link',
  scope: 'shared',
  execution: 'server',
  requiredCapabilities: ['studio.write'],
  description:
    'Remove a prototype interaction by id. Refuses a "code" link, which is derived from the user\'s real onClick and is not the board\'s to delete. Removing a link that is already gone succeeds without writing.',
  inputSchema: DeleteInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, linkId } = input as { dir?: string; linkId: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const file = readPrototypeFile(dir)

    const existing = file.links.find((link) => link.id === linkId)
    if (existing && existing.origin === 'code') {
      return {
        ok: false,
        code: 'code-link-readonly',
        error: `Link "${linkId}" was derived from a real onClick in the source and is read-only. Edit the code instead.`,
      }
    }

    const result = applyPrototypeOp(file, { kind: 'remove', linkId })
    if (!result.ok) return { ok: false, code: 'rejected', error: result.error }
    if (result.changed) {
      writePrototypeFile(dir, result.file)
      pushStudioLiveReload(ctx.userId, { dir, prototypeChanged: true })
    }

    return { ok: true, dir, linkId, removed: result.changed }
  },
}

export const studioPrototypeMcpTools: AiTool[] = [
  studioListPrototypeLinksTool,
  studioSetPrototypeLinkTool,
  studioDeletePrototypeLinkTool,
]
