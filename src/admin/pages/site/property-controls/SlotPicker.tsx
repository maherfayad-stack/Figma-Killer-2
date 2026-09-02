/**
 * SlotPicker — choosing WHAT goes into a slot, separated from
 * `SlotControl.tsx`, which owns whether the slot can be written at all and
 * what happens after.
 *
 * It became its own module when icons arrived. "Pick a component from a list
 * of names" is a search box over one array; "pick an icon" is a previewed
 * grid over several hundred glyphs from three sources, plus a file the user
 * supplies from disk — a different reason to change, with its own fetching,
 * its own empty states and its own failure modes.
 *
 * ## Every candidate leaves here as the same thing
 *
 * The picker's whole output is one `SlotJsxNode`: a component fill is
 * `{ name, importSpecifier }`, an SVG is the subtree `svgToJsxNode` built.
 * `SlotControl` therefore has one commit path, not one per source, and an
 * uploaded file is not a special case of anything — it converts through the
 * exact code the package catalogue does, which is also where it gets
 * sanitised.
 *
 * ## Uploads never touch the server
 *
 * An SVG the user picks is read in the browser, sanitised, converted, and
 * written INTO their source as inline JSX. Nothing is stored, no asset lands
 * in `uploads/`, and there is no file for a later build step to resolve — the
 * icon is in the file the moment the write lands.
 */
import { useEffect, useState } from 'react'
import { sanitizeSvg } from '@core/sanitize'
import { getErrorMessage } from '@core/utils/errorMessage'
import { fetchLocalComponentCatalog } from '@site/studio/componentCatalog'
import { fetchStudioIconCatalog, type StudioIcon } from '@site/studio/iconCatalog'
import type { SlotJsxNode } from '@site/studio/studioSaveRequests'
import { Button } from '@ui/components/Button'
import { FileUpload } from '@ui/components/FileUpload'
import { SearchBar } from '@ui/components/SearchBar'
import { pushToast } from '@ui/components/Toast'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import type { LocalComponentSpec } from './componentPropKind'
import { isIconProp, slotCandidatesFor, type SlotCandidate } from './slotCandidates'
import { svgToJsxNode } from '@site/studio/svgToJsxNode'
import styles from './controls.module.css'

/** How many candidates render at once. A design system's icon set runs to several hundred; the search box is how you reach the rest. */
const VISIBLE_LIMIT = 120

/** An uploaded SVG is read in full in the browser, so it needs its own ceiling — the catalogue's per-file cap does not apply to it. */
const MAX_UPLOAD_BYTES = 64 * 1024

interface SlotPickerProps {
  propKey: string
  label: string
  /** The call site's own file, needed to resolve a PROJECT component's import relative to it. */
  ownerRelPath: string
  /** Name of the candidate currently being written, or `null`. */
  submittingName: string | null
  /** Which write a pick issues — only affects the wording here; `SlotControl` owns the commit. */
  mode: 'append' | 'replace'
  onPick: (node: SlotJsxNode, name: string) => void
}

export function SlotPicker({ propKey, label, ownerRelPath, submittingName, mode, onPick }: SlotPickerProps) {
  const [query, setQuery] = useState('')
  const [components, setComponents] = useState<LocalComponentSpec[] | null>(null)
  const [icons, setIcons] = useState<StudioIcon[] | null>(null)

  const iconProp = isIconProp(propKey)

  useEffect(() => {
    let cancelled = false
    // Both catalogues are cached per project by their own modules, so
    // re-opening the picker — on this row or any other — costs nothing.
    void fetchLocalComponentCatalog().then((list) => {
      if (!cancelled) setComponents(list)
    })
    void fetchStudioIconCatalog().then((list) => {
      if (!cancelled) setIcons(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  function handlePick(candidate: SlotCandidate) {
    if (candidate.kind === 'component') {
      onPick({ name: candidate.name, importSpecifier: candidate.importSpecifier }, candidate.name)
      return
    }
    const converted = svgToJsxNode(candidate.markup)
    if (!converted.ok) {
      pushToast({ kind: 'error', title: `Cannot use ${candidate.name}`, body: converted.message })
      return
    }
    onPick(converted.node, candidate.name)
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return
    if (file.size > MAX_UPLOAD_BYTES) {
      pushToast({
        kind: 'error',
        title: 'SVG too large',
        body: `${file.name} is ${Math.round(file.size / 1024)} KB. Studio inlines an icon into your source, so it accepts up to ${MAX_UPLOAD_BYTES / 1024} KB.`,
      })
      return
    }
    try {
      const converted = svgToJsxNode(await file.text())
      if (!converted.ok) {
        pushToast({ kind: 'error', title: `Cannot use ${file.name}`, body: converted.message })
        return
      }
      onPick(converted.node, file.name)
    } catch (err) {
      pushToast({ kind: 'error', title: 'Could not read that file', body: getErrorMessage(err, 'Unknown error') })
    }
  }

  const loading = components === null || icons === null
  const candidates = slotCandidatesFor(propKey, ownerRelPath ? (components ?? []) : [], ownerRelPath, icons ?? [])
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? candidates.filter((c) => c.name.toLowerCase().includes(needle))
    : candidates
  const visible = matches.slice(0, VISIBLE_LIMIT)

  return (
    <div className={styles.slotPicker} data-testid={`slot-control-${propKey}-picker`}>
      <SearchBar
        value={query}
        onValueChange={setQuery}
        placeholder={iconProp ? 'Search icons…' : 'Search components…'}
        aria-label={`Search ${iconProp ? 'icons' : 'components'} for the ${label} slot`}
        autoFocus
      />

      {loading ? (
        <p className={styles.slotPickerEmpty}>Loading…</p>
      ) : visible.length === 0 ? (
        <p className={styles.slotPickerEmpty}>
          {iconProp
            ? 'No icon matched. Studio offers the icons your installed design system actually ships, plus your own components — or upload an SVG below.'
            : 'No component matched. Studio only offers components it can find declared in your own files.'}
        </p>
      ) : (
        <ul className={styles.slotPickerList} role="listbox" aria-label={`Choices for the ${label} slot`}>
          {visible.map((candidate) => (
            <li key={candidate.key}>
              <Button
                variant="ghost"
                size="xs"
                className={styles.slotPickerCandidate}
                onClick={() => handlePick(candidate)}
                disabled={submittingName !== null}
                data-testid={`slot-control-${propKey}-candidate-${candidate.name}`}
              >
                {candidate.kind === 'svg' ? (
                  <span
                    className={styles.slotPickerPreview}
                    aria-hidden="true"
                    // Sanitised here as well as in `svgToJsxNode`: this markup
                    // is rendered inside `/admin`, same-origin, so the preview
                    // is its own trust boundary and does not get to assume the
                    // conversion path already ran.
                    dangerouslySetInnerHTML={{ __html: sanitizeSvg(candidate.markup) }}
                  />
                ) : (
                  <span className={styles.slotPickerPreview} aria-hidden="true" />
                )}
                <span className={styles.slotPickerName}>
                  {submittingName === candidate.name
                    ? `${mode === 'replace' ? 'Replacing with' : 'Adding'} ${candidate.name}…`
                    : candidate.name}
                </span>
                {candidate.kind === 'svg' && candidate.group && (
                  <span className={styles.slotPickerGroup}>{candidate.group}</span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {matches.length > visible.length && (
        <p className={styles.slotPickerCount}>
          Showing {visible.length} of {matches.length} — keep typing to narrow it down.
        </p>
      )}

      <FileUpload
        accept="image/svg+xml,.svg"
        buttonProps={{
          variant: 'ghost',
          size: 'xs',
          disabled: submittingName !== null,
          className: styles.slotPickerCandidate,
          'data-testid': `slot-control-${propKey}-upload`,
        }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          // Cleared so picking the SAME file twice fires `change` again.
          event.currentTarget.value = ''
          void handleUpload(file)
        }}
      >
        <UploadIcon size={11} aria-hidden="true" />
        Upload an SVG…
      </FileUpload>
    </div>
  )
}
