/**
 * AnimationsSection — W5-5's inspector surface for CSS motion.
 *
 * The write path for all of this already existed: `setDeclaration` /
 * `removeDeclaration` for timing properties, `insertRule` and (now)
 * `insertKeyframes` for a brand-new `@keyframes`, and
 * `CanvasAnimationInjector` for freezing what is on screen. What did not exist
 * was any way to SEE an animation, so a project full of motion read as a
 * still with no explanation. This section is that surface.
 *
 * Shaped after `EffectsSection.tsx` deliberately, because the problem is the
 * same one: a comma-separated CSS value that is really a LIST of things, each
 * of which wants its own row and its own small editor. Two exports, the same
 * two:
 *
 *   - `AnimationsSectionActions` — the header's "+" menu (Animation /
 *     Transition), mounted by `StyleSectionsEditor` in BOTH the collapsed-empty
 *     header and the open one, because at the Law-1 rest state it is the only
 *     way to add the first animation.
 *   - `AnimationsSection` — the body: one `PropertyList` whose rows are the
 *     rule's animations then its transitions, followed by the scrub.
 *
 * ## Law 1, and why this section in particular must obey it
 *
 * An element with no motion costs one header line. That is the disclosure
 * plan's rule for every `collapsedWhenEmpty` section, but it matters more here
 * than anywhere else: resolving an animation means indexing every `@keyframes`
 * rule in the registry, and the overwhelming majority of elements have no
 * animation at all. `StyleSectionsEditor`'s Law-1 machinery does not mount
 * this component when nothing in the section is set, so that work never runs
 * for them.
 *
 * ## What this refuses, and says so
 *
 *   - **JS animation** (framer-motion, GSAP, a rAF loop). Not listed and not
 *     editable — there is no declaration to write. This is the same freeze gap
 *     `CanvasAnimationInjector` documents under "What this cannot freeze", and
 *     it is a different fix in a different layer, not something to fake with a
 *     row that pretends to control it.
 *   - **A transition's property list.** Timing is editable; deciding that
 *     `.card` should transition `transform` as well as `opacity` is not — see
 *     `transitionValue.ts`.
 *   - **Scroll-driven animation** (`animation-timeline`). Out of scope for
 *     this pass; a rule that uses it keeps its declarations untouched and
 *     shows its `animation` value as a raw row rather than a structured one it
 *     would be lying about.
 *   - **A value this module cannot parse** — the whole declaration becomes one
 *     raw text row with the reason, never a partial read. `animationValue.ts`
 *     and `transitionValue.ts` own that judgement.
 *
 * A COMPILED or unmapped animation is not refused here at all: it is graying
 * that `StyleWriteLockContext` already applies to every control beneath it,
 * from the one verdict `classCssWritability.ts` computes. The keyframe editor
 * asks the same question about the `@keyframes` rule specifically
 * (`keyframesModel.ts`) and shows the same standard notice.
 */
import { useRef, useState, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { isStudioPageRootId } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { AnimationEditorPopover, type AnimationEditorTarget } from './AnimationEditorPopover'
import { AnimationScrubRow } from './AnimationScrubRow'
import {
  ANIMATION_DEFAULTS,
  animationClearProperties,
  animationFieldPatch,
  animationRemovalPatch,
  resolveAnimations,
  serializeAnimations,
  type AnimationField,
  type AnimationSource,
} from './animationValue'
import {
  indexKeyframesRules,
  keyframesRuleName,
  keyframesSelector,
  newKeyframesCss,
  resolveKeyframes,
  uniqueKeyframesName,
} from './keyframesModel'
import {
  resolveTransitions,
  transitionFieldPatch,
  transitionRemovalPatch,
  type TransitionField,
  type TransitionSource,
} from './transitionValue'
import styles from './AnimationsSection.module.css'

// ---------------------------------------------------------------------------
// Header actions — the "+" menu (see module doc)
// ---------------------------------------------------------------------------

/** The transition a "+ Transition" adds: the shortest thing that is visibly a transition and needs no further editing to be one. */
const DEFAULT_TRANSITION = 'all 200ms ease'

interface AnimationsSectionActionsProps {
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** The node the open style target belongs to, for co-locating a new `@keyframes` block. Absent in global-selector mode. */
  styleTarget?: { nodeId: string }
}

export function AnimationsSectionActions({ storedStyles, onChange, styleTarget }: AnimationsSectionActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const styleRules = useEditorStore((s) => s.site?.styleRules)
  const createAmbientRule = useEditorStore((s) => s.createAmbientRule)

  const animationSource = resolveAnimations(storedStyles)
  const transitionSource = resolveTransitions(storedStyles)
  // A value this module could not parse must not be silently rebuilt from a
  // structured list it never produced, so "add" is refused for that shape
  // rather than offered and then dropped.
  const canAddAnimation = animationSource.kind === 'none' || animationSource.kind === 'shorthand'
  const canAddTransition = transitionSource.kind === 'none' || transitionSource.kind === 'shorthand'

  function addAnimation() {
    setMenuOpen(false)
    const taken = new Set<string>()
    for (const rule of Object.values(styleRules ?? {})) {
      const name = keyframesRuleName(rule)
      if (name) taken.add(name)
    }
    const name = uniqueKeyframesName('fade-in', taken)
    createAmbientRule({
      selector: keyframesSelector(name),
      name: keyframesSelector(name),
      rawCss: newKeyframesCss(name),
      ...(styleTarget ? { scope: { type: 'node' as const, nodeId: styleTarget.nodeId, role: 'module-style' as const } } : {}),
    })
    const next =
      animationSource.kind === 'shorthand'
        ? [...animationSource.animations, { ...ANIMATION_DEFAULTS, name, duration: '300ms', fillMode: 'both' }]
        : [{ ...ANIMATION_DEFAULTS, name, duration: '300ms', fillMode: 'both' }]
    onChange('animation', serializeAnimations(next))
  }

  function addTransition() {
    setMenuOpen(false)
    const existing = transitionSource.kind === 'shorthand' ? `${transitionSource.transitions.map((t) => `${t.property} ${t.duration}`).join(', ')}, ` : ''
    onChange('transition', `${existing}${DEFAULT_TRANSITION}`)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Add animations"
        tooltip="Add animation"
        data-testid="class-style-section-add-animations"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <PlusIcon size={12} aria-hidden="true" />
      </Button>
      {menuOpen && (
        <ContextMenu
          ariaLabel="Add animation"
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          offset={6}
          onClose={() => setMenuOpen(false)}
        >
          <ContextMenuItem disabled={!canAddAnimation} onClick={addAnimation}>
            Animation
          </ContextMenuItem>
          <ContextMenuItem disabled={!canAddTransition} onClick={addTransition}>
            Transition
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Section body
// ---------------------------------------------------------------------------

type AnimationEntryData =
  | { kind: 'animation'; index: number }
  | { kind: 'transition'; index: number }
  | { kind: 'animationRaw'; raw: string; reason: string }
  | { kind: 'transitionRaw'; raw: string; reason: string }

interface AnimationsSectionProps {
  storedStyles: Record<string, unknown>
  /**
   * Kept for parity with every other curated section `StyleSectionsEditor`
   * mounts identically, and unread here for the same reason `EffectsSection`
   * does not read it: a list row is an additive item with no "inherited from
   * base" placeholder to resolve.
   */
  currentStyles: Record<string, unknown>
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function AnimationsSection({
  storedStyles,
  visibleProperties,
  onChange,
  onRemove,
  onClearProperties,
  onPreview,
  onClearPreview,
}: AnimationsSectionProps) {
  const visible = new Set(visibleProperties)
  // The anchor comes back from `PropertyList`'s `onActivate` and is held as
  // plain STATE, never as a ref read during render — the same React Compiler
  // constraint `EffectsSection` documents.
  const [editing, setEditing] = useState<{ id: string; anchorRef: RefObject<HTMLElement | null> } | null>(null)

  const styleRules = useEditorStore((s) => s.site?.styleRules)
  const setRuleRawCss = useEditorStore((s) => s.setRuleRawCss)
  // The keyframes write lock is only meaningful inside Studio, where a rule
  // genuinely maps to a file on disk — the same gate `StyleSurface` applies to
  // the class lock, for the same reason (`classCssWritability.ts`).
  const studioSession = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page != null && isStudioPageRootId(page.rootNodeId)
  })

  const animationSource: AnimationSource = visible.has('animation') || visible.has('animationName')
    ? resolveAnimations(storedStyles)
    : { kind: 'none' }
  const transitionSource: TransitionSource = visible.has('transition')
    ? resolveTransitions(storedStyles)
    : { kind: 'none' }

  const keyframesByName = indexKeyframesRules(styleRules ?? {})

  const entries: PropertyListEntry<AnimationEntryData>[] = []

  if (animationSource.kind === 'shorthand' || animationSource.kind === 'longhand') {
    animationSource.animations.forEach((animation, index) => {
      entries.push({
        id: `animation-${index}`,
        label: animation.name || `Animation ${index + 1}`,
        summary: animation.name || 'Animation',
        value: animation.duration,
        data: { kind: 'animation', index },
      })
    })
  } else if (animationSource.kind === 'raw' || animationSource.kind === 'mixed') {
    entries.push({
      id: 'animation-raw',
      label: 'Animation',
      summary: 'Animation',
      value: animationSource.raw,
      data: { kind: 'animationRaw', raw: animationSource.raw, reason: animationSource.reason },
    })
  }

  if (transitionSource.kind === 'shorthand') {
    transitionSource.transitions.forEach((transition, index) => {
      entries.push({
        id: `transition-${index}`,
        label: `Transition — ${transition.property}`,
        summary: `Transition ${transition.property}`,
        value: transition.duration,
        data: { kind: 'transition', index },
      })
    })
  } else if (transitionSource.kind === 'raw') {
    entries.push({
      id: 'transition-raw',
      label: 'Transition',
      summary: 'Transition',
      value: transitionSource.raw,
      data: { kind: 'transitionRaw', raw: transitionSource.raw, reason: transitionSource.reason },
    })
  }

  /** Apply a declaration patch through the ordinary per-property write path. */
  function applyPatch(patch: Partial<Record<keyof CSSPropertyBag, string>> | null): void {
    if (!patch) return
    for (const [property, value] of Object.entries(patch)) {
      onChange(property as keyof CSSPropertyBag, value)
    }
  }

  function setAnimationField(index: number, field: AnimationField, value: string) {
    applyPatch(animationFieldPatch(animationSource, index, field, value))
  }

  function setTransitionField(index: number, field: TransitionField, value: string) {
    applyPatch(transitionFieldPatch(transitionSource, index, field, value))
  }

  function handleRemove(entry: PropertyListEntry<AnimationEntryData>) {
    const { data } = entry
    if (data.kind === 'animationRaw') {
      onRemove('animation')
      return
    }
    if (data.kind === 'transitionRaw') {
      onRemove('transition')
      return
    }
    if (data.kind === 'transition') {
      const patch = transitionRemovalPatch(transitionSource, data.index)
      if (patch) applyPatch(patch)
      else onRemove('transition')
      return
    }
    const patch = animationRemovalPatch(animationSource, data.index)
    if (patch) applyPatch(patch)
    // Clearing the LAST animation clears every property the source shape uses
    // in one undo step — a longhand-shaped rule has eight of them, and leaving
    // seven behind with the name gone is not "removed", it is broken.
    else onClearProperties(animationClearProperties(animationSource))
  }

  const editingEntry = editing ? entries.find((entry) => entry.id === editing.id) : undefined
  const target = editingEntry ? resolveTarget(editingEntry) : null

  function resolveTarget(entry: PropertyListEntry<AnimationEntryData>): AnimationEditorTarget {
    const { data } = entry
    if (data.kind === 'animation') {
      const animation = (animationSource.kind === 'shorthand' || animationSource.kind === 'longhand'
        ? animationSource.animations[data.index]
        : undefined) ?? { ...ANIMATION_DEFAULTS }
      return {
        kind: 'animation',
        label: entry.label,
        animation,
        keyframes: animation.name ? resolveKeyframes(animation.name, keyframesByName, { studioSession }) : null,
        onFieldChange: (field, value) => setAnimationField(data.index, field, value),
        onKeyframesChange: (ruleId, rawCss) => setRuleRawCss(ruleId, rawCss),
      }
    }
    if (data.kind === 'transition') {
      const transition = transitionSource.kind === 'shorthand' ? transitionSource.transitions[data.index] : undefined
      return {
        kind: 'transition',
        label: entry.label,
        transition: transition ?? { property: 'all', duration: '0s', timingFunction: 'ease', delay: '0s' },
        onFieldChange: (field, value) => setTransitionField(data.index, field, value),
      }
    }
    return {
      kind: 'raw',
      label: entry.label,
      property: data.kind === 'animationRaw' ? 'animation' : 'transition',
      value: data.raw,
      reason: data.reason,
      onChange,
      onRemove,
      onPreview: onPreview
        ? (property, value) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
        : undefined,
      onClearPreview,
    }
  }

  const hasAnimations = entries.some((entry) => entry.data.kind === 'animation')

  return (
    <div className={styles.section}>
      <PropertyList
        listLabel="Animations"
        entries={entries}
        onActivate={(entry, anchorRef) => setEditing({ id: entry.id, anchorRef })}
        onRemove={handleRemove}
      />
      {hasAnimations && <AnimationScrubRow />}
      {target && editing && (
        <AnimationEditorPopover
          id={`animation-${editing.id}`}
          anchorRef={editing.anchorRef}
          onClose={() => setEditing(null)}
          target={target}
        />
      )}
    </div>
  )
}
