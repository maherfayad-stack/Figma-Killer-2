/**
 * Studio workspace shell — placeholder. Real chrome (dashboard, workspace,
 * sidebars, inspector) lands in Phase 5 (playbook §4/P5, §2). This P0 stub
 * only proves `apps/studio` boots, typechecks, and can import `@ccs/canvas`,
 * `@ccs/protocol`, `@ccs/ui` across the workspace boundary.
 */
import { CANVAS_PACKAGE_PHASE } from '@ccs/canvas';
import { UI_PACKAGE_PHASE } from '@ccs/ui';
import { FrameMetaSchema } from '@ccs/protocol';

export function App() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1>canvas-code-studio</h1>
      <p>Phase 0 placeholder — workspace shell lands in Phase 5.</p>
      <p>
        Wired packages: <code>@ccs/canvas</code> (phase {CANVAS_PACKAGE_PHASE}),{' '}
        <code>@ccs/ui</code> (phase {UI_PACKAGE_PHASE}), <code>@ccs/protocol</code> (
        {Object.keys(FrameMetaSchema.shape).length} FrameMeta top-level fields).
      </p>
    </main>
  );
}
