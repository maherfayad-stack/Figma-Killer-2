/**
 * Studio root — Phase 5 chrome (playbook §4/P5, §2). Routes between the
 * Dashboard (local projects registry) and the per-file WorkspaceShell,
 * mounting `@ccs/canvas`'s `StudioCanvas` once a project is opened.
 *
 * The daemon control-ws URL is read from `?daemonPort=` (same convention
 * `packages/canvas`'s P1/P2 dev harness + e2e already use) — this SPA
 * doesn't boot the daemon itself; a dev/e2e harness or a future desktop
 * shell does, the same separation of concerns `@ccs/canvas`'s own dev
 * harness already established.
 */
import * as React from 'react';
import type { EngineApi } from './engine/engine-api.js';
import { createMockEngineApi } from './engine/mock-engine-api.js';
import { loadRealEngineApi } from './engine/real-engine-api.js';
import { ensureDefaultProject, renameProject, type ProjectEntry } from './engine/projects-registry.js';
import { readDaemonPort } from './engine/query-params.js';
import { useWorkspaceStore } from './workspace/workspace-store.js';
import { Dashboard } from './dashboard/Dashboard.js';
import { WorkspaceShell } from './workspace/WorkspaceShell.js';

const daemonUrl = `ws://127.0.0.1:${readDaemonPort()}`;
// Seeded at MODULE load (not inside a `useEffect`) so it lands in
// localStorage before `Dashboard`'s lazy `useState(() => listProjects())`
// initializer ever runs — an effect would only populate it AFTER the first
// (empty) render, leaving the Dashboard's initial paint with no projects.
ensureDefaultProject(daemonUrl);

/** Real-P4 wiring (ADR-0022 integration pass): the REAL `@ccs/tokens`
 * catalog is only reachable through the Vite dev-server bridge (see
 * `../vite.config.ts`'s module doc for why), so it's loaded asynchronously
 * at boot. Falls back to the mock adapter — logged, not silent — if the
 * bridge isn't reachable (e.g. a production static build with no Node dev
 * server behind it; see that CR) so the chrome still renders instead of
 * hard-failing. Kicked off at MODULE load (not per-render) so re-mounts
 * (React StrictMode) don't refetch. */
const engineApiPromise: Promise<EngineApi> = loadRealEngineApi().catch((err: unknown) => {
  console.warn('@ccs/studio: real @ccs/tokens engine API unavailable, falling back to the mock adapter.', err);
  return createMockEngineApi();
});

export function App(): React.ReactElement {
  const [openProject, setOpenProject] = React.useState<ProjectEntry | null>(null);
  const [engineApi, setEngineApi] = React.useState<EngineApi | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void engineApiPromise.then((api) => {
      if (!cancelled) setEngineApi(api);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!engineApi) {
    return (
      <div className="ccs-root" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minBlockSize: '100vh' }}>
        Loading…
      </div>
    );
  }

  if (!openProject) {
    return <Dashboard daemonUrl={daemonUrl} onOpenProject={setOpenProject} />;
  }

  return (
    <WorkspaceShell
      fileName={openProject.name}
      projectId={openProject.id}
      daemonUrl={openProject.daemonUrl}
      engineApi={engineApi}
      onBackToDashboard={() => {
        useWorkspaceStore.getState().clearSelection();
        setOpenProject(null);
      }}
      onRenameFile={(name) => {
        const updated = renameProject(openProject.id, name);
        if (updated) setOpenProject(updated);
      }}
    />
  );
}
