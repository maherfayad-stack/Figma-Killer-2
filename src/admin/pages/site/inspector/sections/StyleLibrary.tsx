/**
 * StyleLibrary - CT-5's two inspector pieces, shared by the Text and Effects
 * sections:
 *
 *   - `StyleLibraryButton` - the section header's styles button. Its menu lists
 *     the project's styles of the family (the click applies one), then "Create
 *     style from selection..." (a name popover) and, while one is applied,
 *     "Detach style".
 *   - `AppliedStyleRow` - the applied style as a chip at the top of the section
 *     body, with the detach button beside it.
 *
 * Both are plain views over `useStyleLibrary`; every write goes through
 * `textStylePlan.ts` and one structural commit, so each click is one undo step.
 * A menu item that cannot act says why in its tooltip (the layer has nothing to
 * save as a style) rather than doing nothing.
 */
import { useRef, useState, type FormEvent, type RefObject } from 'react'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { Input } from '@ui/components/Input'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { summarizeStyle, type StyleFamily } from '../../studio/textStyleDiscovery'
import { styleClassName } from '../../studio/textStylePlan'
import type { StyleLibrary } from './useStyleLibrary'
import styles from './StyleLibrary.module.css'

const COPY: Record<StyleFamily, { noun: string; plural: string; create: string; empty: string }> = {
  text: {
    noun: 'Text style',
    plural: 'Text styles',
    create: 'Create text style from selection...',
    empty: 'No text styles in this project yet. A class that sets a font, size and line height shows up here.',
  },
  effect: {
    noun: 'Effect style',
    plural: 'Effect styles',
    create: 'Create effect style from selection...',
    empty: 'No effect styles in this project yet. A class that is only a shadow or a blur shows up here.',
  },
}

export function StyleLibraryButton({ library }: { library: StyleLibrary | null }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  if (!library) return null
  const copy = COPY[library.family]
  const list = library.styles[library.family]
  const { applied } = library

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        pressed={applied !== null}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={copy.plural}
        tooltip={applied ? `${copy.noun}: ${applied.label}` : copy.plural}
        data-testid={`${library.family}-styles-trigger`}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <ColorsSwatchSolidIcon size={12} aria-hidden="true" />
      </Button>
      {menuOpen && (
        <ContextMenu
          ariaLabel={copy.plural}
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          offset={6}
          maxHeight={320}
          minWidth={200}
          onClose={() => setMenuOpen(false)}
        >
          {list.length === 0 && <p className={styles.menuEmpty}>{copy.empty}</p>}
          {list.map((style) => (
            <ContextMenuItem
              key={style.ruleId}
              selected={applied?.ruleId === style.ruleId}
              data-testid={`style-option-${style.label}`}
              onClick={() => {
                setMenuOpen(false)
                if (applied?.ruleId !== style.ruleId) library.apply(style)
              }}
            >
              <span className={styles.menuItemBody}>
                <span>{style.label}</span>
                <span className={styles.menuItemSummary}>{summarizeStyle(style)}</span>
              </span>
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={library.createBlocker !== null}
            tooltip={library.createBlocker ?? undefined}
            data-testid={`${library.family}-style-create`}
            onClick={() => {
              setMenuOpen(false)
              setNaming(true)
            }}
          >
            {copy.create}
          </ContextMenuItem>
          {applied && (
            <ContextMenuItem
              data-testid={`${library.family}-style-detach`}
              onClick={() => {
                setMenuOpen(false)
                library.detach(applied)
              }}
            >
              Detach style
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}
      {naming && <StyleNamePopover library={library} anchorRef={triggerRef} onClose={() => setNaming(false)} />}
    </>
  )
}

function StyleNamePopover({
  library,
  anchorRef,
  onClose,
}: {
  library: StyleLibrary
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const copy = COPY[library.family]
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const className = styleClassName(library.family, name)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    const problem = await library.create(name)
    setBusy(false)
    if (problem === null) onClose()
    else setError(problem)
  }

  return (
    <InspectorPopover
      id={`${library.family}-style-name`}
      anchorRef={anchorRef}
      onClose={onClose}
      title={`New ${copy.noun.toLowerCase()}`}
      width={240}
    >
      <form className={styles.nameForm} onSubmit={submit}>
        <Input
          aria-label={`${copy.noun} name`}
          data-testid={`${library.family}-style-name`}
          placeholder="Heading 1"
          value={name}
          invalid={error !== null}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
        />
        {error ? (
          <p className={styles.nameError} role="alert">
            {error}
          </p>
        ) : (
          <p className={styles.nameHint}>
            {className ? `Saved as .${className} in your stylesheet.` : 'The name becomes the class.'}
          </p>
        )}
        <div className={styles.nameActions}>
          <Button variant="ghost" size="xs" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="xs"
            type="submit"
            disabled={className === null || busy}
            data-testid={`${library.family}-style-name-submit`}
          >
            Create
          </Button>
        </div>
      </form>
    </InspectorPopover>
  )
}

export function AppliedStyleRow({ library }: { library: StyleLibrary | null }) {
  if (!library?.applied) return null
  const { applied } = library
  return (
    <div className={styles.appliedRow} data-testid={`${library.family}-style-applied`}>
      <span className={styles.appliedChip}>
        <span className={styles.appliedName}>{applied.label}</span>
        <span className={styles.appliedSummary}>{summarizeStyle(applied)}</span>
      </span>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Detach style"
        tooltip="Detach style - keep its values on this layer"
        data-testid={`${library.family}-style-detach-chip`}
        onClick={() => library.detach(applied)}
      >
        <CloseIcon size={12} aria-hidden="true" />
      </Button>
    </div>
  )
}
