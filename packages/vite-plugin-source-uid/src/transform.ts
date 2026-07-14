import { transformSync } from '@babel/core';
import { createSourceUidBabelPlugin } from './babel-plugin.js';

export interface TransformSourceUidOptions {
  /** File-folder-relative source path, e.g. "src/frames/Hero.tsx" — becomes
   * the `<relPath>` half of every `data-uid` emitted for this file. Must
   * end in `.tsx` to satisfy the frozen `NodeUidSchema` (`^.+\.tsx:.+$`,
   * `packages/protocol/src/uid.ts`). */
  relPath: string;
  /** Absolute-ish filename passed to Babel for error messages/sourcemaps.
   * Defaults to `relPath`. */
  filename?: string;
}

export interface TransformSourceUidResult {
  code: string;
  map: object | null;
}

/**
 * Runs the source-uid Babel plugin over one file's source, in isolation
 * from any other transform (react-refresh, esbuild JSX-compile, etc.) —
 * see `vite-plugin.ts` for why this MUST run before those (`enforce:
 * 'pre'`): once JSX is compiled to `jsx()`/`createElement()` calls there
 * are no more `JSXElement`/`JSXFragment` AST nodes left to tag.
 */
export function transformSourceUid(
  source: string,
  options: TransformSourceUidOptions,
): TransformSourceUidResult {
  const filename = options.filename ?? options.relPath;

  const result = transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    parserOpts: {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    },
    plugins: [createSourceUidBabelPlugin(options.relPath)],
  });

  if (!result || result.code == null) {
    throw new Error(
      `@ccs/vite-plugin-source-uid: babel transform produced no output for "${filename}"`,
    );
  }

  return { code: result.code, map: (result.map as object | null) ?? null };
}
