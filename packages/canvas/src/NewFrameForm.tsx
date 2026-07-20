import * as React from 'react';
import { isValidFrameName } from './new-frame.js';
import type { CreateFrameFn } from './studio-canvas-types.js';

/**
 * Sub-workstream 2d-ii (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — the
 * "+ New Frame" floating panel, extracted verbatim (same JSX/styles/
 * behavior) from `StudioCanvas.tsx`'s original inline markup so BOTH
 * `TldrawEngineCanvas` and `CustomEngineCanvas` render the exact same
 * control instead of duplicating it — this markup has zero engine
 * dependency (plain HTML form elements), matching the design note's own
 * call-out that this panel is "plain React/HTML with zero tldraw
 * dependency."
 *
 * Owns its own open/name/error/busy state internally (rather than the
 * caller threading it through) since neither engine needs to observe or
 * drive this state from outside — `createFrame`/`defaultFileFolder` are the
 * only two things that cross the boundary, matching `CANVAS-ENGINE-DESIGN.md`'s
 * suggested `NewFrameForm` shape exactly.
 */
export interface NewFrameFormProps {
  createFrame: CreateFrameFn;
  /** The file-folder a new frame is created inside — mirrors
   * `StudioCanvas.tsx`'s original `frames[0]?.fileFolder` computation
   * (the caller passes `useStudioCanvasDaemon`'s own `defaultFileFolder`
   * straight through). */
  defaultFileFolder: string | undefined;
}

export function NewFrameForm({ createFrame, defaultFileFolder }: NewFrameFormProps): React.ReactElement {
  const [newFrameOpen, setNewFrameOpen] = React.useState(false);
  const [newFrameName, setNewFrameName] = React.useState('');
  const [newFrameError, setNewFrameError] = React.useState<string | null>(null);
  const [newFrameBusy, setNewFrameBusy] = React.useState(false);

  const submitNewFrame = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!defaultFileFolder) {
        setNewFrameError('no file-folder known yet');
        return;
      }
      if (!isValidFrameName(newFrameName)) {
        setNewFrameError('name must be PascalCase, e.g. "Testimonials"');
        return;
      }
      setNewFrameBusy(true);
      setNewFrameError(null);
      createFrame({ fileFolder: defaultFileFolder, name: newFrameName })
        .then(() => {
          setNewFrameOpen(false);
          setNewFrameName('');
        })
        .catch((err: unknown) => {
          setNewFrameError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setNewFrameBusy(false);
        });
    },
    [createFrame, defaultFileFolder, newFrameName],
  );

  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, fontFamily: 'system-ui, sans-serif' }}>
      {newFrameOpen ? (
        <form
          onSubmit={submitNewFrame}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            background: '#fff',
            border: '1px solid #d4d4d8',
            borderRadius: 6,
            padding: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          }}
        >
          <input
            aria-label="New frame name"
            placeholder="Testimonials"
            value={newFrameName}
            onChange={(e) => setNewFrameName(e.target.value)}
            autoFocus
            style={{ fontSize: 13, padding: '4px 6px', border: '1px solid #d4d4d8', borderRadius: 4 }}
          />
          {newFrameError && <span style={{ fontSize: 12, color: '#dc2626' }}>{newFrameError}</span>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="submit" disabled={newFrameBusy} style={{ fontSize: 13 }}>
              {newFrameBusy ? 'Creating…' : 'Create'}
            </button>
            <button type="button" onClick={() => setNewFrameOpen(false)} style={{ fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setNewFrameOpen(true)}
          style={{
            fontSize: 13,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #d4d4d8',
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          + New Frame
        </button>
      )}
    </div>
  );
}
