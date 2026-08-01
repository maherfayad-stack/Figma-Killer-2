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
├── ModelPicker.tsx         — credential + model selector used in the input bar
├── ConversationHistory.tsx — history popover (browse, restore, delete past threads)
├── ContextMeter.tsx        — compact five-segment context + conversation-usage tooltip
├── ContextMeter.module.css
├── contextMeterMetrics.ts  — five-band fill/tone calculation
├── AgentPanel.module.css
└── index.ts                — barrel export

src/admin/pages/ai/
├── AiPage.tsx              — /admin/ai workspace; three tabs gated by ai.providers.manage + ai.audit.read
├── AiPage.module.css
└── tabs/
    ├── ProvidersTab.tsx    — CRUD for ai_credentials rows (provider-derived API key or endpoint credential shape)
    ├── DefaultsTab.tsx     — Studio's default-model editor (single row — one agent, one default)
    ├── AuditTab.tsx        — usage audit view: totals strip, by-model/user tables, daily bar chart
    └── UsageTablePanel.tsx — shared table scaffolding (title + hint header, numeric-aligned columns, empty row)
```

Shared AI number and spend formatting lives in `src/admin/ai/usageFormat.ts`, so
the Audit workspace and compact composer usage detail use identical labels.

The Agent Panel owns the credential list load for its header, lock-state empty states, and model picker. The header always contains a `ConversationHistory` popover (browse and restore past threads), a "New chat" button (`startNewAgentConversation`), a conditional "Clear conversation" button (visible when `agentMessages.length > 0`), a streaming badge, and an "AI settings" shortcut that routes to `/admin/ai`. The AI settings button is always visible in the header, independent of credential state.

The composer has two distinct lock states, expressed as `lockReason: 'setup' | 'chooseModel' | null`:

- `'setup'` — no credentials exist at all. The message area shows a "Connect an AI provider" empty state with a CTA to `/admin/ai`. The model picker is hidden. The textarea placeholder reads "Add AI credentials to start chatting" and the send button tooltip reads "Add AI credentials first".
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
| `claudeCli` | Claude Code (subscription) | `apiKey` (L2 only — see below) | — (L1 stores no credential row at all) | `claude setup-token` value (L2) | No live catalogue — static fallback (`opus`/`sonnet`/`haiku` aliases); the CLI is the source of truth, and there is no API key to call `/v1/models` with |

**Custom Provider** (id `openai-compatible`) is the generic adapter for any endpoint that speaks the OpenAI chat/completions wire protocol — Groq (`https://api.groq.com/openai`), Together, DeepSeek, Mistral, Fireworks, self-hosted vLLM, LM Studio, and others. Capabilities default to `{ toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true }`; the operator is responsible for selecting a model that actually supports tool calling. Because arbitrary endpoints are not in the OpenRouter catalogue, no context-window enrichment is available and the context meter stays hidden for these models.

**The server is the model-capability authority.** The composer catalogue flags are early UX gates, but they are not trusted for persistence, provider calls, or tool screenshots. `chat.ts` resolves the selected model on every turn through `resolveModelCapabilities`. Providers with stable capabilities (Anthropic, OpenAI, Custom Provider) use their driver default. Model-specific providers own a selected-model lookup: OpenRouter resolves the exact entry's `architecture.input_modalities`, while Ollama sends an authenticated `POST /api/show` for only the selected model. The shared resolver de-duplicates concurrent lookups, applies a ten-second provider timeout, includes credential/backend revisions in its cache key, and caches successful results for five minutes. Missing or unavailable model-specific metadata fails closed for vision input; Custom Provider also remains fail-closed in v1. An image targeting a non-vision model, or an editor-agent turn targeting a model known not to support tools, receives 422 before the user message is stored.

---

## Claude CLI provider (WS-11) — a subprocess, not an HTTP driver

`server/ai/drivers/claudeCli.ts` is the exception to "every driver talks directly to its provider's REST API": it drives the local `claude` binary the user already has installed and logged in — the same mechanism the Claude Code VS Code extension uses. Studio never holds an API key, never reads `~/.claude/.credentials.json`, and never sends an `Authorization` header to Anthropic itself for this provider. See `src/__tests__/architecture/ai-driver-isolation.test.ts`'s doc comment for the exact rule this carves out (no provider SDK, ever; HTTP/SSE or a local user-installed binary).

**Two login paths, both landing in the same per-user `CLAUDE_CONFIG_DIR`:**

| | Path | Studio holds a secret? | Works on a remote server? |
|---|---|---|---|
| **L1** | Terminal login — `server/handlers/studio/claudeCliEnv.ts`'s `buildClaudeCliLoginCommand(configDir)` renders `CLAUDE_CONFIG_DIR=<dir> claude auth login` for the user to run in their own shell. `claude auth login`/`claude setup-token` are Ink TUIs that die on piped stdin, so Studio cannot drive them itself — no PTY dependency was added to work around that. | No. | Only with shell access to the host. |
| **L2** | Token paste — the user runs `claude setup-token` anywhere and pastes the result as a normal `apiKey`-mode credential, `providerId: 'claudeCli'` (`ProvidersTab.tsx`). Stored via the existing encrypted credential store — `auth_mode='apiKey'` fits `ai_creds_apikey_shape_check` unchanged, and `provider_id` has no DB constraint, so this shipped with **zero migrations**. The token is inference-only (cannot drive Remote Control) and does **not** refresh — `CredentialView.expiresAt` (computed from `createdAt` + 1 year, not a stored column) surfaces the deadline in the Providers tab rather than letting it expire silently. | Yes, encrypted, per user. | Yes — this is what makes server-side login work at all. |

Every spawn (probe or chat) sets `CLAUDE_CONFIG_DIR` to `<CLAUDE_CLI_DATA_DIR>/<userId>/` (default `./.data/claude-cli`, override with `CLAUDE_CLI_DATA_DIR`), created mode `0700` by `ensureClaudeCliConfigDir`. `userId` is validated as a safe path segment (`assertSafeClaudeCliUserId`) and re-checked for containment (`assertPathWithin`) before it ever reaches a join — the same discipline `appRoot.ts` applies to project-relative paths. **macOS cannot honour this**: `CLAUDE_CONFIG_DIR` does not relocate the OS keychain, so `claudeCliPlatformSupport()` reports the provider disabled with that reason on `darwin` — never a silently shared login.

**Availability probe** — `claudeCliProbe.ts`'s `probeClaudeCliAuth()` runs `claude auth status --json` (via `runCappedSubprocess`, cwd = a neutral temp dir, never a project) and classifies the result into `logged-in` / `logged-out` / `not-installed` / `probe-failed`. It deliberately never reads `apiKeySource` (present in the same JSON body, but it reports the API-key source, not auth state, and reads `"none"` even when fully logged in).

**Chat streaming** — `claudeCliSpawn.ts`'s `spawnClaudeCliNdjson()` reads `claude -p <prompt> --output-format stream-json --verbose --model <id> --permission-mode default --strict-mcp-config` incrementally (line-by-line, not "wait for exit" — a chat turn needs to stream, unlike the one-shot probe), and `claudeCliEvents.ts` translates each `stream-json` line into canonical `AiStreamEvent`s: `assistant` messages become `text` events (skipping the synthetic auth-failure message, `message.model === "<synthetic>"`), and the terminal `result` event becomes `context` + `usage` (its own `total_cost_usd` wins over the shared pricing-table estimate — it already accounts for every model in `modelUsage`, including an internal classifier call Studio never requested) + `done`/`error` keyed off `result.is_error` (**never** `result.subtype`, which reads `"success"` even on a failed turn).

**Step 1 scope, deliberately not built yet:**
- **No tools.** `req.tools` is accepted (the `AiProvider` interface requires it) but never forwarded — no `--mcp-config` is passed, so the subprocess has zero tools of its own either. Routing Studio's real toolset through `/_studio/mcp` with a scoped connector token per chat session (so a `claude` turn can actually touch the canvas) is WS-11 step 3.
- **No project `cwd`.** Nothing upstream threads a workspace path into `AiStreamRequest`/`ToolContextBase` yet, so the subprocess spawns inside the user's own `CLAUDE_CONFIG_DIR` — guaranteed to hold no `CLAUDE.md`, which doubles as avoiding the cost trap below.
- **No multi-turn history replay.** Every HTTP driver replays the full `AiMessage[]` log each turn (no server-side session). This driver has no verified `--resume`/session-id mechanism yet, so it sends only the latest user message's text as the `-p` prompt.

**The loop-ownership fork.** Every HTTP driver is a thin adapter: `runToolLoop` (`drivers/http/toolLoop.ts`) owns the multi-turn agent loop, tool dispatch, and retries. `claudeCli.ts` does not call `runToolLoop` at all — the `claude` subprocess owns its own agent loop internally. Turn structure, retries, and tool-permission prompts are the CLI's, not Studio's. That is a genuine behavioural difference from every other driver, not an oversight — see `docs/features/mcp-connectors.md` for how step 3's MCP routing will reuse the connector-bridge machinery this fork depends on.

**Cost warning.** A single trivial prompt run against a real project cost $0.168 in testing because it cache-created ~27k tokens of `CLAUDE.md` and project context. Any probe or health check must spawn with an empty/neutral `cwd`, never a real project — `claudeCliProbe.ts` uses `os.tmpdir()` for exactly this reason, and step 1's chat spawn uses the (guaranteed-empty) `CLAUDE_CONFIG_DIR` for the same one.

**Tests never spawn the real binary.** Every test (`server/ai/drivers/claudeCli*.test.ts`, `server/handlers/__tests__/claudeCliEnv.test.ts`) injects a fake `spawn` matching `subprocessRunner.ts`'s `SubprocessSpawnFn` and feeds recorded NDJSON fixtures shaped like the verified CLI contract.

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

Returns the rollups consumed by the `/admin/ai` Audit tab and the dashboard "AI usage this month" widget. Gated by `ai.audit.read`. There is no per-scope breakdown — Studio has exactly one agent, so a "by surface" rollup would always be a single row identical to `totals`.

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

The Audit tab (`src/admin/pages/ai/tabs/AuditTab.tsx`) consumes this endpoint. The daily rollup there also aligns its "Today" range window to local midnight (`setHours(0, 0, 0, 0)`) so the day boundary is consistent both in the filter and in the bar chart. The by-model and by-user rollups render through `UsageTablePanel` (`tabs/UsageTablePanel.tsx`) — a shared table component that takes a `columns` config and handles the empty-state row. Number and cost formatting (`formatNumber`, `formatCost`) live in `src/admin/ai/usageFormat.ts`, a plain shared leaf used by both Audit and the composer context tooltip.

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
  - `src/admin/pages/ai/AiPage.tsx` — `/admin/ai` workspace (Providers / Defaults / Audit tabs)
  - `src/admin/pages/ai/tabs/AuditTab.tsx` — usage audit view (totals strip, tables, daily bar chart)
  - `src/admin/pages/ai/tabs/UsageTablePanel.tsx` — shared table scaffolding for audit rollups
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
