/**
 * BoardFlowLayer — the flow map, drawn over the board.
 *
 * `STUDIO-PROTOTYPE-PLAN.md` §1's differentiator: these connectors were not
 * drawn by anybody. Studio read the project's own navigation code and is
 * reporting what it found (`server/handlers/studio/prototypeCodeFlow.ts`), so
 * the board shows flows that are already true on a repository nobody has
 * prototyped yet — the part a shape-database design tool structurally cannot do.
 *
 * READ-ONLY, AND IT HAS TO LOOK IT
 * ────────────────────────────────
 * There is no delete affordance, no drag handle, no context menu, and no click
 * handler anywhere in the layer — the chip opts back into pointer events for
 * HOVER only, so its tooltip can open. The only way to change one of these
 * lines is to change the code it came from. It carries the source snippet it
 * was read out of, because a line the user cannot edit has to be able to answer
 * "why do you think that", and the answer is a piece of their own file.
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
import { Tooltip } from '@ui/components/Tooltip'
import { routeCodeFlow, type FlowLine } from './flowRouting'
import styles from './BoardFlowLayer.module.css'

export function BoardFlowLayer() {
  const boardMode = useEditorStore((s) => s.boardMode)
  const frames = useEditorStore(selectActiveBoardFrames)
  const edges = useEditorStore((s) => s.codeFlow.edges)

  // Design mode never shows connectors — the plan's §1 condition for the design
  // layer being honest is that it is invisible while you are editing the design.
  if (boardMode !== 'prototype' || frames.length === 0 || edges.length === 0) return null

  const lines = routeCodeFlow(edges, frames)
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
  const { connector, edges } = line
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
        aria-hidden="true"
      >
        <path d={connector.path} />
      </svg>

      <div
        aria-hidden="true"
        className={styles.arrow}
        style={
          {
            left: `${connector.tipX}px`,
            top: `${connector.tipY}px`,
            '--flow-arrow-angle': `${connector.tipAngle}deg`,
          } as CSSProperties
        }
      />

      <div className={styles.chipAnchor} style={{ left: `${connector.labelX}px`, top: `${connector.labelY}px` }}>
        <Tooltip content={<FlowEvidence edges={edges} />}>
          <span className={styles.chip} data-testid="board-flow-chip">
            {edges.length > 1 ? `${edges.length} links` : edges[0]!.evidence}
          </span>
        </Tooltip>
      </div>
    </>
  )
}

/**
 * The tooltip body: every piece of source that produced this line, with where
 * it is written. This is the whole justification for a connector the user
 * cannot edit — it cites their code rather than asserting a flow.
 */
function FlowEvidence({ edges }: { edges: FlowLine['edges'] }) {
  return (
    <span className={styles.evidence}>
      {edges.map((edge) => (
        <span key={edge.id} className={styles.evidenceRow}>
          <code className={styles.evidenceCode}>{edge.evidence}</code>
          <span className={styles.evidenceWhere}>{edge.sourceNodeId}</span>
        </span>
      ))}
    </span>
  )
}
