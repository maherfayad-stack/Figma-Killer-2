#!/usr/bin/env node
// `pnpm create-file <name>` — copies templates/file-app into files/<name>/
// as a standalone project (no workspace:* deps, own install), then runs
// `pnpm install` inside it to prove it boots with zero dependency on any
// studio package (playbook §4/P0 acceptance + pitfall).
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const name = process.argv[2] ?? 'demo';

if (!/^[a-z0-9-]+$/i.test(name)) {
  console.error(`[create-file] invalid name "${name}" — use letters, numbers, dashes only`);
  process.exit(1);
}

const source = join(repoRoot, 'templates', 'file-app');
const filesDir = join(repoRoot, 'files');
const dest = join(filesDir, name);

if (!existsSync(filesDir)) mkdirSync(filesDir, { recursive: true });

if (existsSync(dest)) {
  console.log(`[create-file] "${name}" already exists at files/${name} — removing and recreating`);
  rmSync(dest, { recursive: true, force: true });
}

cpSync(source, dest, {
  recursive: true,
  filter: (src) => !/node_modules|\/dist(\/|$)|\.turbo/.test(src),
});

// Rename the package so each created file has an independent identity.
const pkgPath = join(dest, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = name;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Remember the most recently created file so `pnpm dev` (no args) targets it.
writeFileSync(join(filesDir, '.last-file'), name);

console.log(`[create-file] created files/${name} from templates/file-app`);
console.log(`[create-file] installing dependencies (standalone, no workspace link)...`);

const install = spawnSync('pnpm', ['install', '--ignore-workspace'], {
  cwd: dest,
  stdio: 'inherit',
});

if (install.status !== 0) {
  console.error('[create-file] pnpm install failed');
  process.exit(install.status ?? 1);
}

console.log(`[create-file] done. Run "pnpm dev" (or "pnpm dev ${name}") to serve it.`);
