#!/usr/bin/env node
// `pnpm dev [name]` — serves a file created by `pnpm create-file` standalone
// via its own Vite dev server. Defaults to the most recently created file.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const filesDir = join(repoRoot, 'files');

let name = process.argv[2];
if (!name) {
  const lastFilePath = join(filesDir, '.last-file');
  name = existsSync(lastFilePath) ? readFileSync(lastFilePath, 'utf8').trim() : 'demo';
}

const dest = join(filesDir, name);

if (!existsSync(dest)) {
  console.error(`[dev] files/${name} does not exist yet. Run "pnpm create-file ${name}" first.`);
  process.exit(1);
}

console.log(`[dev] serving files/${name} standalone (vite dev)...`);

const result = spawnSync('pnpm', ['exec', 'vite', '--port', process.env.PORT ?? '5173'], {
  cwd: dest,
  stdio: 'inherit',
});

process.exit(result.status ?? 0);
