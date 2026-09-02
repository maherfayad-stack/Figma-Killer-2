/**
 * NewProjectDialog — the form-factor question `DashboardPage`'s "New project"
 * asks before it scaffolds anything.
 *
 * A project is a repository of screens, and the screens in one repository are
 * almost always the same shape. Asking once here is what lets every page added
 * later — from the board, from "New page", or by the agent — open at the right
 * width without being resized by hand. The answer becomes the project's
 * `frameDefaults`; see `@core/studio-board`'s `platformPresets.ts` for the two
 * presets and why they are the numbers they are.
 *
 * The name field is optional and stays optional: leaving it blank preserves
 * the previous one-click behaviour exactly (the server auto-names the project
 * `Untitled`, `Untitled 2`, …), so the dialog adds a choice without adding a
 * required step.
 */
import { useState, type FormEvent } from 'react'
import { PLATFORM_PRESETS, DEFAULT_PROJECT_PLATFORM, type ProjectPlatform } from '@core/studio-board'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { FormField } from '@ui/components/FormField'
import styles from './NewProjectDialog.module.css'

interface NewProjectDialogProps {
  open: boolean
  /** True while the create request is in flight — disables both footer buttons. */
  busy: boolean
  onClose: () => void
  onCreate: (options: { name?: string; platform: ProjectPlatform }) => void
}

export function NewProjectDialog({ open, busy, onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState<ProjectPlatform>(DEFAULT_PROJECT_PLATFORM)

  // Reopening the dialog after a cancel (or after a failed create) starts from
  // the defaults rather than the abandoned attempt's half-filled state.
  //
  // Adjusted during RENDER on the `open` transition, not in an effect: an
  // effect that calls setState synchronously causes the cascading re-render
  // `react-hooks/set-state-in-effect` exists to prevent. This is the pattern
  // React documents for "reset state when a prop changes", and the one
  // `StudioPagesTree` already uses for its own active-page sync.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName('')
      setPlatform(DEFAULT_PROJECT_PLATFORM)
    }
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (busy) return
    const trimmed = name.trim()
    onCreate({ name: trimmed || undefined, platform })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      eyebrow="Studio"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        <FormField label="Name" description="Optional — leave blank to name it later.">
          <Input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Untitled"
            aria-label="Project name"
          />
        </FormField>

        {/*
          A radio group, not two buttons.

          It is the honest control — two mutually exclusive answers to one
          question — and it is also the only one that works here. Built on the
          `Button` primitive these cards inherited its pill radius, its fixed
          32px height and its `white-space: nowrap`, so a card-shaped choice
          came out as a lozenge with the content spilling past both ends.
          Overriding all of that would have been fighting the primitive to
          make it stop being a button. The BTN-3 gate governs bare button
          elements, and a radio input is not one.

          The input stays a real, focusable `<input type="radio">` covering the
          card, so the group keeps native arrow-key navigation and screen-reader
          semantics for free — it is only invisible.
        */}
        <fieldset className={styles.platformField}>
          <legend className={styles.legend}>What are you designing?</legend>
          <p className={styles.legendHint}>
            Sets the size every screen in this project starts at. You can resize any frame later.
          </p>
          <div className={styles.options}>
            {PLATFORM_PRESETS.map((preset) => (
              <label
                key={preset.platform}
                className={styles.option}
                data-selected={preset.platform === platform ? 'true' : undefined}
              >
                <input
                  type="radio"
                  name="studio-project-platform"
                  className={styles.radio}
                  value={preset.platform}
                  checked={preset.platform === platform}
                  onChange={() => setPlatform(preset.platform)}
                />
                {/* Proportion IS the explanation, so the frame this choice
                    produces is drawn rather than described. Both illustrations
                    share a fixed-height stage so the two cards' text lines up. */}
                <span className={styles.stage} aria-hidden="true">
                  {preset.platform === 'mobile' ? <PhoneIllustration /> : <DesktopIllustration />}
                </span>
                <span className={styles.optionLabel}>{preset.label}</span>
                <span className={styles.optionMeta}>
                  {preset.width} × {preset.height}
                </span>
                <span className={styles.optionDescription}>{preset.description}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  )
}

/*
 * The two device drawings.
 *
 * Hand-drawn SVG rather than an icon from the vendored set, because these are
 * not icons: they are a to-proportion picture of the artboard each choice
 * produces, and the aspect ratio is the whole message. Everything is
 * `currentColor`, so the card tints the drawing by setting `color` — see
 * `.illustration` in the module.
 */
function PhoneIllustration() {
  return (
    <svg className={styles.illustration} width="26" height="46" viewBox="0 0 26 46" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="24" height="44" rx="4.5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.5" />
      {/* Speaker slot and home indicator — the two marks that read "phone" at 26px. */}
      <rect x="9" y="4.2" width="8" height="1.6" rx="0.8" fill="currentColor" fillOpacity="0.55" />
      <rect x="8" y="40" width="10" height="1.6" rx="0.8" fill="currentColor" fillOpacity="0.55" />
    </svg>
  )
}

function DesktopIllustration() {
  return (
    <svg className={styles.illustration} width="64" height="46" viewBox="0 0 64 46" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="62" height="36" rx="3.5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.5" />
      {/* Browser chrome: the rule and three window dots. */}
      <path d="M1.75 10h60.5" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.45" />
      <circle cx="6" cy="5.6" r="1.1" fill="currentColor" fillOpacity="0.55" />
      <circle cx="10" cy="5.6" r="1.1" fill="currentColor" fillOpacity="0.55" />
      <circle cx="14" cy="5.6" r="1.1" fill="currentColor" fillOpacity="0.55" />
      {/* Stand. */}
      <rect x="27" y="37" width="10" height="4" fill="currentColor" fillOpacity="0.4" />
      <rect x="20" y="41" width="24" height="2.4" rx="1.2" fill="currentColor" fillOpacity="0.6" />
    </svg>
  )
}
