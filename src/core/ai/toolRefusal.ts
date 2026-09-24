/**
 * `toolRefusal` — the one shape every Studio tool refuses with.
 *
 * ## Why this exists (A14)
 *
 * A refusal was whatever each tool felt like returning: a bare
 * `aiToolError('No screen matched "Checkout"…')` here, an `{ ok: false, code }`
 * there, a `{ ok: false, error }` with no code somewhere else. Three
 * consequences, all paid by the consumer:
 *
 *   - **Nothing was machine-readable.** The consumer is often a small model.
 *     Given prose, it pattern-matches; given `code: 'no-such-page'` it can
 *     branch. `mcp-tooling.md`: "Stable finding codes. Anything diagnostic
 *     returns a machine-readable code plus a suggested fix."
 *   - **Nothing said whether retrying was pointless.** The dominant observed
 *     waste in a turn is the same failing call issued three times with the
 *     same arguments. `retryable` states it, and the system prompt turns it
 *     into a rule.
 *   - **Nothing said what to do instead.** `remedy` is the next action, not a
 *     restatement of the symptom.
 *
 * ## Why the code is also inside `error`
 *
 * Every consumer path reduces a failed tool result to its `error` STRING and
 * nothing else — `mcp/server.ts`'s `CallToolResult` builder, and
 * `anthropic.ts` / `responses-shared.ts` / `chatCompletions.ts`'s
 * `toolResultText`. A structured field the model never sees is decoration. So
 * `toolRefusal` renders message + remedy + `[code=… retryable=…]` into `error`
 * AND keeps the structured fields on the object, which the chat path forwards
 * whole. One call site, both audiences, no way for the two to disagree.
 *
 * ## Retryable means one specific thing
 *
 * `retryable: true` ⇔ *this identical call could succeed once some external
 * condition changes, with no change to your arguments.* A disconnected board
 * can reconnect; a transient IO error can clear. A page that does not exist
 * will not start existing because you asked twice, and a project at Tier 0
 * will not promote itself. Anything whose fix is "change the arguments" or
 * "ask the user to do something first" is `false`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

interface ToolRefusalCodeDef {
  /** See the module doc — NOT "is this failure temporary", but "could the same args work later". */
  readonly retryable: boolean
  /** What this code means, in one line. Documented in `docs/features/agent.md`. */
  readonly meaning: string
}

/**
 * The refusal vocabulary. Adding a code is a deliberate act: it is part of the
 * tool interface an external agent programs against, so it gets a line here
 * and a row in `docs/features/agent.md`, gated by `toolRefusal.test.ts`.
 */
export const TOOL_REFUSAL_CODES = {
  // --- the caller passed something that cannot work -----------------------
  'invalid-input': {
    retryable: false,
    meaning: 'The arguments are self-contradictory or incomplete in a way the schema cannot express (e.g. exactly one of three fields required).',
  },
  'input-schema-mismatch': {
    retryable: false,
    meaning: 'The arguments do not match the tool\'s input schema. The refusal names each failing field\'s path, what was expected there and what arrived, plus a minimal valid call built from the schema (required fields only) whenever one can be built.',
  },
  'missing-param': {
    retryable: false,
    meaning: 'A parameter this particular verb/mode requires was not supplied.',
  },
  'unknown-verb': {
    retryable: false,
    meaning: 'The requested operation name is not one this tool implements.',
  },

  // --- the thing named does not exist ------------------------------------
  'no-such-page': {
    retryable: false,
    meaning: 'No screen in this project matched the given name or page id. The refusal lists the names that do exist.',
  },
  'no-such-file': {
    retryable: false,
    meaning: 'No readable regular file at that project-relative path, or it exceeds the read cap.',
  },
  'no-such-reference': {
    retryable: false,
    meaning: 'No design reference is registered under that id for this project.',
  },
  'no-design-reference': {
    retryable: false,
    meaning: 'This page has no design to measure against — either nothing is registered for the project, or every registered reference belongs to a different screen. Register one, or say plainly that there is no design rather than guessing a score.',
  },
  'no-such-variable-set': {
    retryable: false,
    meaning: 'No design-variable set is ingested under that id for this project.',
  },
  'no-such-variant-set': {
    retryable: false,
    meaning: 'No variant set is recorded under that id for this project.',
  },
  'no-such-thread': {
    retryable: false,
    meaning: 'No comment thread with that seq exists on the board.',
  },
  'no-such-job': {
    retryable: false,
    meaning: 'No background job with that id — it expired, or the id is wrong.',
  },
  'no-board-frame': {
    retryable: false,
    meaning: 'The page exists but has no frame placed on the board yet.',
  },
  'no-package-json': {
    retryable: false,
    meaning: 'This project has no package.json, so there is no dependency manifest to act on.',
  },
  'no-such-token': {
    retryable: false,
    meaning: 'No stylesheet the canvas loads declares that CSS custom property at the document root — in the requested colour scheme, when one was named. The refusal says whether the light value exists when the dark one does not.',
  },
  'no-such-component': {
    retryable: false,
    meaning: 'No component of that name is in the design-system catalog of this project (the one studio_list_components reads). The refusal lists the nearest names.',
  },
  'no-writable-location': {
    retryable: false,
    meaning: 'The node has no single honest source location to write to — a synthetic node, or one produced inside a `.map` iteration.',
  },

  // --- the thing named exists but cannot be used -------------------------
  'ambiguous-reference': {
    retryable: false,
    meaning: 'Two or more equally-ranked design references could stand in for this page. Name one explicitly with referenceId.',
  },
  'ambiguous-declaration': {
    retryable: false,
    meaning: 'The design token is declared in more than one place for the same colour scheme (two project stylesheets, or a responsive/second selector in one file), so no single declaration is "the" token. The refusal lists every file:line; edit the one you mean with the file tools.',
  },
  'read-only-source': {
    retryable: false,
    meaning: 'The declaration that wins comes from a package, from the built-in Studio design system, or from compiled Sass/PostCSS/Tailwind output — not a project file that can be edited in place. Override it in a stylesheet of the project, or edit the source the output was compiled from.',
  },
  'invalid-prop-value': {
    retryable: false,
    meaning: 'A prop value is not one the component accepts — an enum value outside its declared set, a non-boolean for a boolean prop, or a prop the component does not declare. The refusal lists the accepted values.',
  },
  'reference-unreadable': {
    retryable: false,
    meaning: 'A registered design reference is on the books but its file could not be read from disk.',
  },
  'image-decode-failed': {
    retryable: false,
    meaning: 'Image bytes were found but could not be decoded as a raster image.',
  },
  'crop-out-of-bounds': {
    retryable: false,
    meaning: 'The requested rectangle falls outside the source image. Deliberately refused rather than clamped — a silently clamped crop is a wrong asset that looks right.',
  },
  'path-outside-project': {
    retryable: false,
    meaning: 'The path resolves outside the project directory. Containment is absolute.',
  },
  'not-a-file': {
    retryable: false,
    meaning: 'The path exists but is a directory or another non-regular file.',
  },
  'protected-path': {
    retryable: false,
    meaning: 'The path is inside the project but is not the user\'s source: a directory Studio owns or that is not source (.studio, .claude, .git, node_modules, build output), a credential file (.env, .npmrc, key material), or a file with other hard-linked names. No agent file tool reads or writes it.',
  },
  'needs-user': {
    retryable: false,
    meaning: 'The file runs on the user\'s machine outside the page — build-tool config, package.json, env and package-manager config, git hooks, .vscode, CI workflows — or is standing agent instruction (CLAUDE.md). No agent writes it on either path: show the user the exact change and ask them to make or approve it. Screen files (.tsx, .ts, .css, assets) stay writable.',
  },
  'not-text': {
    retryable: false,
    meaning: 'The file (or the content supplied) is binary or not valid UTF-8, so a text tool cannot hand it back or rewrite it byte-faithfully. Images and fonts go through the asset tools.',
  },
  'file-too-large': {
    retryable: false,
    meaning: 'The file, or the content supplied for it, is over the file tools\' size cap. Split the file, or edit the part that needs to change.',
  },
  'stale-source': {
    retryable: false,
    meaning: 'The file on disk is not the version the write was built against: its hash no longer matches the expectedHash given, or an existing file was about to be overwritten with no expectedHash at all. Read it again (studio_read_file returns the hash) and rebuild the change against what is there now.',
  },
  'edit-no-match': {
    retryable: false,
    meaning: 'The oldString of an edit does not occur in the file. Read the file again and copy the exact text, whitespace and line breaks included.',
  },
  'edit-ambiguous': {
    retryable: false,
    meaning: 'The oldString of an edit occurs more than once, so which one to change is a guess. Include enough surrounding text to make it unique, or pass replaceAll:true when every occurrence should change.',
  },
  'no-open-project': {
    retryable: false,
    meaning: 'This tool writes only into the project open for this turn, and none is. The file-authoring tools never take a directory argument.',
  },
  'stale-anchor': {
    retryable: false,
    meaning: 'A comment thread\'s anchored element has moved or gone, so resolving it would attach the reply to the wrong thing.',
  },
  'invalid-message': {
    retryable: false,
    meaning: 'A commit message outside the accepted length range.',
  },
  'invalid-path': {
    retryable: false,
    meaning: 'A named path is not usable for this operation — not project-relative, or in a never-committable area (build output, node_modules, .git, .studio).',
  },
  'outside-workspace': {
    retryable: false,
    meaning: 'The directory given is not a Studio project.',
  },
  'not-a-repository': {
    retryable: false,
    meaning: 'This project has no git repository of its own. Ask the user to create one from the Version control panel — you may not create it yourself.',
  },
  'empty-file-list': {
    retryable: false,
    meaning: 'The operation needs at least one file and none was usable.',
  },
  'git-failed': {
    retryable: false,
    meaning: 'git itself refused. The message is git\'s own — a missing git identity and an empty commit both land here.',
  },
  'empty-body': {
    retryable: false,
    meaning: 'A comment reply needs a non-empty body.',
  },
  'write-conflict': {
    retryable: false,
    meaning: 'The write would collide with something already on disk, and overwriting it is not this tool\'s decision to make.',
  },
  'codemod-refused': {
    retryable: false,
    meaning: 'The AST edit has no single honest target, or would destroy a binding. The refusal names the reason.',
  },

  // --- authorisation and trust -------------------------------------------
  'trust-tier-required': {
    retryable: false,
    meaning: 'This project\'s trust tier is below what the operation needs. Ask the user to promote it — you may never promote it yourself, so the same call will keep refusing until they do.',
  },

  // --- the environment cannot answer -------------------------------------
  'no-board-connected': {
    retryable: true,
    meaning: 'This tool needs the project open in a Studio browser tab, and none is connected. The server already waited for a reconnecting tab before answering.',
  },
  'capture-unavailable': {
    retryable: false,
    meaning: 'Neither the headless browser nor a live tab could produce the capture. Usually a missing Chromium (`bunx playwright install chromium`) — report it, do not re-capture.',
  },
  'measure-unavailable': {
    retryable: false,
    meaning: 'The headless browser could not render the screen to measure it. Same cause and same remedy as capture-unavailable.',
  },
  'dev-server-failed-to-boot': {
    retryable: false,
    meaning: 'The project\'s own dev script did not come up. The refusal carries the captured stdout/stderr tail — read it, fix the cause, then call again.',
  },
  'render-failed': {
    retryable: false,
    meaning: 'The dev server is up but the route could not be rendered or screenshotted.',
  },
  'remote-fetch-failed': {
    retryable: false,
    meaning: 'A remote URL could not be fetched, was refused by the SSRF guard, or exceeded the size cap.',
  },
  'asset-write-failed': {
    retryable: false,
    meaning: 'Bytes were obtained but could not be landed as a project file (validation, containment, or naming).',
  },
  'typescript-not-installed': {
    retryable: false,
    meaning: 'The project has no TypeScript of its own to type-check with. Studio never substitutes its own — the refusal carries the install command to ask for.',
  },
  'no-tsconfig': {
    retryable: false,
    meaning: 'The project has no tsconfig.json, so there is no project config to type-check under.',
  },
  'typecheck-timed-out': {
    retryable: false,
    meaning: 'tsc was killed before it finished. Any diagnostics it had already printed are returned and `pass` is forced false — an incomplete run never reports a pass.',
  },
  'tsc-invocation-error': {
    retryable: false,
    meaning: 'tsc itself could not run — a broken toolchain or tsconfig, not a code error. The refusal carries a capped output excerpt.',
  },
  'io-error': {
    retryable: true,
    meaning: 'An unexpected filesystem or subprocess error. The message carries the underlying cause.',
  },

  // --- the tool refuses on principle -------------------------------------
  'duplicate-call': {
    retryable: false,
    meaning: 'This exact write, with these exact arguments, already ran this turn and nothing else has been written since. The loop answered from the first call\'s result instead of running it again (Z3, `toolLoop.ts`) — the write you asked for has already happened, so read the echoed result rather than repeating it. Observers (screenshots, compares, measurements, typechecks) are never answered this way, and a write repeated after a different write landed runs again.',
  },
  'strict-mode-stand-in-refused': {
    retryable: false,
    meaning: 'Strict fidelity mode will not measure against a stand-in reference. Register the real design as a spec first.',
  },
} as const satisfies Record<string, ToolRefusalCodeDef>

export type ToolRefusalCode = keyof typeof TOOL_REFUSAL_CODES

/** Every code, sorted — for the docs-parity gate and for enumerating in a prompt. */
export const TOOL_REFUSAL_CODE_LIST: readonly ToolRefusalCode[] = (
  Object.keys(TOOL_REFUSAL_CODES) as ToolRefusalCode[]
).sort()

/**
 * The refusal a tool handler returns. `code` is `Type.String()` rather than a
 * union of the literals above because this schema also validates refusals that
 * arrive from the browser half of a bridged tool, where the vocabulary is
 * enforced at the call site (`toolRefusal`) rather than on the wire — a
 * refusal with an unrecognised code must still read as a refusal, never
 * degrade into a success.
 */
export const ToolRefusalSchema = Type.Object({
  ok: Type.Literal(false),
  code: Type.String({ description: 'Stable machine-readable refusal code — see TOOL_REFUSAL_CODES.' }),
  /** The rendered line every driver forwards to the model — message + remedy + code + retryable. */
  error: Type.String(),
  /** The bare human-readable cause, without the rendered code suffix. */
  message: Type.String(),
  /** The next action that could actually work. Omitted when the message already is one. */
  remedy: Type.Optional(Type.String()),
  retryable: Type.Boolean(),
})

export type ToolRefusal = Static<typeof ToolRefusalSchema>

export interface ToolRefusalOptions {
  /** The next action that could work. Rendered into `error` after the message. */
  remedy?: string
  /**
   * Extra diagnostic fields to carry alongside the refusal (the available
   * seqs, the captured log, the tier that was found). Spread FIRST, so no
   * detail can shadow `ok`/`code`/`error`/`retryable`.
   */
  details?: Record<string, unknown>
}

/** `message remedy [code=… retryable=…]` — the single rendering, used for `error`. */
function renderRefusalText(code: string, message: string, remedy: string | undefined, retryable: boolean): string {
  const body = remedy ? `${message} ${remedy}` : message
  return `${body} [code=${code} retryable=${retryable}]`
}

/**
 * Build the canonical refusal. `retryable` is derived from the code table, not
 * passed in — two call sites disagreeing about whether `no-such-page` is worth
 * retrying is exactly the drift this replaces.
 */
export function toolRefusal(
  code: ToolRefusalCode,
  message: string,
  options: ToolRefusalOptions = {},
): ToolRefusal & Record<string, unknown> {
  const { retryable } = TOOL_REFUSAL_CODES[code]
  return {
    ...(options.details ?? {}),
    ok: false,
    code,
    message,
    ...(options.remedy === undefined ? {} : { remedy: options.remedy }),
    retryable,
    error: renderRefusalText(code, message, options.remedy, retryable),
  }
}

/** Is this value a structured tool refusal? Used by the gates and by callers forwarding one. */
export function isToolRefusal(value: unknown): value is ToolRefusal {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.ok === false &&
    typeof candidate.code === 'string' &&
    typeof candidate.error === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.retryable === 'boolean'
  )
}
