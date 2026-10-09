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

## Wake latency, measured (2026-10-09, v0.0.39/v0.0.40)

Page-load → chat-ready, resource-timed from the browser:

| phase | t | cost |
|---|---|---|
| probe fails, auto-wake POST /wake | +2.2s | — |
| **tinfoil container deploy (via concierge)** | +2.2→76.2s | **74s** |
| first health poll OK | +78.2s | ~2s cadence |
| attestation → unlock screen | ~+80s | ~2s |
| unlock (bb grant + shelf restore + handshake) | +127.1s | **6.7s** |

The platform deploy is 85–90% of the whole path (three samples: 42s
human-timed, 73s CLI-timed, 74s concierge-timed — concierge adds ~1s,
deploy cost is platform-side). Client-side sequencing (probe, poll
cadence, serialized attestation) is ~6s total — polish, not the lever.
Real levers: warm window (doze state, hold the exit N min), scheduled
pre-wake rows, or a standby instance (doubles idle spend). Also proven
tonight: the manual 💤 sleep button (click 21:22:19 → Stopped 21:23:06,
graceful checkpoint + flare), and a second user's uncoordinated wake.

## Instance-provided inference (v0.0.40)

TINFOIL_API_KEY moved from client-delivered-at-unlock to a tinfoil org
secret in the config's secrets list — the server already read
process.env.TINFOIL_API_KEY (initAgent just sets it), so zero code
changed. Proven live: unlock with an EMPTY key field on v0.0.40 →
agent answers ("17×23 → 391") on the boot-time env key. This is what
makes unattended wake-boots possible: a scheduled task can now think
without any human unlocking. The client field remains as an optional
override (BYOK) — blank means instance-provided. Note: config changes
re-measure (secrets list is part of the measurement) → TOFU re-pin on
v0.0.40 was expected. Remaining proof: the unattended ceremony
(schedule → sleep → wake row → task runs, no unlock, re-sleep).

## Wake latency, measured (2026-10-09, v0.0.39/v0.0.40)

Page-load to chat-ready, resource-timed from the browser:

| phase | t | cost |
|---|---|---|
| probe fails, auto-wake POST /wake | +2.2s | - |
| tinfoil container deploy (via concierge) | +2.2 to 76.2s | 74s |
| first health poll OK | +78.2s | ~2s cadence |
| attestation to unlock screen | ~+80s | ~2s |
| unlock (bb grant + shelf restore + handshake) | +127.1s | 6.7s |

The platform deploy is 85-90% of the whole path (three samples: 42s
human-timed, 73s CLI-timed, 74s concierge-timed — the concierge adds
~1s; deploy cost is platform-side). Client-side sequencing (probe,
poll cadence, serialized attestation) is ~6s total — polish, not the
lever. Real levers: warm window (doze state, hold the exit N min),
scheduled pre-wake rows, or a standby instance (doubles idle spend).
Also proven tonight: the manual sleep button (click 21:22:19 to
Stopped 21:23:06, graceful checkpoint + flare) and a second user's
uncoordinated wake+unlock.

## Instance-provided inference (v0.0.40)

TINFOIL_API_KEY moved from client-delivered-at-unlock to a tinfoil org
secret in the config secrets list — the server already read
process.env.TINFOIL_API_KEY (initAgent just sets it), so zero code
changed. Proven live: unlock with an EMPTY key field on v0.0.40, agent
answers (17x23 -> 391) on the boot-time env key. This is what makes
unattended wake-boots possible: a scheduled task can now think without
any human unlocking. The client field remains as an optional override
(BYOK) — blank means instance-provided. Note: config changes
re-measure (the secrets list is part of the measurement), so the TOFU
re-pin on v0.0.40 was expected. Remaining proof: the unattended
ceremony (schedule, sleep, wake row fires, task runs with no unlock,
re-sleep).

## Warm-standby pool: design validated (2026-10-09 21:52)

The multi-user shape: concierge + N warm standbys (blank, locked,
env-inferred, zero user state). A user arrival gets a standby ASSIGNED
(URL handout); their secret makes it theirs (unlock + shelf restore);
a replacement standby boots in the background. TTL drops unclaimed
warm machines. Proven live, end to end, with zero pool code:

- `tinfoil container create waddle-standby-1 --repo nchapman/waddle-config
  --tag v0.0.40` — second instance from the same config, 77s to live.
- Client repointed at it: TOFU pin HELD (same config = same measurement,
  no re-pin) — attestation travels across instances.
- Unlock on the standby restored the user's full state (gen 38, 29
  events — including an earlier session's chat) from a machine that
  booted blank 56s earlier; handshake ok; initial push ok.
- Latency: page load to live chat ~17s (10s attest+unlock-screen, 7s
  unlock+restore) vs ~87s via the deploy path. The 77s replacement
  boot hides behind the user's session.

Build notes (concierge grows a tiny scheduler, still metadata-only):
- machines table {name, state: warm|serving|stopped, claimed_at, ttl};
  /assign endpoint; TTL sweeper; background replacement boots;
  health-first wake (a wake row finding a live machine no-ops instead
  of the zombie stop-deploy dance).
- Env knobs, per request: WARM_POOL_SIZE (default 1),
  STANDBY_TTL_MINUTES (default 60), STANDBY_CREATE_TIMEOUT_S.
- Per-instance WADDLE_INSTANCE (tinfoil create --variable) — pool
  machines must not handshake under a colliding instance name (the
  experiment's standby handshook as "waddle" and clobbered the real
  machine's stop row; harmless tonight, a real bug in a pool).
- Doze (single-user warm window) is subsumed: a pool of one. Doze is
  cheaper at k=1 user; the pool amortizes 1/k machines per user as k
  grows.
- Scheduled tasks still can't read the user's shelf unattended (the
  escrow problem is unchanged — pool solves return latency, not
  unattended data access).
