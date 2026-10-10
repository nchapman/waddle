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

## 2026-10-09 23:15 UTC — the full pool ceremony, live (concierge v0.3.2→v0.3.4)

End state proven: primary stopped → client page load auto-falls-back to
/assign → warm standby-6 → v0.0.41 measurement verifies, TOFU pin holds
(no fingerprint screen) → unlock with stored secret, blank inference key →
full shelf restored (entire conversation archive) → live chat answered
through the standby. The 77s boot hides behind the pool; the user-visible
path is ~10s verify + ~7s unlock/restore.

Three live-caught findings shaped v0.3.3/v0.3.4:

1. **Per-instance --variable breaks measurement (v0.3.2, standby-1).**
   tinfoil create --variable changes the code measurement → the client
   refused ("Code measurement mismatch") against the signed release —
   the security model working exactly as designed. v0.3.3: standbys run
   the exact committed config, no variables. Per-machine identity is an
   open design item; interim bounds on a claimed machine are the
   concierge-side grace row (default 12h, STANDBY_CLAIM_GRACE_MS).

2. **Tagless deploy = version skew (v0.3.3, caught by standby-3).**
   The CLI verified standby-3 clean against v0.0.41, but a browser load
   fell through to /wake, whose deploy was tagless → the primary booted
   its SAVED v0.0.40 → client expects latest (v0.0.41) → correct refusal.
   v0.3.4: /wake and zombie-recovery deploy with --tag, defaulting to
   STANDBY_CONFIG_TAG (CONCIERGE_DEPLOY_TAG overrides). Live-proven:
   /wake booted the primary at v0.0.41 and the pin re-pinned cleanly.

3. **Concierge restart churn double-boots.** Each concierge restart
   orphans in-flight replacement boots (memory-only tables): v0.3.3→v0.3.4
   left standbys 2 and 4 untracked and burning. Name recycling works
   (standby-1 was reborn after deletion, tracked by the fresh concierge).
   Cost: one extra boot per restart-with-pending-standby; cleaned by hand
   tonight; a future adopt-live-standbys heuristic would close it.

Also live-proven tonight: assign-404 → /wake fallback in the browser
(standby not yet warm at page-load — tick lag), locked-boot stop backstop
rows appearing on every standby boot ("waddle" shared-identity collision,
harmless as designed: the row stops an already-stopped primary), and
instance-provided inference through a pool machine (blank key field,
agent answered — and correctly cannot see its own host identity or key).

Standing cost note: the pool's steady state is one warm machine, always.
WARM_POOL_SIZE is measured config — changing it re-measures the
concierge. Overnight economics are a user decision, not a code one.

## 2026-10-10 00:16–00:29 UTC — the unattended ceremony, live (waddle v0.0.43 + concierge v0.3.5–v0.3.7)

The parked design, proven end to end with zero persistent infrastructure —
the credential lives in the concierge's MEMORY:

- 00:10:33 unlock (client, stored secret, blank inference field) → the
  machine armed the handoff: POST /handoff → memory row. /status showed
  `wake_handoff.armed: true` seconds later. (First arm attempt at 23:58
  failed silently: the concierge shim didn't forward /handoff — fixed in
  v0.3.7. Found by /status, not by luck.)
- 00:11–00:13 scheduled the proof task via chat (agent tool
  `schedule_create`, job 30cf083a, fires 00:16:32Z).
- 00:13:16 manual 💤 sleep → gate wrote the wake row (+3min) → checkpoint
  → death flare → machine Stopped 00:14. Nothing running anywhere.
- 00:16:42 concierge wake row fired → markWakeFired → deploy v0.0.43.
- 00:18:13 machine up `"locked":false` — the boot pulled the fire-gated
  handoff and self-unlocked. Nobody touched anything.
- 00:28–00:29 idle gate (600s) fired → machine re-slept itself. Burn
  bounded; handoff still armed in memory for the next cycle.

State-level proof complete: stop → fire → deploy → self-unlock → run →
re-sleep. The shelf-level proof (the AUTONOMY-PROOF reply line) was
blocked by an ATC outage (atc.tinfoil.sh 500s for the expected-measurement
fetch, ~00:29+) — to be read back at the next unlock when ATC recovers.

Live-caught along the way:
- A sleep with no live concierge session (post-restart) skips the death
  flare AND wake rows: process dies, container zombies Running until the
  backstop stop row reaps it; the client's /wake cleared that backstop row
  (userWake) and the zombie-recovery loop didn't land — manual stop+deploy
  recovered. The client's "resume session" on a zombie read a stale
  locked:false. Client bug filed: after /assign the SDK's pinned fetch
  still targets the primary ("refusing to send request… bound to the
  verified enclave/proxy").
- Release tooling: runner gh CLI can lag the measure-action's 2.67.0
  floor — both config repos' publish workflows now self-install current
  gh. And sed ate a closing YAML quote during a digest bump (use python).
- STANDBY_CONFIG_TAG must track every waddle release (standby-create
  skew = the same client-refusal class as the deploy skew fixed in
  v0.3.4). Treadmill noted: every waddle release implies a concierge
  config bump + release.

### Post-mortem addendum (00:36 UTC): the autonomous run's output did not survive

The 00:35 unlock restored the shelf only up to the 00:13 manual sleep —
no "[system] autonomous boot" event, no AUTONOMY-PROOF line. Root cause,
confirmed in code: BOTH the restore pull and the sleep-time shelf push
are gated on `bbGrantActive()`, and `setBbGrant` runs only in the client's
unlock POST (the client supplies a fresh betterbase JWT). An autonomous
boot has no grant: it self-unlocked into an EMPTY log, ran the due task
(state-timing consistent), then idle-slept without pushing — the run
existed only in that machine's memory and died with it.

So the honest scoreboard for the unattended ceremony:
- PROVEN (state-level, observed): stop → wake fire → deploy → fire-gated
  handoff pull → self-unlock (locked:false at 00:18) → idle re-sleep at
  00:29. The escrow, gate, and lifecycle all work.
- GAP (design): autonomous output needs a survival path. Options inside
  the memory-only constraint: (a) the concierge as postbox — autonomous
  machines POST their event tail at sleep; the next unlock merges it
  (extends the handoff pattern; the concierge stays metadata+sealed-blob
  only); (b) a machine-capable bb grant in the armed credential (bigger
  escrow blast radius — needs the privacy review's blessing); (c) accept
  loss (dishonest for real scheduled work — rejected).

## 2026-10-10 00:29–01:33 — SME hardening, and the race the fix inverted (v0.3.8 → v0.3.10)

Privacy + security SME reviews ran against the v0.3.7 design. Verdicts:
the privacy reviewer said do-not-ship-as-is (the fire gate was decorative:
any external-tier /timer write could mint a fire and pull the escrow); the
security reviewer found a standby-steal race (a racing boot could win the
one-shot pull, self-unlock, and idle forever) and an unauthenticated
/status. All findings implemented (commit 6bf610a, waddle v0.0.44 +
concierge v0.3.8):

- /timer is session-tier only; /status requires the shared secret;
  GET /handoff replaced by POST /handoff/pull + no-store (caching/URL
  secrets); constant-time secret compare.
- Release window opens ONLY after the schedule deploy succeeds, 3-min
  TTL; failed deploys re-arm the row (3 tries); the pool defers fills
  while a window is open (canFill).
- Escrow TTL = next-due + margin, armed at the sleep gate (recurring
  schedules work; arm skipped with nothing pending); disarm verb
  (clear:true); leftover Running machines adopted, not reaped blindly.
- Restricted autonomous mode: credential-unlocked machines run schedules
  only (chat/browser intents refused); a user unlock takes over.

Then the 01:00 hardened cycle caught MY fix's own bug, live: the boot's
escrow pull lands at ~+90s (app up), which BEATS the deploy CLI's own
resolve — marking the fire only after the deploy resolved meant the
intended machine pulled `no-fire` and booted locked (machine handshook
01:23:42Z, escrow still armed, job spent). Fix (v0.3.10): the window
opens at FIRE time; the standby-steal vector stays closed by the pool's
canFill deferral (no replacement boots while a window is open), and a
failed deploy re-arms its row while the stale window harmlessly expires.
Lesson recorded: ordering fixes need the whole timeline, not just the
attacker's — the defender's happy path can race too.

Operational notes from the same stretch: the shim allowlist bit again
(renamed /handoff/pull 404'd at the gateway until v0.3.9 forwarded it),
and an AdGuard-Home negative-cache (NXDOMAIN for exactly one enclave
host, poisoned from Quad9 during a network flap, 30-min TTL; re-poisoned
once by a probe fired between cache-clear and upstream recovery) blocked
client attestation for ~40 min — diagnosis via dig against each resolver
in the chain, plus the user's AdGuard query log.

## 2026-10-10 04:06–04:23 UTC — the hardened unattended cycle, live (waddle v0.0.44 + concierge v0.3.10)

Zero persistent infrastructure, memory-only escrow, every hardening on:

| UTC | event |
|---|---|
| 04:06:57 | manual 💤 (attended): checkpoint → stop → escrow armed (job 2bbb9a03 pending) |
| 04:09:55 | machine Stopped; nothing running anywhere |
| 04:11:00 | wake row fired → release window opens AT FIRE (v0.3.10) → deploy v0.0.44 |
| 04:12:36 | booted `"locked":false` — the pull landed IN the window; restricted self-unlock |
| ~04:12:40 | ticker ran "hardened proof 4" (prompt: reply exactly `HARDENED-AUTONOMY-4 ok`) |
| 04:23:02 | 10-min idle gate → checkpoint → stop → re-sleep |

The inverted race is dead: 96s fire→unlocked, pull in-window on the first
try. The restricted mode held for the run window, and the machine put
itself away — total unattended burn ~11.5 min, bounded by the idle gate.

Read-back (the shelf-level line) blocked AGAIN by an ATC outage
(atc.tinfoil.sh 500 "Failed to build attestation bundle", 04:26+;
fail-closed client refuses to verify without it). Expected behavior per
the eventual-consistency property observed at 00:35: the schedule
persists in the shelf (the autonomous run's done-marker dies with the
unpushed log), so the NEXT unlock re-fires proof-4 attended and the
HARDENED-AUTONOMY-4 line should appear then. To be appended once ATC
recovers. Also wiped by the user's reboot: the /tmp copy of the shared
secret (only the tinfoil vault holds the value now — `secrets get`
never returns it; rotation available at the cost of a re-measure+
re-pin cycle if /status access from the laptop matters again).
