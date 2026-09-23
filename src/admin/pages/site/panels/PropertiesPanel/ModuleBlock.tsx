/**
 * ModuleBlock — the Module section of the Design tab: a module's own prop
 * rows under its name (P2 rule 2, "everything is at rest" — a fixed block,
 * not an accordion).
 *
 * The header and body used to be markup inside `StyleSurface.tsx`, which is
 * why `StyleSurface`'s own doc listed "the Module section" among the things
 * that file still owns. It owns the section MOUNT; the module's presentation
 * belongs with the module's content, which is built one file over in
 * `renderModuleTabContent.tsx`.
 *
 * ## The Law-3 fold (panel-41)
 *
 * `docs/features/inspector.md` §1 Law 3: optional fields are *added*, never
 * pre-drawn. This block broke it — it walked a module's whole `schema` and
 * drew a control per key whether or not the user's source set it. On a
 * Studio-imported `<img>` that is three select rows (`loading`,
 * `fetchPriority`, `decoding`) — 112px of defaults for attributes the JSX
 * never wrote, on the fixture whose Design tab was already over budget.
 *
 * So the rows are partitioned (`renderModuleTabContent`): a prop the source
 * sets — or that carries a breakpoint override the user made — is resident,
 * and the rest sit behind ONE disclosure. The disclosure is the header's
 * trailing button, not a row of its own, because a row costs exactly what it
 * hides: `N` folded rows behind an `N+1`th row saves `N-1` rows; behind the
 * header it saves `N`. It is a fold, not a deletion — one click mounts every
 * row with the same `property-control-<key>` test ids and the same
 * `ParamPromotableRow` wiring the Visual-Component param surface drives.
 *
 * ## A real boundary (P2-F, UX-1)
 *
 * The props block is the selected element's own identity, and it used to be
 * drawn as the WEAKEST header in the panel — a ~10px uppercase subtle label
 * with 4px of padding — and to end 8px above the headerless Layer row with no
 * line and no title between them. So a prop row sat exactly as far from its
 * sibling prop as from the unrelated opacity row below it, which is the
 * "cramped, not segregated" feel the owner named.
 *
 * Now the block is bounded on both sides by the panel's own vocabulary: its
 * title is `SectionStaticHeader` — the same 32px, bold, full-contrast recipe
 * as every section title below it — its rows sit the within-group 4px apart,
 * its body ends in 8px of padding, and the block closes on a hairline. Props
 * → [8px] → hairline → [section gap] → Layer.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AnyModuleDefinition } from '@core/module-engine'
import { Button } from '@ui/components/Button'
import { SectionStaticHeader } from '@ui/components/Section'
import { cn } from '@ui/cn'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import sectionStyles from '@ui/components/Section/Section.module.css'
import styles from './ModuleBlock.module.css'

interface ModuleBlockProps {
  definition: AnyModuleDefinition
  /** Rows the user's source actually sets. */
  resident: ReactNode
  /** Rows for props the source leaves unset — behind the header disclosure. */
  folded: ReactNode
  foldedCount: number
}

export function ModuleBlock({ definition, resident, folded, foldedCount }: ModuleBlockProps) {
  const [showFolded, setShowFolded] = useState(false)

  const foldToggle =
    foldedCount > 0 ? (
      <Button
        variant="ghost"
        size="micro"
        className={styles.foldToggle}
        aria-expanded={showFolded}
        tooltip={
          showFolded
            ? 'Hide the properties this element does not set'
            : 'Show the properties this element does not set'
        }
        onClick={() => setShowFolded((open) => !open)}
        data-testid="module-more-properties-toggle"
      >
        <span className={cn(styles.chevron, showFolded && styles.chevronOpen)}>
          <ChevronRightIcon size={11} aria-hidden="true" />
        </span>
        {`${foldedCount} more`}
      </Button>
    ) : undefined

  return (
    <div className={styles.block}>
      <SectionStaticHeader title={definition.name} icon={definition.icon} actions={foldToggle} />
      <div className={cn(sectionStyles.sectionBody, styles.body)} data-testid="module-properties">
        {resident}
        {showFolded && folded}
      </div>
    </div>
  )
}
