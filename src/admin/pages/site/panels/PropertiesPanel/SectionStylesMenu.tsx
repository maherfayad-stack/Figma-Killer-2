/**
 * SectionStylesMenu — apply a design-system STYLE from the section that owns it.
 *
 * Figma splits "reuse a design decision" into two things, and so does this
 * repo — they just weren't reachable from the same place:
 *
 *   - a **variable** is a value (`var(--color-brand-600)`, `var(--text-l)`).
 *     Already applied at the point of use: `TokenizedColorField` lists every
 *     framework colour on any colour row, `TokenAwareInput` lists the type and
 *     spacing scales on the fields that take them.
 *   - a **style** is a bundle of declarations under one name. Here that is a
 *     framework-generated utility class (`.text-l`, `.bg-brand`), which is a
 *     real `StyleRule` in `site.styleRules` carrying `generated.family`.
 *     Applying one means adding it to `node.classIds` — nothing is copied, and
 *     editing the framework still moves every user of the style.
 *
 * Styles were reachable only by name-typing in the ClassPicker at the top of
 * the panel: you had to already know that the way to set body type was to type
 * "text-m" into a box labelled with the element's classes. Figma puts a styles
 * button in the header of the section the style belongs to, which is where
 * someone looking for it actually is. This is that button.
 *
 * **One button per family.** The Typography header carries two: a type mark
 * that opens text styles, and a swatch that opens text-colour styles. It used
 * to be a single button opening both, and that menu was unusable — a project
 * generates six text styles and several hundred colour utilities, so the six
 * things the button was for drowned under the colours. Which family you are
 * about to apply is a choice you have already made before you reach for the
 * button, so it belongs in the button, not in a heading halfway down a list.
 * Background and Border have one family each and so keep one button.
 */

import { useRef, useState, type CSSProperties } from 'react'
import { styleRuleDisplayName, type StyleRule } from '@core/page-tree'
import type { IconComponent } from 'pixel-art-icons/types'
import type { FrameworkColorUtilityType } from '@core/framework-schema'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { useEditorStore } from '@site/store/store'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { Input } from '@ui/components/Input'
import { isTextStyleRule, isColorStyleRule } from './styleFamilyClassifier'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import styles from './SectionStylesMenu.module.css'

// ---------------------------------------------------------------------------
// Which style families each section offers
// ---------------------------------------------------------------------------

interface StyleFamily {
  /** Stable id for the trigger's test id. */
  key: string
  /** Trigger tooltip + the menu's accessible name. */
  title: string
  icon: IconComponent
  /**
   * `null` — this family is the generated TYPOGRAPHY classes.
   * Otherwise — the generated COLOUR utilities of these kinds.
   *
   * A family is one or the other by construction, which is what keeps a menu
   * from ever mixing them again.
   */
  colorUtilities: ReadonlyArray<FrameworkColorUtilityType> | null
}

/**
 * Section id → the style families that section offers, in button order.
 *
 * A section absent from this map gets no styles button at all: `spacing`,
 * `size`, `position`, `layout` and `interaction` have no generated-class
 * family behind them, and a button that opens an empty menu is worse than no
 * button. `effects` is absent for the same reason today — shadow/filter
 * utilities aren't generated yet; when they are, one entry here turns a
 * button on with no other change.
 */
const SECTION_STYLE_FAMILIES: ReadonlyMap<string, ReadonlyArray<StyleFamily>> = new Map([
  ['typography', [
    {
      key: 'text',
      title: 'Text styles',
      icon: TextStartTIcon,
      colorUtilities: null,
    },
    {
      // `fill` is Figma's own name for a text colour and some projects
      // generate it instead of `text`; offering both means a project isn't
      // punished for its naming convention.
      key: 'text-color',
      title: 'Text color styles',
      icon: ColorsSwatchSolidIcon,
      colorUtilities: ['text', 'fill'],
    },
  ]],
  ['background', [
    {
      key: 'background-color',
      title: 'Background color styles',
      icon: ColorsSwatchSolidIcon,
      colorUtilities: ['background'],
    },
  ]],
  ['border', [
    {
      key: 'border-color',
      title: 'Border color styles',
      icon: ColorsSwatchSolidIcon,
      colorUtilities: ['border'],
    },
  ]],
])

// ---------------------------------------------------------------------------
// Style rows
// ---------------------------------------------------------------------------

interface StyleEntry {
  rule: StyleRule
  /** A colour swatch value for a colour style, `null` for a type style. */
  swatch: string | null
  /**
   * The metrics Figma prints after a style's name — `16px · 1.4`.
   *
   * `null` for a colour style, and deliberately so: the only thing a colour
   * utility could say there is its token name, which is already most of the
   * class name beside it (`text-background-brand-alfursan-10` next to
   * `background-brand-alfursan · 10`). Printing it cost the name half the row
   * and told the reader nothing. Figma shows a swatch and a name for a colour
   * style, and metrics only for text — for this reason.
   */
  hint: string | null
}

/**
 * The summary Figma shows beside a style name: `14/140` for a text style, the
 * swatch for a colour. Read off the rule's OWN declarations rather than the
 * framework settings that generated it, so a style whose generator has since
 * changed reports what it currently applies, not what it was born as.
 *
 * `resolveVar` exists because a generated colour utility declares
 * `var(--brand-600)`, and that custom property is defined in the CANVAS
 * document, not in the admin chrome this menu renders into. Handing the raw
 * reference to a swatch paints nothing — the browser resolves an undefined
 * variable to the initial value and the swatch comes out blank, which is how
 * this shipped for exactly one screenshot. `TokenizedColorField` solves the
 * same problem the same way.
 */
function describeStyle(
  rule: StyleRule,
  resolveVar: (value: string) => string,
  isColorFamily: boolean,
): StyleEntry {
  if (isColorFamily) {
    const declared =
      rule.styles.backgroundColor ??
      rule.styles.background ??
      rule.styles.color ??
      rule.styles.borderColor ??
      rule.styles.borderTopColor
    return {
      rule,
      swatch: typeof declared === 'string' ? resolveVar(declared) : null,
      hint: null,
    }
  }

  const size = rule.styles.fontSize
  const leading = rule.styles.lineHeight
  const parts = [size, leading].filter((part) => part != null && part !== '')
  return {
    rule,
    swatch: null,
    hint: parts.length > 0 ? parts.join(' · ') : null,
  }
}

/**
 * How many rows a menu will draw before it stops and says how many it left
 * out.
 *
 * A real project generates thousands of colour utilities: every colour token
 * times every shade and tint times every enabled utility. Measured on the
 * fixture project while building this — 4,294 entries when one menu carried
 * both families. Splitting the families fixed the worst of it (the text menu
 * is now six rows), but a colour menu is still hundreds long, and a menu that
 * long is not a picker, it is a wall. The cap plus the search field is what
 * turns it back into a picker; the count line is there so the cap never
 * silently hides the style someone is looking for.
 */
const MAX_VISIBLE_STYLES = 40

/**
 * Every generated rule belonging to one family, name-sorted and filtered by
 * the menu's search box. Returns the capped page plus the honest total, so
 * the caller can say what it left out.
 */
function collectFamilyStyles(
  styleRules: Record<string, StyleRule> | undefined,
  family: StyleFamily,
  query: string,
  resolveVar: (value: string) => string,
): { entries: StyleEntry[]; total: number } {
  const matches: StyleRule[] = []
  const needle = query.trim().toLowerCase()

  for (const rule of Object.values(styleRules ?? {})) {
    if (needle && !styleRuleDisplayName(rule).toLowerCase().includes(needle)) continue

    // Classified by what the rule DECLARES, not by where it came from. This
    // used to require `generated.origin === 'framework'`, which on a real
    // Studio project matched almost nothing: the repo is the document, its
    // rules are parsed out of the project's own CSS, and a parsed rule has
    // no `generated` metadata. See `styleFamilyClassifier.ts`.
    const belongs =
      family.colorUtilities === null
        ? isTextStyleRule(rule)
        : isColorStyleRule(rule, family.colorUtilities)
    if (belongs) matches.push(rule)
  }

  matches.sort((a, b) => a.name.localeCompare(b.name))
  return {
    entries: matches
      .slice(0, MAX_VISIBLE_STYLES)
      .map((rule) => describeStyle(rule, resolveVar, family.colorUtilities !== null)),
    total: matches.length,
  }
}

// ---------------------------------------------------------------------------
// SectionStylesMenu — the section header's whole styles cluster
// ---------------------------------------------------------------------------

interface SectionStylesMenuProps {
  /** Style section this sits in — decides which families it offers. */
  sectionId: string
  /** The node the style is applied to. */
  nodeId: string
  /** Class ids already on the node, so applied styles render as such. */
  assignedClassIds: ReadonlyArray<string>
}

export function SectionStylesMenu({
  sectionId,
  nodeId,
  assignedClassIds,
}: SectionStylesMenuProps) {
  const families = SECTION_STYLE_FAMILIES.get(sectionId)
  if (!families) return null

  return (
    <>
      {families.map((family) => (
        <StyleFamilyMenu
          key={family.key}
          family={family}
          nodeId={nodeId}
          assignedClassIds={assignedClassIds}
        />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// StyleFamilyMenu — one button, one family
// ---------------------------------------------------------------------------

interface StyleFamilyMenuProps {
  family: StyleFamily
  nodeId: string
  assignedClassIds: ReadonlyArray<string>
}

function StyleFamilyMenu({ family, nodeId, assignedClassIds }: StyleFamilyMenuProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const styleRules = useEditorStore((state) => state.site?.styleRules)
  const colorSettings = useEditorStore((state) => state.site?.settings.framework?.colors)
  const addNodeClass = useEditorStore((state) => state.addNodeClass)
  const removeNodeClass = useEditorStore((state) => state.removeNodeClass)
  const setPreviewNodeClass = useEditorStore((state) => state.setPreviewNodeClass)
  const clearPreviewNodeClass = useEditorStore((state) => state.clearPreviewNodeClass)
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')

  // `--brand-600` → `#1a73e8`, for the swatch. Built from the same generator
  // the Colours panel and the colour-token picker read, so a swatch here can
  // never disagree with the one beside the value.
  const colorVariables = generateFrameworkColorVariableSets(colorSettings).light
  const resolveVar = (value: string): string => {
    const varName = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(value.trim())?.[1]
    if (!varName) return value
    return colorVariables.find((variable) => variable.name === varName)?.value ?? value
  }

  const { entries, total } = collectFamilyStyles(styleRules, family, query, resolveVar)
  const assigned = new Set(assignedClassIds)
  const hidden = total - entries.length
  const TriggerMark = family.icon

  const toggle = (rule: StyleRule) => {
    clearPreviewNodeClass()
    if (assigned.has(rule.id)) removeNodeClass(nodeId, rule.id)
    else addNodeClass(nodeId, rule.id)
    setOpen(false)
  }

  return (
    <span className={styles.wrap}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="micro"
        iconOnly
        pressed={open}
        onClick={() => {
          setQuery('')
          setOpen((wasOpen) => !wasOpen)
        }}
        aria-label={`Apply ${family.title.toLowerCase()}`}
        aria-expanded={open}
        tooltip={family.title}
        data-testid={`section-styles-${family.key}`}
      >
        <TriggerMark size={13} aria-hidden="true" />
      </Button>

      {open && (
        <ContextMenu
          ariaLabel={family.title}
          anchorRef={triggerRef}
          align="end"
          /* Generated utility names run long (`text-background-brand-alfursan-40`)
             and the name is the only thing that identifies the style, so the
             menu is sized to the names rather than to the button it hangs off. */
          minWidth={280}
          maxWidth={360}
          maxHeight={320}
          onClose={() => {
            clearPreviewNodeClass()
            setOpen(false)
          }}
          header={
            <div className={styles.search}>
              <Input
                autoFocus
                fieldSize="sm"
                type="search"
                value={query}
                placeholder={`Search ${family.title.toLowerCase()}`}
                aria-label={`Search ${family.title.toLowerCase()}`}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          }
        >
          {total === 0 ? (
            /*
             * An honest empty state, not a hidden button. With no query this
             * says the framework generates nothing for this family — a fact
             * about the project worth telling the user, and the sentence says
             * where to change it.
             */
            <p className={styles.empty}>
              {query.trim()
                ? `No style matches "${query.trim()}".`
                : `No ${family.title.toLowerCase()} in this project yet. A class in the project's own CSS counts as one as soon as it reads as a ${family.colorUtilities === null ? 'type' : 'colour'} style; the Framework panel's generators add more.`}
            </p>
          ) : (
            entries.map(({ rule, swatch, hint }) => {
              const isApplied = assigned.has(rule.id)
              return (
                <ContextMenuItem
                  key={rule.id}
                  selected={isApplied}
                  onClick={() => toggle(rule)}
                  onMouseEnter={
                    hoverPreviewEnabled ? () => setPreviewNodeClass(nodeId, rule.id) : undefined
                  }
                  onMouseLeave={hoverPreviewEnabled ? () => clearPreviewNodeClass() : undefined}
                >
                  <span className={styles.row}>
                    {swatch !== null ? (
                      <span
                        className={styles.swatch}
                        style={{ '--style-swatch': swatch } as CSSProperties}
                        aria-hidden="true"
                      />
                    ) : (
                      <span className={styles.typeMark} aria-hidden="true">Ag</span>
                    )}
                    <span className={styles.name}>{styleRuleDisplayName(rule)}</span>
                    {hint !== null && <span className={styles.hint}>{hint}</span>}
                  </span>
                </ContextMenuItem>
              )
            })
          )}
          {hidden > 0 && (
            <p className={styles.more}>
              {hidden} more — keep typing to narrow the list.
            </p>
          )}
        </ContextMenu>
      )}
    </span>
  )
}
