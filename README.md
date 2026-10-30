# LLM API Manager

**English** | [简体中文](./README.zh-CN.md)

A self-hosted console for LLM APIs: manage all your providers in one web UI, publish them as
unified model aliases, and provision the result into the coding agents on your machine
(Codex CLI and Claude Code today).

The design borrows ideas from `cc-switch` (own only a minimal set of Agent config keys) and
`new-api` (multi-channel gateway with priority-based routing), but the code is an independent
implementation — neither project's source was copied.

## What it does

- **Provider management**: three protocols — OpenAI-compatible (Chat Completions),
  OpenAI-compatible (Responses), and Anthropic-compatible (Messages). API keys are encrypted at
  rest and masked in the UI, with priority ordering, per-provider enable/disable, connectivity
  tests (hits the upstream `/models`), and one-click model discovery that works off the current
  form values before you even save. A per-provider **effort probe** sends one minimal request per
  reasoning level, so the Codex model catalog advertises only the levels your upstream actually
  accepts.
- **Model aggregation**: every enabled provider's chat models are published as
  `lam-<provider-key>/<model>` aliases. You can also set a default provider + default model to
  serve requests that carry no alias. Image models are configured in a **separate list**, so
  they never show up in Codex's `/model` picker.
- **Unified gateway**: `/v1/models`, `/v1/chat/completions`, `/v1/messages`, `/v1/responses`,
  plus `/v1/images/generations` and `/v1/images/edits` so Codex's built-in image tool works
  through the gateway (image URLs are inlined as `b64_json`), with SSE streaming pass-through
  and one priority-based fallback when the primary path fails.
- **Agent provisioning**: Codex CLI (`~/.codex/config.toml` + `auth.json` +
  `llmapi-model-catalog.json`; requires a `responses` provider and pins `wire_api` to
  `responses`) and Claude Code (`~/.claude/settings.json`; requires `anthropic`). Preview,
  apply, revert, and stop running Codex processes — with a backup before every write, touching
  only the keys we own. On Windows the same files live under `C:\Users\<user>\`, and process
  detection/termination uses PowerShell `Get-CimInstance` + `taskkill`.
- **Multi-device sync (bidirectional, manual)**: one machine can serve its configuration for
  others to pull. Roles are `standalone` (default), `master` (serve only), `follower` (pull
  only) and `peer` (both). Pull is always initiated by the receiving side — there is no push
  and no scheduler. A per-tenant `sync-state.json` stores content hashes so the merge is
  **three-way**: "only the other machine changed" converges automatically, while genuine
  divergence becomes a conflict that keeps both versions for you to arbitrate. Deletions are
  not propagated, and the pull token is supplied per request and never persisted.
- **Windows service and installer**: an Inno Setup installer
  (`llmapi-manager-setup-<version>-x64.exe`) plus a portable zip. A WinSW-managed service ships
  its own Node 22 LTS x64, writes into the installing user's `.codex` / `.claude` through
  `AGENT_HOME_DIR`, can open inbound TCP 8787 on the Private firewall profile (opt-in), and
  supports `CODEX_BIN` for `codex` installed outside the service account's PATH.
- **Observability**: request log plus today's stats (request count, success rate, average
  latency).
- **Bilingual UI and bilingual errors**: the console switches between Simplified Chinese and
  English. The preference is stored server-side (tenant settings), so it survives a browser
  change or a cache wipe; before sign-in the browser language is used. The API's
  `error.message`, Agent descriptions, and diagnostics output follow the same language.

## Quick start

```bash
npm install
cp .env.example .env    # edit as needed
npm run dev             # server :8787 + web :5173
```

Open http://localhost:5173. On first launch you **set your own** admin username and password:
copy the one-time setup token printed by the server into the setup page.

Production mode (a single process serves the API and the built frontend):

```bash
npm run build
npm start               # http://127.0.0.1:8787
```

On Windows, use the installer or the portable zip instead of the source checkout:

1. Run `llmapi-manager-setup-<version>-x64.exe` (Inno Setup) or unpack the portable zip and run
   `scripts/windows/install-service.ps1` as Administrator.
2. The installer writes `.env` (`HOST=0.0.0.0`, `PORT=8787`,
   `PUBLIC_BASE_URL=http://127.0.0.1:8787`, data/log under `C:\ProgramData\llmapi-manager\`),
   registers a WinSW service, grants that service account write access to the installing user's
   `.codex` / `.claude`, and can add an inbound TCP 8787 rule for the Private profile (the
   installer option is off by default; tick it when other devices must reach this machine).
3. Open http://127.0.0.1:8787 and finish setup with the one-time token printed in the service
   log. The temporary `ADMIN_PASSWORD` is removed from `.env` once the health check passes.

Upgrade, uninstall, firewall and troubleshooting details: [docs/windows.md](./docs/windows.md).

> The Windows installer/service scripts are not exercised in this repository's Linux
> development environment. Verify them on Windows CI or on a real machine before relying on them.

Other commands: `npm run typecheck`, `npm test`.

## Documentation

Full docs live in [docs/](./docs/README.md) (written in Chinese):

| Document | Contents |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | Process layout, layering, tenants and identity, data flows |
| [docs/api.md](./docs/api.md) | API reference (paths, permissions, examples, error codes) |
| [docs/gateway.md](./docs/gateway.md) | Aliases, routing, protocol matching, streaming |
| [docs/agents.md](./docs/agents.md) | Codex / Claude Code provisioning details (including Windows paths and process handling) |
| [docs/sync.md](./docs/sync.md) | Multi-device sync: roles (`master` / `follower` / `peer`), bidirectional manual pull, three-way merge, conflicts, Windows/LAN |
| [docs/windows.md](./docs/windows.md) | Windows installer/portable package, WinSW service, upgrade/uninstall, service account, firewall, `CODEX_BIN` |
| [docs/configuration.md](./docs/configuration.md) | Environment variables, data directory, deployment, migration |
| [docs/security.md](./docs/security.md) | Auth, permission matrix, credentials and security boundaries |
| [docs/development.md](./docs/development.md) | Development, testing, extension guide |

If you are contributing — especially as an AI coding agent — read [AGENTS.md](./AGENTS.md) first.

## API at a glance

Admin endpoints (require a session cookie):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | Health check and startup warnings (no auth) |
| POST | `/api/auth/login` / `/api/auth/logout` | Sign in / sign out |
| GET | `/api/auth/me` | Current identity, permissions and UI language (`language`; `null` = follow the browser) |
| POST | `/api/auth/password` | Change password (invalidates existing sessions) |
| GET/POST | `/api/providers` | List / create providers |
| PUT/DELETE | `/api/providers/:id` | Update / delete |
| PATCH | `/api/providers/:id/enabled` | Enable or disable |
| POST | `/api/providers/:id/test` | Connectivity test |
| POST | `/api/providers/:id/probe-efforts` | Probe reasoning-effort levels (NDJSON progress stream) |
| POST | `/api/providers/models` | Discover models from unsaved form values |
| PUT | `/api/providers/order` | Reorder by priority |
| GET | `/api/models` | Aliases, default model, gateway URL and token (masked) |
| PUT | `/api/settings/default` | Set the default provider and model |
| GET | `/api/settings` | Read tenant settings (including `language`, `disableCodexWebSearch`) |
| PATCH | `/api/settings/language` | Set UI language: `zh` / `en` / `null` (follow the browser) |
| PATCH | `/api/settings/codex` | Codex behaviour flags, e.g. disable web search |
| POST | `/api/gateway/token` | Create or reset the gateway token (plaintext returned once) |
| GET | `/api/agents` | Agent list and provisioning status |
| POST | `/api/agents/:id/preview` \| `apply` \| `revert` | Preview / apply / revert |
| POST | `/api/agents/:id/stop-processes` | Stop local Codex processes so they reload config |
| GET | `/api/sync/status` | Sync role, peer URL, scopes, last pull result, conflict count, `canServe` / `canPull` / `hasSyncRead` / `hasSyncWrite` |
| PATCH | `/api/sync/config` | Set role (`standalone` / `master` / `follower` / `peer`), peer URL (`masterUrl`), scopes |
| GET | `/api/sync/snapshot` | Export a snapshot (permission `sync:read`, role `master` / `peer`) |
| POST | `/api/sync/pull` | Pull from the peer (permission `sync:write`, role `follower` / `peer`, token in the body) |
| GET | `/api/sync/conflicts` | Pending conflicts (already stripped of sealed values) |
| POST | `/api/sync/conflicts/:id/resolve` | Resolve with `{ "choice": "local" \| "remote" }` |
| GET | `/api/logs`, `/api/stats` | Request log and stats |

Gateway endpoints (require a gateway token via `Authorization: Bearer <token>` or `x-api-key`):

```
GET  /v1/models
POST /v1/chat/completions    # needs an apiType=openai upstream (OpenAI-compatible · Chat Completions)
POST /v1/messages            # needs an apiType=anthropic upstream (Anthropic-compatible · Messages)
POST /v1/responses           # needs an apiType=responses upstream (OpenAI-compatible · Responses)
POST /v1/images/generations  # image generation; needs an openai OR responses upstream
POST /v1/images/edits        # image edits;      needs an openai OR responses upstream
```

The chat paths match **strictly**: a protocol mismatch returns 501 rather than being
silently forwarded. The two image paths are the exception — they accept both `openai` and
`responses` providers, because `apiType` describes the chat protocol, not whether the upstream
implements the Images API (a `responses` provider can generate images; an `openai` one may not).
The gateway downloads `data[].url` responses and inlines them as `b64_json`, which is the only
field Codex reads. Auth headers are grouped by upstream family: `openai` and `responses` use
`Authorization: Bearer`, `anthropic` uses `x-api-key` + `anthropic-version`.

Example (create a token on the "Model aggregation" page):

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lam-myprovider/gpt-x","messages":[{"role":"user","content":"hi"}]}'
```

When `model` is an aggregation alias the request is routed to that provider only. An unknown
`lam-` alias returns 400 and **never** falls back to the default provider — a fallback would
spend another provider's quota and answer with the wrong model without the caller noticing.

Errors share one shape: `{ "error": { "code", "message", "messageKey", "details"? } }`.
`message` is rendered in the request's language (tenant setting > `Accept-Language` > Chinese).
To branch on a specific cause use **`messageKey`**, which never changes with language (for
example `gateway.auth.invalidToken`) — do not match on the translated text.
See [docs/api.md](./docs/api.md).

## Environment variables

See [.env.example](.env.example). The common ones:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address; put an HTTPS reverse proxy in front if exposed. The Windows installer sets `0.0.0.0` so the LAN can reach the console; the firewall and network profile bound that exposure |
| `PORT` | `8787` | Listen port |
| `PUBLIC_BASE_URL` | derived from HOST:PORT | Gateway URL written into Agent config; must be set explicitly behind a proxy or in a container. The Windows installer pins `http://127.0.0.1:8787` so local Agents use loopback; change it only when other devices' Agents must also go through this gateway |
| `TRUST_PROXY` | off | Set to `1` behind an HTTPS reverse proxy so `X-Forwarded-Proto` is trusted (only from loopback). Do **not** enable it for direct LAN HTTP — there is no proxy to trust, and a forged header would bypass the sync HTTPS check |
| `SYNC_ALLOW_INSECURE` | off | Set to `1` to allow sync snapshots/pulls over plain HTTP. Trusted LAN or tunnel only, and **both ends** must set it; the snapshot carries plaintext upstream keys |
| `DATA_DIR` | `data` | Data directory; relative paths resolve against the process cwd (i.e. `server/data` under npm scripts). Set `../data` to pin it to the repo root. The Windows installer uses `C:\ProgramData\llmapi-manager\data` |
| `ADMIN_USERNAME` | `admin` | Initial admin username, used only when first creating the account |
| `ADMIN_PASSWORD` | none | Escape hatch: skips web setup and creates the account with this password directly (handy for Docker/systemd). The Windows installer generates a temporary one and removes it from `.env` after the health check |
| `DATA_ENCRYPTION_KEY` | none | Key used to encrypt provider keys and gateway tokens at rest; if unset they are stored in plaintext and a warning is shown. Sync transmits plaintext keys on the wire because this key is per-machine |
| `LOG_LANGUAGE` | `zh` | Language (`zh` / `en`) of runtime logs, the startup banner and CLI output. Separate from the UI language: the API follows the request language, logs follow this setting |
| `LOG_DIR` | repo-root `log/` | Runtime log directory; set to `off` for console-only. The Windows installer uses `C:\ProgramData\llmapi-manager\log` |
| `LOG_MAX_BYTES` / `LOG_MAX_FILES` | `5242880` / `5` | Rotation threshold and number of retained files |
| `AGENT_HOME_DIR` | OS home | Root for Agent config (holds `.codex` / `.claude`). The Windows service runs as LocalSystem, so the installer points this at the installing user's profile and grants the service account write access; otherwise files land in the system profile |
| `CODEX_BIN` | `codex` on PATH | Absolute path to the Codex executable. The LocalSystem service PATH usually lacks the npm global bin directory, so stopping Codex processes needs this on Windows |

## Data and security boundaries

```
data/                                  # actual location is DATA_DIR; server/data under npm scripts
├── identity.json                       # tenants and accounts (passwords stored as scrypt hashes only)
├── instance.json                       # session signing secret (rebuildable; also the sync masterId)
├── setup.json                          # first-run setup token (hashed), cleared once completed
└── tenants/<tenantId>/
    ├── providers.json                  # providers (API keys encrypted with AES-256-GCM)
    ├── settings.json                   # default model, gateway token (hash + ciphertext only), Codex flags
    ├── agents.json                     # provisioning snapshot (includes appliedBy)
    ├── sync-conflicts.json             # conflicts waiting for arbitration (credentials masked)
    ├── sync-state.json                 # content-hash baseline for three-way merge (no values, no API)
    ├── requests.jsonl                  # gateway request log
    └── (backups are not kept here — see below)
```

- **It writes to your home directory**, but only when you click "Apply config": it updates
  `~/.codex/config.toml`, `~/.codex/auth.json`, `~/.codex/llmapi-model-catalog.json` (the model
  catalog, generated in full) and `~/.claude/settings.json`. Before each write it creates a
  `*.bak-<timestamp>` backup **next to the file** (e.g.
  `~/.codex/config.toml.bak-2026-10-23T14-00-00-000Z`), so you can recover immediately even if
  this service is no longer running.
- **It stops your processes**: Codex only reads config and the model catalog at startup, so the
  "Stop Codex processes" button runs `codex app-server daemon stop` and then terminates `codex` /
  `codex exec` processes (on POSIX `SIGTERM`, then `SIGKILL`; on Windows `taskkill /PID /T /F`).
  Matching is conservative: it never touches `mycodex`, editor plugins, or one-shot commands like
  `codex --version`. If automatic cleanup misses something, fall back to `pkill -9 -f codex`
  on POSIX, or Task Manager / `taskkill /F /IM codex.exe` on Windows. A failed Windows
  process-table probe is reported as a warning, never as "no processes running".
- **It owns a minimal set of keys**: for Codex it only touches `model_provider`, `model`,
  `model_catalog_json`, `web_search` and the `[model_providers.llmapi]` section; for Claude Code
  only three keys under `env`. Everything else (MCP servers, hooks, permissions, other
  providers) is preserved verbatim.
- **Revert is conservative**: it only removes keys whose current value still equals the value we
  wrote. Keys you edited by hand are kept and reported as conflicts. Files we created that would
  be empty after a revert are deleted.
- **Credentials**: passwords use scrypt; gateway tokens are stored as hashes only (a separate
  ciphertext copy is used when provisioning Agents and is never returned by any endpoint); the
  provider list only exposes the first 3 and last 4 characters of a key.
- **Sync sends plaintext keys over the wire**: a snapshot contains decoded provider keys because
  `enc:v1:` is bound to the local `DATA_ENCRYPTION_KEY`. The endpoint therefore refuses
  non-loopback plaintext HTTP unless `SYNC_ALLOW_INSECURE=1`, always sends
  `cache-control: no-store`, and never logs the body. `sync-state.json` stores only content
  hashes (including a hash of the plaintext key — a fingerprint, not a recoverable value).
  With role `peer`, **both ends** expose the snapshot endpoint, so either machine's credentials
  are enough to read all keys.
- **Plaintext mode**: without `DATA_ENCRYPTION_KEY`, credentials are stored in plaintext and
  `/api/health` keeps warning about it. Single-machine use only.

## Designed for multi-user

The current release is single-user (one `t_default` tenant, one `owner` account), but the
structure already leaves room for multi-tenant isolation and permission control:

- **Three identity layers**: `Tenant` / `User(role)` / `Principal` (request context). Both
  sessions and gateway tokens resolve to a `Principal`; there is no "anonymous default tenant"
  fallback.
- **Data partitioning**: all tenant data lives under `data/tenants/<tenantId>/`, repositories are
  only reachable via `forTenant(principal)`, and routes never build paths themselves.
- **Centralised permission decisions**: `server/src/domain/permissions.ts` defines `Permission`
  and the role mapping. Every `/api` route declares its required permission through
  `defineRoute`, `policy.ts` decides uniformly, and a missing declaration fails the startup
  self-check.
- **Replaceable paths**: Agent file paths resolve through `AgentPathResolver` keyed by
  `{tenantId, userId}`; `registerTenantWorkspace()` is already the entry point for per-tenant
  workspaces.
- **Auditable**: logs and provisioning snapshots carry `tenantId` / `appliedBy`.

Adding multi-user support means implementing account/tenant provisioning, invitations and
sign-in flows, and replacing the hard-coded `DEFAULT_TENANT_ID` in `app.ts` with a tenant derived
from the `Principal`. The domain model and API contracts do not need to change.

## Known limitations

- Protocols match strictly by default: `/v1/chat/completions` needs `openai`, `/v1/messages`
  needs `anthropic`, `/v1/responses` needs `responses`. A mismatch returns 501 instead of
  silently forwarding. The single exception is `/v1/responses → openai`: with
  "cross-protocol forwarding" enabled (or auto-enabled when protocols don't match), the gateway
  converts requests, responses and stream events in both directions. Hosted tools such as
  `web_search` have no Chat equivalent and are dropped.
- **Sync is manual and receive-initiated**: a machine pulls only when you click "Sync now";
  there is no scheduler and no push. Role `peer` requires both ends to be reachable from each
  other — with a one-way NAT/firewall you effectively get a single direction. Two ends should
  run the same version; an old peer falls back to the older two-way heuristic.
- **The pull token is never persisted**: it is read from the request body for each pull and is
  not written to `settings.json`. You must supply it again after a restart.
- **Deletions are not propagated**: deleting a provider on one machine leaves it on the other.
  Delete on both sides; the merge never removes local records that are absent remotely.
- **`peer` exposes the snapshot endpoint on both ends**: either machine's `sync:read` credential
  (or account) can export every upstream key in plaintext. Grant a dedicated token with
  `expiresAt`, revoke it after use, and only enable `peer` on machines you are willing to expose
  to each other.
- No billing, quotas, multi-user UI, MCP/Skills/session management, or desktop packaging.
  (Windows service/installer is supported; macOS/Linux packaging is not.)
- **Log language and API language are two separate settings**: API responses follow the request
  language (tenant setting > `Accept-Language`), while runtime logs, the startup banner and CLI
  output follow `LOG_LANGUAGE` (Chinese by default). Logs are read by whoever deploys the
  service; letting them drift with a particular client would make the same failure look
  different across requests and break `grep`.
- Storage is JSON files with atomic writes, suited to single-machine self-hosting. High
  concurrency or multiple instances require SQLite/Postgres and shared state.
- Upstreams are assumed to be "OpenAI / Anthropic compatible" (the OpenAI family covers both the
  Chat Completions and Responses API shapes). Non-compatible proprietary protocols need a new
  adapter layer.

## Repository layout

```
server/
  src/
    app.ts                Fastify wiring, error handling, SPA hosting
    index.ts              Entry point (bootstrap + listen)
    config.ts  logger.ts  resilience.ts  context.ts  bootstrap.ts
    i18n/                 Server-side copy: language resolution (tenant setting → Accept-Language → Chinese), translate, locales/{zh,en}/
    domain/               provider, aliases, identity, permissions, agent, settings, modelCatalog, requestLog
    store/                jsonFile (atomic writes / corruption quarantine), paths, tenantScope, identityRepo
    auth/                 password, session, principal, policy, guard
    crypto/               secretCodec (AES-256-GCM)
    gateway/              token, auth, forward
    services/             providers, connectivity, requestLog, setup, sync (three-way merge)
    agents/               registry (path resolution), patch (value-preserving JSON/TOML edits), toml, processes, service
    routes/               auth, providers, models, logs, agents, gateway, sync
  test/                   Unit tests + end-to-end smoke tests (with fake upstreams)
web/
  src/pages/              Login / Setup / Layout / Overview / Providers / Models / Agents / Settings
  src/components/         ui, ProviderForm, CopyButton
  src/lib/                api, auth, useAsync, types, labels (enum message keys)
  src/i18n/               i18next init, language detection, date localisation, locales/{zh,en}/
  test/                   Page assembly tests + dictionary contract + hardcoded-text scan (jsdom)
scripts/windows/          PowerShell installer/service/packaging scripts (run on Windows)
.github/workflows/        CI: Ubuntu + Windows test matrix, Windows package/smoke jobs
```

## Credits

The design references two open-source projects:

- [cc-switch](https://github.com/farion1231/cc-switch) — writing config into local Agents while
  owning only a minimal set of keys.
- [new-api](https://github.com/QuantumNous/new-api) — multi-channel gateway with priority-based
  routing.

The code here is an independent implementation: neither project's source was copied, nor was its
architecture adopted.

## License

[MIT](LICENSE) © 2026 LinWang
