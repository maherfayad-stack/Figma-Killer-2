# The agent team

Fourteen specialists. **All run on Sonnet 5**, so every definition is written
prescriptively — exact paths, exact commands, explicit "never do this" lists —
rather than relying on judgement.

Every agent must read `PROJECT-BRIEF.md` and `STATE.md` before working, and must
write a `STATE.md` handoff entry before stopping. Format:
[`docs/agent-refs/handoff-protocol.md`](../../docs/agent-refs/handoff-protocol.md).

---

## Core — used on most tasks

| Agent | Use when | Writes code? |
|---|---|---|
| `studio-scout` | You need to know where something lives or how it works. Run this **first** instead of grepping. | No — read-only |
| `studio-architect` | The change spans more than one file, or the right layer isn't obvious. Produces a file-level work order. | No — plan + `STATE.md` only |
| `studio-implementer` | The plan is settled and the task isn't one of the specialist areas below. | Yes |
| `studio-verifier` | End of every task. Runs the gates and separates your failures from the repo's ~200 known ones. | No — reports |
| `studio-scribe` | Behaviour changed, a rule moved, or you learned something durable. | Docs + `STATE.md` only |

## Specialists — routed by what the change touches

| Agent | Owns |
|---|---|
| `parser-surgeon` | ts-morph parsing, the static evaluator, inlining, node ids, **every codemod that rewrites the user's source** |
| `canvas-engineer` | iframes, injectors, overlays, geometry, pan/zoom, cross-iframe events, inline editing, board frames |
| `store-engineer` | Zustand slices, tree mutations, undo/coalescing, selection |
| `panel-designer` | Right sidebar, property controls, `src/ui/` primitives, design tokens |
| `server-engineer` | Bun routes, handlers, TypeBox boundaries, filesystem safety |
| `mcp-tooling` | MCP tools, AI tool engine, editor bridge, visual-audit tooling |
| `perf-hunter` | Frame rate, selection latency, load time, benchmarks and budgets |
| `security-guard` | Untrusted input: archives, paths, subprocesses, the trust tiers |
| `test-engineer` | Tests, fixtures, architecture gates |

---

## A typical task

```
studio-scout        → where does this live, does it already exist?
studio-architect    → work order: files, steps, contracts, gates
<specialist>        → implement it
studio-verifier     → build + targeted tests + lint, triaged
studio-scribe       → docs + STATE.md moved to "Recently landed"
```

Small, well-understood changes can skip straight to the specialist. Nothing
skips `studio-verifier` or the `STATE.md` handoff.

---

## Shared rules every agent inherits

- **Read `STATE.md` first.** Another agent may already be in your files.
- **Write a handoff at every stage boundary**, not only at the end. If you stop
  for any reason, the entry you leave is the deliverable.
- **Never delete another agent's entry.** Append, or update the one you own.
- **Verify once, at the end** — `bun run build`, targeted `bun test`, `bun run lint`.
- **~200 full-suite failures are pre-existing and Windows-only** (`standing-01`).
  Triage against `git diff`; never "fix" what isn't yours.
- **UI is dogfooded by the human** (`standing-02`). No browser or Playwright
  passes for visual work — finish with a concrete "Human action needed" line.
- **Bun**, never npm/pnpm/yarn.
- **Never delete or clear anything under `studio-workspace/`** — that is user data.
