import { fileURLToPath } from 'node:url';
import { createSyncFn } from 'synckit';
import type { Options } from 'prettier';

/**
 * Synchronous bridge to prettier's (Promise-only, as of v3) `format()` —
 * see the CHANGE-REQUEST note in `pnpm-workspace.yaml` next to the
 * `synckit` catalog entry. `applyOp`'s frozen signature (ADR-0018 item 1,
 * matching the P0 stub and `golden-runner.test.ts`, which calls
 * `applyOp(...)` without `await`) returns `{newText, uidRemap}`
 * synchronously; prettier v3 no longer offers a sync `format`. `synckit`
 * (also relied on by `eslint-plugin-prettier` for the identical problem)
 * runs the real, unmodified prettier package in a persistent worker thread
 * and blocks the calling thread with `Atomics.wait` until it replies — no
 * filesystem/network IO of its own, just in-process thread synchronization.
 */

interface FormatWorkerInput {
  source: string;
  options: Options;
}

type FormatWorkerFn = (input: FormatWorkerInput) => Promise<string>;

const workerPath = fileURLToPath(new URL('./prettier-worker.mjs', import.meta.url));

let syncFormat: ((input: FormatWorkerInput) => string) | undefined;

function getSyncFormat(): (input: FormatWorkerInput) => string {
  syncFormat ??= createSyncFn<FormatWorkerFn>(workerPath);
  return syncFormat;
}

export function formatSync(source: string, options: Options): string {
  return getSyncFormat()({ source, options });
}
