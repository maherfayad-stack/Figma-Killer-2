/**
 * ShortcutsHelpButton — opens the generated keyboard-shortcuts sheet
 * (Settings → Shortcuts, `HelpKeybindingsList`).
 *
 * viewport-01: the sheet has existed since the spotlight landed and was
 * reachable by exactly two paths a first-time user cannot discover — the `?`
 * key (`help.shortcuts`) and typing "shortcuts" into ⌘K. Nothing in the chrome
 * pointed at it. This is that pointer, and its tooltip carries the keycap so
 * clicking it once teaches the key.
 *
 * Same shape as its neighbour `SettingsButton`: it reads the tiny `adminUi`
 * store, NOT the editor store, so hosting it in the global toolbar trailer
 * doesn't drag the editor toolchain into the Plugins / Users / Account
 * bundles. The label comes from the keybindings registry — never hand-typed
 * (`keybindings-registry-single-source.test.ts`).
 */
import { useAdminUi } from '@admin/state/adminUi'
import { CommandIcon } from 'pixel-art-icons/icons/command'
import { Button } from '@ui/components/Button'
import { formatShortcut, getKeybindingForCommand } from '@admin/spotlight/keybindings'

const SHORTCUTS_BINDING = getKeybindingForCommand('help.shortcuts')

export function ShortcutsHelpButton() {
  const openSettings = useAdminUi((s) => s.openSettings)
  const keyLabel = SHORTCUTS_BINDING ? formatShortcut(SHORTCUTS_BINDING.shortcut) : null

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label="Keyboard shortcuts"
      aria-keyshortcuts={SHORTCUTS_BINDING?.ariaKeyshortcuts}
      tooltip={keyLabel ? `Keyboard shortcuts (${keyLabel})` : 'Keyboard shortcuts'}
      onClick={() => openSettings('shortcuts')}
      data-testid="toolbar-shortcuts-btn"
    >
      <CommandIcon size={16} aria-hidden="true" />
    </Button>
  )
}
