/**
 * editorWindowDiagnostics — ERR-26: the editor's OWN window gets the sink every
 * canvas frame already has.
 *
 * Each canvas frame's document has had an `error` + `unhandledrejection`
 * collector since Z5 (`CanvasDiagnosticsInjector`), feeding
 * `canvasDiagnosticsBuffer.ts`. The window the editor itself runs in had
 * nothing: React's root callbacks see render errors, and nothing saw an async
 * failure — a rejected promise in a fire-and-forget handler, a timer that threw.
 * Those were invisible to diagnostics, and the only trace was a console line
 * nobody was reading.
 *
 * This installs the same two listeners on the editor window, classified by the
 * same rules (`runtimeErrorRecording.ts`), into the same buffer — keyed by the
 * editor's `window` and published under {@link EDITOR_DIAGNOSTICS_SCOPE}, so
 * `readFrameDiagnostics(window)` and `subscribeScopeDiagnostics('editor')` read
 * it exactly as they read a frame.
 *
 * It NEVER toasts. An unhandled rejection is the editor's bug, not an
 * operation the user asked for; a card would report the editor's own weather
 * (CLAUDE.md: operation failures toast, this is not one). It logs once, with
 * the module prefix, and records.
 */
import { disposeFrameDiagnostics, ensureFrameDiagnostics } from './canvasDiagnosticsBuffer'
import { recordErrorEvent, recordRejectionEvent } from './runtimeErrorRecording'

/** The scope key the editor window's diagnostics are published under. */
export const EDITOR_DIAGNOSTICS_SCOPE = 'editor'

/** Install the sink on `view`. Returns the uninstall. Idempotent per window through the buffer's own `ensure`. */
export function installEditorWindowDiagnostics(view: Window): () => void {
  ensureFrameDiagnostics(view, EDITOR_DIAGNOSTICS_SCOPE)

  const onError = (event: Event): void => recordErrorEvent(view, event)
  const onRejection = (event: Event): void => {
    console.error('[editor-window] unhandled promise rejection:', (event as { reason?: unknown }).reason)
    recordRejectionEvent(view, event)
  }

  // Capture phase, for the same reason the frame collector uses it: a failing
  // `<img>`/`<script>` in the editor's own document does not bubble.
  view.addEventListener('error', onError, true)
  view.addEventListener('unhandledrejection', onRejection)
  return () => {
    view.removeEventListener('error', onError, true)
    view.removeEventListener('unhandledrejection', onRejection)
    disposeFrameDiagnostics(view)
  }
}
