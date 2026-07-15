/**
 * Local projects registry backing the Dashboard (playbook §2.6 / §4/P5:
 * "local projects registry (`~/.studio/projects.json`)").
 *
 * CR (scope boundary, flagged not silently decided): a REAL
 * `~/.studio/projects.json` requires filesystem access the studio SPA
 * doesn't have on its own, and this phase's rules pin P5 to `apps/studio` +
 * `packages/ui` only — no `packages/sync-daemon` control-message additions
 * (that package isn't in this phase's authorized-touch list, and the
 * P4↔P5 partition (ADR-0022) reserves daemon changes for whichever phase
 * actually needs them; Phase 6/Backend is the playbook's real home for a
 * server-backed project registry, §4/P6). This module is a faithful UI
 * SHELL over the same shape (`{name, folder, thumbnailUrl?}[]`), persisted
 * to `localStorage` as a stand-in so the Dashboard is fully interactive
 * (create/duplicate/delete) without inventing a filesystem API here. A
 * real daemon-backed registry is a drop-in swap for this module's
 * functions later.
 */

export interface ProjectEntry {
  id: string;
  name: string;
  /** `files/<folder>` relative to the monorepo project root — matches the
   * `fileFolder` addressing already used throughout the control-ws
   * protocol (ADR-0013). */
  folder: string;
  /** Control-ws URL for the daemon already serving this project (dev-mode
   * convenience — a real backend would resolve this server-side, P6). */
  daemonUrl: string;
  createdAt: string;
}

const STORAGE_KEY = 'ccs.studio.projects.v1';

function readAll(): ProjectEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProjectEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(projects: ProjectEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function listProjects(): ProjectEntry[] {
  return readAll();
}

export function addProject(entry: Omit<ProjectEntry, 'id' | 'createdAt'>): ProjectEntry {
  const project: ProjectEntry = {
    ...entry,
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  writeAll([...readAll(), project]);
  return project;
}

export function removeProject(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id));
}

export function duplicateProject(id: string, newName: string): ProjectEntry | null {
  const source = readAll().find((p) => p.id === id);
  if (!source) return null;
  return addProject({ name: newName, folder: source.folder, daemonUrl: source.daemonUrl });
}

/** Ensures at least the repo's own `files/demo` project is registered, so
 * the Dashboard is never empty on a fresh profile (dev/e2e convenience —
 * mirrors how `files/demo` is already the repo's canonical fixture
 * project, used by every earlier phase's own e2e). */
export function ensureDefaultProject(daemonUrl: string): void {
  const existing = readAll();
  if (existing.some((p) => p.folder === 'demo')) return;
  addProject({ name: 'Demo', folder: 'demo', daemonUrl });
}
