/**
 * applicabilityGates — fills in `PropSpec.appliesWhen` for a design-system
 * prop whose doc comment says it only means something for SOME values of a
 * sibling enum prop. Split out of `buildDesignSystemManifest.ts` (which
 * calls `inheritApplicability` as its own post-pass, alongside
 * `inheritForwardedEnums`/`inheritTemplatedClassEnums`) purely by size —
 * this is a self-contained parsing concern with its own doc, not a
 * dependency boundary.
 *
 * `Button.cardArt`'s "selected-card thumbnail — apple-pay / gpay-card /
 * gpay-personalized" is the motivating case: on a `variant="primary"`
 * instance it used to render a dead row — a full, empty 140px image picker —
 * because the manifest recorded no applicability at all.
 *
 * `inheritApplicability` re-reads the SAME trailing `//` comment
 * `buildDesignSystemManifest.ts`'s `parsePropComments` already captures, but
 * only after every component's enums are FINAL — including what its own
 * `inheritForwardedEnums`/`inheritTemplatedClassEnums` passes just added —
 * so a token match has every enum it could possibly need to check against.
 *
 * ## Prose forms this HANDLES, each requiring every extracted token to be an
 * exact, already-parsed enum member of exactly one OTHER prop on the same
 * component (never the prop's own enum, and never a value split across two
 * different props' enums — an ambiguous match is a declined match):
 *
 * 1. **`when prop="value"`** — `Cell.toggleChecked` ("toggle state when
 *    trailing=\"toggle\""), `BottomActionBar.originalPrice`.
 * 2. **`prop="value" only`** — `Separator.label` ("(variant=\"or\" only)").
 * 3. **`shown by value`** — `Button.cardLast4` ("masked card number shown by
 *    gpay-personalized").
 * 4. **`<phrase> only`**, phrase unnamed — `AdBanner.showImageAction`
 *    ("desktop only"), `MarketingCard.partnerLogoSrc` ("solid only"),
 *    `Search.showClose` ("ios only"), and the leading `AdBanner.size`
 *    ("mobile only: small | medium | large") scope-prefix form the
 *    manifest's own enum cleaner (`stripEnumAnnotation`) already strips for
 *    the prop's OWN enum.
 *    `<phrase>` may be a bare `/`-joined compound with NO spaces
 *    (`text/payment only`) — every token must resolve to the SAME sibling
 *    enum or the whole match is declined, which is what keeps `Button.size`
 *    unconditional: `payment` is a real `variant` value but `text` is not a
 *    literal value of anything in this package, so the compound never
 *    agrees on one owning prop. This is the deliberate non-inference the
 *    work order calls out — "text variants" names a GROUP, not a value, and
 *    a wrong gate is worse than a missing one.
 * 5. **A bare `/`-joined list straight after an em/en dash**, no "only"
 *    needed — `Button.cardArt` itself. Anchored to right-after-the-dash
 *    (not "anywhere in the comment") on purpose: `AdBanner.imageSrc`'s
 *    "hero (mobile medium/large) / trailing strip (mobile small) / side
 *    image (desktop)" also contains a `word/word` run (`medium/large`,
 *    both literal `size` values), but it sits inside a PARENTHETICAL aside
 *    describing one of three always-applicable interpretations of the same
 *    prop, not a scope — and it is not adjacent to a dash, so this form
 *    never reaches it.
 *
 * ## Prose forms this DECLINES, on purpose:
 *
 * - **A categorical phrase with no literal enum member** — `text/payment
 *   only`, `(text variants)`, `brand-pay variants are single fixed size`.
 *   Deciding whether "text variants" means the 5 non-payment/non-brand-pay
 *   `variant` values is an inference about the package's intent, not a
 *   reading of a listed value — exactly the case the work order says to
 *   decline.
 * - **`only affects X; ignored for Y, Z`** — `AlmosaferLogo.lang`. The scope
 *   word appears BEFORE "only" here ("only affects wordmark"), not after
 *   it, and handling that order too would risk matching "only" used as a
 *   plain adverb elsewhere in the same clause; declined rather than adding a
 *   second grammar this narrow.
 * - **A partial exception inside an otherwise-unconditional prop** —
 *   `BottomSheet.size`'s "small is iOS-only; android small → medium" is a
 *   per-VALUE remapping on one platform, not "this prop only applies when
 *   platform=ios" (the prop applies on both platforms; only one of its
 *   options behaves differently) — no single `{ prop, values }` gate can
 *   represent that honestly, so none is recorded.
 * - **Anything with no doc comment at all**, or a doc comment naming no
 *   sibling prop's literal, already-parsed enum member. This includes a prop
 *   documented only in a component's SECOND (or later) usage example —
 *   `Dialog.icon`'s own "android only" comment is a real, correctly-shaped
 *   instance of form 4 above, but it lives in the Android example fence, and
 *   `parsePropComments` only reads the FIRST example (`firstUsageExample`'s
 *   own doc explains why). That is a pre-existing limit of what comment this
 *   module ever SEES, not a gap in the forms it can parse — extending the
 *   comment window is out of this module's scope.
 *
 * A missing gate is always the safe failure: the caller (`register.tsx`)
 * only ever HIDES a row when `appliesWhen` says to, so a prose form this
 * module declines simply keeps the row unconditional — exactly its current,
 * correct-if-uninformative behaviour.
 */
import type { ComponentSpec } from '../component-manifest/types'

export function inheritApplicability(components: ComponentSpec[], commentsByComponent: Map<string, Map<string, string>>): void {
  for (const component of components) {
    const comments = commentsByComponent.get(component.name)
    if (!comments) continue
    const enums = new Map<string, string[]>()
    for (const prop of component.props) {
      if (prop.enumValues) enums.set(prop.name, prop.enumValues)
    }
    for (const prop of component.props) {
      const comment = comments.get(prop.name)
      if (!comment) continue
      const gate = applicabilityFromComment(prop.name, comment, enums)
      if (gate) prop.appliesWhen = gate
    }
  }
}

interface ApplicabilityGate {
  prop: string
  values: string[]
}

/** `prop="value"` — resolved only when `prop`'s own already-parsed enum literally contains `value`, guarding against a doc typo naming a value that doesn't exist. */
function explicitGate(prop: string, value: string, enums: Map<string, string[]>): ApplicabilityGate | undefined {
  return enums.get(prop)?.includes(value) ? { prop, values: [value] } : undefined
}

/**
 * The ONE other prop (never the gated prop itself) whose enum contains EVERY
 * token in `tokens`, or `undefined` when zero or more than one prop
 * qualifies. An ambiguous match — two props whose enums both happen to
 * contain the same literal — is exactly as unsafe as no match: which one the
 * docs meant is a guess either way.
 */
function uniqueOwner(tokens: string[], others: Map<string, Set<string>>): string | undefined {
  let owner: string | undefined
  for (const [name, set] of others) {
    if (tokens.every((token) => set.has(token))) {
      if (owner !== undefined) return undefined
      owner = name
    }
  }
  return owner
}

/** A single value or a bare `/`-joined compound of them (`text/payment`), with no other punctuation — the shape every "only"/dash-anchored phrase below must reduce to before its tokens are checked against an enum. */
const BARE_TOKEN_PHRASE_RE = /^[a-z][\w-]*(?:\s*\/\s*[a-z][\w-]*)*$/i

/** Form 3 — `shown by <value>` (`Button.cardLast4`). */
function gateFromShownBy(comment: string, others: Map<string, Set<string>>): ApplicabilityGate | undefined {
  const match = /\bshown by\s+([a-z][\w-]*)\b/i.exec(comment)
  if (!match) return undefined
  const owner = uniqueOwner([match[1]!], others)
  return owner ? { prop: owner, values: [match[1]!] } : undefined
}

/**
 * Form 4 — an unnamed `<phrase> only` scope. Walks every `only` in the
 * comment (there is normally at most one) and, for each, cuts the phrase at
 * the NEAREST preceding `(`, `;`, `–`/`—`, or the start of the comment —
 * `AdBanner.size`'s "mobile only:" needs the start-of-comment cut,
 * `MarketingCard.partnerLogoSrc`'s "(solid only)" needs the `(` cut,
 * `AdBanner.showImageAction`'s "— desktop only" needs the dash cut.
 */
function gateFromOnlyKeyword(comment: string, others: Map<string, Set<string>>): ApplicabilityGate | undefined {
  const onlyRe = /\bonly\b/gi
  let match: RegExpExecArray | null
  while ((match = onlyRe.exec(comment))) {
    const before = comment.slice(0, match.index)
    const cut = Math.max(before.lastIndexOf('('), before.lastIndexOf(';'), before.lastIndexOf('–'), before.lastIndexOf('—'))
    const phrase = before.slice(cut + 1).trim().replace(/:$/, '')
    if (!BARE_TOKEN_PHRASE_RE.test(phrase)) continue
    const tokens = phrase.split('/').map((token) => token.trim())
    const owner = uniqueOwner(tokens, others)
    if (owner) return { prop: owner, values: tokens }
  }
  return undefined
}

/**
 * Form 5 — a bare `/`-joined alternatives list straight after an em/en dash,
 * with no "only" keyword needed (`Button.cardArt`). Anchored to right after
 * the dash — see this function's caller's doc comment for why a `word/word`
 * run elsewhere in the comment (inside a parenthetical aside) must NOT match.
 */
function gateFromDashedSlashList(comment: string, others: Map<string, Set<string>>): ApplicabilityGate | undefined {
  const dashRe = /[–—]/g
  let match: RegExpExecArray | null
  while ((match = dashRe.exec(comment))) {
    const rest = comment.slice(match.index + 1)
    const stop = rest.search(/[();]/)
    const segment = (stop === -1 ? rest : rest.slice(0, stop)).trim()
    if (!/^[a-z][\w-]*(?:\s*\/\s*[a-z][\w-]*)+$/i.test(segment)) continue
    const tokens = segment.split('/').map((token) => token.trim())
    const owner = uniqueOwner(tokens, others)
    if (owner) return { prop: owner, values: tokens }
  }
  return undefined
}

function applicabilityFromComment(propName: string, comment: string, enums: Map<string, string[]>): ApplicabilityGate | undefined {
  const others = new Map<string, Set<string>>()
  for (const [name, values] of enums) {
    if (name !== propName) others.set(name, new Set(values))
  }

  const when = /\bwhen\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/i.exec(comment)
  if (when) {
    const gate = explicitGate(when[1]!, when[2]!, enums)
    if (gate) return gate
  }

  const only = /\b([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"\s*only\b/i.exec(comment)
  if (only) {
    const gate = explicitGate(only[1]!, only[2]!, enums)
    if (gate) return gate
  }

  return gateFromShownBy(comment, others) ?? gateFromOnlyKeyword(comment, others) ?? gateFromDashedSlashList(comment, others)
}
