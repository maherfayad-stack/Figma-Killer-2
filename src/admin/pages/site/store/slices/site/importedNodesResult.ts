/**
 * The outcome of `insertImportedNodes` — the store action behind the paste-HTML
 * modal and the agent's `site_insert_html` / `site_replace_node_html` tools.
 *
 * It used to return `string[]`, with an empty array standing for every way the
 * import could fail to land. That was survivable while the only failure was
 * "the parent does not accept children", and stopped being survivable when
 * `mcp-21` found the other one: on a studio-imported tree the action merged
 * nanoid nodes into the page with no source write behind them, and the next
 * parse deleted them without a word. Refusing that needs a REASON to travel
 * back — the modal shows it inline, and an external MCP client with
 * `ai.tools.write` gets it as the tool's error instead of a sentence about
 * containers that was never true.
 *
 * Its own module so `types.ts` can name it without growing: that file is a
 * hair under the 700-line ceiling and this type belongs to one action.
 */
export type ImportedNodesResult =
  /** The fragment is in the tree. `rootIds` are the inserted roots, in document order. */
  | { ok: true; rootIds: string[] }
  /**
   * Nothing was inserted. `message` is the sentence the user has ALREADY been
   * shown where a refusal channel exists (`presentStructuralRefusal`), carried
   * here as well so a programmatic caller can report the same reason rather
   * than inventing one.
   */
  | { ok: false; message: string }
