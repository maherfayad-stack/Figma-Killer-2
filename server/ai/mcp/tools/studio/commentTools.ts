/**
 * Studio comment tools — the agent's half of the review loop.
 *
 * Three tools, which together let an agent close a thread end to end:
 *
 *   studio_list_comments  → what is outstanding, and what each thread points at
 *   studio_apply_edits    → (existing) make the change
 *   studio_reply_comment  → say what was done, in the thread
 *   studio_resolve_comment→ mark it done
 *
 * This is the thing Figma cannot do, and the reason comments live on disk next
 * to the source instead of in a database: a review thread is readable by
 * whatever is editing the repository.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ANCHOR GATE — read this before changing anything here
 * ─────────────────────────────────────────────────────────────────────────
 * A Studio node id is `relFile:line:col`. It is a source POSITION, so it stops
 * resolving the moment anything above it in the file changes. A comment
 * written last week almost certainly names a line number that now belongs to
 * something else.
 *
 * That makes "the agent acted on the comment" a genuinely dangerous sentence.
 * If the agent trusts a rotten anchor it edits the WRONG ELEMENT, in the
 * user's real source, in a file they did not open, and then posts a reply
 * saying it did what was asked. A wrong edit that announces itself as correct
 * is worse than no edit at all.
 *
 * So `studio_resolve_comment` re-resolves the anchor against the live tree and
 * REFUSES on `drifted` (the element was edited since) or `detached` (it is
 * gone), posting the reason into the thread instead of resolving it. Same
 * posture as `refuseStructuralEdit`: when there is not exactly one honest
 * target, say so rather than guess. `isAgentActionable` in
 * `@core/studio-comments` is the single predicate; do not inline a looser
 * copy of it here.
 *
 * `studio_list_comments` reports the same confidence on every thread, so a
 * well-behaved agent never attempts the refused call in the first place — the
 * gate is the backstop, not the interface.
 *
 * Reading confidence costs a page parse, which is why it is opt-out
 * (`resolveAnchors: false`) for an agent that only wants the text.
 */
import { randomUUID } from 'node:crypto'
import { Type } from '@core/utils/typeboxHelpers'
import {
  addReply,
  buildCommentLocation,
  findThread,
  isAgentActionable,
  explainAnchorRefusal,
  setThreadResolved,
  type CommentAuthor,
  type CommentThread,
  type CommentsFile,
} from '@core/studio-comments'
import { resolveNodeAnchor, type AnchorConfidence } from '@core/studio-anchor'
import type { Page } from '@core/page-tree'
import type { BoardsFile } from '@core/studio-board'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { readCommentsFile, writeCommentsFile } from '../../../../handlers/studio/commentsStore'
import { readBoardsFileOrEmpty } from '../../../../handlers/studio/boardGeometry'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { pushStudioLiveReload } from './liveReloadPush'

const DirField = Type.Optional(
  Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
)

/**
 * The byline on an agent-written comment.
 *
 * `userId` is the connector owner's, so the comment still belongs to a real
 * account for ownership checks; `kind: 'agent'` is what the UI renders as the
 * AI tag. A reviewer must always be able to tell which half of a thread was
 * machine-written, so this is stamped here and is not reachable from the HTTP
 * route a browser talks to.
 */
function agentAuthor(ctx: ToolContext): CommentAuthor {
  return { userId: ctx.userId, displayName: 'Studio agent', kind: 'agent' }
}

/** Threads keyed by the page they point at, for a single batched parse. */
async function pagesForThreads(
  dir: string,
  threads: readonly CommentThread[],
): Promise<Map<string, Page>> {
  const wanted = new Set(
    threads.map((thread) => thread.anchor.pageId).filter((id): id is string => id !== null),
  )
  if (wanted.size === 0) return new Map()
  // One parse for the whole call rather than one per thread. `loadStudioPages`
  // is cached (`pageParseCache.ts`), but the cache is not free and a board can
  // carry dozens of threads.
  const loaded = await loadStudioPages(dir)
  const byId = new Map<string, Page>()
  for (const page of loaded.pages) {
    if (wanted.has(page.id)) byId.set(page.id, page)
  }
  return byId
}

/**
 * Mirrors `selectThreadAnchorConfidence` on the browser side. A thread with no
 * node hint is `unanchored` (it never named an element, so nothing went
 * stale), NOT `detached` — collapsing the two made every free-floating comment
 * permanently un-resolvable by the agent.
 */
function confidenceFor(thread: CommentThread, pages: Map<string, Page>): AnchorConfidence {
  const pageId = thread.anchor.pageId
  if (!thread.anchor.node || !pageId) return 'unanchored'
  return resolveNodeAnchor(thread.anchor.node, pages.get(pageId) ?? null).confidence
}

/**
 * One thread as the agent sees it: the gate fields at the top level, and
 * everything about WHERE it is under `location`.
 *
 * `location` is `buildCommentLocation`'s record verbatim — the same one the
 * editor's "Send to AI" button renders as prose. It exists because the ids on
 * a stored thread do not, on their own, describe anywhere: the board and page
 * are UUIDs and slugs, the element is a `relFile:line:col` position, and the
 * pin's `dx/dy` mean nothing without the frame they are relative to. An agent
 * given only those either asks three follow-up questions or guesses, and
 * guessing here means editing the wrong element in the user's real source.
 */
function threadSummary(
  thread: CommentThread,
  confidence: AnchorConfidence | null,
  boards: BoardsFile,
  pages: Map<string, Page>,
) {
  const board = boards.boards.find((candidate) => candidate.id === thread.boardId) ?? null
  const frame = board?.frames.find((candidate) => candidate.id === thread.anchor.frameId) ?? null
  const page = thread.anchor.pageId ? (pages.get(thread.anchor.pageId) ?? null) : null

  return {
    seq: thread.seq,
    threadId: thread.id,
    resolved: thread.resolved,
    ...(confidence
      ? { anchorConfidence: confidence, agentActionable: isAgentActionable(confidence) }
      : {}),
    location: buildCommentLocation(thread, {
      boardName: board?.name ?? null,
      pageTitle: page?.title ?? null,
      tree: page,
      frameWidth: frame?.width ?? null,
      frameHeight: frame?.height ?? null,
      // `pages` is empty when the caller opted out of the parse. Without this
      // the missing tree would read as `detached` — "it is gone" — when the
      // truth is only that nothing looked.
      checkAnchor: confidence !== null,
    }),
    comments: thread.comments.map((comment) => ({
      author: comment.author.displayName,
      kind: comment.author.kind,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  }
}

// ---------------------------------------------------------------------------
// studio_list_comments
// ---------------------------------------------------------------------------

const ListInputSchema = Type.Object(
  {
    dir: DirField,
    status: Type.Optional(
      Type.Union([Type.Literal('open'), Type.Literal('resolved'), Type.Literal('all')], {
        description: 'Which threads to return. Defaults to "open" — the outstanding work.',
      }),
    ),
    pageId: Type.Optional(
      Type.String({ description: 'Only threads anchored to this page. Omit for every page.' }),
    ),
    resolveAnchors: Type.Optional(
      Type.Boolean({
        description:
          'Recompute each thread\'s anchorConfidence against the live source (default true). Costs a project parse; pass false when you only want the comment text.',
      }),
    ),
  },
  { additionalProperties: false },
)

const studioListCommentsTool: AiTool = {
  name: 'studio_list_comments',
  scope: 'shared',
  execution: 'server',
  // No `requiredCapabilities` — the same posture every other Studio READ tool
  // takes (`projectTools.ts`): reachable by any `ai.chat` caller, since it
  // only reads a file the caller's own workspace already exposes. The two
  // write tools below are gated on `studio.write` like their siblings.
  description:
    'List review comment threads pinned to the Studio board (.studio/comments.json) — the human feedback on this design, as a work queue. Returns { ok, dir, threads:[{ seq, threadId, resolved, anchorConfidence, agentActionable, location, comments:[{author,kind,body,createdAt}] }] }. `seq` is the number shown on the pin and in the UI — use it when talking to the user ("comment 3"). `location` tells you exactly where the comment is, so you never have to guess which element was meant: { boardId, boardName, frameId, pageId, pageTitle, pageFile, dx, dy, xPercent, yPercent, element:{ nodeId, moduleId, text, trail }, confidence }. `pageFile` is the source file to edit; `dx`/`dy` are the pin\'s position in frame-local pixels from the frame\'s top-left (with xPercent/yPercent as the same point relative to the frame\'s size); `element.trail` is the path of labels from the page root down to the element, so you can find it by structure when the id has gone stale; `element` is null for a pin dropped on empty canvas, where the coordinates are the whole location. CRITICAL: `anchorConfidence` says whether the element the comment points at still exists — "exact"/"moved" mean yes (agentActionable: true), "drifted" means it was edited since the comment was written, "detached" means it is gone and `element` is the stale stored hint. Only act on threads with agentActionable: true; studio_resolve_comment refuses the others. Filter with status ("open" default, "resolved", "all") and pageId. ',
  inputSchema: ListInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, status = 'open', pageId, resolveAnchors = true } = input as {
      dir?: string
      status?: 'open' | 'resolved' | 'all'
      pageId?: string
      resolveAnchors?: boolean
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const file = readCommentsFile(dir)

    const threads = file.threads.filter((thread) => {
      if (status === 'open' && thread.resolved) return false
      if (status === 'resolved' && !thread.resolved) return false
      if (pageId && thread.anchor.pageId !== pageId) return false
      return true
    })

    const pages = resolveAnchors ? await pagesForThreads(dir, threads) : new Map<string, Page>()
    // One read for the whole call — every thread names a board, and most name
    // the same one.
    const boards = readBoardsFileOrEmpty(dir)

    return {
      ok: true,
      dir,
      status,
      threads: threads.map((thread) =>
        threadSummary(thread, resolveAnchors ? confidenceFor(thread, pages) : null, boards, pages),
      ),
    }
  },
}

// ---------------------------------------------------------------------------
// studio_reply_comment
// ---------------------------------------------------------------------------

const ReplyInputSchema = Type.Object(
  {
    dir: DirField,
    seq: Type.Number({ description: 'The thread number shown on its pin, from studio_list_comments.' }),
    body: Type.String({ minLength: 1, description: 'The reply. Say what you changed, or why you did not.' }),
  },
  { additionalProperties: false },
)

const studioReplyCommentTool: AiTool = {
  name: 'studio_reply_comment',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Post a reply into a review thread, attributed to the AI (it renders with an "AI" tag — a reviewer must always be able to tell which half of a thread was machine-written). Address the thread by `seq`, the number on its pin. Use this to report what you changed after acting on a comment, or to explain why you did not. Returns { ok, seq, threadId, commentCount }. Requires studio.write.',
  inputSchema: ReplyInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, seq, body } = input as { dir?: string; seq: number; body: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const file = readCommentsFile(dir)
    const thread = file.threads.find((candidate) => candidate.seq === seq)
    if (!thread) return notFound(seq, file)

    const next = addReply(file, thread.id, {
      id: randomUUID(),
      author: agentAuthor(ctx),
      body,
      now: new Date().toISOString(),
    })
    if (!next) {
      return { ok: false, code: 'empty-body', error: 'A reply needs a non-empty body.' }
    }

    writeCommentsFile(dir, next)
    pushStudioLiveReload(ctx.userId, { dir, commentsChanged: true })

    const updated = findThread(next, thread.id)
    return { ok: true, seq, threadId: thread.id, commentCount: updated?.comments.length ?? 0 }
  },
}

// ---------------------------------------------------------------------------
// studio_resolve_comment — the gated one
// ---------------------------------------------------------------------------

const ResolveInputSchema = Type.Object(
  {
    dir: DirField,
    seq: Type.Number({ description: 'The thread number shown on its pin.' }),
    resolved: Type.Optional(
      Type.Boolean({ description: 'true to resolve (default), false to reopen.' }),
    ),
    reply: Type.Optional(
      Type.String({
        description:
          'Optional reply to post before resolving — normally what you changed. Strongly recommended: a thread that closes with no explanation tells the reviewer nothing.',
      }),
    ),
  },
  { additionalProperties: false },
)

const studioResolveCommentTool: AiTool = {
  name: 'studio_resolve_comment',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Resolve (or reopen) a review thread by `seq`, optionally posting a reply first. REFUSES to resolve when the thread\'s anchorConfidence is "drifted" or "detached" — meaning the element the comment points at was edited or deleted since the comment was written, so you cannot have addressed it reliably. On refusal it posts the reason INTO the thread and returns { ok:false, code:"stale-anchor", anchorConfidence }, leaving the thread open for a human. This is deliberate: acting on a stale anchor edits the wrong element in the user\'s real source. Reopening (resolved:false) is never gated. Returns { ok, seq, threadId, resolved }. Requires studio.write.',
  inputSchema: ResolveInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, seq, resolved = true, reply } = input as {
      dir?: string
      seq: number
      resolved?: boolean
      reply?: string
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    let file = readCommentsFile(dir)
    const thread = file.threads.find((candidate) => candidate.seq === seq)
    if (!thread) return notFound(seq, file)

    const now = new Date().toISOString()
    const author = agentAuthor(ctx)

    // Reopening is never gated. A stale anchor is a reason to leave a thread
    // OPEN, so it can never be a reason to refuse opening one.
    let confidence: AnchorConfidence | null = null
    if (resolved) {
      const pages = await pagesForThreads(dir, [thread])
      confidence = confidenceFor(thread, pages)

      if (!isAgentActionable(confidence)) {
        // Refuse — but say so in the thread rather than only in a tool result
        // the user never sees. The reviewer's own UI shows the same sentence
        // on the pin, so there is one explanation, not two.
        const reason = explainAnchorRefusal(confidence) ?? 'The anchor could not be verified.'
        const explained = addReply(file, thread.id, {
          id: randomUUID(),
          author,
          body: reply ? `${reply}\n\n${reason}` : reason,
          now,
        })
        if (explained) {
          writeCommentsFile(dir, explained)
          pushStudioLiveReload(ctx.userId, { dir, commentsChanged: true })
        }
        return {
          ok: false,
          code: 'stale-anchor',
          seq,
          threadId: thread.id,
          anchorConfidence: confidence,
          error: reason,
        }
      }
    }

    if (reply) {
      file = addReply(file, thread.id, { id: randomUUID(), author, body: reply, now }) ?? file
    }
    file = setThreadResolved(file, thread.id, resolved) ?? file

    writeCommentsFile(dir, file)
    pushStudioLiveReload(ctx.userId, { dir, commentsChanged: true })

    return {
      ok: true,
      seq,
      threadId: thread.id,
      resolved,
      ...(confidence ? { anchorConfidence: confidence } : {}),
    }
  },
}

/** Names the seqs that DO exist, so a wrong guess is one round trip, not a search. */
function notFound(seq: number, file: CommentsFile) {
  return {
    ok: false,
    code: 'no-such-thread',
    error: `No comment thread with seq ${seq}.`,
    availableSeqs: file.threads.map((thread) => thread.seq),
  }
}

export const studioCommentMcpTools: AiTool[] = [
  studioListCommentsTool,
  studioReplyCommentTool,
  studioResolveCommentTool,
]
