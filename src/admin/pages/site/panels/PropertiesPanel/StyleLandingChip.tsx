/**
 * StyleLandingChip — says where the last style edit went (G-5):
 * "Saved in Card.module.css", "Saved as an override in Card.css", "Saved in
 * Card.css, shorthand expanded", or "Saved inline".
 *
 * A style edit never refuses; it takes the first honest rung of a ladder
 * (`@core/page-tree`'s `styleLanding.ts`), and the server reports the rung
 * after the write (`styleLandings.ts`). This chip is the reading of that report
 * for the selection: the newest landing among the node's own inline layer and
 * the classes it carries. It renders nothing until a write has landed.
 *
 * A rung a plain "set the old value back" cannot undo byte for byte (an
 * override, an expanded shorthand) carries an Undo that restores the file from
 * the server's journal.
 */
import { useSyncExternalStore } from 'react'
import { styleLandingText } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import {
  latestStyleLanding,
  styleLandingSubjects,
  subscribeStyleLandings,
  undoStyleLanding,
} from '@site/studio/styleLandings'
import styles from './StyleLandingChip.module.css'

interface StyleLandingChipProps {
  nodeId: string | null
  classIds: readonly string[]
}

export function StyleLandingChip({ nodeId, classIds }: StyleLandingChipProps) {
  const subjects = styleLandingSubjects(nodeId, classIds)
  const landing = useSyncExternalStore(subscribeStyleLandings, () => latestStyleLanding(subjects))
  if (landing === null) return null
  const token = landing.undoToken

  return (
    <div className={styles.chip} role="status" data-testid="style-landing-chip" data-rung={landing.rung}>
      <span className={styles.text} title={landing.file}>
        {styleLandingText(landing)}
      </span>
      {token !== null && (
        <Button
          variant="secondary"
          size="xs"
          onClick={() => void undoStyleLanding(token)}
          tooltip="Put the file back exactly as it was before this change"
          data-testid="style-landing-undo"
        >
          Undo
        </Button>
      )}
    </div>
  )
}
