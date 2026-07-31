/**
 * TokenImportStatus — `tokens-01`. Surfaces what the last token extraction
 * found (`server/handlers/studio/tokenExtract.ts`, run automatically on every
 * Studio project load — see `fsCodemodAdapter.ts`'s `loadSite`) so a fresh
 * import doesn't look like it silently did nothing: which source won
 * (project CSS / Tailwind theme / a vendor design-system package), how many
 * colors/spacing/type-size tokens landed, and a "Re-scan tokens" action for
 * when the reason nothing was found is fixable (e.g. dependencies not yet
 * installed — see the `vendor-css-requires-install` warning).
 *
 * Studio-only: `tokenExtractionStatus` stays `null` for the CMS's own
 * (non-Studio) editor, since only `fsCodemodAdapter`'s `loadSite` ever calls
 * `/admin/api/studio/tokens` — this component simply renders nothing then.
 */
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { refreshExtractedTokens } from '@site/studio/fsCodemodAdapter'
import {
  getStudioTokenExtractionStatus,
  subscribeStudioTokenExtractionStatus,
  type TokenExtractionStatus,
} from '@site/studio/studioTokenStatus'
import styles from './TokenImportStatus.module.css'

const SOURCE_LABEL: Record<TokenExtractionStatus['source'], string> = {
  'project-css': "this project's own CSS",
  'tailwind-theme': 'the Tailwind theme config',
  'vendor-css': 'an installed design-system package',
  none: 'no source',
}

function summarize(status: TokenExtractionStatus): string {
  const parts: string[] = []
  if (status.counts.colors > 0) parts.push(`${status.counts.colors} color${status.counts.colors === 1 ? '' : 's'}`)
  if (status.counts.spacing > 0) parts.push(`${status.counts.spacing} spacing step${status.counts.spacing === 1 ? '' : 's'}`)
  if (status.counts.typography > 0) parts.push(`${status.counts.typography} type size${status.counts.typography === 1 ? '' : 's'}`)
  return parts.join(', ')
}

export function TokenImportStatus() {
  const status = useSyncExternalStore(subscribeStudioTokenExtractionStatus, getStudioTokenExtractionStatus)
  const [rescanning, setRescanning] = useState(false)

  if (!status) return null

  const found = status.counts.colors + status.counts.spacing + status.counts.typography > 0
  const primaryWarning = status.warnings.find((w) => w.code !== 'typography-detail-not-mapped' && w.code !== 'unclassified-tokens-skipped')

  const handleRescan = () => {
    if (rescanning) return
    setRescanning(true)
    refreshExtractedTokens()
      .then((next) => {
        const nextFound = next.counts.colors + next.counts.spacing + next.counts.typography > 0
        pushToast({
          kind: nextFound ? 'success' : 'info',
          title: nextFound ? 'Design tokens imported' : 'No design tokens found',
          body: nextFound
            ? `Imported ${summarize(next)} from ${SOURCE_LABEL[next.source]}.`
            : next.warnings[0]?.message ?? "No design tokens were found in this project's CSS.",
        })
      })
      .catch((err) => {
        pushToast({ kind: 'error', title: 'Could not re-scan design tokens', body: getErrorMessage(err, 'Unknown error') })
      })
      .finally(() => setRescanning(false))
  }

  return (
    <div className={found ? styles.success : styles.info} role="status">
      <span className={styles.text}>
        {found
          ? `Imported ${summarize(status)} from ${SOURCE_LABEL[status.source]}.`
          : primaryWarning
            ? primaryWarning.message
            : "No design tokens were found in this project's CSS yet."}
      </span>
      <Button variant="secondary" size="xs" onClick={handleRescan} disabled={rescanning} aria-busy={rescanning}>
        {rescanning ? 'Scanning…' : 'Re-scan'}
      </Button>
    </div>
  )
}
