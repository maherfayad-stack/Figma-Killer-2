/**
 * AnimationsSection — Studio's own "Animations" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras). Ported (not kept) from
 * `panels/PropertiesPanel/AnimationsSection.tsx` (deleted — it was only
 * ever reachable through `StyleSectionsEditor`'s hardcoded
 * `ANIMATIONS_SECTION_ID` branch, itself deleted with
 * `StyleSectionsEditor.tsx`) onto its own `INSPECTOR_SECTIONS` manifest
 * entry, the same pattern every migrated section already established:
 * reads/writes exclusively through `useSelectionModel()`/
 * `useInspectorCommit(model)`, takes no props, renders `null` on no
 * selection.
 *
 * Combines what used to be TWO exports (`AnimationsSectionActions` — the
 * header "+" menu, mounted separately by `StyleSectionsEditor` in both the
 * collapsed-empty header and the open one — and `AnimationsSection` — the
 * body) into one component with its own local Law-1 empty/populated
 * disclosure, the SAME pattern Stroke/Shadow/Blur/Fill each already
 * reproduced locally (`Section empty` when nothing set anywhere, `Section
 * forceOpen` once populated).
 *
 * `AnimationEditorPopover.tsx`/`AnimationScrubRow.tsx`/`animationValue.ts`/
 * `keyframesModel.ts`/`transitionValue.ts` are all kept in place, UNCHANGED
 * — they already take a fully-formed, decoupled `AnimationEditorTarget`/
 * no-props contract with zero dependency on `classStyleSections`/
 * `StyleSectionsEditor`'s handler shapes.
 *
 * `createAmbientRule`/`setRuleRawCss`/`s.site?.styleRules` stay direct
 * `useEditorStore` calls, exactly as in the pre-migration file — keyframes-
 * rule bookkeeping, not a style-bag write `commitApi.ts` covers.
 *
 * ## What this refuses, and says so
 *
 * See the pre-migration file's own doc (ported verbatim below in spirit):
 * JS animation (framer-motion/GSAP/rAF) is not listed — there is no
 * declaration to write. A transition's property LIST is not editable, only
 * its timing. Scroll-driven animation (`animation-timeline`) is out of
 * scope — its rule keeps its declarations untouched and shows its
 * `animation` value as a raw row. A value this module cannot parse becomes
 * one raw-text row with the reason, never a partial read.
 *
 * ## Locked (code-valued) properties
 *
 * Every property this section claims is filtered through
 * `selectedNode.codeProps`'s `style:<prop>` keys, the same per-section slice
 * every migrated section reproduces.
 *
 * ## MULTI-SELECT
 *
 * Out of scope, structurally — see `TransformSection.tsx`'s own doc.
 */
import { useRef, useState, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { isStudioPageRootId, styleValueKey } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { Section } from '@ui/components/Section'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { AnimationEditorPopover, type AnimationEditorTarget } from '../../panels/PropertiesPanel/AnimationEditorPopover'
import { AnimationScrubRow } from '../../panels/PropertiesPanel/AnimationScrubRow'
import {
  ANIMATION_DEFAULTS,
  animationClearProperties,
  animationFieldPatch,
  animationRemovalPatch,
  resolveAnimations,
  serializeAnimations,
  type AnimationField,
} from '../../panels/PropertiesPanel/animationValue'
import {
  indexKeyframesRules,
  keyframesRuleName,
  keyframesSelector,
  newKeyframesCss,
  resolveKeyframes,
  uniqueKeyframesName,
} from '../../panels/PropertiesPanel/keyframesModel'
import {
  resolveTransitions,
  transitionFieldPatch,
  transitionRemovalPatch,
  type TransitionField,
} from '../../panels/PropertiesPanel/transitionValue'
import { hasStyleValue } from '../../panels/PropertiesPanel/styleValueUtils'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import styles from '../../panels/PropertiesPanel/AnimationsSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

/** The transition a "+ Transition" adds: the shortest thing that is visibly a transition and needs no further editing to be one. */
const DEFAULT_TRANSITION = 'all 200ms ease'

const ANIMATION_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'animation',
  'animationName',
  'animationDuration',
  'animationTimingFunction',
  'animationDelay',
  'animationIterationCount',
  'animationDirection',
  'animationFillMode',
  'animationPlayState',
  'transition',
]

type AnimationEntryData =
  | { kind: 'animation'; index: number }
  | { kind: 'transition'; index: number }
  | { kind: 'animationRaw'; raw: string; reason: string }
  | { kind: 'transitionRaw'; raw: string; reason: string }

export function AnimationsSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId } = model

  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState<{ id: string; anchorRef: RefObject<HTMLElement | null> } | null>(null)

  const styleRules = useEditorStore((s) => s.site?.styleRules)
  const createAmbientRule = useEditorStore((s) => s.createAmbientRule)
  const setRuleRawCss = useEditorStore((s) => s.setRuleRawCss)
  // The keyframes write lock is only meaningful inside Studio, where a rule
  // genuinely maps to a file on disk — the same gate `StyleSurface` applies
  // to the class lock, for the same reason (`classCssWritability.ts`).
  const studioSession = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page != null && isStudioPageRootId(page.rootNodeId)
  })

  if (!selectedNodeId || !selectedNode) return null

  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(ANIMATION_PROPERTIES, contextOnlyClassChain, inlineStyles)

  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = ANIMATION_PROPERTIES.some(
    (prop) => hasStyleValue(storedStyles[prop]) || crossContextStyles.some((bag) => hasStyleValue(bag[prop])),
  )

  function onChange(property: keyof CSSPropertyBag, value: string | number | undefined) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyle(property, value ?? null)
  }

  function onRemove(property: keyof CSSPropertyBag) {
    onChange(property, undefined)
  }

  function onPreview(patch: Partial<CSSPropertyBag>) {
    const filtered: Record<string, string | number | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (lockedProperties.has(key)) continue
      filtered[key] = (value as string | number | null | undefined) ?? null
    }
    if (Object.keys(filtered).length === 0) return
    commit.commitStyleMany(filtered as Partial<Record<keyof CSSPropertyBag, string | number | null>>, {
      preview: true,
    })
  }

  const onClearPreview = commit.clearStylePreview

  /**
   * Apply a declaration patch as ONE store write — therefore one undo entry.
   * A longhand-shaped animation rule has eight properties; rewriting it one
   * `onChange` at a time made a single field edit eight history entries.
   */
  function applyPatch(patch: Partial<Record<keyof CSSPropertyBag, string>> | null): void {
    if (!patch) return
    const filtered: Record<string, string | number | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (lockedProperties.has(key)) continue
      filtered[key] = value ?? null
    }
    if (Object.keys(filtered).length === 0) return
    commit.commitStyleMany(filtered as Partial<Record<keyof CSSPropertyBag, string | number | null>>)
  }

  function onClearProperties(properties: ReadonlyArray<keyof CSSPropertyBag>) {
    const patch: Record<string, null> = {}
    for (const property of properties) {
      if (lockedProperties.has(String(property))) continue
      patch[property] = null
    }
    if (Object.keys(patch).length === 0) return
    commit.commitStyleMany(patch as Partial<Record<keyof CSSPropertyBag, string | number | null>>, { mode: 'clear' })
  }

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
      scope: { type: 'node' as const, nodeId: selectedNodeId!, role: 'module-style' as const },
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

  const addMenu = (
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
        data-testid="animations-section-add"
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

  // Law 1's empty header — nothing set anywhere. Resolving keyframes against
  // the whole rule registry is real work; this keeps it off the panel for
  // the overwhelming majority of elements, same as the pre-migration file.
  if (!setAnywhere) {
    return <Section title="Animations" empty flush icon={VideoSolidIcon} actions={addMenu} />
  }

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
    // Clearing the LAST animation clears every property the source shape
    // uses in one undo step — a longhand-shaped rule has eight of them.
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
      onPreview: (property, value) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>),
      onClearPreview,
    }
  }

  const hasAnimations = entries.some((entry) => entry.data.kind === 'animation')

  return (
    <Section title="Animations" icon={VideoSolidIcon} forceOpen flush actions={addMenu}>
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
    </Section>
  )
}
