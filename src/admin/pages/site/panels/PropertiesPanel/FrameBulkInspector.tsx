/**
 * FrameBulkInspector — the Properties panel body when 1+ board FRAMES are
 * selected (`boardSlice.selectedFrameIds`, WS-7.1), as opposed to nodes.
 * Shown by `PropertiesPanel` in place of `FrameSizePanel`/`PropertiesPanelBody`
 * whenever the frame selection is non-empty — the two selection domains are
 * mutually exclusive (see `boardSlice`'s module doc), so exactly one of
 * "frame(s) selected" or "node(s) selected" is ever on screen.
 *
 * WS-7.2 — bulk frame actions, all resolved against `selectedFrameIds`:
 *   - Set size (W/H, mixed-value aware — typing replaces on every selected frame)
 *   - Device preset (`devicePresets.ts`, applied to every selected frame)
 *   - "Apply to all pages" — the literal ask: writes `width` to EVERY frame on
 *     the board (not just the selection) and persists it as the project's
 *     `frameDefaults` so a page added later inherits it.
 *   - Fit height to content — measures each selected frame's LIVE iframe
 *     height (already maintained by `useIframeFrameAutoHeight`) via a plain
 *     DOM read, so the store itself never touches the DOM.
 *   - Align / distribute / tidy — pure geometry in `boardSlice`.
 *   - Batch rename with a `{n}`-substituted pattern, applied in selection order.
 *   - Delete — one confirmation for the whole set (removes board membership
 *     only, same as the single-frame "Remove from board" action; never
 *     touches the underlying page file).
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { DEVICE_PRESETS, findMatchingPreset, FRAME_WIDTH, FRAME_HEIGHT, type DevicePreset } from '@core/studio-board'
import { MIN_FRAME_SIZE } from '@site/canvas/BoardFramesLayer/frameResize'
import { escapeCssAttributeValue } from '@site/canvas/canvasNodeLookup'
import { Select } from '@ui/components/Select'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { ScrubInput } from '@ui/components/ScrubInput'
import { MIXED, isMixed, type Mixed } from '@ui/components/MixedValue'
import { AlignBar } from '@ui/components/AlignBar'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import styles from './FrameBulkInspector.module.css'

/** Presets grouped by `group`, preserving `DEVICE_PRESETS`' own order (mirrors `FrameSizePanel`). */
function groupPresets(presets: DevicePreset[]): Map<string, DevicePreset[]> {
  const groups = new Map<string, DevicePreset[]>()
  for (const preset of presets) {
    const group = groups.get(preset.group)
    if (group) group.push(preset)
    else groups.set(preset.group, [preset])
  }
  return groups
}
const PRESET_GROUPS = groupPresets(DEVICE_PRESETS)
function presetOptionValue(preset: DevicePreset): string {
  return `${preset.group}::${preset.name}`
}

/**
 * A selected frame's live content height, read straight off the DOM element
 * `useIframeFrameAutoHeight` already fits (`iframe.style.height`) — a plain
 * imperative read, not a store subscription, so this only runs when the
 * "Fit height to content" button is clicked. `null` when the frame's iframe
 * isn't mounted (offscreen/virtualized — see `BoardFramesLayer`'s
 * virtualization note) or hasn't measured yet.
 */
function measureFrameContentHeight(pageId: string): number | null {
  const selector = `[data-testid="board-frames-layer"] [data-page-id="${escapeCssAttributeValue(pageId)}"] iframe`
  const iframe = document.querySelector<HTMLIFrameElement>(selector)
  if (!iframe) return null
  const height = Number.parseFloat(iframe.style.height || '')
  return Number.isFinite(height) && height > 0 ? height : null
}

export function FrameBulkInspector() {
  const board = useEditorStore(selectActiveBoard)
  const selectedFrameIds = useEditorStore((s) => s.selectedFrameIds)
  const setSelectedFramesSize = useEditorStore((s) => s.setSelectedFramesSize)
  const applyWidthToAllFrames = useEditorStore((s) => s.applyWidthToAllFrames)
  const setFrameHeights = useEditorStore((s) => s.setFrameHeights)
  const alignSelectedFrames = useEditorStore((s) => s.alignSelectedFrames)
  const distributeSelectedFrames = useEditorStore((s) => s.distributeSelectedFrames)
  const tidySelectedFrames = useEditorStore((s) => s.tidySelectedFrames)
  const removeFrame = useEditorStore((s) => s.removeFrame)
  const clearFrameSelection = useEditorStore((s) => s.clearFrameSelection)
  const renamePage = useEditorStore((s) => s.renamePage)
  const confirmDelete = useConfirmDelete()

  const [renamePattern, setRenamePattern] = useState('Screen {n}')
  const [applyingToAll, setApplyingToAll] = useState(false)

  if (!board || selectedFrameIds.length === 0) return null

  const selectedFrames = selectedFrameIds
    .map((pageId) => board.frames.find((f) => f.pageId === pageId))
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
  if (selectedFrames.length === 0) return null

  const widths = new Set(selectedFrames.map((f) => f.width ?? FRAME_WIDTH))
  const heights = new Set(selectedFrames.map((f) => f.height ?? FRAME_HEIGHT))
  const mixedWidth = widths.size > 1
  const mixedHeight = heights.size > 1
  const singleWidth = mixedWidth ? '' : String([...widths][0])
  const singleHeight = mixedHeight ? '' : String([...heights][0])
  const matchingPreset = !mixedWidth && !mixedHeight ? findMatchingPreset([...widths][0]!, [...heights][0]!) : undefined

  const handlePresetChange = (value: string) => {
    const preset = DEVICE_PRESETS.find((p) => presetOptionValue(p) === value)
    if (preset) setSelectedFramesSize(preset.width, preset.height)
  }

  const handleApplyToAllPages = async () => {
    const width = mixedWidth ? undefined : Number.parseInt(singleWidth, 10)
    if (!width || !Number.isFinite(width)) return
    applyWidthToAllFrames(width)
    setApplyingToAll(true)
    try {
      const { saveFrameDefaults } = await import('@site/studio/frameDefaultsApi')
      await saveFrameDefaults({ width }, getStudioWorkspaceDir())
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Failed to save frame default',
        body: getErrorMessage(err, 'Unknown error saving the project frame default'),
      })
    } finally {
      setApplyingToAll(false)
    }
  }

  const handleFitHeight = () => {
    const heightsByPageId: Record<string, number> = {}
    for (const pageId of selectedFrameIds) {
      const measured = measureFrameContentHeight(pageId)
      if (measured !== null) heightsByPageId[pageId] = measured
    }
    setFrameHeights(heightsByPageId)
  }

  const handleBatchRename = () => {
    selectedFrameIds.forEach((pageId, i) => {
      const title = renamePattern.replace(/\{n\}/g, String(i + 1))
      if (title.trim()) renamePage(pageId, title)
    })
  }

  const handleDelete = () => {
    const count = selectedFrameIds.length
    confirmDelete({
      title: count === 1 ? 'Remove frame from board?' : `Remove ${count} frames from board?`,
      description: 'The underlying page files are not deleted — only their board membership.',
      confirmLabel: 'Remove',
      commit: () => {
        for (const pageId of selectedFrameIds) removeFrame(pageId)
        clearFrameSelection()
      },
    })
  }

  return (
    <div className={styles.panel} data-testid="frame-bulk-inspector">
      <div className={styles.header}>{selectedFrameIds.length} frames selected</div>

      <Select
        fieldSize="sm"
        value=""
        placeholder={matchingPreset ? matchingPreset.name : 'Custom'}
        aria-label="Device size preset"
        data-testid="frame-bulk-preset-select"
        onChange={(e) => handlePresetChange(e.target.value)}
      >
        {Array.from(PRESET_GROUPS.entries()).map(([group, presets]) => (
          <optgroup key={group} label={group}>
            {presets.map((preset) => (
              <option key={presetOptionValue(preset)} value={presetOptionValue(preset)}>
                {preset.name} ({preset.width}×{preset.height})
              </option>
            ))}
          </optgroup>
        ))}
      </Select>

      <div className={styles.dimensions}>
        <BulkDimensionInput
          label="W"
          ariaLabel="Frame width"
          value={mixedWidth ? MIXED : singleWidth}
          onCommit={(next) => setSelectedFramesSize(next, null)}
        />
        <BulkDimensionInput
          label="H"
          ariaLabel="Frame height"
          value={mixedHeight ? MIXED : singleHeight}
          onCommit={(next) => setSelectedFramesSize(null, next)}
        />
      </div>

      <Button
        variant="secondary"
        size="sm"
        disabled={mixedWidth || applyingToAll}
        onClick={handleApplyToAllPages}
        tooltip="Write this width to every frame on the board and save it as the project default"
      >
        Apply width to all pages
      </Button>

      <Button variant="secondary" size="sm" onClick={handleFitHeight} tooltip="Set each selected frame's height to its measured content">
        Fit height to content
      </Button>

      <div className={styles.sectionLabel}>Align &amp; distribute</div>
      <AlignBar
        count={selectedFrameIds.length}
        onAlign={(edge) => alignSelectedFrames(edge)}
        onDistribute={(axis) => distributeSelectedFrames(axis)}
        onTidy={tidySelectedFrames}
      />

      <div className={styles.sectionLabel}>Batch rename</div>
      <div className={styles.renameRow}>
        <Input
          fieldSize="sm"
          value={renamePattern}
          onChange={(e) => setRenamePattern(e.target.value)}
          aria-label="Rename pattern — use {n} for the position number"
          placeholder="Screen {n}"
        />
        <Button variant="secondary" size="sm" onClick={handleBatchRename} disabled={!renamePattern.trim()}>
          Rename all
        </Button>
      </div>

      <Button variant="destructive" size="sm" onClick={handleDelete} tooltip="Remove the selected frames from the board">
        <TrashSolidIcon size={13} aria-hidden="true" />
        Remove from board
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BulkDimensionInput — like FrameSizePanel's FrameDimensionInput, but with
// mixed-value support: shows an empty field with a "Mixed" placeholder when
// the selection's widths (or heights) differ, and committing any typed value
// applies it to every selected frame (via the parent's `onCommit`).
// ---------------------------------------------------------------------------

interface BulkDimensionInputProps {
  label: string
  ariaLabel: string
  /** The single shared value as a string, or `''` when `mixed`. */
  value: string | Mixed
  onCommit: (next: number) => void
}

function BulkDimensionInput({ label, ariaLabel, value, onCommit }: BulkDimensionInputProps) {
  const clamp = (n: number) => Math.max(MIN_FRAME_SIZE, Math.round(n))

  const commit = (raw: string) => {
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n)) onCommit(clamp(n))
  }

  return (
    <ScrubInput
      label={label}
      aria-label={ariaLabel}
      fieldSize="sm"
      value={isMixed(value) ? MIXED : value}
      onChange={commit}
      min={MIN_FRAME_SIZE}
      data-testid={`frame-bulk-${label.toLowerCase()}`}
    />
  )
}
