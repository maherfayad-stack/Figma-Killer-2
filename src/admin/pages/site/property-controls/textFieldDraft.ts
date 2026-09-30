/**
 * textFieldDraft — draft-then-commit for `TextControl` (P2-G, UX-16).
 *
 * `TextControl` used to write on every keystroke: typing `Get started` into a
 * component's `label` prop was eleven store writes, each one a source edit to
 * the instance's call site, and Escape did nothing — there was no pre-focus
 * value to go back to, because the field had already overwritten it. Every
 * other text-entry field in the inspector (`ScrubInput`, `TokenAwareInput`)
 * already works the Figma way, and this one now does too:
 *
 *   - typing edits a local DRAFT; nothing is written;
 *   - blur or Enter COMMITS the draft (Enter keeps focus and re-selects, so
 *     the next keystroke replaces the value — §5.4);
 *   - Escape REVERTS the draft to the value the field showed before, then
 *     leaves the field, and writes nothing.
 *
 * The commit decision is a pure function (`decideTextCommit`) so it is
 * unit-tested without rendering; `useTextFieldDraft` is the React half.
 */
import { useRef, useState } from 'react'

export interface TextCommitInput {
  /** What the field holds at the moment of the commit. */
  raw: string
  /** The value the field was editing — the store's current value. */
  value: string
  /** The field stands for a multi-selection whose members disagree. */
  mixed: boolean
  /** The user typed in this editing session. */
  dirty: boolean
  /** Turns typed text into the value to write (normalisation, unit coercion). */
  resolve: (raw: string) => string
}

/**
 * The value a commit should write, or `null` when it must write nothing.
 *
 * Nothing is written unless the user actually typed. That is the rule the
 * inspector learned from the phantom-write bug `TokenAwareInput` documents:
 * focusing a field and leaving it must never write a declaration nobody
 * typed. It also keeps a Mixed field mixed — its draft is empty, and an
 * untouched blur would otherwise flatten the whole selection to `''`.
 *
 * A typed value equal to the current one writes nothing either (no undo entry
 * that reverts nothing). A Mixed field has no single current value, so any
 * typed value is a real change there.
 */
export function decideTextCommit({ raw, value, mixed, dirty, resolve }: TextCommitInput): string | null {
  if (!dirty) return null
  const resolved = resolve(raw)
  if (!mixed && resolved === value) return null
  return resolved
}

export interface TextFieldDraftOptions {
  value: string
  mixed: boolean
  resolve: (raw: string) => string
  /** Applied to every keystroke before it becomes the draft (e.g. identifier casing). */
  normalizeInput?: (raw: string) => string
  onCommit: (next: string) => void
}

export interface TextFieldDraft {
  /** What the input shows. */
  draft: string
  onChange: (raw: string) => void
  onBlur: (raw: string) => void
  /** Commit the typed value without leaving the field (Enter). */
  commit: (raw: string) => void
  /**
   * Escape: restore the pre-edit value and leave. The caller blurs the input
   * after calling this; the blur that follows writes nothing.
   */
  revert: () => void
  /** Write a value produced by a gesture (arrow-key nudge) straight through. */
  applyImmediately: (next: string) => void
}

export function useTextFieldDraft({
  value,
  mixed,
  resolve,
  normalizeInput,
  onCommit,
}: TextFieldDraftOptions): TextFieldDraft {
  // A Mixed field shows the shared "Mixed" placeholder over an empty draft
  // rather than one member's value.
  const display = mixed ? '' : value
  const [draft, setDraft] = useState(display)
  // Set by a keystroke into the text; cleared by every commit, revert and
  // nudge. `ScrubInput`'s own `typed` bit, for the same reason (§5.4, ERR-1):
  // while it is clear a focused field is only a parked caret, so it follows
  // its value exactly as an unfocused one does and commits nothing.
  const [typed, setTyped] = useState(false)
  const revertingRef = useRef(false)

  // Follow the store while the user is not typing — an undo, a canvas edit,
  // an agent edit, a resync. Text the user IS typing is never overwritten.
  // React 19's adjust-state-during-render idiom, as `TokenAwareInput` uses.
  const [lastDisplay, setLastDisplay] = useState(display)
  if (!typed && display !== lastDisplay) {
    setLastDisplay(display)
    setDraft(display)
  }

  function commit(raw: string) {
    const next = decideTextCommit({ raw, value, mixed, dirty: typed, resolve })
    setTyped(false)
    if (next === null) {
      // Show the resolved form of an unchanged value (a `50` that means
      // `50px`) rather than leaving the raw text in the field.
      setDraft(display)
      return
    }
    setDraft(next)
    onCommit(next)
  }

  return {
    draft,
    onChange: (raw) => {
      setTyped(true)
      setDraft(normalizeInput ? normalizeInput(raw) : raw)
    },
    onBlur: (raw) => {
      // Escape reverts, then blurs. The blur fires before React re-renders the
      // reverted draft, so committing the input's text here would write the
      // very value Escape discarded.
      if (revertingRef.current) {
        revertingRef.current = false
        return
      }
      commit(raw)
    },
    commit,
    revert: () => {
      revertingRef.current = true
      setTyped(false)
      setDraft(display)
    },
    applyImmediately: (next) => {
      setTyped(false)
      setDraft(next)
      onCommit(next)
    },
  }
}
