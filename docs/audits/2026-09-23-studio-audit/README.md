# 2026-09-23 Studio audit
> **Trust:** historical, dated 2026-09-23. Paths and line numbers were true at `560ddb0e`; re-read the code before acting on a finding. The plan built from it is `ROADMAP.md`.

> **Purpose:** the evidence behind [`ROADMAP.md`](../../../ROADMAP.md) · **Read when:** a work order cites an ID from here (PERF-, ERR-, WB-, IX-, UX-, AI-, IMG-, DET-, SVG-) · **Trust:** historical, dated 2026-09-23 at `560ddb0e`; line numbers drift, so re-read the code before acting · **Owner:** studio-scribe

Nine read-only audits ran in parallel, each by an Opus agent acting as one specialist. Every finding
carries a file:line, a severity, a fix, an effort, an owner, and a note on whether an older plan already covered it.
Where a finding says **CONFIRMED (probe)**, the auditor reproduced it with a throwaway script
that called the real modules. Those scripts were not committed. Turning each one into a regression test is part of ROADMAP Phase 1.

| File | Scope | ID prefix |
|---|---|---|
| [01-perf.md](01-perf.md) | Canvas performance, lag, missing budgets (includes a measured selector-sweep bench) | PERF- |
| [02-errors-client.md](02-errors-client.md) | Editor-side errors, refusals, stuck states, store/disk desync, plus an inventory of ~158 toast sites | ERR- |
| [03-errors-writeback.md](03-errors-writeback.md) | Parse → writeback pipeline, data-loss bugs, and a ~90-reason refusal inventory | WB- |
| [04-interactions.md](04-interactions.md) | Shortcuts, drag/drop, placement, snapping, resize vs Penpot/Figma, and a full shortcut parity matrix | IX- |
| [05-design-pane-ux.md](05-design-pane-ux.md) | Design pane spacing, inspector, editor chrome | UX- |
| [06-assistant.md](06-assistant.md) | The in-editor AI assistant: prompt delivery, tools, loop, panel | AI- |
| [07-image-drop-and-detach.md](07-image-drop-and-detach.md) | Spec A (image drag & drop) and Spec B (detach component) | IMG-, DET- |
| [08-svg.md](08-svg.md) | Plan for inserting, drawing and editing SVG on the canvas | SVG- |
| [09-docs.md](09-docs.md) | Every doc, plan and STATE.md: disposition, contradictions, references to update | (Phase 0) |
