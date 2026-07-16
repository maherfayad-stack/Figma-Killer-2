import * as React from 'react';
import { Button, DropdownMenu, Icon, Input } from '@ccs/ui';
import { addProject, duplicateProject, listProjects, removeProject, type ProjectEntry } from '../engine/projects-registry.js';
import './Dashboard.css';

/**
 * Dashboard (playbook §2.6 `dashboard/{projects,files,grid}.cljs`, restyled
 * to `.orchestrator/PENPOT-FIDELITY-SPEC.md` §4): local projects registry,
 * file grid, create/duplicate/delete. See `projects-registry.ts`'s module
 * doc for the localStorage-backed CRUD this shell sits on top of.
 *
 * Shell = Penpot's 3-column dashboard chrome (mini-rail | sidebar |
 * content), adapted per spec §4 "Our adaptation": no teams/server, so the
 * mini-rail is decorative and the sidebar's workspace switcher is a static
 * "Local" label. Content owns its own header row (title + create control)
 * above the scrollable project grid, so the outer shell only needs a
 * single-row 3-column grid (each column fills the full block-size) rather
 * than literally reproducing Penpot's `52px 1fr` row split, which existed
 * to align a *global* header across all three columns — a header we don't
 * have (our per-column headers differ: mini-rail has none, sidebar's
 * "header" is the workspace switcher, content's is 64px).
 */
export interface DashboardProps {
  daemonUrl: string;
  onOpenProject: (project: ProjectEntry) => void;
}

export function Dashboard({ daemonUrl, onOpenProject }: DashboardProps): React.ReactElement {
  const [projects, setProjects] = React.useState<ProjectEntry[]>(() => listProjects());
  const [query, setQuery] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const newNameRef = React.useRef<HTMLInputElement>(null);

  function refresh(): void {
    setProjects(listProjects());
  }

  function createProject(name: string): void {
    if (!name.trim()) return;
    addProject({ name: name.trim(), folder: 'demo', daemonUrl });
    setNewName('');
    refresh();
  }

  const visibleProjects = query.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : projects;

  return (
    <div
      className="ccs-root"
      data-testid="dashboard"
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 256px 1fr',
        blockSize: '100vh',
        background: 'var(--ccs-bg-canvas)',
        overflow: 'hidden',
      }}
    >
      {/* Mini-rail (40px) — decorative per spec §4 adaptation: our dashboard
       * has no teams/orgs to switch between, so this is just a mark + a
       * settings glyph, not a functional nav rail. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBlock: 'var(--ccs-space-3)',
          background: 'var(--ccs-bg-panel)',
          borderInlineEnd: '1px solid var(--ccs-border)',
        }}
      >
        <div
          aria-hidden
          style={{
            inlineSize: 24,
            blockSize: 24,
            borderRadius: 'var(--ccs-radius-sm)',
            background: 'var(--ccs-accent)',
            color: 'var(--ccs-accent-contrast)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          C
        </div>
        <Button variant="icon" size="sm" aria-label="Settings">
          <Icon name="settings" size={16} />
        </Button>
      </div>

      {/* Sidebar (256px) */}
      <aside
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--ccs-space-6)',
          paddingBlock: 'var(--ccs-space-4)',
          paddingInline: 'var(--ccs-space-4)',
          background: 'var(--ccs-bg-panel)',
          borderInlineEnd: '1px solid var(--ccs-border)',
          overflow: 'hidden',
        }}
      >
        {/* Workspace switcher (static — no teams/orgs, spec §4 adaptation) */}
        <div
          style={{
            flexShrink: 0,
            blockSize: 48,
            borderRadius: 'var(--ccs-radius)',
            border: '1px solid var(--ccs-border)',
            display: 'flex',
            alignItems: 'center',
            paddingInline: 'var(--ccs-space-3)',
            fontWeight: 500,
          }}
        >
          Local
        </div>

        {/* Search */}
        <div style={{ flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Icon
            name="search"
            size={16}
            style={{ position: 'absolute', insetInlineStart: 10, color: 'var(--ccs-text-subtle)', pointerEvents: 'none' }}
          />
          <input
            type="search"
            aria-label="Search projects"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              inlineSize: '100%',
              blockSize: 40,
              borderRadius: 'var(--ccs-radius)',
              border: '1px solid var(--ccs-border)',
              background: 'var(--ccs-bg-input)',
              color: 'var(--ccs-text)',
              paddingInlineStart: 34,
              paddingInlineEnd: 'var(--ccs-space-2)',
              fontFamily: 'inherit',
              fontSize: 'var(--ccs-font-size-sm)',
            }}
          />
        </div>

        {/* Nav */}
        <nav style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              paddingInline: 'var(--ccs-space-3)',
              marginBlockEnd: 4,
              fontSize: 'var(--ccs-font-size-sm)',
              fontWeight: 500,
              lineHeight: 1.2,
              textTransform: 'uppercase',
              color: 'var(--ccs-text-muted)',
            }}
          >
            Workspace
          </span>
          <button type="button" className="ccs-sidebar-nav-item is-selected">
            <Icon name="document" size={16} />
            Projects
          </button>
        </nav>

        <div style={{ flex: 1 }} />

        {/* Profile footer */}
        <div
          style={{
            flexShrink: 0,
            borderBlockStart: '1px solid var(--ccs-border)',
            paddingBlockStart: 'var(--ccs-space-3)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--ccs-space-2)',
          }}
        >
          <div
            aria-hidden
            style={{
              inlineSize: 40,
              blockSize: 40,
              borderRadius: '50%',
              flexShrink: 0,
              background: 'var(--ccs-bg-panel-raised)',
              color: 'var(--ccs-text-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="user" size={16} />
          </div>
          <span style={{ fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text-muted)' }}>Guest</span>
        </div>
      </aside>

      {/* Content */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header
          style={{
            flexShrink: 0,
            blockSize: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 'var(--ccs-space-6)',
            borderBlockEnd: '1px solid var(--ccs-border)',
          }}
        >
          <h1 style={{ fontSize: 'var(--ccs-font-size-lg)', fontWeight: 600, margin: 0 }}>Projects</h1>
          <form
            style={{ display: 'flex', gap: 'var(--ccs-space-2)' }}
            onSubmit={(e) => {
              e.preventDefault();
              createProject(newName);
            }}
          >
            <Input
              ref={newNameRef}
              aria-label="New project name"
              placeholder="New project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ inlineSize: 220 }}
            />
            <Button type="submit" variant="primary">
              <Icon name="add" size={16} />
              New project
            </Button>
          </form>
        </header>

        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--ccs-space-4)' }}>
          {projects.length === 0 ? (
            <div
              style={{
                blockSize: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--ccs-space-2)',
                color: 'var(--ccs-text-subtle)',
              }}
            >
              <Icon name="board" size={32} />
              <span>No projects yet</span>
            </div>
          ) : (
            <div
              data-testid="project-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(252px, 1fr))',
                gap: 'var(--ccs-space-6)',
              }}
            >
              {visibleProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={() => onOpenProject(project)}
                  onDuplicate={() => {
                    duplicateProject(project.id, `${project.name} copy`);
                    refresh();
                  }}
                  onDelete={() => {
                    removeProject(project.id);
                    refresh();
                  }}
                />
              ))}
              <button
                type="button"
                className="ccs-add-project-card"
                onClick={() => newNameRef.current?.focus()}
              >
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ccs-space-2)' }}>
                  <Icon name="add" size={16} />
                  Add project
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ProjectCardProps {
  project: ProjectEntry;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/** One dashboard project card (spec §4 "File card"): thumbnail + name +
 * metadata, `onOpen` on click, and a hover-only kebab menu (Open / Duplicate
 * / Delete) replacing the old always-visible button row. */
function ProjectCard({ project, onOpen, onDuplicate, onDelete }: ProjectCardProps): React.ReactElement {
  return (
    <article
      data-testid="project-card"
      className="ccs-project-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // let nested controls (kebab button) handle their own keys
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="ccs-project-kebab-wrap">
        <DropdownMenu
          trigger={({ onClick, 'aria-expanded': expanded }) => (
            <button
              type="button"
              aria-label="Project actions"
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                inlineSize: 28,
                blockSize: 28,
                border: 'none',
                borderRadius: 'var(--ccs-radius-sm)',
                background: 'var(--ccs-bg-overlay)',
                color: 'var(--ccs-icon)',
                cursor: 'pointer',
              }}
            >
              <Icon name="menu" size={16} />
            </button>
          )}
          items={[
            { id: 'open', label: 'Open', onSelect: onOpen },
            { id: 'duplicate', label: 'Duplicate', onSelect: onDuplicate },
            { id: 'delete', label: 'Delete', danger: true, separatorBefore: true, onSelect: onDelete },
          ]}
        />
      </div>

      <div
        aria-hidden
        style={{
          blockSize: 168,
          borderRadius: 'var(--ccs-radius)',
          background: 'var(--ccs-bg-panel-raised)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ccs-text-subtle)',
          fontSize: 'var(--ccs-font-size-sm)',
        }}
      >
        {project.folder}
      </div>

      <div>
        <strong
          style={{
            display: 'block',
            fontSize: 'var(--ccs-font-size-md)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {project.name}
        </strong>
        <span
          style={{
            display: 'block',
            fontSize: 'var(--ccs-font-size-xs)',
            color: 'var(--ccs-text-subtle)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {project.folder}
        </span>
      </div>
    </article>
  );
}
