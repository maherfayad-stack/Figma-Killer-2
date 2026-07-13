import type { FrameEntry } from '@ccs/protocol';
import { defaultGeometryForIndex } from './project-wiring.js';

/**
 * New-frame tool (playbook §4/P1 step 4): pure builders for the three
 * artifacts creating a frame touches — the `.tsx` source, the
 * `src/frames.ts` registry patch, and the new `.studio/canvas.json`
 * entry. Kept file-IO-free so the exact same logic drives both the
 * production path (sent to the daemon once it grows a create-frame API —
 * see CHANGE-REQUEST) and the dev-harness's local fs-backed stub used for
 * the P1 acceptance demo (`dev/create-frame-middleware.ts`).
 *
 * `src/frames.ts` is deliberately NOT part of the editable-surface
 * contract's JSX/AST domain (playbook §0) — it's build-time scaffolding
 * plumbing with one fixed shape (import list + object literal), the same
 * category as the template itself, so a small textual patch here is
 * appropriate; this is not a general codemod and must never be reused for
 * arbitrary source edits (that discipline is Phase 3's ast-engine).
 */

const VALID_FRAME_NAME = /^[A-Z][A-Za-z0-9]*$/;

/** Frame names must be valid JS identifiers usable as both a component
 * name and an import binding — same convention as the existing "Hero"/
 * "Pricing" fixtures (PascalCase, no path separators). */
export function isValidFrameName(name: string): boolean {
  return VALID_FRAME_NAME.test(name);
}

/** The new frame's file-folder-relative source path. */
export function frameSourcePath(name: string): string {
  return `src/frames/${name}.tsx`;
}

/** Minimal frame component source — same shape as the template's Hero.tsx
 * fixture (default-exported function component, Tailwind utility
 * classes), so a freshly-created frame is immediately editable by the
 * same AST surface every other frame is (playbook §0 editable-surface
 * contract: static JSX, literal props/classes only). */
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
 * both anchored on the template's exact, fixed shape
 * (`templates/file-app/src/frames.ts`). Throws if the source doesn't
 * match that shape closely enough to patch safely (never silently
 * corrupts the registry — same discipline as the ast-engine's "refuse
 * rather than guess" rule, playbook §4/P3 pitfalls, applied here at a much
 * smaller scale).
 */
export function patchFramesRegistry(existingSource: string, name: string): string {
  if (existingSource.includes(`import ${name} from './frames/${name}.js';`)) {
    throw new Error(`@ccs/canvas: frame "${name}" is already registered in src/frames.ts`);
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
      '@ccs/canvas: src/frames.ts did not match the expected template shape (no frame import found) — refusing to patch',
    );
  }

  if (!REGISTRY_OBJECT_PATTERN.test(withImport)) {
    throw new Error(
      '@ccs/canvas: src/frames.ts did not match the expected `frames: Record<string, ComponentType> = {...}` shape — refusing to patch',
    );
  }

  return withImport.replace(
    REGISTRY_OBJECT_PATTERN,
    (_match, open: string, body: string, close: string) => `${open}${body}\n  ${name},${close}`,
  );
}

/** The new `.studio/canvas.json` entry, cascading past whatever frames
 * already exist in that file-folder (same convention `defaultGeometryForIndex`
 * uses for frames discovered with no prior geometry). */
export function buildNewCanvasJsonEntry(existingEntries: readonly FrameEntry[], name: string): FrameEntry {
  return { framePath: frameSourcePath(name), ...defaultGeometryForIndex(existingEntries.length) };
}
