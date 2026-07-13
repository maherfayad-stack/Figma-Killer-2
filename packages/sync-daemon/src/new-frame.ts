import type { FrameEntry } from '@ccs/protocol';

/**
 * New-frame tool, pure builders — ported into the daemon per ADR-0014 (the
 * task brief: "the exact fs logic for create-frame ALREADY EXISTS in
 * `packages/canvas/dev/create-frame-server.ts` ... port that logic into the
 * daemon; do not reinvent it"). This is a deliberate line-for-line port of
 * `packages/canvas/src/new-frame.ts`'s pure builders, not a shared import:
 * `sync-daemon` must not depend on `@ccs/canvas` (canvas already depends on
 * `@ccs/sync-daemon` as a devDependency for its dev-harness/e2e — a daemon
 * dependency back on canvas would be a package cycle), so the algorithm is
 * ported rather than re-exported. Both copies are covered by their own
 * golden-style tests; keep them in sync by hand until Phase 3's ast-engine
 * subsumes this (see CHANGE-REQUEST in the P1 integration report).
 */

const VALID_FRAME_NAME = /^[A-Z][A-Za-z0-9]*$/;

/** Frame names must be valid JS identifiers usable as both a component
 * name and an import binding (PascalCase, no path separators) — this also
 * doubles as the path-traversal guard: no `/`, `.`, `..`, or whitespace can
 * ever pass this regex, so a name can never escape `src/frames/`. */
export function isValidFrameName(name: string): boolean {
  return VALID_FRAME_NAME.test(name);
}

/** The new frame's file-folder-relative source path. */
export function frameSourcePath(name: string): string {
  return `src/frames/${name}.tsx`;
}

/** Minimal frame component source — same shape as the template's Hero.tsx
 * fixture (default-exported function component, Tailwind utility classes). */
export function buildFrameSource(name: string): string {
  return `export default function ${name}() {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">${name}</h1>
    </section>
  );
}
`;
}

const IMPORT_LINE_PATTERN = /^import \w+ from '\.\/frames\/[^']+\.js';$/gm;
const REGISTRY_OBJECT_PATTERN =
  /(export const frames: Record<string, ComponentType> = \{)([\s\S]*?)(\n\};)/;

/**
 * Insert `import <Name> from './frames/<Name>.js';` after the last frame
 * import, and add a `<Name>,` entry to the `frames` registry object —
 * anchored on the template's exact, fixed shape
 * (`templates/file-app/src/frames.ts`). Throws if the source doesn't match
 * that shape closely enough to patch safely, or if `name` is already
 * registered.
 */
export function patchFramesRegistry(existingSource: string, name: string): string {
  if (existingSource.includes(`import ${name} from './frames/${name}.js';`)) {
    throw new Error(`@ccs/sync-daemon: frame "${name}" is already registered in src/frames.ts`);
  }

  const importLine = `import ${name} from './frames/${name}.js';`;
  const importMatches = [...existingSource.matchAll(IMPORT_LINE_PATTERN)];
  const lastImportMatch = importMatches.at(-1);
  let withImport: string;
  if (lastImportMatch && lastImportMatch.index !== undefined) {
    const insertAt = lastImportMatch.index + lastImportMatch[0].length;
    withImport = existingSource.slice(0, insertAt) + '\n' + importLine + existingSource.slice(insertAt);
  } else {
    throw new Error(
      '@ccs/sync-daemon: src/frames.ts did not match the expected template shape (no frame import found) — refusing to patch',
    );
  }

  if (!REGISTRY_OBJECT_PATTERN.test(withImport)) {
    throw new Error(
      '@ccs/sync-daemon: src/frames.ts did not match the expected `frames: Record<string, ComponentType> = {...}` shape — refusing to patch',
    );
  }

  return withImport.replace(
    REGISTRY_OBJECT_PATTERN,
    (_match, open: string, body: string, close: string) => `${open}${body}\n  ${name},${close}`,
  );
}

// Same cascading-grid convention as `canvas-json.ts`'s internal
// `defaultFrameEntry` (kept as a local copy rather than importing that
// private helper — it isn't part of canvas-json.ts's exported surface).
const DEFAULT_FRAME_WIDTH = 1440;
const DEFAULT_FRAME_HEIGHT = 900;
const DEFAULT_FRAME_GAP = 160;

function defaultGeometryForIndex(index: number): { x: number; y: number; w: number; h: number } {
  return {
    x: index * (DEFAULT_FRAME_WIDTH + DEFAULT_FRAME_GAP),
    y: 0,
    w: DEFAULT_FRAME_WIDTH,
    h: DEFAULT_FRAME_HEIGHT,
  };
}

/** The new `.studio/canvas.json` entry, cascading past whatever frames
 * already exist in that file-folder. */
export function buildNewCanvasJsonEntry(existingEntries: readonly FrameEntry[], name: string): FrameEntry {
  return { framePath: frameSourcePath(name), ...defaultGeometryForIndex(existingEntries.length) };
}
