import { FrameMetaSchema, type FrameMeta } from '@ccs/protocol';

/**
 * HTTP access into a file-folder's own Vite dev server — used for two
 * things the ADR-0013 control-ws wire format does not cover (both
 * verified live against a real `files/demo` Vite server, see the P1
 * report's CHANGE-REQUEST section for why this is a pragmatic client-side
 * workaround rather than a daemon change):
 *
 * 1. Reading `.studio/canvas.json` content. Vite's dev server serves any
 *    file under the file-folder root over plain HTTP, dotfiles included
 *    (confirmed: `GET /.studio/canvas.json` → 200 with the raw JSON) — so
 *    the canvas package can fetch a file-folder's current geometry
 *    directly from `new URL(devServerUrl).origin`, without a new daemon
 *    API.
 * 2. Checking whether a frame source file exists on disk, to satisfy
 *    ADR-0013's "canvas infers add vs remove via existsSync" directive
 *    from a browser context that has no `fs.existsSync`. `GET
 *    /src/frames/<Name>.tsx` always returns HTTP 200 from Vite (SPA
 *    fallback serves `index.html` for unknown paths instead of a 404),
 *    but the `Content-Type` response header reliably differs: an existing
 *    source file is served as `text/javascript` (Vite's transformed ESM
 *    module), a missing one falls back to `text/html`.
 */

export type FetchLike = (input: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** Fetch + parse a file-folder's `.studio/canvas.json` via its Vite dev
 * server. Returns `null` on any failure (network error, 404, invalid
 * JSON, schema mismatch) — callers fall back to computed default
 * geometry, mirroring how the daemon's own `readCanvasJson` treats a
 * missing file as "no geometry yet" rather than an error. */
export async function fetchCanvasJson(
  devServerOrigin: string,
  fetchImpl: FetchLike = fetch,
): Promise<FrameMeta | null> {
  try {
    const res = await fetchImpl(`${devServerOrigin}/.studio/canvas.json`);
    if (!res.ok) return null;
    const parsed = FrameMetaSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const JS_CONTENT_TYPE_PREFIXES = ['text/javascript', 'application/javascript'];

/** Probe whether `src/frames/<name>.tsx` exists on disk, via the
 * Content-Type heuristic documented above. `relFramePath` is file-folder-
 * relative, e.g. "src/frames/Hero.tsx". */
export async function checkFrameSourceExists(
  devServerOrigin: string,
  relFramePath: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${devServerOrigin}/${relFramePath}`);
    if (!res.ok) return false;
    const contentType = res.headers.get('content-type') ?? '';
    return JS_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix));
  } catch {
    return false;
  }
}

/** `new URL(devServerUrl).origin` — pulled out as a named helper (rather
 * than inlined at every call site) purely so intent reads clearly at the
 * call sites; `URL` itself needs no test coverage. */
export function originOf(devServerUrl: string): string {
  return new URL(devServerUrl).origin;
}
