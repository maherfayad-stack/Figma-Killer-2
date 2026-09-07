/**
 * ProjectCard — one project tile on the Overview launcher.
 *
 * The card answers three questions before the project is opened, and offers
 * every verb that acts on it.
 *
 * **What is this project?** `.studio/meta.json` already carried the platform,
 * the cached probe's framework and the trust tier, and `listStudioProjects`
 * read them per entry and threw them away. They render as small badges. The
 * one that earns its place most is the style badge: a Tier-0 project with a
 * Tailwind/Sass/PostCSS toolchain opens *unstyled*, and until now the only
 * place that was ever said was a banner on the board — i.e. after the user had
 * already opened it and started wondering. The card says it first.
 *
 * **When did I last touch it?** "Edited 2 days ago", from the newest mtime
 * under the project's pages dir (`StudioProjectSummary.editedAt`).
 *
 * **Verbs.** Open / Rename / Duplicate / Delete, in a `ContextMenu` reached
 * two ways — the `⋯` button revealed on hover/focus, and a right-click
 * anywhere on the tile (the gesture people already try). Delete used to be a
 * hover-only trash ghost, which made the most destructive verb the single
 * most reachable one; it is now a `danger` row at the bottom of the menu,
 * still behind `DeleteProjectDialog`.
 *
 * Rename is inline, matching the Studio toolbar's `StudioProjectLabel`
 * (`Toolbar.tsx`): the name becomes an `<input>`, Enter/blur commits, Escape
 * reverts. Same gesture in both places for the same field.
 *
 * The tile is a bare `<button>` by design — §8.11 of the button-primitive
 * allowlist covers this file. `Button`'s fixed-height inline-flex row cannot
 * represent a stacked card. Everything hung off it (`⋯`, the menu rows) is a
 * SIBLING, never a child: a button inside a button is invalid HTML that
 * browsers silently un-nest, and the inner control stops being clickable.
 */
import { useRef, useState, type MouseEvent } from 'react'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { Input } from '@ui/components/Input'
import { styleToolchainLabel } from '@site/studio/styleCompileConsent'
import { formatEditedAgo } from './editedAgo'
import type { ProjectFramework, StudioProject } from './hooks/useStudioProjects'
import styles from './ProjectCard.module.css'

/**
 * How each probed framework is named on a card. The probe's own vocabulary
 * (`next-app`, `cra`) is a wire value, not a label — a user reading their own
 * project's tile should see what the ecosystem calls it.
 *
 * `'unknown'` is deliberately absent: the probe ran and recognized nothing,
 * and a badge reading "Unknown" adds a word without adding a fact.
 */
const FRAMEWORK_LABELS: Partial<Record<ProjectFramework, string>> = {
  vite: 'Vite',
  'next-app': 'Next.js App Router',
  'next-pages': 'Next.js Pages',
  cra: 'Create React App',
  remix: 'Remix',
  astro: 'Astro',
}

const PLATFORM_LABELS = { mobile: 'Mobile', web: 'Web' } as const

/**
 * Where the action menu is anchored. Two openings, one menu: the `⋯` button
 * anchors it (auto-flipping beside the trigger), a right-click drops it at the
 * pointer. `ContextMenu` treats `anchorRef` and `x`/`y` as mutually exclusive,
 * so this has to be a discriminated union rather than two loose pieces of
 * state that could both be set.
 */
type MenuPlacement = { kind: 'anchor' } | { kind: 'point'; x: number; y: number }

interface ProjectCardProps {
  project: StudioProject
  /** True while another project action is in flight — every verb is disabled together. */
  busy: boolean
  onOpen: (project: StudioProject) => void
  /** Commits a new display name. Resolves when the server has answered. */
  onRename: (project: StudioProject, name: string) => Promise<void>
  onDuplicate: (project: StudioProject) => void
  onDelete: (project: StudioProject) => void
}

export function ProjectCard({ project, busy, onOpen, onRename, onDuplicate, onDelete }: ProjectCardProps) {
  const [menu, setMenu] = useState<MenuPlacement | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  // Enter blurs the field to commit, so without this latch the blur handler
  // would run the same commit a second time. Same guard, same reason, as
  // `StudioProjectLabel`'s `committingRef`.
  const committingRef = useRef(false)

  const editedAgo = formatEditedAgo(project.editedAt)
  const frameworkLabel = project.framework ? FRAMEWORK_LABELS[project.framework] : undefined
  // Only a Tier-0 project can have a toolchain that has not run. Above Tier 0
  // the compile happens, so saying "not compiled" there would be false.
  const uncompiled = project.trust === 'static' && project.styleToolchains.length > 0
    ? styleToolchainLabel(project.styleToolchains)
    : null

  function startRename() {
    committingRef.current = false
    setDraft(project.name)
  }

  async function commitRename() {
    if (committingRef.current) return
    committingRef.current = true
    const name = draft?.trim() ?? ''
    setDraft(null)
    if (!name || name === project.name) return
    await onRename(project, name)
  }

  function openMenuAtPointer(event: MouseEvent) {
    // Only while the card is a card. During a rename the browser's own
    // text-editing context menu is the useful one.
    if (draft !== null) return
    event.preventDefault()
    setMenu({ kind: 'point', x: event.clientX, y: event.clientY })
  }

  const badges = (
    <span className={styles.badges}>
      {project.platform && <span className={styles.badge}>{PLATFORM_LABELS[project.platform]}</span>}
      {frameworkLabel && <span className={styles.badge}>{frameworkLabel}</span>}
      {uncompiled && (
        <span
          className={styles.badgeWarning}
          title={`This project's ${uncompiled} styles are compiled by its own toolchain, which Studio does not run until you promote the project. It will open unstyled.`}
        >
          {uncompiled} not compiled
        </span>
      )}
    </span>
  )

  const meta = (
    <span className={styles.cardMeta}>
      {project.pageCount} page{project.pageCount === 1 ? '' : 's'}
      {editedAgo && <> · {editedAgo}</>}
    </span>
  )

  return (
    <li className={styles.cell} onContextMenu={openMenuAtPointer}>
      {draft !== null ? (
        // Not a <button> while renaming: an <input> inside a button is invalid
        // HTML, and the whole surface being a click target would swallow the
        // caret placement anyway.
        <div className={styles.card}>
          <span className={styles.cardIcon}>
            <FolderGlyphIcon size={22} aria-hidden="true" />
          </span>
          <Input
            autoFocus
            className={styles.renameInput}
            value={draft}
            aria-label={`Rename ${project.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              else if (event.key === 'Escape') {
                committingRef.current = true
                setDraft(null)
              }
            }}
          />
          {badges}
          {meta}
        </div>
      ) : (
        <button type="button" className={styles.card} onClick={() => onOpen(project)}>
          <span className={styles.cardIcon}>
            <FolderGlyphIcon size={22} aria-hidden="true" />
          </span>
          <span className={styles.cardName}>{project.name}</span>
          {badges}
          {meta}
        </button>
      )}

      {/*
        A SIBLING of the card, never a child — see the module doc. Revealed on
        hover or focus so a grid of projects reads as projects rather than as a
        row of menu buttons; `:focus-within` on the cell is what keeps it
        reachable by keyboard.
      */}
      <Button
        ref={menuButtonRef}
        variant="ghost"
        className={styles.cardMenuButton}
        aria-label={`Actions for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        disabled={busy}
        onClick={() => setMenu((open) => (open ? null : { kind: 'anchor' }))}
      >
        <MoreHorizontalSolidIcon size={12} aria-hidden="true" />
      </Button>

      {menu && (
        <ContextMenu
          ariaLabel={`${project.name} actions`}
          onClose={() => setMenu(null)}
          animateExit={menu.kind === 'point'}
          {...(menu.kind === 'anchor'
            ? { anchorRef: menuButtonRef, align: 'end' as const }
            : { x: menu.x, y: menu.y })}
        >
          <ContextMenuItem
            onClick={() => {
              setMenu(null)
              onOpen(project)
            }}
          >
            <ExternalLinkSolidIcon size={12} aria-hidden="true" /> Open
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              setMenu(null)
              startRename()
            }}
          >
            <EditSolidIcon size={12} aria-hidden="true" /> Rename
          </ContextMenuItem>
          <ContextMenuItem
            disabled={busy}
            onClick={() => {
              setMenu(null)
              onDuplicate(project)
            }}
          >
            <CopySolidIcon size={12} aria-hidden="true" /> Duplicate
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            danger
            disabled={busy}
            onClick={() => {
              setMenu(null)
              onDelete(project)
            }}
          >
            <TrashSolidIcon size={12} aria-hidden="true" /> Delete
          </ContextMenuItem>
        </ContextMenu>
      )}
    </li>
  )
}
