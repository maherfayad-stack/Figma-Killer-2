/**
 * The `studio_page_diagnostics` finding-code vocabulary — one definition,
 * shared by the collector that PRODUCES a finding (the canvas injector, in the
 * browser) and the tool that REPORTS it (`server/ai/mcp/tools/studio/
 * pageDiagnostics.ts`).
 *
 * It lives in `@core/ai` rather than beside either one because both sides need
 * it and neither may import the other: a server tool cannot reach into
 * `src/admin/`, and the canvas cannot import a server module. A second copy on
 * either side would drift, and a diagnostic whose code means something
 * different depending on who is reading it is worse than no code at all.
 *
 * Same contract as `fidelityCodes.ts`: kebab-case, and a code that has shipped
 * is frozen. Add a new one rather than repurposing an existing one, and keep
 * `docs/features/mcp-connectors.md`'s table in step — `pageDiagnostics.test.ts`
 * gates that every code here appears there and vice versa.
 */

export type PageDiagnosticCode =
  | 'runtime-uncaught-error'
  | 'runtime-unhandled-rejection'
  | 'runtime-console-error'
  | 'asset-load-failed'
  | 'module-resolution-failed'
  | 'network-request-failed'

export interface PageDiagnosticCodeDef {
  code: PageDiagnosticCode
  /** Short human title, the same string the doc table uses. */
  title: string
  severity: 'error' | 'warning'
  /** What to actually DO about it — returned on every finding, so a weaker model has a next step and not just a symptom. */
  fix: string
}

export const PAGE_DIAGNOSTIC_CODES: Readonly<Record<PageDiagnosticCode, PageDiagnosticCodeDef>> = {
  'runtime-uncaught-error': {
    code: 'runtime-uncaught-error',
    title: 'Uncaught exception',
    severity: 'error',
    fix: 'The screen did not finish rendering — nothing about its CSS is meaningful until this throws no more. Read the named file:line, fix the exception, then screenshot again.',
  },
  'runtime-unhandled-rejection': {
    code: 'runtime-unhandled-rejection',
    title: 'Unhandled promise rejection',
    severity: 'error',
    fix: 'An async call failed with no catch. Handle the rejection where it is awaited, or render a fallback for the failed state.',
  },
  'runtime-console-error': {
    code: 'runtime-console-error',
    title: 'console.error from the frame',
    severity: 'warning',
    fix: "React reports a failed render, an invalid hook call, a key warning and a hydration mismatch through this channel. Read the message: it usually names the component and the exact rule broken.",
  },
  'asset-load-failed': {
    code: 'asset-load-failed',
    title: 'Asset failed to load',
    severity: 'error',
    fix: 'The referenced file is not where the markup says it is. Check the import/src path against the workspace, or land the file with studio_upload_asset / studio_fetch_remote_asset before pointing at it.',
  },
  'module-resolution-failed': {
    code: 'module-resolution-failed',
    title: 'Module specifier did not resolve',
    severity: 'error',
    fix: 'Either the dependency is not installed (studio_install_deps) or the relative path is wrong. A screenshot of this page shows a blank frame, not a styling problem.',
  },
  'network-request-failed': {
    code: 'network-request-failed',
    title: 'Request from the frame failed',
    severity: 'warning',
    fix: 'A fetch the screen makes at runtime rejected or answered 4xx/5xx. Expected when a screen calls a real backend that is not running — only act on it when the screen depends on that data to render.',
  },
}

export const PAGE_DIAGNOSTIC_CODE_LIST: readonly PageDiagnosticCode[] = Object.keys(
  PAGE_DIAGNOSTIC_CODES,
) as PageDiagnosticCode[]
