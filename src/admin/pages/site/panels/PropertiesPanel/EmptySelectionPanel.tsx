/**
 * EmptySelectionPanel — what the Properties panel shows when nothing is
 * selected (P5-F, UX-9). It used to be one sentence. Figma and Penpot show
 * the page's own properties there, because "nothing selected" is still
 * "looking at a screen":
 *
 *   - **the frame's size** (`FrameSizePanel`, panel-39 — it lives here and
 *     nowhere else);
 *   - **Screen**: copy the open screen as a PNG — the same capture ⌘⇧C makes
 *     with nothing selected (`canvas/copyAsPng.ts`), one click away instead of
 *     one shortcut the user has to already know;
 *   - **Snapping**: the two snap toggles (IX-5e), with their state visible —
 *     the same store preference ⌘⇧' / ⌘' and the zoom menu flip.
 *
 * A short hint closes it, so the panel still says what selecting does.
 * Nothing here writes the user's source; every control reads or writes
 * editor state, or reads the board.
 */
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { getKeybindingForCommand, shortcutLabelFor } from '@admin/spotlight/keybindings'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { Switch } from '@ui/components/Switch'
import { copySelectionAsPng } from '@site/canvas/copyAsPng'
import { FrameSizePanel } from './FrameSizePanel'
import styles from './EmptySelectionPanel.module.css'

export function EmptySelectionPanel() {
  // The title only — a string, so the panel does not re-render on every edit
  // to the page it names (`site.pages` is replaced on each one).
  const screenTitle = useEditorStore((s) => selectActiveCanvasPage(s)?.title ?? null)
  const isVisualComponent = useEditorStore((s) => s.activeDocument?.kind === 'visualComponent')
  const snapToObjects = useEditorStore((s) => s.snapPreferences.objects)
  const snapToGuides = useEditorStore((s) => s.snapPreferences.guides)
  const toggleSnapPreference = useEditorStore((s) => s.toggleSnapPreference)

  return (
    <div className={styles.panel} data-testid="empty-selection-panel">
      <FrameSizePanel />
      {screenTitle && !isVisualComponent && (
        <Section title="Screen" forceOpen flush>
          <div className={styles.body}>
            <p className={styles.screenName} title={screenTitle}>{screenTitle}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={copySelectionAsPng}
              tooltip="Copy this screen to the clipboard as a PNG"
              tooltipShortcut={shortcutLabelFor('export.copySelectionPng')}
              data-testid="empty-selection-copy-png"
            >
              Copy as PNG
            </Button>
          </div>
        </Section>
      )}
      <Section title="Snapping" forceOpen flush>
        <div className={styles.body}>
          <label className={styles.switchRow}>
            <span>Snap to objects</span>
            <Switch
              checked={snapToObjects}
              onCheckedChange={() => toggleSnapPreference('objects')}
              switchSize="sm"
              aria-label="Snap to objects"
              aria-keyshortcuts={getKeybindingForCommand('canvas.toggleSnapToObjects')?.ariaKeyshortcuts}
              data-testid="empty-selection-snap-objects"
            />
          </label>
          <label className={styles.switchRow}>
            <span>Snap to ruler guides</span>
            <Switch
              checked={snapToGuides}
              onCheckedChange={() => toggleSnapPreference('guides')}
              switchSize="sm"
              aria-label="Snap to ruler guides"
              aria-keyshortcuts={getKeybindingForCommand('canvas.toggleSnapToGuides')?.ariaKeyshortcuts}
              data-testid="empty-selection-snap-guides"
            />
          </label>
        </div>
      </Section>
      <p className={styles.hint}>Select a layer on the canvas to edit it.</p>
    </div>
  )
}
