# Waddle

An open, fully confidential personal AI agent — a private Muse. One agent VM per user inside a hardware-attested secure enclave: neither the operator nor the cloud provider can read the user's data, conversations, credentials, or browser activity. The client verifies the enclave cryptographically before sending anything.

**Prototype goal:** five core capabilities in ~4 weeks — (1) agent harness in a confidential container, (2) attested client connection with user-held state encryption, (3) agent-driven browser the user can watch and take over, (4) private connectors with credential surrogation, (5) memory the agent owns and the user can inspect.

**Design rule: simple design, powerful parts.** Few components, each doing real work; plumbing gets cut or deferred.

---

## Why this is possible now

Meta's Muse (per-user VM, runtime cell, externalized credentials, Sentinel, brokered browser) is sound — but its Confidential VM is still *coming*. The pieces to leapfrog it exist today:

- **Tinfoil Containers** run any Docker image in AMD SEV-SNP / Intel TDX enclaves; the config is measured and Sigstore-logged; clients verify attestation with open SDKs — **including in-browser JS**. Muse Confidential VM, day one.
- **Tinfoil Inference** serves open models from attested GPU enclaves, OpenAI-compatible (we already built a proxy: `betterbase-inference`).
- **Betterbase** — OPAQUE accounts + E2E-encrypted blob storage (client SDK). Auth and confidential backup, already built.
- **pi** — a minimal MIT agent harness with a TypeScript SDK built for in-process embedding (tools, approvals, providers, sessions, skills).
- **Hiro** — history/memory conventions and isolation techniques (Landlock + seccomp, SSRF-safe fetch). We borrow ideas, not the control plane: hiro assumes a central brain; waddle has none.

The novel work is the composition: **harness + browser + connectors inside a per-user enclave the operator cannot see into.**

## Confidentiality model

| Data | Who can read it | Mechanism |
|---|---|---|
| Workspace, memory, files | User only | E2E-encrypted snapshots in the user's betterbase space; enclave-local disk is ephemeral scratch |
| Conversations / trajectories | User only | Never leave the enclave; backup snapshots are E2E-encrypted |
| Third-party credentials | User only | authd vault; snapshot AEAD at rest; never enter model context |
| Inference prompts | User + Tinfoil enclave | Tinfoil inference runs in its own attested TEE; no retention |
| **Agent code (image digest)** | **User + operator** | Attestation proves the enclave runs the *operator-published* image — see pinning below |
| Network metadata (IP, timing) | Infra providers (+ Concierge timing, product mode) | Known residual, same as Tinfoil's own disclosure |

**Honest limits:**
- **Operator code trust:** clients that follow config HEAD verify green against operator-swapped code. Mitigation: client-side **measurement pinning** — TOFU on first connect; any digest change blocks, shows old/new digests + the repo commit, requires approval. Product mode: per-user config forks, so the user controls releases.
- **Web client is TOFU:** the operator serves the client JS and could fake a green badge; unlock-secret entry limits the blast radius; a signed/native client (Expo) closes this later.
- **In-VM isolation: deferred by design** (below).
- Trust anchors: hardware attestation + user-held secret + pinned measurement. Everything beyond is listed, not implied.

## Architecture

┌──────────────────────┐   wake (POST → boot)    ┌───────────────────┐
│  Web client          │────────────────────────▶│  Concierge        │
│  (React + TS SDK)    │                         │  (wake-only for   │
│   • betterbase       │                         │   now; scoped key;│
│     account: backup  │                         │   metadata only)  │
│     store auth       │                         └─────────┬─────────┘
│   • verify           │                                   │ Tinfoil API
│     attestation,     │                                   ▼
│     pin measurement  │                         ┌───────────────────┐
│   • chat, approvals, │                         │  Tinfoil          │
│     browser stream,  │                         │  containers       │
│     takeover, wake   │                         │  (shared pool)    │
└─────────┬────────────┘                         └───────────────────┘
          │ attested WSS (SecureClient pins TLS to the verified enclave)
          │ backup snapshots: E2E blobs in betterbase store —
          │ VM writes via UCAN delegation, clients read
┌─────────▼──────────────────────────────────────────────────────────────┐
│  Waddle VM — Tinfoil Container (SEV-SNP / TDX enclave, one per user)   │
│  ┌─ app container — a single-user app — egress: open ───────────────┐  │
│  │ gateway       attested WSS; lock screen pre-unlock; session auth │  │
│  │               HKDF-derived from the unlock transcript            │  │
│  │ harness (pi)  agent loop → Tinfoil inference (TEE-to-TEE);       │  │
│  │               ONE append-only log (pi JSONL) = wire contract =   │  │
│  │               replay & resume storage (importFromJsonl)          │  │
│  │ sleep gate    end-of-turn proposal + deterministic gate + buffer │  │
│  │               → checkpoint → snapshot → exit (restart: no)       │  │
│  │ approval gate hardcoded rules; exact parameters; step-up         │  │
│  │ authd         vault: one encrypted file; two connector modules   │  │
│  │               as separate processes (OAuth exchange + refresh)   │  │
│  │ browser broker  Chromium + Playwright CDP, plain subprocess;     │  │
│  │               agent: a11y + screenshots + network capture;       │  │
│  │               user: screencast + input injection (takeover)      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  Scratch disk (ephemeral — read-only rootfs enforced). State hydrates │
│  from E2E snapshots in the user's store at unlock; checkpoints push   │
│  back. No user data exists in the clear without the client's secret.  │
└────────────────────────────────────────────────────────────────────────┘
Product inset: at scale, N such single-user VMs behind a metadata-only
Concierge (wake / presence / cron / webhooks) — product phase, parked.

**Security domains — one, deliberately.** The prototype runs everything (gateway, harness, connectors, authd, browser) unconfined in a single container. Isolation chosen before the system works is chosen blind — hiro's carefully separated architecture collapsed once real capabilities arrived; boundaries only become visible when the parts run. What we keep is the *structure* that makes later hardening cheap: credentials in an encrypted vault only connector-worker processes read, workers as separate processes, a broker-mediated browser, approval gate + untrusted-content tagging. Kernel confinement (Landlock/seccomp helper, or container splits) returns post-prototype, where experience shows it pays. The honest gap until then: a renderer RCE or compromised gateway process reads everything inside the VM — bounded by the TEE, unbounded within it.

**Mental model — a single-user app in a secure container.** The enclave runs one user's application, designed as if it were local and personal: one principal (the owner), no tenant machinery, no roles, a lock screen (pre-unlock exposes only the unlock endpoint) and then a personal server with full run of its own data — local-first tools, sqlite, plain files. Security comes from the perimeter (TEE + attested connection) and the **client, which is the security-critical component**: it verifies what it's talking to before trusting it, holds and delivers the keys, approves irreversible actions, wakes the app. Betterbase serves the *client* as tooling — account identity (OPAQUE), the E2E backup store, UCAN delegation minting — never the app's front door. This survives product scale: N single-user containers behind a metadata-only Concierge, not a multi-tenant platform. One principal ≠ untrusted-free: the app faces the public network and ingests browser content, so input distrust (rate-limited unlock, untrusted tagging, approval gates) is untouched by the model.

**Topology:** no central brain. Each user's enclave runs the full harness and its own inference; the client talks straight to the enclave; the only shared service (Concierge) is metadata-only. The client renders, verifies, holds secrets, approves — zero inference.

**User auth to the enclave:** Tinfoil has no private networking, so the gateway authenticates its one user — its owner — itself. Pre-unlock, only the unlock endpoint is exposed; the unlock transcript is HKDF-derived into the session credential. Betterbase JWTs are fine for Concierge/backup-store but are operator-mintable — **not** the enclave's front door. Unlock is rate-limited; the client pins the config repo *and* the instance domain (TOFU), so a phishing instance running the same public config can't harvest unlock secrets.

## Lifecycle, presence & out-of-band work

Lifecycle is the hardest architectural question here: always-on per user is Muse's model and the simplest, but cost scales linearly with users. "Asleep" must be a first-class state.

**Modes:** prototype = **agent-directed sleep**; product = warm-window scale-to-zero — sleep after N idle minutes (state rides snapshots), wake on message/schedule/webhook via Concierge; cold boot ≈ boot + healthcheck + attestation + unlock + hydrate, acceptable for long-running work and hidden behind a “waking your agent…” state for chat. Updates ride the sleep window (single instance); brief per-user downtime otherwise.

**Agent-directed sleep (prototype).** The agent manages its own existence — idle with nothing pending, it sleeps; the client is the only wake path. **Decision, every turn:** at end-of-turn the agent proposes sleep (`sleep_ok` + rationale — part of the turn's own output, narrated to the user; no separate call), and a **deterministic gate** verifies ground truth: no pending tasks, no unexpired approvals, and **no live schedule — any schedule, regardless of when** (staying alive is the only way to honor it; the gateway's own timers fire it while alive — the sleep design *is* the scheduler, no cron infrastructure; a recurring weekly schedule means never sleeping, and the agent should say so plainly, cost included). Finishing the last scheduled task → the “nothing else on my plate — safe to shut down” proposal. **Buffer:** proposal → `sleep_pending` countdown (default ~5 min, config knob), visible in the client; any inbound — message, approval, task creation — cancels it instantly; at zero → checkpoint → stop. Sleeping with a client attached is allowed: the buffer absorbs “user sends another message right away,” and a message after zero rides the wake flow (deploy → attest → unlock → resume). **Mechanism:** checkpoint → process exit with `restart: no` — zero credentials, **zero new enclave capabilities** (the invariant survives; injection-forced sleep ≡ crash, which the resume invariants already absorb). Phase 0 verifies an exited container actually stops billing; fallback: stop via the concierge — needed anyway as the client's wake button since browsers can't hold Tinfoil credentials. Hard idle backstop (N hours) bounds the never-sleep failure mode.

**Hibernate-ready invariants (day one, so scale-to-zero is a deployment change, not a rewrite):**
1. No durable state outside the E2E backup store — the enclave's local disk is scratch, rebuilt on every boot.
2. Every task resumable from persisted state — kill the VM at any instant and it reconstructs. Approvals included: checkpoint (tool, exact args) → abort → `awaiting_approval` → optionally sleep → resume on approval. In-process awaits are only the fast path for a watching user.
3. Boot path fixed: attest → unlock → resume (dangling tool-calls get a synthesized "interrupted; outcome unknown" result).
4. The only interactive boot step is the user delivering the unlock secret (until key escrow).
5. Monotonic generation counter on the backup manifest; regression = loud refusal (replay could resurrect revoked tokens).

**Tasks, not chats.** A task = goal + optional schedule + resumable state. Clients *attach*: the gateway replays its **single append-only event log** — pi's JSONL session file is both its storage and the resume mechanism (`importFromJsonl`); one log serves wire contract, replay, and resume. Clients send **intents only** — messages, approvals, steering — never history; the client's rendered chat is a derived cache (droppable, reconstructible), and model context is a server-side derivation from the log (log ≠ context). A fresh client reconstructs any conversation entirely from replay — cross-device handoff never moves data client→client. Detaching never stops a task; out-of-band = a task running with zero clients attached.

**Autonomy now vs later.** Delivered in the prototype: tasks run with zero clients attached (unlock happens once per boot — the secret lives in enclave memory until the VM stops, so the agent works all day after you disconnect), plus **scheduled tasks via in-VM timers** — a schedule is a due-time + a stay-alive intent; the sleep design *is* the scheduler (no cron infrastructure). The gap: after a full stop, nothing runs until the owner returns (wake → attest → unlock → resume). Closing that gap — escrow keyserver, cron/webhook wakes via Concierge, sealed storage — is product-phase custody design; see the parked appendix.

## Components

### 1. Gateway
Attested WSS, JSON protocol. Carries chat/streaming, tool events, approvals (bound to tool-call ID + nonce; **exact parameters** rendered), screencast + input, OAuth handoffs, unlock. The protocol **is** the client SDK — Expo reuses it verbatim later. Client consumption is two-layer: the chat surface via AI SDK `useChat` with a custom transport over this protocol (assistant-ui renders), and non-chat events (screencast, sleep, attestation, OAuth) via the `sdk` directly.

### 2. Harness — pi, embedded
Embed the loop, don't build one: `createAgentSession()` with `DefaultResourceLoader` plus targeted overrides (system prompt, tool set) — keeping pi's extension/MCP machinery. Waddle is a thin layer of extensions and custom tools:

| Concern | pi mechanism |
|---|---|
| Inference → Tinfoil | OpenAI-compatible provider via `models.json`; SDK-verified TLS TEE-to-TEE |
| Approval gate | `tool_call` handler: rules, block-or-allow; fast path awaits client, offline path checkpoints + aborts |
| Browser, connectors | `registerTool()` custom tools backed by the brokers |
| File tools | pi built-ins with workspace root guards. **No bash in the prototype** |
| Untrusted-data tagging | `context` events wrap browser/connector results entering model context — ships with the browser, week 2 |
| History & resume | file-backed `SessionManager` (JSONL) on scratch, snapshot-backed; dangling tool-calls reconciled; `importFromJsonl` for restore |
| Steering | `session.steer()` by default when the user messages mid-run |
| Skills & memory | pi skills; `persona.md` + `memory.md` as user-inspectable files injected as context at session start (the read half of memory) |
| Memory write path | a `memory` tool — the agent appends/edits facts, gated like a workspace write. Agent-curated, no hidden writes: what it decides to remember is inspectable and is itself a capability |
| Browser sub-agent | second headless SDK session, web-specific anti-injection instructions, own loader |

**Accepted trade-off:** pi is coding-agent-shaped; we keep the generic file tools, replace prompts/skills wholesale, and depend on a small MIT SDK surface (forkable if upstream drifts). Its dependency tree is TCB — pin and minimize. *Stack decision (considered, closed):* Rust + rig for the loop was evaluated and rejected — the hard parts (durable resume, approvals, steering, compaction, MCP) are what pi ships and rig leaves you to build; Playwright a11y, betterbase SDKs, Tinfoil SDK, and the shared TS protocol (`vm` + `client` + Expo) are all Node-native; Rust returns where it pays — the standalone Landlock helper. And the MCP server ecosystem is Node-native (`npx` distribution — GitHub's official server included): a Rust VM would still ship a Node runtime just to spawn MCP servers.

### 3. Approval gate
Three rules: reads auto-allow; workspace writes auto-allow; connector actions, form submissions, and egress ask. Every ask shows exact parameters — injected content must not be able to shop for approvals. Irreversible actions (send, purchase, delete) require step-up: re-enter the unlock secret. The agent proposes; only the gate executes. Configurable policy engine is post-prototype.

### 4. Authd + connectors (private Pipedream)
- **Vault:** library, not daemon — encrypted file in the state dir (snapshot-backed), envelope-wrapped under the unlock secret. The model sees `connector.invoke("github", "create_pr", …)` and gets results, never tokens. Injection asking it to print credentials is structurally futile.
- **Workers:** TS modules, separate processes. The OAuth code→token exchange happens in the worker — tokens go straight to the vault, never through the gateway heap — and the same worker refreshes on expiry (`refreshIfNeeded`): access tokens last hours, so without refresh the demo decays within a week.
- **OAuth (enclave-callback):** enclave generates `state` + PKCE verifier; client opens the consent URL as a dumb browser; redirect hits the enclave's `*.containers.tinfoil.dev` domain; the worker exchanges and vaults. The client never holds verifier or token.
- **MCP:** pi's native support (`registerMcpServer`, scoped env credentials, gate rules on tool annotations) — no bespoke adapter. MCP servers are third-party code: pinned versions, per-server install approval, honestly documented as unconfined in the prototype.
- **Prototype connectors:** GitHub (official MCP server) + one hand-built connector — a single Google OAuth app with two scopes (`gmail.send` + calendar read/write) — proving surrogation end-to-end and carrying the flagship's calendar step. Generic HTTP connector deferred — the SSRF workhorse, needs allowlist design.
- Code-in-repo, open, auditable. Nothing hosted, nothing visible to us.

### 5. Browser broker
Chromium + Playwright, plain subprocess (confinement deferred); the broker owns CDP and is transport-agnostic, so a later container split is config, not code. The agent gets **a11y snapshots (Playwright's ref system) + screenshots + network capture** — the XHR behind a UI is often 10× cheaper and more injection-resistant than driving the UI; never raw DOM, never JS execution. The user gets screencast over the gateway (1–2 fps JPEG, keyframe-on-attach, client-side backpressure drop) + input injection. **Takeover pauses the agent at the broker** — user wins conflicts — and doubles as the captcha story: challenge → pause → user solves → hand back. Browser profile (cookies are bearer tokens) lives in the state dir and rides the snapshots like everything else (one code path; the profile's churn is why product-phase dedup exists) — **no runtime cookie export/import**, ever; quiescent checkpoints keep hot Chromium DBs coherent.

### 6. Inference
Tinfoil inference API, TEE-to-TEE — check **`@tinfoilsh/pi-provider`** (Tinfoil's own pi provider package) first; fall back to pi's OpenAI-compatible provider over the `tinfoil` package's `SecureClient.fetch` from inside the enclave (attested + EHBP body encryption; `createTinfoilAI` exists as an AI SDK provider if we ever need direct calls, but the client never calls inference). Open models only (Llama/Qwen/DeepSeek-class) — the cost of confidentiality. Pluggable behind the OpenAI-compatible interface. **Week 1 builds the eval suite** — one 10–15 task suite (browse / files / connectors / mixed), run across 2–3 model candidates to make the model decision early; week 4 re-runs it on the chosen model as the regression bar. The go/no-go artifact for demo quality.

### 7. Persistence & keys
The E2E backup store (§8) is the **only** durable state; the enclave's local disk is **scratch** — rebuilt on every boot (the shared pool enforces read-only rootfs; scratch is an ephemeral writable mount). Boot = attest → unlock → hydrate from the latest snapshot; checkpoints push back. There is no volume and no volume story: that's the custody model stated in hardware — nothing readable exists anywhere but ciphertext in the user's own store.

Everything durable therefore lives in snapshots: workspace, memory, the event log, task records, vault, browser profile. Keys, prototype-simple: **client-generated full-entropy 64-byte secret** (never passphrase-derived; an optional passphrase *wraps* it with Argon2 client-side), then HKDF labels for what exists — `"unlock"` (verifier), `"backup"` (snapshot AEAD), `"session"` (unlock-derived auth), `"log"` (event records). Label discipline from day one keeps the product-phase fork (domain-separated autonomy/vault snapshots for escrow — §8) a policy change, not a migration. The secret alone = full recovery; wrapped copy (under the account root key, optional second Argon2 wrap) in the personal space by week 4 — new-device enrollment = login + read. Generation counter per the invariants.

### 8. Persistence = encrypted snapshots in the backup store (no volume)
**No sync engine — waddle is an online system.** The VM is the single writer; clients are thin viewers + intents, not sync peers. When the VM is down, nothing needs to write — offline interaction is "read the last snapshot or wake the VM." (Real sync — multi-writer, CRDT, phone-side memory editing — is a product-phase feature; if it arrives it lands on the same store.)

**No volume, deliberately.** The shared pool has no per-org persistent disks (they'd need dedicated org hosts — paid capacity we don't want for the prototype), and platform-managed volume keys (`--auto-unlock`) would transit Tinfoil's control plane — a custody violation regardless of cost. Org hosts may return someday as a wake-latency optimization; they can never be a custody dependency.

**The mechanism — one code path, no per-class wiring:** at quiescent checkpoints, snapshot the world, encrypt, push. Nothing to forget to replicate: any new state class (a sqlite DB, a new file) is in the backup by construction. **Checkpoints are the crash-safety story, not just tidiness:** a `kill -9`, OOM, or platform stop never runs a shutdown hook — anything un-checkpointed is lost. Checkpoints therefore ride every quiescent gate (task completion, approval waits, memory writes, pre-sleep) plus the periodic timer; RPO = last successful push. `wal_checkpoint(TRUNCATE)` any open SQLite before the tar.

```
/{user}/
  manifest                    latest-complete pointer + generation counter (rollback anchor)
  secret.wrapped              wrapped unlock secret (one-time client write at enrollment)
  snapshots/{gen}.tar.zst.enc full-state snapshot, AEAD under HKDF(unlock secret, "backup") — stored in the betterbase `waddle-backups` space (file routes, ciphertext only)
```

- **Checkpoint cadence** rides the hibernate checkpoints: task completion, approval waits, memory writes, pre-sleep, plus a periodic timer for long tasks (brief writer pause — seconds, state is MBs). All naturally quiescent — the same discipline that makes `kill -9` survivable makes snapshots coherent. `wal_checkpoint(TRUNCATE)` any open SQLite before the tar. (Also folded into the mechanism paragraph above: cadence is crash-safety.)
- **Seam (4 verbs):** `put/get/list/delete` on versioned blobs, client-side encrypted. **One adapter: betterbase-sync file routes** (boots locally via `just dev` in betterbase-dev — accounts+sync+postgres+caddy on `*.betterbase.localhost`); the local-dir adapter demotes to a test double. The seam stays swappable (S3/R2) but no second production backend.
- **Manifest written last** — points at latest *complete* snapshot; crash mid-push leaves an orphan the manifest never references; generation regression at restore = loud refusal (invariant #5).
- **Browser profile included** — one code path means one code path (cookies are bearer credentials, but the store is the user's own and holds only ciphertext). Quiescent checkpoints sidestep hot-Chromium-DB tearing; the profile's churn is what makes product-phase chunked dedup worth it. Snapshot key = HKDF(unlock secret, "backup"): the secret alone restores everything, consistent with §7. (Domain-separated snapshots — autonomy vs vault — are the known product-phase fork, driven by key escrow, not backup.)
- **Boring storage sanctioned:** sqlite (WAL) for task records — the one append-only log lives as pi's JSONL; memory is markdown files. Growth path for size is restic-style chunked dedup — still snapshots, still no per-class logic.
- **Auth (betterbase, concretely):** client = OAuth 2.0 + PKCE public client of accounts (OPAQUE underneath; keys arrive via the extended-PKCE JWE flow); `secret.wrapped` is a file in the personal space wrapped under the **account root key** — new-device enrollment = login + read, no ceremony. A dedicated `waddle-backups` **space** holds the snapshots; the VM holds a **UCAN delegation** minted by the client (`crypto/ucan.ts`; audience = VM did:key, scoped to that space, revocable by DID) — plain `fetch` + bearer on the sync file routes, no SDK in the VM, no account identity. We skip the record/CRDT/FileStore layer entirely: `put/get` on `/api/v1/spaces/{id}/files/{id}` is the whole storage contract, `wrapped_dek` omitted (snapshot AEAD is fully ours — even the account hierarchy can't read snapshots; only the unlock secret can). Push failures retry with backoff, then sleep proceeds — RPO = last *successful* push.

**Restore = pull + untar — and every boot is a restore.** Unlock (the client also delivers the UCAN delegation alongside the secret) → read manifest → pull latest (gen++) → decrypt → unpack → resume; there is no "volume intact" fast path — that's the design, not a limitation. Client offline reading: download latest snapshot, decrypt, render — every enrolled device is a partial backup, which is what makes thin clients safe to hold nothing. Restore matrix: client lost → log in on any device (account keys recover the wrapped secret) → replay; VM gone → any snapshot renders history and seeds rehydration. **RPO = last checkpoint**; sleep = snapshot → push → exit, so voluntary sleep is zero-loss by construction. Multi-client consistency during live sessions comes from the VM's event log, not the store. Product payoff stands: an asleep VM gates *interaction*, not data.
## Reuse

| Piece | Source | Effort |
|---|---|---|
| Attested compute, client attestation | Tinfoil Containers + JS SecureClient | config + spike |
| Confidential inference | Tinfoil (pattern proven in `betterbase-inference`) | small |
| Auth for client login + concierge JWT validation | `betterbase-accounts` (OAuth 2.0 + PKCE, OPAQUE, JWKS) | reuse |
| Backup blob store + UCAN delegation | `betterbase-sync` file routes + `betterbase` SDK `crypto/ucan` (no CRDT/record layer needed) | reuse — thin REST adapter |
| Agent loop (tools, streaming, compaction, steering, skills, sessions, MCP) | pi SDK, embedded | trivial |
| History/memory conventions, untrusted tagging, SSRF-safe fetch | hiro patterns | small |
| Landlock/seccomp helper | hiro `internal/landlock` → Rust | deferred |
| Concierge | new, on betterbase accounts/backup store | deferred |

## Tech stack

- **Monorepo:** pnpm + TypeScript — `server` (gateway + harness + connectors — the single-user app that runs in the enclave), `client` (React), `sdk` (protocol), `concierge` (wake service), `config` (public tinfoil-config repo).
- **VM:** Node 22+, Fastify + ws, pi SDK, Playwright. No DB — files on scratch, snapshot-backed.
- **Client:** Vite + React; **assistant-ui** (chat surface) over **Vercel AI SDK** (`ai` + `@ai-sdk/react`, `useChat` with a **custom `ChatTransport` bridged to our WSS protocol** — replay + live tail converted to UIMessage parts; `@assistant-ui/ai-sdk` runtime on top); tinfoil JS SDK (`SecureClient`) for attestation + pinning — the same `secureClient.fetch` mechanic their AI-SDK examples use; canvas screencast, sleep/status, attestation badge, OAuth handoff, wake button all consume the `sdk` directly (they're event-log events, not conversation parts). Expo later via `sdk` + AI SDK React hooks (assistant-ui stays web-only).
- **Deploy:** single container, SHA-digest-pinned image; measured `tinfoil-config.yml` in a public repo; egress `open` (honest limit — see security domains). Tinfoil Projects give one config repo → N independently managed instances — the per-user primitive (quota 10/org). Container splits are a post-prototype hardening option.

**Dev & deploy loop — two environments, one image.** The artifact is always the Docker image Tinfoil measures; local compose exists only for the hot loop.
- **Local (hot loop):** one compose file — vm source mounted, `tsx watch`, Vite on localhost, blob store = the running betterbase-dev stack (`just dev` next door — accounts + sync on `*.betterbase.localhost`), wake via `docker start`, attestation shows a loud dev badge. The key hierarchy runs for real locally (unlock, vault envelope, snapshot AEAD, generation counter) — only disk encryption and attestation are stand-ins. The whole Phase 4 durability suite (kill -9 chaos, sleep, wake, restore) runs here, free and fast.
- **Tinfoil (truth):** debug containers (SSH, never real data; the SDK refuses them and clients inherit the refusal) for environment quirks; attested instances for acceptance gates and trust stunts. Inference is always Tinfoil — any OpenAI-compatible endpoint works in dev via `models.json`, but the quality bar is measured on Tinfoil. Deploy = `build && deploy`; no parity ceremony — the image is the artifact.
- **Two-backend adapters, config-selected** (store: dir | betterbase; concierge backend: `docker start` | `tinfoil` CLI; attestation: badge | `SecureClient`) — seams the design already has, not new machinery.
- **Self-hosting (others running waddle on their own Docker or Tinfoil org) is deliberately not a prototype target** — one-image-plus-config makes it additive later.

## Success: how we'll know

Muse's demos feel like: *it did the real thing, on the real web, while I watched — and it knew me.* Our proof has to show that **plus the one thing Meta can't demo: that nobody — including us — saw any of it.**

**The flagship run — "Dinner & a Show."** One live end-to-end errand:

> *"Book dinner for me and Sam Saturday — somewhere quiet, Sam's celiac, Mission area. Then find something after and get tickets. Put it on the calendar and email Sam the plan."*

Every step is a real-world side effect, and it compresses all five cores into one story:
1. **Memory:** knows Sam is the spouse, celiac, likes jazz, normal budgets — zero reminders given.
2. **Browser:** researches real restaurants and events on the live web; shortlists with reasons. Visceral on the screencast.
3. **Connectors:** reads the shared calendar for conflicts; writes the events; emails Sam via the hand-built Google connector.
4. **Approvals:** the reservation confirmation shows *exact* parameters before committing; a page-embedded "book for 20" injection can't sneak past the exact-parameter display.
5. **Takeover ×2:** the login OTP and the ticket checkout are the user's — grab the mouse, pay in ten seconds (the human pays; payments are a non-goal), hand back, agent resumes. A hard moment is not a demo failure, it's a takeover moment: graceful stuck-ness is the product.
6. **The confidentiality finale:** after the run, the operator view on camera — disk snapshot, logs, memory dump — all ciphertext and opaque metadata. *We built this and we can't tell you where you're eating Saturday.*

**The objective bar.** The Phase-1 eval suite is the regression suite: ≥80% on 15 tasks (browse / files / connectors / mixed), the injection gauntlet 100% blocked-or-escalated, the chaos test 10/10 clean resumes.

**The trust stunts** (what Muse can't demo): operator blindness shown live with full infra access and zero plaintext; a phishing/debug instance the client refuses before any secret moves; a pushed digest change that blocks every client until approved (old/new digests + repo-commit link); the "print your credentials" injection failing on camera during the real run.

**The dogfood bar.** Post-flagship, the real test: two weeks of the developer's actual life admin through waddle — real errands, not demos. Success = reaching for waddle instead of a browser.

**Scope honesty:** "similar capability" means on the axes we claim — the five cores. We don't prove purchases (the human pays), crons, or sub-agent fleets. The flagship's ceiling is the open model's browser quality — the week-1 eval measures it; takeover is the floor that keeps the demo alive regardless.

## Build plan

**How to build this (for an autonomous agent):**
- Phases in order; every ✅ acceptance gate must demonstrably pass — with recorded evidence (command output, transcripts, screenshots) — before the next phase starts. Commit per phase; deviations from this plan get flagged in the commit, not silently absorbed.
- **Authorities, in order:** this plan (design decisions are *closed* — never re-litigate the parked appendix or non-goals) → pi SDK docs (`@earendil-works/pi-coding-agent`; installed package + its `docs/` and examples) → docs.tinfoil.sh (containers / volumes / attestation) → `/Users/nchapman/Code/betterbase-dev` (accounts + E2E-encrypted files SDKs) → `/Users/nchapman/Code/hiro` (patterns to borrow, not a control plane). Read the authority before guessing; verify SDK signatures from source before mocking.
- **Invariants, not suggestions:** single append-only log (pi JSONL) = wire contract = resume; snapshot backup at quiescent checkpoints (they are the crash-safety story); single-user app mental model (no tenant machinery); zero lifecycle credentials inside the enclave; unlock secret never leaves the client un-attested.
- **Dev loop:** local Docker → debug enclave (SSH, never real data — the SDK refuses debug instances, clients inherit the refusal) → attested instance. No real third-party credentials until the vault + approval gate exist (Phase 3).
- **When stuck on a load-bearing unknown** mid-phase (attested WSS, SwiftShader, snapshot restore latency), use the plan's stated fallback where one exists; if none, spike it Phase-0-style — measure, then build. Facts beat the plan; goals don't move.

**Prerequisites (the kickoff checklist):** Tinfoil org + admin API key + inference key + spend ceiling (emails to Tinfoil drafted by the agent, sent by the owner). Betterbase: ✅ integration design settled against betterbase-dev source (accounts OAuth+PKCE, sync file routes, `crypto/ucan` minting — see §8); remaining: run `just dev` in `../betterbase-dev`, confirm `betterbase` npm linking (published vs workspace), register the waddle OAuth client via `setup-oauth-client.sh`. Owner-created: Google OAuth client (gmail.send + calendar; localhost + tinfoil redirect URIs), GitHub OAuth app + sandbox repo, throwaway test accounts (real creds gated on Phase 3; real calendar/Gmail sanctioned for the flagship), image registry + push token (GHCR), always-on host for the **concierge** (the wake service; local in dev). Operating policy: autonomous within a phase, evidence at every ✅ gate, stop-and-ask on invariant changes / real credentials / spend cap; secrets in gitignored `.env.local`.

**Divergences (First Hands, as built):** bash ships in the workspace toolset now
(the plan deferred it) because the approval gate makes it safe to run — bash always
asks, reads auto-allow, writes auto-allow in-workspace only (policy unit-tested).
The eval seed ran 5 tasks against both candidates (deepseek-v4-1-flash, kimi-k3)
through the live harness: 5/5 and 5/5. assistant-ui renders via a custom
`ChatTransport` over the gated WSS with one hard-won protocol rule: text parts
must be opened (`text-start`) before ANY text-delta — tool lines and approval
verdicts ride as fenced text in the assistant turn, and the seed of replayed
history maps tool rows back the same way so rehydration matches what streamed.
Step-up re-entry and connector-class approvals remain with the connector work;
the gate's deny-timeout and disconnect paths emit verdict events so no banner
can dangle.

**Divergences (The Eyes, as built — pulled forward for the demo):** the
browser phase ships before connectors/memory, demo-first. Architecture as
planned-in-spirit but concretely: headful Chromium under Xvfb inside the
enclave container (apt chromium, `--no-sandbox` as root), driven over local
CDP (ws to the page target). The viewport streams to the client as `frame`
events — jpeg q55, 1024px, wire-throttled ~10fps — riding the *existing*
attested ws as ephemeral broadcasts, never sealed into the log (frames are
views, not history); `browser_status` events update the client's URL bar.
The plan's "broker-mediated browser + take-over" lands as: agent tools
(browser_open / browser_snapshot / browser_click / browser_type) with the
approval gate on `browser_open` only — allowlisted domains
(`WADDLE_BROWSER_ALLOWLIST`) pass, everything else asks; clicks/types/snapshots
auto-allow; in-page link navigation follows without re-ask (the gate is the
explicit-open boundary). DOM-model driving (numbered clickables via
`data-waddle-idx`, no vision) — snapshot gives the model text + indices;
clicks highlight the element in the stream so the user sees exactly what the
agent clicked. Client: a BrowserPreview card (URL bar, LIVE pulse, fps
counter, expand) above the chat, fixed-overlay expanded view, ESC to
collapse. Post-fix proof: bare-domain allowlist normalization matches the
tool's (regression-tested). Live WebRTC capture remains the production
upgrade path.

**Divergences (The Backbone, as built):** durable history lives in the user's
betterbase store via a *tokenless relay*: the browser — never the enclave —
holds the betterbase session (OAuth+PKCE, public client `a5be475c-5f9b-47f0-aa39-ace116f7a8c0`,
scopes `openid sync`). The criterion-2 letter ("token delegated to the enclave
at unlock, memory-only") diverges deliberately: no betterbase credential ever
enters the enclave, even in memory. The snapshot is the same AEAD envelope as
the device backup (HKDF(secret,"waddle/backup")), double-sealed under
betterbase's platform E2EE — the store and the server both see only
ciphertext. On a fresh boot (log empty or sleep-wiped) the client pulls,
decrypts locally, and relays plaintext history over the attested ws
(`history_restore` intent); the enclave seals those rows into its log — the
same trust it holds for live turns. Device localStorage is the signed-out
fallback. Facts that cost debugging time: sync record ids must be UUIDs
(server storage layer rejects non-UUID ids — a rejected batch is quarantined
*silently*); the local db is offline-only until a `BetterbaseProvider` mounts
(sync engine); sleep wipes the scratch log down to the sleep marker, so the
hydrate decision filters bookkeeping events. Compose parity (criterion 6) is
the primary dev loop: all flows proven against betterbase-dev alongside the
compose stack. v0.0.16 (digest `33374016…`) is built, pushed, digest-pinned
in the config repo (tag + release `v0.0.16` published), and boots clean —
but Tinfoil's control plane 500s on every new-version `update`/`deploy
--tag` (old-version deploy works; retry over 20+ min, backoff, both paths);
live-enclave proofs (criterion 7) resume when the platform recovers.

**First milestone — First Light (the walking skeleton; Phase 0 + the spine of Phase 1):** *open the client, watch the attestation badge turn green, unlock with a secret only you hold, have a real conversation with the agent inside the enclave — then watch it sleep, and wake it back up.* Acceptance: (1) image on public GHCR digest-pinned, measured config repo, attested instance live; (2) in-browser SecureClient verification + report + TOFU pin that blocks on digest change; (3) lock screen → unlock: client-generated 64-byte secret delivered post-verification, locked→unlocked, session derived from the transcript; (4) real conversation: message → pi via Tinfoil inference (`@tinfoilsh/pi-provider` first, OpenAI-compat fallback) → streamed through the WSS event log → assistant-ui renders; refresh = full history via replay; (5) sleep + wake for real: idle gate → process exit (`restart: no`) → instance (and billing) stops → wake button → concierge boots → re-attest → unlock → snapshot restore → history intact; (6) identical flows under compose (docker backend) with betterbase-dev alongside. *Not in scope:* approvals UI, browser, connectors, memory, snapshots, multi-device.

**Phase 0 — Spike the real risks (2–3 days).**
Hello enclave: Node server in a Tinfoil Container; browser client verifies attestation via SecureClient and shows the report. Then the load-bearing unknowns:
- pi headless via a Tinfoil provider; **resume with a dangling tool-call**; an async approval resolved 60s later
- attested WSS through the enclave shim (fallback: attested HTTPS challenge → session token → WSS)
- Chromium under SwiftShader; cookie persistence across restart; **public IP stability across stop/start** (site-login survival depends on it)
- snapshot **round-trip** (push → stop → boot → restore); cold-boot wall-clock; wake-latency budget at MB-scale state
- informational: does Landlock/seccomp work under Tinfoil's defaults? Not load-bearing now, but it determines later hardening options
- **economics:** record the actual per-hour cost of our shape from the dashboard; email Tinfoil about researcher pricing, whether `/dev/sev-guest` is exposed to containers (sealed-storage potential — see risks), **and** whether a `restart: no` container whose process exits actually stops billing (agent self-sleep mechanism), plus whether scoped per-instance stop credentials exist (product concern: a shared org key would let one compromised enclave stop everyone's agents).

✅ *Acceptance: green attestation badge; pi answers via Tinfoil from inside the enclave; snapshot round-trip proven; go/no-go facts recorded for each item.*

**Phase 1 — Harness, gateway, tasks, approvals, memory (week 1).**
pi embedded with overrides; Tinfoil provider; **dev compose harness (dev + image variants, two-backend adapters)**; WSS protocol + React client (AI SDK transport + assistant-ui); file tools with root guards (no bash); approval gate with client round-trip, exact parameters, step-up; task records + event log with replay; checkpointed approvals + dangling-tool-call resume; session auth from unlock; **agent-directed sleep: end-of-turn `sleep_ok` proposal + deterministic gate + cancellable ~5-min buffer + process-exit stop; client wake button → concierge (`@waddle/concierge`, wake-only) → deploy → attest → unlock → resume**; memory loop — `persona.md`/`memory.md` injected at session start + the `memory` write tool (learn a fact in session 1, use it unprompted in session 2). **Model eval, week 1: build the 10–15 task suite, run 2–3 candidates, pick** — building on a model that fails it is the classic trap; week 4 re-runs this suite as the regression bar.
✅ *Acceptance: attested chat; agent edits workspace files; irreversible actions require step-up; `kill -9` mid-approval and mid-tool → correct resume on restart; idle agent with a clean gate sleeps, and a client wake resumes it with memory intact; a fact told in session 1 is used unprompted in session 2.*

**Phase 2 — Browser (week 2).**
CDP broker + Chromium; browser sub-agent (a11y snapshots, screenshots, network capture); screencast to client; input injection + takeover-at-broker; URL/domain gate; untrusted tagging on everything the browser returns.
✅ *Acceptance: agent researches on the live web; user watches, grabs the mouse mid-task, agent pauses; captcha-takeover loop works; a page-embedded "visit attacker.com" is blocked or escalated.*

**Phase 3 — Connectors (week 3).**
authd vault incl. `refreshIfNeeded`; OAuth enclave-callback; GitHub via MCP (scoped, gated); hand-built Google connector (gmail.send + calendar read/write — one OAuth app); token exchange + refresh in-worker; injection test: asking the agent to print tokens fails.
✅ *Acceptance: connect GitHub in the client; agent opens a PR via credentials it has never seen; approval shows exact parameters before the write.*

**Phase 4 — Durability + honesty (week 4).**
Model eval re-run on the chosen model (regression bar, ≥80%); restart-chaos test (random kills × N, assert resume); generation counter; unlock-secret wrapping + client-held backup; snapshots: encrypt → push → restore; *(stretch, post-flagship: client renders offline from latest snapshot)*; rehearse the flagship run end-to-end (see Success); docs — threat model with honest limits, cookie/IP caveats, what a future keyserver changes.
✅ *Acceptance: eval results recorded; destroy the enclave, redeploy, unlock, agent resumes with memory intact; blank scratch → wrapped secret → pull latest snapshot (memory + history render, browser re-logins); threat-model doc published; flagship run completed live once.*

**Phase 5 — post-prototype, in order.**
Kernel confinement where it pays (Landlock/seccomp helper or container splits; installability checked in Phase 0); sandboxed bash; egress policy. Then Concierge + warm-window scale-to-zero; cron + opt-in enclaved keyserver; MCP isolation; mobile (Expo) on the same `sdk`; multi-device sync.

## Product-phase design (parked)

**Concierge** (the only shared always-on service): user → enclave map; wake/sleep via the Tinfoil API; presence heartbeat ("alive / asleep / booting"); cron triggers (schedule *times* are visible to it — timing is metadata; task *payloads* stay in E2E blobs); approval pings (content-free push; mobile later); webhook ingestion — scale-to-zero uses wake-and-wait until escrow (receive → wake → ping → deliver post-unlock; wake-timeout stops instances stuck `locked`); the Concierge sees webhook payloads at the TLS-termination instant — mitigation ladder: seal-and-forget → receiver enclave → Concierge-in-TEE.

**Custody ladder for unattended wake.** **Tier 0, manual:** state sealed to the user alone; no unattended boots. **Tier 1, escrow:** keyserver enclave (its own TEE) releasing the secret only to user-pinned release tags, every release audited. **Tier 1.5, scoped escrow:** domain-separated derivation (`HKDF(secret,"autonomy")` vs `HKDF(secret,"vault")`) — unattended boots get memory + browsing + queued approvals, while payment-class credentials and irreversible sends stay attended-only. Autonomy with a blast-radius dial. Always-on delivers boots-itself autonomy with *no* escrow but 24/7 compute; tap-to-unlock (push → biometric tap → client delivers the secret it already holds wrapped — a UX flow, not new crypto) patches the reboot gaps in every tier. The release-approval UX (visible diff, signed changes) is the security-critical surface once escrow exists.

**Volume-free unattended boots:** the keyserver releases only the autonomy subkey; the lean agent hydrates memory/skills/task payloads from the backup store (autonomy-domain blobs), runs, writes results back, sleeps — the sealed disk stays sealed. Opting the browser profile into the autonomy domain ("stay logged in while I sleep") is the user's call — cookies are bearer credentials.

**[Refined 2026-10-09] Concierge-in-TEE — stateless escrow agent.** The concierge becomes the TEE'd supervisor (always-on, tiny; the one thing that never sleeps): admin key injected via Tinfoil-managed secrets, memory-only; **egress locked to the controlplane** (an enclave bounds the host, not its own bugs — the one-verb surface + egress wall is the containment); authorization is betterbase-native UCANs (owner did:key → machine key, revocable, time-scoped). **Everything client-derived is memory-only: reboot = full wipe, by construction** — no storage exists, so delegated authority and escrowed secrets cannot outlive the enclave; death is the strongest revocation. Recovery is client-healed: a fresh concierge re-reads durable wake intents from betterbase (data persists, authority doesn't), finds intents with no live delegation, and push-notifies those accounts to return for the re-delegation dance (push delivery is the one operator-visible seam — tokens are metadata, contents are not). Present users re-delegate silently at unlock, then wake. This inverts the prototype's "schedule = stay-alive" rule in the product phase: agents register a wake intent, checkpoint, and die — cost drops from 24/7 to per-task windows. Operator/user split stays clean: operators resurrect the *mechanism* (admin key buys liveness, never authority); delegations bind to the concierge's measured did:key (config-endorsed, TOFU'd) so a swapped "concierge" harvests nothing.

**Sealed storage — silicon escrow (Tier 1.5′, researched):** `SNP_GET_DERIVED_KEY` derives a key from chip-unique PSP secrets bound to the launch measurement (+ optional TCB/policy fields) — the same chip + the same measured image re-derives it on every boot. Seal the autonomy subkey only, store the sealed blob on a low-custody boot volume (inert off-chip); unattended wakes self-unseal with zero keyserver trust in secret material; updates re-key the seal by design — the old, user-approved release unseals and re-seals to the new release's measurement after checking the approved-tag list: **release pinning enforced by silicon**. Hazards: chip-pinning (host loss = sealed autonomy lost; user re-seals on next unlock), TCB drift on AMD firmware updates. Unreachable on Tinfoil today (attestation.sock serves reports only; attested-keys are per-boot) but one small feature away — the CVM owns the PSP relationship; native on raw Azure/GCP CVMs (the Plan B path); Cocoon productizes a TDX variant; Edgeless/CoCo converged on key-release (the pattern the keyserver tier follows). **Phase 0 asks Tinfoil: derived-key via the attestation socket (or persistent attested-keys); customer SNP ID blocks (owner-signed launch digests — boot-time enforcement)?**

## Risks & open questions

- **[Decided 2026-10-07] Shared-pool persistent volumes — dropped.** Tinfoil's shared pool offers no per-org persistent disks (`tinfoil volume create` requires org hosts; `container hosts` = none); the platform `--auto-unlock` path keys volumes via Tinfoil's control plane — a custody violation regardless of cost. Persistence is snapshot-only (§7–8): hydrate on boot, checkpoint at idle gates + exit. Org hosts may return as a wake-latency optimization, never as a custody dependency.
- **Operator code trust** — the asterisk on "no pinky-promises": measurement pinning, visible diffs, (product) per-user config forks. In the docs day one.
- **Open-model agent quality** — biggest demo risk; the week-1 eval is go/no-go; vision checked in Phase 0 (browser screenshots are where the demo dies).
- **pi dependency** — MIT, forkable, digest-pinned; coding-agent shape mitigated by loader overrides; headless smoke-tested Phase 0.
- **In-VM lateral movement unbounded (by decision)** — renderer RCE or compromised gateway reads the whole VM; bounded by the TEE, not within it; hardened after the parts work.
- **Chromium in the enclave** — SwiftShader; 1–2 fps screencast; 16GB likely; cookie/IP stability spiked Phase 0.
- **Provider concentration / Plan B:** Tinfoil is the only product bundling TEE + in-browser attested client + lifecycle API today. Designated fallback: **Azure CVMs** (`DCasv5`/`DCev5`, ~$0.13–0.15/hr for 2c/16GB, deallocated = disk-only, no instance quota) — costs ~1–2 weeks of platform rebuild (provisioning automation, LUKS + our own unlock flow, attestation via browser-verifiable Azure Attestation tokens, wildcard DNS/TLS) but gains **native `/dev/sev-guest`** — silicon escrow implementable today — and better sleep economics. Migration insurance (cheap, from day one): unlock flow stays our own protocol; attestation verification abstracted behind our client SDK; state in our own app-layer formats — all already true. Tinfoil inference is provider-agnostic from any enclave (SDK verifies the inference TEE from inside our VM). GCP is a parallel option; ACI confidential containers are a niche middle; Phala Cloud needs a custody audit before trusting.
- **Cost & billing topology:** Tinfoil bills per runtime-hour by resource shape + $20/mo base; org quota is 10 instances — operator-pays caps at ~10 users. Always-on = ~730 hr/mo/user, which is what makes warm-window scale-to-zero economically necessary, not just nice. Confidentiality survives operator-pays (client-enforced attestation + key custody — the operator can DoS or delete, never read), but the product path is **BYO-account**: per-user config forks deploying into the user's own Tinfoil org on their card — the operator exits both the trust and billing loops. Researcher discount worth requesting.
- **Key custody UX** — full-entropy secret, optional passphrase wrap; export now, wrapped backup week 4.
- **No provider offers memory-preserving sleep for confidential VMs** — Azure CVMs can't hibernate, GCP migrates only legacy SEV, QEMU has SEV snapshot/restore as TODO, Tinfoil's attested-keys are explicitly per-boot. It's the hardware model (memory keys are unexportable), so app-level checkpoint+resume *is* the correct idiom — our design is aligned, not working around a gap.
- **Sealed storage → silicon escrow:** researched and parked in the appendix; Phase 0 carries the Tinfoil asks.

## Non-goals for the prototype

Kernel confinement, sandboxed bash, egress policy, Concierge's product surface (presence, cron, webhooks — its wake-only embryo ships in Phase 1), scale-to-zero, cron infrastructure (in-VM timers for scheduled tasks *are* in scope), keyserver escrow, mobile, generic HTTP connector, policy engine, eBPF taint tracking, payments, classifier-based injection detection (rules + tagging only), multi-user, federation, CBOR, self-hosting distribution (one-image-plus-config makes it additive later).
