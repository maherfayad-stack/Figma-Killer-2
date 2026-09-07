/**
 * InspectorPopover — an anchored, portalled, dismissible PANEL (not a menu).
 *
 * `ContextMenu` already solved portalled/anchored/dismissible positioning,
 * but it is a menu: roving-focus `menuitem` children, one gesture, then it
 * closes. Laws 2 and 4 of `docs/features/inspector-disclosure.md` need a
 * floating surface that holds arbitrary controls and stays open while the
 * user works inside it — a ⚙ *settings popover* (F5, F8, F17, F21, F25-27),
 * not a dropdown. This is that primitive. It shares `useAnchoredFloating`
 * with `ContextMenu` rather than forking the positioning maths.
 *
 * ACCESSIBILITY
 * -------------
 * `role="dialog"`, labelled by `title`. Focus moves onto the first focusable
 * element inside on open, is trapped (Tab/Shift+Tab cycle within the panel)
 * while open, and is restored to the trigger (`anchorRef`) on close. `Esc`
 * and an outside pointer-down both close it, exactly like `ContextMenu`'s
 * `useOutsidePointerDismiss` — the trigger element is excluded so clicking
 * the ⚙ again toggles rather than closing-then-reopening.
 *
 * `data-field-skin="inspector"`
 * ------------------------------
 * The Properties panel sets this attribute on its root `<aside>`; every
 * primitive inside inherits the compact inspector skin (pill → chip inputs,
 * tighter segmented controls, …) from the CSS cascade. A popover portals to
 * `document.body`, OUTSIDE that subtree, so without setting the attribute
 * again here every control inside would silently render the wrong (admin
 * pill) shape. Set on the popover root — do not remove this.
 *
 * NESTED POPOVERS (F14: a colour picker opening from inside a Fill row that
 * may itself be inside a popover)
 * ------------------------------------------------------------------------
 * A nested popover's floating panel portals to `document.body` too, so it is
 * a DOM *sibling* of its logical parent's panel, not a descendant — the
 * parent's outside-pointer-dismiss would otherwise see a click inside the
 * child as "outside" and close itself. `InspectorPopoverNestingContext`
 * tracks the REACT-tree nesting (which is real — the child's trigger button
 * is rendered inside the parent's own children) instead of DOM containment:
 * each popover registers its own root element with the nearest ancestor
 * popover, if any, and folds every registered child into its own dismiss
 * `ignore` list.
 *
 * STICKY VIEW STATE
 * ------------------
 * `id` is a stable identity for the *trigger*, not the current selection —
 * reopening the same ⚙ on a different node/class restores whichever `tabs`
 * entry was last active for that id. This is a plain module-level `Map`,
 * not `useEditorPreference`: that hook's catalog is a fixed, hand-enumerated
 * union of preference ids (see `src/admin/pages/site/preferences/catalog.ts`)
 * meant for a handful of named user settings, not an open-ended id minted
 * per popover trigger — and `src/ui/` primitives (portable to plugins, see
 * `Tabs.tsx`'s doc comment) must not depend on `src/admin`'s site-editor
 * preference store. A tab choice resetting on a full page reload is an
 * acceptable trade for that isolation.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { Tabs, TabList, Tab, TabPanel } from '@ui/components/Tabs'
import { cn } from '@ui/cn'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import {
  type FloatingAlign,
  type FloatingSide,
  type ResolvedFloatingSide,
} from '@ui/lib/floatingPosition'
import { fitFloatingToViewport } from '@ui/lib/floatingViewportFit'
import { useAnchoredFloating } from '@ui/lib/useAnchoredFloating'
import { useOutsidePointerDismiss } from '@ui/lib/useOutsidePointerDismiss'
import { useEvent } from '@ui/lib/useEvent'
import styles from './InspectorPopover.module.css'

/** Preferred side, then the remaining sides in a sensible fallback order. */
const ALL_SIDES: ReadonlyArray<ResolvedFloatingSide> = ['left', 'right', 'bottom', 'top']

/**
 * Gap kept between the popover and every viewport edge, px. Deliberately
 * wider than `computeFloatingPosition`'s own 8px `viewportMargin`: the side
 * pass only needs the panel technically on-screen, whereas this is the
 * *visual* breathing room a settings panel needs so its last row never reads
 * as clipped against the bottom of the display.
 */
const VIEWPORT_MARGIN = 12

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

/**
 * Focuses whatever `anchorRef` currently points at (or `fallback`), reading
 * `.current` at CALL time rather than at effect-setup time. Deliberately a
 * plain top-level function, not a closure inlined in the effect below: the
 * intent here is late binding — the trigger element `Button` swaps its DOM
 * node when the popover closes (see the close-cleanup doc comment) — and a
 * function boundary keeps the static "ref accessed in effect cleanup" lint
 * heuristic from flagging what is, here, the correct behaviour.
 */
function focusAnchorOrFallback(
  anchorRef: RefObject<HTMLElement | null>,
  fallback: HTMLElement | null,
): void {
  const target = anchorRef.current ?? fallback
  target?.focus()
}

// ---------------------------------------------------------------------------
// Sticky per-id view state — see the "STICKY VIEW STATE" doc above.
// ---------------------------------------------------------------------------

const stickyTabByPopoverId = new Map<string, string>()

function initialTabFor(
  id: string,
  tabs: ReadonlyArray<InspectorPopoverTab>,
  defaultTab: string | undefined,
): string {
  const remembered = stickyTabByPopoverId.get(id)
  if (remembered != null && tabs.some((tab) => tab.value === remembered)) return remembered
  if (defaultTab != null && tabs.some((tab) => tab.value === defaultTab)) return defaultTab
  return tabs[0]?.value ?? ''
}

// ---------------------------------------------------------------------------
// Viewport measurement — see the viewport-fit block inside the component.
// ---------------------------------------------------------------------------

interface PopoverMetrics {
  /** Laid-out height of the popover root, px (`offsetHeight`). */
  height: number
  viewportWidth: number
  viewportHeight: number
}

function samePopoverMetrics(a: PopoverMetrics, b: PopoverMetrics): boolean {
  return (
    a.height === b.height &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight
  )
}

// ---------------------------------------------------------------------------
// Nested-popover registration — see the "NESTED POPOVERS" doc above.
// ---------------------------------------------------------------------------

type RegisterChild = (element: HTMLElement) => () => void

const InspectorPopoverNestingContext = createContext<RegisterChild | null>(null)

export interface InspectorPopoverTab {
  value: string
  label: string
  content: ReactNode
}

export interface InspectorPopoverProps {
  /**
   * Stable identity for the trigger that opens this popover — used to key
   * sticky internal view state (currently: last-active tab). Not the same
   * thing as `anchorRef`; `id` is a semantic key ("layout-settings",
   * `fill-row-${entryId}`), stable across reopen/re-selection, while
   * `anchorRef` can point at a fresh DOM node every render.
   */
  id: string
  /**
   * Element the popover is anchored to. Also the element focus returns to
   * when the popover closes, and the element excluded from outside-pointer
   * dismiss so clicking the trigger again toggles rather than closing and
   * immediately reopening.
   */
  anchorRef: RefObject<HTMLElement | null>
  /** Called on Esc, outside-pointer dismiss, and the header's close button. */
  onClose: () => void
  /** Header title. Also becomes the dialog's `aria-label`. */
  title: string
  /** Rendered width in px. Default 248 — Figma's 240-260px popover band. */
  width?: number
  /**
   * Preferred side. Always auto-flips at the viewport edge (trying the
   * remaining sides in a fixed fallback order) — there is no non-flipping
   * mode. Default `'left'`: Figma opens every settings/colour popover
   * leftward off the inspector so it never covers the field being edited
   * (F14, F17, F21, F25).
   */
  side?: Exclude<FloatingSide, 'auto'>
  /** Cross-axis alignment relative to the anchor. Default `'start'`. */
  align?: FloatingAlign
  /** Gap between the anchor and the popover, px. Default 8. */
  offset?: number
  /**
   * Optional tab strip (F17's Basic/Dynamic/Brush, F25-27's
   * Basics/Details/Variable). When provided, the tab panels own the content
   * area and `children` is ignored. The active tab is sticky per `id`.
   */
  tabs?: ReadonlyArray<InspectorPopoverTab>
  /** Tab selected the first time this `id` is opened. Defaults to `tabs[0]`. */
  defaultTab?: string
  /** Non-tabbed content. Ignored when `tabs` is provided. */
  children?: ReactNode
  className?: string
  /** z-index override. Defaults to the same layer as `ContextMenu` (`--menu-z-index`). */
  zIndex?: number
}

export function InspectorPopover({
  id,
  anchorRef,
  onClose,
  title,
  width = 248,
  side = 'left',
  align = 'start',
  offset = 8,
  tabs,
  defaultTab,
  children,
  className,
  zIndex,
}: InspectorPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const [activeTab, setActiveTab] = useState<string>(() =>
    tabs != null ? initialTabFor(id, tabs, defaultTab) : '',
  )

  function handleTabChange(next: string) {
    setActiveTab(next)
    stickyTabByPopoverId.set(id, next)
  }

  // Prefer the requested side; fall back through the remaining sides in a
  // fixed order rather than never flipping — a popover pinned to `left` on a
  // narrow viewport would otherwise render off-screen.
  const autoPriority = side === 'left'
    ? ALL_SIDES
    : [side, ...ALL_SIDES.filter((candidate) => candidate !== side)]

  const { position, effectiveWidth } = useAnchoredFloating({
    anchorRef,
    floatingRef: popoverRef,
    side: 'auto',
    align,
    offset,
    autoPriority,
    width,
    minWidth: width,
  })
  const measuring = position === null

  // ── Viewport fit ──────────────────────────────────────────────
  // `useAnchoredFloating` picks the side and clamps against the popover's
  // *measured* height, which cannot help a panel taller than the viewport —
  // it just pins the top and lets the tail run off the bottom of the screen.
  // Measure the laid-out height ourselves and hand it to
  // `fitFloatingToViewport`, which returns both the clamped origin and the
  // `max-height` ceiling that makes the panel fit; `.body` scrolls the rest.
  //
  // `offsetHeight`, not `getBoundingClientRect().height`: the latter includes
  // the enter animation's `scale(0.97)` and reports ~3% short, which would
  // place the panel ~3% too low and clip exactly the last row.
  const [metrics, setMetrics] = useState<PopoverMetrics>(() => ({
    height: 0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }))

  const measure = useEvent(() => {
    const element = popoverRef.current
    if (!element) return
    const next: PopoverMetrics = {
      height: element.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }
    // Bail on an unchanged measurement: the ResizeObserver below fires for
    // every content change inside the panel, and a fresh object each time
    // would re-render the whole popover on every keystroke in it.
    setMetrics((prev) => (samePopoverMetrics(prev, next) ? prev : next))
  })

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useLayoutEffect(() => {
    const element = popoverRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => measure())
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

  // The panel is `position: fixed`, so a window resize (and a scroll that
  // moves the anchor) changes which part of the viewport it has to fit into.
  useEffect(() => {
    function onViewportChange() {
      measure()
    }
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [measure])

  const fit = fitFloatingToViewport({
    x: position?.x ?? 0,
    y: position?.y ?? 0,
    width: effectiveWidth,
    height: metrics.height,
    viewportWidth: metrics.viewportWidth,
    viewportHeight: metrics.viewportHeight,
    margin: VIEWPORT_MARGIN,
  })

  // ── Nested popovers ─────────────────────────────────────────────────────
  const registerWithParent = useContext(InspectorPopoverNestingContext)
  const [childRoots, setChildRoots] = useState<readonly HTMLElement[]>([])

  // Stable identity required: this is handed to children through context and
  // read inside THEIR effect dependency arrays, so it must not change every
  // render or every descendant popover would re-register in a loop.
  const registerChild = useEvent<[HTMLElement], () => void>((element) => {
    setChildRoots((prev) => [...prev, element])
    return () => setChildRoots((prev) => prev.filter((entry) => entry !== element))
  })

  useEffect(() => {
    const element = popoverRef.current
    if (!registerWithParent || !element) return undefined
    return registerWithParent(element)
  }, [registerWithParent])

  // ── Focus: move in on open, trap while open, restore to the trigger on close ──
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const raf = requestAnimationFrame(() => {
      const container = popoverRef.current
      const body = bodyRef.current
      if (!container) return
      // Prefer the first control the user actually came here to edit over
      // the header's close button — the close button is still first in the
      // Tab loop, just not where autofocus lands.
      const first = (body && getFocusable(body)[0]) ?? getFocusable(container)[0]
      ;(first ?? container).focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      // Deferred one more frame, deliberately: the trigger for a real ⚙
      // popover is almost always a `Button` with `aria-expanded` — closing
      // flips that to `false` in the same commit that unmounts this
      // popover, which re-enables `Button`'s `Tooltip` wrapper
      // (`Tooltip.tsx`: `if (disabled) return children` vs mounting
      // `TooltipInner` — a different element TYPE at the same tree
      // position). React tears down the old `<button>` and mounts a fresh
      // one in that same commit, so a `.focus()` call made synchronously
      // here — inside this cleanup — can target a node mid-swap and
      // silently land focus on `<body>` instead of the trigger. Re-reading
      // `anchorRef.current` one frame later — deliberately fresh, not the
      // value at cleanup time — targets whatever settled.
      requestAnimationFrame(() => focusAnchorOrFallback(anchorRef, previouslyFocused))
    }
  }, [anchorRef])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const container = popoverRef.current
    if (!container) return
    const focusable = getFocusable(container)
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault()
        last.focus()
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault()
      first.focus()
    }
  }

  useOutsidePointerDismiss({
    onDismiss: onClose,
    ignore: [popoverRef, anchorRef, ...childRoots.map((element) => ({ current: element }))],
  })

  const style = {
    '--inspector-popover-x': `${fit.x}px`,
    '--inspector-popover-y': `${fit.y}px`,
    '--inspector-popover-width': `${effectiveWidth}px`,
    '--inspector-popover-max-height': `${fit.maxHeight}px`,
    ...(zIndex != null ? { '--inspector-popover-z-index': zIndex } : null),
    ...(measuring ? { visibility: 'hidden' as const } : null),
  } as CSSProperties

  const body = tabs != null ? (
    <Tabs value={activeTab} onChange={handleTabChange}>
      <TabList ariaLabel={`${title} sections`}>
        {tabs.map((tab) => (
          <Tab key={tab.value} value={tab.value}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
      {tabs.map((tab) => (
        <TabPanel key={tab.value} value={tab.value}>
          {tab.content}
        </TabPanel>
      ))}
    </Tabs>
  ) : children

  return createPortal(
    <InspectorPopoverNestingContext.Provider value={registerChild}>
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={title}
        data-field-skin="inspector"
        data-open={!measuring ? '' : undefined}
        tabIndex={-1}
        className={cn(styles.popover, className)}
        style={style}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <CloseIcon size={14} aria-hidden="true" />
          </Button>
        </header>
        <div ref={bodyRef} className={styles.body}>{body}</div>
      </div>
    </InspectorPopoverNestingContext.Provider>,
    document.body,
  )
}
