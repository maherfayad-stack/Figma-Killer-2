import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import reactCompiler from 'eslint-plugin-react-compiler'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// React Compiler ESLint rule surfaces functions the compiler can't safely
// memoize (Rules-of-React violations, mutating render-time state, etc.) so
// they're caught at lint time rather than as a build-time bailout. The
// compiler itself is wired in `vite.config.ts`.

const configDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig([
  // `design-system/` is a standalone package with its own tsconfig, eslint, and
  // test scripts — it is a library, not part of the Vite app, so app-only rules
  // (notably `react-refresh/only-export-components`, which is about HMR
  // boundaries) do not apply to it. Lint it with its own `bun run lint` there.
  //
  // `studio-workspace/` holds arbitrary user React projects — real imports and
  // the `__canonical-fixture` reference project alike. Studio PARSES that code
  // with ts-morph; it never builds or lints it, and React Compiler purity rules
  // (`react-hooks/purity`, e.g. `Math.random()` in a render path) are rules
  // about STUDIO'S OWN admin app, not a constraint on what a user's — or a
  // fixture's — source is allowed to contain. Every existing project under here
  // happens to be `.jsx`, which this app's `**/*.{ts,tsx}` file matcher already
  // skips; excluding the whole tree makes that accidental exemption explicit
  // instead of leaving a `.ts`/`.tsx` file the one shape that would trip it.
  globalIgnores(['dist', '.worktrees', '.claude', 'design-system', 'studio-workspace']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      reactCompiler.configs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        tsconfigRootDir: configDir,
      },
    },
    rules: {
      // `varsIgnorePattern` includes `Schema$` because TypeBox's idiom is
      //   const FooSchema = Type.Object({ ... })
      //   export type Foo = Static<typeof FooSchema>
      // The schema MUST be a runtime value (the source of truth — `Static`
      // reads it through `typeof`). Eslint's `no-unused-vars` does not count
      // `typeof` references as a "use" of the value, so non-exported leaf
      // schemas would otherwise trip the rule. We allow that pattern by name.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '(^_|Schema$)',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // The editor store uses TypeScript declaration merging: `EditorStore` is
      // declared as an empty interface in `src/admin/pages/site/store/types.ts` and
      // each slice file augments it via
      //   declare module '@site/store/types' {
      //     interface EditorStore extends MySlice {}
      //   }
      // That requires both the original empty interface AND each per-slice
      // empty-extends form. They are not redundant — the empty body is the
      // augmentation point, removing it would break the type. Allowlist the
      // one identifier this pattern uses, project-wide.
      '@typescript-eslint/no-empty-object-type': ['error', {
        allowWithName: '^EditorStore$',
      }],
    },
  },
  {
    files: ['src/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-constant-condition': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    // Example plugins are standalone projects that ship as zip packages —
    // they aren't part of the host's React Fast-Refresh graph (Vite never
    // serves them) and they don't run under the host's React 19 strict
    // setState-in-effect rules. These rules are noisy in plugin authoring
    // contexts; relax them for the examples folder.
    files: ['examples/plugins/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
])
