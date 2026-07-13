import { toPng } from 'html-to-image';

/**
 * Rasterizes a frame's live `<iframe>` content for the perf cull's
 * screenshot fallback (playbook §4/P1 Perf requirements: "cached
 * screenshot (html-to-image via the frame...)"). Works only because the
 * sandbox includes `allow-same-origin` (playbook §5.8) — the iframe is
 * same-origin (`http://127.0.0.1:<port>`), so `iframe.contentDocument`
 * is reachable and `html-to-image` can walk its DOM without tainting a
 * canvas the way a true cross-origin capture would.
 *
 * `captureFn` is injectable so `screenshot-cache`/viewport-swap wiring can
 * be exercised in tests without a real iframe or `html-to-image` — this
 * module itself does no unit-testable *decision* logic (that's
 * `viewport-cull.ts` / `screenshot-cache.ts`), just the DOM boundary.
 */
export type CaptureFn = (node: HTMLElement) => Promise<string>;

export async function captureFrameScreenshot(
  iframe: HTMLIFrameElement,
  captureFn: CaptureFn = toPng,
): Promise<string | null> {
  try {
    const body = iframe.contentDocument?.body;
    if (!body) return null;
    return await captureFn(body);
  } catch {
    // Not-yet-loaded iframe, cross-origin surprise, or html-to-image
    // internal failure — screenshotting is a perf nicety, never load-
    // bearing, so we degrade to "no screenshot" rather than throw.
    return null;
  }
}
