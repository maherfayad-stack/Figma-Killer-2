/**
 * themeUtilities - how a Tailwind theme name becomes the utility classes that
 * read it (CT-6).
 *
 * In Tailwind v4 a variable declared in `@theme` is also a vocabulary item:
 * `--color-brand` is the colour `brand`, which `bg-brand`, `text-brand`,
 * `border-brand/50` and `hover:ring-brand` all spell. Renaming only the
 * variable leaves every one of those classes pointing at nothing, so a rename
 * has to know the class spellings; and "apply this variable" for a theme
 * variable is, in practice, adding one of those classes.
 *
 * Both are the same table, kept in one place: a NAMESPACE (the leading part of
 * the variable name) and the utility prefixes that read it. Pure and
 * browser-safe - the Variables panel offers the classes, the server rewrites
 * them.
 *
 * ## What is deliberately not here
 *
 * `--spacing-*`, `--container-*` and `--breakpoint-*` are namespaces too, but
 * their names are read by a long tail of utilities (`p-`, `m-`, `gap-`, `w-`,
 * `inset-`... ) or by VARIANTS (`md:`), where a textual rewrite cannot tell a
 * class from a word. They are listed so a rename can say exactly why it is
 * refused, with no utilities, rather than being treated as an ordinary name.
 */

export interface ThemeNamespace {
  /** The variable-name prefix, including both dashes and the trailing one: `--color-`. */
  readonly prefix: string
  /** Every utility prefix whose class names the variable (`bg` -> `bg-brand`). Empty when a rename cannot follow them. */
  readonly utilities: readonly string[]
  /** The few the Variables panel offers as "apply", most useful first. */
  readonly apply: readonly string[]
  /** Why a rename cannot follow the classes, when `utilities` is empty. */
  readonly renameBlocked?: string
}

const COLOR_UTILITIES = [
  'bg', 'text', 'decoration', 'border', 'border-x', 'border-y', 'border-s', 'border-e', 'border-t', 'border-r', 'border-b', 'border-l',
  'divide', 'outline', 'ring', 'ring-offset', 'inset-ring', 'shadow', 'inset-shadow', 'accent', 'caret', 'fill', 'stroke', 'from', 'via', 'to',
] as const

const RADIUS_UTILITIES = ['rounded', 'rounded-s', 'rounded-e', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded-ss', 'rounded-se', 'rounded-ee', 'rounded-es', 'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl'] as const

/** Longest prefix first: `--font-weight-` must be tried before `--font-`, `--inset-shadow-` before `--shadow-`. */
const NAMESPACES: readonly ThemeNamespace[] = [
  { prefix: '--font-weight-', utilities: ['font'], apply: ['font'] },
  { prefix: '--inset-shadow-', utilities: ['inset-shadow'], apply: ['inset-shadow'] },
  { prefix: '--drop-shadow-', utilities: ['drop-shadow'], apply: ['drop-shadow'] },
  { prefix: '--text-shadow-', utilities: ['text-shadow'], apply: ['text-shadow'] },
  { prefix: '--perspective-', utilities: ['perspective'], apply: ['perspective'] },
  { prefix: '--breakpoint-', utilities: [], apply: [], renameBlocked: 'its name is also a responsive variant (for example md:), which a rename cannot follow' },
  { prefix: '--container-', utilities: [], apply: [], renameBlocked: 'its name is also read by sizing utilities and container variants (max-w-, @md:), which a rename cannot follow' },
  { prefix: '--spacing-', utilities: [], apply: [], renameBlocked: 'its name is read by every spacing and sizing utility (p-, m-, gap-, w-, inset-...), which a rename cannot follow' },
  { prefix: '--tracking-', utilities: ['tracking'], apply: ['tracking'] },
  { prefix: '--leading-', utilities: ['leading'], apply: ['leading'] },
  { prefix: '--animate-', utilities: ['animate'], apply: ['animate'] },
  { prefix: '--aspect-', utilities: ['aspect'], apply: ['aspect'] },
  { prefix: '--radius-', utilities: RADIUS_UTILITIES, apply: ['rounded'] },
  { prefix: '--shadow-', utilities: ['shadow'], apply: ['shadow'] },
  { prefix: '--color-', utilities: COLOR_UTILITIES, apply: ['bg', 'text', 'border', 'fill', 'stroke', 'ring', 'outline'] },
  { prefix: '--font-', utilities: ['font'], apply: ['font'] },
  { prefix: '--text-', utilities: ['text'], apply: ['text'] },
  { prefix: '--blur-', utilities: ['blur', 'backdrop-blur'], apply: ['blur'] },
  { prefix: '--ease-', utilities: ['ease'], apply: ['ease'] },
]

/** The bare `--spacing`: Tailwind multiplies it for every numeric spacing utility, so the NAME is read by the engine itself. */
const BARE_SPACING = '--spacing'

export interface ThemeVariable {
  readonly namespace: ThemeNamespace
  /** The name after the prefix: `--color-brand-500` -> `brand-500`. */
  readonly key: string
}

/** The namespace a variable name belongs to, or `null` for an ordinary custom property (`--brand-glow`). */
export function themeVariableOf(name: string): ThemeVariable | null {
  for (const namespace of NAMESPACES) {
    if (name.startsWith(namespace.prefix) && name.length > namespace.prefix.length) {
      return { namespace, key: name.slice(namespace.prefix.length) }
    }
  }
  return null
}

/** Whether the name is a Tailwind theme variable (a `@theme` declaration of it also creates utilities). */
export function isThemeNamespacedName(name: string): boolean {
  return name === BARE_SPACING || themeVariableOf(name) !== null
}

/** Why renaming this theme variable cannot rewrite the classes that use it, or `null` when it can. */
export function themeRenameBlockedReason(name: string): string | null {
  if (name === BARE_SPACING) return 'Tailwind reads --spacing by name to size every spacing utility'
  return themeVariableOf(name)?.namespace.renameBlocked ?? null
}

/** The other utility-prefix owners: `text-` is both a colour and a size, `font-` both a family and a weight, `shadow-` both a colour and a shadow. */
export function sharedUtilityNamespaces(namespace: ThemeNamespace, utility: string): ThemeNamespace[] {
  return NAMESPACES.filter((other) => other !== namespace && other.utilities.includes(utility))
}

/** The classes the Variables panel offers for applying this theme variable to an element: `bg-brand`, `text-brand`... */
export function themeApplyClasses(name: string): string[] {
  const variable = themeVariableOf(name)
  return variable ? variable.namespace.apply.map((utility) => `${utility}-${variable.key}`) : []
}

/** One class as it is written inside a string: `hover:bg-brand/50!` has the name `bg-brand`. */
export interface ClassWord {
  /** The utility name with its variants, opacity modifier and important marker removed: `bg-brand`. */
  readonly name: string
  /** Offsets of `name` in the searched text. */
  readonly start: number
  readonly end: number
}

const WORD_RE = /[^\s"'`]+/g

/**
 * The classes in the text of a string literal, read the way Tailwind reads
 * them: whitespace separates classes, `:` outside brackets ends the variants
 * (`md:hover:bg-brand`, `[&:hover]:bg-brand`), a leading or trailing `!` is
 * the important marker, and a `/` outside brackets starts the opacity modifier.
 * One definition for the usage count, the rename and the "is it already used"
 * check, so they cannot disagree about what a class is.
 */
export function classWordsOf(text: string): ClassWord[] {
  const words: ClassWord[] = []
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0]
    let depth = 0
    let nameStart = 0
    let slash = -1
    for (let i = 0; i < word.length; i++) {
      const ch = word[i]!
      if (ch === '[' || ch === '(') depth++
      else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1)
      else if (depth === 0 && ch === ':') {
        nameStart = i + 1
        slash = -1
      } else if (depth === 0 && ch === '/' && slash === -1) slash = i
    }
    let end = slash === -1 ? word.length : slash
    let start = nameStart
    if (word[start] === '!') start++
    if (end > start && word[end - 1] === '!') end--
    if (end > start) words.push({ name: word.slice(start, end), start: match.index + start, end: match.index + end })
  }
  return words
}

/** Every class that reads the theme key `key` of `namespace`: `['bg-brand', 'text-brand', ...]`. */
export function themeClassNames(namespace: ThemeNamespace, key: string): string[] {
  return namespace.utilities.map((utility) => `${utility}-${key}`)
}

/** The class stems of `namespace` that a computed name could complete (`bg-` of `` `bg-${tone}` ``). */
export function themeClassStems(namespace: ThemeNamespace): string[] {
  return namespace.utilities.map((utility) => `${utility}-`)
}

/** Rewrites each class `decide` names a replacement for; every other byte is untouched. */
export function rewriteClassWords(text: string, decide: (name: string) => string | null): { text: string; count: number } {
  const edits: ClassWord[] = []
  const replacements: string[] = []
  for (const word of classWordsOf(text)) {
    const replacement = decide(word.name)
    if (replacement === null || replacement === word.name) continue
    edits.push(word)
    replacements.push(replacement)
  }
  let next = text
  for (let i = edits.length - 1; i >= 0; i--) next = next.slice(0, edits[i]!.start) + replacements[i] + next.slice(edits[i]!.end)
  return { text: next, count: edits.length }
}
