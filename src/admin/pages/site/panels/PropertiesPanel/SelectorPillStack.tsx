/**
 * SelectorPillStack — the element's selectors, as interactive chips, and the
 * panel's ONE statement of where a style edit lands (`panel-41`).
 *
 * Split out of `ClassPickerParts.tsx` when the write-target facts landed on
 * the pills and pushed that file past the 700-line module ceiling: the pills
 * are a distinct responsibility from the input row and the suggestions
 * portal that share the file with them.
 *
 * ## Why the write-target facts live here
 *
 * They used to be a SECOND row — `WriteTargetRow`, drawn 40px below this
 * stack inside the Design tab's scroll container, listing the same `.card`
 * `.primary` `style=` chips again, read-only, purely to say which of them is
 * locked and which one a brand-new property lands in. Two surfaces stating
 * one fact about one element is the panel's own copy of the write-target
 * ambiguity `STUDIO-IMPORT-V2-PLAN.md` WS-6.2 exists to fix, so the facts
 * moved onto the interactive chips that were already there.
 */
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { cn } from '@ui/cn'
import { TagPill } from '@ui/components/TagPill'
import { Tooltip } from '@ui/components/Tooltip'
import { styleRuleDisplaySelector, type StyleRule } from '@core/page-tree'
import type { SelectorPillItem } from './selectorPickerModel'
import styles from './ClassPicker.module.css'

/**
 * The write-target facts a pill carries.
 *
 * `lockReason` non-null → this target cannot be written; the pill is struck
 * through and says why on hover, exactly as the old row did. `isDefault`
 * marks the one chip `resolveWriteTarget` reaches for when a property has no
 * declaration anywhere yet.
 */
export interface SelectorPillTargetInfo {
  lockReason: string | null
  isDefault: boolean
}

const NO_TARGET_INFO: SelectorPillTargetInfo = { lockReason: null, isDefault: false }

/**
 * The write-target wrapper around one pill: the tooltip, the struck-through
 * locked state, and the queryable `data-locked` / `data-default` attributes
 * `WriteTargetRow` used to own. Kept as a wrapper rather than pushed into
 * `TagPill` because none of it is a tag-pill concern — it is this panel's
 * "where does my edit land" story.
 */
function WriteTargetSlot({
  targetKey,
  info,
  defaultHint,
  children,
}: {
  targetKey: string
  info: SelectorPillTargetInfo
  /** What this target means when it is NOT locked. */
  defaultHint: string
  children: ReactNode
}) {
  return (
    <Tooltip content={info.lockReason ?? defaultHint}>
      <span
        className={cn(styles.pillSlot, info.lockReason != null && styles.pillSlotLocked)}
        data-testid={`write-target-chip-${targetKey}`}
        data-locked={info.lockReason != null ? 'true' : 'false'}
        data-default={info.isDefault ? 'true' : 'false'}
      >
        {children}
      </span>
    </Tooltip>
  )
}

interface AssignedClassPillProps {
  cls: StyleRule
  isActive: boolean
  target: SelectorPillTargetInfo
  onToggle: () => void
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onKeyboardContextMenu: (event: KeyboardEvent<HTMLElement>) => void
  onRemove: () => void
}

function AssignedClassPill({
  cls,
  isActive,
  target,
  onToggle,
  onContextMenu,
  onKeyboardContextMenu,
  onRemove,
}: AssignedClassPillProps) {
  const selectorLabel = styleRuleDisplaySelector(cls)
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
      return
    }
    onKeyboardContextMenu(e)
  }

  return (
    <WriteTargetSlot
      targetKey={cls.id}
      info={target}
      defaultHint={`Declarations already here, or new ones by default, save to ${selectorLabel}.`}
    >
      <TagPill
        label={selectorLabel}
        active={isActive}
        leading={target.isDefault ? <span className={styles.defaultTargetDot} /> : undefined}
        onClick={onToggle}
        onMainKeyDown={handleKeyDown}
        onContextMenu={onContextMenu}
        onRemove={onRemove}
        mainAriaLabel={`${isActive ? 'Deselect' : 'Edit'} class ${selectorLabel}`}
        removeAriaLabel={`Remove class ${selectorLabel}`}
        removeTooltip="Remove from this element"
        mainTestId={`class-chip-${cls.name}`}
        removeTestId={`class-chip-remove-${cls.name}`}
      />
    </WriteTargetSlot>
  )
}

function AmbientSelectorPill({
  pill,
  onToggle,
}: {
  pill: SelectorPillItem
  onToggle: () => void
}) {
  const selectorLabel = styleRuleDisplaySelector(pill.rule)
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <TagPill
      label={selectorLabel}
      active={pill.active}
      onClick={onToggle}
      onMainKeyDown={handleKeyDown}
      mainAriaLabel={`${pill.active ? 'Deselect' : 'Edit'} selector ${selectorLabel}`}
      mainTestId={`selector-chip-${pill.rule.id}`}
    />
  )
}

function InlineStylePill({
  isActive,
  target,
  clearable,
  onToggle,
  onRemove,
}: {
  isActive: boolean
  target: SelectorPillTargetInfo
  /** There are inline styles to clear — otherwise the `×` would clear nothing. */
  clearable: boolean
  onToggle: () => void
  onRemove: () => void
}) {
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <WriteTargetSlot
      targetKey="inline"
      info={target}
      defaultHint="A property with no writable class saves here, on this one element."
    >
      <TagPill
        label="Inline"
        active={isActive}
        muted
        leading={target.isDefault ? <span className={styles.defaultTargetDot} /> : undefined}
        onClick={onToggle}
        onMainKeyDown={handleKeyDown}
        onRemove={clearable ? onRemove : undefined}
        mainAriaLabel={`${isActive ? 'Stop editing' : 'Edit'} inline styles`}
        removeAriaLabel="Clear inline styles"
        removeTooltip="Clear inline styles"
        mainTestId="inline-style-pill"
        removeTestId="inline-style-pill-remove"
      />
    </WriteTargetSlot>
  )
}

interface SelectorPillStackProps {
  pills: readonly SelectorPillItem[]
  /** The node carries inline styles, or the user is editing them. */
  showInlinePill: boolean
  /** `style=""` is a reachable write target at all — the inline chip shows either way. */
  inlineReachable: boolean
  inlineStyleEditing: boolean
  /** Per-target write facts, keyed by rule id (`'inline'` for the inline chip). */
  targetInfo: Readonly<Record<string, SelectorPillTargetInfo>>
  onToggleRule: (ruleId: string, active: boolean) => void
  onClassContextMenu: (classId: string, event: MouseEvent<HTMLElement>) => void
  onKeyboardClassContextMenu: (classId: string, event: KeyboardEvent<HTMLElement>) => void
  onRemoveClass: (classId: string) => void
  onToggleInline: () => void
  onClearInline: () => void
}

export function SelectorPillStack({
  pills,
  showInlinePill,
  inlineReachable,
  inlineStyleEditing,
  targetInfo,
  onToggleRule,
  onClassContextMenu,
  onKeyboardClassContextMenu,
  onRemoveClass,
  onToggleInline,
  onClearInline,
}: SelectorPillStackProps) {
  const renderInline = showInlinePill || inlineReachable
  if (pills.length === 0 && !renderInline) return null

  return (
    <>
      {pills.map((pill) => (
        pill.rule.kind === 'ambient'
          ? (
              <AmbientSelectorPill
                key={pill.rule.id}
                pill={pill}
                onToggle={() => onToggleRule(pill.rule.id, pill.active)}
              />
            )
          : (
              <AssignedClassPill
                key={pill.rule.id}
                cls={pill.rule}
                isActive={pill.active}
                target={targetInfo[pill.rule.id] ?? NO_TARGET_INFO}
                onToggle={() => onToggleRule(pill.rule.id, pill.active)}
                onContextMenu={(e) => onClassContextMenu(pill.rule.id, e)}
                onKeyboardContextMenu={(e) => onKeyboardClassContextMenu(pill.rule.id, e)}
                onRemove={() => onRemoveClass(pill.rule.id)}
              />
            )
      ))}
      {renderInline && (
        <InlineStylePill
          isActive={inlineStyleEditing}
          target={targetInfo.inline ?? NO_TARGET_INFO}
          clearable={showInlinePill}
          onToggle={onToggleInline}
          onRemove={onClearInline}
        />
      )}
    </>
  )
}
