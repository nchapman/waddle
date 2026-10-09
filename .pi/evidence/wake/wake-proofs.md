# Wake scheduling — live prod proof (2026-10-09)

The full unattended-ish cycle on prod tinfoil, one day after the dev E2E,
waddletest2@betterbase.dev, waddle v0.0.37 + concierge v0.2.3.

## Cast

- `waddle` — v0.0.37 (`sha256:7e230fe7…`), measured at waddle-config@v0.0.37,
  snp_measurement `e9c2f601e8c5…0d906d4a`, org secret CONCIERGE_SHARED_SECRET
- `waddle-concierge` — v0.2.3 (`sha256:99808d31…`), its own deployment +
  config repo (nchapman/waddle-concierge-config), egress allowlisted to
  `api.tinfoil.sh` only, org secrets TINFOIL_ADMIN_KEY + CONCIERGE_TOKEN,
  memory-only timer table, tinfoil CLI 0.19.0 baked in

## The cycle (timestamps UTC, from /debug/log ring + concierge /status)

1. 19:41:38 — unlock (stored secret, tk_ inference key, prod bb grant):
   restore gate fresh → `machine restored from shelf` on the first boot;
   `concierge handshake {ok:true, via:"shared-secret"}` (the v0.0.35
   fallback fix, live) → stop backstop armed idle+30s = 615 s out.
2. 19:42:30 — agent schedules via its own `schedule_create` tool:
   id `0945ebff…`, one-shot 19:55:30Z ("live wake test").
3. 19:43:20 — user closes the tab (socket drops).
4. ~19:52:40 — idle gate (600 s): checkpoint → final shelf push →
   death flare (stop @+5 s) + wake row (job `0945ebff…`, due 122 s out
   at 19:53:27 observation) → process exit → zombie "Running".
5. 19:55:30 — wake row fired; the concierge's deploy initially failed
   silently (see bug below), recovered at 20:10 via `/wake`:
   `(zombie recovered)` — stop → poll → deploy, fresh CVM.
6. 20:11:29 — unlock on the fresh boot: `machine restored from shelf
   {gen:22, events:5}` (full transcript + schedules.json; pi session
   resumed natively), handshake via shared-secret, initial push fa4873e5.
7. 20:11:34 — due-ticker fired the overdue one-shot **3 s** after the
   socket connected: agent replied "Wake test worked — I'm up. 🦆",
   ran `schedule_list` (row `done … last run 20:11:34`), sealed in the log.
8. Steady state: stop row re-armed, wake jobs empty (one-shot exhausted).

## Bugs the live ceremony flushed out (each fixed + verified live)

- **Stop-lease race** (dev E2E, pre-release): arming the platform stop at
  60 s while the idle gate waits 120 s let the concierge SIGKILL the
  machine before its own checkpoint-exit. The stop row is a zombie
  backstop now: always idle+30 s from last contact, replaced by the 5 s
  death flare at the gate.
- **Missing system CA bundle** (live, concierge v0.2.1→v0.2.3):
  `node:24-slim` ships `/etc/ssl/certs` empty; Node bundles its own roots,
  the Go tinfoil CLI does not → every platform verb failed with
  `x509: certificate signed by unknown authority` while fire-and-forget
  rows consumed silently. Fix: `ca-certificates` in the image. The
  `/wake` error surfaced it verbatim; `(zombie recovered)` proves the fix.
- **bb-JWT-only handshake** (live, waddle v0.0.35): with a bb grant armed,
  the handshake sent only the 15-min JWT; the concierge (no JWKS yet)
  401'd and the whole timer path stayed dead. Fix: fall back to the
  shared secret; `via:"shared-secret"` in the ring is the fix working.
- **YAML quote casualty** (ceremony): a sed digest-swap ate the image
  line's closing quote → "mapping values are not allowed" at line 11,
  two burned release tags (v0.0.35/36) before the real cause was visible.
- **Vite env precedence** (client): `.env.development` overrides
  `.env.local` in dev mode — live env must go in `.env.development.local`
  (plus the prod bb client id `d096d76d…`, recovered from the session
  record after my `.env.local` rewrite dropped it).

## Known seams (follow-ups, not blockers)

- Server-fired turns (scheduled runs) don't append to the live thread —
  they're in the sealed log and /state; a page reload renders them.
- Page reload re-sends the last user message (the agent fielded the
  scheduling request twice; it declined to double-book).
- Unattended autonomy stays parked: on tinfoil every deploy is a fresh
  volume, and the wake-credential (excluded from the shelf by design)
  dies with the CVM — wake-boots are user-in-the-loop until the escrow /
  renewal-token design lands (PLAN.md).
- The concierge /health version string reads 0.2.1 (constant not bumped
  with the image tag); cosmetic.

## Incident + fix: the gate that raced its own unlock (v0.0.38 → v0.0.39)

**The bug** (found live on prod, 2026-10-09 20:43): the activity clock
initialized at BOOT, but the gate only checks the lock state — so an
enclave that sat locked longer than the idle window (prod deploys take
minutes) was reaped the moment its first unlock flipped `unlocked`,
mid-restore, before any WebSocket existed. Signature: a shelf whose
chain head is an empty gen holding one `sleep "idle 120s"` event
timestamped DURING the unlock — the final checkpoint clobbered the
live gen-22 machine (content survives behind it in the bb store;
anchor 1c3bf4d6, recovery parked). Compounding it: the idle default
was 120 s (a dev convenience that shipped), making the race certain.

**The fix** (v0.0.39, regression-proven):
- `lastActivity` starts null — the clock begins at first client
  contact (unlock stamp / WS connect / sink events), never at boot.
- `restoring` guard: the gate never fires while an unlock (bb grant +
  shelf restore + handshake) is in flight.
- Idle default 600 s; prod config sets `WADDLE_IDLE_MS: "600000"`
  explicitly.
- Regression script: `locked-idle-regression.mjs` (boot → 150 s
  locked-idle → unlock → must survive to idle-from-unlock, then sleep
  gracefully). Green on v0.0.39 (unlock 20:56:01 → sleep 20:58:09,
  event delivered to the silent client, exit 0).
