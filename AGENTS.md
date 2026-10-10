# waddle — agent notes

## Standing policies

- **Always do the deploy ceremony** after verified changes that touch the
  server image: buildx push → pin digest in /tmp/waddle-config
  (git repo, origin git@github.com:nchapman/waddle-config.git) → commit+push →
  `gh workflow run tinfoil-release.yml -f version=vN` (never manual
  `gh release create` — the platform 500s on it) → wait for the auto-triggered
  publish to attach tinfoil-deployment.json + tinfoil.hash →
  `tinfoil container update waddle --tag vN --yes` (env from `.env.local`;
  tinfoil CLI on `~/.local/bin`) → poll `/health` for *locked* → TOFU re-pin
  in the client → quick live smoke. Track the pinned config in
  `config/tinfoil-config.yml` in the same commit train.
- **The concierge has its own ceremony** (repo `/tmp/waddle-concierge-config`,
  origin git@github.com:nchapman/waddle-concierge-config.git, same flow, image
  `ghcr.io/nchapman/waddle-concierge`). Both repos' publish workflows
  self-install current gh (runner gh flakes too old are handled).
- **Edit YAML digests with python** (`re.sub`), never sed — sed ate a closing
  quote once and shipped a broken release (v0.0.42, `image: …@`).
- **Every waddle release implies a concierge config bump** (STANDBY_CONFIG_TAG
  treadmill — standby-create skew is the same client-refusal class as deploy
  skew). Concierge config changes re-measure the concierge only; the client
  never verifies it, so no TOFU re-pin for concierge deploys.
- **`tinfoil container update waddle-concierge --tag vN` re-deploys the
  tag's FROZEN config** — a STANDBY_CONFIG_TAG bump pushed to main does
  NOT reach the running concierge until a NEW version is released (bit
  us at v0.0.47: the concierge kept deploying v0.0.46 standbys/main
  replacements and the wake fire hit an "already running" stray →
  ceremony dead, 18:43Z). Every waddle release implies a concierge
  VERSION bump + release, not just a config commit.
- **Book scheduled fires ≤ sleep+3.5min** — stopped instances can get
  replacement-deployed on a ~4min platform cadence; a later fire hits
  `ensureInstance` → "already running" → the occurrence is consumed
  with no boot. Tight booking wins the race.
- **`tinfoil container deploy --tag vN` does NOT update the saved spec** —
  the concierge's wake path redeploys the SAVED tag, so a deploy-only
  release makes every wake boot the previous version (bit us at v0.0.46:
  wake booted v0.0.45 subkey code against a {secret,snapshot} credential →
  locked burn). Always run `tinfoil container update waddle --tag vN --yes`
  (which does persist the tag) after any release deploy.
- **The concierge release window must outlive platform deploy latency** —
  the fire→pull gap is ~90s normally, but certificate issuance stalled to
  5.4 min once, closing the hard 3-min window before the boot's pull
  (v0.3.13 makes it `WAKE_RELEASE_WINDOW_MS`, set to 10 min in config).
- **The shim `paths` list is an exact-match ingress allowlist** — every new
  endpoint path must be added to the concierge config's shim or it 404s at
  the gateway (bit us three times: /handoff, /handoff/pull, /handoff/post + /handoff/post/pull — all in as of concierge v0.3.12).
- **Concierge escrow is memory-only** — no volumes, no keyservers, nothing at
  rest (user decision, final). Machines are cattle; the shelf is the state.

## Local layout

- vite :5173 (dev/compose parity), :5174 (live mode — BLOCKED by default:
  concierge `CONCIERGE_ALLOWED_ORIGINS` defaults to localhost:5173; use
  `pnpm dev --port 5174`, not `pnpm dev -- --port 5174`); compose :8080
  (`docker compose down -v && up -d`); concierge :5390; betterbase-dev is a
  compose stack in `../betterbase-dev` (:5377/:5379, `docker compose -f
  docker-compose.yml -f docker-compose.dev.yml up -d`). Test account
  waddler / iceflow-flipper-9.
- `/tmp` clones (waddle-config, waddle-concierge-config) and
  `/tmp/waddle-concierge-shared-secret` die on reboot — re-clone; the secret
  value exists ONLY in the tinfoil vault now (`secrets get` never returns it;
  rotation = re-measure + re-pin treadmill, ask the user).
- Evidence lives under `.pi/evidence/` (never committed except the
  wake-proofs.md narrative, which is tracked).
- Stray `.bak`/`.bak2` files are old debris — do not commit.

## Live-environment facts (as of v0.0.48 / concierge v0.3.15)

- **Stop = DNS teardown (platform, proved 2026-10-10 at Cloudflare's
  authoritative NS)**: a stopped instance's name NXDOMAINs authoritatively;
  deploy re-adds it in ~90s. SOA negative TTL is 1800s, so every resolver
  that queried during a sleep caches NXDOMAIN up to 30min — the recurring
  "browser can't reach a freshly-woken machine" class. curl --resolve
  (or the tinfoil verified proxy) sidesteps it; AdGuard cache settings
  were tuned 2026-10-10 to blunt the local amplification. Random per-boot
  names ("every boot is a standby") would kill the class — parked in
  PLAN.md territory (discovery via concierge, zone-bind trust).
- **A deployed-but-unattended machine lives ~10.5min by design**: the
  locked-boot stop backstop (WADDLE_IDLE_MS+30s) reaps boots nobody
  unlocks, and the concierge's 24h-quiet sweep reaps machines its table
  remembers. Both fired during the v0.0.48 deploy (22:13:34Z stop =
  boot+10.5min exact). "Mystery stops" of a fresh deploy are one of these
  two, not platform flakiness.
- **Client /wake + /assign are 401 in live mode (as of v0.0.48)**: the
  deployed concierge has no CONCIERGE_JWKS_URL (secret-only auth) and the
  client's VITE_CONCIERGE_TOKEN predates the vault-only rotation, while
  its egress allowlist (api.tinfoil.sh only) couldn't fetch JWKS anyway.
  Decision pending: JWKS trio + egress for betterbase.dev (the designed
  bb-JWT client path) vs rotating the shared secret into the client env.
- ATC (atc.tinfoil.sh) 500s intermittently ("Failed to build attestation
  bundle") — blocks client verification, fail-closed; recovers on retry in
  minutes. `curl -X POST https://atc.tinfoil.sh/attestation` is the probe.
- /status on the concierge needs `authorization: Bearer <shared secret>` —
  we have no local copy (see above); /health is public.
- DNS playbook (live 2026-10-10): a single-name NXDOMAIN through the local
  resolver chain was an AdGuard Home negative-cache entry poisoned from an
  upstream (Quad9) blip. Diagnose by digging each resolver in the chain
  (100.100.100.100 tailscale → AdGuard → upstreams → authoritative); the
  record was healthy everywhere else. Clear the cache only AFTER upstream
  heals, or the clear re-poisons (30-min TTL).
- Waddle deploys take ~75-95s (platform-side); wake fire → restored+
  self-unlocked ≈ 80-96s (observed 79s at v0.0.47, 96s at v0.0.45).

## Browser-driving rules (Playwright MCP against the client)

- Navigate ONCE per real URL change — every reload restarts client
  attestation from scratch and can wedge it at "Attesting the enclave…".
- The loop is: `browser_wait_for` (text appear/gone) → `browser_find`
  (locate element + ref) → `browser_click`/`browser_type` via ref.
  `browser_snapshot` for full state; `browser_evaluate` for chat-log tails;
  screenshots time out on the live-stream element (use DOM extracts for
  evidence).
- Server-fired turns mid-session (scheduled runs while the client
  watches) don't append to the live thread — reload + "resume session"
  renders them (parked client bug). Unlock-time postbox merges DO render
  live (proven, proof 6 read-back).

## Two-tier autonomy (decided 2026-10-10, shipped v0.0.47 — proven live)

Background tasks off (default) = no delegation, concierge holds zero
secrets. Background tasks on (warned client dialog, user preference) =
full delegation: escrow carries master secret + schedules + sealed
CONTEXT snapshot (shelf archive minus `browser/` — the profile is tens
of MiB and trips the 768KiB arm cap; unattended boots need
log/verifier/workspace/schedules, not logins); scheduled boot restores
then does a VERIFIED unlock (boot marker says which — `enrolled:true`
alone can't, TOFU re-enrolls deterministically); one master-sealed
log; re-snapshot/re-arm at autonomous re-sleep. Proven 2026-10-10
19:08–19:29Z (wake-proofs.md proof 6): planted workspace fact →
arm → fire → restored boot → read-tool proof with the fact → postbox
delivered exactly once at unlock. The
invariant: operators can't read data without breaking the enclave
(nothing at rest is plaintext; secrets are memory-only in enclaves).
Residual (tier 1): machine→concierge is shared-secret, not attested —
fake-concierge capture is the known active-attack surface; UCAN/silicon
are the parked fixes. Full statement in PLAN.md "[Decided 2026-10-10]
Two-tier autonomy" + the [Implemented] block. betterbase-accounts#1
closed — no bb changes.

## Known open items (as of v0.0.47 / concierge v0.3.14)

- ~~Autonomous output dies with the machine~~ — RESOLVED: the postbox
  (v0.0.45+) + context snapshot (v0.0.47) deliver unattended output
  exactly once at next unlock; proven live, proof 6.
- Client bugs filed: after /assign the SDK's pinned fetch still targets the
  primary ("refusing to send request… bound to the verified enclave/proxy");
  zombie stale locked:false "resume session"; reload re-sends last message;
  server-fired turns need reload (above).
- Agent context now rides the snapshot on restored boots (proof 6:
  "session resumed natively from …/sessions/…" in the boot log);
  fresh-volume boots still start a new pi session — the planned seam
  (`session.sendCustomMessage(..., {deliverAs: "nextTurn"})` on
  history_restore) stays parked for smoothing the UI-replay path.
- Browser tools: no scroll, and body links on long pages (wikipedia) fall
  outside the 80-element clickable index — the agent works around it by
  navigating directly (observed live).
- Live stream is jpeg-over-ws (~10fps); WebRTC is the production upgrade.
- k=1 accepted risks (per-machine identity + UCAN is the k>1 fix, PLAN.md):
  shared secret as identity proxy, shared "waddle" instance name,
  poison-arm overwrite, captured-release-is-the-secret; /handshake→/timer
  stays open to secret-holders until then.
- User decisions pending: pool overnight economics (one warm standby always
  burning); restricted-mode scope for real scheduled work (read-only proven
  live — browser? with which approvals? still open); optional
  CONCIERGE_SHARED_SECRET rotation.
