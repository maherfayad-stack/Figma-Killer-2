/**
 * VectorPaintControls — the body of the Vector section: fill, stroke, stroke
 * weight / caps / joins, opacity and the `<svg>`'s own width / height /
 * viewBox, for ONE literal inline `<svg>` (`base.svg`), written back as JSX
 * attributes on the elements that carry them (`fill="…"`,
 * `strokeWidth={2}`) — see `vectorPaintModel.ts` for what a target means and
 * what refuses, and `vectorPaintCommit.ts` for how a gesture becomes one save.
 *
 * Takes the node as props rather than reading the selection, because two
 * places mount it: the Vector manifest section (a `<svg>` selected in a frame)
 * and the loose-layer inspector (a `<svg>` drawn on the free canvas, whose
 * element lives in its own `canvas:<id>` page and is never "the selected
 * node").
 *
 * A graphic this cannot write says why, once, above disabled controls — the
 * invariant-2 rule: an edit with no single honest target is refused by name,
 * never silently dropped.
 */
import { useEffect, useRef, useState } from 'react'
import type { PageNode } from '@core/page-tree'
import { Select } from '@ui/components/Select'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Input } from '@ui/components/Input'
import { MIXED } from '@ui/components/MixedValue'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { pushToast } from '@ui/components/Toast'
import {
  planVectorWrite,
  readVectorField,
  readVectorGraphic,
  vectorTargetOptions,
  vectorPaintRefusal,
  viewBoxAspect,
  type VectorFieldState,
  type VectorTarget,
} from './vectorPaintModel'
import { createVectorPaintCommitter } from './vectorPaintCommit'
import styles from './VectorSection.module.css'

type PaintMode = 'color' | 'none' | 'currentColor'

const PAINT_MODE_OPTIONS = [
  { label: 'Colour', value: 'color' },
  { label: 'None', value: 'none' },
  { label: 'Current colour', value: 'currentColor' },
]

const LINECAP_OPTIONS = [
  { label: 'Butt', value: 'butt' },
  { label: 'Round', value: 'round' },
  { label: 'Square', value: 'square' },
]

const LINEJOIN_OPTIONS = [
  { label: 'Miter', value: 'miter' },
  { label: 'Round', value: 'round' },
  { label: 'Bevel', value: 'bevel' },
]

function paintMode(value: string | null): PaintMode | null {
  if (value === null) return null
  if (value.trim().toLowerCase() === 'none') return 'none'
  if (value.trim().toLowerCase() === 'currentcolor') return 'currentColor'
  return 'color'
}

function formatOpacity(value: string | null): string | typeof MIXED {
  if (value === null) return MIXED
  const n = Number(value)
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 10) : value
}

interface VectorPaintControlsProps {
  nodeId: string
  node: PageNode
}

export function VectorPaintControls({ nodeId, node }: VectorPaintControlsProps) {
  const permissions = useEditorPermissions()
  const [target, setTarget] = useState<VectorTarget>('all')
  const [committer] = useState(createVectorPaintCommitter)
  const committerRef = useRef(committer)
  // Leaving the panel (or the selection) posts whatever burst is still settling.
  useEffect(() => {
    const pending = committerRef.current
    return () => pending.flush()
  }, [])

  const markup = typeof node.props.svg === 'string' ? node.props.svg : ''
  const graphic = readVectorGraphic(markup)
  const refusal = vectorPaintRefusal(nodeId, node, graphic)
  const readOnly = refusal !== null || !permissions.canEditStyle
  const liveTarget: VectorTarget = graphic && (target === 'all' || graphic.parts.some((part) => part.part === target)) ? target : 'all'
  const showsRoot = liveTarget === 'all' || liveTarget === ''

  const field = (name: Parameters<typeof readVectorField>[2]): VectorFieldState =>
    graphic ? readVectorField(graphic, liveTarget, name) : { value: null, inherited: false, lockedReason: null }

  const write = (name: Parameters<typeof readVectorField>[2], value: string | null, label: string, settle: 'burst' | 'now') => {
    if (!graphic || readOnly) return
    const plan = planVectorWrite(graphic, nodeId, liveTarget, name, value)
    if (!plan.ok) {
      pushToast({ kind: 'warning', title: 'Cannot change this graphic', body: plan.reason, location: 'site-editor' })
      return
    }
    committer.push(nodeId, plan.writes, label, settle)
  }

  const fill = field('fill')
  const stroke = field('stroke')
  const strokeWidth = field('strokeWidth')
  const linecap = field('strokeLinecap')
  const linejoin = field('strokeLinejoin')
  const opacity = field('opacity')
  const width = field('width')
  const height = field('height')
  const viewBox = field('viewBox')
  const aspect = viewBoxAspect(viewBox.value)
  const strokeVisible = paintMode(stroke.value) !== 'none'

  // Proportional sizing: while width and height already follow the viewBox's
  // ratio, changing one keeps it — the Figma "constrain proportions" default
  // for a vector. A graphic authored off-ratio keeps its two numbers free.
  const proportional =
    aspect !== null && Number(width.value) > 0 && Number(height.value) > 0 &&
    Math.abs(Number(width.value) / Number(height.value) - aspect) < 0.01
  const writeSize = (axis: 'width' | 'height', next: string) => {
    const n = Number.parseFloat(next)
    if (!Number.isFinite(n) || n <= 0) return
    write(axis, String(n), 'Resize graphic', 'burst')
    if (proportional && aspect !== null) {
      const other = axis === 'width' ? n / aspect : n * aspect
      write(axis === 'width' ? 'height' : 'width', String(Math.round(other * 100) / 100), 'Resize graphic', 'burst')
    }
  }

  const reasons = [...new Set([fill, stroke, strokeWidth, linecap, linejoin, opacity, ...(showsRoot ? [width, height, viewBox] : [])]
    .map((state) => state.lockedReason)
    .filter((reason): reason is string => reason !== null))]

  const paintRow = (label: 'Fill' | 'Stroke', attribute: 'fill' | 'stroke', state: VectorFieldState) => {
    const mode = paintMode(state.value)
    const disabled = readOnly || state.lockedReason !== null
    return (
      <div className={styles.row} data-testid={`vector-${attribute}-row`}>
        <span className={styles.rowLabel}>{label}</span>
        <Select
          fieldSize="sm"
          className={styles.mode}
          value={mode ?? ''}
          mixed={mode === null}
          disabled={disabled}
          aria-label={`${label} type`}
          data-testid={`vector-${attribute}-mode`}
          options={PAINT_MODE_OPTIONS}
          onChange={(event) => {
            const next = event.target.value as PaintMode
            const value = next === 'color' ? (mode === 'color' && state.value ? state.value : '#000000') : next
            write(attribute, value, label, 'now')
          }}
        />
        {/* Mixed shapes still get the field: typing one colour is how a
            designer unifies them. */}
        {(mode === 'color' || mode === null) && (
          <span className={styles.colour}>
            <ColorValueInput
              value={state.value ?? ''}
              mixed={mode === null}
              ariaLabel={`${label} colour`}
              swatchLabel={`Pick ${label.toLowerCase()} colour`}
              disabled={disabled}
              onChange={(value) => write(attribute, value.trim() === '' ? null : value, label, 'burst')}
            />
          </span>
        )}
      </div>
    )
  }

  const targetOptions = graphic ? vectorTargetOptions(graphic) : []

  return (
    <div className={styles.root} data-testid="vector-paint">
      {refusal && (
        <p className={styles.note} role="note" data-testid="vector-paint-refusal">
          {refusal}
        </p>
      )}
      {targetOptions.length > 2 && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>Applies to</span>
          <Select
            fieldSize="sm"
            className={styles.grow}
            value={liveTarget}
            aria-label="Which part of the graphic"
            data-testid="vector-target"
            options={targetOptions}
            onChange={(event) => {
              committer.flush()
              setTarget(event.target.value)
            }}
          />
        </div>
      )}
      {paintRow('Fill', 'fill', fill)}
      {paintRow('Stroke', 'stroke', stroke)}
      {strokeVisible && (
        <div className={styles.row} data-testid="vector-stroke-details">
          <span className={styles.rowLabel} aria-hidden="true" />
          <ScrubInput
            fieldSize="sm"
            className={styles.weight}
            label="W"
            aria-label="Stroke weight"
            data-testid="vector-stroke-width"
            unit=""
            min={0}
            step={0.5}
            value={strokeWidth.value ?? MIXED}
            inherited={strokeWidth.inherited}
            disabled={readOnly || strokeWidth.lockedReason !== null}
            onChange={(next) => write('strokeWidth', next.trim() === '' ? null : next, 'Stroke weight', 'burst')}
          />
          <Select
            fieldSize="sm"
            className={styles.grow}
            value={linecap.value ?? ''}
            mixed={linecap.value === null}
            aria-label="Stroke cap"
            data-testid="vector-stroke-linecap"
            disabled={readOnly || linecap.lockedReason !== null}
            options={LINECAP_OPTIONS}
            onChange={(event) => write('strokeLinecap', event.target.value, 'Stroke cap', 'now')}
          />
          <Select
            fieldSize="sm"
            className={styles.grow}
            value={linejoin.value ?? ''}
            mixed={linejoin.value === null}
            aria-label="Stroke join"
            data-testid="vector-stroke-linejoin"
            disabled={readOnly || linejoin.lockedReason !== null}
            options={LINEJOIN_OPTIONS}
            onChange={(event) => write('strokeLinejoin', event.target.value, 'Stroke join', 'now')}
          />
        </div>
      )}
      <div className={styles.row}>
        <span className={styles.rowLabel}>Opacity</span>
        <ScrubInput
          fieldSize="sm"
          className={styles.grow}
          label="%"
          aria-label="Graphic opacity"
          data-testid="vector-opacity"
          unit=""
          min={0}
          max={100}
          value={formatOpacity(opacity.value)}
          inherited={opacity.inherited}
          disabled={readOnly || opacity.lockedReason !== null}
          onChange={(next) => {
            const percent = Number.parseFloat(next)
            if (!Number.isFinite(percent)) return
            write('opacity', percent >= 100 ? null : String(Math.max(0, percent) / 100), 'Opacity', 'burst')
          }}
        />
      </div>
      {showsRoot && (
        <>
          <div className={styles.row} data-testid="vector-size-row">
            <span className={styles.rowLabel}>Size</span>
            <ScrubInput
              fieldSize="sm"
              className={styles.grow}
              label="W"
              aria-label="SVG width attribute"
              data-testid="vector-width"
              unit=""
              min={0}
              value={width.value ?? ''}
              disabled={readOnly || width.lockedReason !== null}
              onChange={(next) => writeSize('width', next)}
            />
            <ScrubInput
              fieldSize="sm"
              className={styles.grow}
              label="H"
              aria-label="SVG height attribute"
              data-testid="vector-height"
              unit=""
              min={0}
              value={height.value ?? ''}
              disabled={readOnly || height.lockedReason !== null}
              onChange={(next) => writeSize('height', next)}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>viewBox</span>
            <ViewBoxField
              value={viewBox.value ?? ''}
              disabled={readOnly || viewBox.lockedReason !== null}
              onCommit={(next) => write('viewBox', next.trim() === '' ? null : next.trim(), 'viewBox', 'now')}
            />
          </div>
        </>
      )}
      {!refusal && reasons.map((reason) => (
        <p key={reason} className={styles.note} role="note" data-testid="vector-paint-lock">
          {reason}
        </p>
      ))}
    </div>
  )
}

/** The viewBox as text — committed on Enter or blur, never per keystroke. */
function ViewBoxField({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setDraft(value)
  }
  const commit = () => {
    if (draft !== value && (draft.trim() === '' || viewBoxAspect(draft) !== null)) onCommit(draft)
    else setDraft(value)
  }
  return (
    <Input
      fieldSize="sm"
      className={styles.grow}
      aria-label="SVG viewBox"
      data-testid="vector-viewbox"
      placeholder="min-x min-y width height"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}
