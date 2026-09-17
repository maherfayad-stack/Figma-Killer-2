/**
 * The diagnostics scope key a Live/Play screen publishes under (P8).
 *
 * One function rather than two string templates, because the PROVIDER
 * (`CanvasLiveSurface`'s `renderScreen`, inside the frame) and the READER
 * (`PlayCrashCard`, outside it) have to agree exactly, and they live in
 * different components. A typo in one of two literals is a card that silently
 * never appears — the exact class of failure this whole work order exists to
 * remove.
 *
 * The `live:` prefix keeps it out of the board's namespace, where the key is a
 * raw `BoardFrame.id`. A board frame and a Live screen of the same page are two
 * different frames with two different documents and two different buffers.
 */
export function liveScreenDiagnosticsScope(pageId: string): string {
  return `live:${pageId}`
}
