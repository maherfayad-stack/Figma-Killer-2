# AI Agent
> **Purpose:** the in-canvas AI agent: providers, the tool loop, the Studio tool family, refusals · **Read when:** touching the agent, its prompt or its tools · **Trust:** current · **Owner:** mcp-tooling · **Verified:** not yet

The AI Agent is a model-powered assistant integrated into the Site editor — Studio's one and only agent surface (WS-12 §8.1 D3). The Agent Panel owns conversation state, provider selection, streaming, history, and the browser bridge.

The agent reads the current page snapshot, plans a sequence of edits, and executes them by calling tools. Structure is written as semantic HTML (`site_insert_html` / `site_replace_node_html`); styling is written as CSS — a `<style>` block and/or `class=` attributes inside the insert, or the dedicated `site_apply_css` tool for authoring/editing any CSS on its own. There is one CSS path and it accepts every selector; `site_assign_class` / `site_remove_class` attach existing classes to nodes.

The agent runs on a provider-agnostic AI runtime (`server/ai/`) that can drive any supported model (Anthropic Claude, OpenAI, OpenRouter, Ollama, or any OpenAI-compatible endpoint). Every driver talks directly to its provider's REST API over HTTP/SSE — no provider SDKs. All drivers share one multi-turn tool loop (`drivers/http/toolLoop.ts`); each supplies only a small `ProviderAdapter` of pure mapping functions. The plain `@anthropic-ai/sdk` (and any provider SDK) is banned repo-wide. Gated by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Structure via HTML.** `site_insert_html` and `site_replace_node_html` accept semantic HTML strings; the browser executor calls `importHtml` (the same pipeline as the paste-HTML UI) to convert them into first-class, editable `PageNode`s.
- **Styling via CSS.** The agent emits CSS the same way a human pastes it: a `<style>` block and/or `class=` attributes inside the `site_insert_html`/`site_replace_node_html` payload, or the standalone `site_apply_css` tool. The importer (`cssToStyleRules`) classifies every selector — a bare `.foo {}` rule becomes a reusable Selectors-panel class bound to `class="foo"`; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule; `style=` attributes land on the node's inline styles. There is no structured `classes` parameter — the agent never hand-builds classes node-by-node at insert time. `site_apply_css` is the single tool for CSS on its own, with explicit merge, replace, rule-delete, and property-removal operations; exact selector identity and `!important` priority survive the round trip.
- **One Studio agent, 35 tools total.** 6 server-side catalog read tools (resolved server-side from the posted snapshot / DB) + 29 browser-bridged tools. There is no per-surface scope split (WS-12 §8.1 D3).
- **Two-endpoint bridge.** `POST /admin/api/ai/chat` opens an NDJSON stream. When the model calls a browser-bridged tool, the server emits `toolRequest`; the browser executor reads or mutates the live workspace and POSTs the `AiToolOutput` result to `POST /admin/api/ai/tool-result`.
- **Provider-agnostic.** The runtime selects a driver (Anthropic, OpenAI, OpenRouter, Ollama, Custom Provider) from the conversation's configured credential.
- **Site tool input schemas are a single source of truth** in `@core/ai` (`src/core/ai/toolSchemas.ts`). The server registry and browser executor import from that shared leaf. Most tools reuse the exact same schema object; `site_apply_css` deliberately advertises a flat provider object because Anthropic rejects root-level schema composition, then the executor validates the payload against the leaf's exact operation union. Gated by `ai-tool-input-object.test.ts`, `ai-tool-schema-ssot.test.ts`, and `ai-tools-typebox-only.test.ts`.
- **Capabilities.** `ai.chat` required to stream; `ai.tools.write` required for write tools. Gated by `ai-handlers-capability-gated.test.ts`.

---

## Where the code lives

```text
src/core/ai/
├── toolOutput.ts           — AiToolOutput type + AiToolOutputSchema + aiToolOk / aiToolError
├── turnBudget.ts            — AGENT_TURN_ROUND_BUDGET + parseTurnStepReport / formatTurnProgress (A9; shared by the server prompt and the panel)
├── toolSchemas.ts          — all site write-tool schemas; provider/execution layers for site_apply_css share field definitions here
└── index.ts                — barrel re-export (canonical @core/ai import path)

server/ai/
├── legacyScope.ts          — LEGACY_SCOPE_COLUMN: the one permitted `ai_defaults`/`ai_conversations.scope` value (vestigial, see "Server endpoints")
├── handlers/
│   ├── chat.ts             — POST /admin/api/ai/chat  (NDJSON stream)
│   ├── toolResult.ts       — POST /admin/api/ai/tool-result  (bridge POST)
│   ├── conversations.ts    — CRUD for ai_conversations rows
│   ├── credentials.ts      — CRUD for ai_credentials rows (encrypted secrets + endpoint credentials); auto-seeds the default on create
│   ├── defaults.ts         — GET/PUT/DELETE /admin/api/ai/defaults (Studio's one default)
│   ├── models.ts           — list available models per provider; enriches Anthropic/OpenAI with catalogue prices + context windows
│   └── audit.ts            — GET /admin/api/ai/audit (usage rollups for the Audit tab; gated by ai.audit.read)
├── audit/
│   └── store.ts            — getUsageTotals / getUsageByUser / getUsageByModel / getUsageByDay (rollup queries; daily rollup bins into the viewer's local calendar day via localDayKeyFactory)
├── conversations/
│   ├── history.ts          — buildMessageHistory(): reconstruct AiMessage[] from persisted rows; heals interrupted tool calls (synthetic error results for unanswered tool_use blocks)
│   ├── store.ts            — appendMessage / listMessagesForConversation / readConversationForUser
│   └── types.ts            — MessageRecord type
├── pricing/
│   ├── index.ts            — resolveCostUsd / getModelCatalogue (6h in-memory cache, DB fallback)
│   ├── openrouterCatalogue.ts — fetches OpenRouter /api/v1/models; pricingKey() normaliser; ModelCatalogue type
│   └── store.ts            — durable DB cache in ai_model_pricing (prices + context_window column)
├── contextTokens.ts        — normalizeContextTokens(): provider-normalised "context used" for the meter
├── tools/
│   ├── site/
│   │   ├── writeTools.ts      — browser-bridged site tools (TypeBox schemas), including document reads/opening and write mutations
│   │   ├── readTools.ts       — server-side catalog read tools
│   │   ├── render.ts          — catalog derivations (`describeAgentModules`, `describeAgentTokens`, `filterTokenFamily`)
│   │   ├── systemPrompt.ts    — HTML-native static prefix + buildDynamicSuffix
│   │   └── snapshot.ts        — `SiteAgentSnapshotSchema` + `SiteAgentSnapshot` re-export + catalog output types (ModuleInfo, SnapshotTokens, …)
│   └── index.ts            — `studioTools` (= `siteTools`) + `selectStudioTools(capabilities)`
├── drivers/
│   ├── http/
│   │   ├── sse.ts             — parseSseStream(res): reassemble SSE frames across chunks
│   │   ├── execTool.ts        — executeAiTool(): server-handler vs browser-bridge dispatch; normaliseToolOutput(): wraps raw handler results in the canonical AiToolOutput envelope, validated via TypeBox (not duck-typed)
│   │   ├── toolLoop.ts        — runToolLoop(): provider-agnostic multi-turn loop
│   │   ├── toolArgs.ts        — parseToolArguments(json): shared tool-argument JSON parsing (one copy for all drivers)
│   │   ├── chatCompletions.ts — shared /v1/chat/completions SSE adapter (makeChatCompletionsAdapter); used by ollama + openai-compatible
│   │   └── errors.ts          — isAbortError / classifyHttpError
│   ├── responses-shared.ts    — OpenAI-Responses mapping + SSE translator + adapter factory (openai + openrouter)
│   ├── anthropic.ts           — Anthropic driver: direct POST /v1/messages (no SDK)
│   ├── openai.ts              — OpenAI driver: direct POST /v1/responses (no SDK)
│   ├── openrouter.ts          — OpenRouter driver: direct POST /v1/responses (shared Responses path; live /models; native cost)
│   ├── ollama.ts              — Ollama driver: POST /v1/chat/completions via shared chatCompletions adapter; live /api/tags catalogue
│   └── openaiCompatible.ts    — Custom Provider driver: any /v1/chat/completions endpoint; live GET /v1/models catalogue
└── runtime/
    ├── runner.ts           — runChat(): drives a driver, emits stream events
    ├── persister.ts        — ConversationsPersister: messages + usage to DB; writes contextTokens snapshot
    ├── types.ts            — canonical AiStreamEvent / AiMessage / AiTool / ToolContext
    └── transport.ts        — createBridge() / resolveBridgeToolResult()

src/admin/ai/
├── ndjsonStream.ts         — shared validated NDJSON reader
├── toolResultApi.ts        — shared browser-tool result POST
└── useMcpWorkspaceBridge.ts— external MCP stream + browser dispatcher for the live Site editor bridge

src/admin/pages/site/agent/
├── index.ts                — public barrel (all external imports go through here)
├── agentSlice.ts           — Zustand slice factory (createAgentSlice(config)) — Studio has exactly one config, `siteAgentSliceConfig`
├── agentProviderUpdate.ts  — timed provider/model persistence and fail-closed reconciliation
├── agentSliceConfig.site.ts— site-editor config: snapshot builder, executor wiring
├── agentConfig.ts          — conversation/default API path constants
├── agentApi.ts             — conversation bootstrap and message rehydration
├── streamEvents.ts         — NDJSON schema (ServerStreamEventSchema) + processStreamEvent reducer
├── siteAgentSnapshot.ts    — `SiteAgentSnapshotSchema` (TypeBox) + derived `SiteAgentSnapshot` type + `buildSiteAgentSnapshot` serializer
├── pageContext.ts          — editor adapter: reads active page + store scalars, calls `buildSiteAgentSnapshot`
├── executor.ts             — browser-side dispatcher: validates + runs write tools; auto-navigates canvas to node's owning document before each write
├── cssTools.ts             — site_apply_css parser + exact-selector merge/replace/delete runners
├── documentTools.ts        — list/read/open document helpers for pages, templates, and visual components
├── tokenRunners.ts         — site_set_color_tokens / site_set_font_tokens / site_set_type_scale / site_set_spacing_scale runners (split from executor.ts)
├── renderEvidence.ts       — captureAgentRenderSnapshot (site_render_snapshot tool)
├── storeRef.ts             — setAgentStoreApi / getAgentStoreApi (avoids store ↔ executor cycle)
└── types.ts                — ServerStreamEvent, AgentMessage, AgentRequestBody, …

src/admin/pages/site/panels/AgentPanel/
├── AgentPanel.tsx          — panel shell, persisted message thread, and image-gallery orchestration
├── AgentComposer.tsx       — controlled draft, paste/send lifecycle, active-model capability check
├── AgentImageGallery.tsx   — compact shared thumbnails for user and agent-tool images
├── AgentImagePreview.tsx   — modeless draggable full-image preview
├── AgentImageContextMenu.tsx — shared copy/download/Media actions for every image surface
├── PendingImageAttachmentGrid.tsx — compact pending tiles and per-image actions
├── agentImageActions.ts    — authenticated blob reads, clipboard/download, and Media upload
├── agentImageTypes.ts      — shared preview/menu image contracts and keyboard positioning
├── agentImageAttachment.ts — browser decode, resize, JPEG normalisation, and base64 encoding
├── usePendingImageAttachments.ts — ref-backed sequential image queue and per-item cancellation
├── designReferenceHeader.ts — bounded-prefix PNG/JPEG/WebP header sniff (no decode) for the lossless reference path
├── useDesignReferenceAttachment.ts — attach/upload/remove state for the ONE project design reference
├── DesignReferenceAttachment.tsx — composer control: attach button, or filename/dimensions/size chip with progress
├── AgentSessionControls.tsx — effort/permission-mode controls + restart-session button, above the composer
├── ConversationHistory.tsx — history popover (browse, restore, delete past threads)
├── ContextMeter.tsx        — compact five-segment context + conversation-usage tooltip
├── ContextMeter.module.css
├── contextMeterMetrics.ts  — five-band fill/tone calculation
├── AgentPanel.module.css
└── index.ts                — barrel export

src/admin/modals/Settings/sections/
├── AiSection.tsx           — Settings modal "AI" panel; four tabs gated by ai.providers.manage + ai.audit.read
└── ai/
    ├── ai.module.css
    ├── ProvidersTab.tsx    — CRUD for ai_credentials rows (provider-derived API key or endpoint credential shape)
    ├── DefaultsTab.tsx     — Studio's default-model editor (single row — one agent, one default)
    ├── McpTab.tsx          — create/list/revoke MCP connectors
    ├── AuditTab.tsx        — usage audit view: totals strip, by-model/user tables, daily bar chart
    └── UsageTablePanel.tsx — shared table scaffolding (title + hint header, numeric-aligned columns, empty row)
```

Shared AI number and spend formatting lives in `src/admin/ai/usageFormat.ts`, so
the Audit tab and compact composer usage detail use identical labels.

`ModelPicker.tsx`, referenced throughout this doc, lives at `src/admin/ai/ModelPicker/ModelPicker.tsx` — outside both trees above, shared by the composer and any other credential/model selector.

The Agent Panel owns the credential list load for its header, lock-state empty states, and model picker. The header always contains a `ConversationHistory` popover (browse and restore past threads), a "New chat" button (`startNewAgentConversation`), a conditional "Clear conversation" button (visible when `agentMessages.length > 0`), a streaming badge, and an "AI settings" shortcut that opens the Settings modal's AI section (`useAdminUi.getState().openSettings('ai')` — AI credentials/defaults/MCP are no longer a standalone route). The AI settings button is always visible in the header, independent of credential state.

The composer has two distinct lock states, expressed as `lockReason: 'setup' | 'chooseModel' | null`:

- `'setup'` — no credentials exist at all. The message area shows a "Connect an AI provider" empty state with a CTA that opens Settings → AI. The model picker is hidden. The textarea placeholder reads "Add AI credentials to start chatting" and the send button tooltip reads "Add AI credentials first".
- `'chooseModel'` — credentials are loaded but no default or explicit pick is active yet (`activeCredentialId` or `activeModelId` is null). The message area shows "Choose a model to get started" with a link to set a default in AI settings. The model picker remains visible so the user can pick inline. The textarea placeholder reads "Choose a model below to start" and the send button tooltip reads "Choose a model first".
- `null` — `Boolean(activeCredentialId && activeModelId)` is true; the composer is fully usable.

While credentials are still loading, `lockReason` stays `null` so the panel does not flash a setup prompt before `loadStudioDefault()` resolves.

When the panel opens, `AgentPanel` calls `loadStudioDefault()` so the model picker immediately shows the configured default — no "Default" placeholder, no send-time no-provider surprise. `composerLocked` is gated by `hasActiveProvider` (`Boolean(activeCredentialId && activeModelId)`), meaning a stale "No AI provider configured" error string never locks out the UI once a credential + model is staged; picking a model via `setAgentProvider` clears `agentError` immediately, re-enabling the composer.

The composer action row includes a compact five-segment `<ContextMeter>` immediately before Attach images and Send. `AgentComposer` resolves the full active-model descriptor from `GET /admin/api/ai/providers/:id/models?credentialId=…` (the same catalogue-enriched response the picker uses), then uses its `contextWindow`, pricing, `capabilities.visionInput`, and `capabilities.toolCalling`. A model known not to support tools is blocked with an inline "choose an agent-capable model" message; the server repeats that gate authoritatively. The meter appears as soon as a model with a known window is selected. It represents **context remaining**: a fresh conversation is five green segments and the battery drains toward amber/red as context is consumed. Hover or keyboard focus opens a wide graphical tooltip with exact context used/available, cumulative conversation input/output/cache tokens, authoritative USD spend, and current-model list rates. A context snapshot belongs to the credential/model selection that measured it, so switching models renders the meter indeterminate until the next provider response rather than comparing stale usage to a new window. The meter stays hidden when no context window is known (Ollama, uncatalogued models).

### Attaching user images

The composer accepts up to eight local or clipboard images alongside optional text. The icon button beside Send uses the shared `FileUpload` primitive and supports multi-selection; picking the same file again works after removal. Pasting or picking reserves every accepted attachment slot synchronously, then normalises the files sequentially so one selection cannot fan out into eight large browser decoders. Send stays disabled while any image is processing, while model support is being checked, after a processing failure, when the selected model is not vision-capable, or when it is known not to support agent tools. Pending attachments use compact thumbnails in a responsive grid. They never point an `<img>` at the potentially huge source file: a placeholder is shown during decoding, then replaced with the bounded normalised JPEG. Each primitive `Button` removes only its image. Removing an attachment or replacing the composer aborts its queued preparation and stops all downstream resize/encode work after the browser's current decode returns (`createImageBitmap` itself has no cancellation API). A message may contain only images: the server persists the turn normally and titles a new conversation `Image` or `Images`.

Prepared attachments, persisted user images, and session-only images returned by agent tools use the same compact 2/3-column gallery. Each thumbnail is a keyboard-accessible button that opens the original fitted inside a modeless draggable preview window. The window uses the shared admin `FloatingWindow` shell, has only a title and close action, closes on Escape without also closing the Agent Panel, and restores focus to the thumbnail that opened it.

Right-clicking an image in a pending tile, conversation gallery, or preview opens the same point-anchored `ContextMenu`; keyboard users can use the Context Menu key or Shift+F10. Actions copy the image bytes as PNG, start a MIME-correct browser download, or explicitly upload the bytes to Media. The latter uses the canonical `uploadCmsMediaAsset` pipeline (magic-byte validation, storage adapter selection, variants), requires `media.write`, primes the editor media cache, and upserts an already-mounted Media explorer. Escape closes the menu before the preview, and the preview before the Agent Panel.

The provider-neutral v1 policy is defined once in `src/core/ai/userImage.ts` and enforced on both sides of the boundary:

- accepted clipboard sources: PNG, JPEG, or WebP;
- maximum source file: 12 MiB;
- source-header guard: at most 16,384 px on either edge and 40,000,000 encoded pixels; PNG/JPEG/WebP dimensions (including JPEG EXIF orientation) are read before allocating a decoder, and `createImageBitmap` is asked for the bounded output size;
- at most eight images per message; there is no per-conversation image-count quota;
- browser output: metadata-stripped `image/jpeg`, transparent pixels composited over white;
- maximum output: 1,500,000 bytes, 1568 px on either edge, and 1,500,000 total pixels;
- complete chat-request envelope: eight maximum base64 images plus a further 16 MiB reserve for JSON framing and the live editor snapshot (about 32.8 MB total).

`agentImageAttachment.ts` fits both the edge and pixel budgets, tries progressively lower JPEG qualities, then reduces dimensions when necessary. The server never trusts that browser work: `server/ai/inputImages.ts` checks canonical base64, decoded byte length, JPEG magic bytes and dimensions, then fully decodes and re-encodes the JPEG through Sharp before appending the message. That second canonicalisation rejects truncated pixel data and strips EXIF/XMP/ICC metadata even when a direct authenticated client bypasses the browser. Unsupported, malformed, or oversized content is rejected before it can enter conversation history. The conversation single-writer lease is acquired before Sharp work, and the request signal is checked around every sequential decode: a competing request returns 409 without decoding, while a disconnected request finishes only its active Sharp pipeline and never starts the remaining images.

### Attaching a design reference (lossless, not a chat attachment)

A design reference (typically a Figma export) exists to be pixel-diffed, not looked at by the model — so it is a deliberately SEPARATE path from "Attaching user images" above, and does not share, weaken, or route through the `AI_USER_IMAGE_*` policy. The composer shows one "Attach design reference" control above the textarea: empty, it is a labeled `FileUpload` button; once attached, it becomes a chip with a thumbnail, filename, `width × height · size`, upload progress, and a remove action. Only one reference is tracked per project.

- **Client-side policy** — `src/core/ai/designReferenceImage.ts`: accepted formats are the same PNG/JPEG/WebP set as chat images, but the file is never re-encoded or resized. `DESIGN_REFERENCE_MAX_BYTES` (50 MB) is sized against a real 3x Figma export of a tall scrolling screen (commonly 15-40 MB as 24-bit PNG); `DESIGN_REFERENCE_MAX_EDGE`/`DESIGN_REFERENCE_MAX_PIXELS` (20,000 px / 120 MP) reject a decode-bomb-shaped file (a tiny byte count claiming an enormous canvas) before it ever reaches the network.
- **Dimension read** — `designReferenceHeader.ts` reads only a bounded 2 MB header prefix (PNG `IHDR`, JPEG SOF + EXIF orientation, WebP `VP8X`/`VP8 `/`VP8L`) via the same sniffer `agentImageAttachment.ts` uses (`@core/ai`'s `readImageDimensions`), so the chip can show real dimensions before the upload — and even before it completes — without decoding a single pixel.
- **Upload** — `src/admin/pages/site/studio/uploadDesignReference.ts` posts the file's ORIGINAL bytes via `XMLHttpRequest` (for progress, the same sanctioned exception `uploadStudioAsset.ts` uses) to `POST /admin/api/studio/reference-upload`, and reads/deletes the project's current reference via `GET`/`DELETE` on the same path through `apiRequest`. `DesignReferenceMetaSchema` (`@core/ai`) is the wire contract for `{ id, relPath, filename, mimeType, width, height, byteSize }` — the server's own measurement of the landed file is authoritative, not whatever the browser sniffed pre-upload.
- **Consumer** — the server-side reference store and the `studio_render_reference`/`studio_diff_frames` wiring that reads these artifacts back for pixel-diffing are a separate change; this section documents the browser-side ingestion contract only.

---

## Providers

Each entry in **Settings → AI → Providers** stores one credential. The provider id is fixed; the auth mode and input fields are derived from it — the UI never asks you to choose.

| Provider | Label in UI | Auth mode | Required field | Optional field | Model discovery |
|---|---|---|---|---|---|
| `anthropic` | Anthropic (Claude) | `apiKey` | API key (`sk-ant-…`) | — | Static `claude-*` catalogue enriched with OpenRouter prices + context windows |
| `openai` | OpenAI | `apiKey` | API key (`sk-…`) | — | Static `gpt-*` / `o*` catalogue enriched with OpenRouter prices + context windows |
| `openrouter` | OpenRouter | `apiKey` | API key (`sk-or-…`) | — | Live `GET /api/v1/models` (cross-provider; native cost reporting) |
| `ollama` | Ollama (local) | `baseUrl` | Base URL (e.g. `http://localhost:11434`) | API key (bearer, for proxied deployments) | Live `GET {baseUrl}/api/tags`, with `POST {baseUrl}/api/show` capability lookup per model; static fallback list when unreachable |
| `openai-compatible` | Custom Provider | `baseUrl` | Base URL — any host serving the OpenAI `/v1/chat/completions` wire protocol | API key (bearer; cloud services need one, local servers often don't) | Live `GET {baseUrl}/v1/models` (standard OpenAI list shape); model `id` used as label |
| `claudeCli` | Claude Code (subscription) | `apiKey` (L2 only — see below) | — (L1's "Log in with Claude" needs no field, and creates no row) | `claude setup-token` value (L2, behind a demoted disclosure) | No live catalogue — static fallback (`opus`/`sonnet`/`haiku` aliases); the CLI is the source of truth, and there is no API key to call `/v1/models` with |

**Custom Provider** (id `openai-compatible`) is the generic adapter for any endpoint that speaks the OpenAI chat/completions wire protocol — Groq (`https://api.groq.com/openai`), Together, DeepSeek, Mistral, Fireworks, self-hosted vLLM, LM Studio, and others. Capabilities default to `{ toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true }`; the operator is responsible for selecting a model that actually supports tool calling. Because arbitrary endpoints are not in the OpenRouter catalogue, no context-window enrichment is available and the context meter stays hidden for these models.

**The server is the model-capability authority.** The composer catalogue flags are early UX gates, but they are not trusted for persistence, provider calls, or tool screenshots. `chat.ts` resolves the selected model on every turn through `resolveModelCapabilities`. Providers with stable capabilities (Anthropic, OpenAI, Custom Provider) use their driver default. Model-specific providers own a selected-model lookup: OpenRouter resolves the exact entry's `architecture.input_modalities`, while Ollama sends an authenticated `POST /api/show` for only the selected model. The shared resolver de-duplicates concurrent lookups, applies a ten-second provider timeout, includes credential/backend revisions in its cache key, and caches successful results for five minutes. Missing or unavailable model-specific metadata fails closed for vision input; Custom Provider also remains fail-closed in v1. An image targeting a non-vision model, or an editor-agent turn targeting a model known not to support tools, receives 422 before the user message is stored.

---

## Claude CLI provider (WS-11) — a subprocess, not an HTTP driver

`server/ai/drivers/claudeCli.ts` is the exception to "every driver talks directly to its provider's REST API": it drives the local `claude` binary the user already has installed and logged in — the same mechanism the Claude Code VS Code extension uses. Studio never holds an API key, never reads `~/.claude/.credentials.json`, and never sends an `Authorization` header to Anthropic itself for this provider. See `src/__tests__/architecture/ai-driver-isolation.test.ts`'s doc comment for the exact rule this carves out (no provider SDK, ever; HTTP/SSE or a local user-installed binary).

**A conversation now keeps one warm `claude` subprocess alive across its turns, with the cold spawn-per-turn model described below as the crash-recovery fallback, not the primary path.** Every turn used to cold-spawn `claude` and re-handshake every MCP server attached to it — the largest fixed cost in a turn, paid identically for a one-line edit and a full screen rebuild. `claudeCliSessionPool.ts` (which conversation gets which process, and how long it lives) and `claudeCliWarmSession.ts` (how to talk to one process over `--input-format stream-json`, per `claudeCliStdinProtocol.ts`'s verified wire shape) implement this. A pooled process is reused only when the turn's `fingerprint` — model, effort, permission mode, cwd, config dir, native tool allowlist, and the MCP config's content hash — matches exactly; anything else kills the old process and spawns fresh, i.e. runs the cold path. Idle processes are killed after 10 minutes, every process is killed after 1 hour regardless of use, and at most 8 live processes are held across all users/conversations (least-recently-used idle one evicted first). A turn that cannot use a warm process (none compatible, spawn failed, or the process died before producing output) runs the cold path unchanged — everything below about `--session-id`/`--resume`, the filesystem transcript probe, and per-turn MCP connector minting/revocation describes that cold path, which both paths still fall back to and which remains fully live code, not a legacy shim.

**Two login paths, both landing in the same per-user `CLAUDE_CONFIG_DIR` — only one of which stores anything.** WS-11 §3 P2's finding still holds: *"L1 needs no row, and no default either. A terminal login leaves nothing for Studio to store; the credential lives in the user's config dir."* This section's earlier draft had L1 auto-create a keyless credential row to give the model picker something to select; that shipped a real DB `CHECK` violation (`ai_creds_apikey_shape_check` requires `ciphertext`/`iv` non-null for every `apiKey`-mode row) and, on reflection, the wrong shape entirely — a row that represents "there is no secret here" is exactly what that constraint exists to forbid. It was reverted; no migration ships for this.

| | Path | Studio holds a secret? | Works on a remote server? |
|---|---|---|---|
| **L1** | Click-to-authorize terminal login — the Add-credential dialog's **"Log in with Claude"** button (`ProvidersTab.tsx`) calls `POST /admin/api/ai/providers/claude-cli/login-terminal` (`server/ai/handlers/claudeCliLoginTerminal.ts`), which — only when the request is loopback (`isLoopbackRequest`, `security.ts`) — opens a **detached, visible terminal window on the server's own host** running `claude auth login` with `CLAUDE_CONFIG_DIR` already set (`server/ai/drivers/claudeCliTerminalLaunch.ts`). The CLI opens the user's browser itself; the user authorizes there. The dialog polls `GET .../status` for `loggedIn: true` and, on success, shows a plain confirmation — **it creates no credential row**. `claude auth login`/`claude setup-token` are still Ink TUIs that die on piped stdin, so Studio never drives the CLI's stdin directly — no PTY dependency was added to work around that; a REAL terminal is opened instead. | No — never a token, not even transiently. | No — remote requests get a stated reason and the paste-a-token field instead; opening a terminal on the server is meaningless to a caller elsewhere. |
| **L2** | Token paste — the user runs `claude setup-token` anywhere (their own machine, or the server, if they have shell access there) and pastes the result behind the dialog's demoted **"Or paste a setup-token instead"** disclosure, as a normal `apiKey`-mode credential, `providerId: 'claudeCli'`. Stored via the existing encrypted credential store — `auth_mode='apiKey'` fits `ai_creds_apikey_shape_check` unchanged, and `provider_id` has no DB constraint, so this shipped with **zero migrations**. **This is still the only path that produces a row the model picker can select.** The token is inference-only (cannot drive Remote Control) and does **not** refresh — `CredentialView.expiresAt` (computed from `createdAt` + 1 year, not a stored column) surfaces the deadline in the Providers tab rather than letting it expire silently. | Yes, encrypted, per user. | Yes — this is what makes server-side login work at all. |

Every spawn (probe or chat) sets `CLAUDE_CONFIG_DIR` to `<CLAUDE_CLI_DATA_DIR>/<userId>/` (default `./.data/claude-cli`, override with `CLAUDE_CLI_DATA_DIR`), created mode `0700` by `ensureClaudeCliConfigDir`. `userId` is validated as a safe path segment (`assertSafeClaudeCliUserId`) and re-checked for containment (`assertPathWithin`) before it ever reaches a join — the same discipline `appRoot.ts` applies to project-relative paths. **macOS cannot honour this**: `CLAUDE_CONFIG_DIR` does not relocate the OS keychain, so `claudeCliPlatformSupport()` reports the provider disabled with that reason on `darwin` — never a silently shared login.

**"Usable provider", not "credential row exists" (`AgentPanel.tsx`).** A `claudeCli` host that `claude auth status --json` reports as `loggedIn: true` is a real, almost-ready provider even with no stored row — the AgentPanel composer's empty state reads the same `GET .../status` endpoint `ProvidersTab.tsx` polls (fetched once, only when there are zero credentials at all) and swaps its generic "Connect an AI provider" copy for "Claude Code is logged in on this device — add it as a credential in AI settings", both in the empty-state panel and the inline credential alert. This is a messaging refinement only: it does **not** unlock sending. `chat.ts` still resolves a turn's provider through a stored `ai_provider_credentials` row via `conversation.credentialId`, and `ModelPicker.tsx` has no credential-less entry to pick — an ambient "send with a login but no row" path would need a new dispatch shape in `chat.ts` plus a synthetic picker entry, which is a separate, larger design decision, not attempted here.

**Opening the terminal (`claudeCliTerminalLaunch.ts`).** `resolveTerminalLaunchSupport(platform, isLoopback)` is the availability gate, surfaced as `terminalLogin: { available, reason? }` on `GET .../status` so the dialog knows whether to offer the button before the user ever clicks it. Verified on Windows (the dev platform) against the real OS, not assumed, through several rounds of correction:
- **Opening the window at all.** PowerShell's `Start-Process -FilePath <path-to-a-.bat> -WindowStyle Normal`, run from an outer `powershell.exe -WindowStyle Hidden` so only the target window is visible, reliably opens a real windowed terminal (confirmed via `Get-Process` picking up a host process — `WindowsTerminal.exe` on this Windows 11 box, `conhost.exe` on Windows 10 — with the exact requested title). `cmd /c start` could not be visually confirmed inside one earlier verification pass's own sandboxed shell (a Job Object/window-station artifact of that specific harness, not of Windows), so the shipped implementation uses the confirmed-working path.
- **The window closing itself instantly.** The first script ran `del "%~f0"` (self-delete) before `pause`. cmd.exe does not read a running batch file into memory — it holds a file handle and seeks line by line — so deleting it mid-script made the very next line unreadable: cmd printed "The batch file cannot be found." and exited immediately, which looked exactly like the login failing. Fixed by moving the self-delete to the very end, forced out of the batch-file execution context first: `(goto) 2>nul & del "%~f0"` — verified empirically that every line runs first and the file is still removed after.
- **`'claude' is not recognized`, even with the binary installed.** `Start-Process` uses ShellExecute, and the process it creates does **not** inherit this server's environment — verified by running the exact chain and finding even `where` (in `System32`) unresolvable, i.e. PATH was effectively empty. The script therefore never relies on inherited environment for anything: it resolves `claude`'s absolute path via `Bun.which('claude')` (a test seam — `which` — makes both the found and not-found cases deterministic without depending on the host's real `PATH`) and writes both `PATH` and the resolved binary path INTO the script (`set "PATH=..."`, `call "<absolute path>" auth login`), the same way `CLAUDE_CONFIG_DIR` already was — never a bare `claude auth login` relying on PATH resolution. `Bun.which` returning `null` is an explicit `{ ok: false, reason: 'Could not find the `claude` CLI on this machine...' }`, not a silent failure. Both embedded values are `%` → `%%` escaped (`%` is the batch variable sigil).

The Linux path (a best-effort chain over `x-terminal-emulator` / `gnome-terminal` / `konsole` / `xfce4-terminal` / `xterm`, first one present on `PATH` wins) is **UNVERIFIED** — no Linux host was available — and degrades to the manual/paste-a-token path with a stated reason if none are found. macOS never reaches this code in practice: `claudeCliPlatformSupport()` already disables the whole provider there, so the button never renders; `resolveTerminalLaunchSupport` still answers defensively rather than guessing. Every reason string returned to the client is a static, caller-safe message — raw spawn errors and temp-file paths are logged server-side only (`console.error('[claudeCliTerminalLaunch] ...')`), never returned in the response.

**The dialog's poll (`ProvidersTab.tsx`).** After a successful launch, the dialog polls `GET .../status` every 3s for up to 5 minutes, stopping on `loggedIn: true`, on an explicit Cancel, on timeout, or when the dialog unmounts (it is only ever rendered while open, so component teardown IS "stop polling when the dialog closes"). A `loggedIn: true` poll result shows a confirmation and reveals the paste-a-token disclosure — it does not create anything. Typing into the token field also cancels an in-flight wait (the two paths are independent; a user who gave up on the terminal and pasted a token instead shouldn't sit behind a disabled submit until the poll times out). `GET .../status`'s `terminalLogin` field is independent of the CLI-availability classification: a remote caller or an unsupported platform can be `logged-out` while `terminalLogin.available` is false, in which case only the paste-a-token path is offered.

**Availability probe** — `claudeCliProbe.ts`'s `probeClaudeCliAuth()` runs `claude auth status --json` (via `runCappedSubprocess`, cwd = a neutral temp dir, never a project) and classifies the result into `logged-in` / `logged-out` / `not-installed` / `probe-failed`. It deliberately never reads `apiKeySource` (present in the same JSON body, but it reports the API-key source, not auth state, and reads `"none"` even when fully logged in).

**Chat streaming** — `claudeCliSpawn.ts`'s `spawnClaudeCliNdjson()` reads the CLI's stdout incrementally (line-by-line, not "wait for exit" — a chat turn needs to stream, unlike the one-shot probe), and `claudeCliEvents.ts` translates each `stream-json` line into canonical `AiStreamEvent`s: `assistant` messages become `text` events (skipping the synthetic auth-failure message, `message.model === "<synthetic>"`), and the terminal `result` event becomes `context` + `usage` (its own `total_cost_usd` wins over the shared pricing-table estimate — it already accounts for every model in `modelUsage`, including an internal classifier call Studio never requested) + `done`/`error` keyed off `result.is_error` (**never** `result.subtype`, which reads `"success"` even on a failed turn).

The full argv:

```
claude -p <prompt> --output-format stream-json --verbose --model <id>
  --effort medium --permission-mode <'acceptEdits' with a project open | 'default'> --tools <'Read,Write,Edit,Glob,Grep' | 'Read' | ''>
  [--mcp-config <path to a private temp file>] --strict-mcp-config
  --session-id <uuid> | --resume <uuid>
```

`--mcp-config`'s value is a filesystem path, not inline JSON — see the "MCP tool routing" paragraph below for why.

**"Private" means something different per platform, and both halves are real.** On Linux and macOS the directory is `0700` and the file `0600`, set at creation. On Windows `chmod` decides nothing — Node maps it onto the single read-only attribute and `statSync` reports `0o666` back whatever was asked for — so `createPrivateTempDir` (`server/ai/credentials/privateTempDir.ts`) runs `icacls <dir> /inheritance:r /grant:r "<user>:(OI)(CI)(F)"` through the bounded subprocess runner instead, **before** the secret is written into the directory: on NTFS a new file inherits its parent's inheritable ACEs at creation, so the config file never exists with a wider ACL. The resulting DACL is a single entry naming this user, with `SYSTEM` and `BUILTIN\Administrators` removed.

Two things make that guarantee hold rather than merely be likely (`sec-15`). The config file is created with `O_CREAT | O_EXCL` (`writePrivateFileExclusive`), not a plain truncating write: `mkdtempSync` creates the directory with the ACL it *inherits* and only then does `icacls` narrow it, and `/inheritance:r` on the parent does **not** strip an explicit ACE from a child that already exists — so a file planted in that window, with a DACL granting the planter read, would be opened-and-truncated and would receive the secret. `O_EXCL` refuses the name instead. And a failed `icacls` is a **refusal to write the secret at all**: `writeMcpConfigFile` deletes the staging directory and throws, which `tryWriteMcpConfigFile` turns into the same degradation a failed connector mint already gets — the turn runs without MCP tools. A capability is lost; a token is never written into a directory whose access control Studio failed to set.

`claudeCli.test.ts` asserts the mode bits on POSIX and the DACL on Windows; it used to assert `0o600` on both, which is why it sat in `standing-01`'s failure bucket. `claudeCliMcpConfigFile.test.ts` drives the refusals — a planted file, a failed restriction, a failed write — and asserts no staging directory survives any of them.

**Native tool surface.** The spawned session used to carry NO `--tools`/`--allowedTools` restriction at all — the top-level `claude` process could reach every native built-in directly, bypassing the containment checks the MCP tools enforce. `resolveNativeToolAllowlist` (`claudeCliToolSurface.ts`) now computes the allowlist fresh per turn and never omits the flag: `Read,Write,Edit,Glob,Grep,Task` when a real, containment-checked project is open (the agent's authoring path — see "The agent authors files" below); `Read` alone when no project is open but this turn staged an attachment; `''` otherwise. `Bash` is withheld unconditionally, on every turn, at every trust tier, in every permission mode — trust tiers gate MCP-mediated capabilities like `studio_install_deps`, and neither has ever gated a raw shell. What bounds a native write is the process, not the tool list: `cwd` is the validated project directory, and the CLI refuses a write outside it plus whatever `--add-dir` pre-authorises (this turn's attachment staging directory, nothing else). `--tools` is a hard availability list, independent of and prior to `--permission-mode`, so it holds even under a user-selected `bypassPermissions`.

**Workspace `cwd` (step 2).** A real chat turn spawns in the resolved, containment-checked project directory — `resolveClaudeCliWorkspaceCwd(req.workspaceDir, projectsRoot)` (`claudeCliEnv.ts`), fed from `useAdminUi`'s open `studioProject.dir` through `agentSlice.ts` → `AiChatRequestBody.workspaceDir` → `AiStreamRequest.workspaceDir`. This is what makes `.claude/agents/*.md` auto-discovery, `CLAUDE.md` discovery, and the tools' own view of the project work at all — spawn in the wrong place and the project's generated `CLAUDE.md` silently doesn't reach the agent — and, since the agent's file tools are bounded by `cwd`, nothing it writes lands in the right project either. Containment mirrors `appRoot.ts`: both the requested path and the projects root are resolved through `realpathSync` before the prefix check, so a symlink pulled in from a GitHub import can't escape it. No workspace open, or containment fails → falls back to the per-user `CLAUDE_CONFIG_DIR` (a documented degraded case, not a crash). The availability **probe** always stays in the config dir — it must never risk a real project's `CLAUDE.md` cache-creation cost (see the cost warning below).

**Multi-turn continuity (step 2).** `--input-format stream-json` exists (confirmed via `--help`) but its stdin message shape was never verified against the binary — establishing it with confidence would mean sending a real paid turn, which this driver's tests must never do. Instead the driver uses the CONFIRMED `--session-id`/`--resume` pair, keyed by a UUID **deterministically derived** from the Studio conversation id AND its `session_epoch` (`claudeCliSession.ts`'s `claudeCliSessionId(conversationId, epoch)`, SHA-256 truncated to 16 bytes with RFC 4122 version/variant bits set) — the same `(id, epoch)` pair always hashes to the same UUID, so there is still no stored UUID, only the epoch counter (migration 021's `ai_conversations.session_epoch`, `not null default 0`). **Epoch 0 hashes `conversationId` alone — byte-identical to the pre-epoch function** — so this never orphans a live installation's already-running CLI sessions; only a bumped epoch changes the derived id (pinned by an independently-computed test fixture in `claudeCliSession.test.ts`). `req.messages` is still only consulted for the latest user message's text (the `-p` prompt) — the CLI's own session file remembers the rest, not a replayed `AiMessage[]` log the way every HTTP driver in this directory does it.

**Establish vs. resume is a filesystem probe, not a message count.** The original `isFirstClaudeCliTurn` heuristic (message count ≤ 1 → establish) broke the instant "Restart agent session" (below) existed: after a restart the conversation has plenty of replayed history, but the bumped epoch derives a UUID the CLI has never seen, so `--resume` would fail outright. `shouldEstablishClaudeCliSession(configDir, cwd, sessionId)` asks the real question instead — does the CLI already have a transcript file for this exact `(configDir, cwd, sessionId)`? Reverse-engineered (not documented in `--help`) from real transcripts the installed binary wrote on the coordinator's own machine, both under a normal `~/.claude/projects/` and under a `CLAUDE_CONFIG_DIR` override (the exact override this driver sets on every spawn): `<configDir>/projects/<sanitized cwd>/<sessionId>.jsonl`, where the sanitized `cwd` replaces every character that is not `[A-Za-z0-9]` with a single `-` (`claudeCliProjectDirName`). As a side effect this self-heals cases the message-count check never could — a cleared/rotated config dir, a server redeploy onto a fresh volume, or a workspace `cwd` change between turns all leave no transcript for the current pair, so the turn correctly re-establishes rather than sending a `--resume` the CLI would reject. If a future CLI version ever changes this layout, the failure mode is graceful (every turn reads as "no session found" and always establishes — never a resume of something nonexistent, and `ai_messages` stays the durable transcript regardless); the documented fallback if this probe ever proves unreliable is to stop guessing at the CLI's layout and thread the epoch-bump point through explicitly instead.

**Restarting the agent session (`session_epoch`, migration 021).** `POST /admin/api/ai/conversations/:id/restart-session` (`server/ai/handlers/conversations.ts`'s `handleRestartSession`, gated by the same `ai.chat` capability as every other conversation route, owner-checked, 409 if a turn is currently streaming for that conversation) increments `session_epoch` via `bumpSessionEpochForUser` (`conversations/store.ts`). The next turn's `claudeCliSessionId` therefore derives a brand-new UUID, and `shouldEstablishClaudeCliSession` correctly reads that as "no session found" and establishes fresh — re-reading newly-approved MCP servers (`projectMcpServers.ts`'s `approvedMcpServers`) and any other per-spawn config, without touching the conversation row, its messages, or its title. `AgentSessionControls.tsx`'s `RestartSessionButton` is the UI: an icon button next to the permission-mode trigger, disabled while streaming or with no active conversation yet, always states in its tooltip/`aria-label` that it starts a fresh CLI session while keeping this chat's history, and reports success/failure via `pushToast`. Every non-`claudeCli` driver ignores `AiStreamRequest.sessionEpoch` entirely, so bumping it against a conversation on another provider is a harmless no-op.

**`--effort`/`--permission-mode` (step 2).** `--effort` ships wired with a fixed default (`medium`) — a real, explicitly requested requirement, not a nicety, even though no session-controls UI exists yet (WS-12 §5.2 owns that). `--permission-mode` accepts exactly WS-12 §5.2's four modes (`default | acceptEdits | plan | bypassPermissions`) plus `auto`/`dontAsk` (confirmed via `--help`) — a 1:1 mapping with no translation layer whenever that UI ships. Only `'default'` is used today. **`bypassPermissions`/`--dangerously-skip-permissions` is never passed by this driver, under any condition** — that is a hard constraint, not a default that could be flipped by a future options object.

**MCP tool routing (step 3).** `req.tools` (Studio's generic `AiTool[]` list) is never forwarded to the CLI directly — it wouldn't mean anything to it. Instead, before spawning, `server/ai/mcp/sessionConnector.ts`'s `mintClaudeCliSessionConnector()` mints a fresh MCP connector scoped to the caller's own capabilities (privilege-floor rule: never more than the caller holds) with a 1-day TTL floor, by calling the connector store directly rather than the admin `handlers/connectors.ts` endpoint — that endpoint requires `requireStepUp` (a fresh-MFA-like re-auth), which is designed for a human consciously minting a long-lived credential, not a server minting one per chat message. `buildMcpConfig` assembles `{"mcpServers":{"studio":{"type":"http","url":"http://127.0.0.1:<port>/_studio/mcp","headers":{"Authorization":"Bearer <token>"}}}}` — Studio's own `/_studio/mcp` endpoint, on this same running process — but the subprocess is launched with `--mcp-config <path>`, NOT that JSON inline: `writeMcpConfigFile` (`claudeCliMcpConfigFile.ts`) serialises it to a file created with mode 0600 at open time (never chmod'd after — that would leave a window where the file is briefly wider than 0600) inside a fresh `os.tmpdir()` directory that `createPrivateTempDir` (`server/ai/credentials/privateTempDir.ts`) has already made private, and the driver's own `finally` block deletes that directory unconditionally when the turn ends — success, error, or the subprocess killed on abort. This exists because `ps -eo command` prints a process's full argv to any local process, no privilege required; an inline `--mcp-config` would print this bearer token — and, once a project/registered server is approved, a real third-party secret like a Figma PAT — to that output in plaintext, silently defeating `mcpServerSecretStore.ts` encrypting the exact same values at rest. So the CLI's own MCP client discovers Studio's real toolset through the SAME `(userId, scope)` live editor bridge an external Claude Code connector uses (see `mcp-connectors.md`), with zero duplicated tool-routing code, and without the secret ever touching argv. `--strict-mcp-config` is **mandatory** whether or not a connector was minted: without it the CLI merges the user's own `~/.claude.json` and the project's `.mcp.json` and connects to whatever it finds there — Studio ships exactly the toolset it intends and no more. The token is revoked in a `finally` block when the turn ends — scoped to and expiring with the single turn, never reused. If minting fails (a transient connector-store hiccup) or the config file can't be written, the turn degrades to tools-less rather than failing outright — the same fail-soft posture step 1 shipped with.

**The loop-ownership fork.** Every HTTP driver is a thin adapter: `runToolLoop` (`drivers/http/toolLoop.ts`) owns the multi-turn agent loop, tool dispatch, and retries. `claudeCli.ts` does not call `runToolLoop` at all — the `claude` subprocess owns its own agent loop internally, now genuinely exercising tools via the MCP routing above. Turn structure, retries, and tool-permission prompts are the CLI's, not Studio's. That is a permanent, documented behavioural fork from every other driver, not an oversight.

**Model list.** No verified "list installed models" command exists, so `listModels()` still returns a static 3-entry fallback (`opus`/`sonnet`/`haiku`), explicitly `catalogueSource: 'fallback'` — the same staleness signal Ollama's driver uses when it has no live catalogue either. `seedEmptyDefaults` (`handlers/credentials.ts`) already refuses to auto-default a model from a fallback-only list.

**The "Test" credential action needed its own liveness check, because the catalogue can't prove it — and, on the first attempt, neither could `auth status`.** `POST /admin/api/ai/credentials/:id/test`'s default check counts models with `catalogueSource !== 'fallback'` — a real check for a provider with a live `/v1/models`, but `claudeCli`'s ENTIRE catalogue is `'fallback'` by design (no API key to call that endpoint with), so that check failed a perfectly valid credential every time, misleadingly naming a "provider endpoint" this driver doesn't have. Fixed generally, not with a `providerId === 'claudeCli'` special case in the handler: `AiProvider` gained an optional `verifyCredential?(credentials, signal): Promise<void>` (`drivers/types.ts`) — a driver that can prove liveness its own way implements it; `dispatchTest` (factored into the exported, unit-testable `verifyCredentialOrCountModels`, `handlers/credentials.ts`) calls it when present and falls back to the live-model count only when absent.

**`claudeCli`'s first implementation reused `claude auth status --json` and was itself wrong — confirmed empirically, not assumed.** With `CLAUDE_CODE_OAUTH_TOKEN` set to an INVENTED string, `auth status` still exits 0 with `{"loggedIn":true,"authMethod":"oauth_token"}` — it only checks that some auth source is present, and never contacts Anthropic (`claudeCliProbe.ts`'s "What this probe does NOT prove"). A "Test" built on it passed every syntactically plausible token and left the user to discover the truth as a `401` mid-chat — a check that cannot fail is worse than no check.

`verifyClaudeCliCredential` (`claudeCliVerify.ts` — split out of `claudeCli.ts`, which streams long-lived tool-using turns; verification is the opposite shape, a single throwaway subprocess whose only output is pass-or-throw, with its own argv, scratch dir, and error vocabulary) instead runs the smallest REAL turn with the stored token: `--tools ""` (the CLI's documented "no tools" value), `--system-prompt 'Reply with the single word OK.'` (replaces the large, cache-created default), `--model haiku --effort low`, `--disable-slash-commands`, `--strict-mcp-config`, `--no-session-persistence`, `cwd` a neutral temp dir (no `CLAUDE.md` discovery) — measured at **$0.001** per call (298 input / ~160 output tokens) versus $0.0099 for the same turn with defaults left on. `--output-format json` (not `stream-json`) since there's nothing to stream — one `result` object is the whole answer, read via the same `parseClaudeCliLine`/`ClaudeCliLine` shape the chat translator uses. `result.is_error` + `api_error_status === 401` is the specific "Anthropic rejected this token" case; any other `is_error` surfaces `result.result` verbatim rather than blaming the token for an unrelated failure (e.g. API overload). Runs against a fresh, empty scratch config dir (`mkdtempSync`, always cleaned up) with the credential's OWN token as `CLAUDE_CODE_OAUTH_TOKEN` — never the caller's ambient per-user `CLAUDE_CONFIG_DIR`; a stored L2 token and the host's own L1 login state are different facts a user can have independently, and verifying the wrong one would pass a test for a token that doesn't actually work. A cheap, no-spawn shape check runs first, and it distinguishes the two wrong things users actually paste here. A value prefixed `sk-ant-` but not `sk-ant-oat` is an Anthropic console **API key** — a perfectly valid credential in the wrong row of the provider list, so the message points at the `anthropic` provider (where it works immediately, billed per token) rather than only saying what it isn't. Anything else is almost certainly the browser's one-time authorization code, which is meant to go back into the waiting terminal and fails deep inside a real chat turn otherwise. Saying "that isn't a setup-token" to someone holding a working API key is technically true and useless — that was the first version of this message, and it sent a real user looking for a token they already had no reason to mint.

`verifyCredentialOrCountModels` is covered against a fake `AiProvider` (`credentials.test.ts`) with the exact regression this fix closes: a fallback-only catalogue still tests OK when its own `verifyCredential` succeeds. `verifyClaudeCliCredential` itself is covered against a fake spawn (`claudeCli.test.ts`): the 401 and non-auth-failure cases, the no-spawn shape/no-token refusals, and that the argv is the stripped-down verification shape (empty `--tools`, `haiku`, `--no-session-persistence`).

**The setup-token shape check also runs free, at save time.** `AiProvider` gained a second optional hook, `validateSecretShape?(secret): void` — synchronous, no subprocess, no cost — implemented by `claudeCli` as the same `assertLooksLikeSetupToken` check `verifyClaudeCliCredential` runs before spending anything, so both paths give the identical message. `POST`/`PUT /admin/api/ai/credentials` (`secretShapeError`, `handlers/credentials.ts`) calls it before `createCredentialForUser`/`updateCredentialForUser`, so a pasted browser authorization code is rejected immediately at creation — not silently encrypted and stored, to surface as a bare `401` the first time chat spends the paid `/test` round trip or a real turn.

**Availability status over HTTP (step 2 UI)** — `GET /admin/api/ai/providers/claude-cli/status` (`server/ai/handlers/claudeCliStatus.ts`) runs the same platform check + `probeClaudeCliAuth()` the driver itself uses and returns `{ availability: 'logged-in' | 'logged-out' | 'not-installed' | 'unsupported' | 'probe-failed', reason?, loginCommand?, subscriptionType?, terminalLogin: { available, reason? } }` — never silently absent, matching the rule WS-10's probes follow. The classification itself (`classifyClaudeCliStatus`) is factored out as a pure function so it's unit-tested against every variant with no real binary, database, or authenticated request; `terminalLogin` is computed separately (it depends on the live request's loopback-ness, not the platform/probe inputs `classifyClaudeCliStatus` classifies) and merged onto all three of `handleStatus`'s return paths. Consumers:
- `ProvidersTab.tsx`'s Add-credential dialog disables the `claudeCli` provider option outright only for `not-installed`/`unsupported` — true host-level blockers that make BOTH login paths and any stored L2 setup-token credential unusable, since either way the same `claude` subprocess has to run. `logged-out` is deliberately **not** disabling here: this dialog's whole purpose for claudeCli is either the "Log in with Claude" terminal flow or accepting a pasted L2 setup-token, so it stays selectable.
- `ModelPicker.tsx` fetches the same status once a `claudeCli` credential is present in the list, and renders that credential's entire model group disabled-with-reason for `not-installed`/`unsupported` only. `logged-out` does **not** disable a stored credential's group — a stored credential is always an L2 setup-token, sent as `CLAUDE_CODE_OAUTH_TOKEN` at spawn time independent of the host's own CLI login state, so a credential that exists is not blocked by the host being logged out of L1.

**Launching the terminal over HTTP** — `POST /admin/api/ai/providers/claude-cli/login-terminal` (`server/ai/handlers/claudeCliLoginTerminal.ts`) re-checks loopback-ness and platform support server-side (never trusts the client-side `terminalLogin` hint alone), resolves the caller's own config dir, and calls `launchClaudeCliLoginTerminal`. Always 200 with `{ ok, reason? }`, never a 4xx/5xx for an "expected" unavailability — same pattern as `POST /credentials/:id/test` — so the dialog renders the reason inline instead of branching on a thrown `ApiError`.

**Cost warning.** A single trivial prompt run against a real project cost $0.168 in testing because it cache-created ~27k tokens of `CLAUDE.md` and project context. The availability probe must always spawn with an empty/neutral `cwd`, never a real project — `claudeCliProbe.ts` uses `os.tmpdir()` for exactly this reason. A real chat turn is different: it deliberately spawns in the real project directory now (see "Workspace cwd" above) because that's required for `.claude/agents/*.md` and `CLAUDE.md` discovery to work — the cost is the price of those features actually functioning, not a residual bug.

**Tests never spawn the real binary — or a real terminal.** Every test (`server/ai/drivers/claudeCli*.test.ts`, `server/ai/handlers/claudeCliStatus.test.ts`, `server/ai/drivers/claudeCliTerminalLaunch.test.ts`, `server/handlers/__tests__/claudeCliEnv.test.ts`, `server/handlers/studio/projectGuide.test.ts`) injects a fake `spawn` matching `subprocessRunner.ts`'s `SubprocessSpawnFn`, or a fake `mintConnector`/`revokeConnector`/`generateGuide`, and feeds recorded NDJSON fixtures shaped like the verified CLI contract. No test makes a real API call or mints a real database-backed connector against a live process. `claudeCliTerminalLaunch.test.ts` also injects `which` (`launchClaudeCliLoginTerminalOptions.which`, defaulting to `Bun.which`) so the "claude resolves on PATH" and "claude is missing" cases are deterministic regardless of what's actually installed on the machine running the suite — and, per the PATH-inheritance bug above, asserts on the WRITTEN SCRIPT'S CONTENT (captured by diffing `tmpdir()` before/after the call), not just the returned result: it must contain an explicit `set "PATH=` line and invoke `claude` by its resolved absolute path, never by bare name — a script that merely contained `claude auth login` would pass a result-only assertion while still being unable to run. It covers the Windows single-attempt path, the Linux candidate-chain fallthrough, and the platform/loopback availability matrix, all against a fake spawn (it still writes the small login script to a REAL temp file via `Bun.write` — never executed, since the spawn that would run it is faked — cleaned up in `afterAll`). `server/ai/handlers/claudeCliLoginTerminal.test.ts` covers the HTTP wiring (method, auth, non-loopback rejection) by calling the route function directly with a `stampSocketIp`-stamped request, deliberately never exercising the loopback-success path end to end (that would call the default, un-faked `Bun.spawn`).

---

## Studio-project system prompt and tools

Against an open Studio project the agent runs a Studio-specific prompt and toolset, chosen per-request from live context, never a persisted discriminator. Before this existed the in-canvas agent ran the CMS page-builder prompt (`site_insert_html`, `<studio-outlet>`, `data.rows`) against a real React repo, where none of that vocabulary can work.

### The agent authors files (studio-fs)

**The agent edits the project with ordinary file tools.** `resolveNativeToolAllowlist` (`claudeCliToolSurface.ts`) grants `Read,Write,Edit,Glob,Grep,Task` whenever a real, containment-checked project is open, and the subprocess is spawned with `cwd` set to that project directory — which is what bounds them. `Bash` is never granted, at any trust tier, in any permission mode; nor is `WebFetch`, `WebSearch`, or `NotebookEdit`. With no project open the allowlist is `Read` (only when this turn staged an attachment) or `''`.

This replaced composing screens exclusively through `studio_apply_edits`' AST insert engine. That was safe and unusably slow: each insert reparses the file and shifts every node id, so the agent re-read the world between elements. **One mobile screen cost over twenty minutes** and routinely landed broken — the path of least resistance through a typed-edit API is one giant inline `style={{…}}` rather than a real stylesheet, because that is the shape the API rewarded. A screen is a component file and a stylesheet; authoring one is two `Write` calls.

The AST edit engine did not go anywhere. `studio_apply_edits`/`studio_codemod` are still what the canvas PANELS write through (`studioWriteback.ts`), and still what an external MCP client with no filesystem access to the project uses. They are simply not part of the in-canvas agent's surface.

**`--permission-mode` is `bypassPermissions` on a Studio panel turn** — the composer sends it explicitly on every message (`agentSessionControlsInitialState`); see "Bypass is the Studio panel's DEFAULT mode" below for why that does not widen anything. When a request names NO mode at all, `resolvePermissionMode` (`claudeCliPermissionMode.ts`) falls back to `acceptEdits` with a project open and `default` otherwise — never to Bypass. Under `default` the CLI stops and asks before every file write, which Studio relays as an Allow/Deny card — a dozen identical questions to author one screen, each asking permission to do the thing the user just asked for. `acceptEdits` auto-accepts edits inside the working directory and nothing beyond it. Every other permission-bearing tool still prompts, and trust tiers are untouched (`studio_install_deps` reads `.studio/meta.json`, never the permission mode). An explicitly requested mode always wins.

### Subagents — `Task` on the CLI, `studio_delegate` on the HTTP drivers

**`Task` is granted, and screens are built in parallel.** It was withheld for a while, after a real failure: the CLI does **not** error on an unknown `subagent_type` — it silently falls back to its own built-in `general-purpose` agent and returns as if the work had happened. Observed exactly that way: the agent delegated screen authoring to an invented name, reported ten files written in detail, and every one was still an untouched scaffold. Studio used to generate an eleven-agent roster into `<project>/.claude/agents/` and spend a prompt paragraph warning the model not to invent a name; that only narrowed the odds, so the tool was removed.

Removing it also made every multi-screen board strictly sequential — three screens took 45 minutes across 154 turns, for work that shares no file. The cause of the fabrication was the *invented name*, not delegation, so the fix now targets that: the prompt's **Parallel work** section pins `subagent_type` to `'general-purpose'` — the CLI's own built-in, the one value that cannot fall back to something else because it *is* the fallback — and requires each delegated prompt to be self-contained, since the subagent sees only the text it is sent.

Collisions are prevented **structurally, not by a lock**. A Studio screen is a page, and a page owns exactly two files nothing else touches (`pages/<Name>.tsx`, `pages/<Name>.module.css`), so one agent per page is disjoint by construction. Every genuinely shared file — the i18n dictionary, shared components, `package.json`, `.studio/boards.json` — stays the orchestrator's alone, done before the fan-out (create pages, add every translation key, install dependencies, register references) and after it (measure with `studio_compare`, then fix or re-delegate). Two agents appending to one dictionary would destroy each other's work silently, which is why that carve-out is stated in the prompt rather than left to judgement.

Gated by `src/__tests__/architecture/studio-agent-subagent-contract.test.ts`: `Bash` is never granted on any turn shape, `Task` is granted **only** with a project open, the prompt pins `'general-purpose'` and names none of the invented roster names, and it states both halves of the ownership rule.

**On the HTTP drivers the same fan-out is `studio_delegate` (AI-23, `server/ai/delegation/delegateRunner.ts`).** An API-key turn had no `Task`, so a three-screen ask was built one screen after another in one context. `studio_delegate({ tasks: [{ page, brief }] })` runs one bounded child tool loop per page (at most 4 per call), concurrently, on the turn's own driver and credential, and returns each child's final report, the files it wrote, and its round and tool counts. The contract is the CLI's, and here it is **enforced rather than asked for**: each child's `studio_write_file` / `studio_edit_file` / `studio_edit_files` are wrapped so a write to anything but the page's component file and its `.module.css` refuses `not-owned` before the real tool runs, and two tasks naming one page refuse `overlapping-ownership` before anything starts. Everything else a child writes through is the real tool — containment, `agentWriteRefusal`, the stale-hash guard, the write lock, the turn log and the turn's checkpoint (so "Revert turn" undoes a child's files too). A child gets the parent's observers but no other write (tokens, the board, images and dependencies are shared state), no `bridge` tool (no panel is waiting on its calls), and never `studio_delegate` or `studio_propose_plan` — it cannot fan out again. It runs on `MODEL_ROUTING_TABLE.subagent` under the routing rules below (`claude-sonnet-5` on a default Anthropic conversation, the conversation's own model otherwise), for at most `CHILD_MAX_TOOL_ROUNDS` (24) rounds with the loop's usual wind-down, and its usage is priced as its own model and added to the conversation's totals (`addConversationUsageTotals`). **Each turn has a delegation budget**, held by the runner (created once per chat turn): at most `MAX_DELEGATE_CALLS_PER_TURN` (2) `studio_delegate` calls, `MAX_CHILDREN_PER_TURN` (8) children and `MAX_CHILD_ROUNDS_PER_TURN` (150) child rounds. Each child's round cap is `min(24, its share of what is left − 1)` and it reserves that cap plus the loop's summary round before it starts, so the total can never pass the ceiling; a share under `MIN_CHILD_ROUNDS` (6), or a call past either count, is refused whole with `delegation-budget-exhausted` before any child runs. Without it a turn — an injected one included — could call `studio_delegate` every round and spend its round cap × 4 × 24 paid rounds on the user's key. The tool is `ai.tools.write` + `studio.write`, a `write` to the loop (so Plan mode refuses it until a plan is approved), on the HTTP surface only (`studioHttpAgentTools`), and not in the external MCP catalog — an external client has no turn to run children on. The HTTP prompt's "Parallel work" section shares its ownership paragraphs with the CLI's; without the tool (a read-only caller) the HTTP prompt says to build one screen at a time. Tests: `server/ai/delegation/delegateRunner.test.ts`.

### The project's generated guide — `server/handlers/studio/projectGuide.ts`

What the roster's prompts carried now lives in files the CLI loads for free from its cwd. `generateStudioProjectGuide(dir)` runs once per real chat turn, right before the subprocess spawns, and writes:

| File | Contents |
|---|---|
| `CLAUDE.md` (project root) | FACTS about this project only: its pages directory, file extension, styling mechanism and component packages; the design system's name, import contract, icon exports and decision map; where the generated references are. No policy — no workflow, no definition of done, no "always use the design system": those arrive with the system prompt, which now reaches the CLI too (P4-B, audit 06 AI-1), and stating them here as well contradicted the session's own design policy. Loaded before the agent's first tool call — zero round trips, cached across turns. |
| `.claude/design-system-components.md` | The installed design system's real component API — every component's own props block plus its one-line intent, extracted from the package's own docs (`designSystemGuide.ts`). |
| `.claude/design-system-icons.md` | Every icon the package ships: the `*Icon` components importable by name, and each `src/icons/<catalog>/` SVG catalog with the exact import to write (`renderIconReference`). For Studio's built-in system the import is `?raw` from the project's `design-system/icons/…`, for every icon: the folder holds only what something imports, and the next load copies in any icon a file imports (`ensureDesignSystemFiles`). |
| `.claude/design-system.md` | The token/BEM-class digest built from the project's own CSS (`designSystemDigest.ts`), for design systems that arrived as plain CSS with no package docs. |

**Why the component reference exists.** The observed failure was never that the agent refused to use the design system — it imported `Button` and `TextInput` happily. It was that it did not know what else existed, so a back button became the literal character `‹`, four feature rows became emoji (`✈ 🗓 🏷 ⚡`), and a media slot became a grey `<div role="img">` — in a project whose installed package ships `GlassButton`, `ListItem`, `Cell`, `VisualCard` and a full line-icon set. Discovering that vocabulary cost a tool call the agent had no reason to make, against a catalog extractor that returns nothing for this package anyway (`studio_list_components` reads `.d.ts` declarations; ALM ships bundled untyped JS). The package's own docs say all of it plainly and are simply too large to read whole (~103 KB / ~106 KB). So Studio reads them server-side, once per regeneration, and keeps the two parts that matter: `design.md`'s **Component Decision Map** (inlined into `CLAUDE.md` — it is what answers "which component") and each `### <Name>` section's props block (written to the reference file).

**The icon reference teaches `?raw`, because the obvious form does not render.** Naming the icons was not enough — the first version of this file printed the natural import for a packaged SVG, `import u from '<pkg>/src/icons/line-icons/x.svg'` → `<img src={u}/>`, for all 376 of the ALM package's SVGs. That resolves to **nothing** in Studio: `resolveImageAssetImport` passes `allowBare: false` on purpose, because the asset endpoint will not serve out of `node_modules`, so the node reaches the canvas as a `base.image` with no `src` and draws the "No image selected" placeholder. The agent followed the guide, watched every icon come out an empty grey box, concluded the icon set was unusable, and went back to hand-drawing SVG path data into a local `icons.tsx` — the exact failure the file's own opening paragraph forbids, caused by the file itself. The generated snippet is now `?raw` + `dangerouslySetInnerHTML`, which `resolveRawTextImport` **does** resolve for bare specifiers; the markup is inlined statically, promoted to `base.svg`, and renders — and unlike an `<img>`, it inherits `currentColor`. Gated by `projectGuide.test.ts`.

Two supporting fixes landed with it. The `*Icon` components the guide advertises are now **registered as canvas modules** (`src/modules/alm/register.tsx`, discovered by shape from the package's runtime exports): they are absent from the package's own `mcp/catalog.js`, so the manifest never held them and every `<ChevronDownIcon/>` in a user's source drew an "Unknown module" box while the guide told the agent to import it. And a packaged image import is no longer refused **silently** — `packagedImageImportRefusal` records a `Resolution` note naming the import and the fix, so an empty image box explains itself instead of looking identical to an `<img>` that simply has no source yet.

**The import specifier is generated, never copied.** The ALM package's own `CLAUDE.md` documents `import { Button } from 'design-system'` — the name it uses in its own monorepo, not the name it publishes under. Embedding that verbatim would have taught the agent an import that resolves to nothing and breaks the user's build. `buildImportContract` builds the block from the package name Studio knows from the project's dependencies plus the package's own `exports` map (the stylesheet line is emitted only when a `.css` export actually exists).

**Orphans from a previous generator version are swept, once.** `agent-04` replaced the subagent roster and recorded that "files the old roster wrote simply stop being targets; they are deliberately not deleted." Not deleting them left them on disk — and **the CLI loads every file under `.claude/` from its cwd**, so they never stopped being read. Measured on a real project: 12 orphans, ~40 KB, describing a subsystem that no longer exists. `figma.md` walked the agent through a six-step Figma node-id workflow (which is what sent it to `get_design_context` for node ids it could not resolve) and closed by handing off to `screen-builder`, one of eleven deleted subagents. `LEGACY_GUIDE_ARTEFACTS` + `pruneLegacyGuideArtefacts` delete them **once per path per project** — recorded in the manifest's `prunedLegacyArtefacts`, so a file the user later writes themselves is theirs and never re-deleted — and the sweep runs **before the fingerprint fast path**, because every existing project is already warm and a sweep behind it would never run for any of them.

Two traps this hit, both gated now: `readManifest` returned one shared `EMPTY_MANIFEST` constant while the prune mutates what it returns, so the first project swept in a process poisoned every later one (now a factory); and `GUIDE_DEFINITION_VERSION` needed a bump for a **content-only** change to the icon reference — no file added or removed, which is exactly the case that looks like it needs no bump and without which every existing project keeps serving the old broken snippet.

**Searches inside a user project are no longer governed by Studio's `.gitignore`.** `studio-workspace/<project>/` is the user's own repository checked out inside this one, so the root `.gitignore`'s `node_modules` applied to it — and since ripgrep backs the agent's Search tool and honours ignore files, an ignored path comes back as *"Path does not exist"*. The agent was told a real 121 KB `dist/index.css` did not exist and could not search the installed design system at all. `studio-workspace/.ignore` re-includes the tree for search (ripgrep reads `.ignore` above `.gitignore`) while git keeps ignoring it. The accepted cost is stated in that file: a repo-wide `rg` now walks user dependencies too, because the agent's search and a repo-wide search are the same filesystem walk.

**Regeneration never clobbers a user edit (trap #12).** `.claude/.studio-generated.json` (owned by `projectGuideManifest.ts`) records the hash, size and mtime of what Studio last wrote for each file. A file is overwritten only while its on-disk content still matches that hash — a hand-edited `CLAUDE.md`, which a user has every reason to make their own, is left alone and reported `skipped`. Files the old roster wrote simply stop being targets; they are deliberately not deleted.

**The warm path is gated, not rebuilt.** Two cheap independent checks, both required: `computeProjectGuideFingerprint` (profile + design-system CSS stat key + package-docs stat witness + `mcpServerFingerprintWitness` + a definition version — a match proves the output is byte-identical to last time) AND `allOwnedFilesUnchangedSince` (a `statSync` per target against the recorded size/mtime — the clobber-protection half, since the fingerprint only covers INPUTS). `GUIDE_DEFINITION_VERSION` must be bumped whenever a generated file is added or removed, or every existing project keeps serving stale output behind the fast path.

### The Studio prompt (`server/ai/tools/studio/systemPrompt.ts`)

Same cacheable 3-element form as the CMS prompt. **It reaches both agent paths.** The HTTP drivers send it as their system prompt; the `claudeCli` driver appends all of it — static prefix, mode block, policy block, then the dynamic suffix — to the CLI's own prompt through `--append-system-prompt-file` (`server/ai/drivers/claudeCliSystemPrompt.ts`). A file and never argv text: the static prefix is ~28–32.5 KB for every (mode, policy) pair, close enough to Windows' 32,767-character command-line limit that argv is not an option. Until P4-B (audit 06, AI-1/AI-3) the CLI received only the dynamic suffix, so the mode and policy controls did nothing on the default path and the subagent contract never reached the only path that holds `Task`. `src/__tests__/architecture/cli-receives-mode-and-policy.test.ts` now reads the file off a real driver spawn for every (mode, policy) pair on both the warm and cold paths, and `studio-agent-subagent-contract.test.ts` asserts the contract on that same CLI-received text.

**How it reads (P4-D, audit 06 §2b, AI-19).** A senior product designer who ships in code, told what the user sees (a picture, not code). Then, before any workflow, **what "done" means — mode first**: the one rule for every mode is *never claim what you did not check*; matching a design means a measured `studio_compare` pass, creating means `studio_quality_check` clean plus one critique pass, and everything must typecheck; the Fidelity block at the end defines the rest. The prompt used to open with "a screen is DONE when studio_compare returns pass:true" as its one non-negotiable rule, which is wrong for a creative brief with nothing to compare against, and the block that redefined done arrived ~9 KB later. Then the **workflow**: orient; **decide before you draw** (the screen's job and one primary action, the band sequence, a 3+ step type scale, one accent, density, radius family — from the design when there is one, otherwise the agent's own decisions, which ARE the design); **write real content** (domain-true copy, plausible numbers, never lorem); build in one write per file; **look, then critique once** against the craft rubric (fix the worst two, look again — one pass, not a polish loop); verify per mode; report. Then the **craft rubric** — hierarchy, rhythm, alignment, type, colour, touch and mobile, states, imagery — and **initiative** (build first; when creating, add the one thing a senior designer would add and say so; when matching, the design is the ceiling).

What it no longer says: one eSIM project's facts stated as universal (its Button `size="default"` resolving to `--type-subtitle-size`, its coral CTA hex, its Figma variable names, its page ids). They were false on every other project and biased every turn; the failure list keeps each lesson in a project-neutral form. "Read the design as a specification, not an inspiration" moved from the invariant prefix into the BALANCED block, where it is true — in the prefix it contradicted CREATIVE's "improving on it is the point". The creative block now also asks for variation on purpose (structure, type personality, colour strategy), names both archetype pools (web and mobile app) and the app chrome rule, and puts studio_arrange_frames where "place them side by side" used to name nothing; its DONE adds the critique pass.

**"Keep the screen a static composition"** — dropped from the generated `CLAUDE.md` by P4-B as policy — lives in the prompt's *Canvas invariants*, beside parse-never-execute, because that is what it follows from: a hook in a screen file never runs on the canvas, so state, fetching and branches belong in imported components or the app around the screen, and a state (empty, loading, error) is its own screen or a prop-driven instance.

`src/__tests__/architecture/agent-prompt-craft.test.ts` holds all of this on the text each path actually sends — the CLI's appended file off a real driver spawn, and the HTTP drivers' Anthropic system blocks and chat/completions system message — for every mode: each craft section present, "done" before the workflow, the mode block present, no project fact present, and every path x mode x policy prefix at most 34,000 characters (under the pre-rewrite ~36.9K, so the guidance is paid for by what it replaced).

Everything project-SPECIFIC lives in the generated `CLAUDE.md` above rather than being duplicated into a prompt on every turn; everything that is POLICY lives here and nowhere else.

The "Tools available" line is exactly `STUDIO_AGENT_TOOL_NAMES` (`agentToolNames.ts`, the same list `index.ts` resolves into real `AiTool` objects), so the prompt cannot advertise a tool the agent is not offered.

The static prefix also states the turn's **step budget** and asks for `step k/N` reports (A9 — see "A turn has a budget and shows its work" below), and ends with the two per-turn blocks that vary with the session controls: `MODE_BLOCK[fidelityMode]` and `DESIGN_POLICY_BLOCK[designPolicy]`. Both tables live in **`promptSessionBlocks.ts`**, split out of this module on that seam — the invariant half of the prompt, and the half that varies with the two controls — when it crossed the 700-line module ceiling. They stay part of the *prefix* so each (mode, policy) pair is its own stable prompt-cache partition. On the CLI path the prefix is fixed when a warm process spawns, so its sha256 is in the warm pool's reuse fingerprint (`claudeCliWarmTurn.ts`): switching mode or policy, or a changed prompt, respawns rather than serving the turn on the guidance the process was born with.

The dynamic suffix carries the project profile, trust tier, the live board/selection/fidelity digest (`liveDigest.ts`), and the `Design references registered:` line — what `studio_compare` can measure against this turn, or an explicit statement that nothing is armed.

**The selection (AI-9, `selectionDigest.ts`).** The browser posts the whole multi-selection (`StudioAgentSnapshot.selection`, the store's `selectedNodeIds` in order, the last being the primary) with each node's drawn box, measured once at send time in every canvas frame the admin page can read (`selectionBoxes.ts`; a cross-origin live frame is skipped and the box reported as unmeasured). The server decodes each id with the one node-id grammar to `file:line:col` — a `.map` row reports its template's location and says a style edit goes to the template, a structural edit to the array — reads a numbered three-line excerpt for the last three nodes through the agent containment rule (a node id naming `../` reads nothing), and renders one line per node. At most eight nodes are detailed; older selections are counted. The selection used to reach the agent as one bare node id — the last member of a multi-selection only, with no file, no line and no box.

### The Studio toolset (`server/ai/tools/studio/index.ts`)

`studioAgentTools` is an explicit **subset** of the MCP registry — `STUDIO_AGENT_TOOL_NAMES` (`agentToolNames.ts`) currently names 43 tools, not the full registry plus the entire CMS `site_*` set. That is the `claude` CLI path's surface; the HTTP drivers get the same list plus `STUDIO_HTTP_AGENT_FILE_TOOL_NAMES` (see "The HTTP drivers' file tools" below). The list has grown since it was first curated (screenshot/compare/measure, computed-styles and page-diagnostics readbacks, typecheck, a fidelity report, design-reference and design-variable ingestion, board/frame geometry, board comments, project/component orientation, and asset/dependency tools — see `agentToolNames.ts`'s own inline comments for why each one is there and what it replaced). Two things were wrong with serving everything: most of what stayed excluded is dead weight (every tool that existed only because the agent had no filesystem is strictly slower than the native equivalent), and a large toolset is itself a latency and accuracy cost — definitions are re-sent every turn, and a model choosing among too many tools explores instead of acting.

What survives is what the filesystem cannot do: see the canvas (`studio_screenshot`), measure the output against the design (`studio_compare`), the design itself (`studio_measure_reference`), and the output's OWN resolved styles and rendered geometry (`studio_computed_styles`, `studio_measure_element`), change board geometry and per-frame axes, read the project's tokens and component catalog, install dependencies behind the trust-tier gate, and pull assets in — including cutting them out of the supplied design (`studio_extract_reference_asset`). The list is written out by name in `agentToolNames.ts` so adding a tool to the registry does not silently widen the agent's surface; `index.ts` throws at module load if a name no longer resolves.

`mcpToolsForStudioWorkspace` (`server/ai/mcp/registry.ts`) applies the same subset at the MCP server: a connector **bound** to a Studio project (`connectorWorkspace.ts` — in practice the per-turn connector `claudeCli.ts` mints) sees only `studioAgentTools`. An unbound connector — a plain external MCP client — still sees the full registry, including the AST edit tools it genuinely needs.

**Deliberately withheld from every tool, no exceptions:** a shell, and trust promotion. An agent may *ask* the user to promote a project's trust tier; it may never perform the promotion itself.

### How a Studio tool refuses

Every `studio_*` tool answers a refusal in one shape, from one builder
(`toolRefusal` in `src/core/ai/toolRefusal.ts`):

```
{ ok: false, code, message, remedy?, retryable, error }
```

Before A14 a refusal was whatever each tool felt like returning — a bare
`aiToolError('No screen matched "Chekout"...')` in one file, an
`{ ok: false, code }` in another, an `{ ok: false, error }` with no code in a
third. The consumer is often a small model, and it paid for all three: nothing
was machine-readable, so it pattern-matched on prose; nothing said whether a
retry was pointless, which is the single largest source of wasted rounds in an
observed turn; and nothing said what to do instead.

**`retryable` means one specific thing:** *this identical call could succeed
once some external condition changes, with no change to your arguments.* A
disconnected board can reconnect; a transient IO error can clear. A page that
does not exist will not start existing because you asked twice, and a project
at Tier 0 will not promote itself. It is derived from the code, never passed in
per call, so two call sites cannot disagree about the same code. The system
prompt's failure list states the consequence as a rule: a `retryable: false`
code is never retried with the same args.

**The code is also rendered into `error`.** Every consumer path reduces a
failed tool result to its `error` STRING and nothing else — `mcp/server.ts`'s
`CallToolResult` builder, and the three `toolResultText` helpers in the
drivers. So `error` ends with `[code=<code> retryable=<true|false>]`; a
structured field the model never sees would be decoration.

`studio_compare`'s per-page `results[]` entries carry the same
`code`/`remedy`/`retryable` triple without the refusal envelope — the call
itself succeeded, one page inside it did not.

<!-- refusal-codes:start -->

| Code | Retryable | Meaning |
|---|---|---|
| `ambiguous-declaration` | no | The design token is declared in more than one place for the same colour scheme (two project stylesheets, or a responsive/second selector in one file), so no single declaration is "the" token. The refusal lists every file:line; edit the one you mean with the file tools. |
| `ambiguous-reference` | no | Two or more equally-ranked design references could stand in for this page. Name one explicitly with referenceId. |
| `asset-write-failed` | no | Bytes were obtained but could not be landed as a project file (validation, containment, or naming). |
| `capture-unavailable` | no | Neither the headless browser nor a live tab could produce the capture. Usually a missing Chromium (`bunx playwright install chromium`) — report it, do not re-capture. |
| `codemod-refused` | no | The AST edit has no single honest target, or would destroy a binding. The refusal names the reason. |
| `crop-out-of-bounds` | no | The requested rectangle falls outside the source image. Deliberately refused rather than clamped — a silently clamped crop is a wrong asset that looks right. |
| `delegation-budget-exhausted` | no | This turn has spent its delegation budget: at most 2 studio_delegate calls, 8 subagents and 150 subagent rounds per turn, so a runaway turn cannot spend without bound on the user's key. Nothing from this call ran. Build the remaining pages yourself. |
| `delegation-unavailable` | no | Delegation runs only inside a chat turn on an API-key driver with a project open; this call has none (an external client, or a subagent, which cannot delegate further). Do the work yourself. |
| `dev-server-failed-to-boot` | no | The project's own dev script did not come up. The refusal carries the captured stdout/stderr tail — read it, fix the cause, then call again. |
| `duplicate-call` | no | This exact write, with these exact arguments, already ran this turn and nothing else has been written since. The loop answered from the first call's result instead of running it again (Z3, `toolLoop.ts`) — the write you asked for has already happened, so read the echoed result rather than repeating it. Observers (screenshots, compares, measurements, typechecks) are never answered this way, and a write repeated after a different write landed runs again. |
| `edit-ambiguous` | no | The oldString of an edit occurs more than once, so which one to change is a guess. Include enough surrounding text to make it unique, or pass replaceAll:true when every occurrence should change. |
| `edit-no-match` | no | The oldString of an edit does not occur in the file. Read the file again and copy the exact text, whitespace and line breaks included. |
| `empty-body` | no | A comment reply needs a non-empty body. |
| `empty-file-list` | no | The operation needs at least one file and none was usable. |
| `eslint-not-installed` | no | The project has no ESLint of its own to lint with. Studio never substitutes its own or downloads one; install the project's dependencies, or rely on the typecheck when the project does not use ESLint. |
| `file-too-large` | no | The file, or the content supplied for it, is over the file tools' size cap. Split the file, or edit the part that needs to change. |
| `git-failed` | no | git itself refused. The message is git's own — a missing git identity and an empty commit both land here. |
| `host-not-allowed` | no | An agent may only make Studio fetch from Figma asset hosts, the stock photo provider, the Figma Dev Mode server when the operator enabled loopback, or a URL the user pasted into this conversation. Any other host is refused before a request is made. |
| `image-decode-failed` | no | Image bytes were found but could not be decoded as a raster image. |
| `input-schema-mismatch` | no | The arguments do not match the tool's input schema. The refusal names each failing field's path, what was expected there and what arrived, plus a minimal valid call built from the schema (required fields only) whenever one can be built. Produced by `executeAiTool` for every tool on both paths (`drivers/http/toolInputRefusal.ts`), never by a handler. |
| `invalid-input` | no | The arguments are self-contradictory or incomplete in a way the schema cannot express (e.g. exactly one of three fields required). |
| `invalid-message` | no | A commit message outside the accepted length range. |
| `invalid-path` | no | A named path is not usable for this operation — not project-relative, or in a never-committable area (build output, node_modules, .git, .studio). |
| `invalid-prop-value` | no | A prop value is not one the component accepts — an enum value outside its declared set, a non-boolean for a boolean prop, or a prop the component does not declare. The refusal lists the accepted values. |
| `io-error` | yes | An unexpected filesystem or subprocess error. The message carries the underlying cause. |
| `lint-invocation-error` | no | ESLint itself could not run or produced no readable report — a broken config or plugin, not a code error, or a report too large to read (lint fewer paths). The refusal carries a capped output excerpt. |
| `lint-timed-out` | no | ESLint was killed before it finished; nothing it found is known. Lint fewer paths at a time. |
| `measure-unavailable` | no | The headless browser could not render the screen to measure it. Same cause and same remedy as capture-unavailable. |
| `missing-param` | no | A parameter this particular verb/mode requires was not supplied. |
| `needs-user` | no | The file runs on the user's machine outside the page — build-tool config, package.json, env and package-manager config, git hooks, .vscode, CI workflows — or is standing agent instruction (CLAUDE.md). No agent writes it on either path: show the user the exact change and ask them to make or approve it. Screen files (.tsx, .ts, .css, assets) stay writable. |
| `no-board-connected` | yes | This tool needs the project open in a Studio browser tab, and none is connected. The server already waited for a reconnecting tab before answering. |
| `no-board-frame` | no | The page exists but has no frame placed on the board yet. |
| `no-design-reference` | no | This page has no design to measure against — either nothing is registered for the project, or every registered reference belongs to a different screen. Register one, or say plainly that there is no design rather than guessing a score. |
| `no-eslint-config` | no | ESLint is installed but the project has no ESLint config inside it, so there are no project rules. Never write a config to make the lint pass. |
| `no-open-project` | no | This tool writes only into the project open for this turn, and none is. The file-authoring tools never take a directory argument. |
| `no-package-json` | no | This project has no package.json, so there is no dependency manifest to act on. |
| `no-such-component` | no | No component of that name is in the design-system catalog of this project (the one studio_list_components reads). The refusal lists the nearest names. |
| `no-such-file` | no | No readable regular file at that project-relative path, or it exceeds the read cap. |
| `no-such-job` | no | No background job with that id — it expired, or the id is wrong. |
| `no-such-page` | no | No screen in this project matched the given name or page id. The refusal lists the names that do exist. |
| `no-such-reference` | no | No design reference is registered under that id for this project. |
| `no-such-thread` | no | No comment thread with that seq exists on the board. |
| `no-such-token` | no | No stylesheet the canvas loads declares that CSS custom property at the document root — in the requested colour scheme, when one was named. The refusal says whether the light value exists when the dark one does not. |
| `no-such-variable-set` | no | No design-variable set is ingested under that id for this project. |
| `no-such-variant-set` | no | No variant set is recorded under that id for this project. |
| `no-tsconfig` | no | The project has no tsconfig.json, so there is no project config to type-check under. |
| `no-writable-location` | no | The node has no single honest source location to write to — a synthetic node, or one produced inside a `.map` iteration. |
| `not-a-file` | no | The path exists but is a directory or another non-regular file. |
| `not-a-repository` | no | This project has no git repository of its own. Ask the user to create one from the Version control panel — you may not create it yourself. |
| `not-owned` | no | A studio_delegate subagent tried to write a file it does not own. A subagent owns exactly its page's component file and that page's .module.css; every shared file stays with the agent that delegated. Name the change you need in your final reply instead. |
| `not-text` | no | The file (or the content supplied) is binary or not valid UTF-8, so a text tool cannot hand it back or rewrite it byte-faithfully. Images and fonts go through the asset tools. |
| `outside-workspace` | no | The directory given is not a Studio project. |
| `overlapping-ownership` | no | Two studio_delegate tasks name the same page, so two subagents would write the same files. Give each page to exactly one task. |
| `path-outside-project` | no | The path resolves outside the project directory. Containment is absolute. |
| `plan-not-approved` | no | The turn is in plan mode and no plan has been approved yet, so no write runs, and no tool that runs the project's own code (studio_lint, studio_render_reference). Call studio_propose_plan with the steps and wait for the user's approval. |
| `protected-path` | no | The path is inside the project but is not the user's source: a directory Studio owns or that is not source (.studio, .claude, .git, node_modules, build output), a credential file (.env, .npmrc, key material), or a file with other hard-linked names. No agent file tool reads or writes it. |
| `read-only-source` | no | The declaration that wins comes from a package, from the built-in Studio design system, or from compiled Sass/PostCSS/Tailwind output — not a project file that can be edited in place. Override it in a stylesheet of the project, or edit the source the output was compiled from. |
| `reference-unreadable` | no | A registered design reference is on the books but its file could not be read from disk. |
| `remote-fetch-failed` | no | A remote URL could not be fetched, was refused by the SSRF guard, or exceeded the size cap. |
| `render-failed` | no | The dev server is up but the route could not be rendered or screenshotted. |
| `stale-anchor` | no | A comment thread's anchored element has moved or gone, so resolving it would attach the reply to the wrong thing. |
| `stale-source` | no | The file on disk is not the version the write was built against: its hash no longer matches the expectedHash given, or an existing file was about to be overwritten with no expectedHash at all. Read it again (studio_read_file returns the hash) and rebuild the change against what is there now. |
| `stock-key-refused` | no | The stock photo provider refused the API key this Studio server is configured with. Only the operator can fix it; carry on down the Assets ladder. |
| `stock-search-failed` | yes | The stock photo provider could not answer: unreachable, rate-limited, or an error on its side. The same search can work a little later. |
| `strict-mode-stand-in-refused` | no | Strict fidelity mode will not measure against a stand-in reference. Register the real design as a spec first. |
| `trust-tier-required` | no | This project's trust tier is below what the operation needs. Ask the user to promote it — you may never promote it yourself, so the same call will keep refusing until they do. |
| `tsc-invocation-error` | no | tsc itself could not run — a broken toolchain or tsconfig, not a code error. The refusal carries a capped output excerpt. |
| `typecheck-timed-out` | no | tsc was killed before it finished. Any diagnostics it had already printed are returned and `pass` is forced false — an incomplete run never reports a pass. |
| `typescript-not-installed` | no | The project has no TypeScript of its own to type-check with. Studio never substitutes its own — the refusal carries the install command to ask for. |
| `unknown-verb` | no | The requested operation name is not one this tool implements. |
| `write-conflict` | no | The write would collide with something already on disk, and overwriting it is not this tool's decision to make. |

<!-- refusal-codes:end -->

Gates: `src/core/ai/toolRefusal.test.ts` (the shape and the rendering) and
`src/__tests__/architecture/studio-tool-refusals-are-coded.test.ts` (no
code-less `aiToolError` under `server/ai/mcp/tools/studio/`, every produced
code in the vocabulary, every code in this table and vice versa, and the
Retryable column matching the source).

### Tool descriptions (AI-29)

A tool's description is re-sent to the model on every round of every turn, on both paths. The audit measured ~81 K characters of them, `studio_apply_edits` alone at 7 K, most of it design history and the bug each rule once fixed. So a description now says three things — when to use the tool, what it returns, and its refusal codes — in **at most 900 characters**, gated by `src/__tests__/architecture/tool-description-length.test.ts` over every tool any caller can be offered (the full external registry, both agent surfaces, the CMS set, the HTTP-only tools). The WHY lives in each tool's module doc and in this file. Field-level detail belongs on the field's own `description`. For the two external-only tools whose rules genuinely do not fit (`studio_apply_edits`' kinds and refusals, `studio_export_frames`' renderers), the long form is the MCP resource `studio://tool-notes` (`server/ai/mcp/toolNotes.ts`), which their descriptions point to; `resources.test.ts` checks every pointing tool has a section there.

### Studio tool index

Every tool the in-canvas agent is offered, in `STUDIO_AGENT_TOOL_NAMES` order. "Gate" is the tool's own `requiredCapabilities`; every non-**read** row is also `requiresWrite`, so it needs `ai.tools.write` as well, and a **read** row is reachable by any `ai.chat` caller. "Loop" is the tool's `sideEffects` — what the HTTP tool loop reads to decide concurrency and duplicate suppression (see "Tool dispatch within a round" below). The two are separate fields on purpose: `studio_screenshot` is write-GATED (its live fallback borrows the user's tab) but a `cache` observer to the loop. The table is gated against the tool metadata by `src/__tests__/architecture/agent-doc-tool-surface-parity.test.ts`. Prose for each group follows below.

"Where it runs" is the tool's own `execution` field, which has exactly three values (`server/ai/runtime/toolExecution.ts`):

| `execution` | Dispatch | Needs the open board? |
|---|---|---|
| `server` | in-process | never |
| `server-with-bridge-fallback` | in-process, headless first; relays to an open board only when the headless path cannot run, or when the caller explicitly wants the live tab's own state | never — it gets slower without one, not unavailable |
| `bridge` | relayed whole by the runner when the tool declares no handler; dispatched in-process when it does, in which case the handler owns the relay and the "no board" message | **yes** — no board means a refusal |

**The prompt's live-tab claim is generated from this field.** The static prefix used to name `studio_computed_styles` and `studio_page_diagnostics` by hand as the tools that require the open board. That was true when it was written and became false in `mcp-20`, when `studio_computed_styles` went headless — and nothing caught it, because a prompt string has no compiler. The failure mode is the expensive kind: the agent does not get an error, it simply stops calling a tool that works, and reports "the project is not open" on a question that would have been answered off disk. Both halves of that paragraph are now built by `buildBoardRequirementParagraph` from the caller's own capability-filtered tool array, and `src/__tests__/architecture/prompt-claims-match-tool-metadata.test.ts` asserts the generated sentence names **exactly** the `bridge`-only set.

<!-- agent-tool-index:start -->

| Tool | Where it runs | Gate | Loop | One line |
|---|---|---|---|---|
| `studio_screenshot` | `server-with-bridge-fallback` | `studio.write` | `cache` | Sync frames from disk, wait for the reload, capture. The agent's eyes |
| `studio_compare` | `server-with-bridge-fallback` | `studio.write` | `cache` | Capture + score against the page's registered design reference in one call. The agent's ruler |
| `studio_measure_reference` | `server` | read | `none` | Read the design's own colours, type sizes and line-heights out of the reference, in CSS px |
| `studio_computed_styles` | `server-with-bridge-fallback` | read | `none` | What the CSS actually resolved to on the canvas — real px, real weight, real colour, real font |
| `studio_measure_element` | `server` | `studio.write` | `cache` | The canvas's own ruler: each element's rendered box, padding, and gaps to its siblings |
| `studio_page_diagnostics` | `bridge` (needs the open board) | read | `none` | What the screen's runtime said: exceptions, `console.error`, failed assets/modules/fetches |
| `studio_render_reference` | `server` | `studio.run.project` **and** the project at `run-project` trust | `cache` | Boot the project's OWN dev server and screenshot a route through it. Tier 2 only |
| `studio_quality_check` | `server` (headless) | read | `none` | Reference-free source audit: raw hex/px where a token exists, AA contrast, hand-rolled icons, design-system coverage, spacing/type-scale composition, band rhythm and focal point. Severities come from the turn’s design policy |
| `studio_plan_variants` | `server` | `studio.write` | `write` | N style seeds for one brief — the project's own tokens, and a layout-archetype SEQUENCE so A/B/C differ in structure — plus a self-contained subagent directive per variant |
| `studio_list_variant_sets` | `server` | read | `none` | Read back a recorded seed set, so "make B but tighter" is an edit to B's density rather than a re-roll |
| `studio_typecheck` | `server` (subprocess) | `studio.write` + trust ≥ Tier 1 | `none` | Run the project's own `tsc --noEmit` and return structured diagnostics |
| `studio_lint` | `server` (subprocess) | `studio.run.project` **and** the project at `run-project` trust | `none` | Run the project's own ESLint with its own config and return structured diagnostics. Tier 2 only |
| `studio_fidelity_report` | `server` | read | `none` | The machine-readable "what will not import faithfully", as stable codes with a fix |
| `studio_import_figma_frame` | `server` | `studio.write` | `write` | The whole "a Figma link arrived" ritual in ONE call: register the export as a strict spec reference, ingest the variables, size the board frame to the frame's own `absoluteBoundingBox` |
| `studio_register_design_reference` | `server` | `studio.write` | `write` | Store a design's ORIGINAL bytes under `.studio/references/`, scoped to a page |
| `studio_list_design_references` | `server` | read | `none` | What is armed for this project/page, metadata only |
| `studio_read_design_reference` | `server` | read | `none` | One reference's metadata, optionally its image bytes |
| `studio_ingest_design_variables` | `server` | `studio.write` | `write` | Store the design tool's OWN variable table, as handed over by the agent |
| `studio_list_design_variables` | `server` | read | `none` | Ingested variable sets, as summaries |
| `studio_read_design_variable_set` | `server` | read | `none` | One set's actual name/value entries, with Studio's normalisation shown |
| `studio_set_frames` | `server` | `studio.write` | `write` | Bulk-resize board frames in `.studio/boards.json` |
| `studio_arrange_frames` | `server` | `studio.write` | `write` | Place frames — explicit x/y, a row, a column or a grid — with an optional note above each (a variant's idea). Never resizes, creates or removes a frame; a page's second frame moves with its first |
| `studio_set_frame_axes` | `server` | `studio.write` | `write` | Flip one frame's preview direction / colour scheme / locale |
| `studio_duplicate_frame_as_variant` | `server` | `studio.write` | `write` | The same page twice on the board, under different axes |
| `studio_list_comments` | `server` | read | `none` | The user's board pins as a work queue, each with an anchor-confidence verdict |
| `studio_reply_comment` | `server` | `studio.write` | `write` | Post an AI-tagged reply into a thread |
| `studio_resolve_comment` | `server` | `studio.write` | `write` | Resolve/reopen a thread; refuses on a drifted or detached anchor |
| `studio_project_profile` | `server` | read | `none` | "What am I working with" in one call — framework, styling, packages, dark mode, warnings |
| `studio_list_pages` | `server` | read | `none` | Every page/board frame: id, title, slug, node count |
| `studio_list_tokens` | `server` | read | `none` | Every CSS custom property the canvas loads, grouped by family, with its resolved and dark value and the `file:line` that declares it |
| `studio_set_tokens` | `server` | `studio.write` | `write` | Change token values (light or dark) as a CST edit on each token's ONE declaration, all-or-nothing, through the agent write gate. Refuses a token declared twice, or one a package / Studio's design system / compiled output wins |
| `studio_list_components` | `server` | read | `none` | The design system's real component API — the same catalog the insert palette shows |
| `studio_find_component` | `server` | read | `none` | The narrow lookup into that catalog, by component name and/or a prop it declares |
| `studio_component_snippet` | `server` | read | `none` | The exact import line for the file it goes into (relative for Studio's design system) and a JSX usage whose prop values are checked against the component's API |
| `studio_list_assets` | `server` | read | `none` | The project's own images: site URL (and whether a build serves it), pixel size, bytes, and the stock credit when Studio landed it. Paginated |
| `studio_list_fonts` | `server` | read | `none` | Which typefaces the project can actually render and how each is loaded, its font tokens and font files; with `query`, a Google family to add and its `@import` line |
| `studio_find_icon` | `server` | read | `none` | Fuzzy search (words, camelCase, synonyms, typos) over the design system's icon catalogs; the exact `?raw` import per match, or the markup and where to save it |
| `studio_find_image` | `server` | `studio.write` | `write` | Licensed stock (Pexels) search that lands the best matches through the agent write gate and credits each photographer in `IMAGE-CREDITS.md`. Without `PEXELS_API_KEY` it says so and lands nothing |
| `studio_upload_asset` | `server` | `studio.write` | `write` | Land bytes the model holds (base64 PNG/JPEG/WebP, must match `mimeType`) as a new image file, through the agent write gate like every other agent landing |
| `studio_fetch_remote_asset` | `server` | `studio.write` | `write` | Fetch an image URL server-side and land it as a project image; bytes never transit the model. Only Figma asset hosts, the stock host, or a URL the user pasted (`host-not-allowed` otherwise) |
| `studio_extract_reference_asset` | `server` | `studio.write` | `write` | Crop artwork out of the registered reference when it exists nowhere else |
| `studio_install_deps` | `server` (background job) | `studio.write` + trust ≥ Tier 1 | `write` | Start a `bun install --ignore-scripts` job; returns a `jobId` |
| `studio_install_status` | `server` | read | `none` | Poll that job: `running`/`done`/`failed`/`timeout`, plus log and exit code |

<!-- agent-tool-index:end -->

### The HTTP drivers' file tools (P4-C)

An Anthropic API key, OpenAI, OpenRouter, Ollama or a custom endpoint runs the shared HTTP tool loop, which has **no native tools** — so until P4-C (audit 06, AI-2) an API-key user had an assistant that could look, measure and resize frames and could not write a line, while its prompt told it to "Write" and "Edit". These tools are that surface. `selectStudioTools` adds them when `agentFileAccessForProvider(providerId)` is `studio-tools` — every provider but `claudeCli`, which keeps its native `Read`/`Write`/`Edit`/`Glob`/`Grep` and never sees them. The prompt is generated from the same array (`agentFileAccessFor`), so each path is told the file tools it actually has: the HTTP prompt names these, fans out with `studio_delegate` (see "Subagents" above — or, for a caller without it, says there are no subagents), tells the model to read `CLAUDE.md` itself, and tells a caller without write permission that it cannot write.

Every path goes through ONE containment rule, `server/handlers/studio/agentFileAccess.ts`: inside the project on the textual and the real (symlink-resolved) path, never into `.studio/`, `.git/`, `node_modules/` or build output for a read, plus `.claude/` for a write (the same `agentWriteScope` deny list as the CLI path's hook), compared case-folded; never a file that runs on the host (`needs-user`, below); never a credential file (`.env*`, `.envrc`, `.npmrc`, `.dev.vars`, `*.tfvars`, `secrets.*`, key material) for a read; never an NTFS data stream (`file:stream`), a Windows device name (`CON`, `NUL`, `COM1`), a path over 1024 characters or a name over 255, or — for a write — a name ending in a dot or a space; never through a hard link. The path and segment caps are checked before any other work, and the tool schemas carry the same `maxLength`, so no path can cost more than linear time (security review of #233, F1); `replaceAll` refuses an edit whose projected size is over the cap before building it (F2). The three write tools take **no directory** — they write only into the turn's open project — hold the project write lock across check and write (so the P1-D watcher recognises the write as Studio's own), refuse `stale-source` when `expectedHash` (the `hash` a read returned) no longer matches or when an existing file would be overwritten without one, append to the turn write log, and push one live reload naming every file written. `studio_edit_files` is all-or-nothing: every edit is checked before any byte is written, and a write that fails part-way restores what it already wrote. Text only, at most 200 000 bytes, no NUL. They are **not** in the external MCP catalog: no external connector is ever bound to a project, so they could only refuse there. The first four are, for an unbound client that names its `dir`.

**Files that run on the host need the user — on both paths (`needs-user`).** CLAUDE.md's own rule is that Tier 2 is a product default, not a consent boundary, and that "anything that needs a human to have agreed must ask at the point of use". Every project defaults to Tier 2 and the dev server starts when a board opens, so a single agent write to `vite.config.js` — which Vite re-evaluates in Node the moment it changes — or a `predev` script in `package.json` would run code on the user's machine with nobody asked, and a prompt injection planted in anything the agent reads could trigger it (security review of #233, F3). So an agent never writes, on either path:

- build-tool config: `vite.config.*`, `postcss.config.*`, `tailwind.config.*` and any other `*.config.{js,cjs,mjs,ts,cts,mts}`, plus the `.babelrc`/`.postcssrc`/`.eslintrc` family;
- `package.json` at any depth (dependencies go through `studio_install_deps`, `--ignore-scripts` and name-validated), `.env*`, `.npmrc`, `.yarnrc*`, `bunfig.toml`, `.gitmodules`, `.mcp.json`;
- `.husky/`, `.vscode/`, `.devcontainer/`, `.github/workflows/`, `.circleci/`, `.gitlab-ci.yml`, and the commit-hook runners `.lintstagedrc*`, `lefthook.yml` and `.pre-commit-config.yaml`; `babel.config.json`;
- **any local module a host config loads**, to depth 6 (`hostConfigImports.ts`: a bounded textual scan of relative `import`/`require`/`import()` specifiers, quotes or a plain backtick, never executed, cached per project and revalidated by mtime). The configs are the ones at the project root AND at the app root (`resolveAppRoot` — the nested app's config is the one `devServer.ts` runs), the file a dev script names with `--config`, and, where a config is a symlink, the file it points at, whose imports resolve from its own folder. A PostCSS config's plugin-map keys (`'./postcss/local.js': {}`) count, and in a project that depends on Tailwind so does every stylesheet's `@plugin`/`@config` target. `vite.config.ts` importing `./vite/plugins` makes `vite/plugins.ts` — and what that imports — `needs-user`: Vite re-runs a config's dependencies in Node when one changes (security re-review of #233, R1);
- **a stylesheet change that ADDS a Tailwind `@plugin`/`@config` directive** (`agentContentRefusal`, the content half of the same gate: the HTTP tools pass the file's current and new text, the CLI hook the `Write`/`Edit` input). Keeping the directives a file already has and editing the rest stays the agent's;
- `CLAUDE.md` and `CLAUDE.local.md` at any depth — not executed, but standing instruction for every later turn.

The predicate is ONE function, `hostExecutedWorkspaceFile` (`@core/page-parser`), consulted by ONE gate, `agentWriteRefusal` (`server/handlers/studio/agentWriteScope.ts`), which both the `claude` CLI's `PreToolUse` hook (`hooks/denyControlPlaneWrite.ts`, native `Write`/`Edit`) and the HTTP drivers' file tools call. The refusal tells the agent to show the user the exact change and ask them to make or approve it; the system prompt says the same on both paths. `.tsx`, `.ts`, `.css` and assets stay writable — they run in the preview browser, and writing them is the job. `.git/` and `.claude/` remain `protected-path`: Studio's control plane is not something the user approves an agent into. So is Studio's generated preview shell, everything under `prototype/` (`studioShellWorkspaceFile`): the scaffolded `vite.config.js` imports `prototype/studioRuntime.generated.js`, and Studio rewrites the shell on every open. A test holds every path the shell templates emit to this rule, so a new shell file cannot slip past it. Not covered, and deliberately said: a config inside a nested workspace Studio does not run has its own name refused but its imports are not scanned; a tsconfig `paths` alias a config imports through; a specifier computed at runtime; a chain deeper than six. Studio's OWN writers (the prototype shell's `vite.config.js`, dependency installs) never consult it. This removes the zero-click path from one write to host execution; it is **not** a sandbox — any module a config imports still runs in Node.

<!-- agent-http-file-tools:start -->

| Tool | Where it runs | Gate | Loop | One line |
|---|---|---|---|---|
| `studio_read_file` | `server` | read | `none` | One text file, with its `hash` (the version a write checks) and, for `.tsx`/`.jsx`, the canonical-JSX verdict |
| `studio_list_files` | `server` | read | `none` | The project's real file tree as relative POSIX paths; generated/dependency folders never listed |
| `studio_grep` | `server` | read | `none` | Every line matching a LITERAL string, as `{ path, line, text }`, capped and budgeted |
| `studio_get_node_source` | `server` | read | `none` | Decode a node id to `{ file, line, col, snippet, hash }`. Refuses for synthetic and `.map`-iteration ids |
| `studio_write_file` | `server` | `studio.write` | `write` | Create a file or replace one whole; replacing needs `expectedHash` |
| `studio_edit_file` | `server` | `studio.write` | `write` | Exact-string replacement, once (or `replaceAll`); refuses a missing or ambiguous `oldString` with the line numbers |
| `studio_edit_files` | `server` | `studio.write` | `write` | Up to 50 such edits across files, all-or-nothing, one live reload |

<!-- agent-http-file-tools:end -->

**Registry-only Studio tools** — in `mcpToolsForCapabilities` for an *unbound* external MCP client (Claude Code in a terminal, a remote agent), never offered to the in-canvas agent. (The four read tools above are in the registry too.) The exclusions are justified one by one in `agentToolNames.ts`; the short version is that everything filesystem-shaped is strictly slower than the native `Read`/`Write`/`Edit`/`Glob`/`Grep` the driver already grants, and the two measurement tools take base64 bytes the in-canvas agent cannot produce from an MCP image block.

| Tool | Gate | One line |
|---|---|---|
| `studio_list_projects` | read | Every project under `studio-workspace/`, with page count and probed profile |
| `studio_find_nodes` | read | Query nodes by moduleId/tag/class/text/lock state — "show me everything that failed to resolve" |
| `studio_create_page` | `studio.write` | Scaffold a canonical `.tsx` + board frame and return the parsed-back `rootNodeId` |
| `studio_apply_edits` | `studio.write` | The typed-edit batch engine (also the canvas panels' own writeback path — `studioWriteback.ts`) |
| `studio_codemod` | `studio.write` | The higher-level structural verbs: rename-tag, set-import-specifier, detach, extract-component, swap |
| `studio_export_frames` | `studio.write` | Capture step 3 alone, for a client managing its own board |
| `studio_diff_frames` | read | Pixel + region diff where the caller already holds the baseline as base64 |
| `studio_recommend_export_dpr` | read | The `dpr` that lands a capture on a reference's pixel width, with honest clamp warnings |
| `studio_delete_design_reference` | `studio.write` | Remove a reference + its bytes; idempotent |
| `studio_delete_design_variable_set` | `studio.write` | Remove an ingested variable set; idempotent |
| `studio_list_component_bindings` | read | The raw Figma Code Connect `*.figma.tsx` mapping data, including every per-value label pair |
| `studio_read_package_doc` | read | A dependency's own markdown docs **by section** — `outline: true`, then `section: "<heading>"` |
| `studio_git_status` | read | Branch, upstream divergence, and every changed path with its staged/unstaged/untracked state. `isRepo:false` is a normal answer. A read on purpose: reporting what you changed must not need permission to commit it |
| `studio_git_branch` | `studio.git.write` | `list` / `create` (allowed with a dirty tree — a pointer move loses nothing) / `switch` (refuses over a dirty tree, naming the files; Studio never stashes) |
| `studio_git_commit` | `studio.git.write` | Commit an explicit file list. Stages exactly those paths, never `add -A` |
| `studio_git_push` | `studio.git.write` | `--set-upstream origin <branch>`. Never a force push — no parameter and no route could make it one. Authentication is the user's own connected GitHub account or host credential helper |
| `studio_git_open_pr` | `studio.git.write` | Open a GitHub pull request for the current branch, with base/title/body defaulted from the repository. No token → a named refusal carrying the compare URL |
| `studio_import_project` | `studio.write` | The GitHub-import engine, exposed headlessly |

**The git family, and the line it does not cross.** The five `studio_git_*`
tools are the whole publish sentence — *status → branch → commit → push → open a
PR* — and all four mutating ones sit behind the single `studio.git.write`
capability, which is **not** granted to the built-in Admin role. That grant is
the human decision; requiring it again per call bought no safety and produced
an agent that could build a branch and then not ship it. A pull request is
where the sentence ends, because a proposal a human reviews is the right shape
of consent for delegated work. There is deliberately **no** `init`, `restore`,
`pull`, `merge`, `rebase` or conflict-resolution tool: each of those can
overwrite work the user has on screen and cannot see being overwritten, which
is exactly why the Version control panel shows them a list instead.

All five share one guard, `guardProject` in `gitTools.ts`, and it owns both
halves of "can this directory be operated on": it catches
`ProjectDirOutsideWorkspaceError` (which `resolveToolProjectDir` throws for a
`dir` outside `studio-workspace/`) and then runs `assertOwnGitRepo`, so every
tool in the family answers a structured `outside-workspace` /
`not-a-repository` refusal rather than a raw exception — which only
`studio_git_commit` used to do. `outside-workspace` is reachable two ways, and
both are tested: the caught throw, and the workspace **root** itself, which
`resolveProjectDir` accepts (it is what you get with no `dir` in an empty
workspace) and which is not a project. `ProjectDirMismatchError` — a
workspace-bound connector naming a project other than its turn's —
deliberately still throws, as it does in every other Studio tool: its message
names both projects and the next action, and flattening it into
`outside-workspace` told the agent a project that exists does not.

**Non-Studio MCP tools.** `get_context` (`mcp/tools/contextTool.ts`) is the orientation call for the CMS half: it reports whether the Site editor is connected — every browser tool needs it — and which templates wrap pages, so an agent knows what its authored markup is *in addition to*. Headless; call it first when a browser tool answers "open the workspace". `mcp_list_project_servers` and `mcp_propose_server` (`mcpServerTool.ts`) cover external MCP servers: the first lists every project-declared (`.mcp.json`) and Studio-registered server with its approval state and its *secret field names* — never a secret value; the second registers a proposal that is saved **unapproved and cannot be approved by any tool or agent**, so the honest report to the user is "proposed, needs your review", never "set up". `site_read_styles` and `site_list_breakpoints` (`styleTools.ts`) are headless replacements for their snapshot-backed `site_*` siblings, which read a browser-posted snapshot that is `null` over MCP; `site_publish` (`publishTool.ts`) is the one explicitly capability-gated write that leaves draft state. The CMS `site_*` toolset itself is tabulated under [Tools](#tools) below.

### `studio_screenshot` — the agent's eyes

`server/ai/mcp/tools/studio/screenshot.ts`. Nothing watches the workspace directory, so a freshly written page is real, parseable, and completely invisible until two things happen in order. This tool is those two things in one call, deliberately — an agent that has to remember a ritual before every look will skip it, and a partial ritual produces a stale image that reads as evidence:

1. **Reconcile the board with disk** — `syncBoardFramesFromDisk` (`pageScaffold.ts`) places a frame for every page file that lacks one. Additive and idempotent: an existing frame keeps its position and size, and a frame whose file was deleted is left alone (removing frames is a destructive board edit that belongs to the user).
2. **Capture** — hand the resolved page ids to `capture/captureFrames.ts` and return its PNGs as MCP image blocks.

**Waiting for the canvas to re-read used to be step 2** (`awaitStudioLiveReload`, `liveReloadPush.ts`), paid on every call. W9-5 moved it into `captureFrames` and made it conditional: it is awaited only when the capture actually falls back to the live editor tab (`reloadBeforeLiveFallback`), because the headless renderer re-parses from disk on every navigation and a round trip to a tab could not tell it anything it did not already have. `studio_measure_element` dropped it outright — `inspectFrameHeadless` has no live path at all.

**Step 2 stopped needing an open browser tab in W4-2A**, and that matters most exactly here: step 1 has just made *disk* the source of truth, and this tool exists to look at files the agent itself wrote — so the honest renderer is the one that reads those files, not the one that happens to be mounted in someone's tab. `captureFrames` renders the pages in a server-side headless browser and falls back to relaying to the open editor tab only when that cannot run. It also means a capture no longer scrolls, zooms, or re-pages a canvas the user is working in. The result reports `capturedVia: 'headless' | 'live'`, plus `headlessFallbackReason` when the live tab answered only because headless could not run — that reason is the actionable one. When neither path can run, the error names **both** halves (`capture-unavailable`) rather than blaming a missing board; a missing Chromium (`bunx playwright install chromium`) is the common cause.

**Several widths without touching the board (AI-16).** `widths: [375, 768, 1280]` renders each screen at each width through the same headless path, one capture per width, and every returned frame carries `requestedWidth`. The width travels in the capture grant (`CaptureGrant.frameWidth`) into the payload — it is never written to `.studio/boards.json`, so a responsive check leaves the board exactly as it was (the test asserts the file byte-identical). Each frame keeps its own height; scroll-unroll grows it to the content. A width override is headless-only: the live tab can photograph a frame only at its board width, so when headless cannot run the call refuses and says no other width was substituted, rather than returning the board width in place of the one asked for. Screens x widths is capped at 20.

Pages are selected **by name**, not by page id: `"Checkout"`, `"Checkout.tsx"`, `"pages/Checkout.tsx"` and the raw id all resolve to the same frame (`pageKey` in `pageNameMatch.ts` applies the same kebab derivation `pageIdFromRelPath` uses to both sides, so multi-word names like `AddMobile` → `add-mobile` match). Omitting `pages` captures the whole project. `studio_export_frames` still exists and still does step 3 alone, for external clients that manage their own board.

### `studio_compare` — the agent's ruler

`server/ai/mcp/tools/studio/compare.ts`. Sight alone turned out not to be enough: a screen whose subtitle overlapped its heading and whose icons rendered as specks was screenshotted, looked at, and reported as done. "Does this match the design" stayed an opinion, and an agent grading its own homework gives itself a pass.

**The measurement path was unreachable, not merely skipped.** `studio_register_design_reference` + `studio_recommend_export_dpr` + `studio_export_frames` + `studio_diff_frames` existed on paper, but `studio_diff_frames` takes its `baseline` as a base64 **string** while a capture arrives as an MCP **image block**. A model can look at an image block; it cannot transcribe one back into base64 text. No sequence of calls got the agent from "I captured the screen" to "I measured the screen", so no amount of prompt wording about measuring could have worked.

`studio_compare` collapses the five steps into one call keyed by screen name, and captures **server-side** — neither the baseline nor the reference ever transits the model. It resolves the reference automatically from the ones registered for that page, picks the capture dpr that lands on the reference's own pixel width (so the comparison is exact rather than resampled), captures through the same `capture/captureFrames.ts` routing `studio_screenshot` uses (headless first, the open tab as fallback — and with `purpose: 'measurement'`, which lifts the ~1568px vision-safe edge clamp, since these pixels are measured by `pixelmatch` rather than looked at), and scores in-process. It returns `{ pass, verdict, similarityScore, regions[] }` plus three image blocks: your screen, the reference, and the diff.

**Dimension reconciliation has three outcomes, and the verdict names which one it got** (`reconcileReference`, `frameDiffEngine.ts`). `exact` is a same-size comparison. `resampled` stretched the reference to fit within a 5% aspect tolerance, so the score is interpolated rather than exact-pixel. `cropped-to-reference` is the third, added in W9-3: a board frame captures its **full** scroll-unrolled content height, so a scrolling screen measured against a fixed-height artboard produces a capture that is the same width and several times taller — an aspect delta far past the refusal tolerance, and nothing about it a content mismatch. That case now compares the **top `capture.comparedHeight` band** instead of refusing, and the verdict says outright that the pixels below it are UNMEASURED, so a partial pass can never read as a whole-screen pass. Two guards keep it narrow: the widths must match **exactly** (so the band is exact-pixel, not interpolated — `studio_recommend_export_dpr` already produces this), and the direction is one-sided (a capture *shorter* than the reference is a missing section and is still refused).

**A failing page's worst regions carry `colorExplanation`** (`regionExplain.ts`). "Region 0 is 71% different" does not say *what* is wrong there, and the two commonest causes — a wrong colour token and a moved element — look identical as a rectangle. So each of the worst few regions reports the dominant colour on both sides, named in the project's own vocabulary: *"the design fills this rectangle with `#EF4550`, which is the design variable `coral/100`; your screen renders `#3B82F6`, which is `var(--color-primary)`. The project token that carries the design's colour is `var(--color-danger)`."* The design-variable half comes from the existing `designVariableIndex` (ingested via `studio_ingest_design_variables`); the project-token half from the same `buildProjectTokenIndex` `studio_measure_reference` uses. It is **omitted when both sides' fills agree** — that silence is itself the signal that the region moved or its text differs rather than its colour being wrong, and a colour sentence there would send the agent to recolour something already correct. Only a failing page pays for it (building the token index compiles the project's styles).

**`pass` is deliberately not pixel-identity.** A browser rasterises text with different hinting and antialiasing than a design tool, so two *correct* renderings of the same screen still differ by an irreducible margin of edge pixels; a tool demanding 100% would report every screen as broken forever and teach the agent to ignore it. `pass` is two conditions, and the second is the one that matters:

- overall similarity ≥ `passScore`, **and**
- no single differing **region** covering more than `maxRegionCoverage` of the frame,
- **and, in `strict` only, no region above an absolute area floor** — see "Fidelity modes" below.

Those numbers come from the turn's resolved **fidelity mode**, not from one hardcoded pair: `creative` 80 / 12%, `balanced` 92 / 6%, `strict` 99 / 0.5% plus the area floor (`FIDELITY_THRESHOLDS` in `server/handlers/studio/fidelityMode.ts`). An explicit `passScore`/`maxRegionCoverage` argument still overrides the mode's own — a caller who names a number means that number — but naming a number does not change the mode, so strict's area floor still applies. Every result reports the bar it was graded against under `thresholds`, including `fidelityMode`, so the agent never has to infer it.

A structural defect — wrong spacing, a missing element, the wrong button fill, text overlapping a heading — always forms one contiguous region above that floor. Antialiasing does not: it spreads thinly across every glyph edge and never coalesces. That separation is what distinguishes "this is a different design" from "this is the same design on a different rasteriser", and a single global percentage cannot do it. `frameDiffEngine.test.ts` gates it directly.

The system prompt states a passing compare as the **definition of done** for any screen with a registered reference, not as a suggestion (per mode — see the fidelity blocks below).

**Withheld from the agent as a consequence:** `studio_diff_frames` and `studio_recommend_export_dpr`. Offering a tool the agent can only ever fail to call buys wasted turns and teaches it that measurement does not work. Both remain in the MCP registry for external clients, which hold their own bytes and can genuinely use them.

**Shared, not duplicated:** the pixel + region core lives in `frameDiffEngine.ts` and backs both `studio_compare` and `studio_diff_frames`. Reference selection and the reference-px→CSS-px scale live in `referenceResolve.ts`, shared with `studio_measure_reference` so the two tools can never disagree about which design they are talking about. Selection is role-first (`spec` beats `context`), page-scope second, and **refuses** an ambiguous page instead of tie-breaking — see [`mcp-connectors.md`](mcp-connectors.md) → "Which reference a tool call means".

### Fidelity modes — `creative` / `balanced` / `strict` (W9-2)

One control that says how much invention is wanted and how hard the measurement bites. It shapes three things at once, which is the point of it being one control: the system prompt's DONE definition, `studio_compare`'s thresholds, and the Stop gate.

**Resolution precedence** — one function, `resolveFidelityMode` (`server/handlers/studio/fidelityMode.ts`), called by every consumer with whatever tiers it happens to hold. Highest first:

1. **Tool argument** — `studio_compare({ fidelityMode })`. An explicit per-call instruction is never overridden, the same rule `turnRouting` applies to effort.
2. **The resolved design reference's own `mode`** — `DesignReference.mode`, set at registration. A design registered as "this one has to be exact" says so about itself, and outranks a session-wide preference chosen without it in view. This is why the mode is resolved **per page**: two screens in one `studio_compare` batch can legitimately be graded differently.
3. **Per-turn** — `AiChatRequestBody.fidelityMode`, from the composer's picker. Ignored by every non-`claudeCli` driver, exactly like `effort`/`permissionMode`.
4. **Per-project, per-account** — `.studio/meta.json`'s `agentSession.byUser[<userKey>].fidelityMode` (with the bare `agentSession.fidelityMode` read as the project-wide fallback), round-tripped through the same `GET/POST /admin/api/ai/studio-session` route effort uses. Disk JSON; no database anywhere on this path.
5. **Derived** — a design reference is registered for the project → `balanced`; none → `creative`.

**`strict` is never derived.** The derived tier only ever answers `balanced` or `creative`. Strict makes the Stop gate refuse everything short of a measured 99% pass; arriving there without a user asking turns a working session into a loop nobody opted into. Escalation is always somebody's explicit gesture — a tool argument, a reference registered as strict, the picker, or a saved project default. It mirrors `permissionMode`'s rule from the other direction: there the server may never *widen* on its own, here it may never *tighten* on its own.

**Prompt.** Each mode's block is folded into the **static prefix** (`prefix = base + MODE_BLOCK[mode]`, `server/ai/tools/studio/systemPrompt.ts`), so each mode is its own stable prompt-cache partition — every `balanced` turn hits the same cached prefix, and switching costs exactly one cold prefix. In the (uncached) dynamic suffix it would have cost its tokens on every turn forever. Each block ends in a DONE definition reachable *in that mode*, because the prefix's single worked example of "measured" is a passing `studio_compare`, which is correct under strict and actively wrong under creative where there may be no reference at all:

| Mode | DONE means |
|---|---|
| `creative` | every variant typechecks (`studio_typecheck`) **and** passes `studio_quality_check`. A creative-mode compare is directional and must never be reported as "it matches the design" |
| `balanced` | `studio_compare` has RUN on every screen touched since the last write, its verdict is reported **verbatim**, and every differing region is either fixed or named in the reply as a deliberate deviation with a reason |
| `strict` | `studio_compare` passes at strict thresholds, `studio_typecheck` passes, the text is the design's text with no placeholder, and `studio_fidelity_report` returns no unresolved finding — that whole list and nothing added to it |

The numbers in the blocks are interpolated from `FIDELITY_THRESHOLDS`, so the prompt cannot state a threshold the tool does not apply.

**Creative's variants are generated, not asked for.** The `creative` block asks for more than one idea, and asking is not enough for a measurable reason: a model given one brief three times returns the same composition three times, because nothing in the second prompt differs from the first. The variance has to come from **outside** the model. `studio_plan_variants` (`server/handlers/studio/variantSeeds.ts`) generates it — one **style seed** per variant over six axes (type contrast, spacing density, corner family, accent, A13’s layout-archetype sequence, and AI-12’s colour strategy — tonal, high-contrast or accent-led), assigned **without replacement** so distinctness is structural rather than hoped for, and every value taken from a token **this project already declares**. Variety bought by breaking the design system is not variety, it is three screens that fail `studio_quality_check`'s own `raw-hex-color`/`off-scale-*` rules; the type-contrast pool is bounded below by the same `MIN_TYPE_HIERARCHY_RATIO` that `flat-type-hierarchy` grades against — imported, not restated — so a seed can never propose a screen its own audit would then fail, and the density multipliers are whole multiples of the project's spacing base for the same reason.

Each variant comes back with a page name (`Home` → `HomeA`/`HomeB`/`HomeC`) and a **self-contained `directive`** — the exact subagent prompt, since a subagent sees only the text it is sent. The tool **plans**; it does not create the pages or place them on the board, because page creation and `.studio/boards.json` are the orchestrator's alone under the parallel-work rules above. The set is recorded in **`.studio/variants.json`** (`variantStore.ts`, a sibling of `boards.json`, validated on read and capped at 20 sets) with its `rngSeed`, so a later "make B but tighter" is an **edit to B's recorded density** — `studio_list_variant_sets` — and not a re-roll that loses everything the user liked.

**Strict's extra teeth.**

- **An absolute per-region area floor**, ~400 px² at 1x, scaled by the comparison's own px-per-CSS-px (area scales with the *square* of a linear scale, so a 2x Figma export gets 1600). `maxRegionCoverage` is a percentage *of the frame*, and a percentage of a tall screen is a large rectangle: on a 375×2400 page 0.5% is 4500 px², so a 24×24 icon rendered completely wrong passed the structural test without ever being looked at. Coverage catches "a big thing is wrong"; this catches "a small thing is entirely wrong". A frame with no authored width leaves the floor off rather than guessing 1x, which would fail every region on a retina diff.
- **It refuses the project-wide reference fallback.** A reference with no page scope, picked up implicitly, is Studio's *guess* that this design is probably about this screen — a good guess for `balanced`, and the wrong thing to build a 99% verdict on. The refusal names the reference, says to register the screen's own design or pass `referenceId`, and says explicitly that lowering `fidelityMode` is not the fix. (The ambiguous-page case `resolveDesignReference` already refuses, for every mode.)
- **A pass recorded at a looser mode does not close a strict turn.** `pageVerificationStore.ts` records the mode each passing compare was graded at alongside the timestamp. Under strict, `computePageWriteVerification` reports a page whose only post-write pass was graded at `balanced` as `staleFidelityMode`, and `describeUnverifiedPage` gives it its own branch: re-measure with `fidelityMode:"strict"`, do **not** rewrite the screen, it may already pass. A record written before this field is treated as "not known to be strict" — one extra compare, never a page waved through.

The Stop hook (`hooks/stopGateCheck.ts`) is a standalone `bun` subprocess with a `cwd` and nothing else, so it resolves tiers 3–5 off disk through `resolveProjectFidelityMode` — the same function `chat.ts` uses — and `liveDigest.ts` resolves it identically, so the digest and the gate always flag the same set of pages.

**UI.** A third `ContextMenu` trigger in `AgentSessionControls.tsx`, beside permission mode. `Project default` is a first-class option (the store value is `null`), which is how a user undoes a session override without guessing what the project is set to. It **persists**, unlike permission mode, and the asymmetry is deliberate: permission mode is not written to disk because a reset must never land a user in a *looser* state than they chose, and fidelity mode has no looser-than-chosen state to land in — clearing it hands the decision back to the project default and then to the derived value, both of which somebody already made.

**The mode-aware Stop gate, finished (A9).** Each mode now defines "verified since the write" the way its own DONE definition does, so the gate never asks for a measurement the mode does not define. `computePageWriteVerification(dir, userKey, pages, { fidelityMode, replyText })`:

| Mode | The gate's bar | Evidence it reads |
|---|---|---|
| `creative` | a **clean `studio_quality_check`** since the last write — there may be no reference at all, so a compare is not the bar | `pageVerificationStore.qualityChecks[pageId]`, written by the tool for every page whose run returned **no ERROR-severity finding** under the turn's design policy |
| `balanced` | a compare has **RUN** since the last write, and every region that still differs is **fixed or NAMED** in the reply | `pageVerificationStore.compareVerdicts[pageId]` (written for every `ok` verdict, pass **or** fail, with its region labels) plus the turn's trailing assistant reply |
| `strict` | unchanged — a passing compare graded **at strict** | `pageVerificationStore.pages[pageId]` + its recorded `fidelityMode` |

Two mechanisms make balanced's half machine-checkable, which it previously was not:

- **A stable, quotable region label.** `compareRegionLabel(index, top)` produces `R1@y412` — short enough that an agent will paste it into a sentence, unique enough that two regions on one screen never collide. `studio_compare` returns it on every region (`results[].regions[].label`) and the gate looks for exactly that string. One function, beside the store the gate reads, so the tool and the gate can never print and search different formats.
- **The reply is read from the CLI's own transcript.** The `Stop` hook payload carries `transcript_path`; `hooks/stopHookTranscript.ts` reads only the tail, only the trailing assistant text (never back past the last user turn — a region named three turns ago was named about a screen that has since been rewritten), and returns `undefined` on any failure. No reply means nothing counts as named, which is the safe direction *and* the truth at that moment.

A passing compare still short-circuits balanced through either record, because the two are written by different calls and a page that passed is verified whether or not a verdict row happens to sit beside it.

### Design policy — `follow` / `balanced` / `free` (A12)

A **second axis**, beside fidelity mode, and the reason it is not more values on the first is that the two combine in both directions. Fidelity grades against a **reference**; design policy grades against the **project's own tokens and components**. `strict` + `free` is "the comp is the spec, the design system is not". `creative` + `follow` is "invent something new, entirely out of our own vocabulary" — the position the owner asked for by name, and one a single combined control could never express.

| Policy | Design-system findings | The prompt block says |
|---|---|---|
| `follow` | **errors** | tokens and this project's own components only; where the system has no token, say which gap you hit rather than quietly writing the raw value |
| `balanced` (default) | **warnings** | prefer tokens and components; a one-off is allowed and its price is one sentence in the reply naming which and why |
| `free` | **not produced at all** | the design system is optional — spend that on a distinct visual language, not on arbitrariness |

The governed set is exactly `raw-hex-color`, `raw-px-length`, `off-scale-spacing`, `off-scale-type-size`, `design-system-unused`, `design-system-coverage-low` (`DESIGN_SYSTEM_FINDING_CODES`). Everything else — contrast, a font the project cannot load, an unresolved asset import, a hand-drawn `<path>`, and **every** composition rule — is an error at every policy and no policy turns it off. `free` means "this screen need not use our design system", never "this screen may be broken or undesigned".

A finding the policy turns off is **not produced**, not produced-and-labelled: a `free` turn handed eleven `raw-hex-color` findings marked "ignore me" reads as a failing audit to any model skimming a list, and the next thing it does is stop trusting the tool. `findingSeverity(code, policy)` is the single source for the split, shared by `studio_quality_check` and the Stop gate.

**Resolution precedence** — `resolveDesignPolicy` (`server/handlers/studio/designPolicy.ts`), mirroring `resolveFidelityMode` minus the two tiers with no analogue (a design reference declares a fidelity about itself; it declares nothing about a component library): tool argument → per-turn `AiChatRequestBody.designPolicy` → `.studio/meta.json`'s `agentSession.byUser[<userKey>].designPolicy` → `balanced`. The disk half is `projectDesignPolicy.ts`, its own module for the same module-init cycle reason `projectFidelityMode.ts` is.

**Never derived away from `balanced`.** `follow` would fail an ordinary from-scratch screen on a project whose design system may not even cover it; `free` would be the server silently dropping the design-system rules, which is a loosening it may never do on its own — the same one-directional rule `strict` states, pointing the other way.

**Prompt.** `DESIGN_POLICY_BLOCK` is appended to the static prefix after `MODE_BLOCK`, so each (mode, policy) pair is its own stable cache partition. Both tables live in `server/ai/tools/studio/promptSessionBlocks.ts` — split out of `systemPrompt.ts` on the real seam (the invariant half of the prompt, and the half that varies with the two session controls) when the module crossed the 700-line ceiling.

**Variant seeds honour it.** Under `follow`/`balanced` every seeded value is a token the project declares — a seed that invented `1.618` and `#7B61FF` would hand three subagents instructions their own `studio_quality_check` then fails. Under `free`, `generateVariantSeeds` draws from an extended pool: a wider type-contrast range (up to 4x, past what most project scales express), the whole radius vocabulary rather than only the families the project has tokens for, and a varied spacing **base** rather than only the density multiplier — two variants at one base and different densities are one system at two zoom levels, not two visual languages. A `free` seed names no token whose px is not the size it chose.

**UI.** A fourth `ContextMenu` trigger in `AgentSessionControls.tsx`. `Project default` is again a first-class option (store value `null`), persisted through the same `GET/POST /admin/api/ai/studio-session` route and the same `agentSession` shape as fidelity mode, and safe to persist for the same reason: clearing it lands on `balanced`, which asks for **more** design-system discipline than `free`, never less.

### Arming the ruler — `turnDesignReferences.ts`

`studio_compare` is stated as the definition of done, and that sentence was load-bearing and unreachable: **nothing armed the ruler.** A design reached the agent one of two ways and only one counted — the composer's dedicated design-reference control (`DesignReferenceAttachment.tsx` → `POST /admin/api/studio/reference-upload`, durable), or an ordinary chat image attachment (transient, nothing on disk). The second is what people actually do. On a real five-screen project built from a pasted comp, `.studio/references/` did not exist at all: `studio_compare` would have answered "there is no design reference registered", the agent measured nothing, and reported the screens done by eye.

`server/handlers/studio/turnDesignReferences.ts` feeds the transient path into the durable one. Every image attached to a turn with a Studio project open is registered before the system prompt is built, so `StudioLiveDigest.designReferences` reports it on the very turn it arrives. **Idempotent by content hash** — this runs on every turn and conversations re-send attachments, so registering unconditionally would write one copy of the same comp per turn. **Never fatal** — arming is a convenience, not a precondition, so an SVG (refused: no fixed pixel size to diff against) or an undecodable upload is logged and dropped while the turn proceeds.

**As `context`, never as the spec.** Feeding the durable path is not the same as nominating a design, and conflating them shipped the flagship reference-drift bug: resolution picked the most recently registered reference, so the moment a user pasted a screenshot to ask a question, that crop became what every later `studio_compare` measured. In this repo's own `test4` fixture the `sms` page's 375×800 Figma frame is shadowed by a 943×294 chat crop, so compare refuses on aspect ratio and the Stop gate can never pass again — the real design still on disk, still correct, permanently unreachable. A chat attachment therefore registers with `role: 'context'`. It stays listed, addressable and croppable, and still resolves when it is the page's only candidate (paste-a-comp-and-build is unchanged); what it can no longer do is outrank a deliberately registered design or win a page silently. Promotion is an explicit gesture — a `referenceId` tool argument, or registering as `role: 'spec'`. The full precedence and its refusals live in [`mcp-connectors.md`](mcp-connectors.md) → "Which reference a tool call means".

The prompt's dynamic suffix now always carries a `Design references registered:` line — naming what is armed **and each entry's role**, or stating that nothing is, which is itself the honest signal that "does it match" has no answer. The roles are on the line because they decide which entry a comparison would actually use; listing four references without them leaves the model unable to tell, which is exactly the blindness that let the crop win.

**The write-verification gate knows the difference between "no design" and "too many".** `server/handlers/studio/pageWriteVerification.ts` resolves each written page's reference through the same `resolveDesignReference`, and a refusal now arrives labelled: `ResolveReferenceFailure` is `unknown-id` / `ambiguous` / `other-pages-only` / `none`. Only `ambiguous` is kept on the entry (as `referenceAmbiguity`), because it is the only one whose instruction differs from the unarmed page's — and it differs by being its exact opposite. An ambiguous page resolves to no reference, so before this it fell into the "has NO design reference registered — register one" branch shared by the Stop-hook gate (`hooks/stopGateCheck.ts`) and the digest line: the gate blocked the turn and then told the agent to add a **third** candidate to a set it already could not choose between, which makes the next call refuse identically. `describeUnverifiedPage` now has three branches, and the ambiguous one repeats the refusal's own candidate list and ends with the call that clears the block — `studio_compare({pages:["…"], referenceId:"…"})`. Same sentence in the gate and in the digest, as before, so the model never sees the gate say one thing and the prompt another.

### `studio_measure_reference` — reading the design's own numbers

`server/ai/mcp/tools/studio/measureReference.ts`, over `server/handlers/studio/referenceMeasure.ts`.

`studio_compare` scores the **output**: it says which rectangle is wrong and never what right would have been. So every value the agent wrote was still a guess made by looking at a picture — a colour by eye (then written as a raw hex, which the prompt forbids), and a type size **by role**. A screen title became `--type-headline-size` because "headline" reads like a heading. On a real project that token is 26px and the design drew ~21px, so every screen came out too large, in the same direction, for the same reason. Picking by name is not merely imprecise, it is **biased**: the grand-sounding token wins.

The tool takes rectangles in the reference image's own pixels and returns, per region: background and foreground as hex **with the matching project token** when one is within perceptual range, the WCAG contrast between them, the dominant palette, the measured text lines, a font-size range, and the measured line-height. Two things make it honest:

- **Everything is CSS px, never reference px.** A comp exported at 2x holds a 21 CSS px heading as 42 pixels of ink; returning 42 would replace an eyeballed error with a measured one twice the size. Lengths are scaled by the board frame's authored width over the reference's pixel width — the same relationship `studio_compare` uses to pick its capture dpr — so they compare directly against the px in a stylesheet. A page with no board frame is refused rather than guessed at.
- **A font size is a range, not a number.** A raster cannot say whether the ink measured was cap height (~0.72em, no descender) or a full ascender-to-descender span (~0.95em); those differ by a third. Both bounds are reported with the assumption each rests on. Line-height, measured from the pitch between two lines, needs no assumption and is a plain number.

Colours are grouped into buckets so antialiasing cannot push a flat fill out of the ranking, but each group **reports the modal exact colour inside it**, never the bucket's rounded centre — `#0c9ab0` must not come back as `#1098b0`, an error introduced by the instrument meant to remove it. Token matching is perceptual (CIE76 ΔE over CIELAB, `colorMath.ts`), because RGB distance calls two near-blacks adjacent and two different mid-greens close. When nothing is within range the response says so — that is the one case the prompt allows a raw value, and the agent can now tell the two apart.

Tokens come from `projectTokenIndex.ts`, which scans the **same CSS the canvas gets**, collected once by `projectTokenSources.ts`'s `collectProjectTokenSources`: Studio's built-in design-system sheet for a DS-backed project, the package stylesheets and the compiled CSS Modules / Sass / PostCSS / Tailwind output from `compileProjectStyles`, and the global stylesheets the app's entry module imports (`src/index.css` — where a Vite app keeps its tokens, and which the four hand-assembled copies this replaced all missed). A token that is not in the CSS the canvas loads is not a token the agent can use, so indexing anything else would produce confident advice that renders as nothing. `.studio/framework.json` is deliberately not a source: it holds Studio's own generated scale, and offering both would answer "which token is this" with two names from two systems.

### `studio_computed_styles` and `studio_measure_element` — reading your OWN numbers

`server/ai/mcp/tools/studio/{computedStyles,measureElement}.ts`, over
`server/ai/mcp/capture/headlessFrameInspect.ts` and the shared reader
`@core/studio-capture`'s `inspectFrameDocument`.

`studio_measure_reference` reads the DESIGN's numbers; these two read the
build's. Both close the same shape of failure — a difference the agent could
see in a picture but not name, so it "fixed" a value that was already correct:

- **`studio_computed_styles`** reports, per node, the resolved font-size and
  line-height in px, the weight, the colour and background as rgb, and the
  family the text is genuinely SET IN. That last one is the load-bearing
  field: `getComputedStyle().fontFamily` echoes the declared STACK, so a stack
  whose first family never loaded is indistinguishable from one that did, and
  the fallback face makes correct px read as the wrong size. Walking the stack
  against `document.fonts.check` reports the family actually in use. Per NODE
  rather than per component, so it needs no catalogue of what `size="default"`
  means and covers buttons, inputs, labels and containers identically.
- **`studio_measure_element`** reports each element's rendered box, its own
  padding/margin/border, and the measured gap to the elements beside it —
  **next to the parent's declared `row-gap`/`column-gap`**. That pair is the
  diagnosis rather than merely a number: agreeing means the gap value is what
  is wrong; disagreeing means a margin is in play, and no edit to the gap will
  ever close it. Every capture already computed `nodeRects` and threw the
  surrounding arithmetic away, which is why spacing was the last dimension
  still being estimated off a screenshot.

**W9-6 — neither needs a browser tab.** `studio_computed_styles` shipped as
`execution: 'bridge'`, so a project with no editor open spent ~8s in the bridge
and then refused — on a question whose whole subject matter is what is on disk.
Both now render the screen on the same headless capture substrate
`studio_screenshot` uses. `studio_computed_styles` keeps the live tab as its
fallback (authoritative for an unsaved in-progress edit, and what an install
with no Chromium degrades to; `readVia` says which answered);
`studio_measure_element` has none, because it measures a screen the agent itself
just wrote.

**One reader, two documents.** The live-tab fallback runs the exact same
`inspectFrameDocument` against its board-frame iframe. Two readers would mean
the number depends on which path answered, and a fidelity loop whose
measurement moves is not a measurement.

### `studio_set_frame_axes` / `studio_duplicate_frame_as_variant` — board state is file state

`server/ai/mcp/tools/studio/frameAxesTools.ts`.

Both were browser tools wrapping `EditorStore.setFrameAxes` /
`duplicateFrameAsVariant`, because that is where the toolbar's own preview-axes
and duplicate-as-variant controls call them from. The reasoning did not survive
one question: where does the result LIVE? Not in the store — a frame's axes
override and a variant frame are `.studio/boards.json`, which the store holds a
copy of and POSTs back when `boardsDirty` next flushes. The browser path was a
round trip through a mutable copy in order to write a file the server already
owns, and it refused outright whenever no tab was open.

W9-6 makes both `execution: 'server'`. They write through `boardGeometry.ts`'s
`readBoardsFile`/`writeBoardsFile` — the one owner of `.studio/boards.json`, whose
writes go through `studioStore.ts` (atomic, and never through a link) — then push
a live-reload with `boardsChanged: true`, so an open board re-reads the file and
the user watching sees the frame flip exactly as before. The variant's placement
(`x = source.x + width + VARIANT_GAP`, same `y`) now comes from a single
`VARIANT_GAP` in `@core/studio-board`, shared with `boardSlice.ts`, so the
toolbar and the tool cannot drift apart.

`studio_upload_asset` did not move then; it moved later (security review of #248, F6). It
posted real `FormData` to the canvas's own upload route, which serves the USER and so never
asks the agent write gate: an agent could land files in Studio's preview shell `prototype/`.
It is now a server tool on `landAgentAsset` — the agent write gate, the project lock and the
turn log, like `studio_fetch_remote_asset` — and the capability check (`studio.write`) is
the same one every server write tool passes.

### `studio_extract_reference_asset` — artwork that exists only in the comp

`server/ai/mcp/tools/studio/extractReferenceAsset.ts`. The prompt is right that a missing asset is a gap to name rather than a drawing prompt — and that rule left the agent nowhere to go. `studio_fetch_remote_asset` needs a URL; `studio_upload_asset` needs bytes the model holds; a Figma MCP export needs a connected, authenticated server. When the design arrives the way designs usually arrive — a PNG pasted into chat — every one of those is closed, and the hero image, product photo, badge and mockup exist **only** as pixels inside the reference. The honest move was a grey placeholder box, and that is what the screens got.

The tool crops a rectangle out of the registered reference and writes it into the project as a real PNG, returning `{ relPath }` — the same shape `studio_upload_asset` and `studio_fetch_remote_asset` return. Bytes never transit the model (same posture as `studio_fetch_remote_asset`). The crop is re-encoded to PNG rather than copied, because a rectangle of a JPEG is not itself a JPEG, and PNG is lossless and keeps alpha. A crop running past the edge is **refused, not clamped** — unlike a measurement, where a few pixels out is still useful, a silently-trimmed crop is a wrong image on disk under a name that says it is the right one.

It is explicitly second choice to a real source (the design system's own icon set, a Figma export, a URL), because those give the original vector at any size while this gives the comp's raster. It beats both things it replaces: a placeholder box, and a photograph impersonated with CSS gradients.

### Reading the built screen — computed styles, runtime, source audit, `tsc`, fidelity

Five tools that answer "is what I built actually right", each covering a channel the others are blind to. A screenshot is only one of them, and it is the one that lies most easily.

**`studio_computed_styles`** (`computedStyles.ts`, `execution: 'server-with-bridge-fallback'`) is a pure read. Per node it reports what the CSS *resolved to* on the live canvas: font-size and line-height in real px, font-weight, colour and background as rgb, and — the field a picture can never give — the font family the text is genuinely **set in**, as opposed to the declared stack. A stack whose first family never loaded looks identical to one that did, and that difference makes correct px look like the wrong size; every "fix" that follows edits a value that was already correct. It defaults to nodes with their own text (`textOnly`); pass `textOnly: false` for container padding, radius and background. This is the half of a fidelity loop that lets a difference be closed by arithmetic — diff these numbers against the design's own (a Figma connector's variable-definitions tool, or `studio_read_design_variable_set`) and fix whatever disagrees. It does **not** need a Studio browser tab: since `mcp-20` it renders the screen on the same headless capture substrate `studio_screenshot` uses, keeping the open tab only as a fallback (`readVia` says which answered). The system prompt claimed the opposite for months — see "The prompt's live-tab claim is generated" below.

**`studio_page_diagnostics`** (`pageDiagnostics.ts`) reads what the screen's runtime *said*: uncaught exceptions, unhandled rejections, `console.error` output (how React reports a failed render, an invalid hook call and a hydration mismatch), assets that failed to load, module specifiers that did not resolve, and failed `fetch`es from inside the frame. It exists because a frame whose component throws photographs as a blank rectangle, honestly and with no error, and *every other tool agrees with the photograph* — compare reports ~100% different, quality-check reads a stylesheet that never ran, computed-styles reports an empty body. The loop that follows is screenshot, adjust CSS, screenshot, against a page that never executed; the one fact that ends it in a single step was in the frame's own console the whole time. Batch by name, one call per turn's worth of screens. Every finding carries a stable `code` from `@core/ai`'s `PAGE_DIAGNOSTIC_CODES` with that code's suggested `fix`, an occurrence count, and — when the failure is on a real element — the `file:line` its node id decodes to. It is a pure read and deliberately does **not** sync board frames from disk the way `studio_screenshot` does: placing a frame would be a mutation, and a page with no frame is a genuinely different answer, reported as `status: "no-frame"` rather than as clean. Like `studio_computed_styles` it needs a connected board, and says so in a message that tells the user the tab reconnects on its own.

**`studio_render_reference`** (`referenceRender.ts`) is the Tier 2 outlier: it boots the **project's own** dev server (its `dev`/`start` script, via the detected package manager) and screenshots a `route` through a real headless browser at a given viewport — ground truth to compare a `studio_export_frames` capture against. It is the one Studio tool that executes the user's code, so it is gated **twice** — and both gates are load-bearing. The caller needs the `studio.run.project` capability, *and* the target project's own `.studio/meta.json` trust tier must be exactly `run-project`; the handler checks the second through `checkTrustTier` in `server/handlers/studio/trustGate.ts`, the same helper the `/admin/api/studio/dev-server` route uses for the identical spawn. Below Tier 2 it refuses with `{ ok: false, code: 'trust-tier-required', trust, requiredTrust }` and spawns nothing — the agent may ask the user to promote the project and may never promote it itself, so retrying the same call unchanged returns the same refusal.

Until A10 the capability was the *only* gate here, and it was withheld from the built-in Admin role — so the one tool that validates against the app actually running was unreachable for every real operator (audit `01-figma-fidelity.md`), while the MCP path was simultaneously *weaker* than the HTTP route, which had always demanded the tier (`sec-05` finding 1). Both are now fixed by the same change: Admin holds `studio.run.project`, and the per-project promotion is what actually authorises execution. `route` must be a path the project's own router actually serves, which is not the same set as Studio's page slugs — a screen reachable only by tapping through the app has no route here. The dev server is reused across calls and torn down after `idleTimeoutMs`; a boot failure returns `ok: false` with the captured stdout/stderr tail rather than a synthetic result.

**`studio_quality_check`** (`qualityCheck.ts`) is the reference-*free* counterpart to compare/measure. Both of those need a registered design; on a from-scratch brief neither has anything to measure against, and the agent's only signal was its own judgement of a picture. This scans the screen's own stylesheets and its own `.tsx`, headlessly. The stylesheet rules are `raw-hex-color` / `raw-px-length` (a literal where the project already declares a `var(--token)` close enough to be the one that was meant — so the response names the exact `var()` to swap in) and `low-contrast-pair` (one rule declaring both `color` and a `background` under the 4.5:1 AA floor; it cannot see font-size or weight, so a genuinely large rule may still pass WCAG's looser 3:1 threshold, and the finding says so). The page-source rules catch the agent hand-rolling what the design system already ships: `unresolved-asset-import` (a `?raw` import naming a file that is not on disk — the element renders empty while still typechecking and still holding its box, which is the one finding neither a screenshot nor `tsc` will ever report), `hand-authored-vector-path`, `hardcoded-inline-sizing` (which does not flag the legitimate `style={{ '--x': value }}` custom-property case), and `design-system-unused`. A seventh rule, `font-not-available` (`fontAvailability.ts` — its own module, because unlike every other rule it needs the *workspace*: a font-file disk walk and the project's setup files), names the first family in a `font-family` stack that the project cannot load. That is the most expensive silent failure in the loop: the browser falls back, everything still renders and still typechecks, and the fallback's x-height and advance widths are different — so the screen reads as "the type is the wrong size" and every size tuned against a screenshot from there on is tuned against the wrong typeface. Availability is deliberately generous (an `@font-face` in the page's own sheets, the compiled project CSS or the vendor CSS; a `fonts.googleapis.com` link; a `next/font/google` import; a matching font file on disk), it resolves `font-family: var(--font-display)` through the project's own custom properties before judging it, it judges only the **first** family (the rest of a stack is the fallback chain, which is the point of having one), and it **stands down entirely** for a project using `next/font/local`, whose generated family names cannot be judged from static text. The scoring engine reuses the exact `buildProjectTokenIndex` / `contrastRatio` machinery `studio_measure_reference` already uses — no second colour-matching implementation. A fourth rule, flagging hand-built markup for a role the generated `CLAUDE.md` maps to a real component, was prototyped as name-overlap and **rejected**: against the fixture that motivated it, it fired ~20 times for one genuine hit, and a noisy rule trains the agent to ignore the tool entirely. A clean audit says nothing about whether the screen *looks* right — only that its source follows the project's own rules.

**Compliance is not composition (W9-3).** Every rule above is a compliance rule, and a screen can satisfy all of them while still being three stacked grey boxes with one type size — which is exactly what "template-y output" is. Two further families grade that, both reusing the same `buildProjectTokenIndex` and the same already-read files, so they cost nothing new:

- **`design-system-coverage-low`** — the sibling of `design-system-unused` for the failure that one cannot see: a shipped screen once used **2 of 42** available components and hand-rolled the rest, and passed `design-system-unused` cleanly. It fires only when four things hold — a catalog was resolved and offers ≥ 8 components; the screen has ≥ 15 JSX tags; `design-system-unused` did *not* fire (so the zero-import case is reported once, by the stronger finding); and fewer than `min(4, catalog size)` distinct catalog components are actually **rendered** (imported *and* used as a tag — an unused import is not coverage). The finding **names what the decision table offered and the screen did not take**, because "use more components" is unactionable and "you have `ListItem`, `Cell`, `VisualCard`, `GlassButton`" is a next step. The catalog is the *same* `resolveDesignSystemGuide` that renders the project's own `CLAUDE.md` decision table, so the finding can never name a component the agent was never offered.
- **`off-scale-spacing` / `off-scale-type-size` / `flat-type-hierarchy`** (`auditCompositionQuality`, `server/handlers/studio/compositionAudit.ts`) — **page-level aggregates**, at most one finding per rule per screen, each carrying a count, a ratio, and the offending `file:line` list. Aggregate rather than per-declaration because per-declaration would double-report every value `raw-px-length` already flags; page-level rather than per-file because a screen's type scale lives across every stylesheet it imports, so a "largest ÷ body" ratio computed inside one `.module.css` measures a fragment and calls it a hierarchy. Both scale rules run **only** against tokens the project actually declares — no spacing tokens means no spacing rule, not an invented 4px default. `flat-type-hierarchy` needs no tokens: it is the ratio between the screen's own largest and most-common type size, and under **1.6** the screen reads flat.

The rejected name-overlap rule was **not** resurrected for either — none of these use a name-similarity heuristic.

**Composition archetypes and two more findings (A13).** `flat-type-hierarchy` grades whether the screen has a **scale**; two new page-level aggregates grade whether it was **composed**:

- **`no-focal-point`** — the screen has a scale and yet nothing leads the eye. Three causes, named individually in the message: fewer than **three** distinct type sizes in use (body and one heading is a document, not a screen); the largest size set on more than **two** rules (a size used that often is a body style, not a focal point); or a largest-to-second-largest step under **1.2** (the top two levels read as the same weight twice). It never fires when `flat-type-hierarchy` did — a screen with no scale at all is one problem reported once, and a tool that reports it twice starts reading as noise. The 1.2 is deliberately *not* `MIN_TYPE_HIERARCHY_RATIO`: that ratio grades display-vs-body across the whole scale, and demanding it between two **adjacent** levels would fail every well-built modular scale.
- **`monotone-band-rhythm`** — the screen's spacing is one value repeated, or its largest gap is less than one step above its inner rhythm. Equidistant spacing groups nothing: every element is as related to its neighbour as to the section above it, so the screen reads as one undifferentiated column no matter what is in it. Unlike the two `off-scale-*` rules this needs **no tokens** — whether a screen separates its bands is true or false regardless of whose scale the values came from — and "one step" is the project's own base where it declares one, otherwise the smallest gap the screen actually uses, never an invented 4px.

Both are errors at **every** design policy: they are composition, not design-system adherence.

`LAYOUT_ARCHETYPES` and `COMPOSITION_RULES` (also in `compositionAudit.ts`) are the shared vocabulary above them — two pools tagged by `surface` (AI-12): six web shapes (hero, feature grid, split, testimonial band, pricing, footer) and eight mobile-app shapes (detail header, list rows, grouped list, form step, card feed, stats and chart, order summary, empty state), each with a stand-alone brief, plus `APP_CHROME_RULE` (top bar; a tab bar OR one pinned action, never both; safe areas), which frames every app screen and is not a band. `studio_plan_variants` picks the pool from the project's recorded platform, else the median frame width (under 768px is an app), else web, and records `surface` on each seed; an app directive carries the chrome rule. Before AI-12 a 393px checkout screen was planned out of hero/pricing/footer bands, and the five rules that make a screen read as designed (≥ 3 type-scale steps in use, one accent, one radius family, ≥ 1 spacing step between bands, contrast ≥ AA). Two consumers must agree on them: the creative prompt block names the shapes and quotes the rules, and `generateVariantSeeds` gives each variant a different **archetype sequence**, walking a shuffled order from a per-variant offset of one so every variant opens on a different shape and repeats no band inside itself. Three variants × three bands over six archetypes is nine slots, so *some* overlap between variants is arithmetic, not a bug — what the axis buys is that A/B/C differ in **structure and order**, not only in tokens. Four of the five rules name the finding that grades them; the archetypes themselves are **never detected from CSS** and deliberately never will be, because "is this a testimonial band" is a semantic question about content and a textual scan that guessed at it would be exactly the word-overlap heuristic already prototyped and rejected.

**`studio_typecheck`** (`typecheck.ts`, over `handlers/studio/typecheck.ts`) closes the largest verification gap the toolset had: the agent writes `.tsx` with no shell, so before this there was no way to confirm what it wrote compiles, and both `studio_screenshot` and `studio_compare` pass happily on a screen that never typechecks. It runs the **project's own** installed `tsc --noEmit`, never Studio's. `tsc` cannot check a subset of a project without losing its config, so `paths` never changes what runs — it filters which diagnostics come *back*, and the response always names which mode ran (`scope: 'project' | 'filtered'`) and how many diagnostics exist outside the filter, so nothing is hidden. Failures are structured rather than thrown: `trust-tier-required`, `available: false` with `typescript-not-installed`/`no-tsconfig` plus a fix, or `timedOut: true` carrying whatever partial diagnostics `tsc` had already printed (with `pass` forced to `false` — an incomplete run must never report a pass just because no error had surfaced yet). Running a binary the workspace's `node_modules` supplied is the same risk class as installing dependencies, so it takes the same gate: `requiresWrite: true` plus `requiredCapabilities: ['studio.write']`, and a hard refusal at Tier 0. The gate is about the binary it runs, not about what it changes — it changes nothing (`--incremental false`), so its `sideEffects` is `none` and a re-check after a fix always runs rather than being answered with the pre-fix diagnostics. A connector that cannot install dependencies cannot typecheck either. The prompt states the rule as: a screen is not done until it both compares clean **and** typechecks.

**`studio_lint`** (`lintTool.ts`, over `handlers/studio/projectLint.ts`, AI-21) is the step after "it compiles": does the code follow the rules this project set for itself (hooks, a11y, import order)? It runs the **project's own** ESLint with the project's own config and returns `{ pass, errorCount, warningCount, diagnostics[{ file, line, column, severity, ruleId, message }], truncated, configFile }` (60 diagnostics at most, errors first; `pass` allows warnings). Unlike `tsc`, ESLint can lint a subset without losing its config, so `paths` narrows what RUNS. It is **Tier 2**, gated like `studio_render_reference`: an ESLint config is a JavaScript module the project wrote and its plugins are packages the project installed, and loading them runs them — so the caller needs `studio.run.project` and the project must be at `run-project` trust (`checkTrustTier`), else `trust-tier-required`. How the process is started is the security-hardening bundle's rule for the dev server (`viteLaunch.ts`), shared through `handlers/studio/projectPackageBin.ts`: the `eslint` bin from the project's own `node_modules` (app root up to the project directory, real-path contained), run directly with Node or this Bun — never `<pm> run lint`, which would also run a `prelint` script, and never `npx`, which could fetch a package the project never installed. The config is pinned with `--config` to one found between the app root and the project directory, because flat-config ESLint searches upward and a project under `studio-workspace/` sits inside Studio's own repository; none there is `no-eslint-config`, never a borrowed config. No `--fix`, no `--cache`, no output file: nothing is written, so it is `sideEffects: 'none'` — it batches with other looks — but in Plan mode it is held with the writes until a plan is approved (see Plan mode below), because nothing of the project's runs before the user has agreed what the turn is for. Every lint target is contained through `resolveAgentFilePath` and passed as an absolute path, so a target can never be read as a flag. `minimalSubprocessEnv`, capped output, killed at 120 s. Refusals: `eslint-not-installed`, `no-eslint-config`, `lint-invocation-error` (ESLint's own exit 2 or an unreadable report — never a pass), `lint-timed-out`.

**`studio_fidelity_report`** (`fidelityReport.ts`) is the machine-readable "what will not import faithfully". It walks each page's node tree and turns `PageNode.lockReason` / `resolution` / `codeProps` into the stable codes in `fidelityCodes.ts` — every documented import limitation as `{ code, nodeId, file, line, message, fix, impact }` — plus a per-page score (`nodes`/`resolved`/`locked`/`codeValued`), plus `projectFindings` from the project probe (missing Tailwind config, dependencies not installed, a guessed pages dir) using the same codes `studio_project_profile` returns. It also carries the `RTL_PHYSICAL_PROPERTY` scan the prompt holds the agent to. Call it *before* a visual audit: it says **why** a screen looks wrong and what source change would fix it, which a pixel diff structurally cannot. Alone among the batched tools it does not cap the omit-`pages` case at `MAX_BATCH_PAGES` — a project-wide report is the whole point, each entry is compact, and truncating a 30-screen project to 20 would hide exactly the gaps this tool exists to surface. An explicit `pages` selection still shares the family's cap.

### The design-reference store — `register` / `list` / `read`

Three tools over `.studio/references/`, the durable home for "the design this screen is supposed to match". `studio_compare` and `studio_measure_reference` both read this store; [Arming the ruler](#arming-the-ruler--turndesignreferencests) covers how a chat attachment gets in without the agent doing anything.

**`studio_register_design_reference`** stores the **original bytes verbatim** — never re-encoded, never downsampled — and returns a durable id with the intrinsic width/height, a content hash and the byte size. Exactly one of three inputs: `path` (a file already on disk in the project — the reliable route after a Figma MCP asset-download tool, or anything else that writes an export to disk), `url` (fetched **server-side**, for a publicly fetchable download URL; an `api.figma.com` URL is *not* one, since it needs a token Studio does not have), or `imageBase64` (only when the model genuinely holds the bytes — an image a connector rendered inline is a picture the model can see, not bytes it can re-emit). Raster only: PNG/JPEG/GIF/WEBP/AVIF, and an SVG is refused outright because it has no fixed intrinsic pixel size to diff against. `pageId` scopes it to one screen and is strongly recommended — an unscoped reference is how `studio_compare` on screen 1 silently starts measuring against screen 2's design. Registering by URL gets a 50 MB ceiling rather than `fetchRemoteBytes`' ordinary 25 MB asset cap, because a reference is stored lossless on purpose and the smaller cap rejected comps the HTTP upload route accepted.

**`studio_list_design_references`** returns what is armed, filtered by `pageId`, capped (default 50, max 200) with an honest `truncated`/`omittedCount` — never a silent drop. Metadata only, no bytes. This is the tool that answers "which design is `studio_compare` actually about to measure against", which the prompt makes an explicit check before trusting a verdict.

**`studio_read_design_reference`** returns one reference by id. `includeImage: false` (the default) is metadata only and cheap — enough for `studio_recommend_export_dpr` or `studio_diff_frames`' `referenceId` input. `includeImage: true` returns the original bytes as an MCP image block so the agent can actually look at it, at real context cost. An unknown id, and a registered id whose file has gone missing from disk (pruned outside Studio), each return `ok: false` with the distinguishing reason.

`studio_delete_design_reference` completes the set for external clients but is withheld from the in-canvas agent: cleanup by id is not a decision this agent needs to make mid-turn.

### The design's own numbers — `studio_ingest_design_variables` and friends

`studio_measure_reference` infers a font size as a *range* and a colour by sampling pixels, because a raster is all it has. The design tool's own variable API already states those values exactly — and **Studio's server has no Figma connection and never will inside this tool family.** The connector, where configured, belongs to the *agent*. So the shape is: the agent calls the design tool itself, then hands over what it got back.

**`studio_ingest_design_variables`** stores that table durably under `.studio/variables/`. Each call creates one new, independently addressable set. Colours (any CSS-recognisable hex/rgb/hsl) and lengths with a knowable unit (`px`/`rem`/`em`/`pt`, or a bare number — Figma's own convention for most FLOAT geometry variables, treated as px and flagged `unitAssumed: true`, since a bare number could equally be an opacity, a line-height multiplier or a font-weight) are normalised for matching; anything else is stored as-is with `kind: "other"` and stays readable, never dropped. `pageId`/`referenceId` scope a table to one screen or one reference; omitting both gives a project-wide table, which is right for most whole-file Figma exports. Duplicate names within one call collapse last-wins, and `duplicatesDropped` says how many. **Everything ingested is stored and reported as what the agent was given** — Studio does not and cannot verify it against the design tool, so a `source` string is free text the agent supplied, not a provenance chain. Once ingested, `studio_measure_reference` consumes it automatically, matching each measured value against the design's declared one and from there against the project's own tokens; with nothing ingested, those extra fields are simply absent and that tool behaves exactly as it always has.

**`studio_list_design_variables`** returns per-set summaries (`id`, `ingestedAt`, `source`, scoping ids, `label`, and the variable/colour/size/other counts), filterable by `pageId`/`referenceId`. An empty result is itself informative: it means measurement is running on pixels alone. **`studio_read_design_variable_set`** returns one set's actual entries, each reporting the **original authored value** (`raw`) alongside Studio's normalisation (`kind`, `hex` or `px`, `unitAssumed`) — so a reader can always see what was given as well as what was inferred. Capped at 200 (max 500) with `truncated`/`omittedCount`; use `nameContains` to narrow a large table rather than paging blind. `studio_delete_design_variable_set` is registry-only, excluded from the agent surface for the same reason its design-reference sibling is.

### The Figma-link pipeline — `studio_import_figma_frame` (W9-4)

A pasted Figma URL used to buy one sentence in the prompt. Arming a page against the frame it named took six tool calls in a fixed order, and a weaker model got the *order* wrong more often than it got any single call wrong: download the export, register it, remember `mode: "strict"`, ingest the variables scoped to a reference id that only exists after step 2, find the page, resize the board frame. Miss that last step and every later `studio_compare` is graded on a **resampled** capture — an 800px-tall reference against a 788px-tall frame — a weaker claim than the strict threshold it is being measured with, and silently so.

**`studio_import_figma_frame({ dir?, pageId, url?, exportPath?, node?, variables?, mode?, label? })`** is that ritual as one call, `execution: 'server'`, `requiresWrite: true`, `sideEffects: 'write'`, `studio.write`.

**Studio still never talks to Figma.** This tool fetches nothing, accepts no token, stores no token and returns no token. Every Figma-side input arrives as an argument the *agent* already holds, fetched through **its own** connector: `exportPath` is a file its asset-download tool wrote inside the project, `node` is `get_metadata`'s JSON, `variables` is `get_variable_defs`' table. `url` is recorded verbatim as the reference's provenance and parsed (`server/handlers/studio/figmaUrl.ts`) into `{ fileKey, nodeId }`, echoed back in the colon form Figma's own tools take — a copied Figma link writes `123-456`, and re-deriving `123:456` from the raw URL was a step the model routinely got wrong.

Four legs, each reporting its **own** status code, so one failing leg does not look like a failed import (a missing export still resizes the frame):

| Field | Codes | What it means |
|---|---|---|
| `frame.status` | `resized` · `already-matched` · `no-bounding-box` · `out-of-range` · `no-frame-for-page` · `section-not-sized` | The board frame was set from `node.absoluteBoundingBox`. This is the one that kills the resample class. `no-frame-for-page` names `studio_list_pages`; `no-bounding-box` names the cost (every comparison stays resampled). `syncBoardFramesFromDisk` runs first, so a page the agent wrote moments ago is placed rather than reported missing. |
| `reference.status` | `registered` · `not-provided` · `failed` | The export, landed through the same `registerDesignReference` path everything else uses, as `role: "spec"` and **`mode: "strict"` by default** — a Figma frame is an exact spec. `not-provided` says what it costs: `studio_compare` still has nothing to measure against. |
| `variables.status` | `ingested` · `not-provided` | The table, stored scoped to this page **and** to the reference just registered, through `studio_ingest_design_variables`' own store. Same "what you were given, never verified" posture as that tool. |
| `screenDetection` | `single-frame` · `section-of-screens` · `no-metadata` · `no-bounding-box` | Whether this metadata describes one screen or N. |

**Section → N pages.** A Figma SECTION (or a frame used as a board) holding sibling screen-sized FRAMEs is N pages, not one. A direct child counts as a screen when it is visible, FRAME-like, at least 240×320, **and** at least half the parent's own height — that last clause is the whole discriminator, because screens sit side by side in a section (nearly as tall as it) while a hero and a header inside one screen stack (a fraction of its height). Two or more such children make it a section: nothing is resized, and `screens[]` enumerates each one's `name`, `nodeId` and size. They are **enumerated, never auto-created** — creating N Studio pages from one tool call would write files the user never asked for under names this tool would have to invent. Create the pages, then call this tool once per screen with that child's own metadata and export.

**Hidden layers are reported, not built.** `visible: false` subtrees are counted (never descended into — a layer under a hidden layer is not a second finding) and up to 20 are named back, with the note that says what it is for: these are not part of the design, so do not build them and do not read their absence from the export as a mistake.

The live digest carries the parsed link too. `StudioLiveDigest.figmaLink` is `{ url, fileKey, nodeId }` for the first figma.com URL in the user's latest message — `nodeId` is `null` rather than the raw text when the link names no resolvable node, so nothing downstream can hand a placeholder to a Figma tool. It is computed unconditionally; the *nudge* (`figmaReferenceNudge`, which additionally requires a configured connector, an active page and no armed spec) is the conditional part, and its prompt line now names the identifiers and points at this tool.

### Board geometry — frames, axes, variants

Board state lives in `.studio/boards.json`, not in the source files the agent can write, so it needs tools.

**`studio_set_frames`** (`editTools.ts`, server-side) bulk-resizes: set `width`/`height` on the given `pageIds`, or on **every** frame across every board when `pageIds` is omitted — which is what "set all the pages to a certain width at once" means. A `pageId` with no existing frame is **skipped, not created**, so pair it with `studio_list_pages`; the response's `resized`/`missing`/`pageIds` says exactly which frames moved. If the caller has the project open in a tab, its board geometry is nudged to re-read from disk, best-effort.

**`studio_arrange_frames`** (`arrangeFramesTool.ts`, AI-17) places frames: `pageIds` + `layout` (`row` to compare variants side by side, `column`, or `grid` with `columns`), or `positions` for explicit x/y, with optional `gap` and `origin` (default: the group's own current top-left, so it tidies in place). `notes` puts a sticky note above a frame — a variant's idea — with an id derived from the page, so arranging again rewrites the same note. It never resizes, creates or removes a frame; a page shown twice (a variant under other axes) moves as a pair, keeping its offset. A page with no frame refuses `no-board-frame` (`studio_screenshot` places one). Until it existed the creative block asked for variants "side by side on the board" and nothing could place a frame.

**`studio_set_frame_axes`** and **`studio_duplicate_frame_as_variant`** (`frameAxesTools.ts`) run on the server and write `.studio/boards.json` with a live-reload push (see the parity rows below); they change the same frame state the editor store's `setFrameAxes` / `duplicateFrameAsVariant` change. The first overrides one frame's preview `direction`/`colorScheme`/`locale`, the same control the toolbar's preview-axes UI drives; a user editing in the same session watches the frame flip. The second duplicates a frame as a new, independently addressable variant with its own axes, which is the side-by-side move: the same page rendered twice on the board (LTR beside RTL) rather than one frame toggling back and forth. It returns `{ frameId }` for the new frame, which is what a later `studio_set_frame_axes` call takes to adjust it again. Both address a frame by `pageId`, and when a page has more than one frame on the active board the first found wins unless `frameId` is given. Both are `requiresWrite: true` + `studio.write`, and `sideEffects: 'write'`. A design-review turn should flip the axes *before* capturing, not just look at the default rendering — the prompt says as much, and `studio_screenshot` also takes a one-shot `axes` override that restores the session afterwards.

### Board comments as a work queue

Three tools that let a review thread be closed end to end: `studio_list_comments` finds what is outstanding, the file tools make the change, `studio_reply_comment` says what was done, `studio_resolve_comment` marks it done. This is what comments living on disk next to the source buys — a review thread readable by whatever is editing the repository.

They were absent long enough to make a routine request impossible rather than merely awkward: the comments panel's own "address these comments" prompt says in as many words *reply in the thread saying what you did, and resolve it*, and the agent had no tool that could do either. Measured on a real session with six threads, five open: every edit landed, not one thread was replied to or resolved, and nothing anywhere told the user why.

**`studio_list_comments`** returns `{ seq, threadId, resolved, anchorConfidence, agentActionable, location, comments[] }` per thread. `seq` is the number on the pin, and the number to use when talking to the user ("comment 3"). `location` is deliberately over-complete so the agent never has to guess which element was meant: board and frame ids, `pageId`/`pageTitle`/`pageFile` (the file to edit), `dx`/`dy` as the pin's position in frame-local px from the frame's top-left with `xPercent`/`yPercent` alongside, and `element: { nodeId, moduleId, text, trail }` — where `trail` is the path of labels from the page root down, so the element is findable **by structure** when its id has gone stale. `element` is `null` for a pin dropped on empty canvas, where the coordinates are the whole location. Filter by `status` (`open` default / `resolved` / `all`) and `pageId`; resolving anchors costs a page parse, so `resolveAnchors: false` opts out for an agent that only wants the text.

**The anchor gate is the reason these tools are shaped this way.** A Studio node id is `relFile:line:col` — a source *position*, so it stops resolving the moment anything above it in the file changes, and a comment written last week almost certainly names a line that now belongs to something else. That makes "the agent acted on the comment" a genuinely dangerous sentence: trusting a rotten anchor edits the **wrong element, in the user's real source, in a file they did not open**, and then posts a reply saying it did what was asked. A wrong edit that announces itself as correct is worse than no edit.

So **`studio_resolve_comment`** re-resolves the anchor against the live tree and **refuses** on `drifted` (the element was edited since) or `detached` (it is gone), posting the reason *into the thread* and returning `{ ok: false, code: "stale-anchor", anchorConfidence }` — leaving the thread open for a human. Same posture as `refuseStructuralEdit`: when there is not exactly one honest target, say so rather than guess. `isAgentActionable` in `@core/studio-comments` is the single predicate; there is deliberately no looser copy inline. Reopening (`resolved: false`) is never gated. `studio_list_comments` reports the same confidence on every thread, so a well-behaved agent never attempts the refused call — the gate is the backstop, not the interface. The honest-target rule here is enforced by the tool, not by the prompt.

**`studio_reply_comment`** posts into a thread by `seq`, attributed to the AI and rendered with an "AI" tag: a reviewer must always be able to tell which half of a thread was machine-written. Use it to report what changed, or to explain why nothing did. Both writes require `studio.write`; the list tool takes the same read posture as every other Studio read.

### Orientation — profile, pages, tokens, components

Four reads the filesystem cannot answer as cheaply or as truthfully, plus one narrow lookup.

**`studio_project_profile`** is "what am I working with" in one call: detected framework, route style, pages directory, style toolchain (Tailwind / Sass / CSS Modules / CSS-in-JS), component packages, design systems, path aliases, locale capability, and the probe's own warnings as `{ code, message, fix }` — the same codes `studio_fidelity_report` surfaces. `profile.colorScheme` is how *this* project expresses dark mode: the mechanism (`class`/`media`/`none`), the exact selector a dark rule must be gated on, and the source file it was found in, which is often the installed design system's stylesheet rather than anything in the project. It uses the cached probe from `.studio/meta.json` when present and probes fresh otherwise, and never writes the cache except to heal one an older probe version got wrong. It also returns the project's `trust` tier, which is what tells the agent whether `studio_install_deps`/`studio_typecheck` will refuse.

**`studio_list_pages`** lists every page (board frame) with `pageId`, `title`, `slug` and `nodeCount`, parsing the whole project once through the same pipeline the Studio UI uses to load the board. Its ids are what `studio_set_frames`, `studio_fidelity_report` and the scoping arguments on the reference/variable tools take.

**`studio_list_tokens`** (`projectTokenTools.ts`) lists the project's real tokens: every CSS custom property declared at the document root in the stylesheets above, through `listProjectTokens` — the position-keeping view of the same scan `studio_measure_reference` matches measurements against, so the two cannot disagree about a value. Each token carries its resolved `value`, its `dark` value only when one differs (resolved through the dark map, so an alias of a token that changes in dark mode reports its dark value too), `aliasOf` when it is declared as `var(--other)`, a `role` for type tokens, and `source` — the `file:line` of the declaration that wins the cascade (`file` alone for compiled Sass/PostCSS output, whose lines point at nothing a person edits). Results are grouped by family (`color`, `type`, `space`, `radius`, `shadow`, `other` — `classifyDesignTokenFamily`'s nine families folded to six), filterable by name substring or family, and paginated (`offset`/`limit` ≤ 400, `nextOffset` when more remain); `counts` always covers the whole set and `sources` names every stylesheet scanned with its origin (`project` / `package` / `studio-design-system` / `compiled`), so "why is `--x` missing" has an answer. **It used to read `.studio/framework.json`** — Studio's own generated scale, `{"colors":{"tokens":[]}}` on every real project — and so told every agent the project had no tokens while the prompt called it the source of every `--type-*` value (AI-4). The prompt still says never to read `.studio/` directly; it now also says the project's tokens are not in there.

**`studio_list_components`** is the design system's real component API — the *exact* catalog the Studio insert palette draws from, read headlessly. It closes a documented failure: an agent could not enumerate what the palette offers, could not see a single prop signature, and guessed component names from prose, and a real board shipped using 2 of 42 available components with a hand-rolled nav, divider and cards that already existed. Each entry is `{ name, pkg, exportName, isDefaultExport, file, hiddenFromPalette, apiSource, props, figma? }`: `pkg` is the specifier to actually write, and `props` is `[{ name, kind, required }]` under the same classification the Properties panel uses to pick a control (`enum` → dropdown, `color` → colour picker, `node` → slot). **`apiSource` is the honesty field**, because two sources are merged and neither is guessed from the other. `types` means the props came from a real `.d.ts`/`.tsx` — `required` is trustworthy. `code-connect` means the project has no typed entry for that package at all and every prop was reduced from a Figma Code Connect `*.figma.tsx` mapping (a `figma.enum` whose code-side values are all strings becomes an enum, all-boolean becomes boolean, anything else stays `unknown` — never guessed), and there **`required` is always `false`**, because Code Connect maps the values a variant can take, not whether a prop is mandatory. `hiddenFromPalette` marks an overlay/portal component (Dialog, Sheet, Toast, Tooltip, Popover by name, or an explicit `.studio/meta.json` override) that is real and importable but excluded from the canvas picker as confusing to hand-place — still usable by writing its JSX directly. Responses are capped (default 60, max 200) with `matchedComponents`/`returnedComponents`/`omittedCount`. **The stated limitation matters:** a design system brought in through the "Import design tokens" wizard (`styles/imported/<slug>/`, plain CSS, no `package.json`, no Code Connect files) has no extractable component API from either source and returns zero components — the response's `designSystems` field and `note` are how "this project has a design system I can't read" is told apart from "this project has none".

**`studio_find_component`** is the narrow lookup for a large system where listing everything wastes context. Match on `name`, on `prop` (a prop *name* any matched component declares — `prop: "variant"` finds every component with a variant prop, so their enum values can be compared before picking one), or both. At least one is required; browsing without a starting point is `studio_list_components`' job. Same per-component shape, capped at 40 (max 200) with `truncated`/`omittedCount`, and the same imported-CSS-design-system limitation.

**`studio_component_snippet`** (`componentSnippetTool.ts`, AI-14) writes the one thing the two catalog tools leave to the agent: the exact import line for the file the usage goes into — relative to it for Studio's built-in design system (`designSystemImportSpecifier`, the scaffolder's own helper), the package specifier otherwise, default or named as the component really exports — and a JSX usage whose `props` are checked against the component's API. An enum value outside its set, a wrong type or an undeclared prop refuses `invalid-prop-value` with the accepted values (a Code Connect-only component, whose mapping may be partial, warns instead of refusing an undeclared prop); required props it could not fill are listed; `alreadyImported` says whether the file already has the import. A read: it writes nothing.

**`studio_set_tokens`** (`setTokensTool.ts`, AI-15) changes token values as a CST edit (`@core/css-codemods`' `setCustomPropertyValueAtLine`: postcss round-trip, comments, formatting, `!important` and the file's line endings kept) on the ONE declaration that is each token, found with the same scan `studio_list_tokens` and the canvas use. `scheme: "dark"` edits the dark-scheme declaration. A batch of up to 40 is all-or-nothing across files. It refuses `no-such-token` (and says when only the other scheme exists), `read-only-source` when a package, Studio's design system or compiled output wins, and `ambiguous-declaration` — with every `file:line` — when two project stylesheets declare the token for that scheme or one file declares it twice (a second selector, a responsive `@media` override). The write goes through the agent write gate (`resolveAgentFilePath(…, 'write')`, i.e. `agentWriteRefusal`), holds the project write lock, re-reads the file inside it and refuses `stale-source` if it moved since the scan, then commits through the shared `commitPlannedWrites` (turn-logged, live-reloaded). A `.css` stylesheet is not a host-executed file, so the gate allows it; the value is refused unless it parses back as exactly one declaration, so no `;`, `{` or `}` can smuggle a second declaration or an at-rule into the file.

The deep-dive sibling `studio_list_component_bindings` — the full per-value Figma label mapping, verification prose, and per-component file keys — stays registry-only.

### Assets — find before you draw (P4-E, AI-13, AI-20)

The Assets ladder used to end, for a photo or an icon the brief did not arrive with, in "a plain neutral placeholder box". The agent had no way to find either, so creative screens came out grey. Four tools replace that rung, and the prompt's ladder (`systemPrompt.ts` "# Assets") now reads: what the project has → the design system's icon → the design's own art → licensed stock → only then a box, and the reply NAMES what belongs in it.

- **`studio_list_assets`** (`assetInventoryTools.ts`, read) — the project's images (the same walk as the inspector's picker, `projectAssets.ts`), each with its site URL (`assetSiteUrl.ts`), `buildSafe`, pixel size (header bytes only), file size, and its stock credit. Filtered by `query`, paged by `offset`/`limit` (≤ 100).
- **`studio_list_fonts`** (read) — the families the project can actually render and how each is loaded (`@font-face`, a Google Fonts link, `next/font/google`, a font file), its font tokens and font files, from the same evidence as the `font-not-available` finding (`fontAvailability.ts`). With `query`, searches Studio's bundled Google Fonts snapshot (`@core/fonts`, no network) and returns the exact `@import` line to add.
- **`studio_find_icon`** (`findIconTool.ts`, read) — fuzzy search over `collectStudioIcons` (the picker's catalog): words and camelCase, prefixes, a small synonym table (search/magnifier, close/x, delete/trash…) and typo tolerance. Each match carries the `?raw` import for `forFile`. A built-in design-system icon is imported from `design-system/icons/…` even when the folder does not carry it yet: every load runs `ensureDesignSystemFiles`, whose demand scan copies in each icon a project file imports. Only in a project whose `.studio/meta.json` does not name `designSystem: 'alm'` (so nothing maintains that folder) does a missing icon come back as markup plus a `saveAs` path (markup capped at 24 KB per call). No catalog → a plain answer naming what to ask the user for.
- **`studio_find_image`** (`findImageTool.ts`, `studio.write`) — searches **Pexels** (`stockPhotos.ts`) and lands the best `count` (≤ 4) photos, returning the next six as `moreResults` for a follow-up `photoId`. Pexels, because its licence lets the file live in the user's repo (Unsplash's API terms require hotlinking), it needs no attribution we cannot give, and every image is on one host. The credential is **`PEXELS_API_KEY`** in the environment: never stored, logged, returned, or sent to the image host. Without it the tool answers `configured: false` with what to do instead (not an error), and the live digest says so once so the agent skips it. Each landed photo gets a line in the project's **`IMAGE-CREDITS.md`** (`imageCredits.ts`): photographer, source, licence, keyed by the image's path; photographer names are made inert as markdown and linked only to `pexels.com`.

Every landing — `studio_find_image` and `studio_fetch_remote_asset` — goes through `landAgentAsset` (`agentWriteSupport.ts`): the target folder is resolved by `resolveAgentFilePath(…, 'write')`, so the ONE agent write gate (`agentWriteRefusal`) refuses `.studio/`, `.git/`, `.claude/` and Studio's `prototype/` shell, which `assetLanding.ts`' own guard (built for the user's drops) allowed; the landing holds `withProjectWriteLock`; and a new file is recorded in the turn write log. The bytes themselves still land through `assetLanding.ts` unchanged: sniffed type, sanitized SVG, content dedupe, `wx` names.

**Which hosts an agent may make Studio fetch from** (`remoteFetchPolicy.ts`, security review of #233 F8). The transport (`remoteAssetFetch.ts`) already blocked private, loopback and metadata addresses, redirects and oversized bodies; it could not stop a request to a PUBLIC host the model was talked into naming — a URL planted in a README or a design layer, carrying stolen data in its query string. Now `studio_fetch_remote_asset` and `studio_register_design_reference({ url })` fetch only from Figma's asset hosts (`figma.com` and subdomains, Figma's S3 export bucket), the stock provider's image host, the Figma Dev Mode server's `:3845/assets/` path on loopback when the operator set `STUDIO_ALLOW_LOOPBACK_ASSET_FETCH` (no other loopback port or path), or **a URL the user pasted into this conversation**, matched exactly (fragment ignored). Anything else is `host-not-allowed`, before a DNS lookup. The user's URLs come from the text blocks they typed (`collectUserSuppliedUrls`, in `chat.ts`); a user-role block Studio composed carries `origin: 'studio'` and is skipped. "Address with AI" is one: it quotes every comment in the thread, the AI's own replies included, so a URL the agent planted in a reply never becomes one the user "pasted" (review of #248, F2). They ride `ToolContextBase.userSuppliedUrls` on the HTTP path, and on the `claude` CLI path reach the MCP server through the turn's connector (`connectorUserUrls.ts`, bound by `bindConnectorRegistries`). An external MCP client has no user-supplied set. The transport also gained a 30 s deadline over connect, headers and body (a never-ending body no longer holds the turn), an image `content-type` allowlist checked before the body is read, and a check that the sniffed magic bytes match the declared type.

**A landed SVG never runs on the admin origin.** Every route that serves a user or project file on Studio's origin — `/admin/api/studio/asset` (a project's own images, which includes every landed asset), `/uploads/*`, and a published SVG/HTML under `/_studio/assets/*` — sends `INERT_FILE_CSP` (`server/static.ts`: `default-src 'none'; sandbox`, plus `nosniff`) through one helper, and the admin security layer appends its own directives to a route's policy instead of replacing it (`securityHeaders.ts`). That header is the boundary: an SVG opened directly ("open image in new tab") gets no script and an opaque origin. `svgSanitize.ts` is defence in depth: it also strips namespace-prefixed `script`/`foreignObject`/`handler` elements, entity-encoded or whitespace-split `javascript:` URLs, SMIL `animate`/`set` that target a link or an event handler, and handlers after `/` or a quote (security review of #248, F1).

### Dependencies — `studio_install_deps` and `studio_install_status`

**`studio_install_deps`** starts a `bun install --ignore-scripts` (or the detected package manager) as a **background job** and returns a `jobId` immediately; it never blocks on the install itself, which runs 30 s–3 min. It **refuses outright at Tier 0 (`static`)** — the agent may ask the user to promote the project, never promote it itself. That check reads `.studio/meta.json`'s `trust` field at the tool's own authorization boundary and has no notion of "bypass" at all, so no permission mode can widen it. Postinstall scripts never run even once promoted, since arbitrary code execution is refused separately; a package needing one is reported as a warning in the job log. A project that is already installed returns `{ jobId: null, alreadyInstalled: true }` rather than doing the work twice, and a project with no `package.json` gets a plain error.

**`studio_install_status`** polls that job by `jobId` and returns `{ status: running | done | failed | timeout, log, exitCode }`. It is a plain read with no capability gate — the write half of the pair is where the gate lives.

### Session controls — model, effort, mode, attachments (WS-12 §5)

**Model** — `ModelPicker.tsx`, populated live from each provider (no hardcoded list). **Effort** and **mode** are `AgentSessionControls.tsx`, above the composer: `--effort` (`low|medium|high|xhigh|max`) and `--permission-mode` (`default|acceptEdits|plan|bypassPermissions`), both request-driven end to end (`chatRequest.ts` → `AiStreamRequest` → `claudeCli.ts`'s argv). Effort also reaches every HTTP driver since P4-C (AI-11): an explicitly chosen effort becomes Anthropic extended thinking (`thinking: adaptive` + `output_config.effort` on current models, a `budget_tokens` budget on 3.7–4.5, nothing on older ones — `anthropicModelProfile.ts`) or OpenAI-style `reasoning.effort` / `reasoning_effort` (`openAiReasoning.ts`); an unset effort sends none. Permission mode is `claudeCli`-only except Plan, which the HTTP drivers now enforce too (AI-22, see "The panel" below). **Fidelity mode** (W9-2) is the third trigger in that row and **design policy** (A12) the fourth; both ride the same wire and are consumed server-side rather than mapped onto a CLI flag — see "Fidelity modes" and "Design policy" above.

**Two more fields ride the same wire, and neither has a picker (Z3).** `maxToolRounds` and `turnCapMs` are per-turn OVERRIDES of the loop ceilings described under "Every loop has a ceiling" and "Abort + crash recovery" — a turn that names neither is still bounded, so omitting them is the normal case and no caller can remove a ceiling by leaving one out. They are bounded at the schema (1–200 rounds; 1 min – 2 h) rather than clamped in a driver: a caller asking for a thousand rounds is asking for exactly what the ceilings exist to prevent, and a validation refusal says so instead of quietly substituting a different number. `maxToolRounds` is read only by the shared HTTP tool loop and `turnCapMs` only by `claudeCli`; each driver ignores the other's.

**Bypass is the Studio panel's DEFAULT mode.** An initial pass refused `bypassPermissions` outright, reading this driver's "never pass a permission-bypassing flag" rule as covering the literal value under any circumstance; that was resolved to "a user deliberately selecting Bypass IS the consent", and it is now the mode the composer starts in (`agentSessionControlsInitialState`). `--dangerously-skip-permissions`/`--allow-dangerously-skip-permissions` (a different, blunter flag) remain permanently, unconditionally forbidden — this driver's argv never constructs either, checked or not.

**Why that is defensible, and it is not "the agent can now do more".** Permission mode governs PROMPTING for an already-available tool; it never widens which tools exist. `--tools` is a hard availability list the CLI evaluates independently of and *prior to* `--permission-mode`, so `Bash` stays withheld under Bypass exactly as under any other mode, and a native write stays bounded by the subprocess `cwd` (the containment-checked project directory). Studio's own tools stay gated by the minted connector's capabilities, floored to the caller's. `acceptEdits`, the previous default, only ever silenced the *file-edit* half — every MCP tool call still raised an Allow/Deny card mid-build, which is the friction this change removes.

**What it costs, stated rather than buried.** Nothing reads the mode from storage, so a user who deliberately switches to a *safer* mode is back in Bypass after a reload. Under the old default that reset direction was always toward safety; now it is away from it. Making an explicit downgrade stick would mean persisting the mode, which this design deliberately does not do — if that trade stops being acceptable, persist the user's explicit choice rather than moving the default back and forth.

D5 §11.5's rail 1 ("non-persisting") is retired by this: it existed to stop Studio arriving at Bypass without the user, and Bypass is now where the user is put deliberately. The other two survive, one altered:

1. **Visibly indicated** — the mode trigger (in the composer's own control row, `AgentSessionControls.tsx`) carries a warning glyph and a descriptive accessible name whenever the mode is Bypass, and sits outside the scrollable message thread so it can't scroll out of view. Its `danger` **tone was dropped** when Bypass became the default: a red on every session for every user is not an indication, it is wallpaper, and it drains the colour of meaning everywhere else it is used. The trigger's label already reads "Bypass". The menu *item* keeps `danger`, where it still does real work — telling the four options apart at the moment of choosing.
2. **Still trust-tier-bound** — Bypass has zero effect on tool-level authorization. `studio_install_deps`'s trust check (`projectTools.ts`) reads only `.studio/meta.json`'s `trust` field; the tool call has no permission-mode parameter for a mode to influence in the first place. Tested explicitly (`projectTools.test.ts`): a tool call carrying `permissionMode: 'bypassPermissions'` in its input is refused at Tier 0 exactly the same as one that doesn't.

**The server still never invents Bypass.** `resolvePermissionMode` (`claudeCliPermissionMode.ts`) falls back to `acceptEdits`/`default`, never to Bypass — a caller that names no mode (an external MCP client, a script, a future driver) is not a person choosing it. `assertBypassCameFromRequest` sits at the literal argv-construction site and throws if `bypassPermissions` would reach argv without the request having named it. It was renamed from `assertBypassOnlyFromExplicitRequest`, because "explicit request" stopped being true the moment a default put the value in the request — a guard whose name overstates what it checks is worse than no guard.

**Effort persists per project AND per account** (D5, W10) — `.studio/meta.json`'s `agentSession.byUser[<studioAgentUserKey>].effort` (the bare `agentSession.effort` is still READ as the project-wide default for an account that has never saved one, and never written again), round-tripped through `GET/POST /admin/api/ai/studio-session` (`server/ai/handlers/studioAgentSession.ts` — lives under `server/ai/handlers/`, not `server/handlers/studio/`, specifically so it needs no change to `studio.ts`'s own sub-router array). Fidelity mode (W9-2) and design policy (A12) persist through the same route and the same per-account shape; each control is sent on its own request and an omitted field means "leave alone", so the three pickers never overwrite each other. **Permission** mode is never accepted by this route's request schema at all — the same "nowhere to write it" enforcement as the store-level rail above.

**Effort is ROUTED per turn when nobody pinned one** (`server/ai/routing/turnRouting.ts`). Before this, every turn shipped at `DEFAULT_EFFORT` — "what does that class do?" paid the same price as "rebuild this screen from the Figma frame", in latency the user sits through and in a rate limit they hit later. Two rules bound it:

1. **An explicit choice is never overridden.** A pinned effort (`req.effort`, set by the composer's Effort submenu) is used verbatim and the classifier does not run at all. Routing is strictly additive to a default nobody chose.
2. **Unsure routes UP.** Under-serving a build turn costs a wrong screen plus a full corrective turn; over-serving a question costs a few seconds. So `build` is the fallback answer and `question` must be positively earned: nothing attached, short (≤320 chars), no imperative verb, and question-shaped. A vague follow-up ("is that right?") after a turn that wrote files is routed up, not down — `readTurnWriteLog` is read before `resetTurnWriteLog` clears it, so "did the last turn write anything" is a real signal rather than a guess.

Three shapes (`question` / `smallEdit` / `build`) map onto two efforts: `question` → `low`, the other two → the same `medium` that was previously unconditional. **Nothing routes above the old default** — raising effort would be a latency and rate-limit regression nobody asked for, and there is no measurement here saying `high` builds a better screen. The classifier is pure and table-tested (`turnRouting.test.ts`).

### Model routing and turn telemetry (AI-25)

**One table picks a model per job** — `MODEL_ROUTING_TABLE` in `server/ai/routing/modelRouting.ts`: `claude-opus-5-5` for build and creative turns, `claude-sonnet-5` for small edits, questions and `studio_delegate` subagents, `claude-haiku-4-5-20251001` for utility calls (history compaction reads `COMPACTION_MODEL_ID` from it). `claude-fable-5-1` is a bench candidate with **no role** until it has been measured. These assignments are the owner's (ROADMAP P4-G) and are **not yet measured**: `bun run bench:agent-models` is what confirms or changes them (see "Measuring it" below).

The chat handler classifies each turn with the same `classifyTurn` the effort router uses (`routing/chatTurnModel.ts`), maps the shape to a role (a build with no design to match — fidelity `creative` — is the `creative` role), and applies three rules:

1. **A chosen model is never overridden.** `ai_conversations.model_source` (migration 024) records why a conversation has its model: `default` (the client staged Studio's default and the user never picked) or `chosen` (picked in the model picker — at creation, or later through the conversation `PUT`, which always sets `chosen`). Only `default` is routed; a row from before the column reads as `chosen`, so no existing conversation starts being routed on upgrade.
2. **Routing only ever spends less.** A turn never moves to a higher tier than the conversation's own model (`opus` > `sonnet` > `haiku`, read off the id). With Sonnet as the default, a build turn stays on Sonnet. An id with no known tier is never routed from or to.
3. **Only to a model the key can use.** The target must be in the credential's live model list (`routing/modelAvailability.ts`, cached 10 minutes per credential revision); an unknown list keeps the conversation's model. Routing never makes a turn fail.

Only the Anthropic API-key provider is routed. The `claude` CLI is deliberately not: its catalogue is three static aliases, so an id cannot be checked before the spawn, and its warm session is keyed to one model — routing per turn would cold-start the process the warm pool keeps alive. The routed model is the one priced (`createConversationsPersister`), the one compaction sizes the window for, and the one the audit row names. The panel sees it as a `modelRouting` stream event; when a turn ran on a different model than the picker shows, the model trigger's read-only label adds `turn · <model id>` with the router's reason on hover (`routedModelLabel`).

**What the routing is measured by.** Every turn with a project open, on both paths, appends one `kind: 'turn'` line to `.studio/agent-turns.jsonl` beside the per-tool lines (`handlers/studio/agentTurnLog.ts` → `AgentTurnSummarySchema`, written by `server/ai/turnTelemetry.ts`): the model it ran on, the conversation's own model, the routing mode and role, wall-clock duration, provider rounds, tool calls, prompt and completion tokens, and the outcome (`ok` / `error` / `aborted`). A `studio_delegate` child writes its own line with role `subagent`. Numbers and ids only — never a prompt or a reply. `summarizeTurnsByModel` groups them per (role, model) — p50/p95 duration, p50 tokens and tool calls, error rate — and `bench:agent-turn` prints that table.

**Measuring it.** `bun run bench:agent-models` (`scripts/bench/benches/agent-models.ts`) runs real API-key turns — the production prompt, tool surface (with `studio_delegate`), driver and loop — once per candidate in `MODEL_BENCH_CANDIDATES` against a fresh copy of the canonical fixture: the creative brief always, graded by `studio_quality_check` findings and a labelled grey-fill heuristic for placeholder boxes; the match brief when `STUDIO_BENCH_MATCH_REFERENCE` names a PNG to rebuild, graded by `studio_compare`. It spends real tokens on the operator's `ANTHROPIC_API_KEY` and reports `skipped` unless `STUDIO_BENCH_SPEND=1` is also set. It writes `agent-models.json` and the per-(role, model) telemetry table. No result from it is recorded in this doc: the assignments above stay the owner's until a run says otherwise.

### A turn has a budget and shows its work (A9)

**The budget.** `AGENT_TURN_ROUND_BUDGET` (40) lives in `@core/ai`'s `turnBudget.ts` — the leaf both halves already depend on, because three surfaces have to agree on the same integer or the control is a lie: the prompt states it, the driver loop caps rounds at it, and the panel renders progress against it. The static prefix's "Step budget" section states the ceiling, asks the model to report `step k/N` as it works, and says why: the user is watching a progress line built from exactly those reports, and the model is budgeting against a ceiling it can see rather than discovering it as a truncation. It also carries the two loop rules — never re-issue a mutating call with identical arguments, and a `retryable: false` code is final.

**The progress line.** `parseTurnStepReport` (a narrow regex; a bare "3/6" is a fraction, only the literal word `step` in front of it makes the claim) runs on each text delta in `streamEvents.ts` and stamps `AgentMessage.reportedStep` — session-only, display-only, never persisted and never replayed to a model. `formatTurnProgress` composes the line: the model's own `step 3 of 6` when it reported one, `2 of 3 steps done` from the tool-call ledger when it did not, plus the round count against the budget once the turn passes `AGENT_TURN_ROUND_WARN_AT` (3/4 of it), because at that point the honest question stops being "what is it doing" and becomes "will it get to finish". It renders in `AgentActivity`'s meta line beside the elapsed clock — **passive**, in the transcript, never a toast. A turn that is working is not an event.

A report split across two stream deltas is missed. That costs the line its nicer denominator for one step and nothing else: the tool-call fallback is always available.

**Per-turn telemetry — `.studio/agent-turns.jsonl`.** One line per tool round: tool name, ms, bytes in/out, `ok`, cache hit, execution class, and the turn's resolved fidelity mode and design policy. Recorded in `executeAiTool` (`server/ai/drivers/http/execTool.ts`) and nowhere else, because that is the **one** choke point both the HTTP drivers (via `toolLoop.ts`) and the `claude` CLI (via `server/ai/mcp/server.ts`) pass through — instrumenting the two loops separately would produce two logs that disagree about what a round is. TypeBox schema, capped at 2 MB with a whole-line trim to 1 MB on the next append, and every function swallows its own failures: a telemetry write that failed must never turn into a failed tool call.

**Byte counts, never bytes.** A tool argument can carry a file path, a design brief or a pasted credential; `bytesIn`/`bytesOut` carry none of those and answer the only question this log exists to answer.

A rejected browser bridge is deliberately **not** recorded — a round that never reached a tool has no tool latency, and logging it as one would poison the p95.

**`bench:agent-turn` reads it back.** A fifth section reports per-tool p50/p95/max/total and cache-hit rate (slowest total first — the order that answers "where did the turn go"), then grades each conversation's summed tool time against A9's two budgets: **90 s** for a creative turn with no reference to measure against, **3 min** otherwise (`AGENT_TURN_BUDGETS`). `observedMs` is Studio's own tool time, **not wall clock** — the model's thinking time is neither Studio's to measure nor Studio's to fix, and a reader who thinks otherwise reads every verdict as optimistic. The budgets assert as **warnings**, not failures, for as long as no real turn has been measured on this machine: a budget that fails a suite on a number nobody has observed trains people to ignore the suite. Every row names its `worstTool`, which is where to look first. With no log anywhere the section reports `unavailable` with the reason, the same posture the capture section takes without Chromium — it never fabricates a number.

**A real turn has now been measured — `tests/e2e/agent-turn.e2e.ts` (`mcp-25`).** It drives one brief ("Make the hero heading bolder and give the hero card a subtle shadow") on a throwaway copy of `studio-workspace/__canonical-fixture`, in `balanced` fidelity, through the warm `claude` CLI — the real subprocess and the real subscription, not a fake. Four such turns on this Windows box, 2026-09-18:

| run | wall ms | tool rounds | `POST /admin/api/studio/save` | files changed |
|---|---|---|---|---|
| 1 | 198,788 | 10 | 0 | `CanonicalScreen.module.css` |
| 2 | 56,362 | 8 | 0 | `CanonicalScreen.module.css` |
| 3 | 173,327 | 9 | 0 | `CanonicalScreen.module.css` |
| 4 | 149,801 | 15 | 0 | `CanonicalScreen.module.css` + `CanonicalScreen.tsx` |

`AGENT_TURN_WALL_MS` (`tests/e2e/helpers/canvasPerf.ts`) is **300,000 ms** — 1.5x the worst, rounded up. Read the 3.5x spread on an identical brief before tightening it: the slow runs are the ones where the agent reached for `studio_screenshot`, so a budget near the median would fail on the model deciding to look at its own work. It is a ratchet against a hung turn, not a target, and it does not replace `AGENT_TURN_BUDGETS` above — that grades Studio's own TOOL time, this measures the wall clock a person waits.

Three things the runs settled that no unit test could: **zero writeback POSTs is the healthy shape** (the in-canvas agent writes with the CLI's native `Read`/`Write`/`Edit`, and `STUDIO_AGENT_TOOL_NAMES` does not offer it `studio_apply_edits`, so `/admin/api/studio/save` is the canvas's path and not the agent's); **no turn fanned out** — every changed file in all four was the hero's own; and the telemetry above really is written on the CLI path, 2–7 lines per turn.

**The MODEL is deliberately not routed.** `req.effort` is `undefined` until the user picks one, which is exactly what makes "pinned vs default" knowable; `req.modelId` has no such tell — the session always carries a concrete model id and nothing distinguishes "the user chose Opus" from "Opus is what the credential defaulted to". Routing on that would silently demote a deliberate choice, which is the failure rule 1 exists to prevent. Model routing needs the conversation to record *why* a model id is set, which is a schema change, not a heuristic.

**The choice is surfaced, not silent.** The driver emits one `routing` stream event (`{ mode, effort, shape?, reason }`) before the provider is called; `processStreamEvent` folds it onto `agentRoutedTurn` in the agent slice, and `routedTurnLabel`/`routedTurnTitle` (`agentSessionControls.ts`) render it as a read-only chip plus tooltip. Display only — never persisted to conversation history, never fed back to a model, same posture as `context` and `reasoning`. A router that quietly spends less is indistinguishable from a model having a bad day, and the user cannot pin a value back if they never saw it move.

**Attachments — images AND files route to the CLI by staged file path** (`claudeCliDriver`'s `visionInput` capability flipped to `true`). There is no confirmed `-p` mechanism for inline image bytes (`--input-format stream-json`'s stdin shape remains unverified, per WS-11's own finding), so `claudeCliAttachments.ts` writes each attachment to a fresh, turn-scoped temp directory and appends its absolute path to the prompt text — the CLI's own built-in `Read` tool does the actual reading. With no project open, `Read` is the only native built-in the session's `--tools` allowlist grants, and only on a turn that actually staged something here (see "Native tool surface" above). The staging directory is torn down unconditionally in the driver's own `finally` block, alongside MCP connector revocation.

**File attachments deliberately reuse the existing `kind: 'image'` content block — no new `AiContentBlock` kind.** `AiImageBlockSchema.mimeType` was already an unconstrained string, so a text-ish mime type fits the wire shape without a schema change any other driver/persistence consumer would need to know about; `claudeCliAttachments.ts` alone decides, by mime type, whether a block is an image, a text-ish file, or refused outright. Files are gated by an explicit allow-list (plain text, markdown, JSON, CSV, CSS/HTML/XML, common source types — `text/javascript`, `text/typescript`, `text/x-python`, `text/yaml`) and a 256 KiB decoded-byte size cap; anything outside the allow-list or over the cap is refused, never staged. A refusal isn't silent: it's appended to the prompt text (`describeAttachmentsForPrompt`) so the model can tell the user rather than the file just vanishing. **The composer's own picker UI still only offers images** — a person cannot yet pick a non-image file to attach from the panel. The pipeline that would carry one (staging, allow-list, size cap, containment, refusal) is complete and tested; wiring a file-picker into `AgentComposer.tsx` is a separate, smaller follow-up.

**Permission prompts land in the chat, not in a terminal.** The CLI runs headless (`-p`), so when one of its own built-in tools needs approval there is no TTY to prompt in — it just refuses, which surfaced to users as an unanswerable dead end ("Claude requested permissions to read from …, but you haven't granted it yet"). `--permission-prompt-tool` is the CLI's own mechanism for this: rather than prompting, it *calls* an MCP tool and obeys the result. Studio points it at `mcp__studio__permission_request` on the per-turn MCP server it already mints, and the request round-trips through machinery that already existed — `bridge.callBrowser` emits an ordinary `toolRequest` down the open chat stream, `streamEvents.ts` intercepts it before the tool dispatcher, `AgentPermissionCard.tsx` renders Allow / Deny, and the click POSTs back to `/tool-result` like any other tool.

Three things about it are load-bearing:

1. **It fails closed.** Every path that is not the user clicking Allow — no gate, no browser, a timeout, a malformed answer, a thrown bridge, a stopped turn — returns `{"behavior":"deny"}` (`permissionGate.ts`, `abandonPermissionPrompts`). A gate that failed open would grant silently at exactly the moment something had gone wrong.
2. **It is invisible to external MCP clients.** The tool is added to `tools/list` *only* for a connector with a live gate, and only the `claudeCli` driver ever registers one (for the duration of one turn, released in its `finally`). Listing it is mandatory — the CLI resolves `--permission-prompt-tool` against `tools/list` at startup and aborts with "not found. Available MCP tools: …" otherwise — so scoping by gate presence is what keeps it off every other connector's tool list.
3. **Attachments never reach it.** Staged attachments live in an `os.tmpdir()` directory outside the workspace cwd, so the CLI would otherwise stop to ask permission to read a file *the user just attached in that same turn*. The driver passes `--add-dir <staging dir>` — exactly the directory Studio created, nothing wider, torn down with the turn.

Verified against CLI 2.1.114, whose `--help` does **not** list `--permission-prompt-tool` (unknown flags do error, which is how its existence was confirmed): `allow` lets the tool run, `deny` blocks it and records the attempt in the result's `permission_denials`.

**Project-declared MCP servers reach the agent only by explicit approval.** Studio passes `--strict-mcp-config`, which makes the CLI ignore every MCP config on the machine except the one Studio generates. That flag stays — without it the CLI merges `~/.claude.json` and the project's `.mcp.json` and connects to whatever it finds (WS-11 §4.0 trap #4), and it also, measured, shields the turn from a third-party server whose invalid tool schema fails the whole request with `400 input_schema does not support oneOf/allOf/anyOf`.

But strictness had a cost worth naming, because it explains two user-visible defects at once. Projects ship MCP servers precisely because their knowledge is too large to read: the Almosafer design system bundles one whose README says it exists so Claude can "call `list_components` then pull only the components it needs, instead of ingesting all 37 up front". Unreachable, the agent fell back to reading that package's 103 KB `CLAUDE.md`, blew the 25k-token read limit **five times in a single turn**, and shipped a screen that used 2 of the 42 available components and hand-rolled a nav, a divider and three card rows that all already existed.

So `server/ai/drivers/projectMcpServers.ts` merges a project's own servers into the generated config — but only those named in `.studio/meta.json`'s `approvedMcpServers`. The security shape is the point:

- **Nothing is approved by default.** A `.mcp.json` entry is a command line; `{"command":"node","args":["evil.js"]}` in a cloned repo would otherwise be arbitrary code execution the moment the project is opened. Cloning a repo is never consent.
- **Approval lives in `.studio/meta.json`, not `.mcp.json`** — otherwise a project could approve itself.
- **Approval names one server**, so adding an entry to `.mcp.json` later does not inherit consent already granted for another.
- **`studio` is a reserved name.** A project entry using it is dropped, and the driver spreads project servers *before* Studio's own, so even a gap in that check cannot redirect Studio's tool calls away from the connector-authenticated endpoint.

This is also the supported route for a project's Figma MCP server. Approval is a human action in **Settings → AI → MCP Servers** (`McpServersSection.tsx`), which lists every project-declared and Studio-registered server with its `summary` (command line or URL) and an Approve/Revoke control — never a yes/no on a bare name. A server that needs a secret (a Figma personal access token, most concretely) uses the Studio-registered route instead (`registeredMcpServers.ts`) — see `mcp-connectors.md`'s "Project MCP servers" section for why a `.mcp.json` entry alone can't hold one safely.

**Studio ships that Figma entry, pointed at the REMOTE server.** `BUILT_IN_MCP_SERVERS` (`registeredMcpServers.ts`) declares `figma` as `https://mcp.figma.com/mcp` in every project. It used to be the desktop app's Dev Mode server on `http://127.0.0.1:3845/mcp`, which self-approved because loopback-with-no-secret is the one thing `isSelfApprovingBuiltIn` lets through — genuinely zero-config, and genuinely dependent on the user having the Figma desktop app open on the same machine as the Studio server, which is a bad bargain for a hosted Studio and a worse one for a headless turn.

**The remote server is OAuth-only.** `https://api.figma.com/.well-known/oauth-authorization-server` advertises a Dynamic Client Registration `registration_endpoint`, PKCE `S256`, `require_state_parameter`, and `bearer_methods_supported: ["header"]`, and [Figma's own docs](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) say you sign in through the OAuth flow. There is **no** personal-access-token path: a PAT in `X-Figma-Token` or in `Authorization: Bearer` gets the same 401 as sending nothing. (An earlier revision of this section claimed a PAT worked, reasoning from the endpoint's `Vary: X-Figma-Token` response header — that is Figma's generic API-gateway header, not an MCP auth path.)

**Studio ships a generic OAuth flow, and Figma is the case it cannot serve.** Studio does not need to *be* the MCP client to hold a credential: the `--mcp-config` file it already writes carries a `headers` object per http server, and `bearer_methods_supported: ["header"]` is how the resource expects to be called. So Studio owns a real browser OAuth flow — discovery, DCR, PKCE, both grants — and any remote MCP server with **open** dynamic client registration signs in from Settings in one click.

**Figma's registration is closed, and this is external.** Its docs state that *"only clients listed in the Figma MCP Catalog like VS Code, Cursor, or Claude Code can connect to the Figma MCP Server"*, with a waitlist for new clients. `POST https://api.figma.com/v1/oauth/mcp/register` answers a bare `403 Forbidden` — identical for a minimal body, an https redirect URI, a public-client registration, a browser user-agent, and an `Origin: https://www.figma.com`. It is refusing the caller, not validating the request, and no request Studio can construct changes that. (Its metadata still advertises `registration_endpoint`, which per RFC 7591 means "you may register here" — so discovery gives no warning; the 403 is the first signal.)

The Claude CLI **is** on that catalog, and Studio already spawns it against a per-user `CLAUDE_CONFIG_DIR`, so a one-time interactive sign-in performed against *that* directory is inherited by every later headless turn. When Studio's own flow is refused, the Settings row stops offering a button that cannot work and prints the exact commands instead (`cliSignInCommands`), with the real config-dir path:

```
CLAUDE_CONFIG_DIR="<studio config dir>" claude mcp add --transport http figma https://mcp.figma.com/mcp
CLAUDE_CONFIG_DIR="<studio config dir>" claude     # then /mcp, authenticate figma
```

Printed rather than launched: `claudeCliPlatformSupport()` disables terminal launching on macOS, and the interactive `/mcp` step needs a real TTY regardless — a command you can read and paste beats a button that works on one platform.

**The refusal is remembered, so it costs one doomed click ever, not one per session.** `registerOAuthClient` throws a typed `McpClientRegistrationClosedError` for a 401/403 from a registration endpoint; `POST /start` answers **403** (the provider forbade Studio — the one status the panel can act on without reading message text) and records the server name in `.studio/meta.json`'s `mcpOAuthRegistrationClosed`. `GET /status` reports it back as `registrationClosed`, so the row opens straight into the CLI instructions instead of hiding them behind a sign-in attempt that cannot succeed. Copying one of those commands arms the same window-focus re-probe the browser flow arms — returning to the tab is the only observable end of a sign-in that happens in another process.

**This is verified.** After that sign-in, `mcp__figma__whoami` returns the signed-in account inside an ordinary Studio chat turn: `--strict-mcp-config` restricts which server DEFINITIONS the CLI loads, and does not isolate the stored credential for an endpoint Studio's own `--mcp-config` names.

**The sign-in alone was not enough, and this is the bug that made the whole route look broken.** The CLI keeps its own verdict cache at `<CLAUDE_CONFIG_DIR>/mcp-needs-auth-cache.json`, written when a server answers a turn unauthenticated — and a headless (`-p`) turn then trusts that file *instead of the server*. `claude mcp list` does not; it health-checks live. So the two disagree permanently, in the one direction that matters. Measured against one config dir and one endpoint, minutes apart, after a completed `/mcp` sign-in:

| asked | answer |
|---|---|
| `claude mcp list` | `figma: ✔ Connected` |
| a headless turn's `system/init` | `{"name":"figma","status":"needs-auth"}`, zero `mcp__figma__*` tools |

Deleting the `figma` key from that file — nothing else, no re-authentication — flipped the same headless turn to `connected` with the full tool surface. That is exactly the reported symptom: Settings says "Signed in via the Claude CLI" while every turn says `No such tool available: mcp__figma__…`. It is also self-perpetuating — one turn taken *before* the sign-in poisons the file, and no later turn ever re-checks — so the manual step Studio asks for silently bought the user nothing.

`clearCliNeedsAuthCache` (`cliMcpConnectionProbe.ts`) prunes it, name-scoped to servers there is positive evidence for, from two places: the Settings probe the moment it observes a live `connected`, and `claudeCli.ts` immediately before every spawn, for each server in the remembered sign-in list. It is a cache of a verdict — not a credential, not consent — in a directory Studio creates, owns, and deletes wholesale, and the worst case of a wrong prune is one extra connection attempt.

**And underneath that, `USER`.** Studio spawns every subprocess with an explicit minimal environment (`minimalSubprocessEnv`, `sec-01`) so a workspace's build script can never see `STUDIO_SECRET_KEY` or a provider key. `USER` was not on that allowlist — and the Claude CLI keys its stored credentials by the OS account name, so a child without it looks up a different account, finds nothing, and reports a signed-in server as `! Needs authentication`. Bisected against one config dir and one endpoint, needs-auth cache cleared before each run:

| environment | `claude mcp list` says |
|---|---|
| `env -i HOME PATH CLAUDE_CONFIG_DIR` | `! Needs authentication` |
| the same, plus `USER` | `✔ Connected` |
| the same, plus `LOGNAME` instead | `! Needs authentication` — it does not substitute |

`USER` (and the Windows spelling `USERNAME`) are now in `BASE_SUBPROCESS_ENV_KEYS`, which fixes the probe, the turn, and every other `claude` spawn in one place. It leaks nothing the allowlist was protecting: the child already runs *as* that user with `HOME` pointing at their home directory. `subprocessRunner.test.ts` pins it, because removing it to "tighten" the environment breaks the connector with no error message anywhere.

**Verified end to end**, from the poisoned state on a real machine, with Studio's exact spawn environment and flags: `system/init` reports `{"name":"figma","status":"connected"}` and **41** `mcp__figma__*` tools.

**`-s user` is load-bearing.** The CLI resolves servers, and their OAuth state, per working directory. Measured against one config dir and one endpoint, back to back:

| cwd | `claude mcp list` says |
|---|---|
| an empty temp directory | ✔ Connected |
| `studio-workspace/<project>` — where turns actually run | ✔ Connected |
| a directory holding a **local-scope** registration of the same URL | ! Needs authentication |

A credential meant to serve every project belongs at user scope, and it is the only scope the connection probe below can see.

**Setup is one human step, once.** Studio runs the registration half itself (`ensureCliMcpServerRegistered` — `claude mcp add -s user …` is non-interactive and idempotent, and writes a definition, never a credential), and a completed sign-in is treated as the approval: `recordBuiltInSignIn` approves a shipped built-in once the user has authenticated it. The justification is that without a sign-in the server is **inert** (Figma registers zero tools for an unauthenticated client, so an unapproved built-in and an unauthenticated one are the same thing), and with one the user has already consented *to Figma, in Figma's own OAuth screen*. Four guards keep the blast radius to exactly that: never without a sign-in, never for a non-built-in, never over a project's own entry of the same name, never over an explicit opt-out. The observation is remembered in Studio's per-user CLI data dir (server names only) so a project created later works on its first turn rather than after someone opens Settings — and it is **one-way**, because a failed or offline probe must never read as "signed out" and revoke a working connector.

**The badge reads the CLI, because Studio's own store cannot answer.** `handleStatus` derives `connected` from `mcpOAuthStore` — written only by Studio's own OAuth callback. The CLI keeps its MCP credential in the OS keychain, so after a CLI sign-in that badge was **structurally incapable of flipping**: it read "Not signed in" and offered a button that cannot work, next to Figma tools that were live in every turn. `server/ai/credentials/cliMcpConnectionProbe.ts` asks `claude mcp list` instead, and `GET /admin/api/ai/mcp/oauth/cli-status` surfaces a third state, "Signed in via the Claude CLI".

Two properties of that probe matter more than the parsing:

- **It runs in a fresh empty directory.** `claude mcp list` health-checks approved `.mcp.json` stdio servers, and Studio's whole outbound-MCP posture is that a project-declared command runs only after a human approves it *in Studio*. Probing inside a user's project would execute commands from their repo to render a badge, on a consent record Studio does not own. An empty directory also happens to give the same answer as the project directory, so nothing is lost.
- **It never touches the turn path.** The call is a live health check, measured at **~10 seconds**. Results are cached per config dir for 60 s; the live probe is only reachable from an explicit HTTP request, and the per-turn digest uses a cache-only read that never spawns. A cold cache leaves the digest saying "Studio holds no sign-in of its own" — true regardless — rather than buying certainty with ten seconds of latency.

| Module | Responsibility |
|---|---|
| `server/ai/credentials/mcpOAuth.ts` | Protocol only: RFC 9728/8414 discovery, DCR, PKCE S256, the authorize URL (with the RFC 8707 `resource` indicator), and both token grants. No state, no users, no projects. Every external response is TypeBox-validated, and a 401/403 from a registration endpoint is reported as a closed allow-list rather than as a status code. |
| `server/ai/credentials/mcpOAuthStore.ts` | The session, encrypted at rest as one reserved field (`__studio_oauth__`) in `mcpServerSecretStore` — same master key, same `keyFingerprint` rotation detection, same on-disk protection (`ensurePrivateDirectory` + an exclusive-create-plus-rename write through `privateTempDir.ts` — real on Windows since `sec-18`, where the old 0600/0700 was decorative), and removing a server already deletes it. `resolveMcpOAuthHeader` refreshes **on read**, ahead of the deadline by a 60 s skew. |
| `server/ai/mcp/handlers/oauth.ts` | `POST /start` → authorize URL; `GET /callback` → code exchange + store, rendering an HTML page (a human is looking at it); `GET /status` (also returns the CLI config dir for the fallback); `DELETE` to sign out. The PKCE verifier lives in a TTL-bounded in-memory map — a restart invalidates in-flight sign-ins, which needs no cleanup path and is the correct outcome. |
| `registeredMcpServers.ts` → `resolveOneDefinition` | Turns a live session into the `Authorization` header. An explicitly-configured header always wins. |

This replaced the old "Check for sign-in link" probe (`authProbe.ts`, deleted). That probe surfaced a bare `authorization_endpoint` for the user to open by hand, which is precisely the URL that answers *"Parameter client_id is required"* — it could not have worked, and keeping it alongside a flow that does would be two ways of doing one thing.

Shipping the entry therefore buys **visibility, not trust**: it fails `isSelfApprovingBuiltIn` on the host check (non-loopback), so it is listed in Settings unapproved and a human still turns it on. The consent boundary is unmoved — the only saving is that they no longer type the URL themselves.

Two consequences worth knowing. `StudioCapabilityDigest.figma.status` gained **`'needs-auth'`** (approved, but nobody has signed in — so it registers zero tools) and **`'needs-approval'`** as states distinct from `'not-configured'`: "no Figma tools this turn" is now the DEFAULT for a fresh project rather than a sign the user never wanted one, and collapsing the two would tell the agent to give up when the real answer is a human action away — the prompt now says which. And the loopback asset-fetch exception in `remoteAssetFetch.ts` stops applying: the desktop server handed out `http://localhost:3845/assets/…` URLs that the SSRF guard refused unless `STUDIO_ALLOW_LOOPBACK_ASSET_FETCH` was set, while the remote server hands out ordinary `figma.com` URLs that fetch normally. Anyone who wants the desktop server back registers `figma` themselves at the loopback URL — a project's own entry of that name wins over the built-in.

**The reasoning/thinking block (§5.4) is implemented defensively and is UNVERIFIED against a real CLI turn.** `claudeCliEvents.ts`'s translator watches for `type: "stream_event"` lines wrapping a `content_block_delta` whose `delta.type === "thinking_delta"`, emitting a `reasoning` `AiStreamEvent` with the accumulated `delta.thinking` text. This shape is written against the DOCUMENTED Anthropic Messages streaming vocabulary, not observed on the wire — no paid turn was spent confirming it, matching WS-11's own test-discipline rule (tests never spawn the real binary). `--include-partial-messages` was added to `claudeCli.ts`'s argv (required for the CLI to emit `stream_event` lines at all); every event shape this translator doesn't recognise already falls through to a no-op default case, so if the real shape differs, nothing breaks and no reasoning block ever renders — the failure mode is silence, not a broken stream. On the browser side, a `reasoning` block renders as its own collapsed `<details>` row (`ReasoningRow.tsx`, next to `ToolCallRow.tsx`), chronologically ordered against `text`/`toolCall` blocks the same way tool calls already are; it is display-only and never persisted to conversation history (same posture as `context`). **The next person who touches this should run one real turn against the CLI with a prompt likely to trigger extended thinking and confirm whether a `reasoning` block actually renders** — that observation still hasn't been made.

### A turn you can undo — checkpoints and revert (AI-7)

Every agent turn that writes takes a **pre-image checkpoint**, and the panel shows "Changed N files" under the turn with a per-file diff, **Revert turn** and a per-file **Revert**.

- **Store** — `server/handlers/studio/agentCheckpoints.ts`, on disk at `.studio/agent-checkpoints/<userKey>/<turnId>/` (per account, like the turn write log; `<turnId>` is the persisted id of the user message that opened the turn). Not under `.studio/cache/`: a pre-image is the only copy of what the file was. `.studio/` is excluded from Studio's commit staging (`gitOperations.ts`) and from every scaffolded `.gitignore`; this repo's `.gitignore` names `**/.studio/agent-checkpoints/` for its fixtures. The newest 50 turns per account are kept; a file over 4 MB is listed but not revertable.
- **Capture, both paths.** A turn is opened (`beginAgentCheckpointTurn`) where the turn write log is reset — `claudeCli.ts` before its spawn, `studioHttpTurn.ts` for an HTTP driver. Before a write, `captureAgentPreImage` copies what the file held (the FIRST capture of a path in a turn wins); after it, `recordAgentPostImage` copies what the agent left (the LAST wins). On the CLI the `PreToolUse` hook (`hooks/denyControlPlaneWrite.ts`, right after the write gate allows the call) and the `PostToolUse` hook (`hooks/recordToolWrite.ts`) do it; a warm CLI process outlives its turn, so the hooks find the turn through `STUDIO_AGENT_CONVERSATION_KEY` (set at spawn; the warm pool is per conversation) and the conversation's `current-<key>.json`. On the HTTP path the file tools bracket each write inside the project write lock (`agentWriteSupport.ts`: `checkpointBeforeWrite` / `afterWrites`; `landAgentAsset` records a landed image as created). Capture is fail-soft: a checkpoint that cannot be taken leaves the file "not revertable", never blocks the write.
- **Revert is compare-and-swap.** `revertAgentCheckpoint` restores a file only while it still holds exactly the agent's post-image; a file changed since (on the canvas, in an editor, by a later turn) is refused by name with `changed-since` and left alone. **Revert turn is all-or-nothing**; the per-file reverts that still apply stay available. A created file is deleted. Every restore goes through the one agent write gate (`resolveAgentFilePath(…, 'write')` → `agentWriteRefusal`), holds `withProjectWriteLock`, refuses a hard link, and pushes a live reload — so a revert can land nowhere an agent write could not (outside the project, `.studio/`, `.claude/`, `.git/`, `prototype/`, a host-executed config, through a link). A record naming such a path is refused even though it is on disk (tests forge them).
- **The store trusts none of its own files** (review of #251). Every store directory from `.studio/` down must be a real directory (no symlink or junction); store files are read no-follow, single-link and size-capped (64 KB records); a stored image counts only when it hashes to its record; a turn is bound to its conversation (a revert or diff naming another is `not-found`); the file is re-hashed right before each revert write; store files are written via temp-and-rename. Credential files are refused by the one write gate on both paths (`agentWriteRefusal`) and are never copied into a checkpoint (listed, not revertable, diff `withheld`). Line counts are stored with the post-image, so a list never re-diffs.
- **Routes** (`server/ai/handlers/agentCheckpoints.ts`): `GET /admin/api/ai/agent-checkpoints?dir=&conversationId=` (`ai.chat`, own conversation), `GET …/diff?dir=&conversationId=&turnId=&path=` (a unified diff the git panel's `GitDiffView` renders; `agentCheckpointDiff.ts`), `POST …/revert { dir, conversationId, turnId, paths? }` (`ai.chat` + `studio.write`; 409 while the conversation still has a turn streaming). A refusal returns `{ error, code, files }` and the card shows it as a quiet note — never a red toast.
- **Wire.** The chat handler emits `{ type: 'turn', turnId }` right after `bridgeReady`; the panel stamps it on the user message (`AgentMessage.turnId`; a rehydrated user message's own id is it) and refreshes `agentTurnChanges` when the turn ends and on conversation load (`agent/agentTurnChanges.ts`).

### The panel (AI-28, AI-22, AI-26)

- **Docked, full height** is `AgentPanel`'s default variant; `floating` stays for a host that wants the overlay.
- **Selection chip** (`AgentContextBar`) above the composer says what the agent will be told about — "Button · Checkout.tsx:42 +2", from `decodeSourceNodeId` — and its × keeps THAT selection out of the next message (`dismissAgentSelection`; `buildStudioAgentSnapshot` then sends an empty selection). **Suggestion chips** (`AgentSuggestionChips`, `agentContext.ts`) replace the empty state's one canned sentence with prompts built from the selection, the page on screen and the open review comments.
- **Recovered failures render muted.** `toolCallRecoveries` (`turnPresentation.ts`): a failed call followed by a success of the same tool is "Adjusted"; a failure in a turn still running is "Adjusting"; only a failure the turn ENDED on is red.
- **Variant thumbnails.** A turn that called `studio_plan_variants` gets a card with one tile per planned page, each the newest screenshot of that page in the turn (`variantTiles`; a variant never captured says so). Server-run tools' images now reach the panel on the `toolResult` event (`previewImages`, `runtime/toolPreviewImages.ts`: PNG/JPEG/WebP/GIF only, at most 4, each under ~1.8 MB; session-only).
- **Argument progress** (AI-26). Every driver turns a streaming tool call's argument fragments into `{ type: 'toolInputProgress', toolCallId, toolName, bytes, target? }` (`drivers/toolInputProgress.ts`, one per KB plus one when the target file is known): Anthropic `input_json_delta`, OpenAI-compatible `tool_calls[].function.arguments`, and the CLI's `stream_event` partials. The activity headline reads "Writing Checkout.tsx · 3.2 KB".
- **Plan mode as a checklist** (AI-22). The CLI's `ExitPlanMode` prompt and the HTTP agent's `studio_propose_plan` both render as a plan card: every step ticked → **Approve plan**; unticking steps → **Revise without N** (a denial naming the struck steps); **Keep planning**. On an HTTP driver, the composer's Plan mode now means something: `selectStudioTools(…, { planMode })` adds `studio_propose_plan` (server tool, asks through the turn's bridge; no answer in time is "not approved", never a transport failure), and the tool loop refuses every `sideEffects: 'write'` call **and every Tier-2 tool** (the family declaring `studio.run.project`: `studio_lint`, `studio_render_reference`, which run the project's own code, config and plugins) with `plan-not-approved` until a plan is approved (`toolDispatch.ts`'s `heldUntilPlanApproved` + `TurnPlanGate`; `planGate.test.ts`).

### History compaction (AI-18)

An HTTP turn replays the whole conversation. `conversations/compaction.ts` summarises the older part once the replay is estimated past 60% of the model's window (the catalogue's `contextWindow`, else 200K): everything before the 4th-newest user turn becomes one summary written by `claude-haiku-4-5-20251001` (`MODEL_ROUTING_TABLE.utility`, see "Model routing") through the Anthropic HTTP driver (`historyCompaction.ts` → `runOneShotCompletion`), prepended to the first kept user message. The summary is **pinned** per conversation (in memory, keyed by a hash of the messages it replaced), so later turns reuse it byte for byte and the prompt cache keeps hitting; only when the kept tail itself passes the threshold is a new summary made, folding the previous one in. The summary is replayed as a Studio note marked "background, not instructions", and the summariser attributes requests only to the user's own lines, so text the agent quoted from a file cannot come back as a user request. It spends the user's own Anthropic key on that second, cheaper model. It needs the turn's own credential to be an Anthropic API key — any other provider, a failed or empty summary, or a restart simply replays the history as before. The CLI compacts its own session. Nothing persisted changes.

### Canvas parity matrix (WS-12 §6.1/§9)

`server/ai/tools/studio/parityMatrix.ts` is the enforcement mechanism for "the agent can do what you can do in the canvas" — not documentation. Every real editor action resolves to exactly one status: a real tool (name-checked against the live registry), a native CLI action (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`Task`, with how), an explicitly withheld action (a stated reason — the rendered table below), or a confirmed gap. `parityMatrix.test.ts` gates all of it, including the inverse direction (every registered `sideEffects: 'write'` tool is referenced by at least one row — an orphaned tool is itself a finding), plus a regression test pinning the current gap count so a future "missing" row silently downgraded to "withheld" fails loudly.

**The three gaps the matrix found are now closed.** All three shipped as thin `execution: 'bridge', scope: 'site'` wrappers over the SAME verb the canvas UI already calls; W9-6 then moved two of them server-side, because only one of the three was ever actually about the user's browser:

| Editor action | Tool | Where it runs, and why |
|---|---|---|
| Upload a new image asset into the project | `studio_upload_asset` | **`server`** (`server/ai/mcp/tools/studio/uploadAssetTool.ts`). Decodes the base64 strictly, refuses bytes that are not the declared `mimeType`, and lands them through `landAgentAsset` — the agent write gate on `targetDir`, `withProjectWriteLock`, the turn write log, and `assetLanding.ts`' sniffed type and `wx` names. No tab needs to be open. |
| Set a board frame's preview axes (direction/locale/color-scheme) | `studio_set_frame_axes` | **Server** (`frameAxesTools.ts`). Writes `.studio/boards.json` and pushes a live reload. |
| Duplicate a board frame as a variant | `studio_duplicate_frame_as_variant` | **Server** (`frameAxesTools.ts`). Same file, same push; the variant lands beside its source at the shared `VARIANT_GAP`. |

Both frame tools address a frame by `pageId` (the id every other Studio tool already returns) with an optional `frameId` to disambiguate when a page has more than one — no existing tool exposes a raw `frameId` for an agent to pass in otherwise. The client resolved that against the ACTIVE board; the server has no such notion, so the rule is the first board carrying a frame for that page, else the first board — the same fallback `autoPlaceBoardFrame` documents, and the same answer in every single-board project.

**W9-6 also added a fourth row**, `studio_measure_element` — the canvas's own ruler, and the missing third leg beside `studio_compare` (which rectangle is wrong) and `studio_measure_reference` (what the design says): the rendered geometry of the screen's own elements. See its section above.

The matrix now has **zero `missing` rows** — every editor action a Studio project agent needs is a real tool, a native CLI action, or explicitly, permanently withheld with a stated reason. The withheld rows, rendered from `parityMatrix.ts` and gated against it by `agent-doc-tool-surface-parity.test.ts`:

<!-- parity-withheld:start -->

| Withheld action | Why |
|---|---|
| Promote a project's trust tier | A consent action — the agent may ask the user to promote a project; it may never perform the promotion itself (D5 §11.2, enforced server-side in studio_install_deps's own trust check, which has no tool path to raise the tier). |
| Undo / redo | The user's own safety net over the agent's own writes stays the user's — an agent that can undo the user's manual edits (or redo its own after the user undid them) defeats the point of the control existing. |
| Pan / zoom / marquee-select the canvas viewport | Viewport position is not document state — nothing for a tool to change that would mean anything once the turn ends. |
| Delete a project | studio-workspace/* is the user's real project data with no other copy (trap #12) — no tool the agent holds may reach a delete-the-project path, full stop. |
| Run a raw shell command | No Bash, at any trust tier, in any permission mode — the one tool whose blast radius is not bounded by the project cwd. Dependency installs go through studio_install_deps, which IS trust-tier gated. |
| Reach a file outside the open project | The subprocess cwd is the containment-checked project directory, and the CLI refuses a write outside it plus --add-dir (this turn's attachment staging, nothing else). |

<!-- parity-withheld:end -->

Delegating to a subagent is NOT in that list: `Task` is granted on the CLI path with a project open, `subagent_type: 'general-purpose'` only (see "`Task` is granted, and screens are built in parallel" above). Its row is `native`. It said `withheld` for a wave after `Task` came back, which is the drift AI-24 closed.

`studio_import_figma_frame` has its own row — *arm a screen against a supplied design*. The user's version of that action is two gestures: attach the design through the reference-upload panel (`uploadDesignReference.ts` → `POST /admin/api/studio/reference-upload`), then drag the board frame to the design's own size so the comparison is exact rather than resampled. The tool exists because the ORDER was what a weaker model got wrong, not any single leg — see its own section above.

#### Headless-only tools

The gate runs the matrix backwards too: every registered `sideEffects: 'write'` tool must be named by some row. A tool that genuinely has no canvas counterpart declares **`headlessOnly`** on its own `AiTool` definition — a sentence saying why — and the gate reads that field. There is deliberately no allowlist inside `parityMatrix.test.ts`: a name on a list in a test file is a gate switched off, while a sentence on the tool is a claim the next reader can check. Declaring `headlessOnly` **and** appearing in a parity row fails the gate, because one of the two statements is then untrue.

<!-- headless-only-tools:start -->

| Tool | Why there is no canvas action to be parity with |
|---|---|
| `studio_plan_variants` | Nothing in the editor plans variants. Its only artefact is `.studio/variants.json`, which no panel reads, renders or can create — it exists so a LATER turn can edit variant B's recorded density instead of re-rolling the set. The editor's equivalent of "try three directions" is the user writing three screens by hand, which produces no seed record at all. |
| `studio_find_image` | The editor has no stock search: a user brings an image by dropping or picking a file they already have (asset-drop, the image picker). This is how the agent gets one it was not handed; what it writes is an ordinary image file plus a line in `IMAGE-CREDITS.md`, both of which the user sees and edits like any other file. |

<!-- headless-only-tools:end -->

---

## Flow

```text
User types text and/or pastes images → Agent Panel
    │
    ▼
agentSlice.sendAgentMessage(contentBlocks)
    │
    ├─→ buildSnapshot()  →  SiteAgentSnapshot
    ├─→ ensure conversation row  (lazily created from the AI default on first call)
    ├─→ POST /admin/api/ai/chat  { conversationId, content, snapshot }
    │
    ▼
Server: chat.ts
    │
    ├─→ CSRF + requireCapability('ai.chat')
    ├─→ load conversation row  (credentialId, modelId) + full message history
    ├─→ decrypt credential; resolveDriver(credential.providerId)
    ├─→ preflight text/image blocks + encoded bytes; enforce the per-message bound
    ├─→ resolve/cache the selected model's capabilities (also gates tool screenshots)
    ├─→ acquire the conversation's single-writer stream lease
    ├─→ fully decode/canonicalise images sequentially (request-cancellable)
    ├─→ project persisted images for the selected model
    ├─→ selectStudioTools(capabilities)
    │     — write tools excluded unless caller has ai.tools.write
    ├─→ build the Studio system prompt  →  [staticPrefix, BOUNDARY, dynamicSuffix]
    ├─→ createBridge(emit)  →  { bridgeId, bridge, destroy }
    ├─→ emit { type: 'bridgeReady', bridgeId }
    └─→ runChat({ driver, request, persister, emit })  — streaming begins
          │  request carries the conversation history as req.messages; user
          │  images use the provider replay policy described below.
          │  Direct HTTP drivers have no server-side session — every turn
          │  replays the whole log, mapped into the provider's message array.
          │
          ├─→ catalog read tool (e.g. site_list_documents)
          │     → resolved server-side from snapshot; result returned to model
          │
          ├─→ browser-backed read/open tool (e.g. site_read_document / site_open_document)
          │     → bridge.callBrowser(toolName, input)
          │     → browser reads or opens the target page/template/visual component
          │     → result returned to model
          │
          └─→ browser-bridged mutating tool (e.g. site_insert_html)
                → bridge.callBrowser(toolName, input)
                → emit { type: 'toolRequest', requestId, toolName, input }
                → driver loop pauses; awaits tool-result POST

NDJSON stream events (one JSON object + \n per line):
    { type: 'bridgeReady', bridgeId }
    { type: 'text', text: '…' }
    { type: 'toolCall', toolCallId, toolName, input, status: 'pending' }
    { type: 'toolRequest', requestId, toolName, input }    ← browser-bridged tools only
    { type: 'toolResult', toolCallId, toolName, ok, error? }
    { type: 'usage', promptTokens, completionTokens, costUsd, cacheReadTokens?, cacheCreationTokens? }
    { type: 'context', contextTokens }                     ← per-round meter update
    { type: 'done' }
    { type: 'error', message }                             ← on server error

Browser: processStreamEvent(event) in streamEvents.ts
    │
    ├─→ 'bridgeReady'   → store bridgeId in closure
    ├─→ 'toolRequest'   → executeAgentTool(toolName, input)  (executor.ts)
    │       – TypeBox-validates input
    │       – e.g. runInsertHtml (htmlTools.ts) → importHtml(html) → insertImportedNodes(parentId, …)
    │       → POST /admin/api/ai/tool-result { bridgeId, requestId, result }
    │       → server resolves pending waiter → driver sees tool_result → continues
    └─→ 'text' / 'toolCall' / 'toolResult' / 'done'  → update agentSlice.agentMessages
```

The two-endpoint design keeps the **browser as editor-store authority** (browser-bridged tools read or mutate the live Zustand store in the browser) while the **server runs the model** (driver + tool routing live server-side).

---

## The page snapshot

Before each `sendAgentMessage` call, `buildCurrentPageContext(get)` (in `pageContext.ts`) builds a `SiteAgentSnapshot` from the live editor store. `pageContext.ts` reads the active page, current editor document (`page`, `template`, or `visualComponent`), and the two editor-only scalars (`selectedNodeId`, `activeBreakpointId`) off the store and calls `buildSiteAgentSnapshot(activePage, state.site, opts)` (in `siteAgentSnapshot.ts`). The result is the raw authoritative tree — no pre-flattening.

```ts
// SiteAgentSnapshot = Static<typeof SiteAgentSnapshotSchema>
type SiteAgentSnapshot = {
  page: Page           // active page with full nodes map
  currentDocument: AgentDocumentRef
  site: SiteDocument   // breakpoints, styleRules, settings intact; non-active pages emptied
  selectedNodeId: string | null
  activeBreakpointId: string
}
```

Only the active page carries full `nodes`. Non-active pages keep metadata (`id`, `title`, `slug`, `template`) with empty `nodes`, bounding the per-turn payload on multi-page sites. Server-side catalog tools read `site.settings`, document metadata, and the server module registry from this snapshot. Full annotated document reads are browser-backed (`site_read_document`) so the agent can inspect any page, template, or visual component from the live store without shipping every tree in every turn.

**Server-side validation.** The chat handler validates the incoming snapshot against `SiteAgentSnapshotSchema` via `safeParseValue` (a soft boundary). A malformed or absent snapshot falls back silently to an empty placeholder — the stream continues with `Untitled` page context rather than crashing. `SiteAgentSnapshotSchema` lives in `src/admin/pages/site/agent/siteAgentSnapshot.ts` and is the source of truth for the type; there is no parallel `interface SiteAgentSnapshot`.

**Mid-turn refresh.** The snapshot is rebuilt once per `sendAgentMessage`, but a single turn runs many tool calls, and browser tools mutate the live store *during* the turn. To keep server-side catalog tools (`site_list_documents`, `site_list_tokens`, …) from seeing stale turn-start state, the browser re-captures `buildSnapshot()` after **every** browser tool and posts it with the tool result (`postToolResult(..., snapshot)`). The server threads it through `resolveBridgeToolResult(..., snapshot)` → the bridge's `onSnapshot` → `toolContextBase.snapshot` (a mutable per-turn field). Because `executeAiTool` re-reads `toolContextBase` for each call, the next catalog tool sees the state the previous browser tool produced. Without this, a catalog read after a write (e.g. `site_list_documents` right after `site_add_page`) returned the document set from the start of the turn.

---

## Server endpoints

### `POST /admin/api/ai/chat`

Studio has exactly one agent (WS-12 §8.1 D3) — there is no `:scope` route
segment. `ai_conversations.scope` still exists as a column (an inline `CHECK`
from migration `007_ai_runtime` pins it, and SQLite cannot alter a `CHECK`),
but it is vestigial: the single write site pins it to a permitted constant
(`LEGACY_SCOPE_COLUMN` in `server/ai/legacyScope.ts`) and nothing reads it back.

```ts
// Request body
{
  conversationId: string   // ai_conversations row id
  prompt:         string
  snapshot:       unknown   // SiteAgentSnapshot
}

// Response: NDJSON stream of ServerStreamEvent (one JSON line + '\n' each)
```

The handler (`server/ai/handlers/chat.ts`):
1. CSRF-checks and requires `ai.chat`.
2. Loads the conversation row (credentialId, modelId) and the full persisted message history (`listMessagesForConversation` → `buildMessageHistory` → `AiMessage[]`).
3. Decrypts the credential and resolves the driver.
4. Calls `selectStudioTools(capabilities)` — write tools excluded without `ai.tools.write`.
5. Builds the Studio system prompt (`buildSiteSystemPrompt(snapshot)`, re-exported as `buildStudioSystemPrompt`).
6. Creates a bridge (`createBridge(emit, req.signal)`), emits `bridgeReady`.
7. Calls `runChat(...)` with the full history as `req.messages`. Direct HTTP drivers have no server-side session, so each driver maps the whole `AiMessage[]` log into the provider's native message array every turn (the Anthropic driver pairs assistant `tool_use` blocks with their following `tool_result` turns). The runner pipes all stream events to the HTTP response. Before recording a terminal usage event, the runner flushes any pending assistant text so text-only replies have an assistant message row for per-turn usage and audit rollups. The multi-turn agentic loop lives in `drivers/http/toolLoop.ts`, not in a provider SDK.
8. Emits a terminal `ai.chat.completed` / `ai.chat.failed` audit event.

### `GET /admin/api/ai/audit?since=ISO&tz=IANA`

Returns the rollups consumed by the Settings → AI Audit tab and the dashboard "AI usage this month" widget. Gated by `ai.audit.read`. There is no per-scope breakdown — Studio has exactly one agent, so a "by surface" rollup would always be a single row identical to `totals`.

```ts
// Query params
since?: string   // ISO 8601 start of window; defaults to 30 days ago
tz?:    string   // IANA timezone (e.g. "Europe/Bratislava"); defaults to UTC

// Response
{
  since:   string           // resolved ISO start instant
  totals:  UsageRow         // aggregate totals across the window
  byUser:  UsageByUserRow[] // one row per user_id, sorted by cost desc
  byModel: UsageByModelRow[]// one row per (provider, model) pair
  byDay:   UsageByDayRow[]  // one row per calendar day in the viewer's timezone
}
```

`byDay` is the time-series chart data — each `day` field is `YYYY-MM-DD` in the viewer's local timezone (not UTC). The daily rollup pulls raw message rows and bins them in JS via `localDayKeyFactory(timeZone)` (`server/time.ts`) rather than SQL date-truncation, because the day boundary depends on the viewer's timezone which the database doesn't know. The client (see `AuditTab.tsx` → `listAiAudit`) reads `Intl.DateTimeFormat().resolvedOptions().timeZone` and passes it as `?tz=`.

The Audit tab (`src/admin/modals/Settings/sections/ai/AuditTab.tsx`) consumes this endpoint. The daily rollup there also aligns its "Today" range window to local midnight (`setHours(0, 0, 0, 0)`) so the day boundary is consistent both in the filter and in the bar chart. The by-model and by-user rollups render through `UsageTablePanel` (`sections/ai/UsageTablePanel.tsx`) — a shared table component that takes a `columns` config and handles the empty-state row. Number and cost formatting (`formatNumber`, `formatCost`) live in `src/admin/ai/usageFormat.ts`, a plain shared leaf used by both Audit and the composer context tooltip.

### `POST /admin/api/ai/tool-result`

```ts
// Request body
{
  bridgeId:  string
  requestId: string
  result:    AiToolOutput   // { ok: boolean; data?: unknown; error?: string; images?: { mimeType, data }[] } — from src/core/ai/
  snapshot?: unknown        // optional post-mutation live editor snapshot (see "Mid-turn refresh")
}
```

Requires `ai.tools.write`. Calls `resolveBridgeToolResult(bridgeId, requestId, result, snapshot)` which (when a snapshot is present) refreshes `toolContextBase.snapshot` via the bridge's `onSnapshot`, then resolves the pending tool waiter inside the driver loop so streaming continues. If the bridge is gone (stream already closed), returns 404 and the result is silently dropped.

`AiToolOutput` is the canonical result type shared by both sides of the bridge. Constructors: `aiToolOk(data?, images?)` and `aiToolError(message)` from `@core/ai`. The optional `images` channel carries base64 attachments (e.g. a `site_render_snapshot` PNG) that drivers forward as native image blocks or drop with a note — see "Heavy evidence" below.

---

## Tools

### Site catalog read tools — 6, server-side

Resolved server-side from the posted `SiteAgentSnapshot` or the data repositories via `ctx.db`. No browser round-trip. Results are returned directly to the model. Full annotated HTML reads are browser-backed because the live browser store owns every page/template/visual-component tree.

| Tool              | What it returns                                                         |
|-------------------|-------------------------------------------------------------------------|
| `site_list_documents`  | Editable document refs for pages, templates, and visual components. Each item includes `{ document: { type, id }, title, rootNodeId, active, current, summary, template? }`; pass those refs to `site_read_document` / `site_open_document` |
| `site_list_modules`    | Module registry (id, name, category, props schema, defaults); `category` filter |
| `site_list_breakpoints`| Configured breakpoints + active id                                      |
| `site_list_post_types` | Routable collections eligible as a `postTypes` template target — `{ slug, label, routeBase, kind }` per entry, filtered to a non-empty `routeBase`. Queries the data repositories via `ctx.db` |
| `site_list_loop_sources` | Loop source ids, source fields, order/filter options, and data-table field catalogs with valid `{currentEntry.field}` tokens. For post/custom table loops, use source id `data.rows`, the returned table `id` as `<studio-loop data-table-id>`, and the returned tokens inside the loop body |
| `site_list_tokens`     | Design tokens: colors (with shades/tints), typography/spacing scale steps, font tokens — each with CSS variable + utility classes; optional `family` filter (`colors`\|`typography`\|`spacing`\|`fonts`) |

### Site bridge tools — 29, relayed to the open workspace

All 29 tools carry `execution: 'bridge'` in their `AiTool` definition. The server emits `toolRequest`; the browser executor validates input with TypeBox, runs the store action or read helper, and POSTs the canonical `AiToolOutput` result back.

**Documents**

| Tool              | Input                                  | Success `data`                        | What it does                                           |
|-------------------|----------------------------------------|---------------------------------------|--------------------------------------------------------|
| `site_read_document`   | `{ document?: { type, id }, part? }`   | `{ document, title, html, css, pageInfo }` | Read a page/template/visual-component document as annotated HTML (`uid="<nodeId>"`) plus compact CSS without switching the visible canvas. Omit `document` to read the current editor document. Result is size-budgeted; call again with `part: pageInfo.nextPart` until `nextPart` is `null` |
| `site_open_document`   | `{ document: { type, id } }`           | `{ document }`                        | Visibly switch the editor to a page/template/visual component. Use before `site_render_snapshot` when the target is not current |

**Structure (HTML-native)**

| Tool              | Input                                  | Success `data`                        | What it does                                           |
|-------------------|----------------------------------------|---------------------------------------|--------------------------------------------------------|
| `site_insert_html`      | `{ parentId, index?, html }`           | `{ nodeIds }` or `{ cssRulesCreated, cssRulesUpdated }` | Parse HTML (+ any `<style>` CSS) → import as `PageNode`s under `parentId`. Custom `<studio-loop>` elements import as real Loop nodes; `<studio-outlet>` imports as a template outlet. A `<style>`-only payload (no elements) upserts CSS rules without inserting nodes (prefer `site_apply_css` for that) |
| `site_get_node_html`     | `{ nodeId }`                           | `{ html }`                            | Render subtree to HTML via the publisher's `renderNode`|
| `site_replace_node_html` | `{ nodeId, html }`                     | `{ nodeIds }` or `{ cssRulesCreated, cssRulesUpdated }` | Delete existing children; re-import HTML under the same parent. A `<style>`-only payload upserts CSS rules WITHOUT touching the children |

Styling rides on the `html` payload — there is no separate `classes` parameter. The executor runs `importHtml(html)`, which harvests any `<style>` block's CSS, then hands it to `cssToStyleRules`. That classifier routes each selector:

- a bare `.foo {}` rule → a reusable Selectors-panel **class**, bound to every `class="foo"` node in the fragment;
- any other selector (`.hero a`, `a:hover`, `nav > li`, `@media …`) → an **ambient** rule (media queries fold into the matching breakpoint's `contextStyles`);
- supported stylesheet-level rules such as `@keyframes` → ambient raw CSS rules emitted by the publisher;
- inline `style="…"` attributes → the node's inline styles.

`insertImportedNodes` then links every `class=` token on the imported nodes to its registry class id in the same undo step, so `class="hero-section"` renders and is styleable whether its styles came from a `<style>` rule or an automatically-created bare class. See [html-import.md → Class linking](html-import.md#class-linking-name--id).

**Both tools refuse outright on a studio-imported board (`mcp-21`, fixed in `store-13`).** On a project whose source of truth is a real React repository, importing HTML produced nodes carrying nanoid ids that no codemod can write back: the elements appeared on the canvas and the next parse deleted them, with nothing said. Reachable with no UI at all — an external MCP connector holding `ai.tools.write` calls both tools through the editor bridge.

There is no source write to route them to instead, and the reason is structural rather than a gap waiting to be closed:

1. The importer's rule table maps HTML onto ~15 base modules, and exactly two of them — `base.container` and `base.text` — can say what they are in a user's repo (`ModuleDefinition.sourceIntrinsic`). A link, a button, an image, every form control, `<studio-loop>` and `<studio-outlet>` have no JSX form Studio may write. Writing the part that can be written and dropping the rest is a half-applied patch.
2. The `<style>` block belongs in a stylesheet, not in the `.tsx`, so one call would have to land two writes in two files or leave the structure unstyled.
3. The tools' own answer — `nodeIds` / `created`, so the caller can address a nested node — cannot be produced by a source write: those ids are the `line:col`s the codemod emits and do not exist until the board has re-read the file, which is after the tool has returned.

The refusal names the path that does write real code: `studio_apply_edits`' `insert` edit, which writes JSX into the file and returns an addressable node id. `site_replace_node_html` asks BEFORE deleting the target's children (`refuseImportedNodesInto`), so a refused replace never leaves the node empty.

**Authoring CSS with `site_apply_css`.** The required `operation` discriminator makes destructive intent explicit:

- `{ operation: "merge", css }` creates missing selectors and patches only the supplied declarations/contexts. Touched declarations move to the end of the stored rule in authored order, so longhand/shorthand cascade order stays truthful.
- `{ operation: "replace", css }` makes every supplied selector's complete CSS payload authoritative: omitted base declarations and contexts are removed, while stable rule id, cascade order, metadata, and class assignments survive. An empty `.foo {}` therefore clears its CSS without detaching the class.
- `{ operation: "remove-properties", selectors, properties }` removes CSS-native property names from base plus every viewport/custom-condition bag without rebuilding unrelated CSS. Vendor names and custom properties are accepted; emitted `padding`/`margin` shorthands also clear their stored side longhands.
- `{ operation: "delete", selectors }` removes every exact matching rule; class-kind rules are detached from page and Visual Component nodes in the same undo step.

Selectors are matched by their exact emitted text across rule kinds. `.grad`, `.hero .grad`, and `.grad, .hero .grad` are separate rules—there is no unsafe attempt at semantic selector equivalence. Destructive batches preflight missing/locked targets and fail without partial mutation. Merge/replace accept real CSS through `cssToStyleRules`, including conditions, vendor/custom properties, raw keyframes, and structurally preserved `!important`. Framework-generated locked utilities are never changed. `<style>`-only `site_insert_html`/`site_replace_node_html` payloads keep merge behavior as a forgiving fallback; a `<style>` block accompanying inserted elements remains additive (`mergeImportedStyleRules`) so dropping in structure cannot clobber a shared rule.

**Loops through HTML.** A repeated list is authored with the custom importer marker:

```html
<studio-loop data-source-id="data.rows" data-table-id="<table id>" data-order-by="publishedAt" data-direction="desc" data-limit="3">
  <article>
    <a href="{currentEntry.permalink}">
      <img src="{currentEntry.featuredMedia}">
      <h3>{currentEntry.title}</h3>
    </a>
  </article>
</studio-loop>
```

The agent calls `site_list_loop_sources` first to get the valid source id, data table id, order options, and field tokens. The token grammar is single-brace `{currentEntry.field}`; aliases such as `{{post.title}}` are invalid and should never be generated.

**Node edits**

| Tool              | Input                                      | Success `data`          | What it does                                               |
|-------------------|--------------------------------------------|-------------------------|------------------------------------------------------------|
| `site_update_node_props` | `{ nodeId, breakpointId?, patch }`         | none                    | Shallow-merge props; `breakpointId` requires schema `breakpointOverridable: true` |
| `site_move_node`        | `{ nodeId, newParentId, newIndex }`        | none                    | Re-parent or reorder; `newIndex` is 0-based               |
| `site_delete_node`      | `{ nodeId }`                               | none                    | Remove node and all descendants                            |
| `site_duplicate_node`   | `{ nodeId, count? }`                       | `{ nodeId, nodeIds }`   | Clone subtree 1–50 times right after the source           |
| `site_rename_node`      | `{ nodeId, label }`                        | none                    | Set the node's display label in the DOM panel (editor-only)|

**CSS + class assignment**

| Tool          | Input                 | Success `data`                          | What it does                                          |
|---------------|-----------------------|-----------------------------------------|-------------------------------------------------------|
| `site_apply_css`    | `{ operation:'merge'\|'replace', css }` or `{ operation:'delete', selectors }` or `{ operation:'remove-properties', selectors, properties }` | `{ cssRulesCreated?, cssRulesUpdated?, cssRulesDeleted?, cssPropertiesRemoved? }` | Merge/replace authored CSS, delete exact rules, or remove selected properties across all contexts |
| `site_assign_class` | `{ nodeId, classId }` | none                                    | Attach an existing class to a node; `classId` accepts id or name|
| `site_remove_class` | `{ nodeId, classId }` | none                                    | Detach a class from a node (the class itself remains) |

**Code assets**

Scripts and user stylesheets live in `site.files[]`; runtime targeting and loading options live in `site.runtime.scripts` / `site.runtime.styles`. These tools expose that existing Code Editor storage to the agent, so behavior such as theme toggles, tabs, menus, filters, and DOM-ready interactions is authored as a real runtime script instead of attempted through HTML import.

| Tool                   | Input                                      | Success `data`                          | What it does                                          |
|------------------------|--------------------------------------------|-----------------------------------------|-------------------------------------------------------|
| `site_list_code_assets`     | `{ type?: 'script' \| 'style' }`           | `{ assets }`                            | List runtime code assets with file ids, paths, full-content hashes, sizes, timestamps, and runtime config |
| `site_read_code_asset`      | `{ fileId? \| path?, part?, maxChars? }`   | `{ fileId, path, type, content, hash, runtime, pageInfo }` | Read an exact script/stylesheet content slice. The `hash` is for the full file; page through with `pageInfo.nextPart` |
| `site_write_code_asset`     | `{ path, type, content, runtime?, dependencies? }` | asset summary + `{ action, dependencies }` | Create or replace a runtime script/stylesheet and normalize its runtime config. Existing paths are updated, new paths are created. For module scripts, `dependencies` is a package-name → version/range map added to `site.packageJson.dependencies` |
| `site_patch_code_asset`     | `{ fileId? \| path?, expectedHash, replacements }` | asset summary + `{ replacements }` | Apply exact text replacements only when `expectedHash` matches the latest content. Ambiguous matches require a wider `oldText` or explicit `replaceAll:true` |
| `site_inspect_code_runtime` | `{ document?: { type, id } }`              | `{ pageId, document, scripts, styles }` | Report which runtime scripts/stylesheets apply to the current page/template or supplied page/template document ref |

`site_insert_html` / `site_replace_node_html` intentionally strip `<script>` elements and inline event handlers (`onclick`, `onload`, etc.). When a request needs behavior, the agent should use `site_write_code_asset({ type: "script", ... })` and then `site_inspect_code_runtime`, not raw `<script>` tags or event attributes in HTML.

Module scripts that need npm packages should import bare package specifiers and declare those packages in the same `site_write_code_asset` call:

```ts
site_write_code_asset({
  path: 'src/scripts/motion.js',
  type: 'script',
  content: `import { Motion } from '@motion.page/sdk';`,
  runtime: { format: 'module' },
  dependencies: { '@motion.page/sdk': '1.2.4' },
})
```

Agents should not use npm CDN URLs such as `esm.sh`, `unpkg`, or jsDelivr for packages that can live in the site dependency manifest.

**Pages**

| Tool            | Input                             | Success `data` | What it does                                               |
|-----------------|-----------------------------------|----------------|------------------------------------------------------------|
| `site_add_page`       | `{ title, slug? }`                | `{ pageId, rootNodeId }` | Create an empty page and make it active. Slug is auto-uniqued. Build into it via `site_insert_html({ parentId: rootNodeId, … })` |
| `site_delete_page`    | `{ pageId }`                      | none           | Delete page; fails if it would leave the site with 0 pages |
| `site_rename_page`    | `{ pageId, title, slug? }`        | none           | Change title/slug; `slug="index"` makes this the homepage  |
| `site_duplicate_page` | `{ pageId, title, slug? }`        | `{ pageId }`   | Deep-clone page (all nodes, props, class assignments)      |

**Templates (CMS layouts)**

A template is a page carrying a `target` plus a single `<studio-outlet>` where matched content flows in. These bridge to the editor's `convertPageToTemplate` / `convertTemplateToPage` store actions. The outlet itself is placed via `site_insert_html` — the importer maps the custom `<studio-outlet>` element to a `base.outlet` node (see [html-import.md](html-import.md) and templates.md). No save-time outlet guard: a template with no outlet simply doesn't apply at render time.

| Tool                | Input                                                                 | Success `data` | What it does                                              |
|---------------------|----------------------------------------------------------------------|----------------|----------------------------------------------------------|
| `site_set_page_template`   | `{ pageId, target: {kind:'everywhere'} \| {kind:'postTypes', tableSlugs:[…]}, priority? }` | none | Convert a page to a template (or update its target/priority). `priority` defaults to 100. Get post-type slugs from `site_list_post_types` |
| `site_clear_page_template` | `{ pageId }`                                                         | none           | Revert a template to an ordinary page (drops target + dynamic bindings); errors if the page is not a template |

**Design system (tokens)**

The agent works **design-system-first**: it establishes or reuses tokens, then references them (`var(--<slug>)`, `--text-*`, `--space-*`, `var(--<font-var>)`) instead of hardcoding hex/px/font-family. Colors and fonts are list-shaped (one entry per token); typography and spacing are scale-shaped (a group config from which the framework generates per-step values). All four are **create-or-update** — keyed by color `slug`, font `variable`, or scale group — so re-runs patch in place. The executor dispatches to the framework/font store actions (`createFrameworkColorToken`, `create/updateFrameworkTypographyGroup`, `create/updateFrameworkSpacingGroup`, `addFont`/`createFontToken`).

| Tool                | Input                                                                 | Success `data`                              | What it does                                          |
|---------------------|----------------------------------------------------------------------|---------------------------------------------|-------------------------------------------------------|
| `site_set_color_tokens`  | `{ tokens: [{ slug, lightValue, category?, darkValue?, darkModeEnabled? }] }` | `{ tokens: [{ slug, ref, action }] }` | Create/update color tokens → `var(--<slug>)` + utilities/variants |
| `site_set_font_tokens`   | `{ tokens: [{ name, variable?, fallback?, googleFamily?, variants?, subsets?, familyId? }] }` | `{ tokens: [{ name, variable, ref, installed?, action }] }` | Create/update font tokens. `googleFamily` installs a new web font via `POST /admin/api/cms/fonts/install` then binds the token; `familyId` references an already-installed family; neither = fallback-only. Prefer exactly one of `googleFamily`/`familyId`; if both are sent, `googleFamily` wins and the stale `familyId` is ignored |
| `site_set_type_scale`    | `{ groupId?, namingConvention?, steps?, baseScaleIndex?, min?: { fontSize?, scaleRatio? }, max?: {…} }` | `{ groupId, action, namingConvention, generatedVars }` | Configure the typography scale → `--text-*`. Creates the group if none exists, else updates it |
| `site_set_spacing_scale` | `{ groupId?, namingConvention?, steps?, baseScaleIndex?, min?: { size?, scaleRatio? }, max?: {…} }` | `{ groupId, action, namingConvention, generatedVars }` | Configure the spacing scale → `--space-*`. Same shape as `site_set_type_scale` but `min`/`max` carry `size` |

**Capture**

| Tool              | Input                 | Success `data` | What it does                                                     |
|-------------------|-----------------------|----------------|------------------------------------------------------------------|
| `site_render_snapshot` | `{ breakpointId?, nodeId? }`   | `{ breakpointId, nodeId?, label, width, capturedAt, layout, screenshot }` + optional `images[]` | Inspect the rendered canvas: always returns geometry, warnings, and per-node computed styles including background image/clip and WebKit text-mask values; capable providers also receive a PNG. `breakpointId` renders any configured viewport through a deterministic one-shot frame at its exact width, independent of Live mode or collapsed/disabled frames. `nodeId` crops to one subtree while preserving ancestor paint. Unknown ids error. Pair computed evidence with `site_read_document` source CSS when debugging the cascade |

### Auto-navigation

When a node-targeting write tool (`site_insert_html`, `site_get_node_html`, `site_replace_node_html`, `site_delete_node`, `site_update_node_props`, `site_move_node`, `site_rename_node`, `site_duplicate_node`, `site_assign_class`, `site_remove_class`) receives a node id that belongs to a different document (another page, a template, or a VC), the executor automatically navigates the canvas to that document **before** running the mutation. This is done via `focusNodeDocument` in `executor.ts`, which calls `store.openPageInCanvas` or `store.setActiveDocument` as appropriate. The effect: the edit lands in the correct tree, stays visible to the user, and the mid-turn snapshot refresh picks up the navigated state for any subsequent read tool in the same turn.

`site_render_snapshot`, catalog tools (`site_list_documents`, etc.), and token tools have no node target — they are excluded from auto-navigation.

### Heavy evidence — image channel + vision gating + elision

`site_render_snapshot` (and `site_read_document` / `site_get_node_html`) return large payloads. Five rules keep them from exploding context (a screenshot inlined as base64 JSON text once pushed a single turn past 1M tokens):

1. **Image channel, not text.** `AiToolOutput` carries an optional `images: { mimeType, data }[]` (`src/core/ai/toolOutput.ts`). `site_render_snapshot` puts the PNG there — never in `data`. The Anthropic driver forwards it as a **native `image` block** inside the `tool_result` (billed at the rendered image's token cost). Text-only tool channels (Ollama / OpenAI-compatible `function_call_output`) **drop** the image and append a one-line `[N screenshot(s) omitted…]` note. The capture caps the screenshot's long edge at `MAX_IMAGE_EDGE` (1568px in `renderEvidence.ts`) — a tall landing page would otherwise exceed Anthropic's hard 8000px-per-dimension limit (400 error), and the model downsizes the long edge to ~1568px anyway.
2. **Capture is provider-channel-gated.** The chat handler resolves the selected model on every turn and places the result in `AiStreamRequest.modelCapabilities`. `visionInput` means pasted user images are accepted; the separate `toolResultImages` flag means that provider's tool-result wire shape can actually carry a native image. The shared tool loop injects `captureScreenshot: visionInput && toolResultImages` into `site_render_snapshot`. Today Anthropic supports both; Responses and chat/completions providers accept user images but have text-only function/tool results, so they get the layout report without paying for a screenshot that would be discarded. (The model never sets `captureScreenshot` itself.)
3. **`site_read_document` CSS is document-relevant, not the public full-site CSS bundle.** Public pages can share page-invariant CSS files, but `site_read_document` inlines CSS into model context. It keeps framework variables/utilities, font token variables, target-document module CSS, used class rules, ambient selectors whose class tokens all exist on the target document, classless/global ambient selectors, and document-targeted user stylesheets. It omits browser-only `@font-face` file declarations and ambient selectors from unrelated imported pages.
4. **`site_read_document` is cleaned and paged before it reaches the model.** `renderAgentDocument` strips pathological strings from the broad read surface: long base64/data URLs become `data:<mime>;base64,[omitted N chars]`, and very long URLs are middle-truncated. The returned object always includes `pageInfo` with `part`, `totalParts`, `nextPart`, `ranges`, `serializedChars`, and cleanup counts. The hard budget is measured against `JSON.stringify({ html, css, pageInfo }).length`, because that is the text providers receive as the tool result. If `nextPart` is not `null`, the agent calls `site_read_document({ document, part: nextPart })` to continue. For exact node-level markup, use the `uid` with `site_get_node_html`.
5. **Stale evidence is elided.** Within one tool loop, only the **most recent** heavy result per tool name AND scope (the page or file its call named, `heavyResultScope`; AI-18: a screenshot of page A is not superseded by one of page B) (`site_render_snapshot`, `site_read_document`, `site_get_node_html`, or anything with an image) is sent at full fidelity; earlier ones become a one-line breadcrumb (`"Earlier <tool> output removed… Call <tool> again…"`). Older snapshots describe page state the model has since mutated, so they carry no value. This is a **per-request projection** (`projectHeavyElision` in `server/ai/drivers/http/heavyElision.ts`), computed fresh for each POST — the loop's own message history is strictly append-only. It used to rewrite the earlier message in place, which changed the cached prefix on every capture and cost the whole conversation its prompt cache from that point on.

Snapshot pixels come from the iframe document's authored rendering. Full-page captures rasterise `<html>` at the exact iframe viewport width and full document height, so a narrow/transformed body cannot shrink the reported viewport or omit document gutters. Node-scoped captures rasterise that same document painting context and crop to the node rectangle, so transparent sections retain HTML/body/ancestor colors, gradients, and background images. A white browser-default fallback is composited only behind pixels the authored page leaves transparent — it is never written onto the cloned document.

Every request uses `AgentSnapshotFrame`, an offscreen one-shot `IframeFrameSurface` at the configured width. Before it becomes capturable, a revisioned barrier waits for template preview rows, nested loop data, media metadata, web fonts, the resulting React commit, and a quiet DOM window. Readiness lives on the host iframe, never on authored `<html>`/`<body>`, so user attribute selectors cannot distinguish Agent evidence from the published page. Lazy `<img>` resources are left authored as-is; `html-to-image` makes its private clones eager and embeds image/background resources before `toCanvas()` resolves. The frame deliberately does not execute authored runtime scripts, and it is released after capture without changing `activeBreakpointId`, `canvasView`, or collapsed-frame state. Parallel requests are serialized so they cannot replace the single transient frame mid-capture.

**Which iframe gets captured** is decided by `findAgentRenderFrame` (`agent/renderEvidence.ts`), and the canvas's staged mount (S1 — see `canvas-internals.md` §Perf) makes two of its rules load-bearing:

- A `'visible'` query never returns anything inside the transient capture frame. `IframeFrameSurface` stamps `data-breakpoint-id` on the iframe ELEMENT in both document modes (so a cross-mode caller can read a frame's breakpoint without touching `contentDocument`), which otherwise makes the offscreen capture frame's own iframe a match — and an `<iframe>` returned where a frame HOST is expected yields `null` from the capture, silently.
- A frame with no capture-request marker is ready only once its iframe carries `data-studio-canvas-content-ready`. The srcDoc document loads, and its body is tagged with the breakpoint id, one or more commits BEFORE the node tree is portalled into it; capturing in between rasterises an empty document. The transient frame vouches for itself through the stronger, request-scoped `data-agent-snapshot-ready`, written by a marker that lives inside the node tree and only after the settle barrier.

The transient frame itself is mounted UNSTAGED for this reason — see `IframeFrameSurface`'s stage-3 effect.

---

## System prompt

`server/ai/tools/site/systemPrompt.ts` builds a 3-element array:
```ts
[staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]
```
Drivers that support explicit prompt-cache controls (Anthropic) apply `cache_control` to the static prefix automatically — and to three more places; see "Prompt caching" below. Both OpenAI-Responses drivers (OpenAI **and** OpenRouter) concatenate the prompt parts and send the same stable `prompt_cache_key` derived from the toolset, so repeated prefixes route into one cache partition. Other drivers concatenate the three strings. Content is intentionally static across providers — every observable behaviour comes from the tool definitions, not prompt knobs.

### Prompt caching

Anthropic allows four `cache_control` breakpoints per request and serves the longest cached prefix that still matches. The driver spends all four, in prefix order, most-stable first:

1. the **static system prefix** (`buildSystemBlocks`, `drivers/anthropic.ts`);
2. the **last tool definition** (`buildToolDefinitions`, `drivers/anthropicWire.ts`) — one marker on the final tool caches the whole 8–15K-token tool array;
3. the **end of the persisted conversation history** the turn started from — heavy-evidence elision only ever touches messages the loop itself appended, so this anchor survives a fresh screenshot superseding an older one;
4. the **last message of the current request** — so the next round of the tool loop reads everything before it from the cache and pays full price only for its own delta.

3 and 4 are chosen provider-agnostically by `messageCacheBreakpoints` in `drivers/http/toolLoop.ts` and passed to `buildRequestBody`; drivers whose caching is implicit ignore them. `withMessageCacheBreakpoints` copies rather than mutates, because the loop's history array is shared across every round of the turn.

Only breakpoint 1 existed before, which meant a multi-round build loop re-read the tool block and the entire conversation at full input price on every single round.

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is the literal `'__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'`, declared **once** in `server/ai/runtime/types.ts` and imported everywhere — prompt builders and every driver. A duplicate definition would silently break prompt caching on whichever driver drifted. Gated by `ai-driver-shared-helpers.test.ts`.

**There are TWO static prefixes**, and `buildSiteSystemPrompt` picks between them from the snapshot's own node ids (`isStudioPageRootId` on the root, or any `rel:line:col` node id). They differ only in the building block:

- a **CMS page** gets the block below, unchanged;
- a **studio-imported page** — one parsed out of the user's `.tsx`, which is what `/admin/site` shows on this fork — gets a block that says `site_insert_html` and `site_replace_node_html` REFUSE there (`store-13`: an HTML fragment has no honest single source form, and its `<style>` half targets a stylesheet rather than the `.tsx`), and names `studio_apply_edits`' `insert` edit, `studio_codemod` and `studio_create_page` as what writes instead. `site_read_document` / `site_get_node_html` still work and their `uid`s decode to `file:line:col`, so they are how you AIM a `studio_*` edit.

  Two whole prefixes rather than a contradicting line in the dynamic suffix, because element 0 is what a driver puts `cache_control` on: each branch stays internally consistent AND fully cacheable, and which branch a project takes never changes mid-conversation. Gated by `src/__tests__/agent/siteSystemPromptStudioTree.test.ts`.

**Static prefix key rules** (full text lives in `server/ai/tools/site/systemPrompt.ts`):
- **Design system first.** Establish or reuse tokens before/while building (`site_set_color_tokens`, `site_set_type_scale`, `site_set_spacing_scale`, `site_set_font_tokens`), then reference them in CSS (`var(--<slug>)`, `var(--text-l)`, `var(--space-m)`, `var(--<font-var>)`) instead of raw hex/px/font-family. The dynamic suffix's `Tokens —` line shows what already exists; `(none …)` means no design system yet.
- Structure as HTML (`site_insert_html` / `site_replace_node_html`); style with CSS in the same payload — a `<style>` block and/or `class=` attributes referencing the design tokens. The importer classifies selectors, so the agent never hand-builds classes at insert time.
- `<style>` blocks inside imported HTML are parsed: a bare `.foo {}` rule becomes a Selectors-panel class bound to `class="foo"`; any other selector (`.hero a`, `a:hover`, `@media …`) becomes an ambient rule, and supported `@keyframes` publish as raw keyframes CSS. `style=` attributes land on the node's inline styles. These are applied — not stripped.
- CSS-only edits use an explicit `site_apply_css` operation: merge for additive patches, remove-properties for stale declarations, replace only with the selector's complete desired CSS, and delete for whole exact rules. Read the document first before destructive operations; grouped and ungrouped selectors are different identities.
- One `site_insert_html` call per logical section (nav, hero, pricing, footer = 4–6 calls); smaller chunks recover better if one fails.
- Per-breakpoint variation: `@media` queries — in the `<style>` block of an insert or inside `site_apply_css` — with min/max-width queries that line up with the breakpoint widths in the dynamic suffix. Never invent ids like `"mobile"` or `"desktop"`.
- Document refs come from the dynamic suffix or `site_list_documents`; never invent them. Shared chrome/layout/theme/navigation/footer requests should inspect template documents first.
- Page ids for page operations come from the dynamic suffix; never invent them.
- Write-tool success data uses explicit keys: `cssRulesCreated`/`cssRulesUpdated`/`cssRulesDeleted`/`cssPropertiesRemoved` for `site_apply_css`, `pageId` for `site_add_page`/`site_duplicate_page`, `nodeId`/`nodeIds` for `site_duplicate_node`, `nodeIds` for HTML inserts.
- Editing existing content: call `site_read_document` first — it returns annotated document HTML where every element carries `uid="<nodeId>"` plus `pageInfo`; follow `pageInfo.nextPart` when more of the document is needed. Pass `uid` verbatim to write tools (`site_update_node_props`, `site_replace_node_html`, etc.). For a single subtree, `site_get_node_html` is sufficient.
- Reply rule: 1–2 narrating sentences only. No raw HTML/CSS/JSON in the reply.

**Dynamic suffix** (built per request by `buildDynamicSuffix(snap: SiteAgentSnapshot)`):
```text
Page: "My Site" · root: <rootNodeId> · selected: <nodeId|none>
· active breakpoint: <id> · all breakpoints: [<id>@<width>px, …]
· Documents: [page:<id>="Home" (current, active-page, root=<rootNodeId>; Homepage), template:<id>="Chrome" (root=<rootNodeId>; Everywhere template wrapping all pages), …]
· Pages: [<id>=<slug> (active), <id>=<slug>, …]
· Tokens — colors: [primary=…, ink=…]; type --text-*: [xs, s, m, …]; spacing --space-*: […]; fonts: [--font-heading→Inter]
```
The static prefix is cache-friendly (unchanged across prompts for the same provider) and is Anthropic's first `cache_control` breakpoint — see "Prompt caching" above for the other three. The Responses drivers rely on automatic prefix caching plus `prompt_cache_key`. The dynamic suffix carries per-request state. The `Tokens —` digest is a compact, always-inlined summary of the site's design tokens (`describeAgentTokens(snap.site)`) so the agent sees the design system every turn without a `site_list_tokens` round-trip; when no tokens exist it reads `Tokens: (none — no design system yet; establish one first …)`. `site_list_tokens` remains the on-demand full-detail read (variants, utility classes).

---

## Why HTML-native

The previous tool surface required the model to reference internal module ids (`base.text`, `base.container`, …) and construct node trees as structured JSON. The current surface lets the model write plain HTML:

- LLMs produce correct semantic HTML far more reliably than custom JSON node-tree payloads.
- No module enumeration is needed in the system prompt — shorter context, lower token cost.
- The importer (`@core/htmlImport`) guarantees every element becomes a first-class editable `PageNode`: selectable, draggable, deletable, and re-styleable in the canvas.
- `site_get_node_html` (backed by the publisher's `renderNode`) gives the agent read-back at the same semantic level it writes.

The same importer that powers the Agent's `site_insert_html` tool also powers the paste-HTML UI — see `docs/features/html-import.md`. No duplicated mapping logic.

**Reads are HTML-native.** The `site_read_document` tool returns the same semantic surface the agent writes: annotated HTML where every element carries `uid="<nodeId>"`, plus document-relevant CSS rather than the public full-site CSS bundle. It accepts document refs for pages, templates, and visual components, and omitting `document` reads the current editor document. The response is cleaned and size-budgeted; if `pageInfo.nextPart` is set, subsequent `site_read_document({ document, part })` calls return the remaining cleaned ranges. The agent reads `uid` values from the HTML and passes them verbatim to write tools — no separate node-lookup round-trip. Catalog tools (`site_list_modules`, `site_list_tokens`, `site_list_documents`, `site_list_post_types`, `site_list_loop_sources`, `site_list_breakpoints`) describe things not visible in the document HTML (what is insertable, design token CSS vars, editable document refs, CMS route targets, and loop binding fields) and remain as JSON tools.

---

## Client store (`agentSlice`)

`createAgentSlice(config)` (`src/admin/pages/site/agent/agentSlice.ts`) is a Zustand slice factory. The site editor is Studio's only agent surface, so there is exactly one `AgentSliceConfig` in the app — `siteAgentSliceConfig` from `agentSliceConfig.site.ts`:

```ts
// agentSliceConfig.site.ts — wired in store.ts via createAgentSlice(siteAgentSliceConfig)
export const siteAgentSliceConfig: AgentSliceConfig = {
  buildSnapshot: () => buildCurrentPageContext(
    () => getAgentStoreApi<EditorStore>().getState(),
  ),
  dispatchTool: executeAgentTool,
  noProviderMessage: 'No AI provider configured for the site editor. …',
}
```

`getAgentStoreApi` reads the live store via `storeRef.ts`, wired in `store.ts` after store creation (`setAgentStoreApi(useEditorStore)`). This avoids a static import cycle: executor → store → agentSlice → executor.

`agentProviderUpdate.ts` owns the existing-conversation provider/model PUT and its failure reconciliation. A definite 4xx can roll the picker back to the re-read row; a timeout, network failure, or 5xx stays fail-closed unless the re-read already proves that the requested selection committed. `agentSlice.ts` keeps the ordering queue and Send lock because those coordinate store actions rather than HTTP persistence.

Key slice state and actions:

```ts
interface AgentSlice {
  // ── UI state ──────────────────────────────────────────────────────────
  isAgentOpen:               boolean
  isAgentStreaming:          boolean
  agentMessages:             AgentMessage[]
  agentError:                string | null
  /** Active ai_conversations row id — created lazily on first send. */
  agentConversationId:       string | null
  /** Active (credentialId, modelId) surfaced by the model picker. */
  agentActiveCredentialId:   string | null
  agentActiveModelId:        string | null
  /** Conversation summaries for the history popover. */
  agentConversations:        ConversationView[]
  /** Current-context snapshot plus cumulative conversation billing totals. */
  agentUsage: {
    contextTokens:           number | null
    contextCredentialId:     string | null
    contextModelId:          string | null
    promptTokens:            number
    completionTokens:        number
    cacheReadTokens:         number
    cacheCreationTokens:     number
    costUsd:                 number
  }
  /** Blocks Send/navigation while a history load or delete may replace the active chat. */
  isAgentConversationPending: boolean
  /** Blocks Send/navigation while an existing chat's model PUT is pending. */
  isAgentProviderPending:     boolean
  /** Incremented when a conversation is replaced so local text/image drafts remount cleanly. */
  agentComposerEpoch:        number

  // ── Actions ───────────────────────────────────────────────────────────
  openAgent():                                         void
  closeAgent():                                        void
  toggleAgent():                                       void
  sendAgentMessage(content: AiUserContentBlock[]):     Promise<{ accepted: boolean }>
  abortAgent():                                        void
  clearAgentMessages():                                void
  startNewAgentConversation():                         void
  loadAgentConversations():                            Promise<void>
  loadAgentConversation(id: string):                   Promise<void>
  deleteAgentConversation(id: string):                 Promise<void>
  /** Change which credential + model is active. Updates the conversation row if one exists; stages the values for the next create if not. Also clears `agentError` so a sticky "no provider" error doesn't keep the composer disabled after the user picks a model. */
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
  /** Preload the default (credentialId, modelId) from GET /admin/api/ai/defaults. No-op when a conversation or explicit pick is already active. Called by AgentPanel on open. */
  loadStudioDefault():                                  Promise<void>
}
```

Conversations and their message history are persisted server-side in `ai_conversations` + `ai_messages`. `loadAgentConversation(id)` rehydrates a past thread into `agentMessages` without re-running the conversation.

**Content blocks have one persisted vocabulary and one safe browser projection.** Every stored/provider message body is an `AiContentBlock[]` — a discriminated union of `text` / base64 `image` / `toolCall` / `toolResult` kinds defined once as a TypeBox schema in `@core/ai` (`src/core/ai/contentBlock.ts`). The server runtime type and the `content_json` read boundary derive from it. Conversation-detail responses derive from the sibling `AiContentViewBlockSchema`: non-image blocks keep the same schemas, while an image carries an authenticated lazy `url` instead of inline `data`. The client validates that view schema before rehydrating its render model.

**User turns use the same canonical blocks at the HTTP boundary.** `AiChatRequestBodySchema` in `src/core/ai/chatRequest.ts` accepts `{ conversationId, content, snapshot? }`, where `content` contains at most one trimmed text block plus up to eight canonical JPEG blocks. The server canonicalises a mixed turn as text followed by the images in paste order and removes whitespace-only text. It does not accept `toolCall` or `toolResult` blocks from the browser.

```ts
{
  conversationId,
  content: [
    { kind: 'text', text: 'Use this mockup as the reference.' },
    { kind: 'image', mimeType: 'image/jpeg', data: '<canonical base64>' },
    { kind: 'image', mimeType: 'image/jpeg', data: '<canonical base64>' },
  ],
  snapshot,
}
```

**Persisted images, browser history, and provider replay are deliberately different views.** Every accepted user JPEG is stored inline in `ai_messages.content_json`; conversations have no image-count quota. A conversation-detail response replaces each base64 block with `GET /admin/api/ai/conversations/:conversationId/messages/:messageId/images/:blockIndex`. The ownership-guarded endpoint returns only a canonical JPEG with `private, no-store`; native lazy image loading means reopening a large collection does not embed all bytes in one JSON response. Before a provider call, `projectUserImagesForModel` creates a non-mutating outbound projection:

- a vision model first receives every persisted image in conversation order; there is no Studio replay count cap;
- a non-vision model receives no image bytes at all; every persisted image becomes a text breadcrumb, so switching models cannot poison the conversation;
- the database rows are never rewritten by projection, so the UI history remains intact and switching back to a vision model restores the complete persisted image history.

Providers may enforce a physical request, context, or routed image limit before accepting that full replay. The shared HTTP tool loop classifies only those explicit overflow responses (`413`, or a matching provider `400`) and retries once before any SSE or tool side effect: images on older user turns become one breadcrumb per turn, while every image on the newest/current user turn remains. Generic 400s, authentication failures and an exhausted balance are never retried; a transient failure is, separately — see "Transient failures, truncation and effort" below. If the reduced request still fails—or only the current turn has images—the error explains that history remains saved and suggests a new conversation or a larger-context model. This is provider-triggered fallback, not a stored-image quota or an arbitrary app-side count.

User attachments are private chat data by default, not media-library assets: the normalised base64 bytes live in the database until the conversation is deleted and purged, are exposed to the owning authorised user only through the lazy conversation-image endpoint, and are sent to the configured AI provider whenever they survive the outbound replay projection. They enter public Media storage only when a user with `media.write` explicitly chooses **Save to Media** from the image context menu; saving creates a separate media asset and does not change or delete the private conversation copy.

The server admits only one active writer per conversation. A concurrent tab receives a retryable 409 before appending, which keeps message positions ordered. In the browser, model changes for an existing conversation are serialized; Send waits for the provider/model update to reach the server, and conversation/model controls stay disabled while a turn streams. If a model PUT times out after an ambiguous commit, the browser re-reads the conversation before re-enabling Send, so the picker cannot disagree with server routing. Stop owns the whole first-send lifecycle, including default lookup and lazy conversation creation, so an aborted bootstrap cannot leave the composer locked.

**User attachments are not tool screenshots.** A pasted image is a persisted `kind:'image'` block on a user message. Conversation-detail responses, authenticated image responses, and chat streams use `Cache-Control: private, no-store`; the database remains the intentional durable copy. Images returned by `site_render_snapshot` or another browser tool instead travel transiently on the plural `AiToolOutput.images` channel, are subject to the heavy-evidence rules above, and remain session-only even though the panel exposes every returned image through the same gallery and draggable preview. The two paths share provider-native image mapping but have different storage and replay lifecycles.

**Tool outcomes are first-class.** A `role:'tool'` row records its result as a `{ kind: 'toolResult', ok, error? }` block — `ok` is an explicit boolean, never inferred from the emptiness of a text block. The persister writes it (`appendToolResult`), `buildMessageHistory` reads `ok`/`error` straight off the block to reconstruct the replay `AiToolOutput`, and the client folds it back into the matching tool-call badge (`rehydrateMessages`). A loaded conversation never owns a live bridge from its previous process: any persisted call without a matching valid result is finalized as `INTERRUPTED_TOOL_RESULT_ERROR`, never restored as pending. The heavy successful `data` an `AiToolOutput` may carry is intentionally **not** persisted: the model already consumed it in the round that produced the result, so replay only needs `{ ok, error }` — re-feeding large tool payloads every turn would bloat the context for no benefit.

---

## Context meter and live model catalogue

### Context meter

The `<ContextMeter>` is a five-segment battery-style status beside the image action. Its hover/focus tooltip deliberately separates current context from cumulative billing:

- **Window** (`windowTokens` prop from `AgentComposer`): the model's max total tokens, resolved once from `GET /admin/api/ai/providers/:id/models?credentialId=…`. The models endpoint enriches Anthropic and OpenAI models with `contextWindow` from the live OpenRouter catalogue (`server/ai/pricing/`); OpenRouter populates it from its own native fetch. Ollama models and uncatalogued models have no window — the meter hides.
- **Current context** (`agentUsage.contextTokens`): the provider-normalised input held by the LATEST provider round, tagged with the credential/model selection that produced it. `normalizeContextTokens(providerId, buckets)` in `server/ai/contextTokens.ts` computes it:
  - Anthropic reports `input_tokens` excluding cache buckets, so the true total is `promptTokens + cacheReadTokens + cacheCreationTokens`.
  - OpenAI / OpenRouter / Ollama / Custom Provider report `input_tokens` as the full input; `promptTokens` alone is the total.

**Tool dispatch within a round.** A batch is executed in ordered groups: consecutive observer calls — `sideEffects` `none` or `cache` — run **concurrently**, and every `write` (or a name that resolves to no registered tool) gets a group of its own. That is the loop's field, not the capability gate: `studio_screenshot`, `studio_compare`, `studio_measure_element`, `studio_typecheck`, `studio_export_frames` and `studio_render_reference` all stay write-GATED (`requiresWrite`) and are still observers here, so a batch of them overlaps; the headless browser underneath serialises its own captures (`capture/browserPool.ts`). Until AI-5 one `mutates` flag was both, and every write-gated observer ran alone. The system prompt asks the model to issue its looks as one batch, and running that batch serially made a round cost the SUM of every observation instead of the slowest one. The write rule stays conservative — two writes to the same file, or an observation the model issued *after* a write in order to see it, must never be reordered. Stream events are still emitted in the model's own call order regardless of which tool finished first. See `groupToolCalls` in `drivers/http/toolDispatch.ts`.

#### Every loop has a ceiling (Z3)

The loop was a bare `for (;;)` whose only exits were "the model stopped", "the transport died", and abort. A model that kept issuing tool calls kept the turn running; a model that issued the same write repeatedly executed it repeatedly. That is the "I made this multiple times" and "twenty minutes for one page" experience, and two differently-shaped bounds close it. Both live in `drivers/http/toolLoop.ts` and both are gated by `src/__tests__/architecture/no-unbounded-tool-loop.test.ts`.

**1 — `MAX_TOOL_ROUNDS` (default 40).** A turn may spend at most this many tool rounds, and it ends WELL at the ceiling (AI-10). `WIND_DOWN_ROUNDS_LEFT` (3) rounds before it, the tool results carry a note — "3 tool rounds are left: finish, verify, report". The last allowed round's results carry a second note, and the loop then makes exactly ONE more request with the tool definitions kept (the cached prefix and the history's tool calls stay valid) but `tool_choice: none`, so the turn ends on the model's own summary of what it did, verified and left — never on an `error` event, which is what it used to end on, mid-work. A failed summary request ends the turn quietly with its usage. Both notes ride in the same user turn as the tool results (Anthropic's strict alternation). Forty is roughly twice the longest legitimate build turn measured here, so a working turn never touches it. Overridable per turn with the request's `maxToolRounds` (1–200, validated by `AiChatRequestBodySchema`).

**2 — a repeated write is answered, not re-executed — until something else is written.** Each `sideEffects: 'write'` call is fingerprinted as `toolName` + its arguments in canonical JSON (key order normalised recursively — `toolCallFingerprint`) **plus the turn's write epoch**, which advances once for every write that lands (`TurnWriteLedger` in `toolLoopBounds.ts`). The ledger is **per turn**: a write the user asks for again in their next message is a new instruction and runs. Write A then write A: the second never reaches the handler. Write A, write B, write A: the third RUNS, because B landed in between — "width 390, width 402, width 390" is a model changing its mind, and answering it from the first call would leave the frame at 402 while saying 390. A suppressed repeat is answered with

```json
{ "ok": false, "code": "duplicate-call", "toolName": "…", "priorResult": { "ok": true, "data": "…" } }
```

`priorResult` is the FIRST call's own outcome, with its images dropped and its `data` truncated at 2 KB — the model gets the real result to carry on from, not an unbounded re-send of evidence already in the transcript. The payload is carried both in the tool output's `data` (what Studio's transcript and UI keep) **and** serialized into its `error` string, because every provider adapter renders a failed tool result as its `error` text alone and discards `data` — a machine-readable code the model cannot read would be no code at all.

The ledger applies only to `sideEffects: 'write'` tools, the same boundary `groupToolCalls` uses. **Observers are deliberately exempt, and never advance the epoch:** re-capturing or re-checking after a write is how a model checks its own work, and that second look is a different question with the same arguments. Before AI-5 the bound keyed on `mutates`, so "write, screenshot, fix, screenshot" answered the last screenshot with the first, pre-fix image.

The ledger records a REFUSED write too, at the epoch it ran in, without advancing it. A write that refused for a reason in its own error text refuses identically the second time, and re-running it is exactly the loop the bound exists to stop — unless another write has landed since, which may be exactly what it was refused for lacking.

#### Transient failures, truncation and effort (P4-C)

**A transient failure is retried, quietly (AI-8).** A 408/429/500/502/503/504/529, a dropped connection, or a stream error of a transient type (`overloaded_error`, `api_error`, `rate_limit_error`) that arrives **before any text, reasoning or tool call reached the user** is re-sent up to `MAX_TRANSIENT_RETRIES` (3) times — after the provider's own `retry-after` / `retry-after-ms`, else 1 s, 2 s, 4 s (`drivers/http/providerRetry.ts`). A `retry-after` over a minute is a quota window, not a blip, and is reported instead of waited out; a 429 naming `insufficient_quota`/billing and every 401/402/403 are never retried. Each retry emits a display-only `retrying` stream event — never persisted, never an error — which the panel's activity headline renders as "The AI provider is busy — trying again (n of 3)"; the first thing the turn produces clears it. Only when every retry is spent does the turn end with its `error`.

**`max_tokens` comes from the model (AI-11).** `anthropicModelProfile.ts` reads the model id: 64 000 output tokens for current Claude models (Sonnet/Haiku 4.x, 3.7, everything 4.6+), 32 000 for Opus 4.0/4.1, 8 192 for 3.5, 4 096 for 3.0, and the old 8 192 for an id it cannot read. It used to be 8 192 for everything, which cut a whole-screen `studio_write_file` off mid-argument.

**A response the output limit cut off is continued, never read as a normal stop (AI-11).** Each translator reports `truncated` (Anthropic `stop_reason: max_tokens`, Responses `incomplete`/`max_output_tokens`, chat/completions `finish_reason: length`). A tool call whose argument string does not parse after such a stop was cut off: it never runs on half its input, and is answered with a result telling the model to write the file in parts. A plain reply that was cut off gets a "continue exactly where it stopped" user note, at most `MAX_TRUNCATION_CONTINUATIONS` (2) times. Unparseable arguments WITHOUT an output-limit stop are the model's own malformed JSON and still run into the `input-schema-mismatch` refusal, as before.

**Effort, and a model that refuses it.** An explicitly chosen effort maps as described under "Session controls". Extended-thinking blocks stream to the panel as `reasoning` and are sent back whole — text and signature — inside the same tool loop (the API requires it); they live only in that turn's in-memory history and are never persisted. A 400 naming the reasoning parameters is classified `unsupportedParameter`: the round is re-sent without them, and they stay off for the rest of the turn.

**Live context, cumulative billing.** A turn makes one provider round-trip per tool batch. The tool loop emits a `context` event **each round** carrying THAT round's input buckets; the chat handler injects the normalised `contextTokens` and the browser updates the meter on every round — so the remaining-capacity battery drains *during* a long tool loop instead of only at the end. The measurement is the LATEST round's input, never the sum across rounds (which would over-count, since each round re-sends the growing context). The terminal `usage` event is **billing only**: prompt/completion/cache counts are summed across rounds. Before forwarding that terminal event, the persister resolves authoritative cache-aware spend (or accepts OpenRouter's native cost), writes the usage, then includes the resolved `costUsd` on the wire. The browser accumulates those totals in `agentUsage`; `loadAgentConversation` hydrates the same totals from `ConversationView`. The tooltip labels the sections “Context remaining” and “Conversation billing” so the two token meanings cannot be confused.

Five equal bands approximate remaining capacity: an empty conversation has all five filled, then the display drains by fifths until no capacity remains. More than 40% remaining is healthy, 20–40% warns, and below 20% is danger. An unmeasured model switch uses five neutral segments until its first response. The keyboard-focusable details button exposes the exact remaining/window counts and percentage in its accessible name; segment count is only the compact visual approximation.

### Live model catalogue

The browser de-duplicates concurrent requests for the same credential, applies a ten-second timeout, and retains successful catalogues for five minutes so the composer capability check and model picker share one result across conversation switches. Credential deletion invalidates its cached catalogue. The server independently applies the same ten-second deadline and forwards request cancellation into provider fetches; Ollama resolves `/api/show` metadata in batches of six rather than launching an unbounded fan-out.

`server/ai/pricing/` is the single source for per-model prices **and context windows**. It sources from OpenRouter's public `/api/v1/models` endpoint (no key required), which publishes list prices and `context_length` for Anthropic and OpenAI models. The module lifecycle:

- **Cold start**: loads the DB cache from `ai_model_pricing` (durable fallback) and kicks a background refresh. The first turn prices immediately off the last-known data.
- **No DB cache yet**: blocks once on a live fetch.
- **Thereafter**: serves from a 6-hour in-memory memo, refreshing in the background past the TTL.
- A failed refresh is logged and keeps the previous data — never fatal.

`pricingKey(modelId)` normalises a provider's native id (`claude-opus-4-8-20260514`) and the OpenRouter slug (`anthropic/claude-opus-4.8`) to the same key (`claude-opus-4-8`), stripping date suffixes, dots, and provider prefixes. Variant suffixes (`:thinking`, `-fast`) are preserved — they have different pricing.

The `getModelCatalogue(db)` export (used by the models handler for picker enrichment) and `resolveCostUsd(db, providerId, modelId, usage)` (used by the persister) share the same in-memory cache. Two callers, one memo.

### Auto-default on credential creation

When `POST /admin/api/ai/credentials` creates a new credential, `seedEmptyDefaults` auto-assigns it as Studio's default if none is set yet. The default model is the `tier === 'smartest'` live-catalogue entry from `driver.listModels()`, or the first live model if no smartest tier is found. If the model list can't be resolved (offline, bad key), seeding is skipped silently — it never fails the credential creation. Driver fallback models can still help the picker explain common local options, but they are not trusted for automatic defaults. An already-set default is left untouched.

The default can also be cleared from the Defaults tab. The UI calls
`DELETE /admin/api/ai/defaults`, removes the row from `ai_defaults`, and
unblocks deletion of the credential that had been protected by the default FK.

---

## Abort + crash recovery

- **Abort owns the whole response.** "Stop" calls `agentSlice.abortAgent()` and aborts the chat fetch. The server also owns a response-lifecycle controller: `ReadableStream.cancel()` or a failed `controller.enqueue()` aborts the same turn even when the original request signal does not observe a disappearing response consumer. `AbortSignal.any()` threads that combined signal into the provider request and browser bridge, and the handler's `finally` destroys the bridge and releases the per-conversation writer lock.
- **Pending calls become terminal.** `runChat` persists `INTERRUPTED_TOOL_RESULT_ERROR` for every declared tool call still unresolved on a graceful abort or terminal driver event. A hard process stop can still land between those two writes, so both recovery projections enforce the same invariant: `buildMessageHistory` injects a synthetic error for provider replay, while `rehydrateMessages` renders an unmatched or malformed call as a failed historical badge. `pending` therefore means only work owned by the current live stream; a reload never shows an old spinner. Adjacent synthetic results plus the following real user prompt are merged into one user turn by `pushUserContent` in `server/ai/drivers/anthropic.ts`, satisfying Anthropic's strict user/assistant alternation requirement.
- **Browser bridge failures are terminal once.** A browser executor resolving `{ ok: false }` remains an ordinary model-correctable tool outcome. A rejected `callBrowser` is transport failure instead: the loop emits exactly one failed `toolResult`, then one terminal `error`, and does not spend another provider round retrying against the same dead bridge. A missing result still has a 90-second upper bound (`BROWSER_TOOL_TIMEOUT_MS`), but it now ends the turn rather than starting a chain of 90-second retries.
- **Crash on server.** If `runChat` throws, the stream emits `{ type: 'error', message }`. The browser surfaces the message verbatim in the Agent Panel (admin-only surface, so info-disclosure is not a concern).
- **Tool failure.** Browser executors wrap every call in try/catch. Failures return `{ ok: false, error }`. The model reads the error message in the next turn and retries with corrected input.
- **Tool-result delivery failure.** A 404 means the browser completed work for a bridge the active runtime no longer owns (commonly a server restart). While the chat signal is active, `postToolResult` propagates that failure, the client aborts the stale response, finalizes its pending badge, and asks the user to send again. Only a POST already being torn down by an aborted signal is ignored quietly. A clean NDJSON EOF without `done` or `error` is handled the same way instead of being mistaken for success.
- **Page reload mid-stream.** The response cancel hook aborts the provider and releases the writer lock. Conversation rows survive; loading the thread shows any unmatched call once as interrupted, with no reconstructed session-only screenshot and no live timeout/spinner.
- **A turn that never ends (Z3).** The HTTP drivers are bounded by `MAX_TOOL_ROUNDS` (above). The `claudeCli` driver owns no loop of its own — the subprocess does — so it is bounded in wall time instead, by **two differently-shaped timers**:
  - **`idleTimeoutMs` (10 min)** — silence on the child's stdout, re-armed by every chunk. Asks "is this process still alive".
  - **`TOTAL_TURN_CAP_MS` (20 min, `claudeCliSpawn.ts`)** — armed once when the turn starts, never re-armed. Asks "is this turn ever going to end". The idle window is blind to a turn that streams steadily forever, and that blindness IS the "twenty minutes on one page" failure: a model looping over the same edit produces output the whole time, so every chunk re-arms the idle timer and nothing stops it.

  On the cap, the **warm** session sends the CLI's own `interrupt` control request over the open stdin (`claudeCliStdinProtocol.ts` §5) rather than killing anything, drains to the terminating `result` line without forwarding it — post-interrupt output belongs to a turn the user is about to be told ended — and **keeps the process alive** for the next turn, so a capped turn costs the turn and not the session's MCP handshakes. Only an interrupt that goes unanswered for `interruptGraceMs` disposes the session; a wedged process is the one thing a cap may not leave running. The **cold** path has no control channel (its stdin already carried the prompt and closed), so it kills the process.

  Either way the turn ends on one terminal `turnCapped` raw event, which `translateClaudeCliStream` renders as exactly one `error` naming the last tool the turn was on — "it ran too long" alone tells the user nothing they can act on, and a capped turn is usually stuck repeating one tool. `turnCapped` is a distinct raw event from `exit` on purpose: `exit` says the process is gone, and on the warm path it deliberately is not.

  Overridable per turn with the request's `turnCapMs` (1 min – 2 h, validated by `AiChatRequestBodySchema`), on the same session-controls wire as `effort`. Every HTTP driver ignores it: an HTTP turn is bounded by rounds, not wall time.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing any provider SDK (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@openrouter/agent`) | Banned repo-wide — no exceptions, including inside `server/ai/drivers/`. Drivers talk directly to the REST API. Gated by `ai-driver-isolation.test.ts`. |
| Importing `@modelcontextprotocol/sdk` outside `server/ai/mcp/` | The MCP SDK is scoped to Studio's MCP server implementation only. Drivers and browser code must not import it. Gated by `ai-driver-isolation.test.ts`. |
| Importing `zod` anywhere | Banned repo-wide — TypeBox schemas pass directly as JSON Schema to every provider. Gated by `ai-driver-isolation.test.ts`. |
| Writing a private `parseToolArguments` / `parseJsonOrEmpty` copy inside a driver | Import `parseToolArguments` from `./http/toolArgs`. Private copies diverge silently — the same malformed model output produces different outcomes per provider. Gated by `ai-driver-shared-helpers.test.ts`. |
| Redefining `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in a driver or prompt builder | Import it from `server/ai/runtime/types.ts`. One source — if a driver or builder drifts the literal, prompt caching silently breaks for that driver. Gated by `ai-driver-shared-helpers.test.ts`. |
| Routing a write tool as a server-side read (resolving from snapshot) | Write tools are `execution: 'bridge'` — they must go through the bridge. The Site editor store is the write authority. |
| Using invented breakpoint ids in `breakpointStyles` (`"mobile"`, `"desktop"`, etc.) | Use verbatim ids from the dynamic suffix. Invalid ids are rejected by the executor. |

---

## Related

- `docs/features/html-import.md` — the `importHtml` pipeline that `site_insert_html` and `site_replace_node_html` run through
- `docs/editor.md` — agent slice composition inside the editor store
- `docs/server.md` — handler routing; `/admin/api/ai/` is matched before `/admin/api/cms/`
- `docs/features/auth-and-access.md` — capability model (`ai.chat`, `ai.tools.write`)
- Source-of-truth files:
  - `src/core/ai/toolOutput.ts` — `AiToolOutput` type, `AiToolOutputSchema`, `aiToolOk`, `aiToolError` (canonical bridge result)
  - `src/core/ai/chatRequest.ts` — canonical browser-to-server chat envelope and computed multi-image request ceiling
  - `src/core/ai/contentBlock.ts` — persisted/provider content blocks plus the lazy-URL conversation-detail view schema
  - `src/core/ai/userImage.ts` — accepted source formats, normalised JPEG schema, byte/dimension limits, and eight-image per-message bound
  - `src/core/ai/toolSchemas.ts` — all site browser-tool input schemas (single source of truth); includes the flat provider schema and exact execution union required for `site_apply_css`
  - `src/core/ai/documentRefs.ts` — document refs/descriptors for pages, templates, and visual components
  - `src/core/ai/readSurface.ts` — runtime-agnostic `renderAgentDocument` annotated HTML + compact CSS renderer
  - `src/core/ai/index.ts` — barrel re-exporting the above
  - `server/ai/tools/site/writeTools.ts` — 29 browser-bridged site tool definitions (uses `@core/ai` input schemas)
  - `server/ai/tools/site/readTools.ts` — 6 server-side catalog tool definitions
  - `server/ai/tools/site/render.ts` — `describeAgentModules`, `describeAgentTokens`, `filterTokenFamily`
  - `server/ai/tools/site/systemPrompt.ts` — HTML-native system prompt
  - `server/ai/tools/site/snapshot.ts` — `SiteAgentSnapshotSchema` + `SiteAgentSnapshot` re-export + catalog output types (`ModuleInfo`, `SnapshotTokens`, …)
  - `server/ai/tools/index.ts` — `studioTools` + `selectStudioTools(capabilities)`
  - `server/ai/legacyScope.ts` — `LEGACY_SCOPE_COLUMN`, the one permitted `ai_defaults`/`ai_conversations.scope` value
  - `server/ai/inputImages.ts` — server-side base64, JPEG, byte, and dimension validation before persistence
  - `server/ai/drivers/modelCapabilities.ts` — cached, timed, authoritative/fail-closed selected-model capability resolution on every turn
  - `server/ai/drivers/modelList.ts` — bounded provider catalogue lookup with caller cancellation
  - `server/ai/drivers/http/toolLoop.ts` — provider loop, its two ceilings (`MAX_TOOL_ROUNDS` with its wind-down and summary round, and the per-turn write ledger behind `duplicate-call`, both in `toolLoopBounds.ts`), transient retries (`providerRetry.ts`), truncation continuation, the reasoning-parameter fallback, grouped (concurrent-observer) tool dispatch keyed on `sideEffects` (`toolDispatch.ts`), the `input-schema-mismatch` refusal (`toolInputRefusal.ts`, via `execTool.ts`), heavy tool-result elision as a per-request projection (`heavyElision.ts`), message cache-breakpoint policy, and one provider-triggered historical-image fallback
  - `server/ai/drivers/anthropicWire.ts` — Anthropic's request-side block shapes plus the tool-block and message `cache_control` builders
  - `server/ai/conversations/history.ts` — interrupted-tool healing plus outbound user-image replay projection
  - `src/admin/pages/site/agent/siteAgentSnapshot.ts` — `SiteAgentSnapshotSchema` (TypeBox source of truth) + `SiteAgentSnapshot` (derived type) + `buildSiteAgentSnapshot`
  - `server/ai/handlers/chat.ts` — `POST /admin/api/ai/chat` endpoint
  - `server/ai/handlers/conversations.ts` — conversation CRUD plus the ownership-guarded lazy image endpoint
  - `server/ai/handlers/toolResult.ts` — `POST /admin/api/ai/tool-result` endpoint
  - `src/core/ai/toolOutput.ts` — canonical `AiToolOutput` envelope + shared `INTERRUPTED_TOOL_RESULT_ERROR`
  - `server/ai/conversations/store.ts` — `appendMessage`, `listMessagesForConversation`, `readConversationForUser`
  - `server/ai/runtime/runner.ts` — `runChat()` driver loop
  - `server/ai/contextTokens.ts` — `normalizeContextTokens()` — provider-normalised "context used" for the meter
  - `server/ai/pricing/index.ts` — `resolveCostUsd`, `getModelCatalogue`, `computeCostUsd`
  - `server/ai/pricing/openrouterCatalogue.ts` — `fetchOpenRouterCatalogue`, `pricingKey`, `ModelCatalogue`
  - `server/ai/pricing/store.ts` — durable `ai_model_pricing` DB cache
  - `server/ai/runtime/persister.ts` — `ConversationsPersister` interface + `createConversationsPersister()`
  - `server/ai/runtime/types.ts` — canonical `AiStreamEvent`, `AiMessage`, `AiTool`, `ToolContext` types
  - `server/ai/runtime/transport.ts` — `createBridge()` / `resolveBridgeToolResult()`
  - `src/admin/ai/toolResultApi.ts` — browser tool-result delivery; active failures terminate the stale chat turn
  - `src/admin/pages/site/agent/agentApi.ts` — conversation bootstrap + terminal historical tool-call rehydration
  - `src/admin/pages/site/agent/toolCallLifecycle.ts` — live-stream pending-call finalization
  - `server/ai/audit/store.ts` — `getUsageTotals`, `getUsageByUser`, `getUsageByModel`, `getUsageByDay` (usage rollup queries)
  - `server/ai/handlers/audit.ts` — `GET /admin/api/ai/audit` handler
  - `server/time.ts` — `resolveTimeZone` + `localDayKeyFactory` (shared timezone day-bucketing utilities)
  - `src/admin/modals/Settings/sections/AiSection.tsx` — Settings modal AI panel (Providers / Defaults / MCP / Audit tabs)
  - `src/admin/modals/Settings/sections/ai/AuditTab.tsx` — usage audit view (totals strip, tables, daily bar chart)
  - `src/admin/modals/Settings/sections/ai/UsageTablePanel.tsx` — shared table scaffolding for audit rollups
  - `src/admin/ai/usageFormat.ts` — shared `formatNumber` / `formatCost` helpers
  - `src/admin/pages/site/agent/agentSlice.ts` — slice factory (`createAgentSlice`)
  - `src/admin/pages/site/agent/agentProviderUpdate.ts` — timed provider/model update and ambiguous-commit reconciliation
  - `src/admin/pages/site/agent/agentSliceConfig.site.ts` — site-editor config
  - `src/admin/pages/site/agent/agentApi.ts` — conversation bootstrap and message rehydration
  - `src/admin/pages/site/agent/streamEvents.ts` — `ServerStreamEventSchema` + `processStreamEvent`
  - `src/admin/pages/site/panels/AgentPanel/AgentImageGallery.tsx` — shared compact gallery for persisted and session-only images
  - `src/admin/pages/site/panels/AgentPanel/AgentImagePreview.tsx` — draggable modeless image preview
  - `src/admin/pages/site/panels/AgentPanel/AgentImageContextMenu.tsx` — shared image actions menu
  - `src/admin/pages/site/panels/AgentPanel/agentImageActions.ts` — clipboard, download, and Media-save pipeline
  - `src/admin/shared/FloatingWindow/` — shared portal, panel header, and persisted drag behavior for admin floating windows
  - `src/admin/pages/site/agent/pageContext.ts` — `buildCurrentPageContext`
  - `src/admin/pages/site/agent/executor.ts` — write-tool browser dispatcher + auto-navigation
  - `src/admin/pages/site/agent/tokenRunners.ts` — design-system token tool runners (`site_set_color_tokens`, `site_set_font_tokens`, `site_set_type_scale`, `site_set_spacing_scale`)
  - `src/admin/pages/site/agent/agentConfig.ts` — API path constants
  - `src/admin/pages/site/agent/renderEvidence.ts` — `captureAgentRenderSnapshot`
  - `src/admin/pages/site/agent/types.ts` — `ServerStreamEvent`, `AgentMessage`, `AgentRequestBody`, …
  - `src/admin/pages/site/agent/index.ts` — public barrel
  - `src/admin/pages/site/panels/AgentPanel/AgentComposer.tsx` — resolves model window/pricing/capabilities and places the meter in the action row
  - `src/admin/pages/site/panels/AgentPanel/ContextMeter.tsx` — five-segment context status and rich usage tooltip
  - `src/admin/pages/site/panels/AgentPanel/contextMeterMetrics.ts` — exact five-band fill/tone calculation
- Gate tests:
  - `src/__tests__/architecture/ai-tool-input-object.test.ts`
  - `src/__tests__/architecture/ai-tool-schema-ssot.test.ts`
  - `src/__tests__/architecture/ai-driver-isolation.test.ts`
  - `src/__tests__/architecture/ai-tools-typebox-only.test.ts`
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
  - `src/__tests__/architecture/ai-driver-shared-helpers.test.ts`


## Sessions per (account, project) — W10

The user's ask: "I want the agent sessions to be per project, and per account, not all shared across everything." Per-USER isolation was already correct server-side; per-PROJECT did not exist.

**A conversation belongs to one project.** `ai_conversations.project_key` (migration 022, both dialects, nullable, **no backfill**) holds `registeredMcpServerProjectKey(dir)` — the same key MCP OAuth sessions and registered-server secrets use, derived in exactly one place (`server/ai/conversations/projectScope.ts`) from a dir that has already passed `resolveValidatedWorkspaceDir`. `null` is the honest "not project-scoped": every thread created before the column existed, and every thread started with no project open. `GET /admin/api/ai/conversations?dir=` returns that project's threads **plus** the null ones, so nothing vanishes; the create route stamps the key; `chat.ts` answers **409** for a turn whose project disagrees with a stamped key and adopts a null one on first use (the `project_key is null` predicate lives in the UPDATE, so two racing tabs cannot double-stamp). A turn with no project open cannot contradict a stamped thread and passes through unchanged.

**One derivation on the client too.** `agentProjectDir()` (`src/admin/pages/site/agent/agentProjectDir.ts`) reads `useAdminUi`'s `studioProject.dir` — the dir the server reported it actually LOADED, deliberately not `studioWriteDir()`, whose localStorage override can name a project the server did not honour. The conversation stamp, the chat turn's `workspaceDir`, and the editor bridge's `dir` all come from it, so they cannot disagree.

**Per-account caches inside a shared project.** `turnWrites.json` and `pageVerification.json` moved from `.studio/cache/` to `.studio/cache/agent/<userKeyHash>/` (`server/handlers/studio/agentUserScope.ts`). Both are disposable derived caches — regenerable, already gitignored, a missing file reads as empty — so this is a path change, not a migration. It closes a real bug: user A's writes were satisfying and blocking user B's Stop gate. The key is a truncated SHA-256 of the user id (the directory name lands in the user's own working tree), and it reaches the `Stop`/`PostToolUse` hook subprocesses through the `STUDIO_AGENT_USER_KEY` environment variable `claudeCli.ts` sets on the CLI — **not** through the generated hook command, because `.claude/settings.local.json` is one file shared by every user of the project. The git panel's "agent-authored" marker reads `readAllTurnWrites` (every account's log), because that flag is a fact about the file in the working tree, not about who is looking. **Design references and design variables deliberately stay project-shared** — they describe the design, not a session.

**The warm CLI pool.** Keyed `${userId}\0${conversationId}`, with `userId` also in the reuse fingerprint (belt and braces: the fingerprint is what answers "may this process honestly serve this turn", and a process holding another user's config dir and connector token may not). A per-user cap of **2** sits under the global 8, so one busy user with several tabs cannot evict everyone else's warm session. The attachment staging root is `sha256(userId + '\0' + conversationId)`.

**The `dir` escape, closed.** `resolveProjectDir` used to be a bare `resolve()` — `dir` is client input on ~70 routes and every Studio MCP tool, so an agent in project A could name project B or any absolute path at all. It now containment-checks against `projectsRootDir()` with symlinks resolved on both sides (`isRealpathContainedAllowingMissing`, so a not-yet-created project still passes), throwing `ProjectDirOutsideWorkspaceError`; `server/router.ts` turns that into one flat 404 for every route at once, and any route-local `catch` that renders errors into responses calls `rethrowProjectDirRefusal(err)` first so it is not flattened into a route-local 500. The error carries the offending path as a **field**, never in `message`, so no catch-all can echo it back. Separately, a **workspace-bound** connector (the in-canvas agent, whose project `chat.ts` has already validated) may only ever name its own project — an explicit `dir` for a different one raises `ProjectDirMismatchError`. Unbound external MCP clients keep the permissive behaviour: naming the project is the only way they can address one.

**The history popover.** `ConversationHistory` passes the open project's dir to the list call, renders that project's threads, and puts the unscoped ones under a collapsed **"Not in this project"** group so nothing disappears. Opening one and sending stamps it with the project it was continued in. With no project open the list is flat.
