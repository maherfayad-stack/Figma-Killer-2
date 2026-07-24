/**
 * FrameSizePanel — Phase 6E device-size preset picker + W/H inputs, shown at
 * the TOP of the design tab (above `PropertiesPanelBody`) whenever the
 * active page is a board frame on the active studio board.
 *
 * Studio-only: gated on `isStudioMode()` — the CMS canvas has no boards, so
 * a page there never resolves to a `BoardFrame`. Also gates on there being a
 * frame at all: a page that's open in the canvas but not curated onto the
 * active board (or a CMS page while `?studio` happens to be sticky) renders
 * nothing here.
 *
 * Size resolution mirrors `BoardFramesLayer`'s own fallback — a frame
 * without a saved `width`/`height` reads as the shared `FRAME_WIDTH`/
 * `FRAME_HEIGHT` default (1024×800), so a never-resized frame shows that
 * size here too instead of blank inputs.
 *
 * The preset `<Select>` and the W/H `NumberControl`s both write through the
 * same `setFrameSize` action (boardSlice) — picking a preset is just a
 * shortcut for typing its width/height. `findMatchingPreset` (pure,
 * `@core/studio-board`) decides whether the current size matches a preset
 * exactly; the select shows that preset's name via its `placeholder`
 * (mirroring `DocumentSwitcher`'s "value lives in the placeholder" pattern)
 * so an unmatched size reads as "Custom" without needing a synthetic
 * "Custom" option in the list.
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { isStudioMode } from '@site/studio/studioMode'
import { DEVICE_PRESETS, findMatchingPreset, type DevicePreset } from '@core/studio-board'
import { FRAME_WIDTH, FRAME_HEIGHT } from '@site/canvas/BoardFramesLayer/frameGrid'
import { MIN_FRAME_SIZE } from '@site/canvas/BoardFramesLayer/frameResize'
import { Select } from '@ui/components/Select'
import { Input } from '@ui/components/Input'
import { nudgeNumber } from '@site/property-controls/numericNudge'
import styles from './FrameSizePanel.module.css'

/** Presets grouped by `group`, preserving `DEVICE_PRESETS`' own order. */
function groupPresets(presets: DevicePreset[]): Map<string, DevicePreset[]> {
  const groups = new Map<string, DevicePreset[]>()
  for (const preset of presets) {
    const group = groups.get(preset.group)
    if (group) {
      group.push(preset)
    } else {
      groups.set(preset.group, [preset])
    }
  }
  return groups
}

const PRESET_GROUPS = groupPresets(DEVICE_PRESETS)

/** `option value` encodes both fields — group+name alone isn't guaranteed
 * unique across groups, but pairing it with the preset list lookup below is
 * simplest and the list is small enough that a linear find is fine. */
function presetOptionValue(preset: DevicePreset): string {
  return `${preset.group}::${preset.name}`
}

export function FrameSizePanel() {
  const board = useEditorStore(selectActiveBoard)
  const activePageId = useEditorStore((s) => s.activePageId)
  const setFrameSize = useEditorStore((s) => s.setFrameSize)

  if (!isStudioMode() || !board || !activePageId) return null
  const frame = board.frames.find((f) => f.pageId === activePageId)
  if (!frame) return null

  const width = frame.width ?? FRAME_WIDTH
  const height = frame.height ?? FRAME_HEIGHT
  const matchingPreset = findMatchingPreset(width, height)

  const handlePresetChange = (value: string) => {
    const preset = DEVICE_PRESETS.find((p) => presetOptionValue(p) === value)
    if (preset) setFrameSize(frame.pageId, preset.width, preset.height)
  }

  return (
    <div className={styles.panel} data-testid="frame-size-panel">
      <Select
        fieldSize="sm"
        value=""
        placeholder={matchingPreset ? matchingPreset.name : 'Custom'}
        aria-label="Device size preset"
        data-testid="frame-size-preset-select"
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
        <FrameDimensionInput
          label="W"
          ariaLabel="Frame width"
          value={width}
          onCommit={(next) => setFrameSize(frame.pageId, next, height)}
        />
        <FrameDimensionInput
          label="H"
          ariaLabel="Frame height"
          value={height}
          onCommit={(next) => setFrameSize(frame.pageId, width, next)}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FrameDimensionInput — in-field-labelled integer input for frame W / H
//
// Matches the Size section's DimensionCell look (label inside the leading
// edge, no chunky spinner) while keeping the frame's immediate-commit,
// integer-clamped numeric semantics. A local draft lets the user type
// intermediate values without the frame resizing on every keystroke; arrow
// nudging (±1 / ±8 Shift / ±0.1 Alt, rounded to whole pixels) applies live.
// ---------------------------------------------------------------------------

interface FrameDimensionInputProps {
  label: string
  ariaLabel: string
  value: number
  onCommit: (next: number) => void
}

function FrameDimensionInput({ label, ariaLabel, value, onCommit }: FrameDimensionInputProps) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)

  // Sync external value → draft when not actively editing (React 19 idiom:
  // adjust state during render by tracking the previous external value).
  const [lastExternal, setLastExternal] = useState(String(value))
  if (!editing && String(value) !== lastExternal) {
    setLastExternal(String(value))
    setDraft(String(value))
  }

  const clamp = (n: number) => Math.max(MIN_FRAME_SIZE, Math.round(n))

  const commit = (raw: string) => {
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n)) onCommit(clamp(n))
    else setDraft(String(value))
    setEditing(false)
  }

  return (
    <Input
      type="text"
      inputMode="numeric"
      prefix={label}
      aria-label={ariaLabel}
      fieldSize="sm"
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const step = e.altKey ? 0.1 : e.shiftKey ? 8 : 1
          const base = Number.parseFloat(draft)
          const start = Number.isFinite(base) ? base : value
          const next = clamp(
            nudgeNumber(start, e.key === 'ArrowUp' ? 'up' : 'down', step, { min: MIN_FRAME_SIZE }),
          )
          setDraft(String(next))
          onCommit(next)
        }
      }}
    />
  )
}
