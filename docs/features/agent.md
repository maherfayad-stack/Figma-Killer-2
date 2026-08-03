# AI Agent

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
├── ModelPicker.tsx         — credential + model selector used in the input bar
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
  [--mcp-config <path to a private 0600 temp file>] --strict-mcp-config
  --session-id <uuid> | --resume <uuid>
```

`--mcp-config`'s value is a filesystem path, not inline JSON — see the "MCP tool routing" paragraph below for why.

**Native tool surface.** The spawned session used to carry NO `--tools`/`--allowedTools` restriction at all — the top-level `claude` process could reach every native built-in directly, bypassing the containment checks the MCP tools enforce. `resolveNativeToolAllowlist` (`claudeCliToolSurface.ts`) now computes the allowlist fresh per turn and never omits the flag: `Read,Write,Edit,Glob,Grep` when a real, containment-checked project is open (the agent's authoring path — see "The agent authors files" below); `Read` alone when no project is open but this turn staged an attachment; `''` otherwise. `Bash` and `Task` are withheld unconditionally, on every turn, at every trust tier, in every permission mode — trust tiers gate MCP-mediated capabilities like `studio_install_deps`, and neither has ever gated a raw shell. What bounds a native write is the process, not the tool list: `cwd` is the validated project directory, and the CLI refuses a write outside it plus whatever `--add-dir` pre-authorises (this turn's attachment staging directory, nothing else). `--tools` is a hard availability list, independent of and prior to `--permission-mode`, so it holds even under a user-selected `bypassPermissions`.

**Workspace `cwd` (step 2).** A real chat turn spawns in the resolved, containment-checked project directory — `resolveClaudeCliWorkspaceCwd(req.workspaceDir, projectsRoot)` (`claudeCliEnv.ts`), fed from `useAdminUi`'s open `studioProject.dir` through `agentSlice.ts` → `AiChatRequestBody.workspaceDir` → `AiStreamRequest.workspaceDir`. This is what makes `.claude/agents/*.md` auto-discovery, `CLAUDE.md` discovery, and the tools' own view of the project work at all — spawn in the wrong place and the project's generated `CLAUDE.md` silently doesn't reach the agent — and, since the agent's file tools are bounded by `cwd`, nothing it writes lands in the right project either. Containment mirrors `appRoot.ts`: both the requested path and the projects root are resolved through `realpathSync` before the prefix check, so a symlink pulled in from a GitHub import can't escape it. No workspace open, or containment fails → falls back to the per-user `CLAUDE_CONFIG_DIR` (a documented degraded case, not a crash). The availability **probe** always stays in the config dir — it must never risk a real project's `CLAUDE.md` cache-creation cost (see the cost warning below).

**Multi-turn continuity (step 2).** `--input-format stream-json` exists (confirmed via `--help`) but its stdin message shape was never verified against the binary — establishing it with confidence would mean sending a real paid turn, which this driver's tests must never do. Instead the driver uses the CONFIRMED `--session-id`/`--resume` pair, keyed by a UUID **deterministically derived** from the Studio conversation id AND its `session_epoch` (`claudeCliSession.ts`'s `claudeCliSessionId(conversationId, epoch)`, SHA-256 truncated to 16 bytes with RFC 4122 version/variant bits set) — the same `(id, epoch)` pair always hashes to the same UUID, so there is still no stored UUID, only the epoch counter (migration 021's `ai_conversations.session_epoch`, `not null default 0`). **Epoch 0 hashes `conversationId` alone — byte-identical to the pre-epoch function** — so this never orphans a live installation's already-running CLI sessions; only a bumped epoch changes the derived id (pinned by an independently-computed test fixture in `claudeCliSession.test.ts`). `req.messages` is still only consulted for the latest user message's text (the `-p` prompt) — the CLI's own session file remembers the rest, not a replayed `AiMessage[]` log the way every HTTP driver in this directory does it.

**Establish vs. resume is a filesystem probe, not a message count.** The original `isFirstClaudeCliTurn` heuristic (message count ≤ 1 → establish) broke the instant "Restart agent session" (below) existed: after a restart the conversation has plenty of replayed history, but the bumped epoch derives a UUID the CLI has never seen, so `--resume` would fail outright. `shouldEstablishClaudeCliSession(configDir, cwd, sessionId)` asks the real question instead — does the CLI already have a transcript file for this exact `(configDir, cwd, sessionId)`? Reverse-engineered (not documented in `--help`) from real transcripts the installed binary wrote on the coordinator's own machine, both under a normal `~/.claude/projects/` and under a `CLAUDE_CONFIG_DIR` override (the exact override this driver sets on every spawn): `<configDir>/projects/<sanitized cwd>/<sessionId>.jsonl`, where the sanitized `cwd` replaces every character that is not `[A-Za-z0-9]` with a single `-` (`claudeCliProjectDirName`). As a side effect this self-heals cases the message-count check never could — a cleared/rotated config dir, a server redeploy onto a fresh volume, or a workspace `cwd` change between turns all leave no transcript for the current pair, so the turn correctly re-establishes rather than sending a `--resume` the CLI would reject. If a future CLI version ever changes this layout, the failure mode is graceful (every turn reads as "no session found" and always establishes — never a resume of something nonexistent, and `ai_messages` stays the durable transcript regardless); the documented fallback if this probe ever proves unreliable is to stop guessing at the CLI's layout and thread the epoch-bump point through explicitly instead.

**Restarting the agent session (`session_epoch`, migration 021).** `POST /admin/api/ai/conversations/:id/restart-session` (`server/ai/handlers/conversations.ts`'s `handleRestartSession`, gated by the same `ai.chat` capability as every other conversation route, owner-checked, 409 if a turn is currently streaming for that conversation) increments `session_epoch` via `bumpSessionEpochForUser` (`conversations/store.ts`). The next turn's `claudeCliSessionId` therefore derives a brand-new UUID, and `shouldEstablishClaudeCliSession` correctly reads that as "no session found" and establishes fresh — re-reading newly-approved MCP servers (`projectMcpServers.ts`'s `approvedMcpServers`) and any other per-spawn config, without touching the conversation row, its messages, or its title. `AgentSessionControls.tsx`'s `RestartSessionButton` is the UI: an icon button next to the permission-mode trigger, disabled while streaming or with no active conversation yet, always states in its tooltip/`aria-label` that it starts a fresh CLI session while keeping this chat's history, and reports success/failure via `pushToast`. Every non-`claudeCli` driver ignores `AiStreamRequest.sessionEpoch` entirely, so bumping it against a conversation on another provider is a harmless no-op.

**`--effort`/`--permission-mode` (step 2).** `--effort` ships wired with a fixed default (`medium`) — a real, explicitly requested requirement, not a nicety, even though no session-controls UI exists yet (WS-12 §5.2 owns that). `--permission-mode` accepts exactly WS-12 §5.2's four modes (`default | acceptEdits | plan | bypassPermissions`) plus `auto`/`dontAsk` (confirmed via `--help`) — a 1:1 mapping with no translation layer whenever that UI ships. Only `'default'` is used today. **`bypassPermissions`/`--dangerously-skip-permissions` is never passed by this driver, under any condition** — that is a hard constraint, not a default that could be flipped by a future options object.

**MCP tool routing (step 3).** `req.tools` (Studio's generic `AiTool[]` list) is never forwarded to the CLI directly — it wouldn't mean anything to it. Instead, before spawning, `server/ai/mcp/sessionConnector.ts`'s `mintClaudeCliSessionConnector()` mints a fresh MCP connector scoped to the caller's own capabilities (privilege-floor rule: never more than the caller holds) with a 1-day TTL floor, by calling the connector store directly rather than the admin `handlers/connectors.ts` endpoint — that endpoint requires `requireStepUp` (a fresh-MFA-like re-auth), which is designed for a human consciously minting a long-lived credential, not a server minting one per chat message. `buildMcpConfig` assembles `{"mcpServers":{"studio":{"type":"http","url":"http://127.0.0.1:<port>/_studio/mcp","headers":{"Authorization":"Bearer <token>"}}}}` — Studio's own `/_studio/mcp` endpoint, on this same running process — but the subprocess is launched with `--mcp-config <path>`, NOT that JSON inline: `writeMcpConfigFile` (`claudeCliMcpConfigFile.ts`) serialises it to a file created with mode 0600 at open time (never chmod'd after — that would leave a window where the file is briefly wider than 0600) inside a fresh 0700 `os.tmpdir()` directory, and the driver's own `finally` block deletes that directory unconditionally when the turn ends — success, error, or the subprocess killed on abort. This exists because `ps -eo command` prints a process's full argv to any local process, no privilege required; an inline `--mcp-config` would print this bearer token — and, once a project/registered server is approved, a real third-party secret like a Figma PAT — to that output in plaintext, silently defeating `mcpServerSecretStore.ts` encrypting the exact same values at rest. So the CLI's own MCP client discovers Studio's real toolset through the SAME `(userId, scope)` live editor bridge an external Claude Code connector uses (see `mcp-connectors.md`), with zero duplicated tool-routing code, and without the secret ever touching argv. `--strict-mcp-config` is **mandatory** whether or not a connector was minted: without it the CLI merges the user's own `~/.claude.json` and the project's `.mcp.json` and connects to whatever it finds there — Studio ships exactly the toolset it intends and no more. The token is revoked in a `finally` block when the turn ends — scoped to and expiring with the single turn, never reused. If minting fails (a transient connector-store hiccup) or the config file can't be written, the turn degrades to tools-less rather than failing outright — the same fail-soft posture step 1 shipped with.

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

**The agent edits the project with ordinary file tools.** `resolveNativeToolAllowlist` (`claudeCliToolSurface.ts`) grants `Read,Write,Edit,Glob,Grep` whenever a real, containment-checked project is open, and the subprocess is spawned with `cwd` set to that project directory — which is what bounds them. `Bash` is never granted, at any trust tier, in any permission mode; nor is `Task`, `WebFetch`, `WebSearch`, or `NotebookEdit`. With no project open the allowlist is `Read` (only when this turn staged an attachment) or `''`.

This replaced composing screens exclusively through `studio_apply_edits`' AST insert engine. That was safe and unusably slow: each insert reparses the file and shifts every node id, so the agent re-read the world between elements. **One mobile screen cost over twenty minutes** and routinely landed broken — the path of least resistance through a typed-edit API is one giant inline `style={{…}}` rather than a real stylesheet, because that is the shape the API rewarded. A screen is a component file and a stylesheet; authoring one is two `Write` calls.

The AST edit engine did not go anywhere. `studio_apply_edits`/`studio_codemod` are still what the canvas PANELS write through (`studioWriteback.ts`), and still what an external MCP client with no filesystem access to the project uses. They are simply not part of the in-canvas agent's surface.

**`--permission-mode` defaults to `acceptEdits` when a project is open** (`claudeCliPermissionMode.ts`), `default` otherwise. Under `default` the CLI stops and asks before every file write, which Studio relays as an Allow/Deny card — a dozen identical questions to author one screen, each asking permission to do the thing the user just asked for. `acceptEdits` auto-accepts edits inside the working directory and nothing beyond it. Every other permission-bearing tool still prompts, and trust tiers are untouched (`studio_install_deps` reads `.studio/meta.json`, never the permission mode). An explicitly requested mode always wins.

### No subagents

`Task` is withheld outright. The CLI does **not** error on an unknown `subagent_type` — it silently falls back to its own built-in `general-purpose` agent and returns as if the work had happened. Observed exactly that way: the agent delegated screen authoring to an invented name, reported ten files written in detail, and every one was still an untouched scaffold. Studio used to generate an eleven-agent roster into `<project>/.claude/agents/` and spend a prompt paragraph warning the model not to invent a name; that only narrowed the odds. Removing the tool makes the failure unreachable. With native file tools there is nothing a screen-building subagent adds but latency.

Gated by `src/__tests__/architecture/studio-agent-no-subagents.test.ts`: the driver never grants `Task` or `Bash` on any turn shape, and the prompt never advertises delegation.

### The project's generated guide — `server/handlers/studio/projectGuide.ts`

What the roster's prompts carried now lives in files the CLI loads for free from its cwd. `generateStudioProjectGuide(dir)` runs once per real chat turn, right before the subprocess spawns, and writes:

| File | Contents |
|---|---|
| `CLAUDE.md` (project root) | This project's pages directory, file extension, styling mechanism and component packages; the build-look-fix loop; the design-system rule; "do not ask before building". Loaded before the agent's first tool call — zero round trips, cached across turns. |
| `.claude/design-system-components.md` | The installed design system's real component API — every component's own props block plus its one-line intent, extracted from the package's own docs (`designSystemGuide.ts`). |
| `.claude/design-system.md` | The token/BEM-class digest built from the project's own CSS (`designSystemDigest.ts`), for design systems that arrived as plain CSS with no package docs. |

**Why the component reference exists.** The observed failure was never that the agent refused to use the design system — it imported `Button` and `TextInput` happily. It was that it did not know what else existed, so a back button became the literal character `‹`, four feature rows became emoji (`✈ 🗓 🏷 ⚡`), and a media slot became a grey `<div role="img">` — in a project whose installed package ships `GlassButton`, `ListItem`, `Cell`, `VisualCard` and a full line-icon set. Discovering that vocabulary cost a tool call the agent had no reason to make, against a catalog extractor that returns nothing for this package anyway (`studio_list_components` reads `.d.ts` declarations; ALM ships bundled untyped JS). The package's own docs say all of it plainly and are simply too large to read whole (~103 KB / ~106 KB). So Studio reads them server-side, once per regeneration, and keeps the two parts that matter: `design.md`'s **Component Decision Map** (inlined into `CLAUDE.md` — it is what answers "which component") and each `### <Name>` section's props block (written to the reference file).

**The import specifier is generated, never copied.** The ALM package's own `CLAUDE.md` documents `import { Button } from 'design-system'` — the name it uses in its own monorepo, not the name it publishes under. Embedding that verbatim would have taught the agent an import that resolves to nothing and breaks the user's build. `buildImportContract` builds the block from the package name Studio knows from the project's dependencies plus the package's own `exports` map (the stylesheet line is emitted only when a `.css` export actually exists).

**Regeneration never clobbers a user edit (trap #12).** `.claude/.studio-generated.json` (owned by `projectGuideManifest.ts`) records the hash, size and mtime of what Studio last wrote for each file. A file is overwritten only while its on-disk content still matches that hash — a hand-edited `CLAUDE.md`, which a user has every reason to make their own, is left alone and reported `skipped`. Files the old roster wrote simply stop being targets; they are deliberately not deleted.

**The warm path is gated, not rebuilt.** Two cheap independent checks, both required: `computeProjectGuideFingerprint` (profile + design-system CSS stat key + package-docs stat witness + `mcpServerFingerprintWitness` + a definition version — a match proves the output is byte-identical to last time) AND `allOwnedFilesUnchangedSince` (a `statSync` per target against the recorded size/mtime — the clobber-protection half, since the fingerprint only covers INPUTS). `GUIDE_DEFINITION_VERSION` must be bumped whenever a generated file is added or removed, or every existing project keeps serving stale output behind the fast path.

### The Studio prompt (`server/ai/tools/studio/systemPrompt.ts`)

Same cacheable 3-element form as the CMS prompt. Its job shrank to what a general-purpose coding agent would not already know: where sight comes from (`studio_screenshot`, and the write-look-fix loop), the bias toward acting rather than surveying and asking, where the design system's boundary is (import a component when one exists; otherwise the smallest plain element styled with the system's own tokens — an emoji is never an icon), and the two canvas invariants (parse-never-execute, one honest write target). Everything project-SPECIFIC lives in the generated `CLAUDE.md` above rather than being duplicated into a prompt on every turn.

The "Tools available" line is exactly `STUDIO_AGENT_TOOL_NAMES` (`agentToolNames.ts`, the same list `index.ts` resolves into real `AiTool` objects), so the prompt cannot advertise a tool the agent is not offered.

The dynamic suffix carries the project profile, trust tier, and the live board/selection/fidelity digest (`liveDigest.ts`).

### The Studio toolset (`server/ai/tools/studio/index.ts`)

`studioAgentTools` is an explicit **subset** of the MCP registry — 19 tools, not ~35 plus the entire CMS `site_*` set. Two things were wrong with serving everything: most of it is now dead weight (every tool that existed only because the agent had no filesystem is strictly slower than the native equivalent), and a large toolset is itself a latency and accuracy cost — definitions are re-sent every turn, and a model choosing among ~60 tools explores instead of acting.

What survives is what the filesystem cannot do: see the canvas (`studio_screenshot` and the reference/diff family), change board geometry and per-frame axes, read the project's tokens and component catalog, install dependencies behind the trust-tier gate, and pull assets in. The list is written out by name in `agentToolNames.ts` so adding a tool to the registry does not silently widen the agent's surface; `index.ts` throws at module load if a name no longer resolves.

`mcpToolsForStudioWorkspace` (`server/ai/mcp/registry.ts`) applies the same subset at the MCP server: a connector **bound** to a Studio project (`connectorWorkspace.ts` — in practice the per-turn connector `claudeCli.ts` mints) sees only `studioAgentTools`. An unbound connector — a plain external MCP client — still sees the full registry, including the AST edit tools it genuinely needs.

**Deliberately withheld from every tool, no exceptions:** a shell, and trust promotion. An agent may *ask* the user to promote a project's trust tier; it may never perform the promotion itself.

### `studio_screenshot` — the agent's eyes

`server/ai/mcp/tools/studio/screenshot.ts`. Nothing watches the workspace directory, so a freshly written page is real, parseable, and completely invisible until three things happen in order. This tool is those three things in one call, deliberately — an agent that has to remember a three-step ritual before every look will skip it, and a partial ritual produces a stale image that reads as evidence:

1. **Reconcile the board with disk** — `syncBoardFramesFromDisk` (`pageScaffold.ts`) places a frame for every page file that lacks one. Additive and idempotent: an existing frame keeps its position and size, and a frame whose file was deleted is left alone (removing frames is a destructive board edit that belongs to the user).
2. **Wait for the canvas to re-read** — `awaitStudioLiveReload` (`liveReloadPush.ts`), awaited rather than fire-and-forget, because capturing first photographs the previous version of the file.
3. **Capture** — relay to the browser-side `studio_export_frames` handler over the live editor bridge and return its PNGs as MCP image blocks.

Pages are selected **by name**, not by page id: `"Checkout"`, `"Checkout.tsx"`, `"pages/Checkout.tsx"` and the raw id all resolve to the same frame (`pageKey` applies the same kebab derivation `pageIdFromRelPath` uses to both sides, so multi-word names like `AddMobile` → `add-mobile` match). Omitting `pages` captures the whole project. `studio_export_frames` still exists and still does step 3 alone, for external clients that manage their own board.

### Session controls — model, effort, mode, attachments (WS-12 §5)

**Model** — `ModelPicker.tsx`, populated live from each provider (no hardcoded list). **Effort** and **mode** are `AgentSessionControls.tsx`, above the composer: `--effort` (`low|medium|high|xhigh|max`) and `--permission-mode` (`default|acceptEdits|plan|bypassPermissions`), both request-driven end to end (`chatRequest.ts` → `AiStreamRequest` → `claudeCli.ts`'s argv), request-body fields every non-`claudeCli` driver ignores.

**Bypass mode is real, resolved from an earlier, mistaken refusal.** An initial pass refused `bypassPermissions` outright, reading this driver's "never pass a permission-bypassing flag" rule as covering the literal value under any circumstance. The coordinator who set that rule resolved the contradiction directly: the rule means Studio must never INJECT a bypassing flag on its own — no silent default, no working around a prompt the user would otherwise see. A user deliberately selecting Bypass IS the consent, not something that rule forbids. `--dangerously-skip-permissions`/`--allow-dangerously-skip-permissions` (a different, blunter flag) remain permanently, unconditionally forbidden — this driver's argv never constructs either, checked or not.

D5 §11.5's three guard rails, each owned by exactly one piece of code, each independently tested:

1. **Non-persisting** — `agentSlice.ts` initializes `agentPermissionMode: 'default'` at store creation (covers reload); `AgentSessionControls.tsx` also resets it on a live Studio-project switch via a `useAdminUi` effect (covers switching without a remount). Nothing anywhere reads or writes it to storage — `.studio/meta.json`'s `agentSession` schema has no field for it at all, so there is nowhere to persist it even by accident.
2. **Visibly indicated while active** — the mode trigger itself (in the composer's own control row, `AgentSessionControls.tsx`) switches to the `danger` tone — foreground text/icon plus a warning glyph and a descriptive accessible name, never a filled block — for as long as `agentPermissionMode === 'bypassPermissions'`. An earlier filled-banner design was rejected for reading like a settings form bolted onto the composer; the current shape sits in the control row (not the scrollable message thread, so it can't scroll out of view) and is permanent, not a one-time toast.
3. **Still trust-tier-bound** — Bypass has zero effect on tool-level authorization. `studio_install_deps`'s trust check (`projectTools.ts`) reads only `.studio/meta.json`'s `trust` field; the tool call has no permission-mode parameter for a mode to influence in the first place. Tested explicitly (`projectTools.test.ts`): a tool call carrying `permissionMode: 'bypassPermissions'` in its input is refused at Tier 0 exactly the same as one that doesn't.

`resolvePermissionMode` (`claudeCli.ts`) resolves the request; a second, independent `assertBypassOnlyFromExplicitRequest` sits at the literal argv-construction site and throws if `bypassPermissions` would ever reach argv WITHOUT the original request itself having named it — belt-and-braces against a future default/inference path reintroducing it silently.

**Effort persists per project** (D5) — `.studio/meta.json`'s `agentSession.effort`, round-tripped through `GET/POST /admin/api/ai/studio-session` (`server/ai/handlers/studioAgentSession.ts` — lives under `server/ai/handlers/`, not `server/handlers/studio/`, specifically so it needs no change to `studio.ts`'s own sub-router array). Mode is never accepted by this route's request schema at all — the same "nowhere to write it" enforcement as the store-level rail above.

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

**The reasoning/thinking block (§5.4) is implemented defensively and is UNVERIFIED against a real CLI turn.** `claudeCliEvents.ts`'s translator watches for `type: "stream_event"` lines wrapping a `content_block_delta` whose `delta.type === "thinking_delta"`, emitting a `reasoning` `AiStreamEvent` with the accumulated `delta.thinking` text. This shape is written against the DOCUMENTED Anthropic Messages streaming vocabulary, not observed on the wire — no paid turn was spent confirming it, matching WS-11's own test-discipline rule (tests never spawn the real binary). `--include-partial-messages` was added to `claudeCli.ts`'s argv (required for the CLI to emit `stream_event` lines at all); every event shape this translator doesn't recognise already falls through to a no-op default case, so if the real shape differs, nothing breaks and no reasoning block ever renders — the failure mode is silence, not a broken stream. On the browser side, a `reasoning` block renders as its own collapsed `<details>` row (`ReasoningRow.tsx`, next to `ToolCallRow.tsx`), chronologically ordered against `text`/`toolCall` blocks the same way tool calls already are; it is display-only and never persisted to conversation history (same posture as `context`). **The next person who touches this should run one real turn against the CLI with a prompt likely to trigger extended thinking and confirm whether a `reasoning` block actually renders** — that observation still hasn't been made.

### Canvas parity matrix (WS-12 §6.1/§9)

`server/ai/tools/studio/parityMatrix.ts` is the enforcement mechanism for "the agent can do what you can do in the canvas" — not documentation. Every real editor action resolves to exactly one status: a real tool (name-checked against the live registry), an explicitly withheld action (a stated reason — undo/redo, viewport pan/zoom, trust promotion, project deletion, a shell tool, a raw file-overwrite), or a confirmed gap. `parityMatrix.test.ts` gates all of it, including the inverse direction (every registered mutating tool is referenced by at least one row — an orphaned tool is itself a finding), plus a regression test pinning the current gap count so a future "missing" row silently downgraded to "withheld" fails loudly.

**The three gaps the matrix found are now closed** — each is a thin `execution: 'browser', scope: 'site'` wrapper (`server/ai/mcp/tools/studio/browserBridgeTools.ts` declares them; `src/admin/pages/site/agent/studioBrowserBridgeTools.ts` runs them) over the SAME verb the canvas UI already calls, dispatched through `executor.ts` exactly like `studio_export_frames`:

| Editor action | Tool | Wraps |
|---|---|---|
| Upload a new image asset into the project | `studio_upload_asset` | `POST /admin/api/studio/asset-upload` — decodes the agent's base64 into a `Blob`, posts real `FormData`; every validation (magic-number sniffing, containment) happens server-side exactly as it does for a human upload. |
| Set a board frame's preview axes (direction/locale/color-scheme) | `studio_set_frame_axes` | `EditorStore.setFrameAxes` — the same action the toolbar's own preview-axes control calls. |
| Duplicate a board frame as a variant | `studio_duplicate_frame_as_variant` | `EditorStore.duplicateFrameAsVariant` — the side-by-side comparison verb. |

Both new tools address a frame by `pageId` (the id every other Studio tool already returns) with an optional `frameId` to disambiguate when a page has more than one frame on the active board — no existing tool exposes a raw `frameId` for an agent to pass in otherwise, so `pageId` + "first match on the active board" is the default resolution rule.

The matrix now has **zero `missing` rows** — every editor action a Studio project agent needs is either a real tool or explicitly, permanently withheld with a stated reason (trust-tier promotion, undo/redo, viewport pan/zoom/marquee, project deletion, a raw shell command, a full-file overwrite — see the six `withheld` rows in `parityMatrix.ts` for why each one stays that way on purpose).

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
    │       – e.g. runInsertHtml → importHtml(html) → insertImportedNodes(parentId, …)
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

### Site browser tools — 29, browser-bridged

All 29 tools carry `execution: 'browser'` in their `AiTool` definition. The server emits `toolRequest`; the browser executor validates input with TypeBox, runs the store action or read helper, and POSTs the canonical `AiToolOutput` result back.

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
5. **Stale evidence is elided.** Within one tool loop, only the **most recent** heavy result per tool name (`site_render_snapshot`, `site_read_document`, `site_get_node_html`, or anything with an image) is replayed at full fidelity; earlier ones are rewritten to a one-line breadcrumb (`"Earlier <tool> output removed… Call <tool> again…"`). Older snapshots describe page state the model has since mutated, so they carry no value. See `applyHeavyElision` in `server/ai/drivers/http/toolLoop.ts`.

Snapshot pixels come from the iframe document's authored rendering. Full-page captures rasterise `<html>` at the exact iframe viewport width and full document height, so a narrow/transformed body cannot shrink the reported viewport or omit document gutters. Node-scoped captures rasterise that same document painting context and crop to the node rectangle, so transparent sections retain HTML/body/ancestor colors, gradients, and background images. A white browser-default fallback is composited only behind pixels the authored page leaves transparent — it is never written onto the cloned document.

Every request uses `AgentSnapshotFrame`, an offscreen one-shot `IframeFrameSurface` at the configured width. Before it becomes capturable, a revisioned barrier waits for template preview rows, nested loop data, media metadata, web fonts, the resulting React commit, and a quiet DOM window. Readiness lives on the host iframe, never on authored `<html>`/`<body>`, so user attribute selectors cannot distinguish Agent evidence from the published page. Lazy `<img>` resources are left authored as-is; `html-to-image` makes its private clones eager and embeds image/background resources before `toCanvas()` resolves. The frame deliberately does not execute authored runtime scripts, and it is released after capture without changing `activeBreakpointId`, `canvasView`, or collapsed-frame state. Parallel requests are serialized so they cannot replace the single transient frame mid-capture.

---

## System prompt

`server/ai/tools/site/systemPrompt.ts` builds a 3-element array:
```ts
[staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]
```
Drivers that support explicit prompt-cache controls (Anthropic) apply `cache_control` to the static prefix automatically. OpenAI concatenates the prompt parts and sends a stable `prompt_cache_key` derived from the toolset so repeated prefixes route more consistently. Other drivers concatenate the three strings. Content is intentionally static across providers — every observable behaviour comes from the tool definitions, not prompt knobs.

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is the literal `'__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'`, declared **once** in `server/ai/runtime/types.ts` and imported everywhere — prompt builders and every driver. A duplicate definition would silently break prompt caching on whichever driver drifted. Gated by `ai-driver-shared-helpers.test.ts`.

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
The static prefix is cache-friendly (unchanged across prompts for the same provider). Anthropic marks only that prefix with `cache_control`; OpenAI relies on automatic prefix caching plus `prompt_cache_key`. The dynamic suffix carries per-request state. The `Tokens —` digest is a compact, always-inlined summary of the site's design tokens (`describeAgentTokens(snap.site)`) so the agent sees the design system every turn without a `site_list_tokens` round-trip; when no tokens exist it reads `Tokens: (none — no design system yet; establish one first …)`. `site_list_tokens` remains the on-demand full-detail read (variants, utility classes).

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

Providers may enforce a physical request, context, or routed image limit before accepting that full replay. The shared HTTP tool loop classifies only those explicit overflow responses (`413`, or a matching provider `400`) and retries once before any SSE or tool side effect: images on older user turns become one breadcrumb per turn, while every image on the newest/current user turn remains. Generic 400s, authentication, quota, rate-limit, and service failures are never retried. If the reduced request still fails—or only the current turn has images—the error explains that history remains saved and suggests a new conversation or a larger-context model. This is provider-triggered fallback, not a stored-image quota or an arbitrary app-side count.

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

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing any provider SDK (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@openrouter/agent`) | Banned repo-wide — no exceptions, including inside `server/ai/drivers/`. Drivers talk directly to the REST API. Gated by `ai-driver-isolation.test.ts`. |
| Importing `@modelcontextprotocol/sdk` outside `server/ai/mcp/` | The MCP SDK is scoped to Studio's MCP server implementation only. Drivers and browser code must not import it. Gated by `ai-driver-isolation.test.ts`. |
| Importing `zod` anywhere | Banned repo-wide — TypeBox schemas pass directly as JSON Schema to every provider. Gated by `ai-driver-isolation.test.ts`. |
| Writing a private `parseToolArguments` / `parseJsonOrEmpty` copy inside a driver | Import `parseToolArguments` from `./http/toolArgs`. Private copies diverge silently — the same malformed model output produces different outcomes per provider. Gated by `ai-driver-shared-helpers.test.ts`. |
| Redefining `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in a driver or prompt builder | Import it from `server/ai/runtime/types.ts`. One source — if a driver or builder drifts the literal, prompt caching silently breaks for that driver. Gated by `ai-driver-shared-helpers.test.ts`. |
| Routing a write tool as a server-side read (resolving from snapshot) | Write tools are `execution: 'browser'` — they must go through the bridge. The Site editor store is the write authority. |
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
  - `server/ai/drivers/http/toolLoop.ts` — provider loop, heavy tool-result elision, and one provider-triggered historical-image fallback
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
