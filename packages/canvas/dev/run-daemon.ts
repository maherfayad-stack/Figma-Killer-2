#!/usr/bin/env tsx
/**
 * P1 acceptance-demo harness (playbook §4/P1, BOUNDARIES: "a thin dev
 * harness under packages/canvas/... to run the acceptance demo"). Boots
 * the REAL sync-daemon (`@ccs/sync-daemon`, unmodified — this script only
 * *consumes* its public `openProject` API) against this repo's own
 * `files/*` projects, plus the dev-only create-frame HTTP endpoint (see
 * `create-frame-server.ts`'s module doc and the P1 report's
 * CHANGE-REQUEST for why that isn't a daemon API yet).
 *
 * Run: `pnpm --filter @ccs/canvas run demo:daemon`
 */
import { fileURLToPath } from 'node:url';
import { openProject } from '@ccs/sync-daemon';
import { CREATE_FRAME_HTTP_PORT, startCreateFrameServer } from './create-frame-server.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  console.log(`[demo] opening project at ${REPO_ROOT}`);
  const daemon = await openProject({ projectRoot: REPO_ROOT });
  console.log(`[demo] daemon control-ws: ws://127.0.0.1:${daemon.daemonPort}`);
  for (const ff of daemon.fileFolders) {
    console.log(`[demo] file-folder "${ff.name}" -> ${ff.devServerUrl} (frames: ${ff.frameNames.join(', ')})`);
  }

  const createFrameServer = startCreateFrameServer(daemon);
  console.log(`[demo] create-frame dev endpoint: http://127.0.0.1:${CREATE_FRAME_HTTP_PORT}/create-frame`);
  console.log(
    `[demo] harness page: pnpm --filter @ccs/canvas run demo:harness -- then open the printed URL with ?daemonPort=${daemon.daemonPort}`,
  );

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[demo] shutting down...');
    await new Promise<void>((resolve) => createFrameServer.close(() => resolve()));
    await daemon.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
