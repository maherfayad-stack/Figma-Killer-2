/**
 * DesignImportDialog — "Import design tokens" from a GitHub repo or npm
 * package. The server scans CSS custom properties AND token-named JSON/JS/TS
 * files (see `server/handlers/designImport.ts`'s doc comment) — this dialog
 * doesn't need to know which source format a candidate came from, only its
 * classified category. Two steps:
 *
 *   1. Source form — pick GitHub (repo URL + optional ref/subdir/token) or
 *      npm (package name, optionally `@version`) → "Fetch" calls
 *      `previewDesignImport`.
 *   2. Preview checklist — every classified color/typography/spacing
 *      candidate, checkbox-selectable (all pre-checked), grouped by category.
 *      "Apply" writes the selected tokens into the Framework settings via the
 *      SAME store actions the Colors/Typography/Spacing panels use
 *      (`applyDesignImportTokens`), then copies the fetched CSS files
 *      verbatim into the project (`copyDesignImportCss`) so anything beyond
 *      the token model (e.g. `@font-face` rules) still ships as real CSS.
 *      Non-CSS token files (JSON/JS/TS) are scanned but never copied — only
 *      their extracted tokens carry through.
 *
 * Studio-only: the "copy CSS into the project" step needs a project
 * directory, which only exists in studio mode — see the entry button's
 * `isStudioMode()` gate in `FrameworkPanel.tsx`.
 */
import { useId, useState, type CSSProperties, type FormEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Checkbox } from '@ui/components/Checkbox'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  previewDesignImport,
  copyDesignImportCss,
  type ColorCandidate,
  type SizeCandidate,
  type DesignImportPreview,
} from './designImportApi'
import { applyDesignImportTokens } from './applyDesignImportTokens'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from './DesignImportDialog.module.css'

interface DesignImportDialogProps {
  onClose: () => void
}

type SourceKind = 'github' | 'npm'

const FORM_ID = 'design-import-form'

/** Filesystem-safe folder-name slug for the CSS copy destination (`styles/imported/<slug>/`). Client-side mirror of the server's own slugging — kept tiny and local rather than importing a server-only module into the browser bundle. */
function slugifySourceLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source'
}

export function DesignImportDialog({ onClose }: DesignImportDialogProps) {
  const site = useEditorStore((s) => s.site)
  const createFrameworkColorToken = useEditorStore((s) => s.createFrameworkColorToken)
  const updateFrameworkColorToken = useEditorStore((s) => s.updateFrameworkColorToken)
  const createFrameworkTypographyGroup = useEditorStore((s) => s.createFrameworkTypographyGroup)
  const updateFrameworkTypographyGroup = useEditorStore((s) => s.updateFrameworkTypographyGroup)
  const createFrameworkSpacingGroup = useEditorStore((s) => s.createFrameworkSpacingGroup)
  const updateFrameworkSpacingGroup = useEditorStore((s) => s.updateFrameworkSpacingGroup)

  const [sourceKind, setSourceKind] = useState<SourceKind>('github')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subdir, setSubdir] = useState('')
  const [token, setToken] = useState('')
  const [packageSpec, setPackageSpec] = useState('')

  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [preview, setPreview] = useState<DesignImportPreview | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const urlId = useId()
  const refId = useId()
  const subdirId = useId()
  const tokenId = useId()
  const packageId = useId()

  const canFetch = sourceKind === 'github' ? url.trim().length > 0 : packageSpec.trim().length > 0

  async function handleFetch(event: FormEvent) {
    event.preventDefault()
    if (!canFetch || busy) return
    setBusy(true)
    setSubmitError(null)
    try {
      const result = await previewDesignImport(
        sourceKind === 'github'
          ? {
              source: 'github',
              url: url.trim(),
              ref: ref.trim() || undefined,
              subdir: subdir.trim() || undefined,
              token: token.trim() || undefined,
            }
          : { source: 'npm', packageSpec: packageSpec.trim() },
      )
      setPreview(result)
      // Every candidate starts checked — the review step is for deselecting
      // noise, not opting in from zero.
      setSelectedIds(new Set([...result.colors, ...result.typography, ...result.spacing].map((c) => c.id)))
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Unknown error fetching the source'))
    } finally {
      setBusy(false)
    }
  }

  function toggle(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function handleApply() {
    if (!preview || busy || !site) return
    setBusy(true)
    setSubmitError(null)
    try {
      const selection = {
        colors: preview.colors.filter((c) => selectedIds.has(c.id)),
        typography: preview.typography.filter((c) => selectedIds.has(c.id)),
        spacing: preview.spacing.filter((c) => selectedIds.has(c.id)),
      }
      const result = applyDesignImportTokens(
        {
          site,
          createFrameworkColorToken,
          updateFrameworkColorToken,
          createFrameworkTypographyGroup,
          updateFrameworkTypographyGroup,
          createFrameworkSpacingGroup,
          updateFrameworkSpacingGroup,
        },
        preview.label,
        selection,
      )

      const copy = await copyDesignImportCss(slugifySourceLabel(preview.label), preview.files)

      pushToast({
        kind: 'success',
        title: 'Design tokens imported',
        body:
          `${result.colorsApplied} colors, ${result.typographyApplied} type sizes, ` +
          `${result.spacingApplied} spacing steps applied. ${copy.written} CSS file` +
          `${copy.written === 1 ? '' : 's'} copied into the project.`,
      })
      onClose()
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Unknown error applying the import'))
    } finally {
      setBusy(false)
    }
  }

  const totalSelected = selectedIds.size
  const totalCandidates = preview ? preview.colors.length + preview.typography.length + preview.spacing.length : 0

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import design tokens"
      size="md"
      footer={
        preview ? (
          <>
            <Button variant="secondary" size="sm" type="button" onClick={() => setPreview(null)} disabled={busy}>
              Back
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => void handleApply()}
              disabled={busy || totalSelected === 0}
              aria-busy={busy}
            >
              {busy ? 'Applying…' : `Apply ${totalSelected} of ${totalCandidates}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              form={FORM_ID}
              disabled={!canFetch || busy}
              aria-busy={busy}
            >
              {busy ? 'Fetching…' : 'Fetch'}
            </Button>
          </>
        )
      }
    >
      {!preview ? (
        <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleFetch}>
          <div className={dialogStyles.field}>
            <SegmentedControl<SourceKind>
              value={sourceKind}
              options={[
                { value: 'github', label: 'GitHub repo' },
                { value: 'npm', label: 'npm package' },
              ]}
              onChange={(next) => {
                setSourceKind(next)
                setSubmitError(null)
              }}
              size="sm"
              fullWidth
            />
          </div>

          {sourceKind === 'github' ? (
            <>
              <div className={dialogStyles.field}>
                <label htmlFor={urlId} className={dialogStyles.label}>Repository URL</label>
                <Input
                  id={urlId}
                  autoFocus
                  fieldSize="sm"
                  value={url}
                  onChange={(event) => { setUrl(event.target.value); setSubmitError(null) }}
                  placeholder="https://github.com/owner/repo"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
              <div className={dialogStyles.field}>
                <label htmlFor={refId} className={dialogStyles.label}>Branch / ref (optional)</label>
                <Input
                  id={refId}
                  fieldSize="sm"
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder="Defaults to the repo's default branch"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
              <div className={dialogStyles.field}>
                <label htmlFor={subdirId} className={dialogStyles.label}>Subdirectory (optional)</label>
                <Input
                  id={subdirId}
                  fieldSize="sm"
                  value={subdir}
                  onChange={(event) => setSubdir(event.target.value)}
                  placeholder="e.g. packages/tokens"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
              <div className={dialogStyles.field}>
                <label htmlFor={tokenId} className={dialogStyles.label}>Access token (optional, for private repos)</label>
                <Input
                  id={tokenId}
                  type="password"
                  fieldSize="sm"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="ghp_…"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
            </>
          ) : (
            <div className={dialogStyles.field}>
              <label htmlFor={packageId} className={dialogStyles.label}>Package name</label>
              <Input
                id={packageId}
                autoFocus
                fieldSize="sm"
                value={packageSpec}
                onChange={(event) => { setPackageSpec(event.target.value); setSubmitError(null) }}
                placeholder="open-props or @radix-ui/colors@3.0.0"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </div>
          )}

          {submitError && (
            <p role="alert" className={dialogStyles.errorText}>{submitError}</p>
          )}
        </form>
      ) : (
        <div className={styles.preview}>
          <p className={styles.previewSummary}>
            Found in <strong>{preview.label}</strong>: {preview.colors.length} colors,{' '}
            {preview.typography.length} font sizes, {preview.spacing.length} spacing values
            {preview.otherCount > 0 ? `, ${preview.otherCount} skipped (not classified)` : ''}.
            {preview.truncated && ' Some files were skipped (source had more CSS than the import limit).'}
          </p>

          <CandidateGroup title="Colors" candidates={preview.colors} selectedIds={selectedIds} onToggle={toggle} kind="color" />
          <CandidateGroup title="Typography (font sizes)" candidates={preview.typography} selectedIds={selectedIds} onToggle={toggle} kind="size" />
          <CandidateGroup title="Spacing" candidates={preview.spacing} selectedIds={selectedIds} onToggle={toggle} kind="size" />

          {submitError && (
            <p role="alert" className={dialogStyles.errorText}>{submitError}</p>
          )}
        </div>
      )}
    </Dialog>
  )
}

function CandidateGroup({
  title,
  candidates,
  selectedIds,
  onToggle,
  kind,
}: {
  title: string
  candidates: ReadonlyArray<ColorCandidate | SizeCandidate>
  selectedIds: Set<string>
  onToggle: (id: string, checked: boolean) => void
  kind: 'color' | 'size'
}) {
  if (candidates.length === 0) return null
  return (
    <div className={styles.group}>
      <h4 className={styles.groupTitle}>{title} <span className={styles.groupCount}>{candidates.length}</span></h4>
      <ul className={styles.groupList}>
        {candidates.map((c) => {
          const dark = kind === 'color' ? (c as ColorCandidate).dark : undefined
          return (
            <li key={c.id} className={styles.candidateRow}>
              <label className={styles.candidateLabel}>
                <Checkbox
                  checked={selectedIds.has(c.id)}
                  onCheckedChange={(checked) => onToggle(c.id, checked)}
                  boxSize="sm"
                />
                {kind === 'color' && (
                  <span className={styles.swatchPair} aria-hidden="true">
                    <span className={styles.swatch} style={{ '--swatch-color': c.value } as CSSProperties} />
                    {dark !== undefined && (
                      <span
                        className={`${styles.swatch} ${styles.swatchDark}`}
                        style={{ '--swatch-color': dark } as CSSProperties}
                      />
                    )}
                  </span>
                )}
                <span className={styles.candidateName}>--{c.name}</span>
                {dark !== undefined ? (
                  <span className={styles.candidateValue}>
                    {c.value} <span className={styles.darkValueLabel}>dark {dark}</span>
                  </span>
                ) : (
                  <span className={styles.candidateValue}>{c.value}</span>
                )}
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
