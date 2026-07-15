// Plain-JS (not .ts) synckit worker entry point — Node's worker_threads
// loader executes this file directly, no TypeScript transpilation step, so
// it must be runnable as-is. See `prettier-sync.ts` for why this exists
// (prettier v3's public `format()` is Promise-only; the frozen `applyOp`
// signature is synchronous).
import { format } from 'prettier';
import { runAsWorker } from 'synckit';

runAsWorker(async ({ source, options }) => format(source, options));
