# Node ids and writeback

A node id IS a source location (`relFile:line:col`, or an inlined
composite id). Never invent, guess, concatenate, or pattern-match one —
use ids exactly as a tool returned them.

`studio_apply_edits`/`studio_codemod` return `shifted: true` when a write
changed a touched file's line count — guaranteed for insert/delete/move,
likely for detach/swap, never for the six single-line value edits
(prop/text/style/literal/tag/asset). After ANY `shifted: true` result,
every node id you already hold is stale. Re-read before your next edit —
editing with a stale id silently modifies the wrong element.