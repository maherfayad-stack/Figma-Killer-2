/**
 * frameJsxElements — PA-6, the write behind Frame selection (⌥⌘G): one
 * container written around a run of siblings, SIZED AND PLACED, with the
 * members' own offsets rebased so nothing moves on screen.
 *
 * It is `wrapJsxElements` plus two things the caller measured:
 *
 *   - `wrapperStyle` — the frame's own inline style (`position: absolute; left;
 *     top; width; height` for a frame around placed layers, the parent's flex
 *     layout for one around auto-layout items, nothing for a plain flow run);
 *   - `memberStyles` — one style patch per target, the inline style each member
 *     needs inside the frame: `null` removes a key. A member placed by offsets
 *     from its old containing block is placed by offsets from the frame now.
 *
 * ## One write, all or nothing
 *
 * The wrapper goes in first (`wrapJsxElements`, so every contiguity and
 * content-model rule applies unchanged), then each member's `style` is set
 * through `setJsxStyle`. If any member's style cannot be written honestly (a
 * `style={tile}` that cannot be edited, a shorthand key) the file is put back
 * to the bytes it had and the frame is refused by name: a frame whose members
 * kept their old offsets would have moved every one of them. The server
 * journals the whole batch, so ⌘Z restores the pre-image in one step.
 *
 * `memberStyles[i]` belongs to `targets[i]`; the targets may come in any order.
 */
import { JsxStyleTargetError, setJsxStyle } from './setJsxStyle'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import { elementChildren } from './jsxChildPlacement'
import { verbatimSourceText, writeVerbatimSource } from './jsxChildRange'
import { wrapJsxElements, type WrapJsxElementsParams, type WrapJsxElementsResult } from './wrapJsxElements'
import { Node } from 'ts-morph'

/** One member's inline-style patch: a string / number sets the key, `null` removes it. */
export type MemberStylePatch = Readonly<Record<string, string | number | null>>

export interface FrameJsxElementsParams extends WrapJsxElementsParams {
  /** One patch per target, aligned with {@link WrapJsxElementsParams.targets}. */
  memberStyles: readonly MemberStylePatch[]
}

export function frameJsxElements(params: FrameJsxElementsParams): WrapJsxElementsResult {
  const { file, targets, memberStyles } = params
  const project = params.project ?? createProject()
  if (memberStyles.length !== targets.length) {
    return {
      ok: false,
      refusal: { reason: 'frame-unwritable', message: 'A frame needs one style per layer in it, and the counts did not match.' },
    }
  }

  const sourceFile = loadSourceFile(project, file)
  const before = verbatimSourceText(sourceFile, file)
  if (before === null) {
    return {
      ok: false,
      refusal: { reason: 'stale-source', message: 'This file changed on disk since the canvas last read it. Reload the project and try again.' },
    }
  }

  // Source order of the targets: the wrapper's element children come back in
  // it, so a patch follows its target by rank rather than by the order sent.
  const ranks = targets
    .map((target, index) => ({ index, line: target.line, col: target.col }))
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .map((entry) => entry.index)

  const refused = (message: string): WrapJsxElementsResult => {
    writeVerbatimSource(sourceFile, file, before)
    return { ok: false, refusal: { reason: 'frame-unwritable', message } }
  }

  const wrapped = wrapJsxElements({ ...params, project })
  if (!wrapped.ok) return wrapped
  if (wrapped.created === null) return refused('Studio could not find the frame it just wrote, so nothing was changed.')

  const fresh = loadSourceFile(project, file)
  const wrapper = findJsxElementAtLocation(fresh, wrapped.created.line, wrapped.created.col)
  const element = wrapper?.getParent()
  const members = element && Node.isJsxElement(element) ? elementChildren(element) : []
  if (members.length !== targets.length) {
    return refused('Studio could not tell which elements ended up inside the frame, so nothing was changed.')
  }
  // Every member's location, read before the first style write moves anything.
  const locations = members.map((member) => {
    const opening = Node.isJsxElement(member) ? member.getOpeningElement() : member
    const { line, column } = fresh.getLineAndColumnAtPos(opening.getTagNameNode().getStart())
    return { line, col: column }
  })

  // Bottom to top, so one member's style attribute never moves the next.
  for (let rank = ranks.length - 1; rank >= 0; rank -= 1) {
    const patch = memberStyles[ranks[rank]!]!
    const set: Record<string, string | number> = {}
    const remove: string[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) remove.push(key)
      else set[key] = value
    }
    if (Object.keys(set).length === 0 && remove.length === 0) continue
    try {
      setJsxStyle({ file, ...locations[rank]!, style: set, remove, project })
    } catch (err) {
      if (err instanceof JsxStyleTargetError) {
        return refused(`A layer in the frame is positioned by code Studio cannot rewrite (${err.detail}), so the frame was not written.`)
      }
      throw err
    }
  }
  return wrapped
}
