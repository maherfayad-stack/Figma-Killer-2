/**
 * BoardFlowLayer — the flow map, drawn over the board.
 *
 * Two kinds of line, drawn in two voices:
 *
 *   - CODE — `STUDIO-PROTOTYPE-PLAN.md` §1's differentiator. Nobody drew these.
 *     Studio read the project's own navigation code and is reporting what it
 *     found (`server/handlers/studio/prototypeCodeFlow.ts`), so the board shows
 *     flows that are already true on a repository nobody has prototyped yet —
 *     the part a shape-database design tool structurally cannot do.
 *   - DESIGN — the links the user authored in the inspector, from
 *     `.studio/prototype.json`. A link whose source element no longer resolves
 *     is drawn BROKEN rather than hidden, so an edit that cost a flow is
 *     visible.
 *
 * READ-ONLY, AND THE CODE HALF HAS TO LOOK IT
 * ───────────────────────────────────────────
 * There is no delete affordance, no drag handle, no context menu, and no click
 * handler anywhere in the layer — the chip opts back into pointer events for
 * HOVER only, so its tooltip can open. Authored links are edited in the
 * inspector; a code line cannot be edited at all, because the only way to
 * change it is to change the code it came from. Each carries the source snippet
 * it was read out of, because a line the user cannot edit has to be able to
 * answer "why do you think that", and the answer is a piece of their own file.
 *
 * WHY IT LIVES IN THE PARENT DOCUMENT
 * ───────────────────────────────────
 * Selection rings are portaled INTO each iframe to dodge coordinate conversion.
 * A connector cannot be: it spans two iframes, and neither of them contains it.
 * So it mounts here, in the board overlay layer, exactly where `BoardCommentsLayer`
 * mounts — inside `CanvasTransformLayer`, positioned in BOARD coordinates, which
 * is what makes it pan/zoom invariant for free. No element of this feature is
 * ever inserted into a user iframe.
 *
 * WHY FRAME-TO-FRAME AND NOT ELEMENT-TO-FRAME
 * ───────────────────────────────────────────
 * Figma anchors a connector to the element you attached it to, because in Figma
 * that element is a shape in the same document. Here it is a DOM node inside
 * another browsing context, and tracking its rect means a cross-document
 * measurement pass on every frame move, resize and content reflow — the exact
 * "stutter machine" the plan's §6 warns about. It is also the wrong granularity
 * for this particular claim: the fact is "Home navigates to Details", and the
 * element that does it is named in the chip's tooltip, where it does not have to
 * be measured to be true. Element-level anchoring is a follow-up for AUTHORED
 * links, which the user places deliberately and one at a time.
 *
 * SIZE: the stroke, the arrowhead and the chip all counter-scale by
 * `1 / var(--canvas-zoom)` in pure CSS — the `CommentPin` pattern, and for the
 * same reason its doc gives: the store's `zoom` is committed 100 ms after the
 * last gesture event, so subscribing to it would make every connector lag the
 * board it is drawn on.
 */
import type { CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardFrames } from '@site/store/slices/boardSelectors'
import type { NodeTree } from '@core/page-tree'
import { Tooltip } from '@ui/components/Tooltip'
import { routeCodeFlow, routePrototypeLinks, type FlowLine } from './flowRouting'
import styles from './BoardFlowLayer.module.css'

export function BoardFlowLayer() {
  const boardMode = useEditorStore((s) => s.boardMode)
  const frames = useEditorStore(selectActiveBoardFrames)
  const edges = useEditorStore((s) => s.codeFlow.edges)
  const links = useEditorStore((s) => s.prototype.links)
  // The pages array by reference, never a scan inside the selector — an
  // authored link's source has to be re-resolved against its page's tree, and
  // walking every page's nodes inside a `useEditorStore` selector would re-run
  // that walk on every store commit in the editor.
  const pages = useEditorStore((s) => s.site?.pages)

  // Design mode never shows connectors — the plan's §1 condition for the design
  // layer being honest is that it is invisible while you are editing the design.
  if (boardMode !== 'prototype' || frames.length === 0) return null

  const trees = new Map<string, NodeTree>((pages ?? []).map((page) => [page.id, page]))
  const lines = [...routeCodeFlow(edges, frames), ...routePrototypeLinks(links, frames, trees)]
  if (lines.length === 0) return null

  return (
    <div className={styles.layer} data-testid="board-flow-layer">
      {lines.map((line) => (
        <FlowLineView key={line.key} line={line} />
      ))}
    </div>
  )
}

function FlowLineView({ line }: { line: FlowLine }) {
  const { connector, details } = line
  const box: CSSProperties = {
    left: `${connector.left}px`,
    top: `${connector.top}px`,
    width: `${connector.width}px`,
    height: `${connector.height}px`,
  }

  return (
    <>
      <svg
        className={styles.curve}
        style={box}
        viewBox={`0 0 ${connector.width} ${connector.height}`}
        data-kind={line.kind}
        data-broken={line.broken ? 'true' : undefined}
        aria-hidden="true"
      >
        <path d={connector.path} />
      </svg>

      <div
        aria-hidden="true"
        className={styles.arrow}
        data-kind={line.kind}
        data-broken={line.broken ? 'true' : undefined}
        style={
          {
            left: `${connector.tipX}px`,
            top: `${connector.tipY}px`,
            '--flow-arrow-angle': `${connector.tipAngle}deg`,
          } as CSSProperties
        }
      />

      <div className={styles.chipAnchor} style={{ left: `${connector.labelX}px`, top: `${connector.labelY}px` }}>
        <Tooltip content={<FlowDetails details={details} />}>
          <span
            className={styles.chip}
            data-kind={line.kind}
            data-broken={line.broken ? 'true' : undefined}
            data-testid="board-flow-chip"
          >
            {line.chip}
          </span>
        </Tooltip>
      </div>
    </>
  )
}

/**
 * The tooltip body: every flow this line stands for, and where each came from.
 *
 * For a code line that is the source snippet and its file position — the whole
 * justification for a connector the user cannot edit is that it cites their own
 * code rather than asserting a flow. For an authored line it is the action and
 * transition, or the sentence saying the element it was drawn on is gone.
 */
function FlowDetails({ details }: { details: FlowLine['details'] }) {
  return (
    <span className={styles.evidence}>
      {details.map((detail) => (
        <span key={detail.key} className={styles.evidenceRow}>
          <code className={styles.evidenceCode}>{detail.primary}</code>
          <span className={styles.evidenceWhere}>{detail.secondary}</span>
        </span>
      ))}
    </span>
  )
}
