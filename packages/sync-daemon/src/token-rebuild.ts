import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { buildTokenOutputs } from '@ccs/tokens';

/**
 * Token rebuild pipeline (playbook §4/P4, ADR-0022): on any
 * `design-system/src/tokens/tokens.js` change (IDE edit, picked up by
 * `watchDesignSystem`'s `tokens-changed`, OR a token-CRUD control message
 * — see `token-crud.ts`), rebuild the emitted CSS/Tailwind-preset outputs
 * with `@ccs/tokens` (pure) and write them into EVERY file-folder so each
 * one's own `src/tokens.css` + `tokens.preset.js` stays in sync — the
 * file-app template imports both as plain relative files (ZERO `@ccs/*`
 * runtime dep, playbook §4/P0 AUDIT-1 standalone contract; see
 * `templates/file-app/tailwind.config.js` / `src/index.css`), so writing
 * fresh copies is what makes Vite's own file-watch HMR pick the change up
 * — no daemon-side proxying of the file-app's HMR websocket.
 *
 * This is the ONE place the daemon writes into `design-system/` (the
 * `token-crud.ts` write path funnels through the SAME `tokensJsPath`
 * resolution here) — everywhere else `design-system/` stays read-only from
 * the daemon's perspective (ADR-0008 BOUNDARIES; `watcher.ts`'s own doc
 * comment).
 */

export function tokensJsPath(projectRoot: string): string {
  return join(projectRoot, 'design-system', 'src', 'tokens', 'tokens.js');
}

function tokensCssPath(fileFolderRoot: string): string {
  return join(fileFolderRoot, 'src', 'tokens.css');
}

function tokensPresetPath(fileFolderRoot: string): string {
  return join(fileFolderRoot, 'tokens.preset.js');
}

/** Not chokidar-watched by this daemon (only Vite's OWN per-file-folder
 * dev server watches inside `src/`, which is exactly the point — it picks
 * this up as an ordinary HMR-triggering change), so no self-write-tracker
 * marking is needed here (contrast `token-crud.ts`'s write to the
 * daemon-watched `tokens.js` itself). */
async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = dirname(absPath);
  const tmp = join(
    dir,
    `.${basename(absPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, absPath);
}

export type RebuildTokenOutputsResult = { ok: true } | { ok: false; reason: string };

/**
 * Reads `tokensJsPath(projectRoot)`, rebuilds every emitted artifact via
 * `@ccs/tokens`'s pure `buildTokenOutputs`, and atomically writes
 * `src/tokens.css` + `tokens.preset.js` into every given file-folder.
 * Best-effort: a missing or malformed `tokens.js` returns `{ok:false,
 * reason}` rather than throwing — callers (daemon startup, the
 * `tokens-changed` watch handler) decide whether/how to surface that
 * (daemon startup swallows it so a fresh scaffold with no `design-system/`
 * yet still boots; the watch handler skips the `tokens-changed`
 * broadcast on failure so clients never see a "changed" event for a
 * rebuild that didn't actually produce anything new).
 */
export async function rebuildTokenOutputs(
  projectRoot: string,
  fileFolderRoots: readonly string[],
): Promise<RebuildTokenOutputsResult> {
  let sourceText: string;
  try {
    sourceText = await readFile(tokensJsPath(projectRoot), 'utf8');
  } catch (err) {
    return { ok: false, reason: `tokens.js not readable: ${err instanceof Error ? err.message : String(err)}` };
  }

  let outputs: ReturnType<typeof buildTokenOutputs>;
  try {
    outputs = buildTokenOutputs(sourceText);
  } catch (err) {
    return { ok: false, reason: `tokens.js parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const combinedCss = `${outputs.css.light}\n${outputs.css.dark}`;

  await Promise.all(
    fileFolderRoots.flatMap((root) => [
      atomicWriteFile(tokensCssPath(root), combinedCss),
      atomicWriteFile(tokensPresetPath(root), outputs.presetModule),
    ]),
  );

  return { ok: true };
}
