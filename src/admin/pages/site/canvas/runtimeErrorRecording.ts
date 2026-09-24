/**
 * runtimeErrorRecording — how one window's `error` and `unhandledrejection`
 * events become diagnostics-buffer entries (`canvasDiagnosticsBuffer.ts`).
 *
 * Split out of `CanvasDiagnosticsInjector.tsx` so the two listeners that
 * collect the SAME kind of failure — each canvas frame's document, and (ERR-26)
 * the editor's own window (`editorWindowDiagnostics.ts`) — classify it with
 * one implementation: a resource `<img>` that 404s, an uncaught exception, a
 * rejected promise, and a module that did not resolve read the same wherever
 * they happen.
 */
import {
  asErrorEventLike,
  describeErrorValue,
  errorStackOf,
  isElementTarget,
  isModuleResolutionMessage,
  resourceElementUrl,
  RESOURCE_ERROR_TAGS,
} from '@core/studio-runtime'
import { recordFrameDiagnostic } from './canvasDiagnosticsBuffer'

export function recordErrorEvent(view: Window, event: Event): void {
  const target = event.target
  // A resource error's target is the failing ELEMENT and the event carries no
  // message. Checked first: an ErrorEvent's target is the window itself.
  if (target && target !== view && isElementTarget(target) && RESOURCE_ERROR_TAGS.has(target.tagName)) {
    const url = resourceElementUrl(target)
    const tagName = target.tagName.toLowerCase()
    // A module `<script>` that fails to load is a resolution failure, not a
    // missing picture — same code the thrown-specifier case uses, so both
    // shapes of the same problem read alike.
    const isModuleScript = target.tagName === 'SCRIPT' && target.getAttribute('type') === 'module'
    // The failing element's own node id, when it has one: a Studio node id is a
    // source position, so this is what turns "an image 404'd" into "line 42 of
    // Checkout.tsx points at a file that is not there".
    const nodeId = target.closest?.('[data-node-id]')?.getAttribute('data-node-id') ?? ''
    recordFrameDiagnostic(view, {
      kind: 'resource',
      code: isModuleScript
        ? 'module-resolution-failed'
        : 'asset-load-failed',
      message: url
        ? `<${tagName}> failed to load ${url}`
        : `<${tagName}> failed to load (no src/href attribute)`,
      ...(url ? { url } : {}),
      tagName,
      ...(nodeId ? { nodeId } : {}),
    })
    return
  }

  const errorEvent = asErrorEventLike(event)
  const message = errorEvent?.message || describeErrorValue(errorEvent?.error) || 'Uncaught error (no message reported).'
  recordFrameDiagnostic(view, {
    kind: 'uncaughtError',
    code: isModuleResolutionMessage(message)
      ? 'module-resolution-failed'
      : 'runtime-uncaught-error',
    message,
    ...(errorEvent?.filename ? { url: errorEvent.filename } : {}),
    ...(typeof errorEvent?.lineno === 'number' && errorEvent.lineno > 0 ? { line: errorEvent.lineno } : {}),
    ...(typeof errorEvent?.colno === 'number' && errorEvent.colno > 0 ? { column: errorEvent.colno } : {}),
    ...(errorStackOf(errorEvent?.error) ? { stack: errorStackOf(errorEvent?.error) } : {}),
  })
}

export function recordRejectionEvent(view: Window, event: Event): void {
  const reason = (event as { reason?: unknown }).reason
  const message = describeErrorValue(reason) || 'Unhandled promise rejection (no reason reported).'
  recordFrameDiagnostic(view, {
    kind: 'unhandledRejection',
    code: isModuleResolutionMessage(message)
      ? 'module-resolution-failed'
      : 'runtime-unhandled-rejection',
    message,
    ...(errorStackOf(reason) ? { stack: errorStackOf(reason) } : {}),
  })
}
