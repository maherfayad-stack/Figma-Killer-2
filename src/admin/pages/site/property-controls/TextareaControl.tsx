/**
 * TextareaControl — a multi-line text prop, edited the way every other field in
 * the inspector is: type into a local draft, commit ONCE.
 *
 * It used to write on every keystroke. That was one source edit per character
 * and, when the text lived in a call-site attribute, one undo per character; and
 * Enter inserted a newline, which turned `title="First"` into
 * `title={"Alpha\n"}`.
 *
 *   - typing edits the draft and writes nothing;
 *   - Enter or blur commits it (one write, one history entry);
 *   - Shift+Enter inserts a newline, but only when `multiline` — a value that
 *     lands in a JSX attribute or another file's string literal (`multiline`
 *     false) has no honest newline to write, so there Enter is the only key
 *     that means anything and pasted line breaks fold to spaces;
 *   - Escape restores what the field held and writes nothing.
 *
 * `textFieldDraft.ts` holds the commit rule shared with `TextControl`.
 */
import type { ControlProps } from './shared'
import { Textarea } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import { useTextFieldDraft } from './textFieldDraft'

interface TextareaControlProps extends ControlProps<string> {
  rows?: number
  placeholder?: string
  /** Whether Shift+Enter may put a line break in the value. Default true. */
  multiline?: boolean
}

/** One line: a line break in text bound for an attribute reads as a space. */
function foldLineBreaks(raw: string): string {
  return raw.replace(/\s*\r?\n\s*/g, ' ')
}

export function TextareaControl({
  propKey,
  value,
  onChange,
  label,
  rows = 3,
  placeholder,
  multiline = true,
  isOverride,
  disabled,
  layout,
}: TextareaControlProps) {
  const field = useTextFieldDraft({
    value: value ?? '',
    mixed: false,
    resolve: multiline ? (raw) => raw : foldLineBreaks,
    normalizeInput: multiline ? undefined : foldLineBreaks,
    onCommit: (next) => onChange(propKey, next),
  })

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      {/* `autoGrow` — an inspector row is as tall as its value, not as tall
          as the schema's `rows`, which becomes the ceiling. A module's own
          `text` prop holding one short line used to reserve four lines of
          the Design tab's height budget (`docs/features/inspector.md` §6). */}
      <Textarea
        id={`ctrl-${propKey}`}
        value={field.draft}
        rows={rows}
        autoGrow
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => field.onChange(e.target.value)}
        onBlur={(e) => field.onBlur(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // A line break is Shift+Enter, and only where the value can hold one.
            if (e.shiftKey && multiline) return
            e.preventDefault()
            field.commit(e.currentTarget.value)
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            field.revert()
            e.currentTarget.blur()
          }
        }}
      />
    </ControlRow>
  )
}
