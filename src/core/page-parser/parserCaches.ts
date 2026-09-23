/**
 * parserCaches — the one switch that empties every node-keyed memo the
 * parser keeps between calls.
 *
 * Four modules memoize work against a ts-morph `SourceFile` or `Node`:
 * `staticEvalCore` (module consts), `staticEvalCalls` (provider traces),
 * `componentSources` (barrel re-exports) and `cssInJsExtract` (styled
 * templates). Each is keyed by the file the ANSWER lives in, but the answer
 * was computed by reading OTHER files — an imported dictionary, a barrel's
 * re-export target, a provider in another module. While every load built a
 * fresh `Project`, that never mattered: new `Project`, new nodes, empty
 * memos. Now `server/handlers/studio/workspaceProject.ts` keeps one `Project`
 * per project directory across loads, so an unchanged file's cached answer
 * could outlive a change to the file it was read through.
 *
 * The honest invalidation is "anything changed → forget everything": the
 * memos exist to make ONE load cheap (a barrel consulted once per page, a
 * provider traced once per hook), not to carry work across loads. A load in
 * which nothing changed is answered by `studioLoadMemo.ts` before the parser
 * runs at all, so nothing is lost by resetting here.
 */
import { forgetExportedDeclarationCache } from './componentSources'
import { forgetCssInJsFileCache } from './cssInJsExtract'
import { forgetProviderTraceCache } from './staticEvalCalls'
import { forgetModuleConstCache } from './staticEvalCore'

/** Empties every cross-file parser memo. Call whenever a kept `Project`'s files have changed on disk. */
export function resetParserCaches(): void {
  forgetModuleConstCache()
  forgetProviderTraceCache()
  forgetExportedDeclarationCache()
  forgetCssInJsFileCache()
}
