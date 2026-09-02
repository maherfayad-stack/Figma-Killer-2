/**
 * InspectPanel — read-only "what actually rendered" view for the selected
 * node: computed colors (as copyable swatches, with design-token names when
 * an exact match exists), typography, box model, and the raw effective CSS.
 *
 * Docked left-sidebar panel (Phase 6C), mounted the same way as
 * Selectors/Framework/Dependencies — see `LeftSidebar.tsx`. Read-only, so it
 * stays visible for non-editing callers too (unlike those three).
 *
 * All computed-style reading + the pure model transform live in
 * `useInspectComputedStyle` / `inspectModel.ts`; this file is chrome + copy
 * affordances only.
 */
import { useState, type CSSProperties } from 'react'
import { useEditorStore, selectSelectedNode } from '@site/store/store'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { Panel } from '@admin/shared/Panel'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { cn } from '@ui/cn'
import { useInspectComputedStyle } from './useInspectComputedStyle'
import { buildInspectModel, type ColorTokenLike, type InspectColorSwatch } from './inspectModel'
import styles from './InspectPanel.module.css'

async function copyToClipboard(value: string, label: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    pushToast({ kind: 'error', title: `Could not copy ${label}`, body: 'Clipboard is unavailable.' })
    return false
  }
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch (err) {
    pushToast({
      kind: 'error',
      title: `Could not copy ${label}`,
      body: getErrorMessage(err, 'Clipboard write failed.'),
    })
    console.error('[InspectPanel] copy failed:', err)
    return false
  }
}

export function InspectPanel() {
  const setInspectPanelOpen = useEditorStore((s) => s.setInspectPanelOpen)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectedNode = useEditorStore(selectSelectedNode)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const colorSettings = useEditorStore((s) => s.site?.settings.framework?.colors)

  const snapshot = useInspectComputedStyle(selectedNodeId, selectedNode, activeBreakpointId)
  const tokens: ColorTokenLike[] = generateFrameworkColorVariableSets(colorSettings).light.map(
    (variable) => ({ name: variable.name, value: variable.value }),
  )
  const model = snapshot ? buildInspectModel(snapshot, tokens) : null

  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  async function handleCopy(key: string, value: string, label: string) {
    const ok = await copyToClipboard(value, label)
    if (!ok) return
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1200)
  }

  return (
    <Panel
      panelId="inspect"
      title="Inspect"
      testId="inspect-panel"
      onClose={() => setInspectPanelOpen(false)}
    >
      {!selectedNodeId ? (
        <p className={styles.emptyState}>Select an element to inspect.</p>
      ) : !model ? (
        <p className={styles.emptyState}>Not currently rendered on the canvas.</p>
      ) : (
        <div className={styles.sections}>
          <ColorsSection colors={model.colors} copiedKey={copiedKey} onCopy={handleCopy} />
          <TypographySection typography={model.typography} copiedKey={copiedKey} onCopy={handleCopy} />
          <BoxModelSection boxModel={model.boxModel} />
          <CssSection css={model.css} copiedKey={copiedKey} onCopy={handleCopy} />
        </div>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface CopyHandler {
  (key: string, value: string, label: string): void
}

function CopyButton({
  copyKey,
  value,
  label,
  copiedKey,
  onCopy,
}: {
  copyKey: string
  value: string
  label: string
  copiedKey: string | null
  onCopy: CopyHandler
}) {
  const copied = copiedKey === copyKey
  return (
    <Button
      variant="ghost"
      size="micro"
      iconOnly
      aria-label={`Copy ${label}`}
      tooltip={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => onCopy(copyKey, value, label)}
      className={styles.copyButton}
    >
      {copied ? <CheckIcon size={11} aria-hidden="true" /> : <CopySolidIcon size={11} aria-hidden="true" />}
    </Button>
  )
}

function ColorsSection({
  colors,
  copiedKey,
  onCopy,
}: {
  colors: InspectColorSwatch[]
  copiedKey: string | null
  onCopy: CopyHandler
}) {
  if (colors.length === 0) return null
  return (
    <section className={styles.section} aria-label="Colors">
      <h3 className={styles.sectionTitle}>Colors</h3>
      <ul className={styles.colorList}>
        {colors.map((swatch) => {
          const chipColor = swatch.value.hex ?? swatch.value.raw
          const copyValue = swatch.value.hex ?? swatch.value.raw
          return (
            <li key={swatch.property} className={styles.colorRow}>
              <span
                className={styles.swatch}
                style={{ '--swatch': chipColor } as CSSProperties}
                aria-hidden="true"
              />
              <span className={styles.colorInfo}>
                <span className={styles.colorLabel}>{swatch.label}</span>
                <span className={styles.colorValue}>
                  {swatch.value.tokenName ? (
                    <>
                      <span className={styles.tokenName}>{swatch.value.tokenName}</span>
                      <span className={styles.colorRaw}>{swatch.value.raw}</span>
                    </>
                  ) : (
                    <span className={styles.colorRaw}>{swatch.value.raw}</span>
                  )}
                </span>
              </span>
              <CopyButton
                copyKey={`color:${swatch.property}`}
                value={copyValue}
                label={`${swatch.label.toLowerCase()} value`}
                copiedKey={copiedKey}
                onCopy={onCopy}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function TypographySection({
  typography,
  copiedKey,
  onCopy,
}: {
  typography: ReturnType<typeof buildInspectModel>['typography']
  copiedKey: string | null
  onCopy: CopyHandler
}) {
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'fontFamily', label: 'Font', value: typography.fontFamily },
    { key: 'fontSize', label: 'Size', value: typography.fontSize },
    { key: 'fontWeight', label: 'Weight', value: typography.fontWeight },
    { key: 'lineHeight', label: 'Line height', value: typography.lineHeight },
    { key: 'letterSpacing', label: 'Letter spacing', value: typography.letterSpacing },
  ]
  return (
    <section className={styles.section} aria-label="Typography">
      <h3 className={styles.sectionTitle}>Typography</h3>
      <dl className={styles.rowList}>
        {rows.map((row) => (
          <div key={row.key} className={styles.row}>
            <dt className={styles.rowLabel}>{row.label}</dt>
            <dd className={styles.rowValue}>{row.value}</dd>
            <CopyButton
              copyKey={`typography:${row.key}`}
              value={row.value}
              label={row.label.toLowerCase()}
              copiedKey={copiedKey}
              onCopy={onCopy}
            />
          </div>
        ))}
      </dl>
    </section>
  )
}

function BoxModelSection({ boxModel }: { boxModel: ReturnType<typeof buildInspectModel>['boxModel'] }) {
  const sides = (s: { top: string; right: string; bottom: string; left: string }) =>
    `${s.top} ${s.right} ${s.bottom} ${s.left}`
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'width', label: 'Width', value: boxModel.width },
    { key: 'height', label: 'Height', value: boxModel.height },
    { key: 'margin', label: 'Margin (T R B L)', value: sides(boxModel.margin) },
    { key: 'padding', label: 'Padding (T R B L)', value: sides(boxModel.padding) },
    { key: 'borderWidth', label: 'Border width (T R B L)', value: sides(boxModel.borderWidth) },
  ]
  return (
    <section className={styles.section} aria-label="Box model">
      <h3 className={styles.sectionTitle}>Box model</h3>
      <dl className={styles.rowList}>
        {rows.map((row) => (
          <div key={row.key} className={styles.row}>
            <dt className={styles.rowLabel}>{row.label}</dt>
            <dd className={cn(styles.rowValue, styles.monoValue)}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function CssSection({
  css,
  copiedKey,
  onCopy,
}: {
  css: string
  copiedKey: string | null
  onCopy: CopyHandler
}) {
  return (
    <section className={styles.section} aria-label="Effective CSS">
      <div className={styles.cssHeader}>
        <h3 className={styles.sectionTitle}>CSS</h3>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onCopy('css', css, 'CSS')}
        >
          {copiedKey === 'css' ? 'Copied' : 'Copy CSS'}
        </Button>
      </div>
      <pre className={styles.cssBlock}>{css}</pre>
    </section>
  )
}
