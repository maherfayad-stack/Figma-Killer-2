import { useMemo } from 'react';
import { getFrame, listFrameNames } from './frames.js';

/**
 * Frame router — reads `?frame=<Name>` and renders that frame full-screen.
 * With no/unknown `frame` param it lists the available frames (dev-only
 * convenience; the studio canvas never hits this branch — it always passes
 * an explicit `?frame=` per iframe, per `.studio/canvas.json`).
 */
export default function App() {
  const frameName = useMemo(() => new URLSearchParams(window.location.search).get('frame'), []);
  const Frame = getFrame(frameName);

  if (Frame) {
    // `Frame` is a lookup into the static `frames` registry (frames.ts), not
    // a component defined inline during render — the router-by-reference
    // pattern this rule otherwise correctly flags.
    // eslint-disable-next-line react-hooks/static-components
    return <Frame />;
  }

  const names = listFrameNames();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">file-app template</h1>
      <p className="text-slate-600">
        Pass a frame via <code className="rounded bg-slate-100 px-1">?frame=&lt;Name&gt;</code>.
      </p>
      <ul className="flex gap-3">
        {names.map((name) => (
          <li key={name}>
            <a className="text-sky-600 underline" href={`?frame=${name}`}>
              {name}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
