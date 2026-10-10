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
- **The shim `paths` list is an exact-match ingress allowlist** — every new
  endpoint path must be added to the concierge config's shim or it 404s at
  the gateway (bit us three times: /handoff, /handoff/pull, /handoff/post + /handoff/post/pull — all in as of concierge v0.3.12).
- **Concierge escrow is memory-only** — no volumes, no keyservers, nothing at
  rest (user decision, final). Machines are cattle; the shelf is the state.

## Local layout

- vite :5173 (dev/compose parity), :5174 (live mode); compose :8080
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

## Live-environment facts (as of v0.0.44 / concierge v0.3.11)

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
- Waddle deploys take ~75-95s (platform-side); wake fire → restricted
  self-unlock ≈ 96s.

## Browser-driving rules (Playwright MCP against the client)

- Navigate ONCE per real URL change — every reload restarts client
  attestation from scratch and can wedge it at "Attesting the enclave…".
- The loop is: `browser_wait_for` (text appear/gone) → `browser_find`
  (locate element + ref) → `browser_click`/`browser_type` via ref.
  `browser_snapshot` for full state; `browser_evaluate` for chat-log tails;
  screenshots time out on the live-stream element (use DOM extracts for
  evidence).
- Server-fired turns (scheduled runs) don't append to the live thread —
  reload + "resume session" renders them (parked client bug).

## Two-tier autonomy (decided 2026-10-10, v0.0.46 design)

Background tasks off (default) = no delegation, concierge holds zero
secrets. Background tasks on (warned client dialog, user preference) =
full delegation: escrow carries master secret + schedules + sealed ~64 KiB
snapshot; scheduled boot restores then does a VERIFIED unlock; one
master-sealed log; re-snapshot/re-arm at autonomous re-sleep. The
invariant: operators can't read data without breaking the enclave
(nothing at rest is plaintext; secrets are memory-only in enclaves).
Residual (tier 1): machine→concierge is shared-secret, not attested —
fake-concierge capture is the known active-attack surface; UCAN/silicon
are the parked fixes. Full statement in PLAN.md "[Decided 2026-10-10]
Two-tier autonomy". betterbase-accounts#1 closed — no bb changes.

## Known open items (as of v0.0.44 / concierge v0.3.11)

- **Autonomous output dies with the machine** (bb-grant gap; schedules
  survive and re-fire at next unlock — eventual consistency, proven).
  Parked fix: concierge-as-postbox (sealed event tail POSTed at sleep,
  merged at next unlock).
- Client bugs filed: after /assign the SDK's pinned fetch still targets the
  primary ("refusing to send request… bound to the verified enclave/proxy");
  zombie stale locked:false "resume session"; reload re-sends last message;
  server-fired turns need reload (above).
- Agent context does not survive boots (UI replays history; the pi session
  starts fresh). Planned seam: `session.sendCustomMessage(..., {deliverAs:
  "nextTurn"})` on history_restore.
- Browser tools: no scroll, and body links on long pages (wikipedia) fall
  outside the 80-element clickable index — the agent works around it by
  navigating directly (observed live).
- Live stream is jpeg-over-ws (~10fps); WebRTC is the production upgrade.
- k=1 accepted risks (per-machine identity + UCAN is the k>1 fix, PLAN.md):
  shared secret as identity proxy, shared "waddle" instance name,
  poison-arm overwrite, captured-release-is-the-secret; /handshake→/timer
  stays open to secret-holders until then.
- User decisions pending: pool overnight economics (one warm standby always
  burning); restricted-mode scope for real scheduled work (browser? with
  which approvals?); optional CONCIERGE_SHARED_SECRET rotation.
