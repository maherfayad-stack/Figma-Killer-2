/**
 * ColorsSection — the built-in design system's palette in the Assets panel
 * (DS-7).
 *
 * A swatch is two facts at once: the light value and the dark value. Showing
 * one of them would be a lie on half the boards this editor opens, so every
 * swatch is split — light leading, dark trailing — and collapses to a single
 * block only when the token genuinely declares the same value in both themes
 * (the static and gradient-stop families). The token's own name sits under it,
 * spelled `--color-x`, because that is the string a designer types into code.
 *
 * ## Two actions, and why one of them is not always there
 *
 * **Click copies `var(--name)`.** That works with nothing selected, it works
 * on a locked node, and it is the action a designer reaches for most.
 *
 * **Apply to fill / Apply to text** appear only when exactly one layer is
 * selected, and they route through `useInspectorCommit` — the SAME commit the
 * inspector's own fields use. That matters more than it looks: the inspector
 * decides per property whether a value lands inline or on the element's one
 * editable class, refuses a property the component's source computes, and
 * coalesces history. Writing `backgroundColor` from here with its own call to
 * `setNodeInlineStyles` would quietly disagree with the field one panel over.
 * When there is no honest place to put the declaration — `resolveWriteTarget`
 * found no writable class and no writable inline layer, or the property is one
 * the component's own source computes (`lockedStyleProperties`, the same rule
 * `commitStyle` drops a patch key on) — the button renders DISABLED with that
 * reason as its tooltip. A control that commits nothing and says nothing is
 * the one thing this panel must never ship.
 *
 * The grid is a separate component from the section so the selection hooks —
 * `useSelectionModel` reads computed style off the live frame — only mount
 * while the section is actually expanded. Colors ships collapsed by default,
 * so the cost of having it in the panel is zero until someone opens it.
 */
import type { CSSProperties } from 'react'
import { Fragment } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useSelectionModel } from '@site/inspector/selectionModel'
import { lockedStyleProperties, useInspectorCommit } from '@site/inspector/commitApi'
import type { WriteTarget } from '@site/inspector/resolveWriteTarget'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import { AssetGroupLabel, AssetSection } from './AssetSection'
import {
  colorTokenTooltip,
  colorVarReference,
  groupColorItems,
  type ColorAssetItem,
} from './colorTokens'
import type { RankedAsset } from './rankAssets'
import styles from './ColorsSection.module.css'

/** The two properties a swatch can write, and the words the UI uses for them. */
const FILL_PROPERTY: keyof CSSPropertyBag = 'backgroundColor'
const TEXT_PROPERTY: keyof CSSPropertyBag = 'color'

interface ColorsSectionProps {
  /** Ranked by the panel's own search, so the section can never disagree with it. */
  ranked: readonly RankedAsset<ColorAssetItem>[]
  collapsed: boolean
  onToggle: () => void
}

export function ColorsSection({ ranked, collapsed, onToggle }: ColorsSectionProps) {
  return (
    <AssetSection
      title="Colors"
      count={ranked.length}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {ranked.length === 0 ? (
        <EmptyState
          plain
          compact
          title="No colors"
          description="The built-in design system's palette lives here — try a family name like “coral”."
        />
      ) : (
        <ColorSwatchGrid ranked={ranked} />
      )}
    </AssetSection>
  )
}

function ColorSwatchGrid({ ranked }: { ranked: readonly RankedAsset<ColorAssetItem>[] }) {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)

  // Multi-select has its own inspector path; `commitStyle` writes to
  // `selectedNodeId` alone, so offering it for a multi-selection would apply
  // the colour to one of N layers without saying which.
  const canApply = model.selectedNodeId !== null && !model.isMultiSelect
  const lockedInCode = lockedStyleProperties(model.selectedNode)

  function applyStateFor(property: keyof CSSPropertyBag, what: string): ApplyState | null {
    if (!canApply) return null
    if (lockedInCode.has(property)) {
      return { kind: 'blocked', reason: `This element's ${what} is computed in its own source.` }
    }
    const target = model.writeTargetFor(property)
    if (target.kind === 'none') return { kind: 'blocked', reason: target.reason }
    return { kind: 'ready', target }
  }

  const fillState = applyStateFor(FILL_PROPERTY, 'background')
  const textState = applyStateFor(TEXT_PROPERTY, 'text colour')

  function apply(
    item: ColorAssetItem,
    property: keyof CSSPropertyBag,
    target: WriteTarget,
    label: string,
  ) {
    const reference = colorVarReference(item.token.name)
    commit.commitStyle(property, reference)
    pushToast({
      kind: 'success',
      title: `Applied ${reference}`,
      body: `${label} now reads from ${describeWriteTarget(target)}.`,
    })
  }

  return (
    <>
      {!canApply && (
        <p className={styles.hint}>
          Select one layer to apply a colour to its fill or text. A click copies the variable.
        </p>
      )}
      {groupColorItems(ranked.map((entry) => entry.item)).map(([group, items]) => (
        <Fragment key={group}>
          <AssetGroupLabel>{group}</AssetGroupLabel>
          <div className={styles.grid}>
            {items.map((item) => (
              <ColorSwatch
                key={item.key}
                item={item}
                fillState={fillState}
                textState={textState}
                onApplyFill={(target) => apply(item, FILL_PROPERTY, target, 'Background')}
                onApplyText={(target) => apply(item, TEXT_PROPERTY, target, 'Text colour')}
              />
            ))}
          </div>
        </Fragment>
      ))}
    </>
  )
}

/**
 * Whether a swatch may write one property on the current selection: the target
 * it would write to, or the reason it may not.
 */
type ApplyState = { kind: 'ready'; target: WriteTarget } | { kind: 'blocked'; reason: string }

interface ColorSwatchProps {
  item: ColorAssetItem
  /** `null` when nothing (or more than one thing) is selected — no apply buttons at all. */
  fillState: ApplyState | null
  textState: ApplyState | null
  onApplyFill: (target: WriteTarget) => void
  onApplyText: (target: WriteTarget) => void
}

function ColorSwatch({
  item,
  fillState,
  textState,
  onApplyFill,
  onApplyText,
}: ColorSwatchProps) {
  const { token } = item
  const reference = colorVarReference(token.name)
  const sameInBothThemes = token.light === token.dark

  async function copy() {
    try {
      await navigator.clipboard.writeText(reference)
      pushToast({
        kind: 'success',
        title: `Copied ${reference}`,
        body: sameInBothThemes
          ? `${token.light} in both themes.`
          : `Light ${token.light} · dark ${token.dark}.`,
      })
    } catch (err) {
      console.error('[ColorsSection] copy colour variable failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not copy that variable',
        body: getErrorMessage(err, 'Clipboard access was refused'),
      })
    }
  }

  return (
    <div className={styles.cell}>
      <Button
        variant="ghost"
        className={styles.swatch}
        tooltip={colorTokenTooltip(token)}
        aria-label={`Copy ${reference}`}
        data-color-token={token.name}
        onClick={() => void copy()}
      >
        <span
          className={styles.paint}
          aria-hidden="true"
          style={
            {
              '--swatch-light': token.light,
              '--swatch-dark': token.dark,
            } as CSSProperties
          }
        >
          <span className={styles.paintLight} />
          {!sameInBothThemes && <span className={styles.paintDark} />}
        </span>
        <span className={styles.name}>{token.name}</span>
      </Button>
      {fillState && textState && (
        <span className={styles.actions}>
          <ApplyButton
            label="Fill"
            state={fillState}
            tokenName={token.name}
            what="background"
            onApply={onApplyFill}
          />
          <ApplyButton
            label="Text"
            state={textState}
            tokenName={token.name}
            what="text colour"
            onApply={onApplyText}
          />
        </span>
      )}
    </div>
  )
}

interface ApplyButtonProps {
  label: string
  state: ApplyState
  tokenName: string
  what: string
  onApply: (target: WriteTarget) => void
}

function ApplyButton({ label, state, tokenName, what, onApply }: ApplyButtonProps) {
  const blocked = state.kind === 'blocked'
  return (
    <Button
      variant="secondary"
      size="micro"
      className={styles.action}
      disabled={blocked}
      tooltip={
        state.kind === 'blocked'
          ? state.reason
          : `Set this layer's ${what} to var(${tokenName}) on ${describeWriteTarget(state.target)}`
      }
      aria-label={`Apply ${tokenName} to ${what}`}
      onClick={() => {
        if (state.kind === 'ready') onApply(state.target)
      }}
    >
      {label}
    </Button>
  )
}

/**
 * Names where the commit landed, in the same vocabulary `WriteTargetRow`'s
 * chips use — `.card` for a class, `style=` for the element's own layer — so
 * the toast and the inspector agree about what just happened.
 */
function describeWriteTarget(target: WriteTarget): string {
  if (target.kind === 'class') return target.selector
  if (target.kind === 'inline') return 'this element’s style='
  return 'nothing'
}
