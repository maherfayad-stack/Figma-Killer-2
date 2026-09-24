/**
 * `studio://tool-notes` — the long-form usage rules for the external-client
 * tools whose descriptions were cut to 900 characters (AI-29).
 *
 * A tool description is re-sent on every round; a resource is read once, when
 * a client needs it. So the per-kind detail of `studio_apply_edits` and the
 * renderer detail of `studio_export_frames` live here, and each description
 * points at this URI. The in-canvas agent does not hold either tool, so
 * nothing it needs was moved out of its reach.
 *
 * `tool-description-length.test.ts` holds every description to the ceiling;
 * `resources.test.ts` checks this resource names each tool whose description
 * points here.
 */

export const STUDIO_TOOL_NOTES_TEXT = `# Studio tool notes

Long-form rules for tools whose descriptions are kept short. Each section is
named for its tool.

## studio_apply_edits

The same engine the canvas save route runs: edits are applied bottom-to-top
(so a line-shifting edit cannot invalidate a pending edit's location),
de-duplicated, and each one succeeds or refuses on its own.

### Value kinds: prop, text, style, class, literal, tag, asset

They rewrite one existing span, but they do NOT reliably keep the line count:
a text edit can re-flow children and a style edit can rewrite a multi-line
\`style={{…}}\`. Always read \`shifted\`.

- **prop** replaces only a LITERAL attribute value, or adds a missing
  attribute. An attribute holding code (\`title={c.heading}\`, \`onClick={fn}\`)
  refuses with \`binding-overwrite\` rather than baking a literal over it.
- **class** (\`{ kind: "class", nodeId, add: string[], remove: string[] }\`)
  adds or removes whole class TOKENS (class names such as \`bg-blue-600\`, never
  Studio's \`sc-<hash>\` rule ids). Swapping \`bg-red-500\` for \`bg-blue-600\` is a
  class edit, not a css edit. It writes a bare \`className="a b"\`, an
  expression-wrapped string or template, and \`cn()\` / \`clsx()\` /
  \`classNames()\` / \`classnames()\` calls (ADD merges into a literal argument or
  appends one; REMOVE strips the token from every literal argument). It
  creates the attribute when absent. Refusals, by name:
  - \`css-module-binding\` — \`className={styles.card}\`: edit the class's own
    declaration in the stylesheet instead;
  - \`template-dynamic\` — REMOVE from a template with an interpolation (the
    token may live in the dynamic part); ADD still works;
  - \`spread-attribute\` — \`className={...spread}\`;
  - \`unsupported-call\` / \`unsupported-expression\` — for a REMOVE. An ADD to a
    bare identifier, member chain, ternary, logical or other call is WRAPPED,
    keeping the binding (\`cn(expr, "a")\` when the file already has a
    class-join helper, else a template). A className that is not a class
    string at all (an arrow, an object) still refuses.
  A module token whose stylesheet is not imported yet is written as
  \`styles.<local>\` and the import is added after the batch (\`shifted\` is then
  true). A request that changes nothing is a silent no-op, not a refusal.

### Structural kinds: insert, delete, move (+ duplicate, wrap, group, ungroup, transplant, styled, reinsert-source)

They always change the file's line count.

- **insert**: \`nodeId\` is the CONTAINER, not the new element. \`anchorNodeId\` +
  \`position\` place it beside a sibling; the default appends as the last child.
  With \`importSpecifier\`, \`name\` is a component imported from that exact
  specifier. With \`designSystemImport: true\`, \`name\` is a component of
  Studio's built-in design system and the server computes the relative path —
  never write it yourself. With neither, \`name\` is an HTML tag.
  \`children\` is a text string or an array of nested elements of the same
  shape, arbitrarily deep. **Build a whole screen in ONE insert**: every insert
  shifts node ids, so one element per call costs a re-parse each (measured:
  over twenty minutes for a ~30-node screen). The whole subtree is validated
  before any byte is written, and all its imports land in one pass.
- **delete** returns \`removed\` and \`prunedImports\`: exactly what it took out.
- **reinsert-source** is a delete's undo: \`nodeId\` is the PARENT, \`index\` the
  child position, \`text\` the bytes a delete returned in \`removed\` (JSX
  content only; a statement or an unmatched closing tag is refused).
- **move**: \`nodeId\` is the element moved; \`anchorNodeId\` + \`position\` name
  where it goes.
- **detach** / **swap** inline or retarget a whole component body: treat them
  as line-count-changing. For a single one, \`studio_codemod\`'s per-call
  result is richer.

### css

Writes a declaration (\`file\`, \`selector\`, \`property\`, \`value\`) into a
stylesheet. The rule is CREATED at the end of the file when the selector is
missing. The file must exist and be hand-authored; a compiled or generated
stylesheet is refused by name.

### The result

- \`shifted: true\` — a touched file's line count changed: every node id read
  before this call is stale. Guaranteed for insert/delete/move, likely for
  detach/swap, possible for text/style.
- \`sharedComponents: true\` — an edit landed on an inlined component instance,
  route chrome, or a detach/swap.
- \`refusals\` — why each edit did not write. \`element-moved\` means an \`expect\`
  fingerprint no longer matches and the element could not be found exactly
  once in the changed file: re-read the ids and retry.
- \`fingerprints\` — each landed value edit's new \`sourceFingerprint\`, for the
  next call's \`expect\`.
- \`retargeted\` — \`{ nodeId, to }\` for an id whose file changed since you read
  it but whose element was re-found exactly once (by its fingerprint) and
  written at \`to\`.
- \`pageIds\` — the pages touched; an open canvas is nudged to re-read them.

## studio_export_frames

The headless renderer uses the same parse output and the same design-canvas
injectors as the board (animation freeze, scroll unroll), so a frame exports
the way it looks on the board. \`source: "live"\` is the only path that sees
state which exists only in the open tab (the selection, an unsaved edit, an
unpersisted re-frame), at the cost of a visible canvas takeover.

Every frame is captured at its own authored width; resize with
\`studio_set_frames\` first when a specific width is needed. \`imageScale\` is
derived from the real captured size, so it stays right when the effective
ratio was clamped. \`studio_compare\` uses \`purpose: "measurement"\` for its own
capture automatically.
`
