/**
 * Projects widget — every on-disk studio project (the hand-authored default
 * workspace + every GitHub import, Phase 7B) with an Open action that
 * switches the active studio workspace and jumps into the Site editor's
 * studio (filesystem-as-truth) canvas.
 *
 * Data comes from `useStudioProjects()` → `GET /admin/api/studio/projects`.
 *
 * "Active" detection: the default workspace is active when no override is
 * persisted (`getStudioWorkspaceDir()` returns undefined); an import is
 * active when its `dir` matches the persisted override exactly. Captured
 * once at mount via a lazy `useState` initializer — the active project can
 * only change by leaving this page (opening another project navigates away),
 * so there's nothing to keep in sync while the widget stays mounted.
 *
 * Opening a project: `setStudioWorkspaceDir(...)` (null for the default
 * workspace, the project's `dir` for an import) then navigate to
 * `/admin/site?studio` — the `?studio` param both selects the studio
 * (fsCodemodAdapter) persistence path and, via `syncStudioModeFromUrl()` on
 * the editor's mount, persists studio mode as sticky so a later param-less
 * visit stays in studio.
 */
import { useState } from 'react'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { getStudioWorkspaceDir, setStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { useStudioProjects, type StudioProject } from '../hooks/useStudioProjects'
import styles from './widgets.module.css'

function kindLabel(kind: StudioProject['kind']): string {
  return kind === 'workspace' ? 'workspace' : 'imported'
}

export function ProjectsWidget({ span, editing }: DashboardWidgetRendererProps) {
  const projects = useStudioProjects()
  const isLoading = projects === null
  const rows = projects ?? []
  const isEmpty = !isLoading && rows.length === 0
  const navigate = useAdminNavigate()

  // Captured once at mount — see doc comment above for why this doesn't
  // need to react to later changes while the widget stays mounted.
  const [activeDir] = useState(() => getStudioWorkspaceDir() ?? null)

  function isActive(project: StudioProject): boolean {
    return project.kind === 'workspace' ? activeDir === null : activeDir === project.dir
  }

  function openProject(project: StudioProject) {
    setStudioWorkspaceDir(project.kind === 'workspace' ? null : project.dir)
    navigate('/admin/site?studio')
  }

  return (
    <Widget
      widgetId="projects"
      title="Projects"
      icon={FolderGlyphIcon}
      tint="lilac"
      span={span}
      editing={editing}
      loading={isLoading}
    >
      {isEmpty && (
        <p className={cn(styles.feedTime, styles.feedEmpty)}>
          No projects yet — import one from GitHub in the Site editor's studio mode.
        </p>
      )}
      {!isLoading && !isEmpty && (
        <div className={styles.projectList}>
          {rows.map((project) => {
            const active = isActive(project)
            return (
              <div key={project.dir} className={styles.projectRow}>
                <span className={styles.projectInfo}>
                  <span className={styles.projectName}>
                    {project.name}
                    {active && <span className={cn(styles.dot, styles.dotGreen)} title="Active" />}
                  </span>
                  <span className={styles.projectMeta}>
                    {kindLabel(project.kind)} · {project.pageCount} page{project.pageCount === 1 ? '' : 's'}
                  </span>
                </span>
                <Button
                  variant={active ? 'ghost' : 'secondary'}
                  size="sm"
                  onClick={() => openProject(project)}
                  disabled={active}
                >
                  {active ? 'Active' : 'Open'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Widget>
  )
}
