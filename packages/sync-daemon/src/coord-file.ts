import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Runtime coordination file — playbook §4/P1 step 7 + ADR-0012:
 * `<projectRoot>/.studio/daemon.json`. Ports + pids ONLY — no design/scene
 * state (that lives exclusively in each file-folder's own
 * `.studio/canvas.json`, per the One Rule). Ephemeral: written on daemon
 * start, removed on clean shutdown. Gitignored via the root `/.studio/`
 * entry (rooted so it does NOT also match nested `.studio/` dirs inside
 * `templates/file-app/` or `files/<name>/`, which are unrelated and, for
 * `files/**`, already covered by the existing `files/` ignore rule).
 */

export interface DaemonCoordFileFileFolder {
  name: string;
  port: number;
  pid: number;
}

export interface DaemonCoordFile {
  daemonPort: number;
  pid: number;
  fileFolders: DaemonCoordFileFileFolder[];
  startedAt: string;
}

function coordFilePath(projectRoot: string): string {
  return join(projectRoot, '.studio', 'daemon.json');
}

export async function writeDaemonCoordFile(
  projectRoot: string,
  data: DaemonCoordFile,
): Promise<void> {
  const dir = join(projectRoot, '.studio');
  await mkdir(dir, { recursive: true });
  const file = coordFilePath(projectRoot);
  const tmp = join(dir, `.daemon.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export async function readDaemonCoordFile(projectRoot: string): Promise<DaemonCoordFile | null> {
  try {
    const raw = await readFile(coordFilePath(projectRoot), 'utf8');
    return JSON.parse(raw) as DaemonCoordFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function removeDaemonCoordFile(projectRoot: string): Promise<void> {
  await rm(coordFilePath(projectRoot), { force: true });
}
