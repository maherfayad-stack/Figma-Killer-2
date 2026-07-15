import * as React from 'react';
import { Button, Input } from '@ccs/ui';
import { addProject, duplicateProject, listProjects, removeProject, type ProjectEntry } from '../engine/projects-registry.js';

/**
 * Dashboard (playbook §2.6 `dashboard/{projects,files,grid}.cljs`): local
 * projects registry, file grid, create/duplicate/delete. See
 * `projects-registry.ts`'s module doc for the localStorage-backed CR.
 */
export interface DashboardProps {
  daemonUrl: string;
  onOpenProject: (project: ProjectEntry) => void;
}

export function Dashboard({ daemonUrl, onOpenProject }: DashboardProps): React.ReactElement {
  const [projects, setProjects] = React.useState<ProjectEntry[]>(() => listProjects());
  const [newName, setNewName] = React.useState('');

  function refresh(): void {
    setProjects(listProjects());
  }

  return (
    <div className="ccs-root" data-testid="dashboard" style={{ minBlockSize: '100vh', padding: 'var(--ccs-space-6)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockEnd: 'var(--ccs-space-5)' }}>
        <h1 style={{ fontSize: 'var(--ccs-font-size-lg)', margin: 0 }}>canvas-code-studio</h1>
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            addProject({ name: newName.trim(), folder: 'demo', daemonUrl });
            setNewName('');
            refresh();
          }}
        >
          <Input aria-label="New project name" placeholder="New project name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button type="submit" variant="primary">
            New project
          </Button>
        </form>
      </header>

      <div
        data-testid="project-grid"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--ccs-space-4)' }}
      >
        {projects.map((project) => (
          <article
            key={project.id}
            data-testid="project-card"
            style={{
              border: '1px solid var(--ccs-border)',
              borderRadius: 'var(--ccs-radius-lg)',
              padding: 'var(--ccs-space-4)',
              background: 'var(--ccs-bg-panel)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              aria-hidden
              style={{
                blockSize: 100,
                borderRadius: 'var(--ccs-radius-md)',
                background: 'var(--ccs-bg-panel-raised)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--ccs-text-subtle)',
                fontSize: 'var(--ccs-font-size-xs)',
              }}
            >
              {project.folder}
            </div>
            <strong>{project.name}</strong>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant="primary" size="sm" onClick={() => onOpenProject(project)}>
                Open
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  duplicateProject(project.id, `${project.name} copy`);
                  refresh();
                }}
              >
                Duplicate
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  removeProject(project.id);
                  refresh();
                }}
              >
                Delete
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
