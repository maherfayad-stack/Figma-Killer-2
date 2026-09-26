# React Compiler and memoization
> **Purpose:** the React Compiler memoization rule and its three exceptions · **Read when:** tempted to write useMemo, useCallback or memo · **Trust:** rule · **Owner:** panel-designer · **Verified:** not yet

The **React Compiler is enabled** for the whole app (`reactCompiler()` in `vite.config.ts`, from `scripts/vite/reactCompilerPlugin.ts`). It auto-memoizes every component and hook it can compile, so hand-written memoization is **noise** — it adds clutter without improving performance. **"It can compile" is the catch:** a function it cannot lower is emitted unmemoized, silently — see "The gate".

---

## TL;DR

- Don't write `useMemo`, `useCallback`, or `memo()` — the compiler handles it.
- Three exceptions exist (dep-array functions, hot-list `React.memo`, lint escape hatches); add a comment on each.
- **Enforcement gates:** `eslint-plugin-react-compiler` in `bun run lint` / CI, and `react-compiler-bailouts.test.ts` (every function in the canvas, `src/ui/components` and the inspector must actually compile).
- `bun run compiler:bailouts [dir…]` lists every function the compiler skips, with its reason.
- `react-doctor` surfaces violations as **warnings** only (`react-doctor.config.json`); it cannot distinguish the three legitimate exceptions.

## The rule

- **No `useMemo`, no `useCallback`, no `memo()`.** Write the plain value, the plain function, the plain component — the compiler memoizes them for you. New code must not introduce manual memoization, and existing manual memoization is being removed.
- **`useState(() => …)` lazy initializers and `useRef(…)` are NOT memoization** — always fine, unaffected by this rule.

## The three exceptions

Memoization legitimately stays in exactly three cases. **Keep it, and add a one-line comment saying why** so the next reader (and the linters) know it's deliberate.

1. **The value/function is referenced in a hook dependency array.** The static `react-hooks/exhaustive-deps` rule can't see the compiler's runtime memoization, so it still demands a stable identity for anything in a `useEffect`/`useMemo`/`useCallback` dep array. Wrapping a *function* used as a dep in `useCallback` (plus the transitive closure it depends on) is required to keep `bun run lint` clean. Only **functions** trip the rule — a plain value feeding a dep array can be inlined.

2. **A `React.memo` re-render bailout on a hot, list-rendered component** (e.g. a per-node canvas renderer, or a windowed tree row re-rendered on every scroll tick). `React.memo` skips re-rendering on equal props — a *different* mechanism from the compiler's within-component memoization — so dropping it on an O(N) critical path is not behavior-preserving without runtime perf validation. Rare; justify in a comment. Examples: `NodeRenderer`, `DomPanel/TreeNode`, `AgentPanel`'s `MessageBubble`/`MarkdownTextBubble`.

3. **A lint escape hatch the compiler/linters force.** Two sub-cases:
   - **`react-hooks/refs`**: a render-scoped event handler that reads/writes a ref (`someRef.current = …`) trips "Cannot access refs during render" when written as a bare function, because the linter can't tell the closure only runs at event time. Wrapping it in `useCallback` satisfies the rule. (See `CanvasLiveSurface`'s pointer handlers.)
   - **Compiler bail-out**: when the compiler genuinely cannot compile a function, add the `"use no memo"` directive (or the existing `eslint-disable react-compiler/react-compiler` pattern) and keep the manual memoization it needs.

## The toolchain

`babel-plugin-react-compiler` 1.0 is built against Babel 7 and asks the host's `NodePath`s questions such as `isLVal()`. The repo's root `@babel/core` is 8 (the studio runtime's `idStamp` needs it), and Babel 8 dropped `AssignmentPattern` from `LVal` — so under the root Babel the compiler skipped **every function with a destructured default** (`{ size = 'md' }`), `Button` and `Tooltip` among them. No compiler release supports Babel 8. The compiler therefore runs on its own Babel 7: `babel-core-7` (an npm alias of `@babel/core@7`), driven by `scripts/vite/reactCompilerPlugin.ts`, which replaced `@rolldown/plugin-babel` with the same file selection. Do not put the compiler back on the root Babel.

## The gate

Two gates, because they catch different things:

- **`eslint-plugin-react-compiler` + `eslint-plugin-react-hooks`** in `bun run lint` / CI. They flag rule violations (`react-hooks/exhaustive-deps` and `react-hooks/refs` enforce exceptions (1) and (3)). They run their **own** Babel, so they do not see what Vite's compile skips.
- **`src/__tests__/architecture/react-compiler-bailouts.test.ts`** compiles every file in `canvas/`, `src/ui/components`, `inspector/`, `panels/PropertiesPanel` and `property-controls/` through the exact transform Vite ships and fails naming each skipped function and the compiler's reason. Its header lists the rewrites that compile (a `finally` moved after a non-rethrowing `catch`, a value block inside `try` moved to a module function, `x = x ?? y` for `??=`, `(n += 1)` for `++n` on a captured variable, a module-level loader for `import()`, state or `useEffectEvent` for a ref touched in render). An entry in its `ALLOWED` list needs a real reason; it is empty today.

`react-doctor`'s `react-compiler-no-manual-memoization` rule *also* flags manual memoization, but it cannot recognize the three exceptions above, so it false-positives on them. It is therefore configured as an **advisory warning** (`react-doctor.config.json`), not an error gate — it surfaces genuinely-gratuitous memoization on new code without blocking on the legitimate exceptions. Treat a new `useMemo`/`useCallback`/`memo()` outside the three exceptions as drift and remove it.

---

## Related

- `CLAUDE.md` → "React Compiler and memoization" — the rule summary with direct agent instructions
- `vite.config.ts` + `scripts/vite/reactCompilerPlugin.ts` — compiler setup (the compiler on its own Babel 7)
- `scripts/react-compiler-bailouts.ts` — the inventory (`bun run compiler:bailouts`)
- `eslint.config.js` — `eslint-plugin-react-compiler` and `react-hooks` configuration
- `react-doctor.config.json` — advisory downgrade for `react-compiler-no-manual-memoization`
