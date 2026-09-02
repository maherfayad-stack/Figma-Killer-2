# Conventions quick-reference

The rules that have **gate tests**. Breaking one fails `bun test`. Read before
writing code. Full rationale is in `CLAUDE.md`; this page is the checklist.

---

## 1. Boundaries — TypeBox or it doesn't ship

| Situation | Use exactly this |
|---|---|
| Client calls an API | `apiRequest(path, { schema, … })` from `@core/http` |
| Client needs binary | `apiBlobRequest(...)` |
| Persistence layer with its own `fetch` | `readEnvelope(res, Schema, fallback)` / `assertOk(res, fallback)` |
| Low-level body validation only | `parseJsonResponse(res, Schema)` — **primitives only**, not admin code |
| `JSON.parse` of stored data | `safeParseJson(raw, Schema)` (hard) / `parseJsonWithFallback(raw, Schema, default)` (soft) |
| Server request body | `readValidatedBody(req, Schema)` from `server/http.ts` |

**Banned:** raw `fetch()` in admin code · `res.json() as Foo` · `JSON.parse(x) as Foo` ·
`req.json()` unvalidated · `body.field as DeepType`.
**Gate:** `boundary-validation.test.ts`.

**Schemas are the source of truth:** `type Foo = Static<typeof FooSchema>`.
Never a parallel `interface Foo` beside a `FooSchema`.

---

## 2. Banned dependencies

`zod` · `lucide-react` · any inline SVG icon string · `clsx` · `tailwind-merge` ·
`class-variance-authority` · `@radix-ui/*` · `react-router-dom` · `immer` ·
`@anthropic-ai/sdk` · `@openai/agents` · Tailwind utility classes.

`@modelcontextprotocol/sdk` is **scoped**: allowed only under `server/ai/mcp/`.

**Gates:** `ai-driver-isolation.test.ts`, `no-third-party-icons.test.ts`,
`no-tailwind-deps.test.ts`, `noTailwindUtilities.test.ts`,
`admin-router-usage.test.ts`, `direct-icon-imports.test.ts`.

Icons: `import { FooIcon } from 'pixel-art-icons/icons/foo'` then `bun run icons:sync`.

---

## 3. CSS

- **No hex / rgb / hsl** in `src/admin`, `src/ui`, `src/modules` CSS modules. Use
  `var(--token)`. Missing token? Add it to `src/styles/globals.css`.
  **Gate:** `css-token-policy.test.ts`.
- **No `var(--name, fallback)`.** Bare `var(--name)` only.
  **Gate:** `no-css-var-fallbacks.test.ts`.
- **No `!important`** in component CSS modules. (Injected *iframe* stylesheets
  like `CanvasAnimationInjector` are exempt — they have no cascade position.)
- **CSS Modules only.** `Component.module.css` next to `Component.tsx`, class
  names `camelCase`.
- **No inline `style={{}}`** except dynamic custom properties:
  `style={{ '--x': v } as CSSProperties}` read back via `var(--x)`.
- Radius scale: `--editor-radius-sm` 3px · `--editor-radius` 6px ·
  `--panel-radius` 12px · 16px tile cards · `--input-radius` 1em pills.

---

## 4. React

- **React Compiler is ON.** No `useMemo`, no `useCallback`, no `memo()`.
  Three exceptions only, each needing a one-line comment:
  1. the value/function is in a `useEffect` dependency array,
  2. a `React.memo` bailout on a hot, list-rendered component,
  3. the compiler cannot compile it (`"use no memo"`).
  `useState(() => …)` and `useRef(…)` are **not** memoization — always fine.
  **Gate:** `eslint-plugin-react-compiler` in `bun run lint`.
- **Every interactive control uses a `src/ui/components/` primitive.** Bare
  `<button>` needs an `ALLOWLIST` entry with a §8 justification.
  **Gate:** `button-primitive-usage.test.ts`.
- **No `alert()` / `confirm()` / `prompt()`.**
  **Gate:** `no-native-browser-dialogs.test.ts`.

---

## 5. Errors

- Async UI handlers wrap in `try/catch`; log `console.error('[<Component>] <desc>:', err)`.
- **User-triggered failures go to the toast bus:**
  `pushToast({ kind: 'error', title, body: getErrorMessage(err, '…') })`.
  The only exception is field-local validation inside a form.
- Server failures return `{ error: string }`; logs use `console.error('[<module>]', err)`.
- **Never** `catch (err) {}`. Name it `catch (_err)` + one-line comment if truly safe.
- **Never** `console.log` in production code.
- Re-throw with cause: `new Error(msg, { cause: err })`.

---

## 6. Imports

Modules with an `index.ts` own it as the canonical entrypoint.

- ✅ outside: `import { Page } from '@core/page-tree'`
- ✅ inside the module: `import type { Page } from './page'`
- ❌ outside: `import { Page } from '@core/page-tree/page'`

Enforced for `@core/page-tree`, `@core/module-engine`, `@core/visualComponents`,
`@core/publisher`, `@core/framework`, `@core/framework-schema`, `@core/fonts`.
**Gate:** `no-core-barrel-deep-imports.test.ts`.

---

## 7. Tree mutations

Every mutation in `src/core/page-tree/mutations.ts` is **tree-agnostic**. The only
place that knows which tree is active is `resolveActiveTreeTarget`
(`store/slices/site/helpers.ts`), used through `mutateActiveTree(fn)`.

The 11 named store actions (`insertNode`, `deleteNode`, `updateNodeProps`,
`setBreakpointOverride`, `clearBreakpointOverride`, `renameNode`,
`toggleNodeLocked`, `toggleNodeHidden`, `moveNode`, `duplicateNode`, `wrapNode`)
are one-liners over `mutateActiveTree`. **They must not contain a
`kind === 'visualComponent'` branch.**
**Gate:** `no-vc-mode-branches-in-mutations.test.ts`.

**A structural action on a studio-imported tree must write source or refuse —
never neither (`struct-01`).** `insertNode`, `deleteNode(s)`, `moveNode(s)`,
`duplicateNode(s)`, `wrapNode(s)` ask `refuseStructuralEdit`
(`src/core/page-tree/sourceStructure.ts`) BEFORE mutating, via
`store/slices/site/structuralSourceEdits.ts`, and commit a `move`/`delete`
`StudioEdit` when it allows. `applyTreeOperation` asks the same function so
plugins and agents ride the same gate. If you add a structural surface, ask
this function — do not re-derive the rule.

---

## 8. Safety (filesystem + untrusted input)

Studio reads and writes the user's repo. Every path is untrusted.

- Reject: absolute paths, UNC paths, `..` on **either** separator, empty
  segments, anything under `EXCLUDED_WORKSPACE_DIR_NAMES`
  (`.studio`, `.git`, `node_modules`, `dist`, `.next`, `.turbo`).
- **Containment is checked on the real path, after resolving symlinks.** A repo
  can arrive from GitHub and git stores symlinks — a textual check is bypassable.
- Archive entries: decide *before* inflating (per-file cap, total cap, file
  count cap, traversal). See `studioGithubImport.ts`'s `filter` callback.
- A write target is derived **server-side**. Never accept a caller-supplied
  directory for anything that clears or overwrites.
- Every rejection is a 404 or a typed error — never a partial write.
- **Subprocesses** (running a package manager, or — `sec-01` — a workspace's
  own Sass/PostCSS/Tailwind compiler): argv array, never a shell string.
  `cwd` is the workspace, never the Studio repo root. `env` is an explicit,
  minimal set built by `subprocessRunner.ts`'s `minimalSubprocessEnv` —
  never `process.env` forwarded wholesale (that would leak
  `STUDIO_SECRET_KEY`/`DATABASE_URL`/AI provider keys to code the workspace
  controls). Timeout + capped stdout/stderr via the same module's
  `runCappedSubprocess`/`captureSubprocess` — reuse it, don't re-roll the
  spawn/timeout/cap mechanics per caller.
  Do **not** trim `BASE_SUBPROCESS_ENV_KEYS` to make the set smaller: `USER`
  is load-bearing (the Claude CLI keys its stored credentials by the OS
  account name, and without it a signed-in MCP server silently reports
  `! Needs authentication` and a turn gets zero of its tools). Pinned by
  `subprocessRunner.test.ts`; the story is `mcp-16` in `STATE.md`.

---

## 9. Database

Studio does not use it. If you truly need a schema change:

- Additive only. New migration id in **both** `server/db/migrations-pg.ts` and
  `server/db/migrations-sqlite.ts`, same semantic effect.
- Never edit a committed migration. Never `DROP`. Never require a DB reset.
- JSON columns end in `_json`. Repositories use ANSI SQL only — no `now()` in
  DML, no `::int`, `::jsonb`, `any($N::…)`, `distinct on`.
- **Gates:** `migration-parity.test.ts`, `db-json-column-naming.test.ts`,
  `db-postgres-isms.test.ts`.

---

## 10. Deleting and refactoring

There is **no backward compatibility for code**. When you replace something:

- Delete the old implementation in the same change. No `legacyFoo()` shims, no
  feature flags "to be safe", no old-and-new side by side.
- Rename across the whole codebase rather than adding an adapter.
- Delete dead exports, unused params, half-finished abstractions.
- No commented-out code. No `TODO: clean up later` — do the cleanup.
- **Exception: DB schema** (see §9).

---

## 11. Verification

Run **once at the end** of the task:

```sh
bun run build     # tsc -b && vite build — type errors fail here
bun test
bun run lint      # only if you touched .ts/.tsx
```

Fast gate-only pass: `bun test src/__tests__/architecture`.

Parallel sessions exist. A failure outside your `git diff` is **not yours** —
note it in the handoff and move on. Do not "fix" it, do not comment out a
failing test, do not revert someone else's work.

**Do not run browser/e2e tests to validate UI work.** The human dogfoods UI.
Static gates + a "needs human dogfood" note in `STATE.md`.

---

## 12. Docs

Change code that a doc describes → update the doc in the **same change**.
Change a structural rule → update its gate test in the **same change**.
New agent-facing knowledge → `docs/agent-refs/`.
Doc style rules: `docs/CONVENTIONS.md`.
