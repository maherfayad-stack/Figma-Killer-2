/**
 * AssetSection — one collapsible band of the Assets panel: a header row that
 * names the section and counts what is in it, and a responsive card grid.
 *
 * Collapse state is the panel's, not the section's — a section that owned it
 * would forget every time a search re-rendered the list.
 */
import type { ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { cn } from '@ui/cn'
import styles from './AssetsPanel.module.css'

interface AssetSectionProps {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  /** Rendered between the header and the grid — e.g. the package-bundle notice. */
  notice?: ReactNode
  children: ReactNode
}

export function AssetSection({
  title,
  count,
  collapsed,
  onToggle,
  notice,
  children,
}: AssetSectionProps) {
  return (
    <section className={styles.section}>
      <Button
        variant="ghost"
        size="xs"
        align="between"
        className={styles.sectionHeader}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className={styles.sectionTitle}>
          <span className={styles.sectionChevron} aria-hidden="true">
            {collapsed ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
          </span>
          {title}
        </span>
        <span className={styles.sectionCount}>{count}</span>
      </Button>
      {notice}
      {!collapsed && <div className={styles.sectionBody}>{children}</div>}
    </section>
  )
}

/** A sub-heading inside a section — the design system's purpose groups. */
export function AssetGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className={cn(styles.groupLabel)} role="presentation">
      {children}
    </div>
  )
}

/** The responsive card grid every section lays its cards out in. */
export function AssetGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>
}
